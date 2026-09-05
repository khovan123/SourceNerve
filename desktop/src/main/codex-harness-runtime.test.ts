import { describe, expect, it, vi } from "vitest";

import type { ManagedWorkspaceView } from "../shared/desktop-api";
import type { DesktopHarnessRunView } from "../shared/harness-api";
import type { CodexThinRunner } from "./codex-thin-runner";
import { CodexHarnessRuntime, parseCodexNativeApprovalResolution } from "./codex-harness-runtime";

function workspace(overrides: Partial<ManagedWorkspaceView> = {}): ManagedWorkspaceView {
  return {
    id: "repo-1",
    name: "Repo One",
    root: "/tmp/repo-1",
    access: "read-write",
    remote: "origin",
    defaultBranch: "main",
    validation: { state: "ready" },
    head: "a".repeat(40),
    branch: "main",
    dirty: false,
    localWritable: true,
    ...overrides,
  };
}

function run(overrides: Partial<DesktopHarnessRunView> = {}): DesktopHarnessRunView {
  return {
    id: "run-1",
    actor: "operator",
    workspace: "repo-1",
    profile: "interactive-local",
    profileDescription: "Interactive local work",
    origin: "manual",
    sandbox: "workspace-write",
    policies: {
      read: "allow",
      write: "allow",
      exec: "allow",
      git: "ask",
      provider: "ask",
      job: "allow",
    },
    status: "running",
    children: [],
    childrenTruncated: false,
    freshnessState: "current",
    recoveryState: "resumable",
    recoveryReason: "ready",
    closedLoop: {
      phase: "execute",
      workShape: "bounded",
      contextReads: 1,
      executions: 0,
      verificationRequired: false,
      verificationStatus: "idle",
      recoveryStatus: "idle",
      satisfiedProofs: [],
      failureCount: 0,
      learningCount: 0,
      learningHints: [],
    },
    repositoryContext: {
      entrypoints: [],
      guidance: [],
      activePlans: [],
      validationOwners: [],
      proofCandidates: [],
      truncated: false,
    },
    pendingApprovals: 0,
    activeJobs: 0,
    uncertainMutations: 0,
    retryableReadExecutions: 0,
    retryablePreDispatchExecutions: 0,
    blockedPreDispatchExecutions: 0,
    startedAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function fakeRunner() {
  const initialize = vi.fn(async () => undefined);
  const account = vi.fn(async () => ({
    account: { type: "chatgpt" as const, email: "hidden@example.com", planType: "plus" },
    requiresOpenaiAuth: true,
  }));
  const runTurn = vi.fn(async () => ({
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed" as const,
    response: "done",
    recoveredBeforeTurn: false,
    binding: { runId: "run-1", workspaceId: "repo-1", cwd: "/tmp/repo-1", threadId: "thread-1", updatedAt: "2026-09-05T00:00:00.000Z" },
    resumed: false,
    skillActivation: {
      runId: "run-1",
      workspaceId: "repo-1",
      root: "/tmp/skills",
      skills: [{ key: "plugin-one/review", name: "review", path: "/tmp/skills/review/SKILL.md", contentHash: "b".repeat(64) }],
    },
  }));
  const release = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => undefined);
  const shutdown = vi.fn(async () => undefined);
  const runner = {
    initialize,
    account,
    run: runTurn,
    release,
    cancel,
    shutdown,
  } as unknown as CodexThinRunner;
  return { runner, initialize, account, runTurn, release, cancel, shutdown };
}

describe("CodexHarnessRuntime", () => {
  it("projects workspace and Harness policy into a native Codex turn without exposing cwd or sandbox to the caller", async () => {
    const fake = fakeRunner();
    const runtime = new CodexHarnessRuntime({
      runner: fake.runner,
      listWorkspaces: async () => [workspace()],
      loadRun: async () => run(),
    });

    const result = await runtime.run({
      runId: "run-1",
      prompt: "review and update the implementation",
      skillKeys: ["plugin-one/review"],
    });

    expect(fake.runTurn).toHaveBeenCalledWith({
      runId: "run-1",
      workspaceId: "repo-1",
      cwd: "/tmp/repo-1",
      prompt: "review and update the implementation",
      skillKeys: ["plugin-one/review"],
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    });
    expect(result).toMatchObject({
      runId: "run-1",
      workspace: "repo-1",
      threadId: "thread-1",
      turnId: "turn-1",
      response: "done",
      activeSkills: ["plugin-one/review"],
    });
  });

  it("returns only bounded account metadata and never forwards the Codex account email", async () => {
    const fake = fakeRunner();
    const runtime = new CodexHarnessRuntime({
      runner: fake.runner,
      listWorkspaces: async () => [workspace()],
      loadRun: async () => run(),
    });
    const account = await runtime.account("repo-1");
    expect(account).toEqual({ authenticated: true, accountType: "chatgpt", planType: "plus", requiresOpenaiAuth: true });
    expect(JSON.stringify(account)).not.toContain("hidden@example.com");
  });

  it("fails closed for stale, recovering, read-only or non-writable Harness scopes", async () => {
    for (const candidate of [
      run({ freshnessState: "stale" }),
      run({ closedLoop: { ...run().closedLoop, recoveryStatus: "needed" } }),
      run({ sandbox: "read-only" }),
      run({ policies: { ...run().policies, exec: "ask" } }),
      run({ pendingApprovals: 1 }),
      run({ uncertainMutations: 1 }),
    ]) {
      const fake = fakeRunner();
      const runtime = new CodexHarnessRuntime({
        runner: fake.runner,
        listWorkspaces: async () => [workspace()],
        loadRun: async () => candidate,
      });
      await expect(runtime.run({ runId: "run-1", prompt: "continue" })).rejects.toThrow();
      expect(fake.runTurn).not.toHaveBeenCalled();
    }

    const fake = fakeRunner();
    const runtime = new CodexHarnessRuntime({
      runner: fake.runner,
      listWorkspaces: async () => [workspace({ access: "read-only", localWritable: false })],
      loadRun: async () => run(),
    });
    await expect(runtime.run({ runId: "run-1", prompt: "continue" })).rejects.toThrow(/writable managed workspace/);
  });

  it("rejects an oversized native response before it crosses the Desktop IPC boundary", async () => {
    const fake = fakeRunner();
    fake.runTurn.mockResolvedValueOnce({
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      response: "x".repeat(1024 * 1024 + 1),
      recoveredBeforeTurn: false,
      binding: { runId: "run-1", workspaceId: "repo-1", cwd: "/tmp/repo-1", threadId: "thread-1", updatedAt: "2026-09-05T00:00:00.000Z" },
      resumed: false,
      skillActivation: { runId: "run-1", workspaceId: "repo-1", root: "/tmp/skills", skills: [] },
    });
    const runtime = new CodexHarnessRuntime({
      runner: fake.runner,
      listWorkspaces: async () => [workspace()],
      loadRun: async () => run(),
    });

    await expect(runtime.run({ runId: "run-1", prompt: "continue" })).rejects.toThrow(/response exceeds the P3 size limit/);
  });

  it("holds native callbacks on the durable ledger and returns only one-shot turn-scoped approval", async () => {
    const fake = fakeRunner();
    const resolveApproval = vi.fn()
      .mockResolvedValueOnce({ decision: "pending", approvalId: "approval-1", status: "pending", created: true })
      .mockResolvedValueOnce({ decision: "allow", approvalId: "approval-1", status: "consumed", created: false });
    const runtime = new CodexHarnessRuntime({
      runner: fake.runner,
      listWorkspaces: async () => [workspace()],
      loadRun: async () => run(),
      resolveApproval,
      approvalPollMs: 10,
      approvalWaitMs: 200,
    });
    const context = { runId: "run-1", workspaceId: "repo-1", cwd: "/tmp/repo-1" };
    const params = { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "npm test" };

    await expect(runtime.handleServerRequest(context, {
      id: 1,
      method: "item/commandExecution/requestApproval",
      params,
    })).resolves.toEqual({ decision: "accept" });
    expect(resolveApproval).toHaveBeenCalledTimes(2);
    expect(resolveApproval).toHaveBeenCalledWith({
      runId: "run-1",
      requestId: "n:1",
      method: "item/commandExecution/requestApproval",
      payload: params,
    });

    const permissionResolver = vi.fn(async () => ({ decision: "allow" as const, approvalId: "approval-2", status: "consumed" as const, created: false }));
    const permissionRuntime = new CodexHarnessRuntime({
      runner: fake.runner,
      listWorkspaces: async () => [workspace()],
      loadRun: async () => run(),
      resolveApproval: permissionResolver,
    });
    const permissions = { network: { enabled: true }, fileSystem: null };
    await expect(permissionRuntime.handleServerRequest(context, {
      id: "permission-1",
      method: "item/permissions/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-2", permissions },
    })).resolves.toEqual({ permissions, scope: "turn", strictAutoReview: true });
  });

  it("fails closed on denied/unavailable native approval and rejects scope drift", async () => {
    const fake = fakeRunner();
    const denied = new CodexHarnessRuntime({
      runner: fake.runner,
      listWorkspaces: async () => [workspace()],
      loadRun: async () => run(),
      resolveApproval: async () => ({ decision: "deny", approvalId: "approval-deny", status: "denied", created: false }),
    });
    const context = { runId: "run-1", workspaceId: "repo-1", cwd: "/tmp/repo-1" };
    await expect(denied.handleServerRequest(context, {
      id: 2,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-2" },
    })).resolves.toEqual({ decision: "decline" });

    const unavailable = new CodexHarnessRuntime({
      runner: fake.runner,
      listWorkspaces: async () => [workspace()],
      loadRun: async () => run(),
    });
    await expect(unavailable.handleServerRequest(context, {
      id: 3,
      method: "item/permissions/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-3", permissions: { network: { enabled: true }, fileSystem: null } },
    })).resolves.toEqual({ permissions: {}, scope: "turn", strictAutoReview: true });
    await expect(unavailable.handleServerRequest(context, { id: 4, method: "item/tool/requestUserInput", params: {} })).rejects.toThrow(/does not authorize/);
    await expect(unavailable.handleServerRequest({ ...context, workspaceId: "repo-2" }, { id: 5, method: "item/fileChange/requestApproval" })).rejects.toThrow(/scope no longer matches/);
  });

  it("cancels a pending durable approval wait when the Harness run is released", async () => {
    const fake = fakeRunner();
    const runtime = new CodexHarnessRuntime({
      runner: fake.runner,
      listWorkspaces: async () => [workspace()],
      loadRun: async () => run(),
      resolveApproval: async () => ({ decision: "pending", approvalId: "approval-pending", status: "pending", created: false }),
      approvalPollMs: 10,
      approvalWaitMs: 500,
    });
    const context = { runId: "run-1", workspaceId: "repo-1", cwd: "/tmp/repo-1" };
    const pending = runtime.handleServerRequest(context, {
      id: 6,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-6" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.release("run-1");
    await expect(pending).resolves.toEqual({ decision: "decline" });
    expect(fake.cancel).toHaveBeenCalledWith("run-1");
  });

  it("rejects inconsistent daemon approval decisions before they can authorize Codex", () => {
    expect(() => parseCodexNativeApprovalResolution({
      decision: "allow", approval: { id: "approval-1", status: "pending" }, created: false,
    })).toThrow(/must already be consumed/);
    expect(() => parseCodexNativeApprovalResolution({
      decision: "pending", approval: { id: "approval-1", status: "consumed" }, created: false,
    })).toThrow(/state is inconsistent/);
    expect(() => parseCodexNativeApprovalResolution({
      decision: "deny", approval: { id: "approval-1", status: "allowed" }, created: false,
    })).toThrow(/state is inconsistent/);
  });

  it("releases one Harness runtime and shuts down the native pool through the runner", async () => {
    const fake = fakeRunner();
    const runtime = new CodexHarnessRuntime({
      runner: fake.runner,
      listWorkspaces: async () => [workspace()],
      loadRun: async () => run(),
    });
    await runtime.release("run-1");
    expect(fake.cancel).toHaveBeenCalledWith("run-1");
    await runtime.shutdown();
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
  });
});
