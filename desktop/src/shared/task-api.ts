import type { DesktopResult } from "./desktop-api";

export const TASK_IPC = {
  list: "desktop:tasks-list",
  begin: "desktop:tasks-begin",
  remember: "desktop:tasks-remember",
  get: "desktop:tasks-get",
  cancel: "desktop:tasks-cancel",
  branch: "desktop:tasks-branch",
  propose: "desktop:tasks-propose",
  apply: "desktop:tasks-apply",
  review: "desktop:tasks-review",
  commit: "desktop:tasks-commit",
  push: "desktop:tasks-push",
  readFile: "desktop:tasks-file-read",
} as const;

export type DesktopTaskStatus = "active" | "stale" | "applied" | "cancelled";
export type DesktopTaskPhase = "snapshot" | "branched" | "patched" | "reviewed" | "committed" | "pushed" | "pr_open" | "merged" | "completed";
export type DesktopTaskProposalStatus = "proposed" | "applied" | "rejected";

export interface DesktopTaskReference {
  taskId: string;
  workspace: string;
  createdAt: string;
}

export interface DesktopTaskView {
  id: string;
  workspace: string;
  baseHead: string;
  status: DesktopTaskStatus;
  contextQuery?: string;
  staleReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DesktopTaskProposalView {
  id: string;
  taskId: string;
  expectedHead: string;
  patchSha256: string;
  changedPaths: string[];
  status: DesktopTaskProposalStatus;
  changesetId?: string;
  createdAt: number;
  appliedAt?: number;
}

export interface DesktopTaskEventView {
  id: number;
  eventType: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface DesktopTaskLifecycleView {
  taskId: string;
  phase: DesktopTaskPhase;
  branch?: string;
  reviewedDiffSha256?: string;
  commitSha?: string;
  pushSha?: string;
  issueNumber?: number;
  pullNumber?: number;
  pullHeadSha?: string;
  mergeSha?: string;
  defaultSyncedHead?: string;
  updatedAt: number;
  provider?: string;
}

export interface DesktopTaskSnapshot {
  task: DesktopTaskView;
  proposals: DesktopTaskProposalView[];
  events: DesktopTaskEventView[];
  lifecycle: DesktopTaskLifecycleView;
}

export interface DesktopTaskListItem extends DesktopTaskReference {
  snapshot?: DesktopTaskSnapshot;
  unavailableReason?: string;
}

export interface DesktopTaskBeginInput {
  workspace: string;
  contextQuery?: string;
}

export interface DesktopTaskBeginResult {
  snapshot: DesktopTaskSnapshot;
  replayed: boolean;
}

export interface DesktopTaskBranchInput {
  taskId: string;
  branch: string;
}

export interface DesktopTaskBranchResult {
  lifecycle: DesktopTaskLifecycleView;
  replayed: boolean;
}

export interface DesktopTaskFileExpectation {
  path: string;
  sha256?: string;
}

export interface DesktopTaskFileReadInput {
  taskId: string;
  path: string;
}

export interface DesktopTaskFileReadResult {
  path: string;
  sha256: string;
}

export interface DesktopTaskProposeInput {
  taskId: string;
  expectedFiles: DesktopTaskFileExpectation[];
  patch: string;
}

export interface DesktopTaskProposalResult {
  proposal: DesktopTaskProposalView;
  replayed: boolean;
}

export interface DesktopTaskApplyInput {
  taskId: string;
  proposalId: string;
}

export interface DesktopTaskApplyResult {
  taskId: string;
  proposalId: string;
  changesetId: string;
  head: string;
  changedPaths: string[];
  diff: string;
}

export interface DesktopTaskGitReview {
  workspace: string;
  branch: string;
  head: string;
  dirty: boolean;
  status: string;
  diff: string;
  diffSha256: string;
}

export interface DesktopTaskReviewResult {
  lifecycle: DesktopTaskLifecycleView;
  review: DesktopTaskGitReview;
  replayed: boolean;
}

export interface DesktopTaskCommitInput {
  taskId: string;
  message: string;
}

export interface DesktopTaskCommitView {
  workspace: string;
  branch: string;
  parentHead: string;
  commit: string;
  clean: boolean;
  status: string;
}

export interface DesktopTaskCommitResult {
  lifecycle: DesktopTaskLifecycleView;
  commit: DesktopTaskCommitView;
  replayed: boolean;
}

export interface DesktopTaskPushView {
  workspace: string;
  remote: string;
  branch: string;
  head: string;
}

export interface DesktopTaskPushResult {
  lifecycle: DesktopTaskLifecycleView;
  push: DesktopTaskPushView;
  replayed: boolean;
}

declare module "./desktop-api" {
  interface SourceNerveDesktopApi {
    listDesktopTasks(): Promise<DesktopResult<DesktopTaskListItem[]>>;
    beginDesktopTask(input: DesktopTaskBeginInput): Promise<DesktopResult<DesktopTaskBeginResult>>;
    rememberDesktopTask(taskId: string): Promise<DesktopResult<DesktopTaskSnapshot>>;
    getDesktopTask(taskId: string): Promise<DesktopResult<DesktopTaskSnapshot>>;
    cancelDesktopTask(taskId: string): Promise<DesktopResult<DesktopTaskSnapshot>>;
    checkoutDesktopTaskBranch(input: DesktopTaskBranchInput): Promise<DesktopResult<DesktopTaskBranchResult>>;
    proposeDesktopTaskPatch(input: DesktopTaskProposeInput): Promise<DesktopResult<DesktopTaskProposalResult>>;
    applyDesktopTaskProposal(input: DesktopTaskApplyInput): Promise<DesktopResult<DesktopTaskApplyResult>>;
    reviewDesktopTask(taskId: string): Promise<DesktopResult<DesktopTaskReviewResult>>;
    commitDesktopTask(input: DesktopTaskCommitInput): Promise<DesktopResult<DesktopTaskCommitResult>>;
    pushDesktopTask(taskId: string): Promise<DesktopResult<DesktopTaskPushResult>>;
    readDesktopTaskFile(input: DesktopTaskFileReadInput): Promise<DesktopResult<DesktopTaskFileReadResult>>;
  }
}
