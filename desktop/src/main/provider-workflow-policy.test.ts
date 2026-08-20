import { describe, expect, it } from "vitest";

import { PROVIDER_WORKFLOW_IPC } from "../shared/provider-workflow-api";
import { validateProviderWorkflowIpcInvocation } from "./provider-workflow-policy";

const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";
const HEAD = "a".repeat(40);

describe("provider workflow IPC policy", () => {
  it("accepts only a durable task UUID for state/default sync", () => {
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.state, [TASK_ID])).toBeNull();
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.defaultSync, [TASK_ID])).toBeNull();
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.state, ["../task"])).toMatch(/UUID/);
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.defaultSync, [TASK_ID, { command: "reset" }])).toMatch(/UUID/);
  });

  it("bounds issue and pull create text without accepting repository/base/provider overrides", () => {
    const issue = { taskId: TASK_ID, title: "Investigate lifecycle", body: "Issue body" };
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.issueCreate, [issue])).toBeNull();
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.issueCreate, [{ ...issue, repository: "other/repo" }])).toMatch(/invalid/);
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.issueCreate, [{ ...issue, title: "x".repeat(513) }])).toMatch(/invalid/);

    const pull = { taskId: TASK_ID, title: "feat: guarded flow", body: "PR body", draft: false };
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullCreate, [pull])).toBeNull();
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullCreate, [{ ...pull, base: "develop" }])).toMatch(/invalid/);
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullCreate, [{ ...pull, url: "https://evil.example" }])).toMatch(/invalid/);
  });

  it("requires an exact 40-hex expected head and fixed merge method", () => {
    for (const method of ["merge", "squash", "rebase"]) {
      expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullMerge, [{ taskId: TASK_ID, expectedHeadSha: HEAD, method }])).toBeNull();
    }
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullMerge, [{ taskId: TASK_ID, expectedHeadSha: "latest", method: "merge" }])).toMatch(/invalid/);
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullMerge, [{ taskId: TASK_ID, expectedHeadSha: HEAD, method: "force" }])).toMatch(/invalid/);
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullMerge, [{ taskId: TASK_ID, expectedHeadSha: HEAD, method: "merge", refspec: "+main:main" }])).toMatch(/invalid/);
  });
});
