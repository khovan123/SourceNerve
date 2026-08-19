import { describe, expect, it } from "vitest";

import { TASK_IPC } from "../shared/task-api";
import { validateDesktopIpcInvocation } from "./ipc-policy";

const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";
const PROPOSAL_ID = "123e4567-e89b-42d3-a456-426614174001";
const SHA256 = "a".repeat(64);

describe("guarded task IPC policy", () => {
  it("accepts bounded task begin and rejects renderer-controlled extra fields", () => {
    const valid = {
      workspace: "api",
      contextQuery: "Fix workspace lifecycle",
      contextMaxBytes: 64 * 1024,
      contextMaxItems: 20,
    };
    expect(validateDesktopIpcInvocation(TASK_IPC.begin, [valid])).toBeNull();
    expect(validateDesktopIpcInvocation(TASK_IPC.begin, [{ ...valid, endpoint: "/api/v1/github/pulls/merge" }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(TASK_IPC.begin, [{ ...valid, contextMaxBytes: 256 * 1024 }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(TASK_IPC.begin, [{ ...valid, contextQuery: "x".repeat(4_097) }])).toMatch(/invalid/);
  });

  it("accepts only safe feature-branch input", () => {
    expect(validateDesktopIpcInvocation(TASK_IPC.branch, [{ taskId: TASK_ID, branch: "feat/task-123" }])).toBeNull();
    for (const branch of ["../main", "-danger", "refs\\heads\\main", "feature.lock", "bad branch", "main@{1}"]) {
      expect(validateDesktopIpcInvocation(TASK_IPC.branch, [{ taskId: TASK_ID, branch }])).toMatch(/invalid/);
    }
    expect(validateDesktopIpcInvocation(TASK_IPC.branch, [{ taskId: TASK_ID, branch: "feat/x", command: "arbitrary-command" }])).toMatch(/invalid/);
  });

  it("bounds patch bytes and file expectations while rejecting traversal", () => {
    const valid = {
      taskId: TASK_ID,
      expectedFiles: [
        { path: "src/http.rs", sha256: SHA256 },
        { path: "src/new_file.rs" },
      ],
      patch: "diff --git a/src/http.rs b/src/http.rs\n",
    };
    expect(validateDesktopIpcInvocation(TASK_IPC.propose, [valid])).toBeNull();
    expect(validateDesktopIpcInvocation(TASK_IPC.propose, [{ ...valid, expectedFiles: [{ path: "../secret", sha256: SHA256 }] }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(TASK_IPC.propose, [{ ...valid, expectedFiles: [{ path: "/etc/passwd", sha256: SHA256 }] }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(TASK_IPC.propose, [{ ...valid, expectedFiles: [{ path: "src/http.rs", sha256: "bad" }] }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(TASK_IPC.propose, [{ ...valid, patch: "x".repeat(1_000_001) }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(TASK_IPC.propose, [{ ...valid, token: "do-not-accept" }])).toMatch(/invalid/);
  });

  it("requires UUIDs for durable task/proposal operations", () => {
    for (const channel of [TASK_IPC.remember, TASK_IPC.get, TASK_IPC.cancel, TASK_IPC.review, TASK_IPC.push]) {
      expect(validateDesktopIpcInvocation(channel, [TASK_ID])).toBeNull();
      expect(validateDesktopIpcInvocation(channel, ["../task"])).toMatch(/UUID/);
    }
    expect(validateDesktopIpcInvocation(TASK_IPC.apply, [{ taskId: TASK_ID, proposalId: PROPOSAL_ID }])).toBeNull();
    expect(validateDesktopIpcInvocation(TASK_IPC.apply, [{ taskId: TASK_ID, proposalId: "bad", url: "https://evil.example" }])).toMatch(/invalid/);
  });

  it("bounds commit messages and never accepts raw git controls", () => {
    expect(validateDesktopIpcInvocation(TASK_IPC.commit, [{ taskId: TASK_ID, message: "feat: guarded task" }])).toBeNull();
    expect(validateDesktopIpcInvocation(TASK_IPC.commit, [{ taskId: TASK_ID, message: "x".repeat(16 * 1024 + 1) }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(TASK_IPC.commit, [{ taskId: TASK_ID, message: "ok", refspec: "+main:main" }])).toMatch(/invalid/);
  });
});
