import { describe, expect, it } from "vitest";

import { PROVIDER_WORKFLOW_IPC } from "../shared/provider-workflow-api";
import { validateProviderWorkflowIpcInvocation } from "./provider-workflow-policy";

describe("provider pull browser IPC policy", () => {
  it("accepts only bounded pull-list queries", () => {
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullList, [{ workspace: "repo", state: "open", limit: 100 }])).toBeNull();
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullList, [{ workspace: "../repo", state: "open" }])).toMatch(/invalid/);
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullList, [{ workspace: "repo", state: "merged" }])).toMatch(/invalid/);
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullList, [{ workspace: "repo", state: "all", limit: 101 }])).toMatch(/invalid/);
  });

  it("accepts only provider PR/MR HTTPS URLs", () => {
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullOpen, [{ url: "https://github.com/acme/repo/pull/12" }])).toBeNull();
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullOpen, [{ url: "https://gitlab.com/acme/repo/-/merge_requests/12" }])).toBeNull();
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullOpen, [{ url: "https://evil.example/pull/12" }])).toMatch(/invalid/);
  });

  it("accepts only bounded explicit pull mutations", () => {
    const head = "a".repeat(40);
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullMerge, [{ workspace: "repo", pullNumber: 12, expectedHeadSha: head }])).toBeNull();
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullMerge, [{ workspace: "repo", pullNumber: 12, expectedHeadSha: "bad" }])).toMatch(/invalid/);
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullClose, [{ workspace: "repo", pullNumber: 12 }])).toBeNull();
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullClose, [{ workspace: "../repo", pullNumber: 12 }])).toMatch(/invalid/);
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullComment, [{ workspace: "repo", pullNumber: 12, body: "LGTM" }])).toBeNull();
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullComment, [{ workspace: "repo", pullNumber: 12, body: "" }])).toMatch(/invalid/);
    expect(validateProviderWorkflowIpcInvocation(PROVIDER_WORKFLOW_IPC.pullComment, [{ workspace: "repo", pullNumber: 12, body: "x".repeat(10_001) }])).toMatch(/invalid/);
  });

  it("rejects removed task-bound provider mutation channels", () => {
    for (const channel of [
      "desktop:provider-workflow-state",
      "desktop:provider-workflow-issue-create",
      "desktop:provider-workflow-pull-create",
      "desktop:provider-workflow-pull-refresh",
      "desktop:provider-workflow-pull-merge",
      "desktop:provider-workflow-default-sync",
    ]) {
      expect(validateProviderWorkflowIpcInvocation(channel, [{}])).toMatch(/not allowlisted/);
    }
  });
});
