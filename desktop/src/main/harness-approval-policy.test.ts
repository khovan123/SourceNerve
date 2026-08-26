import { describe, expect, it } from "vitest";

import { HARNESS_APPROVAL_IPC } from "../shared/harness-approval-api";
import { validateHarnessApprovalIpcInvocation } from "./harness-approval-policy";
import {
  DESKTOP_INBOUND_IPC_CHANNELS,
  validateDesktopIpcInvocation,
} from "./ipc-policy";

describe("Harness approval Desktop IPC policy", () => {
  it("allowlists list/respond through the central Desktop policy", () => {
    expect(DESKTOP_INBOUND_IPC_CHANNELS).toContain(HARNESS_APPROVAL_IPC.list);
    expect(DESKTOP_INBOUND_IPC_CHANNELS).toContain(HARNESS_APPROVAL_IPC.respond);
    expect(validateDesktopIpcInvocation(HARNESS_APPROVAL_IPC.list, [{ runId: "run-1", status: "pending", limit: 100 }])).toBeNull();
    expect(validateDesktopIpcInvocation(HARNESS_APPROVAL_IPC.respond, [{ approvalId: "approval-1", decision: "allow" }])).toBeNull();
  });

  it("rejects smuggled, oversized and unsupported list inputs", () => {
    expect(validateHarnessApprovalIpcInvocation(HARNESS_APPROVAL_IPC.list, [{ runId: "run-1", token: "secret" }])).toMatch(/invalid/);
    expect(validateHarnessApprovalIpcInvocation(HARNESS_APPROVAL_IPC.list, [{ runId: "x".repeat(129) }])).toMatch(/invalid/);
    expect(validateHarnessApprovalIpcInvocation(HARNESS_APPROVAL_IPC.list, [{ runId: "run-1", status: "all" }])).toMatch(/invalid/);
    expect(validateHarnessApprovalIpcInvocation(HARNESS_APPROVAL_IPC.list, [{ runId: "run-1", limit: 201 }])).toMatch(/invalid/);
  });

  it("accepts only allow or deny for one bounded approval id", () => {
    expect(validateHarnessApprovalIpcInvocation(HARNESS_APPROVAL_IPC.respond, [{ approvalId: "approval-1", decision: "deny" }])).toBeNull();
    expect(validateHarnessApprovalIpcInvocation(HARNESS_APPROVAL_IPC.respond, [{ approvalId: "approval-1", decision: "approve" }])).toMatch(/invalid/);
    expect(validateHarnessApprovalIpcInvocation(HARNESS_APPROVAL_IPC.respond, [{ approvalId: "approval-1", decision: "allow", rawArgs: {} }])).toMatch(/invalid/);
    expect(validateHarnessApprovalIpcInvocation(HARNESS_APPROVAL_IPC.respond, [])).toMatch(/invalid/);
  });
});
