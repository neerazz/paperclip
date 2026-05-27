import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  ensureAdapterExecutionTargetCommandResolvable,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputActivityTimedOut: false,
    stdout: [
      "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}",
      "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"done\"}}",
      "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1}}",
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    ensureAdapterExecutionTargetCommandResolvable,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

describe("codex output inactivity watchdog", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeContext(config: Record<string, unknown> = {}) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-watchdog-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

    return {
      logs,
      ctx: {
        runId: "run-watchdog",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "CodexCoder",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "codex",
          cwd: workspaceDir,
          env: {
            CODEX_HOME: codexHomeDir,
          },
          ...config,
        },
        context: {},
        onLog: async (stream: "stdout" | "stderr", chunk: string) => {
          logs.push({ stream, chunk });
        },
      },
    };
  }

  it("passes a JSON-event activity timeout to the Codex child process", async () => {
    const { ctx } = await makeContext({ outputInactivityTimeoutMs: 123 });

    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, unknown, string, string[], { outputActivityTimeout?: { timeoutMs: number; graceMs?: number; hasActivity: (input: { chunk: string; stdout: string }) => boolean } }]
      | undefined;
    const watchdog = call?.[4].outputActivityTimeout;
    expect(watchdog?.timeoutMs).toBe(123);
    expect(watchdog?.graceMs).toBe(5_000);
    expect(watchdog?.hasActivity({ chunk: "not json\n", stdout: "" })).toBe(false);
    expect(watchdog?.hasActivity({ chunk: "noise\n{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n", stdout: "" })).toBe(true);
  });

  it("disables the watchdog only when outputInactivityTimeoutMs is null", async () => {
    const { ctx, logs } = await makeContext({ outputInactivityTimeoutMs: null });

    await execute(ctx as never);

    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, unknown, string, string[], { outputActivityTimeout?: unknown }]
      | undefined;
    expect(call?.[4].outputActivityTimeout).toBeUndefined();
    expect(logs.map((entry) => entry.chunk).join("\n")).toContain("Codex output inactivity watchdog disabled");
  });

  it("surfaces watchdog termination as an adapter failure", async () => {
    (runAdapterExecutionTargetProcess as unknown as {
      mockImplementationOnce: (fn: (...args: unknown[]) => Promise<unknown>) => void;
    }).mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[4] as {
        outputActivityTimeout?: { onTimeout?: (input: { timeoutMs: number; elapsedMs: number }) => void };
      };
      options.outputActivityTimeout?.onTimeout?.({ timeoutMs: 1_200, elapsedMs: 1_234 });
      return {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        outputActivityTimedOut: true,
        stdout: "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n",
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    });
    const { ctx } = await makeContext({ outputInactivityTimeoutMs: 1_200 });

    const result = await execute(ctx as never);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.errorMessage).toBe("watchdog: no codex output for 0m 1s");
  });
});
