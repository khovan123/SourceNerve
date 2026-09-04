import type { DesktopResult, GitProvider } from "./desktop-api";

export const PROVIDER_WORKFLOW_IPC = {
  pullList: "desktop:provider-workflow-pull-list",
  pullOpen: "desktop:provider-workflow-pull-open",
} as const;

export type ProviderChangeState = "open" | "closed" | "merged";
export type ProviderMergeMethod = "merge" | "squash" | "rebase";
export type ProviderPullListState = "open" | "closed" | "all";

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

export interface ProviderPullListItem {
  provider: GitProvider;
  repository: string;
  number: number;
  title: string;
  state: ProviderChangeState;
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  headSha?: string;
  author?: string;
  mergeable?: boolean;
  mergeState?: string;
  updatedAt?: string;
  url?: string;
  linkedTaskIds: string[];
}

export interface ProviderPullListInput {
  workspace: string;
  state: ProviderPullListState;
  limit?: number;
}

export interface ProviderPullOpenInput {
  url: string;
}

export interface ProviderPullOpenResult {
  opened: true;
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
    listProviderPulls(input: ProviderPullListInput): Promise<DesktopResult<ProviderPullListItem[]>>;
    openProviderPull(input: ProviderPullOpenInput): Promise<DesktopResult<ProviderPullOpenResult>>;
  }
}
