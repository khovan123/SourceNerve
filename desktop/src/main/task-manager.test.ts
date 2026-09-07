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

type TestCodexRuntime = Pick<CodexHarnessRuntime, "account" | "status" | "usage" | "run" | "release" | "clearWorkspace" | "listConversations" | "conversation" | "resumeConversation">;

function managerWith(options: {
  workspace?: ManagedWorkspaceView;
  taskRequest?: (path: string, body: object) => Promise<unknown>;
  harnessRequest?: (path: string, body: object) => Promise<unknown>;
  codex?: TestCodexRuntime;
  codexSetup?: Pick<CodexCliManager, "status" | "install" | "login">;
  npmSkillPreflight?: (workspaceId: string, prompt: string) => Promise<{ activeSkillKeys: string[]; installed: string[]; searches: string[] }>;
  skillPreflight?: (workspaceId: string, prompt: string) => Promise<{ activeSkillKeys: string[]; autoInstalledPluginIds: string[] }>;
}) {
  const taskRequest = vi.fn(options.taskRequest ?? (async () => snapshot()));
  const harnessRequest = vi.fn(options.harnessRequest ?? (async (requestPath: string, body: object) => {
    if (requestPath === "/api/v1/harness/context/route") {
      const query = typeof (body as { query?: unknown }).query === "string" ? (body as { query: string }).query : "context";
      return {
        workspace: "api", retrieve: true, route: "semantic", search_query: query,
        reason: "repository context required", surfaces: ["plugin_catalog"],
        work_shape: "bounded", selected_proof_type: "focused-test", selected_proof_source: "package.json", selected_proof_command: "npm test",
      };
    }
    if (requestPath === "/api/v1/harness/native/execution/start") {
      return { run_id: "run-1", phase: "execute", verification_required: false, verification_status: "idle", recovery_status: "idle" };
    }
    if (requestPath === "/api/v1/harness/native/execution/finish") {
      return { run_id: "run-1", phase: "verify", verification_required: true, verification_status: "pending", recovery_status: "idle" };
    }
    if (requestPath === "/api/v1/harness/native/verification/run") {
      return {
        run_id: "run-1", skipped: false, proof_type: "focused-test", proof_source: "package.json", proof_command: "npm test",
        success: true, exit_code: 0, timed_out: false, stdout: "", stderr: "", truncated: false,
      };
    }
    return harnessRun();
  }));
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
  const npmSkillPreflight = options.npmSkillPreflight ?? vi.fn(async () => ({ activeSkillKeys: [], installed: [], searches: ["coding"] }));
  return {
    manager: new DesktopTaskManager({
      client,
      workspaceManager,
      registry,
      ...(options.codex ? { codex: options.codex } : {}),
      ...(options.codexSetup ? { codexSetup: options.codexSetup } : {}),
      npmSkillPreflight,
      ...(options.skillPreflight ? { skillPreflight: options.skillPreflight } : {}),
      onEvent: (event) => {
        if (event.type === "state") events.push(`${event.component}:${event.state}:${event.message ?? ""}`);
      },
    }),
    taskRequest,
    harnessRequest,
    remember,
    npmSkillPreflight,
    events,
  };
}


function fakeCodexRuntime(overrides: Partial<TestCodexRuntime> = {}): TestCodexRuntime {
  return {
    account: vi.fn(async () => ({ authenticated: true, accountType: "chatgpt" as const, planType: "plus", requiresOpenaiAuth: true })),
    status: vi.fn(async () => ({ authenticated: true, accountType: "chatgpt" as const, planType: "plus", requiresOpenaiAuth: true, rateLimits: [] })),
    usage: vi.fn(async () => ({ summary: {} })),
    run: vi.fn(async () => ({ runId: "run-1", workspace: "api", threadId: "thread-1", turnId: "turn-1", status: "completed" as const, response: "done", resumed: false, recoveredBeforeTurn: false, activeSkills: [] })),
    release: vi.fn(async () => undefined),
    clearWorkspace: vi.fn(async () => []),
    listConversations: vi.fn(async () => []),
    conversation: vi.fn(async (runId: string) => ({ runId, workspace: "api", messages: [] })),
    resumeConversation: vi.fn(async ({ runId, threadId }: { runId: string; threadId: string }) => ({ runId, workspace: "api", threadId, messages: [] })),
    ...overrides,
  } as TestCodexRuntime;
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
    const codex = fakeCodexRuntime({ release });
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

  it("runs direct-user bang commands against the exact workspace/request id without fetching a Harness run", async () => {
    const { manager, harnessRequest } = managerWith({
      harnessRequest: async (path, body) => {
        if (path === "/api/v1/harness/commands/execute") {
          return {
            workspace: "api", command: "git pull", request_id: "bang-1",
            status: "completed", sandbox: "workspace-write",
            sandbox_enforcement: "full", success: true, exit_code: 0, timed_out: false,
            stdout: "Already up to date.\n", stderr: "", truncated: false,
          };
        }
        throw new Error(`unexpected Harness endpoint ${path}`);
      },
    });

    await expect(manager.runHarnessCommand({
      workspace: "api", command: "git pull", requestId: "bang-1", timeoutMs: 30_000,
    })).resolves.toMatchObject({ status: "completed", success: true, stdout: "Already up to date.\n" });
    expect(harnessRequest).toHaveBeenCalledTimes(1);
    expect(harnessRequest).toHaveBeenCalledWith("/api/v1/harness/commands/execute", {
      workspace: "api", command: "git pull", request_id: "bang-1", timeout_ms: 30_000,
    });
  });

  it("rejects a bang-command response that no longer matches the exact direct-shell request", async () => {
    const { manager } = managerWith({
      harnessRequest: async (path) => {
        if (path === "/api/v1/harness/commands/execute") {
          return {
            workspace: "api", command: "different command", request_id: "bang-1",
            status: "completed", success: true, stdout: "", stderr: "", truncated: false,
          };
        }
        throw new Error(`unexpected Harness endpoint ${path}`);
      },
    });

    await expect(manager.runHarnessCommand({
      workspace: "api", command: "git pull", requestId: "bang-1",
    })).rejects.toThrow(/does not match the request/);
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
    const codex = fakeCodexRuntime({ account, run: runTurn });
    const { manager, harnessRequest } = managerWith({ codex });

    await expect(manager.getHarnessCodexAccount({ workspace: "api" })).resolves.toMatchObject({ accountType: "chatgpt" });
    await expect(manager.runHarnessCodexTurn({ runId: "run-1", prompt: "continue" })).resolves.toMatchObject({ response: "done" });
    expect(account).toHaveBeenCalledWith("api");
    expect(harnessRequest).toHaveBeenCalledWith("/api/v1/harness/runs/get", { run_id: "run-1" });
    expect(harnessRequest).toHaveBeenCalledWith("/api/v1/harness/context/route", { workspace: "api", run_id: "run-1", query: "continue", start_cycle: true });
    expect(runTurn).toHaveBeenCalledWith({ runId: "run-1", prompt: "continue", skillKeys: [] });
    expect(harnessRequest).toHaveBeenCalledWith("/api/v1/harness/native/execution/start", { run_id: "run-1" });
    expect(harnessRequest).toHaveBeenCalledWith("/api/v1/harness/native/execution/finish", { run_id: "run-1", success: true });
    expect(harnessRequest).toHaveBeenCalledWith("/api/v1/harness/native/verification/run", { run_id: "run-1", timeout_ms: 600_000 });
  });

  it("runs mandatory npm discovery for a greeting without injecting plugin skills", async () => {
    const npmSkillPreflight = vi.fn(async () => ({ activeSkillKeys: [], installed: [], searches: ["coding"] }));
    const skillPreflight = vi.fn(async () => ({ activeSkillKeys: ["sourcenerve/repository-change-workflow"], autoInstalledPluginIds: [] }));
    const runTurn = vi.fn(async () => ({ runId: "run-1", workspace: "api", threadId: "thread-1", turnId: "turn-1", status: "completed" as const, response: "Hi", resumed: false, recoveredBeforeTurn: false, activeSkills: [] }));
    const codex = fakeCodexRuntime({ run: runTurn });
    const { manager } = managerWith({ codex, npmSkillPreflight, skillPreflight });

    await expect(manager.runHarnessCodexTurn({ runId: "run-1", prompt: "hi" })).resolves.toMatchObject({ response: "Hi" });
    expect(npmSkillPreflight).toHaveBeenCalledWith("api", "hi");
    expect(skillPreflight).not.toHaveBeenCalled();
    expect(runTurn).toHaveBeenCalledWith({ runId: "run-1", prompt: "hi", skillKeys: [] });
  });

  it("waits for mandatory npm skill discovery before starting native Codex", async () => {
    let resolvePreflight!: (value: { activeSkillKeys: string[]; installed: string[]; searches: string[] }) => void;
    const npmSkillPreflight = vi.fn(() => new Promise<{ activeSkillKeys: string[]; installed: string[]; searches: string[] }>((resolve) => {
      resolvePreflight = resolve;
    }));
    const runTurn = vi.fn(async () => ({ runId: "run-1", workspace: "api", threadId: "thread-1", turnId: "turn-1", status: "completed" as const, response: "done", resumed: false, recoveredBeforeTurn: false, activeSkills: [] }));
    const codex = fakeCodexRuntime({ run: runTurn });
    const { manager } = managerWith({ codex, npmSkillPreflight });

    const turn = manager.runHarnessCodexTurn({ runId: "run-1", prompt: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(npmSkillPreflight).toHaveBeenCalledWith("api", "hi");
    expect(runTurn).not.toHaveBeenCalled();

    resolvePreflight({ activeSkillKeys: [], installed: [], searches: ["coding"] });
    await expect(turn).resolves.toMatchObject({ response: "done" });
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("runs mandatory npm skill discovery first and uses plugin skills only as secondary candidates", async () => {
    const npmSkillPreflight = vi.fn(async () => ({
      activeSkillKeys: ["npm-123/react-best-practices"],
      installed: ["vercel-labs/agent-skills@vercel-react-best-practices"],
      searches: ["react"],
    }));
    const skillPreflight = vi.fn(async () => ({
      activeSkillKeys: ["sourcenerve/repository-change-workflow"],
      autoInstalledPluginIds: ["react-guidance"],
    }));
    const runTurn = vi.fn(async () => ({ runId: "run-1", workspace: "api", threadId: "thread-1", turnId: "turn-1", status: "completed" as const, response: "done", resumed: false, recoveredBeforeTurn: false, activeSkills: ["npm-123/react-best-practices", "sourcenerve/repository-change-workflow"] }));
    const codex = fakeCodexRuntime({ run: runTurn });
    const { manager, harnessRequest } = managerWith({ codex, npmSkillPreflight, skillPreflight });

    await expect(manager.runHarnessCodexTurn({ runId: "run-1", prompt: "redesign the React screen" })).resolves.toMatchObject({ response: "done" });
    expect(harnessRequest).toHaveBeenCalledWith("/api/v1/harness/context/route", { workspace: "api", run_id: "run-1", query: "redesign the React screen", start_cycle: true });
    expect(npmSkillPreflight).toHaveBeenCalledWith("api", "redesign the React screen");
    expect(skillPreflight).toHaveBeenCalledWith("api", "redesign the React screen");
    expect(runTurn).toHaveBeenCalledWith({
      runId: "run-1",
      prompt: "redesign the React screen",
      skillKeys: ["npm-123/react-best-practices", "sourcenerve/repository-change-workflow"],
    });
  });

  it("recovers a failed deterministic proof with bounded native Codex recovery and verifies again", async () => {
    const runTurn = vi.fn()
      .mockResolvedValueOnce({ runId: "run-1", workspace: "api", threadId: "thread-1", turnId: "turn-1", status: "completed" as const, response: "initial", resumed: false, recoveredBeforeTurn: false, activeSkills: [] })
      .mockResolvedValueOnce({ runId: "run-1", workspace: "api", threadId: "thread-1", turnId: "turn-2", status: "completed" as const, response: "recovered", resumed: true, recoveredBeforeTurn: false, activeSkills: [] });
    let verificationCount = 0;
    const harnessRequest = vi.fn(async (requestPath: string, body: object) => {
      if (requestPath === "/api/v1/harness/runs/get") return harnessRun();
      if (requestPath === "/api/v1/harness/context/route") {
        return { workspace: "api", retrieve: true, route: "semantic", search_query: "fix login", reason: "context", surfaces: ["plugin_catalog"], work_shape: "bounded", selected_proof_type: "focused-test", selected_proof_source: "package.json", selected_proof_command: "npm test" };
      }
      if (requestPath === "/api/v1/harness/native/execution/start") {
        return { run_id: "run-1", phase: "execute", verification_required: false, verification_status: "idle", recovery_status: verificationCount > 0 ? "in-progress" : "idle" };
      }
      if (requestPath === "/api/v1/harness/native/execution/finish") {
        return { run_id: "run-1", phase: "verify", verification_required: true, verification_status: "pending", recovery_status: verificationCount > 0 ? "in-progress" : "idle" };
      }
      if (requestPath === "/api/v1/harness/native/verification/run") {
        verificationCount += 1;
        return verificationCount === 1
          ? { run_id: "run-1", skipped: false, proof_type: "focused-test", proof_source: "package.json", proof_command: "npm test", success: false, exit_code: 1, timed_out: false, stdout: "", stderr: "1 test failed", truncated: false }
          : { run_id: "run-1", skipped: false, proof_type: "focused-test", proof_source: "package.json", proof_command: "npm test", success: true, exit_code: 0, timed_out: false, stdout: "all pass", stderr: "", truncated: false };
      }
      throw new Error(`unexpected Harness request ${requestPath}: ${JSON.stringify(body)}`);
    });
    const codex = fakeCodexRuntime({ run: runTurn });
    const { manager } = managerWith({ codex, harnessRequest });

    await expect(manager.runHarnessCodexTurn({ runId: "run-1", prompt: "fix login" })).resolves.toMatchObject({ response: "recovered" });
    expect(runTurn).toHaveBeenCalledTimes(2);
    const recoveryCall = runTurn.mock.calls[1]?.[0] as { prompt: string; recovery?: boolean };
    expect(recoveryCall.recovery).toBe(true);
    expect(recoveryCall.prompt).toContain("[[SOURCENERVE_HARNESS_RECOVERY]]");
    expect(recoveryCall.prompt).toContain("npm test");
    expect(recoveryCall.prompt).toContain("1 test failed");
    expect(verificationCount).toBe(2);
  });

  it("fails closed after two recovery attempts when deterministic verification still fails", async () => {
    const runTurn = vi.fn(async ({ recovery }: { recovery?: boolean }) => ({
      runId: "run-1", workspace: "api", threadId: "thread-1", turnId: recovery ? "turn-recovery" : "turn-initial",
      status: "completed" as const, response: recovery ? "tried recovery" : "initial", resumed: Boolean(recovery), recoveredBeforeTurn: false, activeSkills: [],
    }));
    const harnessRequest = vi.fn(async (requestPath: string) => {
      if (requestPath === "/api/v1/harness/runs/get") return harnessRun();
      if (requestPath === "/api/v1/harness/context/route") return { workspace: "api", retrieve: true, route: "semantic", search_query: "fix login", reason: "context", surfaces: ["plugin_catalog"], work_shape: "bounded", selected_proof_type: "focused-test", selected_proof_source: "package.json", selected_proof_command: "npm test" };
      if (requestPath === "/api/v1/harness/native/execution/start") return { run_id: "run-1", phase: "execute", verification_required: false, verification_status: "idle", recovery_status: "in-progress" };
      if (requestPath === "/api/v1/harness/native/execution/finish") return { run_id: "run-1", phase: "verify", verification_required: true, verification_status: "pending", recovery_status: "in-progress" };
      if (requestPath === "/api/v1/harness/native/verification/run") return { run_id: "run-1", skipped: false, proof_type: "focused-test", proof_source: "package.json", proof_command: "npm test", success: false, exit_code: 1, timed_out: false, stdout: "", stderr: "still failing", truncated: false };
      throw new Error(`unexpected Harness request ${requestPath}`);
    });
    const codex = fakeCodexRuntime({ run: runTurn });
    const { manager } = managerWith({ codex, harnessRequest });

    await expect(manager.runHarnessCodexTurn({ runId: "run-1", prompt: "fix login" })).rejects.toThrow(/verification failed after recovery attempts.*npm test.*still failing/i);
    expect(runTurn).toHaveBeenCalledTimes(3);
    expect(runTurn.mock.calls.slice(1).every((call) => (call[0] as { recovery?: boolean }).recovery === true)).toBe(true);
  });

  it("recovers a native Codex execution crash in the same supervised cycle before verification", async () => {
    const runTurn = vi.fn()
      .mockRejectedValueOnce(new Error("app-server process crashed"))
      .mockResolvedValueOnce({ runId: "run-1", workspace: "api", threadId: "thread-1", turnId: "turn-recovery", status: "completed" as const, response: "continued after crash", resumed: true, recoveredBeforeTurn: true, activeSkills: [] });
    const harnessRequest = vi.fn(async (requestPath: string, body: object) => {
      if (requestPath === "/api/v1/harness/runs/get") return harnessRun();
      if (requestPath === "/api/v1/harness/context/route") return { workspace: "api", retrieve: true, route: "semantic", search_query: "fix login", reason: "context", surfaces: ["plugin_catalog"], work_shape: "bounded", selected_proof_type: "focused-test", selected_proof_source: "package.json", selected_proof_command: "npm test" };
      if (requestPath === "/api/v1/harness/native/execution/start") return { run_id: "run-1", phase: "execute", verification_required: false, verification_status: "idle", recovery_status: "in-progress" };
      if (requestPath === "/api/v1/harness/native/execution/finish") {
        const success = (body as { success?: boolean }).success === true;
        return { run_id: "run-1", phase: success ? "verify" : "recover", verification_required: success, verification_status: success ? "pending" : "idle", recovery_status: success ? "in-progress" : "needed" };
      }
      if (requestPath === "/api/v1/harness/native/verification/run") return { run_id: "run-1", skipped: false, proof_type: "focused-test", proof_source: "package.json", proof_command: "npm test", success: true, exit_code: 0, timed_out: false, stdout: "pass", stderr: "", truncated: false };
      throw new Error(`unexpected Harness request ${requestPath}`);
    });
    const codex = fakeCodexRuntime({ run: runTurn });
    const { manager } = managerWith({ codex, harnessRequest });

    await expect(manager.runHarnessCodexTurn({ runId: "run-1", prompt: "fix login" })).resolves.toMatchObject({ response: "continued after crash" });
    expect(runTurn).toHaveBeenCalledTimes(2);
    const recovery = runTurn.mock.calls[1]?.[0] as { prompt: string; recovery?: boolean };
    expect(recovery.recovery).toBe(true);
    expect(recovery.prompt).toContain("[[SOURCENERVE_HARNESS_RECOVERY]]");
    expect(recovery.prompt).toContain("app-server process crashed");
  });

  it("records denied native Codex execution in Harness without automatically retrying user-denied authority", async () => {
    const runTurn = vi.fn(async () => { throw new Error("approval denied by user"); });
    const harnessRequest = vi.fn(async (requestPath: string, body: object) => {
      if (requestPath === "/api/v1/harness/runs/get") return harnessRun();
      if (requestPath === "/api/v1/harness/context/route") return { workspace: "api", retrieve: true, route: "semantic", search_query: "fix login", reason: "context", surfaces: ["plugin_catalog"], work_shape: "bounded", selected_proof_type: "focused-test", selected_proof_source: "package.json", selected_proof_command: "npm test" };
      if (requestPath === "/api/v1/harness/native/execution/start") return { run_id: "run-1", phase: "execute", verification_required: false, verification_status: "idle", recovery_status: "idle" };
      if (requestPath === "/api/v1/harness/native/execution/finish") return { run_id: "run-1", phase: "recover", verification_required: false, verification_status: "idle", recovery_status: "needed" };
      throw new Error(`unexpected Harness request ${requestPath}: ${JSON.stringify(body)}`);
    });
    const codex = fakeCodexRuntime({ run: runTurn });
    const { manager } = managerWith({ codex, harnessRequest });

    await expect(manager.runHarnessCodexTurn({ runId: "run-1", prompt: "fix login" })).rejects.toThrow("approval denied by user");
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(harnessRequest).toHaveBeenCalledWith("/api/v1/harness/native/execution/finish", { run_id: "run-1", success: false, error_category: "denied" });
  });

  it("lists and clears native Codex conversations for the requested managed workspace", async () => {
    const native = [{
      threadId: "thread-1",
      runId: "run-1",
      workspace: "api",
      title: "Fix resume labels",
      preview: "Use native history",
      createdAt: "2026-09-05T08:00:00.000Z",
      updatedAt: "2026-09-05T08:01:00.000Z",
      model: "gpt-codex",
      status: "idle",
    }];
    const listConversations = vi.fn(async () => native);
    const clearWorkspaceRuntime = vi.fn(async () => ["run-1"]);
    const codex = fakeCodexRuntime({ listConversations, clearWorkspace: clearWorkspaceRuntime });
    const { manager } = managerWith({ codex });

    await expect(manager.listHarnessCodexConversations({ workspace: "api" })).resolves.toEqual(native);
    await expect(manager.clearHarnessCodexConversations({ workspace: "api" })).resolves.toEqual({ workspace: "api", deleted: 1 });
    expect(listConversations).toHaveBeenCalledWith("api");
    expect(clearWorkspaceRuntime).toHaveBeenCalledWith("api");
  });

  it("resumes a selected native Codex thread through a fresh Harness audit run", async () => {
    const listConversations = vi.fn(async () => [{
      threadId: "thread-native",
      workspace: "api",
      title: "Native conversation",
      preview: "Continue this work",
      createdAt: "2026-09-05T08:00:00.000Z",
      updatedAt: "2026-09-05T08:01:00.000Z",
      status: "idle",
    }]);
    const resumeConversation = vi.fn(async ({ runId, threadId }: { runId: string; threadId: string }) => ({
      runId,
      workspace: "api",
      threadId,
      messages: [{ id: "user-1", role: "user" as const, text: "Continue this work", createdAt: "2026-09-05T08:00:00.000Z", turnId: "turn-1" }],
    }));
    const codex = fakeCodexRuntime({ listConversations, resumeConversation });
    const { manager, harnessRequest } = managerWith({
      codex,
      harnessRequest: async (path) => {
        if (path === "/api/v1/harness/runs/begin") return { snapshot: harnessRun() };
        if (path === "/api/v1/harness/runs/cancel") return harnessRun("cancelled");
        throw new Error(`unexpected Harness endpoint ${path}`);
      },
    });

    await expect(manager.resumeHarnessCodexConversation({ workspace: "api", threadId: "thread-native" })).resolves.toMatchObject({
      runId: "run-1",
      threadId: "thread-native",
      messages: [{ text: "Continue this work" }],
    });
    expect(listConversations).toHaveBeenCalledWith("api");
    expect(resumeConversation).toHaveBeenCalledWith({ runId: "run-1", threadId: "thread-native" });
    expect(harnessRequest).toHaveBeenCalledWith("/api/v1/harness/runs/begin", expect.objectContaining({
      workspace: "api",
      profile: "interactive-local",
      sandbox: "workspace-write",
    }));
  });

  it("uses native Codex as the conversation source of truth instead of writing a renderer transcript", async () => {
    const runTurn = vi.fn(async () => ({
      runId: "run-1",
      workspace: "api",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed" as const,
      response: "done",
      resumed: true,
      recoveredBeforeTurn: false,
      activeSkills: [],
    }));
    const conversation = vi.fn(async () => ({
      runId: "run-1",
      workspace: "api",
      threadId: "thread-1",
      messages: [{ id: "native-1", role: "assistant" as const, text: "native history", createdAt: "2026-09-05T08:01:00.000Z", turnId: "turn-1" }],
    }));
    const codex = fakeCodexRuntime({ run: runTurn, conversation });
    const { manager } = managerWith({ codex });

    await manager.initialize();
    await expect(manager.getHarnessCodexConversation({ runId: "run-1" })).resolves.toMatchObject({ threadId: "thread-1", messages: [{ text: "native history" }] });
    await expect(manager.runHarnessCodexTurn({ runId: "run-1", prompt: "continue" })).resolves.toMatchObject({ response: "done" });

    expect(conversation).toHaveBeenCalledWith("run-1");
    expect(runTurn).toHaveBeenCalledWith({ runId: "run-1", prompt: "continue", skillKeys: [] });
  });
});
