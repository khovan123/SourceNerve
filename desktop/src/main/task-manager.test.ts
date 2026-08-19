import { describe, expect, it, vi } from "vitest";

import type { ManagedWorkspaceView } from "../shared/desktop-api";
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
    index: { state: "current", indexedHead: HEAD, graphVersion: 7, parsedFiles: 10, failedFiles: 0 },
  };
}

function snapshot(phase: string = "snapshot") {
  return {
    task: {
      id: TASK_ID,
      workspace: "api",
      base_head: HEAD,
      graph_version: 7,
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

function managerWith(options: {
  workspace?: ManagedWorkspaceView;
  taskRequest?: (path: string, body: object) => Promise<unknown>;
}) {
  const taskRequest = vi.fn(options.taskRequest ?? (async () => snapshot()));
  const client = { taskRequest } as unknown as SourceNerveClient;
  const workspaceManager = {
    listManagedWorkspaces: vi.fn(async () => [options.workspace ?? workspace()]),
  } as unknown as WorkspaceManager;
  const remember = vi.fn(async () => []);
  const registry = {
    initialize: vi.fn(async () => []),
    snapshot: vi.fn(() => []),
    remember,
  } as unknown as DesktopTaskRegistry;
  return {
    manager: new DesktopTaskManager({ client, workspaceManager, registry }),
    taskRequest,
    remember,
  };
}

describe("DesktopTaskManager", () => {
  it("rejects new tasks for read-only workspaces before invoking Rust mutation APIs", async () => {
    const { manager, taskRequest } = managerWith({ workspace: workspace("read-only") });
    await expect(manager.begin({ workspace: "api", contextMaxBytes: 65536, contextMaxItems: 20 })).rejects.toThrow(/read-only/);
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

  it("persists only the durable task reference after a successful begin", async () => {
    const { manager, taskRequest, remember } = managerWith({
      taskRequest: async (path) => {
        if (path === "/api/v1/tasks/begin") {
          return { task: snapshot().task, context: null, replayed: false };
        }
        if (path === "/api/v1/tasks/get") return snapshot();
        throw new Error(`unexpected endpoint ${path}`);
      },
    });
    const result = await manager.begin({ workspace: "api", contextQuery: "guard task", contextMaxBytes: 65536, contextMaxItems: 20 });
    expect(result.snapshot.task.id).toBe(TASK_ID);
    expect(taskRequest).toHaveBeenCalledTimes(2);
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ taskId: TASK_ID, workspace: "api" }));
    expect(JSON.stringify(remember.mock.calls)).not.toContain("patch");
    expect(JSON.stringify(remember.mock.calls)).not.toContain("diff");
  });
});
