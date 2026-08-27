from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:160]!r}")
    file.write_text(text.replace(old, new, 1))


def write(path: str, content: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content)


# Backend: list durable runs through the existing run kernel.
replace_once(
    "src/harness.rs",
    "const DEFAULT_EVENT_LIMIT: usize = 100;\n",
    "const DEFAULT_EVENT_LIMIT: usize = 100;\nconst MAX_RUN_LIST_LIMIT: usize = 100;\nconst DEFAULT_RUN_LIST_LIMIT: usize = 50;\n",
)
replace_once(
    "src/harness.rs",
    '''#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessRunIdRequest {
    pub run_id: String,
}
''',
    '''#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessRunIdRequest {
    pub run_id: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessRunListRequest {
    #[serde(default = "default_run_list_limit")]
    pub limit: usize,
}
''',
)
replace_once(
    "src/harness.rs",
    '''#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessRunBeginResult {
    pub snapshot: HarnessRunSnapshot,
    pub replayed: bool,
}
''',
    '''#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessRunBeginResult {
    pub snapshot: HarnessRunSnapshot,
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessRunListResult {
    pub runs: Vec<HarnessRunSnapshot>,
}
''',
)
replace_once(
    "src/harness.rs",
    '''fn default_event_limit() -> usize {
    DEFAULT_EVENT_LIMIT
}
''',
    '''fn default_event_limit() -> usize {
    DEFAULT_EVENT_LIMIT
}

fn default_run_list_limit() -> usize {
    DEFAULT_RUN_LIST_LIMIT
}
''',
)
list_fn = r'''
pub async fn list(
    state: &AppState,
    req: HarnessRunListRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessRunListResult> {
    if req.limit == 0 || req.limit > MAX_RUN_LIST_LIMIT {
        return Err(AppError::InvalidRequest(format!(
            "harness run list limit must be between 1 and {MAX_RUN_LIST_LIMIT}"
        )));
    }
    let run_ids: Vec<String> = if operator {
        sqlx::query_scalar(
            "SELECT id FROM harness_runs ORDER BY updated_at DESC, id DESC LIMIT ?1",
        )
        .bind(req.limit as i64)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_scalar(
            "SELECT id FROM harness_runs WHERE principal_id=?1 \
             ORDER BY updated_at DESC, id DESC LIMIT ?2",
        )
        .bind(principal_id)
        .bind(req.limit as i64)
        .fetch_all(&state.db)
        .await?
    };

    let mut runs = Vec::with_capacity(run_ids.len());
    for run_id in run_ids {
        runs.push(
            get(
                state,
                HarnessRunIdRequest { run_id },
                principal_id,
                operator,
            )
            .await?,
        );
    }
    Ok(HarnessRunListResult { runs })
}

'''
replace_once("src/harness.rs", "pub async fn get(\n", list_fn + "pub async fn get(\n")

# Backend: internal Desktop list for existing Harness Jobs; stable MCP operation enum stays unchanged.
replace_once(
    "src/harness_job.rs",
    "const WAIT_POLL_MS: u64 = 100;\n",
    "const WAIT_POLL_MS: u64 = 100;\nconst MAX_JOB_LIST_LIMIT: usize = 100;\nconst DEFAULT_JOB_LIST_LIMIT: usize = 50;\n",
)
replace_once(
    "src/harness_job.rs",
    '''#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessJobCallRequest {
    pub run_id: String,
    pub operation: HarnessJobOperation,
    pub job_id: Option<String>,
    pub client_request_id: Option<String>,
    pub context_query: Option<String>,
    pub context_max_bytes: Option<usize>,
    pub context_max_items: Option<usize>,
    pub wait_timeout_ms: Option<u64>,
}
''',
    '''#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessJobCallRequest {
    pub run_id: String,
    pub operation: HarnessJobOperation,
    pub job_id: Option<String>,
    pub client_request_id: Option<String>,
    pub context_query: Option<String>,
    pub context_max_bytes: Option<usize>,
    pub context_max_items: Option<usize>,
    pub wait_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessJobListRequest {
    pub run_id: String,
    #[serde(default = "default_job_list_limit")]
    pub limit: usize,
}
''',
)
replace_once(
    "src/harness_job.rs",
    '''#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessJobCallResult {
    pub job: HarnessJobView,
    pub task: Option<JobTaskStatus>,
    pub lifecycle: Option<TaskLifecycleView>,
    pub replayed: bool,
    pub timed_out: bool,
}
''',
    '''#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessJobCallResult {
    pub job: HarnessJobView,
    pub task: Option<JobTaskStatus>,
    pub lifecycle: Option<TaskLifecycleView>,
    pub replayed: bool,
    pub timed_out: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessJobListResult {
    pub jobs: Vec<HarnessJobView>,
}

fn default_job_list_limit() -> usize {
    DEFAULT_JOB_LIST_LIMIT
}
''',
)
job_list_fn = r'''
pub async fn list(
    state: &AppState,
    req: HarnessJobListRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessJobListResult> {
    if req.run_id.is_empty() || req.run_id.len() > 128 || !req.run_id.is_ascii() {
        return Err(AppError::InvalidRequest("invalid harness run_id".into()));
    }
    if req.limit == 0 || req.limit > MAX_JOB_LIST_LIMIT {
        return Err(AppError::InvalidRequest(format!(
            "harness job list limit must be between 1 and {MAX_JOB_LIST_LIMIT}"
        )));
    }
    let run = owned_run(state, &req.run_id, principal_id, operator).await?;
    let rows: Vec<HarnessJobDbRow> = sqlx::query_as(
        "SELECT id, request_fingerprint, workspace_id, task_id, harness_run_id, principal_id, \
                harness_request_id, kind, created_at, updated_at \
         FROM jobs WHERE harness_run_id=?1 AND principal_id=?2 \
         ORDER BY updated_at DESC, id DESC LIMIT ?3",
    )
    .bind(&run.run.id)
    .bind(&run.run.principal_id)
    .bind(req.limit as i64)
    .fetch_all(&state.db)
    .await?;

    let mut jobs = Vec::with_capacity(rows.len());
    for row in rows {
        let row = from_db(row);
        if row.workspace != run.run.workspace {
            return Err(AppError::Internal(anyhow::anyhow!(
                "Harness job workspace does not match owning run"
            )));
        }
        jobs.push(materialize(state, row).await?.job);
    }
    Ok(HarnessJobListResult { jobs })
}

'''
replace_once("src/harness_job.rs", "pub async fn call(\n", job_list_fn + "pub async fn call(\n")

# Backend HTTP: Desktop operator read/cancel paths, without adding public MCP tools.
replace_once(
    "src/harness_http.rs",
    '''        self, HarnessRunBeginRequest, HarnessRunEventsRequest, HarnessRunIdRequest,
        capability::HarnessCapabilitiesRequest,
    },
    mcp::harness_approval::{self, HarnessApprovalListRequest, HarnessApprovalRespondRequest},
''',
    '''        self, HarnessRunBeginRequest, HarnessRunEventsRequest, HarnessRunIdRequest,
        HarnessRunListRequest, capability::HarnessCapabilitiesRequest,
    },
    job_ingress::harness_job::{self, HarnessJobCallRequest, HarnessJobListRequest},
    mcp::harness_approval::{self, HarnessApprovalListRequest, HarnessApprovalRespondRequest},
''',
)
replace_once(
    "src/harness_http.rs",
    '''        .route("/harness/runs/begin", post(begin))
        .route("/harness/runs/get", post(get))
''',
    '''        .route("/harness/runs/begin", post(begin))
        .route("/harness/runs/list", post(list_runs))
        .route("/harness/runs/get", post(get))
''',
)
replace_once(
    "src/harness_http.rs",
    '''        .route("/harness/runs/complete", post(complete))
        .route("/harness/approvals/list", post(list_approvals))
''',
    '''        .route("/harness/runs/complete", post(complete))
        .route("/harness/jobs/list", post(list_jobs))
        .route("/harness/jobs/call", post(call_job))
        .route("/harness/approvals/list", post(list_approvals))
''',
)
run_list_handler = r'''
async fn list_runs(
    State(state): State<AppState>,
    Json(request): Json<HarnessRunListRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::list(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

'''
replace_once("src/harness_http.rs", "async fn get(\n", run_list_handler + "async fn get(\n")
job_handlers = r'''
async fn list_jobs(
    State(state): State<AppState>,
    Json(request): Json<HarnessJobListRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness_job::list(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn call_job(
    State(state): State<AppState>,
    Json(request): Json<HarnessJobCallRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness_job::call(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

'''
replace_once("src/harness_http.rs", "async fn list_approvals(\n", job_handlers + "async fn list_approvals(\n")

# Shared typed Desktop API. Renderer never receives raw Harness args/results/event payload JSON.
write("desktop/src/shared/harness-api.ts", r'''import type { DesktopResult } from "./desktop-api";

export const HARNESS_IPC = {
  listRuns: "desktop:harness-runs-list",
  getRun: "desktop:harness-run-get",
  listEvents: "desktop:harness-run-events",
  listJobs: "desktop:harness-jobs-list",
  cancelRun: "desktop:harness-run-cancel",
  cancelJob: "desktop:harness-job-cancel",
} as const;

export interface DesktopHarnessRunListInput { limit?: number; }
export interface DesktopHarnessRunIdInput { runId: string; }
export interface DesktopHarnessEventsInput { runId: string; afterSeq?: number; limit?: number; }
export interface DesktopHarnessJobListInput { runId: string; limit?: number; }
export interface DesktopHarnessJobCancelInput { runId: string; jobId: string; }

export interface DesktopHarnessCheckpointView {
  id: string;
  eventSeq: number;
  state: string;
  reason: string;
  createdAt: number;
}

export interface DesktopHarnessRunView {
  id: string;
  workspace: string;
  profile: string;
  status: string;
  freshnessState: string;
  freshnessReason?: string;
  recoveryState: string;
  recoveryReason: string;
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
    listHarnessRuns(input?: DesktopHarnessRunListInput): Promise<DesktopResult<DesktopHarnessRunView[]>>;
    getHarnessRun(input: DesktopHarnessRunIdInput): Promise<DesktopResult<DesktopHarnessRunView>>;
    listHarnessEvents(input: DesktopHarnessEventsInput): Promise<DesktopResult<DesktopHarnessEventView[]>>;
    listHarnessJobs(input: DesktopHarnessJobListInput): Promise<DesktopResult<DesktopHarnessJobView[]>>;
    cancelHarnessRun(input: DesktopHarnessRunIdInput): Promise<DesktopResult<DesktopHarnessRunView>>;
    cancelHarnessJob(input: DesktopHarnessJobCancelInput): Promise<DesktopResult<DesktopHarnessJobView>>;
  }
}
''')

# Main-process sanitizing parser/read model.
write("desktop/src/main/harness-parser.ts", r'''import type {
  DesktopHarnessCheckpointView,
  DesktopHarnessEventView,
  DesktopHarnessJobView,
  DesktopHarnessRunView,
} from "../shared/harness-api";

const SAFE_EVENT_KEYS = [
  "tool",
  "tool_name",
  "capability_id",
  "job_id",
  "approval_id",
  "kind",
  "state",
  "reason",
  "result_category",
  "sandbox",
  "enforcement",
] as const;

export function parseHarnessRunList(value: unknown): DesktopHarnessRunView[] {
  if (!isRecord(value) || !Array.isArray(value.runs)) throw new Error("SourceNerve Harness run list response is invalid");
  return value.runs.map(parseHarnessRunSnapshot);
}

export function parseHarnessRunSnapshot(value: unknown): DesktopHarnessRunView {
  if (!isRecord(value) || !isRecord(value.run) || !isRecord(value.freshness) || !isRecord(value.recovery)) {
    throw new Error("SourceNerve Harness run response is invalid");
  }
  const run = value.run;
  const freshness = value.freshness;
  const recovery = value.recovery;
  const completedAt = optionalNonNegativeInteger(run.completed_at);
  const freshnessReason = optionalBoundedText(freshness.reason, 256);
  const checkpoint = recovery.checkpoint === null || recovery.checkpoint === undefined
    ? undefined
    : parseCheckpoint(recovery.checkpoint);
  return {
    id: boundedText(run.id, 128, "run id"),
    workspace: boundedText(run.workspace, 128, "workspace"),
    profile: boundedText(run.profile, 128, "profile"),
    status: boundedText(run.status, 64, "run status"),
    freshnessState: boundedText(freshness.state, 64, "freshness state"),
    ...(freshnessReason ? { freshnessReason } : {}),
    recoveryState: boundedText(recovery.state, 64, "recovery state"),
    recoveryReason: boundedText(recovery.reason, 128, "recovery reason"),
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
  }
  const suffix = details.join(" · ");
  return suffix ? `${eventType} · ${suffix}` : eventType;
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
''')

write("desktop/src/main/harness-parser.test.ts", r'''import assert from "node:assert/strict";
import test from "node:test";

import { parseHarnessEvents, parseHarnessRunSnapshot } from "./harness-parser";

test("Harness event parser exposes only whitelisted safe metadata", () => {
  const events = parseHarnessEvents({
    events: [{
      seq: 1,
      event_type: "tool/result",
      payload: { tool: "workspace_exec", result_category: "success", raw_arguments: "DO_NOT_EXPOSE", output: "SECRET" },
      created_at: 10,
    }],
  });
  assert.match(events[0].summary, /workspace_exec/);
  assert.doesNotMatch(events[0].summary, /DO_NOT_EXPOSE|SECRET/);
});

test("Harness run parser drops principal and capability snapshots", () => {
  const parsed = parseHarnessRunSnapshot({
    run: { id: "run-1", workspace: "repo", profile: "interactive-local", status: "running", started_at: 1, updated_at: 2, completed_at: null, principal_id: "oauth:secret", capability_snapshot: { secret: "hidden" } },
    freshness: { state: "current", reason: null },
    recovery: { state: "resumable", reason: "ready", pending_approvals: 0, active_jobs: 0, uncertain_mutations: 0, retryable_read_executions: 0, retryable_pre_dispatch_executions: 0, blocked_pre_dispatch_executions: 0, checkpoint: null },
  });
  assert.equal(parsed.id, "run-1");
  assert.equal("principalId" in parsed, false);
  assert.equal("capabilitySnapshot" in parsed, false);
});
''')

# IPC contract and validation.
write("desktop/src/main/harness-policy.ts", r'''import {
  HARNESS_IPC,
  type DesktopHarnessEventsInput,
  type DesktopHarnessJobCancelInput,
  type DesktopHarnessJobListInput,
  type DesktopHarnessRunIdInput,
  type DesktopHarnessRunListInput,
} from "../shared/harness-api";

export const HARNESS_INBOUND_IPC_CHANNELS = Object.freeze(Object.values(HARNESS_IPC));

export function validateHarnessIpcInvocation(channel: string, args: readonly unknown[]): string | null {
  if (channel === HARNESS_IPC.listRuns) return args.length <= 1 && (args.length === 0 || isRunList(args[0])) ? null : "Harness run list input is invalid";
  if (channel === HARNESS_IPC.getRun || channel === HARNESS_IPC.cancelRun) return args.length === 1 && isRunId(args[0]) ? null : "Harness run input is invalid";
  if (channel === HARNESS_IPC.listEvents) return args.length === 1 && isEvents(args[0]) ? null : "Harness event input is invalid";
  if (channel === HARNESS_IPC.listJobs) return args.length === 1 && isJobList(args[0]) ? null : "Harness job list input is invalid";
  if (channel === HARNESS_IPC.cancelJob) return args.length === 1 && isJobCancel(args[0]) ? null : "Harness job cancel input is invalid";
  return "Harness IPC channel is not allowlisted";
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
function isLimit(value: unknown, max: number): boolean { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max; }
function boundedId(value: unknown): value is string { return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
''')
write("desktop/src/main/harness-policy.test.ts", r'''import assert from "node:assert/strict";
import test from "node:test";

import { HARNESS_IPC } from "../shared/harness-api";
import { validateHarnessIpcInvocation } from "./harness-policy";

test("Harness IPC accepts bounded run and job operations", () => {
  assert.equal(validateHarnessIpcInvocation(HARNESS_IPC.listRuns, [{ limit: 25 }]), null);
  assert.equal(validateHarnessIpcInvocation(HARNESS_IPC.getRun, [{ runId: "run-1" }]), null);
  assert.equal(validateHarnessIpcInvocation(HARNESS_IPC.listEvents, [{ runId: "run-1", afterSeq: -1, limit: 200 }]), null);
  assert.equal(validateHarnessIpcInvocation(HARNESS_IPC.cancelJob, [{ runId: "run-1", jobId: "job-1" }]), null);
});

test("Harness IPC rejects unbounded and extra fields", () => {
  assert.notEqual(validateHarnessIpcInvocation(HARNESS_IPC.listRuns, [{ limit: 101 }]), null);
  assert.notEqual(validateHarnessIpcInvocation(HARNESS_IPC.cancelJob, [{ runId: "run-1", jobId: "job-1", decision: "allow" }]), null);
});
''')

# Allowlisted loopback client surface. Approval compatibility remains narrow.
replace_once(
    "desktop/src/main/sourcenerve-client.ts",
    '''const HARNESS_APPROVAL_API_PATHS = new Set([
  "/api/v1/harness/approvals/list",
  "/api/v1/harness/approvals/respond",
]);
''',
    '''const HARNESS_API_PATHS = new Set([
  "/api/v1/harness/runs/list",
  "/api/v1/harness/runs/get",
  "/api/v1/harness/runs/events",
  "/api/v1/harness/runs/cancel",
  "/api/v1/harness/jobs/list",
  "/api/v1/harness/jobs/call",
  "/api/v1/harness/approvals/list",
  "/api/v1/harness/approvals/respond",
]);
const HARNESS_APPROVAL_API_PATHS = new Set([
  "/api/v1/harness/approvals/list",
  "/api/v1/harness/approvals/respond",
]);
''',
)
replace_once(
    "desktop/src/main/sourcenerve-client.ts",
    '''  async harnessApprovalRequest(requestPath: string, body: object): Promise<unknown> {
    if (!HARNESS_APPROVAL_API_PATHS.has(requestPath)) throw new Error("SourceNerve Harness approval endpoint is not allowlisted");
    return this.request(requestPath, {
      authenticated: true,
      method: "POST",
      body,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      includeGuardError: true,
    });
  }
''',
    '''  async harnessRequest(requestPath: string, body: object): Promise<unknown> {
    if (!HARNESS_API_PATHS.has(requestPath)) throw new Error("SourceNerve Harness endpoint is not allowlisted");
    return this.request(requestPath, {
      authenticated: true,
      method: "POST",
      body,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      includeGuardError: true,
    });
  }

  async harnessApprovalRequest(requestPath: string, body: object): Promise<unknown> {
    if (!HARNESS_APPROVAL_API_PATHS.has(requestPath)) throw new Error("SourceNerve Harness approval endpoint is not allowlisted");
    return this.harnessRequest(requestPath, body);
  }
''',
)

# Desktop manager reuses existing task/authenticated client lifecycle.
replace_once(
    "desktop/src/main/task-manager.ts",
    '''import type {
  DesktopHarnessApprovalListInput,
''',
    '''import type {
  DesktopHarnessEventsInput,
  DesktopHarnessJobCancelInput,
  DesktopHarnessJobListInput,
  DesktopHarnessJobView,
  DesktopHarnessRunIdInput,
  DesktopHarnessRunListInput,
  DesktopHarnessRunView,
} from "../shared/harness-api";
import type {
  DesktopHarnessApprovalListInput,
''',
)
replace_once(
    "desktop/src/main/task-manager.ts",
    '''import { parseHarnessApprovalList, parseHarnessApprovalRespond } from "./harness-approval-parser";
''',
    '''import { parseHarnessApprovalList, parseHarnessApprovalRespond } from "./harness-approval-parser";
import { parseHarnessEvents, parseHarnessJobCall, parseHarnessJobList, parseHarnessRunList, parseHarnessRunSnapshot } from "./harness-parser";
''',
)
manager_methods = r'''
  async listHarnessRuns(input: DesktopHarnessRunListInput = {}): Promise<DesktopHarnessRunView[]> {
    return parseHarnessRunList(await this.options.client.harnessRequest(
      "/api/v1/harness/runs/list",
      { limit: input.limit ?? 50 },
    ));
  }

  async getHarnessRun(input: DesktopHarnessRunIdInput): Promise<DesktopHarnessRunView> {
    return parseHarnessRunSnapshot(await this.options.client.harnessRequest(
      "/api/v1/harness/runs/get",
      { run_id: input.runId },
    ));
  }

  async listHarnessEvents(input: DesktopHarnessEventsInput) {
    return parseHarnessEvents(await this.options.client.harnessRequest(
      "/api/v1/harness/runs/events",
      { run_id: input.runId, after_seq: input.afterSeq ?? -1, limit: input.limit ?? 200 },
    ));
  }

  async listHarnessJobs(input: DesktopHarnessJobListInput): Promise<DesktopHarnessJobView[]> {
    return parseHarnessJobList(await this.options.client.harnessRequest(
      "/api/v1/harness/jobs/list",
      { run_id: input.runId, limit: input.limit ?? 50 },
    ));
  }

  async cancelHarnessRun(input: DesktopHarnessRunIdInput): Promise<DesktopHarnessRunView> {
    return parseHarnessRunSnapshot(await this.options.client.harnessRequest(
      "/api/v1/harness/runs/cancel",
      { run_id: input.runId },
    ));
  }

  async cancelHarnessJob(input: DesktopHarnessJobCancelInput): Promise<DesktopHarnessJobView> {
    return parseHarnessJobCall(await this.options.client.harnessRequest(
      "/api/v1/harness/jobs/call",
      { run_id: input.runId, operation: "cancel", job_id: input.jobId },
    ));
  }

'''
replace_once("desktop/src/main/task-manager.ts", "  async listHarnessApprovals(\n", manager_methods + "  async listHarnessApprovals(\n")

# IPC wiring.
replace_once(
    "desktop/src/main/task-ipc.ts",
    '''import type { DesktopError, DesktopResult } from "../shared/desktop-api";
import {
  HARNESS_APPROVAL_IPC,
''',
    '''import type { DesktopError, DesktopResult } from "../shared/desktop-api";
import {
  HARNESS_IPC,
  type DesktopHarnessEventsInput,
  type DesktopHarnessJobCancelInput,
  type DesktopHarnessJobListInput,
  type DesktopHarnessRunIdInput,
  type DesktopHarnessRunListInput,
} from "../shared/harness-api";
import {
  HARNESS_APPROVAL_IPC,
''',
)
replace_once(
    "desktop/src/main/task-ipc.ts",
    '''  for (const channel of [...Object.values(TASK_IPC), ...Object.values(HARNESS_APPROVAL_IPC)]) ipcMain.removeHandler(channel);

  secureHandle(context, TASK_IPC.list,''',
    '''  for (const channel of [...Object.values(TASK_IPC), ...Object.values(HARNESS_IPC), ...Object.values(HARNESS_APPROVAL_IPC)]) ipcMain.removeHandler(channel);

  secureHandle(context, HARNESS_IPC.listRuns, async (args) => invoke(context, (manager) => manager.listHarnessRuns((args[0] ?? {}) as DesktopHarnessRunListInput)));
  secureHandle(context, HARNESS_IPC.getRun, async (args) => invoke(context, (manager) => manager.getHarnessRun(args[0] as DesktopHarnessRunIdInput)));
  secureHandle(context, HARNESS_IPC.listEvents, async (args) => invoke(context, (manager) => manager.listHarnessEvents(args[0] as DesktopHarnessEventsInput)));
  secureHandle(context, HARNESS_IPC.listJobs, async (args) => invoke(context, (manager) => manager.listHarnessJobs(args[0] as DesktopHarnessJobListInput)));
  secureHandle(context, HARNESS_IPC.cancelRun, async (args) => invoke(context, (manager) => manager.cancelHarnessRun(args[0] as DesktopHarnessRunIdInput)));
  secureHandle(context, HARNESS_IPC.cancelJob, async (args) => invoke(context, (manager) => manager.cancelHarnessJob(args[0] as DesktopHarnessJobCancelInput)));

  secureHandle(context, TASK_IPC.list,''',
)

# Central IPC policy gains a dedicated Harness namespace.
replace_once(
    "desktop/src/main/ipc-policy.ts",
    '''import {
  HARNESS_APPROVAL_INBOUND_IPC_CHANNELS,
''',
    '''import { HARNESS_INBOUND_IPC_CHANNELS, validateHarnessIpcInvocation } from "./harness-policy";
import {
  HARNESS_APPROVAL_INBOUND_IPC_CHANNELS,
''',
)
replace_once(
    "desktop/src/main/ipc-policy.ts",
    '''const HARNESS_APPROVAL_CHANNELS = new Set<string>(HARNESS_APPROVAL_INBOUND_IPC_CHANNELS);
''',
    '''const HARNESS_CHANNELS = new Set<string>(HARNESS_INBOUND_IPC_CHANNELS);
const HARNESS_APPROVAL_CHANNELS = new Set<string>(HARNESS_APPROVAL_INBOUND_IPC_CHANNELS);
''',
)
replace_once(
    "desktop/src/main/ipc-policy.ts",
    '''  ...HARNESS_APPROVAL_INBOUND_IPC_CHANNELS,
''',
    '''  ...HARNESS_INBOUND_IPC_CHANNELS,
  ...HARNESS_APPROVAL_INBOUND_IPC_CHANNELS,
''',
)
replace_once(
    "desktop/src/main/ipc-policy.ts",
    '''export function validateDesktopIpcInvocation(channel: string, args: readonly unknown[]): string | null {
  if (HARNESS_APPROVAL_CHANNELS.has(channel))''',
    '''export function validateDesktopIpcInvocation(channel: string, args: readonly unknown[]): string | null {
  if (HARNESS_CHANNELS.has(channel)) return validateHarnessIpcInvocation(channel, args);
  if (HARNESS_APPROVAL_CHANNELS.has(channel))''',
)

# Preload: typed bridge only, no raw ipcRenderer exposure.
replace_once(
    "desktop/src/preload.ts",
    '''import {
  HARNESS_APPROVAL_IPC,
''',
    '''import {
  HARNESS_IPC,
  type DesktopHarnessEventView,
  type DesktopHarnessEventsInput,
  type DesktopHarnessJobCancelInput,
  type DesktopHarnessJobListInput,
  type DesktopHarnessJobView,
  type DesktopHarnessRunIdInput,
  type DesktopHarnessRunListInput,
  type DesktopHarnessRunView,
} from "./shared/harness-api";
import {
  HARNESS_APPROVAL_IPC,
''',
)
replace_once(
    "desktop/src/preload.ts",
    '''  listHarnessApprovals: (input: DesktopHarnessApprovalListInput) => ipcRenderer.invoke(HARNESS_APPROVAL_IPC.list, input) as Promise<DesktopResult<DesktopHarnessApprovalView[]>>,
''',
    '''  listHarnessRuns: (input: DesktopHarnessRunListInput = {}) => ipcRenderer.invoke(HARNESS_IPC.listRuns, input) as Promise<DesktopResult<DesktopHarnessRunView[]>>,
  getHarnessRun: (input: DesktopHarnessRunIdInput) => ipcRenderer.invoke(HARNESS_IPC.getRun, input) as Promise<DesktopResult<DesktopHarnessRunView>>,
  listHarnessEvents: (input: DesktopHarnessEventsInput) => ipcRenderer.invoke(HARNESS_IPC.listEvents, input) as Promise<DesktopResult<DesktopHarnessEventView[]>>,
  listHarnessJobs: (input: DesktopHarnessJobListInput) => ipcRenderer.invoke(HARNESS_IPC.listJobs, input) as Promise<DesktopResult<DesktopHarnessJobView[]>>,
  cancelHarnessRun: (input: DesktopHarnessRunIdInput) => ipcRenderer.invoke(HARNESS_IPC.cancelRun, input) as Promise<DesktopResult<DesktopHarnessRunView>>,
  cancelHarnessJob: (input: DesktopHarnessJobCancelInput) => ipcRenderer.invoke(HARNESS_IPC.cancelJob, input) as Promise<DesktopResult<DesktopHarnessJobView>>,
  listHarnessApprovals: (input: DesktopHarnessApprovalListInput) => ipcRenderer.invoke(HARNESS_APPROVAL_IPC.list, input) as Promise<DesktopResult<DesktopHarnessApprovalView[]>>,
''',
)

# Controlled approval panel can still be used standalone in Tasks & Changes.
replace_once(
    "desktop/src/renderer/components/HarnessApprovalPanel.tsx",
    '''import { useState } from "react";
''',
    '''import { useEffect, useState } from "react";
''',
)
replace_once(
    "desktop/src/renderer/components/HarnessApprovalPanel.tsx",
    '''export function HarnessApprovalPanel() {
  const [runId, setRunId] = useState("");
''',
    '''export function HarnessApprovalPanel({ runId: selectedRunId }: { runId?: string } = {}) {
  const [manualRunId, setManualRunId] = useState("");
  const runId = selectedRunId ?? manualRunId;
''',
)
replace_once(
    "desktop/src/renderer/components/HarnessApprovalPanel.tsx",
    '''  async function load(): Promise<void> {
    const value = runId.trim();
''',
    '''  useEffect(() => {
    setApprovals([]);
    if (selectedRunId) void load(selectedRunId);
  }, [selectedRunId]);

  async function load(runOverride?: string): Promise<void> {
    const value = (runOverride ?? runId).trim();
''',
)
replace_once(
    "desktop/src/renderer/components/HarnessApprovalPanel.tsx",
    '''      <div className="form-row">
        <label className="field grow">
          <span>Harness run ID</span>
          <input
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
            placeholder="Paste a run ID from the Harness tool response"
            maxLength={128}
          />
        </label>
        <ActionButton onClick={() => void load()} disabled={!runId.trim() || busy !== null}>
          {busy === "load" ? "Loading…" : "Load pending"}
        </ActionButton>
      </div>
''',
    '''      <div className="form-row">
        {selectedRunId ? (
          <p className="muted grow">Selected run <code>{selectedRunId}</code></p>
        ) : (
          <label className="field grow">
            <span>Harness run ID</span>
            <input
              value={manualRunId}
              onChange={(event) => setManualRunId(event.target.value)}
              placeholder="Paste a run ID from the Harness tool response"
              maxLength={128}
            />
          </label>
        )}
        <ActionButton onClick={() => void load()} disabled={!runId.trim() || busy !== null}>
          {busy === "load" ? "Loading…" : "Load pending"}
        </ActionButton>
      </div>
''',
)

# Renderer Harness surface.
write("desktop/src/renderer/components/HarnessScreen.tsx", r'''import { useEffect, useState } from "react";

import type { DesktopHarnessEventView, DesktopHarnessJobView, DesktopHarnessRunView } from "../../shared/harness-api";
import { HarnessApprovalPanel } from "./HarnessApprovalPanel";
import { Panel } from "./Panel";
import { ActionButton } from "./atoms/ActionButton";

export function HarnessScreen() {
  const [runs, setRuns] = useState<DesktopHarnessRunView[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selected, setSelected] = useState<DesktopHarnessRunView | null>(null);
  const [events, setEvents] = useState<DesktopHarnessEventView[]>([]);
  const [jobs, setJobs] = useState<DesktopHarnessJobView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refreshRuns(); }, []);

  async function refreshRuns(): Promise<void> {
    setBusy("runs");
    setError(null);
    const result = await window.sourcenerveDesktop.listHarnessRuns({ limit: 50 });
    if (!result.ok) {
      setError(result.error.message);
      setBusy(null);
      return;
    }
    setRuns(result.value);
    const next = selectedRunId && result.value.some((run) => run.id === selectedRunId)
      ? selectedRunId
      : result.value[0]?.id ?? null;
    setSelectedRunId(next);
    if (next) await refreshRun(next);
    else {
      setSelected(null);
      setEvents([]);
      setJobs([]);
    }
    setBusy(null);
  }

  async function refreshRun(runId: string): Promise<void> {
    setBusy(`run:${runId}`);
    setError(null);
    const [runResult, eventResult, jobResult] = await Promise.all([
      window.sourcenerveDesktop.getHarnessRun({ runId }),
      window.sourcenerveDesktop.listHarnessEvents({ runId, afterSeq: -1, limit: 200 }),
      window.sourcenerveDesktop.listHarnessJobs({ runId, limit: 50 }),
    ]);
    if (!runResult.ok) setError(runResult.error.message);
    else setSelected(runResult.value);
    if (!eventResult.ok) setError((current) => current ?? eventResult.error.message);
    else setEvents(eventResult.value);
    if (!jobResult.ok) setError((current) => current ?? jobResult.error.message);
    else setJobs(jobResult.value);
    setBusy(null);
  }

  async function selectRun(runId: string): Promise<void> {
    setSelectedRunId(runId);
    await refreshRun(runId);
  }

  async function cancelRun(): Promise<void> {
    if (!selected || selected.status !== "running") return;
    if (!window.confirm(`Cancel Harness run ${selected.id}?\n\nThis does not automatically undo already completed side effects.`)) return;
    setBusy("cancel-run");
    const result = await window.sourcenerveDesktop.cancelHarnessRun({ runId: selected.id });
    if (!result.ok) setError(result.error.message);
    else await refreshRuns();
    setBusy(null);
  }

  async function cancelJob(job: DesktopHarnessJobView): Promise<void> {
    if (job.status !== "active" && job.status !== "pending") return;
    if (!window.confirm(`Cancel Harness job ${job.id}?`)) return;
    setBusy(`job:${job.id}`);
    const result = await window.sourcenerveDesktop.cancelHarnessJob({ runId: job.runId, jobId: job.id });
    if (!result.ok) setError(result.error.message);
    else await refreshRun(job.runId);
    setBusy(null);
  }

  return (
    <div className="space-y-4">
      {error ? <p className="error-banner" role="alert">{error}</p> : null}
      <Panel title="Runs" eyebrow="Durable Harness">
        <div className="split-row">
          <p className="muted">Recent durable runs are loaded from SourceNerve state, not renderer session memory.</p>
          <ActionButton onClick={() => void refreshRuns()} disabled={busy !== null}>{busy === "runs" ? "Refreshing…" : "Refresh"}</ActionButton>
        </div>
        {runs.length === 0 ? <p className="muted">No Harness runs yet.</p> : (
          <div className="space-y-3">
            {runs.map((run) => (
              <article className="panel nested-panel" key={run.id}>
                <div className="split-row">
                  <div><strong>{run.workspace}</strong><p className="muted"><code>{run.id}</code> · {run.profile}</p></div>
                  <div className="button-row"><span className="status-pill">{run.status}</span><span className="status-pill">{run.recoveryState}</span><ActionButton onClick={() => void selectRun(run.id)} disabled={busy !== null}>{selectedRunId === run.id ? "Selected" : "Open"}</ActionButton></div>
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>

      {selected ? (
        <>
          <Panel title="Run overview" eyebrow="Recovery state">
            <div className="split-row">
              <div><strong>{selected.workspace}</strong><p className="muted">{selected.profile} · updated {new Date(selected.updatedAt * 1000).toLocaleString()}</p></div>
              <div className="button-row"><span className="status-pill">{selected.status}</span><span className="status-pill">{selected.freshnessState}</span><span className="status-pill">{selected.recoveryState}</span><ActionButton onClick={() => void refreshRun(selected.id)} disabled={busy !== null}>Refresh run</ActionButton>{selected.status === "running" ? <ActionButton onClick={() => void cancelRun()} disabled={busy !== null}>Cancel run</ActionButton> : null}</div>
            </div>
            <dl className="detail-grid">
              <div><dt>Recovery</dt><dd>{selected.recoveryReason}</dd></div>
              <div><dt>Pending approvals</dt><dd>{selected.pendingApprovals}</dd></div>
              <div><dt>Active jobs</dt><dd>{selected.activeJobs}</dd></div>
              <div><dt>Uncertain mutations</dt><dd>{selected.uncertainMutations}</dd></div>
              <div><dt>Safe read retries</dt><dd>{selected.retryableReadExecutions}</dd></div>
              <div><dt>Blocked pre-dispatch</dt><dd>{selected.blockedPreDispatchExecutions}</dd></div>
            </dl>
            {selected.checkpoint ? <p className="muted">Checkpoint {selected.checkpoint.eventSeq}: {selected.checkpoint.state} / {selected.checkpoint.reason}</p> : null}
          </Panel>

          <Panel title="Timeline" eyebrow="Ordered safe events">
            {events.length === 0 ? <p className="muted">No events recorded.</p> : <ol className="feature-list">{events.map((event) => <li key={event.seq}><code>#{event.seq}</code> {event.summary} <span className="muted">· {new Date(event.createdAt * 1000).toLocaleTimeString()}</span></li>)}</ol>}
          </Panel>

          <Panel title="Jobs" eyebrow="Durable work">
            {jobs.length === 0 ? <p className="muted">No Harness jobs for this run.</p> : <div className="space-y-3">{jobs.map((job) => <article className="panel nested-panel" key={job.id}><div className="split-row"><div><strong>{job.kind}</strong><p className="muted"><code>{job.id}</code>{job.taskId ? ` · task ${job.taskId}` : ""}</p></div><div className="button-row"><span className="status-pill">{job.status}</span>{job.status === "active" || job.status === "pending" ? <ActionButton onClick={() => void cancelJob(job)} disabled={busy !== null}>Cancel job</ActionButton> : null}</div></div></article>)}</div>}
          </Panel>

          <HarnessApprovalPanel runId={selected.id} />
        </>
      ) : null}
    </div>
  );
}
''')

# Navigation and App shell.
replace_once(
    "desktop/src/renderer/navigation.ts",
    '''  | "plugins"
  | "tasks"
''',
    '''  | "plugins"
  | "harness"
  | "tasks"
''',
)
replace_once(
    "desktop/src/renderer/navigation.ts",
    '''  {
    id: "tasks",
    label: "Tasks & Changes",
''',
    '''  {
    id: "harness",
    label: "Harness",
    description: "Durable runs, timeline, jobs, recovery and approvals",
  },
  {
    id: "tasks",
    label: "Tasks & Changes",
''',
)
replace_once(
    "desktop/src/renderer/App.tsx",
    '''import { IntelligenceExplorer } from "./components/IntelligenceExplorer";
''',
    '''import { HarnessScreen } from "./components/HarnessScreen";
import { IntelligenceExplorer } from "./components/IntelligenceExplorer";
''',
)
replace_once(
    "desktop/src/renderer/App.tsx",
    '''  plugins: ["Explore declarative plugin packages", "Install skills and bundled MCP components", "Manage plugin lifecycle independently from MCP"],
  tasks:''',
    '''  plugins: ["Explore declarative plugin packages", "Install skills and bundled MCP components", "Manage plugin lifecycle independently from MCP"],
  harness: ["Inspect durable runs and recovery state", "Review ordered safe events and jobs", "Resolve exact one-shot approvals"],
  tasks:''',
)
replace_once(
    "desktop/src/renderer/App.tsx",
    '''  const implementedRoute = route === "workspaces" || route === "mcp" || route === "plugins" || route === "connections" || route === "settings" || route === "diagnostics" || route === "intelligence" || route === "tasks" || route === "pull-requests";
''',
    '''  const implementedRoute = route === "workspaces" || route === "mcp" || route === "plugins" || route === "harness" || route === "connections" || route === "settings" || route === "diagnostics" || route === "intelligence" || route === "tasks" || route === "pull-requests";
''',
)
replace_once(
    "desktop/src/renderer/App.tsx",
    ''': route === "plugins" ? <PluginHubScreen />
            : route === "tasks"''',
    ''': route === "plugins" ? <PluginHubScreen />
            : route === "harness" ? <HarnessScreen />
            : route === "tasks"''',
)
