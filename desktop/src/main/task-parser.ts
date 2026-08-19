import type {
  DesktopTaskApplyResult,
  DesktopTaskBranchResult,
  DesktopTaskCommitResult,
  DesktopTaskCommitView,
  DesktopTaskEventView,
  DesktopTaskGitReview,
  DesktopTaskLifecycleView,
  DesktopTaskPhase,
  DesktopTaskProposalResult,
  DesktopTaskProposalStatus,
  DesktopTaskProposalView,
  DesktopTaskPushResult,
  DesktopTaskPushView,
  DesktopTaskReviewResult,
  DesktopTaskSnapshot,
  DesktopTaskStatus,
  DesktopTaskView,
} from "../shared/task-api";
import { parseContextPack } from "./intelligence-ipc";
import type { IntelligenceContextPack } from "../shared/intelligence-api";
import { isRelativeRepositoryPath } from "./task-policy";
import { isUuid, isWorkspaceId } from "./task-registry";

const TASK_STATUSES = new Set<DesktopTaskStatus>(["active", "stale", "applied", "cancelled"]);
const TASK_PHASES = new Set<DesktopTaskPhase>(["snapshot", "branched", "patched", "reviewed", "committed", "pushed", "pr_open", "merged", "completed"]);
const PROPOSAL_STATUSES = new Set<DesktopTaskProposalStatus>(["proposed", "applied", "rejected"]);
const DROP_EVENT_KEYS = new Set(["patch", "body", "token", "secret", "credential", "authorization"]);

export interface ParsedTaskBegin {
  task: DesktopTaskView;
  context?: IntelligenceContextPack;
  replayed: boolean;
}

export function parseTaskBegin(value: unknown): ParsedTaskBegin {
  const item = requireRecord(value, "task begin");
  if (typeof item.replayed !== "boolean") throw invalid("task begin replay flag is invalid");
  return {
    task: parseTaskView(item.task),
    ...(item.context === null || item.context === undefined ? {} : { context: parseContextPack(item.context) }),
    replayed: item.replayed,
  };
}

export function parseTaskSnapshot(value: unknown): DesktopTaskSnapshot {
  const item = requireRecord(value, "task snapshot");
  return {
    task: parseTaskView(item.task),
    proposals: requireArray(item.proposals, 128, "task proposals").map(parseProposal),
    events: requireArray(item.events, 512, "task events").map(parseEvent),
    lifecycle: parseLifecycle(item.lifecycle),
  };
}

export function parseTaskView(value: unknown): DesktopTaskView {
  const item = requireRecord(value, "task");
  const status = requireText(item.status, 32, "task status") as DesktopTaskStatus;
  if (!TASK_STATUSES.has(status)) throw invalid("task status is unknown");
  return {
    id: requireUuid(item.id, "task id"),
    workspace: requireWorkspace(item.workspace, "task workspace"),
    baseHead: requireCommitSha(item.base_head, "task base head"),
    graphVersion: requireNonNegativeInteger(item.graph_version, "task graph version"),
    status,
    ...(item.context_query === null || item.context_query === undefined ? {} : { contextQuery: requireText(item.context_query, 16 * 1024, "task context query") }),
    ...(item.context_sha256 === null || item.context_sha256 === undefined ? {} : { contextSha256: requireSha256(item.context_sha256, "task context hash") }),
    ...(item.stale_reason === null || item.stale_reason === undefined ? {} : { staleReason: requireText(item.stale_reason, 512, "task stale reason") }),
    createdAt: requireNonNegativeInteger(item.created_at, "task created_at"),
    updatedAt: requireNonNegativeInteger(item.updated_at, "task updated_at"),
  };
}

export function parseTaskProposalResult(value: unknown): DesktopTaskProposalResult {
  const item = requireRecord(value, "task proposal result");
  if (typeof item.replayed !== "boolean") throw invalid("task proposal replay flag is invalid");
  return { proposal: parseProposal(item.proposal), replayed: item.replayed };
}

export function parseTaskApplyResult(value: unknown): DesktopTaskApplyResult {
  const item = requireRecord(value, "task apply result");
  return {
    taskId: requireUuid(item.task_id, "apply task id"),
    proposalId: requireUuid(item.proposal_id, "apply proposal id"),
    changesetId: requireUuid(item.changeset_id, "changeset id"),
    head: requireCommitSha(item.head, "apply head"),
    changedPaths: requireArray(item.changed_paths, 128, "changed paths").map(requirePath),
    diff: requireTextAllowEmpty(item.diff, 2_000_000, "applied diff"),
  };
}

export function parseTaskBranchResult(value: unknown): DesktopTaskBranchResult {
  const item = requireRecord(value, "task branch result");
  if (typeof item.replayed !== "boolean") throw invalid("task branch replay flag is invalid");
  return { lifecycle: parseLifecycle(item.lifecycle), replayed: item.replayed };
}

export function parseTaskReviewResult(value: unknown): DesktopTaskReviewResult {
  const item = requireRecord(value, "task review result");
  if (typeof item.replayed !== "boolean") throw invalid("task review replay flag is invalid");
  return { lifecycle: parseLifecycle(item.lifecycle), review: parseGitReview(item.review), replayed: item.replayed };
}

export function parseTaskCommitResult(value: unknown): DesktopTaskCommitResult {
  const item = requireRecord(value, "task commit result");
  if (typeof item.replayed !== "boolean") throw invalid("task commit replay flag is invalid");
  return { lifecycle: parseLifecycle(item.lifecycle), commit: parseCommit(item.commit), replayed: item.replayed };
}

export function parseTaskPushResult(value: unknown): DesktopTaskPushResult {
  const item = requireRecord(value, "task push result");
  if (typeof item.replayed !== "boolean") throw invalid("task push replay flag is invalid");
  return { lifecycle: parseLifecycle(item.lifecycle), push: parsePush(item.push), replayed: item.replayed };
}

function parseProposal(value: unknown): DesktopTaskProposalView {
  const item = requireRecord(value, "task proposal");
  const status = requireText(item.status, 32, "proposal status") as DesktopTaskProposalStatus;
  if (!PROPOSAL_STATUSES.has(status)) throw invalid("task proposal status is unknown");
  return {
    id: requireUuid(item.id, "proposal id"),
    taskId: requireUuid(item.task_id, "proposal task id"),
    expectedHead: requireCommitSha(item.expected_head, "proposal expected head"),
    patchSha256: requireSha256(item.patch_sha256, "proposal patch hash"),
    changedPaths: requireArray(item.changed_paths, 128, "proposal changed paths").map(requirePath),
    status,
    ...(item.changeset_id === null || item.changeset_id === undefined ? {} : { changesetId: requireUuid(item.changeset_id, "proposal changeset id") }),
    createdAt: requireNonNegativeInteger(item.created_at, "proposal created_at"),
    ...(item.applied_at === null || item.applied_at === undefined ? {} : { appliedAt: requireNonNegativeInteger(item.applied_at, "proposal applied_at") }),
  };
}

function parseLifecycle(value: unknown): DesktopTaskLifecycleView {
  const item = requireRecord(value, "task lifecycle");
  const phase = requireText(item.phase, 32, "task lifecycle phase") as DesktopTaskPhase;
  if (!TASK_PHASES.has(phase)) throw invalid("task lifecycle phase is unknown");
  return {
    taskId: requireUuid(item.task_id, "lifecycle task id"),
    phase,
    ...(item.branch === null || item.branch === undefined ? {} : { branch: requireText(item.branch, 240, "task branch") }),
    ...(item.reviewed_diff_sha256 === null || item.reviewed_diff_sha256 === undefined ? {} : { reviewedDiffSha256: requireSha256(item.reviewed_diff_sha256, "reviewed diff hash") }),
    ...(item.commit_sha === null || item.commit_sha === undefined ? {} : { commitSha: requireCommitSha(item.commit_sha, "task commit sha") }),
    ...(item.push_sha === null || item.push_sha === undefined ? {} : { pushSha: requireCommitSha(item.push_sha, "task push sha") }),
    ...(item.issue_number === null || item.issue_number === undefined ? {} : { issueNumber: requirePositiveInteger(item.issue_number, "issue number") }),
    ...(item.pull_number === null || item.pull_number === undefined ? {} : { pullNumber: requirePositiveInteger(item.pull_number, "pull number") }),
    ...(item.pull_head_sha === null || item.pull_head_sha === undefined ? {} : { pullHeadSha: requireCommitSha(item.pull_head_sha, "pull head sha") }),
    ...(item.merge_sha === null || item.merge_sha === undefined ? {} : { mergeSha: requireCommitSha(item.merge_sha, "merge sha") }),
    ...(item.default_synced_head === null || item.default_synced_head === undefined ? {} : { defaultSyncedHead: requireCommitSha(item.default_synced_head, "default synced head") }),
    updatedAt: requireNonNegativeInteger(item.updated_at, "lifecycle updated_at"),
    ...(item.provider === null || item.provider === undefined ? {} : { provider: requireText(item.provider, 64, "task provider") }),
  };
}

function parseEvent(value: unknown): DesktopTaskEventView {
  const item = requireRecord(value, "task event");
  return {
    id: requireNonNegativeInteger(item.id, "task event id"),
    eventType: requireText(item.event_type, 128, "task event type"),
    metadata: sanitizeMetadata(item.metadata),
    createdAt: requireNonNegativeInteger(item.created_at, "task event created_at"),
  };
}

function parseGitReview(value: unknown): DesktopTaskGitReview {
  const item = requireRecord(value, "git review");
  if (typeof item.dirty !== "boolean") throw invalid("git review dirty flag is invalid");
  return {
    workspace: requireWorkspace(item.workspace, "review workspace"),
    branch: requireText(item.branch, 240, "review branch"),
    head: requireCommitSha(item.head, "review head"),
    dirty: item.dirty,
    status: requireTextAllowEmpty(item.status, 512 * 1024, "review status"),
    diff: requireTextAllowEmpty(item.diff, 2_000_000, "review diff"),
    diffSha256: requireSha256(item.diff_sha256, "review diff hash"),
  };
}

function parseCommit(value: unknown): DesktopTaskCommitView {
  const item = requireRecord(value, "task commit");
  if (typeof item.clean !== "boolean") throw invalid("commit clean flag is invalid");
  return {
    workspace: requireWorkspace(item.workspace, "commit workspace"),
    branch: requireText(item.branch, 240, "commit branch"),
    parentHead: requireCommitSha(item.parent_head, "commit parent head"),
    commit: requireCommitSha(item.commit, "commit sha"),
    clean: item.clean,
    status: requireTextAllowEmpty(item.status, 512 * 1024, "commit status"),
  };
}

function parsePush(value: unknown): DesktopTaskPushView {
  const item = requireRecord(value, "task push");
  return {
    workspace: requireWorkspace(item.workspace, "push workspace"),
    remote: requireText(item.remote, 128, "push remote"),
    branch: requireText(item.branch, 240, "push branch"),
    head: requireCommitSha(item.head, "push head"),
  };
}

function sanitizeMetadata(value: unknown, depth = 0): Record<string, unknown> {
  if (!isRecord(value) || depth > 3) return {};
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, 64);
  for (const [key, raw] of entries) {
    if (DROP_EVENT_KEYS.has(key.toLowerCase()) || key.length > 128) continue;
    const safe = safeMetadataValue(raw, depth + 1);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

function safeMetadataValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return value.length <= 4_096 ? value : `${value.slice(0, 4_096)}…`;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value) && value.length <= 64) return value.map((item) => safeMetadataValue(item, depth)).filter((item) => item !== undefined);
  if (isRecord(value) && depth <= 3) return sanitizeMetadata(value, depth);
  return undefined;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`${label} is not an object`);
  return value;
}
function requireArray(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalid(`${label} is invalid`);
  return value;
}
function requireText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > max || value.includes("\u0000")) throw invalid(`${label} is invalid`);
  return value;
}
function requireTextAllowEmpty(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > max || value.includes("\u0000")) throw invalid(`${label} is invalid`);
  return value;
}
function requireUuid(value: unknown, label: string): string {
  if (!isUuid(value)) throw invalid(`${label} is invalid`);
  return value;
}
function requireWorkspace(value: unknown, label: string): string {
  if (!isWorkspaceId(value)) throw invalid(`${label} is invalid`);
  return value;
}
function requireCommitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) throw invalid(`${label} is invalid`);
  return value;
}
function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) throw invalid(`${label} is invalid`);
  return value;
}
function requirePath(value: unknown): string {
  if (!isRelativeRepositoryPath(value)) throw invalid("repository path is unsafe");
  return value.replaceAll("\\", "/");
}
function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid(`${label} is invalid`);
  return value;
}
function requirePositiveInteger(value: unknown, label: string): number {
  const number = requireNonNegativeInteger(value, label);
  if (number < 1) throw invalid(`${label} is invalid`);
  return number;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(message: string): Error {
  return new Error(`SourceNerve task response invalid: ${message}`);
}
