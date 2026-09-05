import { describe, expect, it, vi } from "vitest";

import type { ManagedWorkspaceView } from "../shared/desktop-api";
import type { CodexHarnessRuntime } from "./codex-harness-runtime";
import type { CodexCliManager } from "./codex-cli-manager";
import type { SourceNerveClient } from "./sourcenerve-client";
import { DesktopTaskManager } from "./task-manager";
import type { DesktopTaskRegistry } from "./task-registry";
import type { WorkspaceManager } from "./workspace-manager";

const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";
const HEAD = "a".repeat(40);

function workspace(access: "read-only" | "read-write" = "read-write"): ManagedWorkspaceView {
  return {
    id: "api",
    name: "API",
    root: "/tmp/api",
    access,
    remote: "origin",
    defaultBranch: "main",
    validation: { state: "ready" },
    head: HEAD,
    branch: "main",
    dirty: false,
    localWritable: true,
  };
}

function snapshot(phase: string = "snapshot") {
  return {
    task: {
      id: TASK_ID,
      workspace: "api",
      base_head: HEAD,
          status: "active",
      context_query: null,
      context_sha256: null,
      stale_reason: null,
      created_at: 1,
      updated_at: 1,
    },
    proposals: [],
    events: [],
    lifecycle: {
      task_id: TASK_ID,
      phase,
      branch: phase === "snapshot" ? null : "feat/task",
      reviewed_diff_sha256: null,
      commit_sha: null,
      push_sha: null,
      issue_number: null,
      pull_number: null,
      pull_head_sha: null,
      merge_sha: null,
      default_synced_head: null,
      updated_at: 1,
      provider: null,
    },
  };
}

function harnessRun(status = "running") {
  return {
    run: {
      id: "run-1",
      workspace: "api",
      profile: "interactive-local",
      origin: "manual",
      status,
      started_at: 1,
      updated_at: 2,
      completed_at: status === "running" ? null : 3,
      capability_snapshot: {
        profile: {
          name: "interactive-local",
          description: "Interactive local work",
          sandbox: "workspace-write",
          policies: { read: "allow", write: "allow", exec: "allow", git: "ask", provider: "ask", job: "allow" },
        },
      },
    },
    freshness: { state: "current", reason: null },
    recovery: { state: "resumable", reason: "ready", pending_approvals: 0, active_jobs: 0, uncertain_mutations: 0, retryable_read_executions: 0, retryable_pre_dispatch_executions: 0, blocked_pre_dispatch_executions: 0, checkpoint: null },
    closed_loop: { phase: "execute", work_shape: "bounded", context_reads: 0, executions: 0, verification_required: false, verification_status: "idle", recovery_status: "idle", satisfied_proofs: [], failure_count: 0, learning_count: 0, learning_hints: [] },
    repository_context: { entrypoints: [], guidance: [], active_plans: [], validation_owners: [], proof_candidates: [], truncated: false },
    children: [],
    children_truncated: false,
  };
}

function managerWith(options: {
  workspace?: ManagedWorkspaceView;
  taskRequest?: (path: string, body: object) => Promise<unknown>;
  harnessRequest?: (path: string, body: object) => Promise<unknown>;
  codex?: Pick<CodexHarnessRuntime, "account" | "run" | "release">;
  codexSetup?: Pick<CodexCliManager, "status" | "install" | "login">;
}) {
  const taskRequest = vi.fn(options.taskRequest ?? (async () => snapshot()));
  const harnessRequest = vi.fn(options.harnessRequest ?? (async () => harnessRun()));
  const client = { taskRequest, harnessRequest } as unknown as SourceNerveClient;
  const workspaceManager = {
    listManagedWorkspaces: vi.fn(async () => [options.workspace ?? workspace()]),
  } as unknown as WorkspaceManager;
  const remember = vi.fn(async () => []);
  const registry = {
    initialize: vi.fn(async () => []),
    snapshot: vi.fn(() => []),
    remember,
  } as unknown as DesktopTaskRegistry;
  const events: string[] = [];
  return {
    manager: new DesktopTaskManager({
      client,
      workspaceManager,
      registry,
      ...(options.codex ? { codex: options.codex } : {}),
      ...(options.codexSetup ? { codexSetup: options.codexSetup } : {}),
      onEvent: (event) => {
        if (event.type === "state") events.push(`${event.component}:${event.state}:${event.message ?? ""}`);
      },
    }),
    taskRequest,
    harnessRequest,
    remember,
    events,
  };
}

describe("DesktopTaskManager", () => {
  it("rejects new tasks for read-only workspaces before invoking Rust mutation APIs", async () => {
    const { manager, taskRequest } = managerWith({ workspace: workspace("read-only") });
    await expect(manager.begin({ workspace: "api" })).rejects.toThrow(/read-only/);
    expect(taskRequest).not.toHaveBeenCalled();
  });

  it("rejects a feature branch equal to the workspace default branch before branch mutation", async () => {
    const { manager, taskRequest } = managerWith({
      taskRequest: async (path) => {
        if (path === "/api/v1/tasks/get") return snapshot("snapshot");
        throw new Error(`unexpected mutation endpoint ${path}`);
      },
    });
    await expect(manager.checkoutBranch({ taskId: TASK_ID, branch: "main" })).rejects.toThrow(/different from default branch/);
    expect(taskRequest).toHaveBeenCalledTimes(1);
    expect(taskRequest).toHaveBeenCalledWith("/api/v1/tasks/get", { task_id: TASK_ID });
  });

  it("persists only the durable task reference and permits a pre-existing dirty tree", async () => {
    const { manager, taskRequest, remember } = managerWith({
      workspace: { ...workspace(), dirty: true },
      taskRequest: async (path) => {
        if (path === "/api/v1/tasks/begin") {
          return { task: snapshot().task, replayed: false };
        }
        if (path === "/api/v1/tasks/get") return snapshot();
        throw new Error(`unexpected endpoint ${path}`);
      },
    });
    const result = await manager.begin({ workspace: "api", contextQuery: "guard task" });
    expect(result.snapshot.task.id).toBe(TASK_ID);
    expect(taskRequest).toHaveBeenCalledTimes(2);
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ taskId: TASK_ID, workspace: "api" }));
    expect(JSON.stringify(remember.mock.calls)).not.toContain("patch");
    expect(JSON.stringify(remember.mock.calls)).not.toContain("diff");
  });

  it("emits one completion event for the same durable task/head", () => {
    const { manager, events } = managerWith({});
    manager.notifyCompleted(TASK_ID, HEAD);
    manager.notifyCompleted(TASK_ID, HEAD);
    expect(events.filter((event) => event.startsWith("task:completed:"))).toHaveLength(1);
    expect(events[0]).toContain(TASK_ID);
  });

  it("releases the native Codex runtime when its Harness run is cancelled", async () => {
    const release = vi.fn(async () => undefined);
    const codex = {
      account: vi.fn(),
      run: vi.fn(),
      release,
    } as unknown as Pick<CodexHarnessRuntime, "account" | "run" | "release">;
    const { manager, harnessRequest } = managerWith({
      codex,
      harnessRequest: async (path) => {
        if (path === "/api/v1/harness/runs/cancel") return harnessRun("cancelled");
        throw new Error(`unexpected Harness endpoint ${path}`);
      },
    });

    const result = await manager.cancelHarnessRun({ runId: "run-1" });
    expect(result.status).toBe("cancelled");
    expect(release).toHaveBeenCalledWith("run-1");
    expect(harnessRequest).toHaveBeenCalledWith("/api/v1/harness/runs/cancel", { run_id: "run-1" });
  });

  it("delegates renderer-parameter-free Codex setup operations", async () => {
    const ready = { installed: true, version: "0.153.4", authenticated: true, accountType: "chatgpt" as const, canInstall: true };
    const codexSetup = {
      status: vi.fn(async () => ready),
      install: vi.fn(async () => ready),
      login: vi.fn(async () => ready),
    } as unknown as Pick<CodexCliManager, "status" | "install" | "login">;
    const { manager } = managerWith({ codexSetup });

    await expect(manager.getHarnessCodexSetup()).resolves.toEqual(ready);
    await expect(manager.installHarnessCodex()).resolves.toEqual(ready);
    await expect(manager.loginHarnessCodex()).resolves.toEqual(ready);
    expect(codexSetup.status).toHaveBeenCalledTimes(1);
    expect(codexSetup.install).toHaveBeenCalledTimes(1);
    expect(codexSetup.login).toHaveBeenCalledTimes(1);
  });

  it("delegates bounded Codex account and turn operations to the production runtime", async () => {
    const account = vi.fn(async () => ({ authenticated: true, accountType: "chatgpt" as const, planType: "plus", requiresOpenaiAuth: true }));
    const runTurn = vi.fn(async () => ({ runId: "run-1", workspace: "api", threadId: "thread-1", turnId: "turn-1", status: "completed" as const, response: "done", resumed: false, recoveredBeforeTurn: false, activeSkills: [] }));
    const codex = { account, run: runTurn, release: vi.fn(async () => undefined) } as unknown as Pick<CodexHarnessRuntime, "account" | "run" | "release">;
    const { manager } = managerWith({ codex });

    await expect(manager.getHarnessCodexAccount({ workspace: "api" })).resolves.toMatchObject({ accountType: "chatgpt" });
    await expect(manager.runHarnessCodexTurn({ runId: "run-1", prompt: "continue" })).resolves.toMatchObject({ response: "done" });
    expect(account).toHaveBeenCalledWith("api");
    expect(runTurn).toHaveBeenCalledWith({ runId: "run-1", prompt: "continue" });
  });
});
