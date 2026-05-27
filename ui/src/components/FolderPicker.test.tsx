// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderPicker } from "./FolderPicker";
import { ApiError } from "@/api/client";
import { MemoryRouter } from "react-router-dom";

const { mockAccessApi } = vi.hoisted(() => ({
  mockAccessApi: {
    listFilesystem: vi.fn(),
  },
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function flushPromises() {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes(text)) ?? null;
}

function renderedSurface() {
  return document.body;
}

describe("FolderPicker", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  function render(node: ReactNode) {
    act(() => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
        </MemoryRouter>,
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 0,
          staleTime: 0,
        },
      },
    });
    mockAccessApi.listFilesystem.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.useRealTimers();
  });

  it("navigates into directories and selects the current folder", async () => {
    const onSelect = vi.fn();
    mockAccessApi.listFilesystem.mockImplementation(async (path?: string) => {
      if (!path) {
        return {
          path: "",
          parent: null,
          entries: [{ name: "/Users", isDir: true, isSymlink: false }],
        };
      }
      if (path === "/Users") {
        return {
          path: "/Users",
          parent: "/",
          entries: [{ name: "neeraj", isDir: true, isSymlink: false }],
        };
      }
      throw new Error(`Unexpected path ${path}`);
    });

    render(<FolderPicker open onOpenChange={() => {}} onSelect={onSelect} />);
    await waitFor(() => expect(buttonByText(renderedSurface(), "/Users")).not.toBeNull());

    const usersButton = buttonByText(renderedSurface(), "/Users");

    act(() => {
      usersButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => expect(mockAccessApi.listFilesystem).toHaveBeenCalledWith("/Users"));

    expect(renderedSurface().textContent).toContain("/Users");

    const selectButton = buttonByText(renderedSurface(), "Select this folder");
    expect(selectButton).not.toBeNull();

    act(() => {
      selectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledWith("/Users");
  });

  it("supports keyboard navigation through the directory list", async () => {
    mockAccessApi.listFilesystem.mockImplementation(async (path?: string) => {
      if (path === "/Users") {
        return {
          path: "/Users",
          parent: "/",
          entries: [
            { name: "Desktop", isDir: true, isSymlink: false },
            { name: "Documents", isDir: true, isSymlink: false },
          ],
        };
      }
      if (path === "/Users/Documents") {
        return {
          path: "/Users/Documents",
          parent: "/Users",
          entries: [],
        };
      }
      throw new Error(`Unexpected path ${path}`);
    });

    render(<FolderPicker open onOpenChange={() => {}} onSelect={() => {}} value="/Users" />);
    await waitFor(() => expect(renderedSurface().querySelector('[role="listbox"]')).not.toBeNull());

    const listbox = renderedSurface().querySelector('[role="listbox"]');

    act(() => {
      listbox?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    act(() => {
      listbox?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await waitFor(() => expect(mockAccessApi.listFilesystem).toHaveBeenCalledWith("/Users/Documents"));
  });

  it("debounces manual path entry before loading the next folder", async () => {
    mockAccessApi.listFilesystem.mockImplementation(async (path?: string) => ({
      path: path ?? "",
      parent: path ? "/" : null,
      entries: [],
    }));

    render(<FolderPicker open onOpenChange={() => {}} onSelect={() => {}} />);
    await flushPromises();
    expect(mockAccessApi.listFilesystem).toHaveBeenCalledTimes(1);

    const input = renderedSurface().querySelector("#folder-picker-path") as HTMLInputElement | null;
    expect(input).not.toBeNull();

    vi.useFakeTimers();
    act(() => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      descriptor?.set?.call(input, "/tmp");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(mockAccessApi.listFilesystem).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(249);
    });
    expect(mockAccessApi.listFilesystem).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    vi.useRealTimers();
    await waitFor(() => expect(mockAccessApi.listFilesystem).toHaveBeenCalledWith("/tmp"));
  });

  it("renders the error state and keeps the manual help fallback reachable", async () => {
    mockAccessApi.listFilesystem.mockRejectedValue(
      new ApiError("Path not found", 404, { error: "Path not found" }),
    );

    render(<FolderPicker open onOpenChange={() => {}} onSelect={() => {}} value="/missing" />);
    await waitFor(() => expect(renderedSurface().textContent).toContain("Could not load this folder"));

    expect(renderedSurface().textContent).toContain("Could not load this folder");
    expect(renderedSurface().textContent).toContain("Path not found");

    const helpButton = buttonByText(renderedSurface(), "Need help finding a path?");
    expect(helpButton).not.toBeNull();

    act(() => {
      helpButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(renderedSurface().textContent).toContain("How to get a full path");
  });
});
