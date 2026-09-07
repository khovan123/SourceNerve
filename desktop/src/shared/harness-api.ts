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
  commandExecute: "desktop:harness-command-execute",
  codexSetupStatus: "desktop:harness-codex-setup-status",
  codexInstall: "desktop:harness-codex-install",
  codexLogin: "desktop:harness-codex-login",
  codexAccount: "desktop:harness-codex-account",
  codexStatus: "desktop:harness-codex-status",
  codexUsage: "desktop:harness-codex-usage",
  codexConversation: "desktop:harness-codex-conversation",
  codexConversationList: "desktop:harness-codex-conversations-list",
  codexConversationClear: "desktop:harness-codex-conversations-clear",
  codexConversationResume: "desktop:harness-codex-conversation-resume",
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
export interface DesktopHarnessCommandInput {
  workspace: string;
  command: string;
  requestId: string;
  timeoutMs?: number;
}

export interface DesktopHarnessCommandView {
  workspace: string;
  command: string;
  requestId: string;
  status: "completed";
  sandbox?: HarnessSandboxMode;
  sandboxEnforcement?: "full" | "partial" | "unavailable";
  success?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
}

export interface DesktopHarnessCodexAccountInput { workspace: string; }
export interface DesktopHarnessCodexStatusInput { workspace: string; }
export interface DesktopHarnessCodexUsageInput { workspace: string; runId?: string; }
export interface DesktopHarnessCodexConversationInput { runId: string; }
export interface DesktopHarnessCodexConversationListInput { workspace: string; }
export interface DesktopHarnessCodexConversationClearInput { workspace: string; }
export interface DesktopHarnessCodexConversationResumeInput { workspace: string; threadId: string; }
export interface DesktopHarnessCodexTurnInput { runId: string; prompt: string; }

export interface DesktopHarnessCodexSetupView {
  installed: boolean;
  version?: string;
  authenticated: boolean;
  accountType: "chatgpt" | "apiKey" | null;
  canInstall: boolean;
}

export interface DesktopHarnessCodexAccountView {
  authenticated: boolean;
  accountType: "apiKey" | "chatgpt" | "amazonBedrock" | null;
  planType?: string;
  requiresOpenaiAuth: boolean;
}

export interface DesktopHarnessCodexRateLimitWindowView {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface DesktopHarnessCodexRateLimitView {
  limitId?: string;
  limitName?: string;
  planType?: string;
  primary?: DesktopHarnessCodexRateLimitWindowView;
  secondary?: DesktopHarnessCodexRateLimitWindowView;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
}

export interface DesktopHarnessCodexStatusView extends DesktopHarnessCodexAccountView {
  rateLimits: DesktopHarnessCodexRateLimitView[];
  resetCreditsAvailable?: number;
}

export interface DesktopHarnessCodexUsageView {
  summary: {
    lifetimeTokens?: number;
    peakDailyTokens?: number;
    currentStreakDays?: number;
    longestStreakDays?: number;
    longestRunningTurnSec?: number;
  };
  thread?: {
    threadId: string;
    estimatedUsageCreditsMicros: number;
    estimatedUsageUsdMicros?: number;
    groups: Array<{
      model?: string;
      reasoningEffort?: string;
      speed?: string;
      totalTokens?: number;
      inputTokens?: number;
      cachedInputTokens?: number;
      netNewInputTokens?: number;
      outputTokens?: number;
      estimatedUsageCreditsMicros: number;
    }>;
  };
}

export interface DesktopHarnessCodexConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  turnId?: string;
}

export interface DesktopHarnessCodexConversationView {
  runId: string;
  workspace: string;
  threadId?: string;
  messages: DesktopHarnessCodexConversationMessage[];
}

export interface DesktopHarnessCodexConversationSummary {
  threadId: string;
  runId?: string;
  workspace: string;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  status: string;
}

export interface DesktopHarnessCodexConversationClearResult {
  workspace: string;
  deleted: number;
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
  startCycle?: boolean;
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
    runHarnessCommand(input: DesktopHarnessCommandInput): Promise<DesktopResult<DesktopHarnessCommandView>>;
    getHarnessCodexSetup(): Promise<DesktopResult<DesktopHarnessCodexSetupView>>;
    installHarnessCodex(): Promise<DesktopResult<DesktopHarnessCodexSetupView>>;
    loginHarnessCodex(): Promise<DesktopResult<DesktopHarnessCodexSetupView>>;
    getHarnessCodexAccount(input: DesktopHarnessCodexAccountInput): Promise<DesktopResult<DesktopHarnessCodexAccountView>>;
    getHarnessCodexStatus(input: DesktopHarnessCodexStatusInput): Promise<DesktopResult<DesktopHarnessCodexStatusView>>;
    getHarnessCodexUsage(input: DesktopHarnessCodexUsageInput): Promise<DesktopResult<DesktopHarnessCodexUsageView>>;
    getHarnessCodexConversation(input: DesktopHarnessCodexConversationInput): Promise<DesktopResult<DesktopHarnessCodexConversationView>>;
    listHarnessCodexConversations(input: DesktopHarnessCodexConversationListInput): Promise<DesktopResult<DesktopHarnessCodexConversationSummary[]>>;
    clearHarnessCodexConversations(input: DesktopHarnessCodexConversationClearInput): Promise<DesktopResult<DesktopHarnessCodexConversationClearResult>>;
    resumeHarnessCodexConversation(input: DesktopHarnessCodexConversationResumeInput): Promise<DesktopResult<DesktopHarnessCodexConversationView>>;
    runHarnessCodexTurn(input: DesktopHarnessCodexTurnInput): Promise<DesktopResult<DesktopHarnessCodexTurnView>>;
  }
}
