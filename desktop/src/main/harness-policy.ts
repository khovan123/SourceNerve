import {
  HARNESS_IPC,
  type DesktopHarnessCodexAccountInput,
  type DesktopHarnessCodexTurnInput,
  type DesktopHarnessContextRouteInput,
  type DesktopHarnessEventsInput,
  type DesktopHarnessRunBeginInput,
  type DesktopHarnessJobCancelInput,
  type DesktopHarnessJobListInput,
  type DesktopHarnessRunIdInput,
  type DesktopHarnessRunListInput,
} from "../shared/harness-api";

export const HARNESS_INBOUND_IPC_CHANNELS = Object.freeze(Object.values(HARNESS_IPC));

export function validateHarnessIpcInvocation(channel: string, args: readonly unknown[]): string | null {
  if (channel === HARNESS_IPC.contextRoute) return args.length === 1 && isContextRoute(args[0]) ? null : "Harness context route input is invalid";
  if (channel === HARNESS_IPC.beginRun) return args.length === 1 && isRunBegin(args[0]) ? null : "Harness run begin input is invalid";
  if (channel === HARNESS_IPC.listRuns) return args.length <= 1 && (args.length === 0 || isRunList(args[0])) ? null : "Harness run list input is invalid";
  if (channel === HARNESS_IPC.getRun || channel === HARNESS_IPC.cancelRun) return args.length === 1 && isRunId(args[0]) ? null : "Harness run input is invalid";
  if (channel === HARNESS_IPC.listEvents) return args.length === 1 && isEvents(args[0]) ? null : "Harness event input is invalid";
  if (channel === HARNESS_IPC.listJobs) return args.length === 1 && isJobList(args[0]) ? null : "Harness job list input is invalid";
  if (channel === HARNESS_IPC.cancelJob) return args.length === 1 && isJobCancel(args[0]) ? null : "Harness job cancel input is invalid";
  if (channel === HARNESS_IPC.codexSetupStatus || channel === HARNESS_IPC.codexInstall || channel === HARNESS_IPC.codexLogin) return args.length === 0 ? null : "Harness Codex setup input is invalid";
  if (channel === HARNESS_IPC.codexAccount) return args.length === 1 && isCodexAccount(args[0]) ? null : "Harness Codex account input is invalid";
  if (channel === HARNESS_IPC.codexTurn) return args.length === 1 && isCodexTurn(args[0]) ? null : "Harness Codex turn input is invalid";
  return "Harness IPC channel is not allowlisted";
}

function isContextRoute(value: unknown): value is DesktopHarnessContextRouteInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !["workspace", "runId", "query"].includes(key))) return false;
  return boundedId(value.workspace) && (value.runId === undefined || boundedId(value.runId)) && boundedQuery(value.query);
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
function isCodexAccount(value: unknown): value is DesktopHarnessCodexAccountInput {
  return isRecord(value) && Object.keys(value).every((key) => key === "workspace") && boundedId(value.workspace);
}
function isCodexTurn(value: unknown): value is DesktopHarnessCodexTurnInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !["runId", "prompt", "skillKeys"].includes(key))) return false;
  if (!boundedId(value.runId) || !boundedPrompt(value.prompt)) return false;
  if (value.skillKeys === undefined) return true;
  return Array.isArray(value.skillKeys) && value.skillKeys.length <= 2 && value.skillKeys.every(isSkillKey);
}
function boundedPrompt(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 1 && Buffer.byteLength(value, "utf8") <= 128 * 1024 && !/\0/.test(value);
}
function isSkillKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,128}$/.test(value);
}
function isLimit(value: unknown, max: number): boolean { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max; }
function boundedQuery(value: unknown): value is string { return typeof value === "string" && value.trim().length >= 1 && value.length <= 16 * 1024 && !/[\u0000-\u001f\u007f]/.test(value); }
function boundedId(value: unknown): value is string { return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
