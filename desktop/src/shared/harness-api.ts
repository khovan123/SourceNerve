import type { DesktopResult } from "./desktop-api";

export const HARNESS_IPC = {
  contextRoute: "desktop:harness-context-route",
  beginRun: "desktop:harness-run-begin",
  listRuns: "desktop:harness-runs-list",
  getRun: "desktop:harness-run-get",
  listEvents: "desktop:harness-run-events",
  listJobs: "desktop:harness-jobs-list",
  cancelRun: "desktop:harness-run-cancel",
  cancelJob: "desktop:harness-job-cancel",
  codexAccount: "desktop:harness-codex-account",
  codexTurn: "desktop:harness-codex-turn",
} as const;

export type HarnessSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type HarnessPolicyDecision = "allow" | "ask" | "deny";
export type HarnessWorkShape = "read-only" | "bounded" | "durable" | "operate-application" | "invariant";
export type HarnessProofType = "focused-test" | "integration" | "e2e" | "recovery-rehearsal" | "measurement";
export type HarnessContextRoute = "none" | "exact-source" | "impact" | "architecture" | "symbol-graph" | "git-state" | "semantic" | "text-search" | "mixed";

export interface DesktopHarnessRunBeginInput {
  workspace: string;
  profile: string;
  sandbox?: HarnessSandboxMode;
}
export interface DesktopHarnessRunListInput { limit?: number; }
export interface DesktopHarnessRunIdInput { runId: string; }
export interface DesktopHarnessEventsInput { runId: string; afterSeq?: number; limit?: number; }
export interface DesktopHarnessJobListInput { runId: string; limit?: number; }
export interface DesktopHarnessJobCancelInput { runId: string; jobId: string; }

export interface DesktopHarnessCodexAccountInput { workspace: string; }
export interface DesktopHarnessCodexTurnInput { runId: string; prompt: string; skillKeys?: string[]; }

export interface DesktopHarnessCodexAccountView {
  authenticated: boolean;
  accountType: "apiKey" | "chatgpt" | "amazonBedrock" | null;
  planType?: string;
  requiresOpenaiAuth: boolean;
}

export interface DesktopHarnessCodexTurnView {
  runId: string;
  workspace: string;
  threadId: string;
  turnId: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  response?: string;
  resumed: boolean;
  recoveredBeforeTurn: boolean;
  activeSkills: string[];
}

export interface DesktopHarnessContextRouteInput {
  workspace: string;
  runId?: string;
  query: string;
}

export interface DesktopHarnessContextRouteView {
  workspace: string;
  retrieve: boolean;
  route: HarnessContextRoute;
  searchQuery: string;
  reason: string;
  surfaces: string[];
}

export interface DesktopHarnessCheckpointView {
  id: string;
  eventSeq: number;
  state: string;
  reason: string;
  createdAt: number;
}

export interface DesktopHarnessChildRunView {
  id: string;
  profile: string;
  status: string;
  parentRunId: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface DesktopHarnessLearningHint {
  tool: string;
  errorCategory: string;
  failures: number;
  recoveries: number;
  confirmations: number;
  state: "candidate" | "fresh-run-validated";
  suggestion: string;
}

export interface DesktopHarnessProofCandidate {
  proofType: HarnessProofType;
  source: string;
  cwd?: string;
  command: string;
  reason: string;
}

export interface DesktopHarnessRepositoryContext {
  entrypoints: string[];
  guidance: string[];
  activePlans: string[];
  validationOwners: string[];
  proofCandidates: DesktopHarnessProofCandidate[];
  truncated: boolean;
}

export interface DesktopHarnessClosedLoopView {
  phase: "context" | "execute" | "verify" | "recover" | "learn";
  workShape: HarnessWorkShape;
  workScope?: string;
  contextReads: number;
  executions: number;
  verificationRequired: boolean;
  verificationStatus: "idle" | "pending" | "passed" | "failed";
  recoveryStatus: "idle" | "needed" | "in-progress" | "recovered";
  selectedProofType?: HarnessProofType;
  selectedProofSource?: string;
  selectedProofCommand?: string;
  satisfiedProofs: HarnessProofType[];
  failureCount: number;
  learningCount: number;
  lastFailureTool?: string;
  lastFailureCategory?: string;
  learningHints: DesktopHarnessLearningHint[];
}

export interface DesktopHarnessRunView {
  id: string;
  actor: "operator" | "external-agent";
  workspace: string;
  profile: string;
  profileDescription: string;
  origin: "manual" | "automatic";
  sandbox: HarnessSandboxMode;
  policies: {
    read: HarnessPolicyDecision;
    write: HarnessPolicyDecision;
    exec: HarnessPolicyDecision;
    git: HarnessPolicyDecision;
    provider: HarnessPolicyDecision;
    job: HarnessPolicyDecision;
  };
  status: string;
  parentRunId?: string;
  children: DesktopHarnessChildRunView[];
  childrenTruncated: boolean;
  freshnessState: string;
  freshnessReason?: string;
  recoveryState: string;
  recoveryReason: string;
  closedLoop: DesktopHarnessClosedLoopView;
  repositoryContext: DesktopHarnessRepositoryContext;
  pendingApprovals: number;
  activeJobs: number;
  uncertainMutations: number;
  retryableReadExecutions: number;
  retryablePreDispatchExecutions: number;
  blockedPreDispatchExecutions: number;
  checkpoint?: DesktopHarnessCheckpointView;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface DesktopHarnessEventView {
  seq: number;
  eventType: string;
  summary: string;
  createdAt: number;
}

export interface DesktopHarnessJobView {
  id: string;
  runId: string;
  workspace: string;
  kind: string;
  taskId?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

declare module "./desktop-api" {
  interface SourceNerveDesktopApi {
    routeHarnessContext(input: DesktopHarnessContextRouteInput): Promise<DesktopResult<DesktopHarnessContextRouteView>>;
    beginHarnessRun(input: DesktopHarnessRunBeginInput): Promise<DesktopResult<DesktopHarnessRunView>>;
    listHarnessRuns(input?: DesktopHarnessRunListInput): Promise<DesktopResult<DesktopHarnessRunView[]>>;
    getHarnessRun(input: DesktopHarnessRunIdInput): Promise<DesktopResult<DesktopHarnessRunView>>;
    listHarnessEvents(input: DesktopHarnessEventsInput): Promise<DesktopResult<DesktopHarnessEventView[]>>;
    listHarnessJobs(input: DesktopHarnessJobListInput): Promise<DesktopResult<DesktopHarnessJobView[]>>;
    cancelHarnessRun(input: DesktopHarnessRunIdInput): Promise<DesktopResult<DesktopHarnessRunView>>;
    cancelHarnessJob(input: DesktopHarnessJobCancelInput): Promise<DesktopResult<DesktopHarnessJobView>>;
    getHarnessCodexAccount(input: DesktopHarnessCodexAccountInput): Promise<DesktopResult<DesktopHarnessCodexAccountView>>;
    runHarnessCodexTurn(input: DesktopHarnessCodexTurnInput): Promise<DesktopResult<DesktopHarnessCodexTurnView>>;
  }
}
