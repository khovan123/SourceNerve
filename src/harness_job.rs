use std::time::{Duration, Instant};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, Transaction};
use tokio::time::sleep;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    harness::{self, HarnessRunIdRequest, HarnessRunSnapshot},
    job_ingress::JobTaskStatus,
    service::AppState,
    task_lifecycle::{self, TaskLifecycleView},
    task_transactions::{self, TaskBeginRequest, TaskIdRequest},
};

const MAX_CLIENT_REQUEST_ID_BYTES: usize = 96;
const MAX_JOB_ID_BYTES: usize = 64;
const DEFAULT_WAIT_TIMEOUT_MS: u64 = 5_000;
const MAX_WAIT_TIMEOUT_MS: u64 = 30_000;
const WAIT_POLL_MS: u64 = 100;
const MAX_JOB_LIST_LIMIT: usize = 100;
const DEFAULT_JOB_LIST_LIMIT: usize = 50;

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessJobOperation {
    Start,
    Get,
    Wait,
    Cancel,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
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

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessJobView {
    pub id: String,
    pub run_id: String,
    pub workspace: String,
    pub kind: String,
    pub task_id: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
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

#[derive(Debug, Clone)]
struct HarnessJobRow {
    id: String,
    request_fingerprint: String,
    workspace: String,
    task_id: Option<String>,
    run_id: String,
    kind: String,
    created_at: i64,
    updated_at: i64,
}

type HarnessJobDbRow = (
    String,
    String,
    String,
    Option<String>,
    String,
    String,
    Option<String>,
    String,
    i64,
    i64,
);

#[derive(Debug, Clone)]
struct MaterializedJob {
    job: HarnessJobView,
    task: Option<JobTaskStatus>,
    lifecycle: Option<TaskLifecycleView>,
}

fn sha256(input: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(input.as_ref()))
}

fn validate_client_request_id(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > MAX_CLIENT_REQUEST_ID_BYTES
        || !value.is_ascii()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(AppError::InvalidRequest(format!(
            "client_request_id must be 1-{MAX_CLIENT_REQUEST_ID_BYTES} ASCII bytes using letters, digits, '-', '_', '.', or ':'"
        )));
    }
    Ok(())
}

fn validate_job_id(value: &str) -> AppResult<()> {
    if value.is_empty() || value.len() > MAX_JOB_ID_BYTES || !value.is_ascii() {
        return Err(AppError::InvalidRequest("invalid harness job_id".into()));
    }
    Ok(())
}

fn request_fingerprint(req: &HarnessJobCallRequest) -> AppResult<String> {
    let bytes = serde_json::to_vec(&(
        "task",
        &req.context_query,
        req.context_max_bytes,
        req.context_max_items,
    ))
    .map_err(anyhow::Error::from)?;
    Ok(sha256(bytes))
}

fn task_request_id(run_id: &str, principal_id: &str, client_request_id: &str) -> String {
    let digest = sha256(
        serde_json::to_vec(&(run_id, principal_id, client_request_id))
            .expect("Harness job task request fingerprint is serializable"),
    );
    format!("harness-job:{digest}")
}

fn from_db(row: HarnessJobDbRow) -> HarnessJobRow {
    HarnessJobRow {
        id: row.0,
        request_fingerprint: row.1,
        workspace: row.2,
        task_id: row.3,
        run_id: row.4,
        kind: row.7,
        created_at: row.8,
        updated_at: row.9,
    }
}

async fn owned_run(
    state: &AppState,
    run_id: &str,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessRunSnapshot> {
    harness::get(
        state,
        HarnessRunIdRequest {
            run_id: run_id.to_string(),
        },
        principal_id,
        operator,
    )
    .await
}

async fn load_by_request(
    state: &AppState,
    run_id: &str,
    principal_id: &str,
    client_request_id: &str,
) -> AppResult<Option<HarnessJobRow>> {
    let row: Option<HarnessJobDbRow> = sqlx::query_as(
        "SELECT id, request_fingerprint, workspace_id, task_id, harness_run_id, principal_id, \
                harness_request_id, kind, created_at, updated_at \
         FROM jobs \
         WHERE harness_run_id=?1 AND principal_id=?2 AND harness_request_id=?3",
    )
    .bind(run_id)
    .bind(principal_id)
    .bind(client_request_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(from_db))
}

async fn load_owned_job(
    state: &AppState,
    run_id: &str,
    principal_id: &str,
    job_id: &str,
) -> AppResult<HarnessJobRow> {
    validate_job_id(job_id)?;
    let row: Option<HarnessJobDbRow> = sqlx::query_as(
        "SELECT id, request_fingerprint, workspace_id, task_id, harness_run_id, principal_id, \
                harness_request_id, kind, created_at, updated_at \
         FROM jobs \
         WHERE id=?1 AND harness_run_id=?2 AND principal_id=?3",
    )
    .bind(job_id)
    .bind(run_id)
    .bind(principal_id)
    .fetch_optional(&state.db)
    .await?;
    row.map(from_db)
        .ok_or_else(|| AppError::InvalidRequest(format!("harness job not found: {job_id}")))
}

async fn append_harness_event_tx(
    tx: &mut Transaction<'_, Sqlite>,
    run_id: &str,
    event_type: &str,
    payload: &serde_json::Value,
) -> AppResult<()> {
    let payload_json = serde_json::to_string(payload).map_err(anyhow::Error::from)?;
    let seq: i64 = sqlx::query_scalar(
        "UPDATE harness_runs SET next_event_seq=next_event_seq+1, updated_at=unixepoch() \
         WHERE id=?1 RETURNING next_event_seq-1",
    )
    .bind(run_id)
    .fetch_one(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO harness_events(run_id, seq, event_type, payload_json, created_at) \
         VALUES(?1, ?2, ?3, ?4, unixepoch())",
    )
    .bind(run_id)
    .bind(seq)
    .bind(event_type)
    .bind(payload_json)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn derived_status(task_status: &str, lifecycle_phase: &str) -> &'static str {
    match (task_status, lifecycle_phase) {
        ("cancelled", _) => "cancelled",
        ("stale", _) => "stale",
        (_, "completed") => "completed",
        _ => "active",
    }
}

fn terminal_event(status: &str) -> Option<(&'static str, &'static str, Option<&'static str>)> {
    match status {
        "completed" => Some(("job_completed", "job/completed", None)),
        "cancelled" => Some(("job_cancelled", "job/cancelled", None)),
        "stale" => Some(("job_failed", "job/failed", Some("task_stale"))),
        _ => None,
    }
}

fn is_terminal(status: &str) -> bool {
    terminal_event(status).is_some()
}

async fn reconcile_terminal(state: &AppState, row: &HarnessJobRow, status: &str) -> AppResult<()> {
    let Some((job_event, harness_event, reason)) = terminal_event(status) else {
        return Ok(());
    };
    let mut tx = state.db.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO job_events(job_id, event_type, metadata_json, created_at) \
         SELECT ?1, ?2, ?3, unixepoch() \
         WHERE NOT EXISTS (\
             SELECT 1 FROM job_events \
             WHERE job_id=?1 AND event_type IN ('job_completed', 'job_cancelled', 'job_failed')\
         )",
    )
    .bind(&row.id)
    .bind(job_event)
    .bind(
        serde_json::to_string(&serde_json::json!({
            "kind": row.kind,
            "reason": reason,
        }))
        .map_err(anyhow::Error::from)?,
    )
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    if inserted {
        sqlx::query("UPDATE jobs SET updated_at=unixepoch() WHERE id=?1")
            .bind(&row.id)
            .execute(&mut *tx)
            .await?;
        append_harness_event_tx(
            &mut tx,
            &row.run_id,
            harness_event,
            &serde_json::json!({
                "job_id": row.id,
                "kind": row.kind,
                "task_id": row.task_id,
                "reason": reason,
            }),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn materialize(state: &AppState, row: HarnessJobRow) -> AppResult<MaterializedJob> {
    let Some(task_id) = row.task_id.as_deref() else {
        return Ok(MaterializedJob {
            job: HarnessJobView {
                id: row.id,
                run_id: row.run_id,
                workspace: row.workspace,
                kind: row.kind,
                task_id: None,
                status: "pending".into(),
                created_at: row.created_at,
                updated_at: row.updated_at,
            },
            task: None,
            lifecycle: None,
        });
    };

    let snapshot = task_transactions::get(
        state,
        TaskIdRequest {
            task_id: task_id.to_string(),
        },
    )
    .await?;
    let lifecycle = task_lifecycle::load_view(state, task_id).await?;
    let status = derived_status(&snapshot.task.status, &lifecycle.phase).to_string();
    let updated_at = row
        .updated_at
        .max(snapshot.task.updated_at)
        .max(lifecycle.updated_at);
    let task = JobTaskStatus {
        id: snapshot.task.id,
        status: snapshot.task.status,
        base_head: snapshot.task.base_head,
        graph_version: snapshot.task.graph_version,
        stale_reason: snapshot.task.stale_reason,
        updated_at: snapshot.task.updated_at,
    };

    reconcile_terminal(state, &row, &status).await?;
    let persisted_updated_at: i64 = sqlx::query_scalar("SELECT updated_at FROM jobs WHERE id=?1")
        .bind(&row.id)
        .fetch_one(&state.db)
        .await?;

    Ok(MaterializedJob {
        job: HarnessJobView {
            id: row.id,
            run_id: row.run_id,
            workspace: row.workspace,
            kind: row.kind,
            task_id: Some(task.id.clone()),
            status,
            created_at: row.created_at,
            updated_at: updated_at.max(persisted_updated_at),
        },
        task: Some(task),
        lifecycle: Some(lifecycle),
    })
}

fn result(current: MaterializedJob, replayed: bool, timed_out: bool) -> HarnessJobCallResult {
    HarnessJobCallResult {
        job: current.job,
        task: current.task,
        lifecycle: current.lifecycle,
        replayed,
        timed_out,
    }
}

async fn start(
    state: &AppState,
    req: HarnessJobCallRequest,
    run: HarnessRunSnapshot,
) -> AppResult<HarnessJobCallResult> {
    if req.job_id.is_some() || req.wait_timeout_ms.is_some() {
        return Err(AppError::InvalidRequest(
            "harness job start does not accept job_id or wait_timeout_ms".into(),
        ));
    }
    let client_request_id = req.client_request_id.as_deref().ok_or_else(|| {
        AppError::InvalidRequest("harness job start requires client_request_id".into())
    })?;
    validate_client_request_id(client_request_id)?;
    let fingerprint = request_fingerprint(&req)?;
    let run_principal_id = run.run.principal_id.clone();

    if let Some(existing) =
        load_by_request(state, &run.run.id, &run_principal_id, client_request_id).await?
    {
        if existing.request_fingerprint != fingerprint {
            return Err(AppError::InvalidRequest(
                "client_request_id already exists with a different Harness job request".into(),
            ));
        }
        return Ok(result(materialize(state, existing).await?, true, false));
    }

    if run.run.status != "running" || run.freshness.state != "current" {
        return Err(AppError::InvalidRequest(format!(
            "harness run {} is not current and running",
            run.run.id
        )));
    }

    let begun = task_transactions::begin(
        state,
        TaskBeginRequest {
            workspace: run.run.workspace.clone(),
            client_request_id: Some(task_request_id(
                &run.run.id,
                &run_principal_id,
                client_request_id,
            )),
            context_query: req.context_query,
            context_max_bytes: req.context_max_bytes,
            context_max_items: req.context_max_items,
        },
    )
    .await?;

    let job_id = Uuid::new_v4().to_string();
    let internal_request_id = format!("harness:{job_id}");
    let mut tx = state.db.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO jobs(\
            id, ingress, client_request_id, request_fingerprint, workspace_id, task_id, \
            harness_run_id, principal_id, harness_request_id, kind, created_at, updated_at\
         ) VALUES(?1, 'webhook', ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'task', unixepoch(), unixepoch()) \
         ON CONFLICT DO NOTHING",
    )
    .bind(&job_id)
    .bind(&internal_request_id)
    .bind(&fingerprint)
    .bind(&run.run.workspace)
    .bind(&begun.task.id)
    .bind(&run.run.id)
    .bind(&run_principal_id)
    .bind(client_request_id)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    if inserted {
        sqlx::query(
            "INSERT INTO job_events(job_id, event_type, metadata_json, created_at) \
             VALUES(?1, 'job_started', ?2, unixepoch())",
        )
        .bind(&job_id)
        .bind(
            serde_json::to_string(&serde_json::json!({ "kind": "task" }))
                .map_err(anyhow::Error::from)?,
        )
        .execute(&mut *tx)
        .await?;
        append_harness_event_tx(
            &mut tx,
            &run.run.id,
            "job/started",
            &serde_json::json!({
                "job_id": job_id,
                "kind": "task",
                "task_id": begun.task.id,
            }),
        )
        .await?;
    }
    tx.commit().await?;

    let stored = load_by_request(state, &run.run.id, &run_principal_id, client_request_id)
        .await?
        .ok_or_else(|| {
            AppError::Internal(anyhow::anyhow!("Harness job reservation disappeared"))
        })?;
    if stored.request_fingerprint != fingerprint {
        return Err(AppError::InvalidRequest(
            "client_request_id already exists with a different Harness job request".into(),
        ));
    }
    Ok(result(
        materialize(state, stored).await?,
        !inserted || begun.replayed,
        false,
    ))
}

async fn get_owned(
    state: &AppState,
    req: &HarnessJobCallRequest,
    run: &HarnessRunSnapshot,
) -> AppResult<MaterializedJob> {
    let job_id = req
        .job_id
        .as_deref()
        .ok_or_else(|| AppError::InvalidRequest("harness job operation requires job_id".into()))?;
    let row = load_owned_job(state, &run.run.id, &run.run.principal_id, job_id).await?;
    if row.workspace != run.run.workspace {
        return Err(AppError::InvalidRequest(format!(
            "harness job not found: {job_id}"
        )));
    }
    materialize(state, row).await
}

fn reject_start_payload(req: &HarnessJobCallRequest) -> AppResult<()> {
    if req.client_request_id.is_some()
        || req.context_query.is_some()
        || req.context_max_bytes.is_some()
        || req.context_max_items.is_some()
    {
        return Err(AppError::InvalidRequest(
            "this harness job operation does not accept start payload fields".into(),
        ));
    }
    Ok(())
}

async fn get(
    state: &AppState,
    req: HarnessJobCallRequest,
    run: HarnessRunSnapshot,
) -> AppResult<HarnessJobCallResult> {
    reject_start_payload(&req)?;
    if req.wait_timeout_ms.is_some() {
        return Err(AppError::InvalidRequest(
            "harness job get does not accept wait_timeout_ms".into(),
        ));
    }
    Ok(result(get_owned(state, &req, &run).await?, false, false))
}

async fn wait(
    state: &AppState,
    req: HarnessJobCallRequest,
    run: HarnessRunSnapshot,
) -> AppResult<HarnessJobCallResult> {
    reject_start_payload(&req)?;
    let timeout_ms = req.wait_timeout_ms.unwrap_or(DEFAULT_WAIT_TIMEOUT_MS);
    if timeout_ms > MAX_WAIT_TIMEOUT_MS {
        return Err(AppError::InvalidRequest(format!(
            "wait_timeout_ms must be between 0 and {MAX_WAIT_TIMEOUT_MS}"
        )));
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let current = get_owned(state, &req, &run).await?;
        if is_terminal(&current.job.status) {
            return Ok(result(current, false, false));
        }
        if Instant::now() >= deadline {
            return Ok(result(current, false, true));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        sleep(remaining.min(Duration::from_millis(WAIT_POLL_MS))).await;
    }
}

async fn cancel(
    state: &AppState,
    req: HarnessJobCallRequest,
    run: HarnessRunSnapshot,
) -> AppResult<HarnessJobCallResult> {
    reject_start_payload(&req)?;
    if req.wait_timeout_ms.is_some() {
        return Err(AppError::InvalidRequest(
            "harness job cancel does not accept wait_timeout_ms".into(),
        ));
    }
    let current = get_owned(state, &req, &run).await?;
    if is_terminal(&current.job.status) {
        return Ok(result(current, false, false));
    }
    let task_id = current.job.task_id.clone().ok_or_else(|| {
        AppError::InvalidRequest("Harness job has no linked task to cancel".into())
    })?;
    task_transactions::cancel(state, TaskIdRequest { task_id }).await?;
    Ok(result(get_owned(state, &req, &run).await?, false, false))
}

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

pub async fn call(
    state: &AppState,
    req: HarnessJobCallRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessJobCallResult> {
    if req.run_id.is_empty() || req.run_id.len() > 128 || !req.run_id.is_ascii() {
        return Err(AppError::InvalidRequest("invalid harness run_id".into()));
    }
    let run = owned_run(state, &req.run_id, principal_id, operator).await?;
    match req.operation {
        HarnessJobOperation::Start => start(state, req, run).await,
        HarnessJobOperation::Get => get(state, req, run).await,
        HarnessJobOperation::Wait => wait(state, req, run).await,
        HarnessJobOperation::Cancel => cancel(state, req, run).await,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        process::Command,
        sync::Arc,
    };

    use tempfile::TempDir;
    use tokio::sync::Mutex;

    use super::*;
    use crate::{
        config::WorkspaceConfig,
        db,
        harness::HarnessRunBeginRequest,
        job_ingress::{self, JobGetRequest},
        memory,
        workspace::WorkspaceRegistry,
    };

    fn run_git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .expect("run git fixture command");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    async fn build_state(repo: &Path, state_dir: &Path) -> AppState {
        let registry = WorkspaceRegistry::build(&[WorkspaceConfig {
            id: "job".into(),
            name: "Harness Job Fixture".into(),
            root: repo.to_path_buf(),
            access: "read-write".into(),
            remote: "origin".into(),
            default_branch: "main".into(),
            provider: None,
            repository: None,
            github_repository: None,
        }])
        .expect("build workspace registry");
        let pool = db::connect(state_dir).await.expect("connect job db");
        db::register_workspaces(&pool, &registry)
            .await
            .expect("register workspace");
        AppState {
            workspaces: registry,
            db: pool,
            mutation_lock: Arc::new(Mutex::new(())),
            github_token: None,
        }
    }

    async fn fixture() -> (TempDir, PathBuf, PathBuf, AppState) {
        let root = tempfile::tempdir().expect("Harness job fixture tempdir");
        let repo = root.path().join("repo");
        let state_dir = root.path().join("state");
        std::fs::create_dir_all(repo.join("src")).expect("create source directory");
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "user.name", "SourceNerve Test"]);
        run_git(
            &repo,
            &["config", "user.email", "sourcenerve@example.invalid"],
        );
        std::fs::write(repo.join("src/lib.rs"), "pub fn baseline() -> u32 { 1 }\n")
            .expect("write baseline source");
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "-m", "Harness job fixture"]);
        let state = build_state(&repo, &state_dir).await;
        memory::index_workspace(&state, "job")
            .await
            .expect("index workspace");
        (root, repo, state_dir, state)
    }

    async fn begin_run(state: &AppState, principal: &str, key: &str) -> HarnessRunSnapshot {
        harness::begin(
            state,
            HarnessRunBeginRequest {
                workspace: "job".into(),
                profile: "interactive-local".into(),
                sandbox: None,
                client_request_id: Some(key.into()),
                parent_run_id: None,
                capability_ids: None,
            },
            principal,
            false,
        )
        .await
        .expect("begin Harness run")
        .snapshot
    }

    fn start_request(
        run_id: &str,
        key: &str,
        context_query: Option<&str>,
    ) -> HarnessJobCallRequest {
        HarnessJobCallRequest {
            run_id: run_id.into(),
            operation: HarnessJobOperation::Start,
            job_id: None,
            client_request_id: Some(key.into()),
            context_query: context_query.map(str::to_string),
            context_max_bytes: Some(4096),
            context_max_items: Some(10),
            wait_timeout_ms: None,
        }
    }

    fn job_request(
        run_id: &str,
        operation: HarnessJobOperation,
        job_id: &str,
    ) -> HarnessJobCallRequest {
        HarnessJobCallRequest {
            run_id: run_id.into(),
            operation,
            job_id: Some(job_id.into()),
            client_request_id: None,
            context_query: None,
            context_max_bytes: None,
            context_max_items: None,
            wait_timeout_ms: None,
        }
    }

    #[test]
    fn terminal_mapping_is_stable_and_conservative() {
        assert_eq!(
            terminal_event("completed").map(|value| value.1),
            Some("job/completed")
        );
        assert_eq!(
            terminal_event("cancelled").map(|value| value.1),
            Some("job/cancelled")
        );
        assert_eq!(
            terminal_event("stale").map(|value| value.1),
            Some("job/failed")
        );
        assert!(terminal_event("active").is_none());
    }

    #[tokio::test]
    async fn harness_job_is_scoped_restart_safe_and_hidden_from_legacy_get() {
        let (_root, repo, state_dir, state) = fixture().await;
        let run = begin_run(&state, "principal-a", "run:a").await;
        let created = call(
            &state,
            start_request(&run.run.id, "job:a", Some("baseline")),
            "principal-a",
            false,
        )
        .await
        .expect("start Harness job");
        assert!(!created.replayed);
        assert_eq!(created.job.status, "active");
        assert_eq!(created.job.run_id, run.run.id);

        let replay = call(
            &state,
            start_request(&run.run.id, "job:a", Some("baseline")),
            "principal-a",
            false,
        )
        .await
        .expect("replay Harness job");
        assert!(replay.replayed);
        assert_eq!(replay.job.id, created.job.id);

        let conflict = call(
            &state,
            start_request(&run.run.id, "job:a", Some("changed context")),
            "principal-a",
            false,
        )
        .await
        .expect_err("changed idempotent request must fail");
        assert!(
            conflict
                .to_string()
                .contains("different Harness job request")
        );

        let legacy = job_ingress::get(
            &state,
            JobGetRequest {
                job_id: created.job.id.clone(),
            },
        )
        .await
        .expect_err("legacy webhook job_get must hide Harness-owned rows");
        assert!(legacy.to_string().contains("job not found"));

        let restarted = build_state(&repo, &state_dir).await;
        let after_restart = call(
            &restarted,
            job_request(&run.run.id, HarnessJobOperation::Get, &created.job.id),
            "principal-a",
            false,
        )
        .await
        .expect("get Harness job after restart");
        assert_eq!(after_restart.job.id, created.job.id);
        assert_eq!(after_restart.job.status, "active");

        let wrong_principal = call(
            &restarted,
            job_request(&run.run.id, HarnessJobOperation::Get, &created.job.id),
            "principal-b",
            false,
        )
        .await
        .expect_err("cross-principal access must fail closed");
        assert!(
            wrong_principal
                .to_string()
                .contains("harness run not found")
        );

        let other_run = begin_run(&restarted, "principal-a", "run:b").await;
        let wrong_run = call(
            &restarted,
            job_request(&other_run.run.id, HarnessJobOperation::Get, &created.job.id),
            "principal-a",
            false,
        )
        .await
        .expect_err("cross-run access must fail closed");
        assert!(wrong_run.to_string().contains("harness job not found"));
    }

    #[tokio::test]
    async fn harness_job_events_do_not_enqueue_legacy_job_callbacks() {
        let (_root, _repo, _state_dir, state) = fixture().await;
        sqlx::query(
            "UPDATE callback_runtime_state SET enabled=1, updated_at=unixepoch() WHERE id=1",
        )
        .execute(&state.db)
        .await
        .expect("enable callback runtime");

        let run = begin_run(&state, "principal-a", "run:callback-isolation").await;
        let created = call(
            &state,
            start_request(&run.run.id, "job:callback-isolation", None),
            "principal-a",
            false,
        )
        .await
        .expect("start Harness job");
        let cancelled = call(
            &state,
            job_request(&run.run.id, HarnessJobOperation::Cancel, &created.job.id),
            "principal-a",
            false,
        )
        .await
        .expect("cancel Harness job");
        assert_eq!(cancelled.job.status, "cancelled");

        let persisted_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM job_events WHERE job_id=?1 AND event_type IN ('job_started', 'job_cancelled')",
        )
        .bind(&created.job.id)
        .fetch_one(&state.db)
        .await
        .expect("count Harness job events");
        assert_eq!(persisted_events, 2);

        let legacy_job_callbacks: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM callback_outbox WHERE source_kind='job_event' AND job_id=?1",
        )
        .bind(&created.job.id)
        .fetch_one(&state.db)
        .await
        .expect("count legacy job callbacks");
        assert_eq!(legacy_job_callbacks, 0);
    }

    #[tokio::test]
    async fn wait_timeout_does_not_cancel_and_cancel_emits_terminal_once() {
        let (_root, _repo, _state_dir, state) = fixture().await;
        let run = begin_run(&state, "principal-a", "run:cancel").await;
        let created = call(
            &state,
            start_request(&run.run.id, "job:cancel", None),
            "principal-a",
            false,
        )
        .await
        .expect("start Harness job");

        let mut wait_request = job_request(&run.run.id, HarnessJobOperation::Wait, &created.job.id);
        wait_request.wait_timeout_ms = Some(0);
        let waited = call(&state, wait_request, "principal-a", false)
            .await
            .expect("bounded wait");
        assert!(waited.timed_out);
        assert_eq!(waited.job.status, "active");

        let cancelled = call(
            &state,
            job_request(&run.run.id, HarnessJobOperation::Cancel, &created.job.id),
            "principal-a",
            false,
        )
        .await
        .expect("cancel Harness job");
        assert_eq!(cancelled.job.status, "cancelled");
        assert!(!cancelled.timed_out);

        let cancelled_again = call(
            &state,
            job_request(&run.run.id, HarnessJobOperation::Cancel, &created.job.id),
            "principal-a",
            false,
        )
        .await
        .expect("idempotent cancel");
        assert_eq!(cancelled_again.job.status, "cancelled");

        let terminal_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM job_events \
             WHERE job_id=?1 AND event_type IN ('job_completed', 'job_cancelled', 'job_failed')",
        )
        .bind(&created.job.id)
        .fetch_one(&state.db)
        .await
        .expect("count terminal job events");
        assert_eq!(terminal_events, 1);

        let harness_terminal_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM harness_events \
             WHERE run_id=?1 AND event_type='job/cancelled' AND payload_json LIKE ?2",
        )
        .bind(&run.run.id)
        .bind(format!("%{}%", created.job.id))
        .fetch_one(&state.db)
        .await
        .expect("count Harness terminal events");
        assert_eq!(harness_terminal_events, 1);

        let task_status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id=?1")
            .bind(cancelled.job.task_id.as_deref().expect("task id"))
            .fetch_one(&state.db)
            .await
            .expect("task status");
        assert_eq!(task_status, "cancelled");
    }
}
