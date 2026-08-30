import type {
  DesktopHarnessCheckpointView,
  DesktopHarnessChildRunView,
  DesktopHarnessClosedLoopView,
  DesktopHarnessContextRouteView,
  DesktopHarnessRepositoryContext,
  DesktopHarnessEventView,
  DesktopHarnessJobView,
  DesktopHarnessRunView,
  HarnessPolicyDecision,
  HarnessSandboxMode,
} from "../shared/harness-api";

const SAFE_EVENT_KEYS = [
  "tool",
  "tool_name",
  "capability_id",
  "job_id",
  "approval_id",
  "parent_run_id",
  "kind",
  "state",
  "route",
  "retrieve",
  "query_bytes",
  "reason",
  "result_category",
  "error_category",
  "verification_tool",
  "verification",
  "recovered",
  "fresh_confirmations",
  "work_shape",
  "work_scope",
  "closed_loop_role",
  "proof_type",
  "proof_source",
  "proof_status",
  "selected_proof_type",
  "selected_proof_source",
  "sandbox",
  "enforcement",
] as const;

const CONTEXT_SURFACES = new Set([
  "read_file",
  "search_code",
  "impact_analysis",
  "references",
  "git_diff",
  "architecture_map",
  "context_pack",
  "symbol_search",
  "symbol_context",
  "repo_snapshot",
  "semantic_search_text",
]);

export function parseHarnessContextRoute(value: unknown): DesktopHarnessContextRouteView {
  if (!isRecord(value) || !Array.isArray(value.surfaces)) throw new Error("SourceNerve Harness context route response is invalid");
  return {
    workspace: boundedText(value.workspace, 128, "context route workspace"),
    retrieve: booleanValue(value.retrieve, "context route retrieve"),
    route: contextRoute(value.route),
    searchQuery: boundedText(value.search_query, 16 * 1024, "context route search query"),
    reason: boundedText(value.reason, 512, "context route reason"),
    surfaces: value.surfaces.map((surface) => contextSurface(surface)),
  };
}

export function parseHarnessRunBegin(value: unknown): DesktopHarnessRunView {
  if (!isRecord(value) || !isRecord(value.snapshot)) throw new Error("SourceNerve Harness begin response is invalid");
  return parseHarnessRunSnapshot(value.snapshot);
}

export function parseHarnessRunList(value: unknown): DesktopHarnessRunView[] {
  if (!isRecord(value) || !Array.isArray(value.runs)) throw new Error("SourceNerve Harness run list response is invalid");
  return value.runs.map(parseHarnessRunSnapshot);
}

export function parseHarnessRunSnapshot(value: unknown): DesktopHarnessRunView {
  if (!isRecord(value) || !isRecord(value.run) || !isRecord(value.freshness) || !isRecord(value.recovery) || !isRecord(value.closed_loop) || !isRecord(value.repository_context)) {
    throw new Error("SourceNerve Harness run response is invalid");
  }
  const run = value.run;
  const freshness = value.freshness;
  const recovery = value.recovery;
  const closedLoop = parseClosedLoop(value.closed_loop);
  const repositoryContext = parseRepositoryContext(value.repository_context);
  const profile = parseProfile(run.capability_snapshot);
  const completedAt = optionalNonNegativeInteger(run.completed_at);
  const parentRunId = optionalBoundedText(run.parent_run_id, 128);
  const freshnessReason = optionalBoundedText(freshness.reason, 256);
  const checkpoint = recovery.checkpoint === null || recovery.checkpoint === undefined
    ? undefined
    : parseCheckpoint(recovery.checkpoint);
  const children = value.children === null || value.children === undefined
    ? []
    : parseChildren(value.children);
  return {
    id: boundedText(run.id, 128, "run id"),
    actor: typeof run.principal_id === "string" && run.principal_id.startsWith("oauth:") ? "external-agent" : "operator",
    workspace: boundedText(run.workspace, 128, "workspace"),
    profile: boundedText(run.profile, 128, "profile"),
    profileDescription: profile.description,
    origin: run.origin === "automatic" ? "automatic" : "manual",
    sandbox: profile.sandbox,
    policies: profile.policies,
    status: boundedText(run.status, 64, "run status"),
    ...(parentRunId ? { parentRunId } : {}),
    children,
    childrenTruncated: value.children_truncated === true,
    freshnessState: boundedText(freshness.state, 64, "freshness state"),
    ...(freshnessReason ? { freshnessReason } : {}),
    recoveryState: boundedText(recovery.state, 64, "recovery state"),
    recoveryReason: boundedText(recovery.reason, 128, "recovery reason"),
    closedLoop,
    repositoryContext,
    pendingApprovals: nonNegativeInteger(recovery.pending_approvals, "pending approvals"),
    activeJobs: nonNegativeInteger(recovery.active_jobs, "active jobs"),
    uncertainMutations: nonNegativeInteger(recovery.uncertain_mutations, "uncertain mutations"),
    retryableReadExecutions: nonNegativeInteger(recovery.retryable_read_executions, "retryable reads"),
    retryablePreDispatchExecutions: nonNegativeInteger(recovery.retryable_pre_dispatch_executions, "retryable pre-dispatch"),
    blockedPreDispatchExecutions: nonNegativeInteger(recovery.blocked_pre_dispatch_executions, "blocked pre-dispatch"),
    ...(checkpoint ? { checkpoint } : {}),
    startedAt: nonNegativeInteger(run.started_at, "started at"),
    updatedAt: nonNegativeInteger(run.updated_at, "updated at"),
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}

export function parseHarnessEvents(value: unknown): DesktopHarnessEventView[] {
  if (!isRecord(value) || !Array.isArray(value.events)) throw new Error("SourceNerve Harness event response is invalid");
  return value.events.map((entry) => {
    if (!isRecord(entry)) throw new Error("SourceNerve Harness event item is invalid");
    const eventType = boundedText(entry.event_type, 64, "event type");
    return {
      seq: nonNegativeInteger(entry.seq, "event sequence"),
      eventType,
      summary: summarizeEvent(eventType, entry.payload),
      createdAt: nonNegativeInteger(entry.created_at, "event created at"),
    };
  });
}

export function parseHarnessJobList(value: unknown): DesktopHarnessJobView[] {
  if (!isRecord(value) || !Array.isArray(value.jobs)) throw new Error("SourceNerve Harness job list response is invalid");
  return value.jobs.map(parseHarnessJob);
}

export function parseHarnessJobCall(value: unknown): DesktopHarnessJobView {
  if (!isRecord(value)) throw new Error("SourceNerve Harness job response is invalid");
  return parseHarnessJob(value.job);
}

function parseChildren(value: unknown): DesktopHarnessChildRunView[] {
  if (!Array.isArray(value)) throw new Error("SourceNerve Harness child run list is invalid");
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error("SourceNerve Harness child run item is invalid");
    const completedAt = optionalNonNegativeInteger(entry.completed_at);
    return {
      id: boundedText(entry.id, 128, "child run id"),
      profile: boundedText(entry.profile, 128, "child run profile"),
      status: boundedText(entry.status, 64, "child run status"),
      parentRunId: boundedText(entry.parent_run_id, 128, "child parent run id"),
      startedAt: nonNegativeInteger(entry.started_at, "child started at"),
      updatedAt: nonNegativeInteger(entry.updated_at, "child updated at"),
      ...(completedAt !== undefined ? { completedAt } : {}),
    };
  });
}

function parseHarnessJob(value: unknown): DesktopHarnessJobView {
  if (!isRecord(value)) throw new Error("SourceNerve Harness job item is invalid");
  const taskId = optionalBoundedText(value.task_id, 128);
  return {
    id: boundedText(value.id, 128, "job id"),
    runId: boundedText(value.run_id, 128, "job run id"),
    workspace: boundedText(value.workspace, 128, "job workspace"),
    kind: boundedText(value.kind, 64, "job kind"),
    ...(taskId ? { taskId } : {}),
    status: boundedText(value.status, 64, "job status"),
    createdAt: nonNegativeInteger(value.created_at, "job created at"),
    updatedAt: nonNegativeInteger(value.updated_at, "job updated at"),
  };
}


function parseRepositoryContext(value: unknown): DesktopHarnessRepositoryContext {
  if (!isRecord(value) || !Array.isArray(value.proof_candidates)) throw new Error("SourceNerve Harness repository context is invalid");
  const entrypoints = stringArray(value.entrypoints, "repository context entrypoints");
  const guidance = stringArray(value.guidance, "repository context guidance");
  const activePlans = stringArray(value.active_plans, "repository context active plans");
  const validationOwners = stringArray(value.validation_owners, "repository context validation owners");
  return {
    entrypoints,
    guidance,
    activePlans,
    validationOwners,
    proofCandidates: value.proof_candidates.map((candidate) => {
      if (!isRecord(candidate)) throw new Error("SourceNerve Harness proof candidate is invalid");
      const cwd = optionalBoundedText(candidate.cwd, 512);
      return {
        proofType: proofType(candidate.proof_type),
        source: boundedText(candidate.source, 512, "proof candidate source"),
        ...(cwd ? { cwd } : {}),
        command: boundedText(candidate.command, 1024, "proof candidate command"),
        reason: boundedText(candidate.reason, 1024, "proof candidate reason"),
      };
    }),
    truncated: value.truncated === true,
  };
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`SourceNerve Harness ${label} is invalid`);
  return value.map((item) => boundedText(item, 512, label));
}

function parseClosedLoop(value: unknown): DesktopHarnessClosedLoopView {
  if (!isRecord(value) || !Array.isArray(value.learning_hints)) {
    throw new Error("SourceNerve Harness closed loop is invalid");
  }
  const phase = value.phase;
  if (phase !== "context" && phase !== "execute" && phase !== "verify" && phase !== "recover" && phase !== "learn") {
    throw new Error("SourceNerve Harness closed-loop phase is invalid");
  }
  const workShape = harnessWorkShape(value.work_shape);
  const workScope = optionalBoundedText(value.work_scope, 512);
  const selectedProofType = value.selected_proof_type === null || value.selected_proof_type === undefined
    ? undefined
    : proofType(value.selected_proof_type);
  const selectedProofSource = optionalBoundedText(value.selected_proof_source, 512);
  const selectedProofCommand = optionalBoundedText(value.selected_proof_command, 1024);
  if (!Array.isArray(value.satisfied_proofs)) throw new Error("SourceNerve Harness satisfied proof list is invalid");
  const satisfiedProofs = value.satisfied_proofs.map(proofType);
  const verificationStatus = value.verification_status;
  if (verificationStatus !== "idle" && verificationStatus !== "pending" && verificationStatus !== "passed" && verificationStatus !== "failed") {
    throw new Error("SourceNerve Harness verification status is invalid");
  }
  const recoveryStatus = value.recovery_status;
  if (recoveryStatus !== "idle" && recoveryStatus !== "needed" && recoveryStatus !== "in-progress" && recoveryStatus !== "recovered") {
    throw new Error("SourceNerve Harness closed-loop recovery status is invalid");
  }
  const lastFailureTool = optionalBoundedText(value.last_failure_tool, 128);
  const lastFailureCategory = optionalBoundedText(value.last_failure_category, 64);
  return {
    phase,
    workShape,
    ...(workScope ? { workScope } : {}),
    contextReads: nonNegativeInteger(value.context_reads, "context reads"),
    executions: nonNegativeInteger(value.executions, "closed-loop executions"),
    verificationRequired: value.verification_required === true,
    verificationStatus,
    recoveryStatus,
    ...(selectedProofType ? { selectedProofType } : {}),
    ...(selectedProofSource ? { selectedProofSource } : {}),
    ...(selectedProofCommand ? { selectedProofCommand } : {}),
    satisfiedProofs,
    failureCount: nonNegativeInteger(value.failure_count, "closed-loop failures"),
    learningCount: nonNegativeInteger(value.learning_count, "closed-loop learnings"),
    ...(lastFailureTool ? { lastFailureTool } : {}),
    ...(lastFailureCategory ? { lastFailureCategory } : {}),
    learningHints: value.learning_hints.map((hint) => {
      if (!isRecord(hint)) throw new Error("SourceNerve Harness learning hint is invalid");
      return {
        tool: boundedText(hint.tool, 128, "learning hint tool"),
        errorCategory: boundedText(hint.error_category, 64, "learning hint error category"),
        failures: nonNegativeInteger(hint.failures, "learning hint failures"),
        recoveries: nonNegativeInteger(hint.recoveries, "learning hint recoveries"),
        confirmations: nonNegativeInteger(hint.confirmations, "learning hint confirmations"),
        state: hint.state === "fresh-run-validated" ? "fresh-run-validated" : "candidate",
        suggestion: boundedText(hint.suggestion, 512, "learning hint suggestion"),
      };
    }),
  };
}

function parseCheckpoint(value: unknown): DesktopHarnessCheckpointView {
  if (!isRecord(value)) throw new Error("SourceNerve Harness checkpoint is invalid");
  return {
    id: boundedText(value.id, 128, "checkpoint id"),
    eventSeq: nonNegativeInteger(value.event_seq, "checkpoint sequence"),
    state: boundedText(value.state, 64, "checkpoint state"),
    reason: boundedText(value.reason, 128, "checkpoint reason"),
    createdAt: nonNegativeInteger(value.created_at, "checkpoint created at"),
  };
}

function summarizeEvent(eventType: string, payload: unknown): string {
  if (!isRecord(payload)) return eventType;
  const details: string[] = [];
  for (const key of SAFE_EVENT_KEYS) {
    const raw = payload[key];
    if (typeof raw === "string" && isBoundedSafeText(raw, 128)) details.push(`${key}=${raw}`);
    else if (typeof raw === "number" && Number.isSafeInteger(raw)) details.push(`${key}=${raw}`);
    else if (typeof raw === "boolean") details.push(`${key}=${raw}`);
  }
  const suffix = details.join(" · ");
  return suffix ? `${eventType} · ${suffix}` : eventType;
}

function parseProfile(value: unknown): {
  description: string;
  sandbox: HarnessSandboxMode;
  policies: DesktopHarnessRunView["policies"];
} {
  if (!isRecord(value) || !isRecord(value.profile)) {
    throw new Error("SourceNerve Harness capability profile is invalid");
  }
  const profile = value.profile;
  if (!isRecord(profile.policies)) throw new Error("SourceNerve Harness capability policies are invalid");
  const sandbox = sandboxMode(profile.sandbox);
  const execPolicy = policyDecision(profile.policies.exec, "exec");
  return {
    description: boundedText(profile.description, 512, "profile description"),
    sandbox,
    policies: {
      read: policyDecision(profile.policies.read, "read"),
      write: policyDecision(profile.policies.write, "write"),
      exec: sandbox === "danger-full-access" && execPolicy !== "deny" ? "ask" : execPolicy,
      git: policyDecision(profile.policies.git, "git"),
      provider: policyDecision(profile.policies.provider, "provider"),
      job: policyDecision(profile.policies.job, "job"),
    },
  };
}

function harnessWorkShape(value: unknown): DesktopHarnessClosedLoopView["workShape"] {
  if (value === "read-only" || value === "bounded" || value === "durable" || value === "operate-application" || value === "invariant") return value;
  throw new Error("SourceNerve Harness work shape is invalid");
}

function proofType(value: unknown): "focused-test" | "integration" | "e2e" | "recovery-rehearsal" | "measurement" {
  if (value === "focused-test" || value === "integration" || value === "e2e" || value === "recovery-rehearsal" || value === "measurement") return value;
  throw new Error("SourceNerve Harness proof type is invalid");
}

function contextRoute(value: unknown): DesktopHarnessContextRouteView["route"] {
  if (value === "none" || value === "exact-source" || value === "impact" || value === "architecture" || value === "symbol-graph" || value === "git-state" || value === "semantic" || value === "text-search" || value === "mixed") return value;
  throw new Error("SourceNerve Harness context route is invalid");
}

function contextSurface(value: unknown): string {
  if (typeof value === "string" && CONTEXT_SURFACES.has(value)) return value;
  throw new Error("SourceNerve Harness context surface is invalid");
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`SourceNerve Harness ${label} is invalid`);
  return value;
}

function sandboxMode(value: unknown): HarnessSandboxMode {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value;
  throw new Error("SourceNerve Harness sandbox mode is invalid");
}

function policyDecision(value: unknown, label: string): HarnessPolicyDecision {
  if (value === "allow" || value === "ask" || value === "deny") return value;
  throw new Error(`SourceNerve Harness ${label} policy is invalid`);
}

function boundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !isBoundedSafeText(value, max)) throw new Error(`SourceNerve Harness ${label} is invalid`);
  return value;
}
function optionalBoundedText(value: unknown, max: number): string | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "string" && isBoundedSafeText(value, max) ? value : undefined;
}
function isBoundedSafeText(value: string, max: number): boolean {
  return value.length >= 1 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`SourceNerve Harness ${label} is invalid`);
  return Number(value);
}
function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
