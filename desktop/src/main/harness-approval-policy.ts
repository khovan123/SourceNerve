import {
  HARNESS_APPROVAL_IPC,
  type DesktopHarnessApprovalListInput,
  type DesktopHarnessApprovalRespondInput,
} from "../shared/harness-approval-api";

export const HARNESS_APPROVAL_INBOUND_IPC_CHANNELS = Object.freeze(Object.values(HARNESS_APPROVAL_IPC));

export function validateHarnessApprovalIpcInvocation(channel: string, args: readonly unknown[]): string | null {
  if (channel === HARNESS_APPROVAL_IPC.list) {
    return args.length === 1 && isListInput(args[0]) ? null : "Harness approval list input is invalid";
  }
  if (channel === HARNESS_APPROVAL_IPC.respond) {
    return args.length === 1 && isRespondInput(args[0]) ? null : "Harness approval response input is invalid";
  }
  return "Harness approval IPC channel is not allowlisted";
}

function isListInput(value: unknown): value is DesktopHarnessApprovalListInput {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !["runId", "status", "limit"].includes(key))) return false;
  if (!boundedId(value.runId)) return false;
  if (value.status !== undefined && !["pending", "allowed", "denied", "consumed", "expired"].includes(String(value.status))) return false;
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 200)) return false;
  return true;
}

function isRespondInput(value: unknown): value is DesktopHarnessApprovalRespondInput {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !["approvalId", "decision"].includes(key))) return false;
  return boundedId(value.approvalId) && (value.decision === "allow" || value.decision === "deny");
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
