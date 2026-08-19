import type {
  DesktopTaskApplyInput,
  DesktopTaskBeginInput,
  DesktopTaskBranchInput,
  DesktopTaskCommitInput,
  DesktopTaskFileExpectation,
  DesktopTaskProposeInput,
} from "../shared/task-api";
import { TASK_IPC } from "../shared/task-api";
import { isUuid, isWorkspaceId } from "./task-registry";

const MAX_CONTEXT_QUERY_BYTES = 4_096;
const MAX_PATCH_BYTES = 1_000_000;
const MAX_COMMIT_MESSAGE_BYTES = 16 * 1024;
const MAX_EXPECTATIONS = 128;
const MAX_REPOSITORY_PATH = 1_024;
const MAX_BRANCH = 240;

const NO_ARGUMENT_CHANNELS = new Set<string>([TASK_IPC.list]);
export const TASK_INBOUND_IPC_CHANNELS = Object.freeze(Object.values(TASK_IPC));

export function validateTaskIpcInvocation(channel: string, args: readonly unknown[]): string | null {
  if (NO_ARGUMENT_CHANNELS.has(channel)) return args.length === 0 ? null : "task operation does not accept arguments";
  if (channel === TASK_IPC.begin) return args.length === 1 && isBeginInput(args[0]) ? null : "task begin input is invalid";
  if (channel === TASK_IPC.remember || channel === TASK_IPC.get || channel === TASK_IPC.cancel || channel === TASK_IPC.review || channel === TASK_IPC.push) {
    return args.length === 1 && isUuid(args[0]) ? null : "task ID must be a SourceNerve task UUID";
  }
  if (channel === TASK_IPC.branch) return args.length === 1 && isBranchInput(args[0]) ? null : "task branch input is invalid";
  if (channel === TASK_IPC.propose) return args.length === 1 && isProposeInput(args[0]) ? null : "task proposal input is invalid";
  if (channel === TASK_IPC.apply) return args.length === 1 && isApplyInput(args[0]) ? null : "task apply input is invalid";
  if (channel === TASK_IPC.commit) return args.length === 1 && isCommitInput(args[0]) ? null : "task commit input is invalid";
  return "task IPC channel is not allowlisted";
}

export function isBeginInput(value: unknown): value is DesktopTaskBeginInput {
  if (!isRecord(value) || !exactKeys(value, ["workspace", "contextQuery", "contextMaxBytes", "contextMaxItems"])) return false;
  if (!isWorkspaceId(value.workspace)) return false;
  if (value.contextQuery !== undefined && !boundedUtf8(value.contextQuery, 1, MAX_CONTEXT_QUERY_BYTES)) return false;
  if (!Number.isSafeInteger(value.contextMaxBytes) || Number(value.contextMaxBytes) < 256 || Number(value.contextMaxBytes) > 128 * 1024) return false;
  return Number.isSafeInteger(value.contextMaxItems) && Number(value.contextMaxItems) >= 1 && Number(value.contextMaxItems) <= 50;
}

export function isBranchInput(value: unknown): value is DesktopTaskBranchInput {
  if (!isRecord(value) || !exactKeys(value, ["taskId", "branch"])) return false;
  return isUuid(value.taskId) && isSafeBranch(value.branch);
}

export function isProposeInput(value: unknown): value is DesktopTaskProposeInput {
  if (!isRecord(value) || !exactKeys(value, ["taskId", "expectedFiles", "patch"])) return false;
  if (!isUuid(value.taskId) || typeof value.patch !== "string") return false;
  const patchBytes = Buffer.byteLength(value.patch, "utf8");
  if (patchBytes < 1 || patchBytes > MAX_PATCH_BYTES || value.patch.includes("\u0000")) return false;
  if (!Array.isArray(value.expectedFiles) || value.expectedFiles.length < 1 || value.expectedFiles.length > MAX_EXPECTATIONS) return false;
  const paths = new Set<string>();
  for (const item of value.expectedFiles) {
    if (!isExpectation(item) || paths.has(item.path)) return false;
    paths.add(item.path);
  }
  return true;
}

export function isApplyInput(value: unknown): value is DesktopTaskApplyInput {
  if (!isRecord(value) || !exactKeys(value, ["taskId", "proposalId"])) return false;
  return isUuid(value.taskId) && isUuid(value.proposalId);
}

export function isCommitInput(value: unknown): value is DesktopTaskCommitInput {
  if (!isRecord(value) || !exactKeys(value, ["taskId", "message"])) return false;
  return isUuid(value.taskId) && boundedUtf8(value.message, 1, MAX_COMMIT_MESSAGE_BYTES);
}

export function isExpectation(value: unknown): value is DesktopTaskFileExpectation {
  if (!isRecord(value) || !exactKeys(value, ["path", "sha256"])) return false;
  return isRelativeRepositoryPath(value.path) && (value.sha256 === undefined || isSha256(value.sha256));
}

export function isSafeBranch(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_BRANCH || value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("\\") || /[\u0000-\u0020~^:?*\[]/.test(value)) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !part.endsWith(".lock"));
}

export function isRelativeRepositoryPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_REPOSITORY_PATH || value.startsWith("/") || value.startsWith("\\")) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized)) return false;
  return normalized.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function boundedUtf8(value: unknown, minBytes: number, maxBytes: number): value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) return false;
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes >= minBytes && bytes <= maxBytes;
}

function exactKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
