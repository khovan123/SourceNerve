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
