import { describe, expect, it } from "vitest";

import { PROVIDER_WORKFLOW_IPC } from "../shared/provider-workflow-api";
import {
  DESKTOP_INBOUND_IPC_CHANNELS,
  validateDesktopIpcInvocation,
} from "./ipc-policy";

const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";
const HEAD = "a".repeat(40);

describe("provider workflow central Desktop IPC integration", () => {
  it("allowlists every provider workflow operation and rejects smuggled controls", () => {
    for (const channel of Object.values(PROVIDER_WORKFLOW_IPC)) {
      expect(DESKTOP_INBOUND_IPC_CHANNELS).toContain(channel);
    }
    expect(validateDesktopIpcInvocation(PROVIDER_WORKFLOW_IPC.state, [TASK_ID])).toBeNull();
    expect(validateDesktopIpcInvocation(PROVIDER_WORKFLOW_IPC.pullMerge, [{ taskId: TASK_ID, expectedHeadSha: HEAD, method: "squash" }])).toBeNull();
    expect(validateDesktopIpcInvocation(PROVIDER_WORKFLOW_IPC.pullMerge, [{ taskId: TASK_ID, expectedHeadSha: HEAD, method: "squash", url: "https://evil.example", refspec: "+main:main" }])).toMatch(/invalid/);
  });
});
