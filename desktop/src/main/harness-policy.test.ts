import { describe, expect, it } from "vitest";

import { HARNESS_IPC } from "../shared/harness-api";
import { validateHarnessIpcInvocation } from "./harness-policy";

describe("Harness Desktop IPC policy", () => {
  it("accepts bounded run, policy switch, and job operations", () => {
    expect(validateHarnessIpcInvocation(HARNESS_IPC.contextRoute, [{ workspace: "repo", runId: "run-1", query: "find callers of begin" }])).toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.beginRun, [{ workspace: "repo", profile: "interactive-local", sandbox: "danger-full-access" }])).toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.listRuns, [{ limit: 25 }])).toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.getRun, [{ runId: "run-1" }])).toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.listEvents, [{ runId: "run-1", afterSeq: -1, limit: 200 }])).toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.cancelJob, [{ runId: "run-1", jobId: "job-1" }])).toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.codexSetupStatus, [])).toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.codexInstall, [])).toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.codexLogin, [])).toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.codexAccount, [{ workspace: "repo" }])).toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.codexTurn, [{ runId: "run-1", prompt: "review and update", skillKeys: ["plugin/review"] }])).toBeNull();
  });

  it("rejects unbounded and renderer-controlled extra fields", () => {
    expect(validateHarnessIpcInvocation(HARNESS_IPC.contextRoute, [{ workspace: "repo", query: "" }])).not.toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.contextRoute, [{ workspace: "repo", query: "find code", override: "semantic" }])).not.toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.contextRoute, [{ workspace: "repo", query: "line one\nline two" }])).not.toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.listRuns, [{ limit: 101 }])).not.toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.beginRun, [{ workspace: "repo", profile: "interactive-local", sandbox: "host-root" }])).not.toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.cancelJob, [{ runId: "run-1", jobId: "job-1", decision: "allow" }])).not.toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.codexInstall, [{ package: "anything" }])).not.toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.codexLogin, [{ command: "codex login --with-api-key" }])).not.toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.codexTurn, [{ runId: "run-1", prompt: "ok", cwd: "/tmp/repo" }])).not.toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.codexTurn, [{ runId: "run-1", prompt: "ok", sandbox: "danger-full-access" }])).not.toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.codexTurn, [{ runId: "run-1", prompt: "ok", skillKeys: ["a/one", "b/two", "c/three"] }])).not.toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.codexTurn, [{ runId: "run-1", prompt: "x".repeat(128 * 1024 + 1) }])).not.toBeNull();
  });
});
