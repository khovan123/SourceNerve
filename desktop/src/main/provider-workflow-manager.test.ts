import { describe, expect, it, vi } from "vitest";

import type { ManagedWorkspaceView } from "../shared/desktop-api";
import type { DesktopTaskSnapshot } from "../shared/task-api";
import type { ProviderManager } from "./provider-manager";
import type { ProviderWorkflowClient } from "./provider-workflow-client";
import { ProviderWorkflowConflictError, ProviderWorkflowManager } from "./provider-workflow-manager";
import type { DesktopTaskManager } from "./task-manager";
import type { WorkspaceManager } from "./workspace-manager";

const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";
const PUSH_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function workspace(): ManagedWorkspaceView {
  return {
    id: "api",
    name: "API",
    root: "/tmp/api",
    access: "read-write",
    remote: "origin",
    defaultBranch: "main",
    provider: "github",
    repository: "acme/repo",
    validation: { state: "ready" },
    head: PUSH_SHA,
    branch: "feat/task",
    dirty: false,
    localWritable: true,
  };
}

function task(phase = "pushed", overrides: Partial<DesktopTaskSnapshot["lifecycle"]> = {}): DesktopTaskSnapshot {
  return {
    task: {
      id: TASK_ID,
      workspace: "api",
      baseHead: "0".repeat(40),
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    },
    proposals: [],
    events: [],
    lifecycle: {
      taskId: TASK_ID,
      phase: phase as DesktopTaskSnapshot["lifecycle"]["phase"],
      branch: "feat/task",
      pushSha: PUSH_SHA,
      updatedAt: 2,
      ...overrides,
    },
  };
}

function pull(headSha = PUSH_SHA, state: "open" | "merged" = "open") {
  return {
    pull: {
      number: 12,
      title: "feat: task",
      state,
      draft: false,
      base_branch: "main",
      head_branch: "feat/task",
      head_sha: headSha,
      mergeable: true,
      html_url: "https://github.com/acme/repo/pull/12",
    },
  };
}

function setup(options: {
  snapshot?: DesktopTaskSnapshot;
  providerConnected?: boolean;
  getPullSha?: string;
}) {
  let current = options.snapshot ?? task();
  const notifyCompleted = vi.fn();
  const list = vi.fn(async () => [{
    taskId: TASK_ID,
    workspace: "api",
    createdAt: "2026-08-26T00:00:00.000Z",
    snapshot: current,
  }]);
  const tasks = {
    get: vi.fn(async () => current),
    list,
    notifyCompleted,
  } as unknown as DesktopTaskManager;
  const workspaces = { listManagedWorkspaces: vi.fn(async () => [workspace()]) } as unknown as WorkspaceManager;
  const providers = {
    states: vi.fn(() => [{ provider: "github", status: options.providerConnected === false ? "disconnected" : "connected", baseUrl: "https://api.github.com" }]),
    listPullRequests: vi.fn(async () => [{
      provider: "github",
      repository: "acme/repo",
      number: 12,
      title: "feat: task",
      state: "open",
      draft: false,
      baseBranch: "main",
      headBranch: "feat/task",
      headSha: PUSH_SHA,
      author: "desktop-user",
      updatedAt: "2026-08-26T12:00:00.000Z",
      url: "https://github.com/acme/repo/pull/12",
    }]),
    getPullRequest: vi.fn(async () => ({
      provider: "github",
      repository: "acme/repo",
      number: 12,
      title: "feat: task",
      state: "open",
      draft: false,
      baseBranch: "main",
      headBranch: "feat/task",
      headSha: options.getPullSha ?? PUSH_SHA,
      mergeable: true,
    })),
    mergePullRequest: vi.fn(async (_provider, _repository, pullNumber, expectedHeadSha) => ({
      provider: "github",
      repository: "acme/repo",
      number: pullNumber,
      title: "feat: task",
      state: "merged",
      draft: false,
      baseBranch: "main",
      headBranch: "feat/task",
      headSha: expectedHeadSha,
    })),
    closePullRequest: vi.fn(async (_provider, _repository, pullNumber) => ({
      provider: "github",
      repository: "acme/repo",
      number: pullNumber,
      title: "feat: task",
      state: "closed",
      draft: false,
      baseBranch: "main",
      headBranch: "feat/task",
      headSha: PUSH_SHA,
    })),
    commentPullRequest: vi.fn(async () => undefined),
  } as unknown as ProviderManager;
  const client = {
    createIssue: vi.fn(async () => ({ issue: { number: 5, title: "Issue", state: "open", html_url: "https://github.com/acme/repo/issues/5" }, replayed: false })),
    createPull: vi.fn(async () => {
      current = task("pr_open", { pullNumber: 12, pullHeadSha: PUSH_SHA });
      return { replayed: false };
    }),
    getPull: vi.fn(async () => pull(
      options.getPullSha ?? PUSH_SHA,
      current.lifecycle.phase === "merged" || current.lifecycle.phase === "completed" ? "merged" : "open",
    )),
    mergePull: vi.fn(async () => {
      current = task("merged", { pullNumber: 12, pullHeadSha: PUSH_SHA, mergeSha: "c".repeat(40) });
      return { replayed: false };
    }),
    syncDefault: vi.fn(async () => {
      current = task("completed", { pullNumber: 12, pullHeadSha: PUSH_SHA, mergeSha: "c".repeat(40), defaultSyncedHead: "d".repeat(40) });
      return { replayed: false };
    }),
  } as unknown as ProviderWorkflowClient;
  return { manager: new ProviderWorkflowManager({ client, tasks, workspaces, providers }), client, tasks, providers, notifyCompleted };
}

describe("ProviderWorkflowManager", () => {
  it("requires a connected explicit provider before provider operations", async () => {
    const { manager, client } = setup({ providerConnected: false });
    await expect(manager.createIssue({ taskId: TASK_ID, title: "Issue", body: "Body" })).rejects.toThrow(/not connected/);
    expect((client as any).createIssue).not.toHaveBeenCalled();
  });

  it("lists all repository pulls and marks durable task links", async () => {
    const { manager, providers } = setup({ snapshot: task("pr_open", { pullNumber: 12, pullHeadSha: PUSH_SHA }) });
    const result = await manager.listPulls({ workspace: "api", state: "all", limit: 40 });
    expect((providers as any).listPullRequests).toHaveBeenCalledWith("github", "acme/repo", "all", 40);
    expect(result).toEqual([
      expect.objectContaining({ number: 12, linkedTaskIds: [TASK_ID] }),
    ]);
  });

  it("routes a linked pull merge through the durable task lifecycle", async () => {
    const snapshot = task("pr_open", { pullNumber: 12, pullHeadSha: PUSH_SHA });
    const { manager, client, providers } = setup({ snapshot });
    const result = await manager.mergeListedPull({ workspace: "api", pullNumber: 12, expectedHeadSha: PUSH_SHA });
    expect((client as any).mergePull).toHaveBeenCalledWith({ taskId: TASK_ID, expectedHeadSha: PUSH_SHA, method: "squash" });
    expect((providers as any).mergePullRequest).not.toHaveBeenCalled();
    expect(result.pull.state).toBe("merged");
    expect(result.pull.linkedTaskIds).toEqual([TASK_ID]);
  });

  it("supports close and comment actions through the connected provider", async () => {
    const { manager, providers } = setup({});
    const closed = await manager.closeListedPull({ workspace: "api", pullNumber: 12 });
    expect((providers as any).closePullRequest).toHaveBeenCalledWith("github", "acme/repo", 12);
    expect(closed.pull.state).toBe("closed");

    await expect(manager.commentListedPull({ workspace: "api", pullNumber: 12, body: "Looks good" })).resolves.toEqual({ commented: true });
    expect((providers as any).commentPullRequest).toHaveBeenCalledWith("github", "acme/repo", 12, "Looks good");
  });

  it("creates a pull only from pushed task state and verifies exact pushed head", async () => {
    const { manager } = setup({});
    const result = await manager.createPull({ taskId: TASK_ID, title: "PR", body: "Body", draft: false });
    expect(result.pull.headSha).toBe(PUSH_SHA);

    const invalid = setup({ snapshot: task("committed") });
    await expect(invalid.manager.createPull({ taskId: TASK_ID, title: "PR", body: "Body", draft: false })).rejects.toThrow(/must be pushed/);
  });

  it("never calls merge when the fresh provider head differs from the user-confirmed SHA", async () => {
    const snapshot = task("pr_open", { pullNumber: 12, pullHeadSha: PUSH_SHA });
    const { manager, client } = setup({ snapshot, getPullSha: OTHER_SHA });
    await expect(manager.mergePull({ taskId: TASK_ID, expectedHeadSha: PUSH_SHA, method: "squash" })).rejects.toBeInstanceOf(ProviderWorkflowConflictError);
    expect((client as any).mergePull).not.toHaveBeenCalled();
  });

  it("merges only the fresh task-recorded head and emits completion after explicit default sync", async () => {
    const snapshot = task("pr_open", { pullNumber: 12, pullHeadSha: PUSH_SHA });
    const { manager, client, notifyCompleted } = setup({ snapshot });
    const merged = await manager.mergePull({ taskId: TASK_ID, expectedHeadSha: PUSH_SHA, method: "merge" });
    expect((client as any).mergePull).toHaveBeenCalledWith({ taskId: TASK_ID, expectedHeadSha: PUSH_SHA, method: "merge" });
    expect(merged.mergeSha).toBe("c".repeat(40));

    const synced = await manager.syncDefault(TASK_ID);
    expect(synced.head).toBe("d".repeat(40));
    expect(notifyCompleted).toHaveBeenCalledWith(TASK_ID, "d".repeat(40));
  });
});
