import type {
  ProviderIssueCreateInput,
  ProviderPullCreateInput,
  ProviderPullMergeInput,
  ProviderPullRefreshInput,
} from "../shared/provider-workflow-api";
import { PROVIDER_WORKFLOW_IPC } from "../shared/provider-workflow-api";
import { isUuid } from "./task-registry";

const MAX_TITLE_BYTES = 512;
const MAX_BODY_BYTES = 64 * 1024;
const MERGE_METHODS = new Set(["merge", "squash", "rebase"]);

export const PROVIDER_WORKFLOW_INBOUND_IPC_CHANNELS = Object.freeze(
  Object.values(PROVIDER_WORKFLOW_IPC),
);

export function validateProviderWorkflowIpcInvocation(
  channel: string,
  args: readonly unknown[],
): string | null {
  if (channel === PROVIDER_WORKFLOW_IPC.state || channel === PROVIDER_WORKFLOW_IPC.defaultSync) {
    return args.length === 1 && isUuid(args[0])
      ? null
      : "provider workflow requires a SourceNerve task UUID";
  }
  if (channel === PROVIDER_WORKFLOW_IPC.issueCreate) {
    return args.length === 1 && isIssueCreateInput(args[0])
      ? null
      : "provider issue input is invalid";
  }
  if (channel === PROVIDER_WORKFLOW_IPC.pullCreate) {
    return args.length === 1 && isPullCreateInput(args[0])
      ? null
      : "provider pull input is invalid";
  }
  if (channel === PROVIDER_WORKFLOW_IPC.pullRefresh) {
    return args.length === 1 && isPullRefreshInput(args[0])
      ? null
      : "provider pull refresh input is invalid";
  }
  if (channel === PROVIDER_WORKFLOW_IPC.pullMerge) {
    return args.length === 1 && isPullMergeInput(args[0])
      ? null
      : "provider pull merge input is invalid";
  }
  return "provider workflow IPC channel is not allowlisted";
}

export function isIssueCreateInput(value: unknown): value is ProviderIssueCreateInput {
  if (!isRecord(value) || !exactKeys(value, ["taskId", "title", "body"])) return false;
  return isUuid(value.taskId) && boundedText(value.title, 1, MAX_TITLE_BYTES) && boundedText(value.body, 0, MAX_BODY_BYTES, true);
}

export function isPullCreateInput(value: unknown): value is ProviderPullCreateInput {
  if (!isRecord(value) || !exactKeys(value, ["taskId", "title", "body", "draft"])) return false;
  return isUuid(value.taskId) && boundedText(value.title, 1, MAX_TITLE_BYTES) && boundedText(value.body, 0, MAX_BODY_BYTES, true) && typeof value.draft === "boolean";
}

export function isPullRefreshInput(value: unknown): value is ProviderPullRefreshInput {
  if (!isRecord(value) || !exactKeys(value, ["taskId"])) return false;
  return isUuid(value.taskId);
}

export function isPullMergeInput(value: unknown): value is ProviderPullMergeInput {
  if (!isRecord(value) || !exactKeys(value, ["taskId", "expectedHeadSha", "method"])) return false;
  return isUuid(value.taskId) && isCommitSha(value.expectedHeadSha) && typeof value.method === "string" && MERGE_METHODS.has(value.method);
}

function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function boundedText(value: unknown, minBytes: number, maxBytes: number, allowEmpty = false): value is string {
  if (typeof value !== "string" || value.includes("\u0000")) return false;
  const bytes = Buffer.byteLength(value, "utf8");
  if (allowEmpty && bytes === 0) return true;
  return value.trim().length > 0 && bytes >= minBytes && bytes <= maxBytes;
}

function exactKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
