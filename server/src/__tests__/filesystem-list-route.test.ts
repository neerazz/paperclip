import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultFilesystemRoots,
  filesystemRoutes,
  isDefaultFilesystemPathAllowed,
} from "../routes/filesystem.js";
import { errorHandler } from "../middleware/error-handler.js";

const tempPaths: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-filesystem-list-"));
  tempPaths.push(dir);
  return dir;
}

function createApp(
  opts: {
    deploymentMode?: "local_trusted" | "authenticated";
    actor?: Express.Request["actor"];
    pathAccessPolicy?: (absoluteRealPath: string) => boolean | Promise<boolean>;
  } = {},
) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = opts.actor ?? {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use(
    "/api",
    filesystemRoutes({
      deploymentMode: opts.deploymentMode ?? "local_trusted",
      pathAccessPolicy: opts.pathAccessPolicy,
    }),
  );
  app.use(errorHandler);
  return app;
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

describe("GET /filesystem/list", () => {
  it("returns platform roots when path is empty", async () => {
    const app = createApp();

    const res = await request(app).get("/api/filesystem/list");

    expect(res.status).toBe(200);
    expect(res.body.path).toBe("");
    expect(res.body.parent).toBeNull();
    expect(res.body.entries.map((entry: { name: string }) => entry.name)).toEqual(await defaultFilesystemRoots());
    for (const entry of res.body.entries as Array<{ isDir: boolean; isSymlink: boolean }>) {
      expect(entry.isDir).toBe(true);
      expect(typeof entry.isSymlink).toBe("boolean");
    }
  });

  it("returns nested directory entries", async () => {
    const root = await makeTempDir();
    await fs.mkdir(path.join(root, "alpha"));
    await fs.writeFile(path.join(root, "bravo.txt"), "hello");

    let createdSymlink = false;
    try {
      await fs.symlink(path.join(root, "alpha"), path.join(root, "charlie-link"));
      createdSymlink = true;
    } catch {
      // Symlinks can require elevated permissions on some platforms.
    }

    const res = await request(createApp())
      .get("/api/filesystem/list")
      .query({ path: root });

    expect(res.status).toBe(200);
    expect(res.body.path).toBe(await fs.realpath(root));
    expect(res.body.parent).toBe(path.dirname(await fs.realpath(root)));

    const entriesByName = new Map(
      (res.body.entries as Array<{ name: string; isDir: boolean; isSymlink: boolean }>).map((entry) => [entry.name, entry]),
    );
    expect(entriesByName.get("alpha")).toMatchObject({ isDir: true, isSymlink: false });
    expect(entriesByName.get("bravo.txt")).toMatchObject({ isDir: false, isSymlink: false });
    if (createdSymlink) {
      expect(entriesByName.get("charlie-link")).toMatchObject({ isDir: true, isSymlink: true });
    }
  });

  it("returns 403 for denied paths", async () => {
    const root = await makeTempDir();
    const realPath = await fs.realpath(root);
    const app = createApp({
      pathAccessPolicy: (candidatePath) => candidatePath !== realPath,
    });

    const res = await request(app)
      .get("/api/filesystem/list")
      .query({ path: root });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Path is not allowed" });
  });

  it("returns 400 for non-absolute paths", async () => {
    const res = await request(createApp())
      .get("/api/filesystem/list")
      .query({ path: "relative/path" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Path must be absolute" });
  });

  it("returns 404 for missing paths", async () => {
    const missingPath = path.join(os.tmpdir(), `paperclip-filesystem-list-missing-${Date.now()}`);
    const res = await request(createApp())
      .get("/api/filesystem/list")
      .query({ path: missingPath });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Path not found" });
  });

  it("gates the route to local_trusted mode", async () => {
    const res = await request(createApp({ deploymentMode: "authenticated" }))
      .get("/api/filesystem/list");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Filesystem listing is only available in local_trusted mode" });
  });
});

describe("isDefaultFilesystemPathAllowed", () => {
  it("denies sensitive unix paths by default", () => {
    if (process.platform === "win32") {
      expect(isDefaultFilesystemPathAllowed("C:\\Users", { uid: 1000 })).toBe(true);
      return;
    }

    expect(isDefaultFilesystemPathAllowed("/etc/shadow", { uid: 1000 })).toBe(false);
    expect(isDefaultFilesystemPathAllowed("/root", { uid: 1000 })).toBe(false);
    expect(isDefaultFilesystemPathAllowed("/root/nested", { uid: 1000 })).toBe(false);
    expect(isDefaultFilesystemPathAllowed("/root", { uid: 0 })).toBe(true);
  });
});
