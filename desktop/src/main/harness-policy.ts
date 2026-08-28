import {
  HARNESS_IPC,
  type DesktopHarnessEventsInput,
  type DesktopHarnessRunBeginInput,
  type DesktopHarnessJobCancelInput,
  type DesktopHarnessJobListInput,
  type DesktopHarnessRunIdInput,
  type DesktopHarnessRunListInput,
} from "../shared/harness-api";

export const HARNESS_INBOUND_IPC_CHANNELS = Object.freeze(Object.values(HARNESS_IPC));

export function validateHarnessIpcInvocation(channel: string, args: readonly unknown[]): string | null {
  if (channel === HARNESS_IPC.beginRun) return args.length === 1 && isRunBegin(args[0]) ? null : "Harness run begin input is invalid";
  if (channel === HARNESS_IPC.listRuns) return args.length <= 1 && (args.length === 0 || isRunList(args[0])) ? null : "Harness run list input is invalid";
  if (channel === HARNESS_IPC.getRun || channel === HARNESS_IPC.cancelRun) return args.length === 1 && isRunId(args[0]) ? null : "Harness run input is invalid";
  if (channel === HARNESS_IPC.listEvents) return args.length === 1 && isEvents(args[0]) ? null : "Harness event input is invalid";
  if (channel === HARNESS_IPC.listJobs) return args.length === 1 && isJobList(args[0]) ? null : "Harness job list input is invalid";
  if (channel === HARNESS_IPC.cancelJob) return args.length === 1 && isJobCancel(args[0]) ? null : "Harness job cancel input is invalid";
  return "Harness IPC channel is not allowlisted";
}

function isRunBegin(value: unknown): value is DesktopHarnessRunBeginInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !["workspace", "profile", "sandbox"].includes(key))) return false;
  if (!boundedId(value.workspace) || typeof value.profile !== "string") return false;
  if (!["read-only-analysis", "interactive-local", "guarded-durable", "background-job", "webhook-automation"].includes(value.profile)) return false;
  return value.sandbox === undefined || value.sandbox === "read-only" || value.sandbox === "workspace-write" || value.sandbox === "danger-full-access";
}
function isRunList(value: unknown): value is DesktopHarnessRunListInput {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "limit")) return false;
  return value.limit === undefined || isLimit(value.limit, 100);
}
function isRunId(value: unknown): value is DesktopHarnessRunIdInput {
  return isRecord(value) && Object.keys(value).every((key) => key === "runId") && boundedId(value.runId);
}
function isEvents(value: unknown): value is DesktopHarnessEventsInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !["runId", "afterSeq", "limit"].includes(key))) return false;
  if (!boundedId(value.runId)) return false;
  if (value.afterSeq !== undefined && (!Number.isSafeInteger(value.afterSeq) || Number(value.afterSeq) < -1)) return false;
  return value.limit === undefined || isLimit(value.limit, 200);
}
function isJobList(value: unknown): value is DesktopHarnessJobListInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !["runId", "limit"].includes(key))) return false;
  return boundedId(value.runId) && (value.limit === undefined || isLimit(value.limit, 100));
}
function isJobCancel(value: unknown): value is DesktopHarnessJobCancelInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !["runId", "jobId"].includes(key))) return false;
  return boundedId(value.runId) && boundedId(value.jobId);
}
function isLimit(value: unknown, max: number): boolean { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max; }
function boundedId(value: unknown): value is string { return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
