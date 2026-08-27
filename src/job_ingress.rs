use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[path = "harness_job.rs"]
pub mod harness_job;

use crate::{
    error::{AppError, AppResult},
    github_webhook::{self, GitHubObservationSummary},
    service::AppState,
    task_lifecycle::{self, TaskLifecycleView},
    task_transactions::{self, TaskBeginRequest, TaskIdRequest},
};

const MAX_CLIENT_REQUEST_ID_BYTES: usize = 96;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct JobSubmitRequest {
    pub client_request_id: String,
    pub workspace: String,
    pub context_query: Option<String>,
    pub context_max_bytes: Option<usize>,
    pub context_max_items: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct JobGetRequest {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct JobView {
    pub id: String,
    pub client_request_id: String,
    pub workspace: String,
    pub task_id: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct JobTaskStatus {
    pub id: String,
    pub status: String,
    pub base_head: String,
    pub graph_version: i64,
    pub stale_reason: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct JobGetResult {
    pub job: JobView,
    pub task: Option<JobTaskStatus>,
    pub lifecycle: Option<TaskLifecycleView>,
    pub github_observation: Option<GitHubObservationSummary>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct JobSubmitResult {
    pub job: JobView,
    pub task: Option<JobTaskStatus>,
    pub lifecycle: Option<TaskLifecycleView>,
    pub github_observation: Option<GitHubObservationSummary>,
    pub replayed: bool,
}

#[derive(Debug, Clone)]
struct JobRow {
    id: String,
    client_request_id: String,
    request_fingerprint: String,
    workspace: String,
    task_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

type JobDbRow = (String, String, String, String, Option<String>, i64, i64);

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

fn request_fingerprint(req: &JobSubmitRequest) -> AppResult<String> {
    let payload = serde_json::to_vec(&(
        &req.workspace,
        &req.context_query,
        req.context_max_bytes,
        req.context_max_items,
    ))
    .map_err(anyhow::Error::from)?;
    Ok(sha256(payload))
}

fn from_row(row: JobDbRow) -> JobRow {
    JobRow {
        id: row.0,
        client_request_id: row.1,
        request_fingerprint: row.2,
        workspace: row.3,
        task_id: row.4,
        created_at: row.5,
        updated_at: row.6,
    }
}

async fn load_by_client_request_id(
    state: &AppState,
    client_request_id: &str,
) -> AppResult<Option<JobRow>> {
    let row: Option<JobDbRow> = sqlx::query_as(
        "SELECT id, client_request_id, request_fingerprint, workspace_id, task_id, created_at, updated_at \
         FROM jobs WHERE ingress='webhook' AND harness_run_id IS NULL AND client_request_id=?1",
    )
    .bind(client_request_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(from_row))
}

async fn load_by_id(state: &AppState, job_id: &str) -> AppResult<JobRow> {
    let row: Option<JobDbRow> = sqlx::query_as(
        "SELECT id, client_request_id, request_fingerprint, workspace_id, task_id, created_at, updated_at \
         FROM jobs WHERE id=?1 AND ingress='webhook' AND harness_run_id IS NULL",
    )
    .bind(job_id)
    .fetch_optional(&state.db)
    .await?;
    row.map(from_row)
        .ok_or_else(|| AppError::InvalidRequest(format!("job not found: {job_id}")))
}

async fn reserve(
    state: &AppState,
    req: &JobSubmitRequest,
    fingerprint: &str,
) -> AppResult<(JobRow, bool)> {
    if let Some(existing) = load_by_client_request_id(state, &req.client_request_id).await? {
        if existing.request_fingerprint != fingerprint {
            return Err(AppError::InvalidRequest(
                "client_request_id already exists with a different webhook job request".into(),
            ));
        }
        return Ok((existing, false));
    }

    let job_id = Uuid::new_v4().to_string();
    let mut tx = state.db.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO jobs(\
            id, ingress, client_request_id, request_fingerprint, workspace_id, task_id, created_at, updated_at\
         ) VALUES(?1, 'webhook', ?2, ?3, ?4, NULL, unixepoch(), unixepoch()) \
         ON CONFLICT(ingress, client_request_id) DO NOTHING",
    )
    .bind(&job_id)
    .bind(&req.client_request_id)
    .bind(fingerprint)
    .bind(&req.workspace)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;

    if inserted {
        sqlx::query(
            "INSERT INTO job_events(job_id, event_type, metadata_json, created_at) \
             VALUES(?1, 'job_reserved', ?2, unixepoch())",
        )
        .bind(&job_id)
        .bind(
            serde_json::to_string(&serde_json::json!({ "workspace": &req.workspace }))
                .map_err(anyhow::Error::from)?,
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let row = load_by_client_request_id(state, &req.client_request_id)
        .await?
        .ok_or_else(|| {
            AppError::Internal(anyhow::anyhow!("webhook job reservation disappeared"))
        })?;
    if row.request_fingerprint != fingerprint {
        return Err(AppError::InvalidRequest(
            "client_request_id already exists with a different webhook job request".into(),
        ));
    }
    Ok((row, inserted))
}

async fn link_task(state: &AppState, job: &JobRow, task_id: &str) -> AppResult<JobRow> {
    if let Some(existing) = job.task_id.as_deref() {
        if existing != task_id {
            return Err(AppError::InvalidRequest(
                "webhook job is already linked to a different durable task".into(),
            ));
        }
        return load_by_id(state, &job.id).await;
    }

    let mut tx = state.db.begin().await?;
    let linked = sqlx::query(
        "UPDATE jobs SET task_id=?1, updated_at=unixepoch() WHERE id=?2 AND task_id IS NULL",
    )
    .bind(task_id)
    .bind(&job.id)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    if linked {
        sqlx::query(
            "INSERT INTO job_events(job_id, event_type, metadata_json, created_at) \
             VALUES(?1, 'task_linked', ?2, unixepoch())",
        )
        .bind(&job.id)
        .bind(
            serde_json::to_string(&serde_json::json!({ "task_id": task_id }))
                .map_err(anyhow::Error::from)?,
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let linked_job = load_by_id(state, &job.id).await?;
    if linked_job.task_id.as_deref() != Some(task_id) {
        return Err(AppError::InvalidRequest(
            "webhook job task linkage changed concurrently".into(),
        ));
    }
    Ok(linked_job)
}

fn derived_status(task_status: Option<&str>, lifecycle_phase: Option<&str>) -> String {
    match (task_status, lifecycle_phase) {
        (None, _) => "pending".into(),
        (Some("cancelled"), _) => "cancelled".into(),
        (Some("stale"), _) => "stale".into(),
        (_, Some("completed")) => "completed".into(),
        _ => "active".into(),
    }
}

async fn materialize(state: &AppState, row: JobRow) -> AppResult<JobGetResult> {
    let Some(task_id) = row.task_id.as_deref() else {
        return Ok(JobGetResult {
            job: JobView {
                id: row.id,
                client_request_id: row.client_request_id,
                workspace: row.workspace,
                task_id: None,
                status: "pending".into(),
                created_at: row.created_at,
                updated_at: row.updated_at,
            },
            task: None,
            lifecycle: None,
            github_observation: None,
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
    let github_observation = github_webhook::summary_for_task(state, task_id).await?;
    let observation_updated_at = github_observation
        .as_ref()
        .map(|value| value.updated_at)
        .unwrap_or(0);
    let updated_at = row
        .updated_at
        .max(snapshot.task.updated_at)
        .max(lifecycle.updated_at)
        .max(observation_updated_at);
    let status = derived_status(Some(&snapshot.task.status), Some(&lifecycle.phase));
    let task = JobTaskStatus {
        id: snapshot.task.id,
        status: snapshot.task.status,
        base_head: snapshot.task.base_head,
        graph_version: snapshot.task.graph_version,
        stale_reason: snapshot.task.stale_reason,
        updated_at: snapshot.task.updated_at,
    };

    Ok(JobGetResult {
        job: JobView {
            id: row.id,
            client_request_id: row.client_request_id,
            workspace: row.workspace,
            task_id: Some(task.id.clone()),
            status,
            created_at: row.created_at,
            updated_at,
        },
        task: Some(task),
        lifecycle: Some(lifecycle),
        github_observation,
    })
}

pub async fn submit(state: &AppState, req: JobSubmitRequest) -> AppResult<JobSubmitResult> {
    validate_client_request_id(&req.client_request_id)?;
    state.workspaces.get(&req.workspace)?;
    let fingerprint = request_fingerprint(&req)?;
    let (reserved, inserted) = reserve(state, &req, &fingerprint).await?;

    if reserved.task_id.is_some() {
        let current = materialize(state, reserved).await?;
        return Ok(JobSubmitResult {
            job: current.job,
            task: current.task,
            lifecycle: current.lifecycle,
            github_observation: current.github_observation,
            replayed: true,
        });
    }

    let begun = task_transactions::begin(
        state,
        TaskBeginRequest {
            workspace: req.workspace,
            client_request_id: Some(format!("webhook-job:{}", reserved.id)),
            context_query: req.context_query,
            context_max_bytes: req.context_max_bytes,
            context_max_items: req.context_max_items,
        },
    )
    .await?;
    let linked = link_task(state, &reserved, &begun.task.id).await?;
    let current = materialize(state, linked).await?;
    Ok(JobSubmitResult {
        job: current.job,
        task: current.task,
        lifecycle: current.lifecycle,
        github_observation: current.github_observation,
        replayed: !inserted || begun.replayed,
    })
}

pub async fn get(state: &AppState, req: JobGetRequest) -> AppResult<JobGetResult> {
    if req.job_id.is_empty() || req.job_id.len() > 64 || !req.job_id.is_ascii() {
        return Err(AppError::InvalidRequest("invalid job_id".into()));
    }
    materialize(state, load_by_id(state, &req.job_id).await?).await
}
