import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Router, type RequestHandler } from "express";
import type { DeploymentMode } from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";

export interface FilesystemRoutesOptions {
  deploymentMode: DeploymentMode;
  pathAccessPolicy?: (absoluteRealPath: string) => boolean | Promise<boolean>;
  rootsResolver?: () => Promise<string[]>;
}

interface FilesystemEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
}

const DEFAULT_UNIX_DENYLIST = new Set(["/etc/shadow"]);

function normalizeAbsolutePath(value: string) {
  return process.platform === "win32" ? path.win32.normalize(value) : path.posix.normalize(value);
}

function isPathWithinRoot(rootPath: string, candidatePath: string) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isDefaultFilesystemPathAllowed(
  absoluteRealPath: string,
  opts: { uid?: number | null } = {},
) {
  const normalizedPath = normalizeAbsolutePath(absoluteRealPath);
  if (process.platform !== "win32" && DEFAULT_UNIX_DENYLIST.has(normalizedPath)) {
    return false;
  }

  const uid = opts.uid ?? process.getuid?.() ?? null;
  if (process.platform !== "win32" && uid !== 0 && isPathWithinRoot("/root", normalizedPath)) {
    return false;
  }

  return true;
}

export async function defaultFilesystemRoots() {
  if (process.platform !== "win32") {
    return Array.from(new Set(["/", os.homedir()]));
  }

  const candidates = new Set<string>();
  const homeRoot = path.parse(os.homedir()).root;
  if (homeRoot) candidates.add(homeRoot);

  const systemDrive = process.env.SystemDrive?.trim();
  if (systemDrive) {
    candidates.add(path.win32.resolve(`${systemDrive}\\`));
  }

  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  await Promise.all(
    [...letters].map(async (letter) => {
      const driveRoot = `${letter}:\\`;
      try {
        const stat = await fs.stat(driveRoot);
        if (stat.isDirectory()) candidates.add(driveRoot);
      } catch {
        // Ignore non-existent drives.
      }
    }),
  );

  return Array.from(candidates).sort((a, b) => a.localeCompare(b));
}

function localTrustedFilesystemGuard(deploymentMode: DeploymentMode): RequestHandler {
  return (req, _res, next) => {
    if (deploymentMode !== "local_trusted") {
      next(forbidden("Filesystem listing is only available in local_trusted mode"));
      return;
    }
    if (req.actor.type !== "board") {
      next(forbidden("Board access required"));
      return;
    }
    next();
  };
}

async function buildRootEntries(
  roots: string[],
  pathAccessPolicy: (absoluteRealPath: string) => boolean | Promise<boolean>,
) {
  const entries: FilesystemEntry[] = [];

  for (const rootPath of roots) {
    try {
      const absolutePath = path.resolve(rootPath);
      const realPath = await fs.realpath(absolutePath);
      if (!(await pathAccessPolicy(realPath))) {
        continue;
      }
      const stats = await fs.lstat(absolutePath);
      entries.push({
        name: absolutePath,
        isDir: stats.isDirectory(),
        isSymlink: stats.isSymbolicLink(),
      });
    } catch {
      // Ignore unavailable roots rather than failing the whole listing.
    }
  }

  return entries;
}

async function buildDirectoryEntry(directoryPath: string, name: string): Promise<FilesystemEntry> {
  const absolutePath = path.join(directoryPath, name);
  const linkStats = await fs.lstat(absolutePath);
  let isDir = linkStats.isDirectory();
  if (linkStats.isSymbolicLink()) {
    const targetStats = await fs.stat(absolutePath).catch(() => null);
    isDir = targetStats?.isDirectory() ?? false;
  }
  return {
    name,
    isDir,
    isSymlink: linkStats.isSymbolicLink(),
  };
}

function sortFilesystemEntries(a: FilesystemEntry, b: FilesystemEntry) {
  if (a.isDir !== b.isDir) {
    return a.isDir ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

export function filesystemRoutes(opts: FilesystemRoutesOptions) {
  const router = Router();
  const pathAccessPolicy = opts.pathAccessPolicy ?? ((absoluteRealPath: string) => isDefaultFilesystemPathAllowed(absoluteRealPath));
  const rootsResolver = opts.rootsResolver ?? defaultFilesystemRoots;

  router.use("/filesystem", localTrustedFilesystemGuard(opts.deploymentMode));

  router.get("/filesystem/list", async (req, res) => {
    if (Array.isArray(req.query.path)) {
      throw badRequest("path query parameter must be a single string");
    }

    const rawPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (!rawPath) {
      const entries = await buildRootEntries(await rootsResolver(), pathAccessPolicy);
      res.json({
        path: "",
        parent: null,
        entries,
      });
      return;
    }

    if (!path.isAbsolute(rawPath)) {
      throw badRequest("Path must be absolute");
    }

    let realPath: string;
    try {
      realPath = await fs.realpath(rawPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Path not found");
      }
      throw error;
    }

    if (!(await pathAccessPolicy(realPath))) {
      throw forbidden("Path is not allowed");
    }

    let stats;
    try {
      stats = await fs.stat(realPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Path not found");
      }
      throw error;
    }

    if (!stats.isDirectory()) {
      throw badRequest("Path must be a directory");
    }

    const dirents = await fs.readdir(realPath, { withFileTypes: true });
    const entries = await Promise.all(dirents.map((dirent) => buildDirectoryEntry(realPath, dirent.name)));
    entries.sort(sortFilesystemEntries);

    const parent = path.dirname(realPath);
    res.json({
      path: realPath,
      parent: parent === realPath ? null : parent,
      entries,
    });
  });

  return router;
}
