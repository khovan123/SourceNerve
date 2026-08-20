import type { DesktopResult, GitProvider } from "./desktop-api";

export const PROVIDER_WORKFLOW_IPC = {
  state: "desktop:provider-workflow-state",
  issueCreate: "desktop:provider-workflow-issue-create",
  pullCreate: "desktop:provider-workflow-pull-create",
  pullRefresh: "desktop:provider-workflow-pull-refresh",
  pullMerge: "desktop:provider-workflow-pull-merge",
  defaultSync: "desktop:provider-workflow-default-sync",
} as const;

export type ProviderChangeState = "open" | "closed" | "merged";
export type ProviderMergeMethod = "merge" | "squash" | "rebase";

export interface ProviderIssueView {
  provider: GitProvider;
  repository: string;
  number: number;
  title: string;
  state: "open" | "closed";
  url?: string;
}

export interface ProviderPullView {
  provider: GitProvider;
  repository: string;
  number: number;
  title: string;
  state: ProviderChangeState;
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  mergeable?: boolean;
  mergeState?: string;
  url?: string;
}

export interface ProviderWorkflowState {
  taskId: string;
  workspace: string;
  provider: GitProvider;
  repository: string;
  defaultBranch: string;
  lifecyclePhase: string;
  taskPushSha?: string;
  taskBranch?: string;
  issueNumber?: number;
  pullNumber?: number;
  pullHeadSha?: string;
  mergeSha?: string;
  defaultSyncedHead?: string;
  pull?: ProviderPullView;
}

export interface ProviderIssueCreateInput {
  taskId: string;
  title: string;
  body: string;
}

export interface ProviderIssueCreateResult {
  issue: ProviderIssueView;
  replayed: boolean;
}

export interface ProviderPullCreateInput {
  taskId: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface ProviderPullCreateResult {
  pull: ProviderPullView;
  replayed: boolean;
}

export interface ProviderPullRefreshInput {
  taskId: string;
}

export interface ProviderPullMergeInput {
  taskId: string;
  expectedHeadSha: string;
  method: ProviderMergeMethod;
}

export interface ProviderPullMergeResult {
  pull: ProviderPullView;
  mergeSha: string;
  replayed: boolean;
}

export interface ProviderDefaultSyncResult {
  taskId: string;
  workspace: string;
  defaultBranch: string;
  head: string;
  replayed: boolean;
}

declare module "./desktop-api" {
  interface SourceNerveDesktopApi {
    getProviderWorkflowState(taskId: string): Promise<DesktopResult<ProviderWorkflowState>>;
    createProviderIssue(input: ProviderIssueCreateInput): Promise<DesktopResult<ProviderIssueCreateResult>>;
    createProviderPull(input: ProviderPullCreateInput): Promise<DesktopResult<ProviderPullCreateResult>>;
    refreshProviderPull(input: ProviderPullRefreshInput): Promise<DesktopResult<ProviderPullView>>;
    mergeProviderPull(input: ProviderPullMergeInput): Promise<DesktopResult<ProviderPullMergeResult>>;
    syncProviderDefaultBranch(taskId: string): Promise<DesktopResult<ProviderDefaultSyncResult>>;
  }
}
