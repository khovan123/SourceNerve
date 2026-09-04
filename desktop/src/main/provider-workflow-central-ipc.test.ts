import { describe, expect, it } from "vitest";

import { PROVIDER_WORKFLOW_IPC } from "../shared/provider-workflow-api";
import { DESKTOP_INBOUND_IPC_CHANNELS, validateDesktopIpcInvocation } from "./ipc-policy";

describe("provider pull browser central Desktop IPC integration", () => {
  it("allowlists browse-only operations and excludes removed lifecycle mutations", () => {
    for (const channel of Object.values(PROVIDER_WORKFLOW_IPC)) {
      expect(DESKTOP_INBOUND_IPC_CHANNELS).toContain(channel);
    }
    expect(validateDesktopIpcInvocation(PROVIDER_WORKFLOW_IPC.pullList, [{ workspace: "repo", state: "open", limit: 50 }])).toBeNull();
    expect(validateDesktopIpcInvocation(PROVIDER_WORKFLOW_IPC.pullOpen, [{ url: "https://github.com/acme/repo/pull/5" }])).toBeNull();

    for (const channel of [
      "desktop:provider-workflow-state",
      "desktop:provider-workflow-issue-create",
      "desktop:provider-workflow-pull-create",
      "desktop:provider-workflow-pull-refresh",
      "desktop:provider-workflow-pull-merge",
      "desktop:provider-workflow-default-sync",
    ]) {
      expect(DESKTOP_INBOUND_IPC_CHANNELS).not.toContain(channel);
      expect(validateDesktopIpcInvocation(channel, [{}])).toMatch(/not allowlisted/);
    }
  });
});
