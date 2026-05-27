import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  Loader2,
  TriangleAlert,
  ArrowUp,
} from "lucide-react";
import { accessApi } from "@/api/access";
import { PathInstructionsModal } from "@/components/PathInstructionsModal";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

function isAbsolutePath(value: string) {
  return value.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(value);
}

function joinFilesystemPath(basePath: string, name: string) {
  if (!basePath) return name;
  const separator = basePath.includes("\\") || WINDOWS_ABSOLUTE_PATH.test(basePath) ? "\\" : "/";
  if (basePath === separator) {
    return `${separator}${name}`;
  }
  return basePath.endsWith(separator) ? `${basePath}${name}` : `${basePath}${separator}${name}`;
}

function buildBreadcrumbs(currentPath: string) {
  if (!currentPath) return [];

  if (WINDOWS_ABSOLUTE_PATH.test(currentPath)) {
    const normalized = currentPath.replaceAll("/", "\\");
    const segments = normalized.split("\\").filter(Boolean);
    const drive = segments.shift();
    if (!drive) return [];

    let nextPath = `${drive}\\`;
    const breadcrumbs = [{ label: `${drive}\\`, path: nextPath }];
    for (const segment of segments) {
      nextPath = nextPath.endsWith("\\") ? `${nextPath}${segment}` : `${nextPath}\\${segment}`;
      breadcrumbs.push({ label: segment, path: nextPath });
    }
    return breadcrumbs;
  }

  const segments = currentPath.split("/").filter(Boolean);
  let nextPath = "/";
  const breadcrumbs = [{ label: "/", path: "/" }];
  for (const segment of segments) {
    nextPath = nextPath === "/" ? `/${segment}` : `${nextPath}/${segment}`;
    breadcrumbs.push({ label: segment, path: nextPath });
  }
  return breadcrumbs;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
}

function formatErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "Failed to load folders.";
}

export interface FolderPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value?: string;
  onSelect: (path: string) => void;
  title?: string;
  description?: string;
  selectLabel?: string;
}

export function FolderPicker({
  open,
  onOpenChange,
  value = "",
  onSelect,
  title = "Choose folder",
  description = "Browse folders on this machine or paste an absolute path directly.",
  selectLabel = "Select this folder",
}: FolderPickerProps) {
  const [pathInput, setPathInput] = useState(value.trim());
  const [requestedPath, setRequestedPath] = useState(value.trim());
  const [helpOpen, setHelpOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const debouncedInput = useDebounced(pathInput.trim(), 250);

  useEffect(() => {
    if (!open) return;
    const nextValue = value.trim();
    setPathInput(nextValue);
    setRequestedPath(nextValue);
    setActiveIndex(0);
  }, [open, value]);

  useEffect(() => {
    if (!open || debouncedInput === requestedPath) return;
    setRequestedPath(debouncedInput);
  }, [debouncedInput, open, requestedPath]);

  const listQuery = useQuery({
    queryKey: queryKeys.filesystem.list(requestedPath),
    queryFn: () => accessApi.listFilesystem(requestedPath),
    enabled: open,
    retry: false,
  });

  const directories = useMemo(
    () => (listQuery.data?.entries ?? []).filter((entry) => entry.isDir),
    [listQuery.data?.entries],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [requestedPath, listQuery.data?.path, directories.length]);

  const loadedPath = listQuery.data?.path ?? "";
  const selectablePath = loadedPath || (isAbsolutePath(pathInput.trim()) ? pathInput.trim() : "");
  const breadcrumbs = buildBreadcrumbs(loadedPath);

  function navigateTo(path: string) {
    setPathInput(path);
    setRequestedPath(path);
  }

  function selectCurrentPath() {
    if (!selectablePath) return;
    onSelect(selectablePath);
    onOpenChange(false);
  }

  function handleEntryKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (directories.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % directories.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + directories.length) % directories.length);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(directories.length - 1);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const entry = directories[activeIndex];
      if (entry) {
        navigateTo(loadedPath ? joinFilesystemPath(loadedPath, entry.name) : entry.name);
      }
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[min(calc(100dvh-2rem),40rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b border-border px-6 pb-4 pt-6">
            <DialogTitle className="text-base">{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
            <div className="space-y-2">
              <label htmlFor="folder-picker-path" className="text-xs font-medium text-muted-foreground">
                Folder path
              </label>
              <Input
                id="folder-picker-path"
                value={pathInput}
                onChange={(event) => setPathInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && selectablePath) {
                    event.preventDefault();
                    selectCurrentPath();
                  }
                }}
                placeholder="/absolute/path/to/workspace"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-sm"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => listQuery.data?.parent && navigateTo(listQuery.data.parent)}
                disabled={!listQuery.data?.parent || listQuery.isFetching}
              >
                <ArrowUp className="size-3" />
                Up
              </Button>

              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 rounded-md border border-border bg-muted/20 px-2 py-1.5">
                {breadcrumbs.length === 0 ? (
                  <span className="text-xs text-muted-foreground">Roots</span>
                ) : (
                  breadcrumbs.map((crumb, index) => (
                    <div key={crumb.path} className="flex min-w-0 items-center gap-1">
                      <button
                        type="button"
                        className="truncate rounded px-1 py-0.5 text-xs hover:bg-accent hover:text-foreground"
                        onClick={() => navigateTo(crumb.path)}
                      >
                        {crumb.label}
                      </button>
                      {index < breadcrumbs.length - 1 ? (
                        <ChevronRight className="size-3 text-muted-foreground" />
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col rounded-md border border-border">
              <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted-foreground">
                <span>{loadedPath || "Available roots"}</span>
                {listQuery.isFetching ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="size-3 animate-spin" />
                    Loading
                  </span>
                ) : null}
              </div>

              {listQuery.isLoading ? (
                <div className="space-y-2 p-3" aria-live="polite">
                  <div className="h-8 animate-pulse rounded bg-muted/60" />
                  <div className="h-8 animate-pulse rounded bg-muted/60" />
                  <div className="h-8 animate-pulse rounded bg-muted/60" />
                </div>
              ) : listQuery.isError ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" aria-live="polite">
                  <TriangleAlert className="size-5 text-destructive" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Could not load this folder</p>
                    <p className="text-sm text-muted-foreground">{formatErrorMessage(listQuery.error)}</p>
                  </div>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    onClick={() => setHelpOpen(true)}
                  >
                    Need help finding a path?
                  </button>
                </div>
              ) : directories.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center" aria-live="polite">
                  <FolderOpen className="size-5 text-muted-foreground" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium">No subfolders here</p>
                    <p className="text-sm text-muted-foreground">
                      You can still select the current folder or paste a different absolute path above.
                    </p>
                  </div>
                </div>
              ) : (
                <div
                  role="listbox"
                  tabIndex={0}
                  aria-label="Subfolders"
                  aria-activedescendant={directories[activeIndex] ? `folder-picker-entry-${activeIndex}` : undefined}
                  className="min-h-0 flex-1 overflow-y-auto p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  onKeyDown={handleEntryKeyDown}
                >
                  {directories.map((entry, index) => {
                    const nextPath = loadedPath ? joinFilesystemPath(loadedPath, entry.name) : entry.name;
                    const selected = index === activeIndex;
                    return (
                      <button
                        id={`folder-picker-entry-${index}`}
                        key={`${loadedPath}:${entry.name}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={cn(
                          "flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm",
                          selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                        )}
                        onFocus={() => setActiveIndex(index)}
                        onClick={() => navigateTo(nextPath)}
                      >
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <Folder className="size-4 text-muted-foreground" />
                          <span className="truncate">{entry.name}</span>
                          {entry.isSymlink ? (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                              symlink
                            </span>
                          ) : null}
                        </span>
                        <ChevronRight className="size-4 text-muted-foreground" />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                onClick={() => setHelpOpen(true)}
              >
                Need help finding a path?
              </button>

              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="button" onClick={selectCurrentPath} disabled={!selectablePath}>
                  {selectLabel}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <PathInstructionsModal open={helpOpen} onOpenChange={setHelpOpen} />
    </>
  );
}

export interface FolderPickerButtonProps {
  value?: string;
  onChange: (path: string) => void;
  className?: string;
  disabled?: boolean;
  label?: string;
  title?: string;
  description?: string;
  selectLabel?: string;
}

export function FolderPickerButton({
  value = "",
  onChange,
  className,
  disabled = false,
  label = "Choose",
  title,
  description,
  selectLabel,
}: FolderPickerButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className={cn("shrink-0", className)}
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        {label}
      </Button>
      <FolderPicker
        open={open}
        onOpenChange={setOpen}
        value={value}
        onSelect={onChange}
        title={title}
        description={description}
        selectLabel={selectLabel}
      />
    </>
  );
}
