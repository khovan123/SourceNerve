use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

use crate::{
    context::{self, ContextPack, ContextPackRequest},
    error::{AppError, AppResult},
    git,
    service::{AppState, FileExpectation, PatchRequest},
};

const DEFAULT_CONTEXT_BYTES: usize = 64 * 1024;
const DEFAULT_CONTEXT_ITEMS: usize = 20;
const MAX_CONTEXT_QUERY_BYTES: usize = 16 * 1024;
const MAX_KEY_BYTES: usize = 128;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskBeginRequest {
    pub workspace: String,
    pub client_request_id: Option<String>,
    pub context_query: Option<String>,
    pub context_max_bytes: Option<usize>,
    pub context_max_items: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskIdRequest {
    pub task_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskProposePatchRequest {
    pub task_id: String,
    pub idempotency_key: Option<String>,
    pub expected_files: Vec<FileExpectation>,
    pub patch: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskApplyPatchRequest {
    pub task_id: String,
    pub proposal_id: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TaskView {
    pub id: String,
    pub workspace: String,
    pub client_request_id: Option<String>,
    pub base_head: String,
    pub graph_version: i64,
    pub status: String,
    pub context_query: Option<String>,
    pub context_sha256: Option<String>,
    pub stale_reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TaskProposalView {
    pub id: String,
    pub task_id: String,
    pub idempotency_key: Option<String>,
    pub expected_head: String,
    pub patch_sha256: String,
    pub changed_paths: Vec<String>,
    pub status: String,
    pub changeset_id: Option<String>,
    pub created_at: i64,
    pub applied_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TaskEventView {
    pub id: i64,
    pub event_type: String,
    pub metadata: serde_json::Value,
    pub created_at: i64,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TaskSnapshot {
    pub task: TaskView,
    pub proposals: Vec<TaskProposalView>,
    pub events: Vec<TaskEventView>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TaskBeginResult {
    pub task: TaskView,
    pub context: Option<ContextPack>,
    pub replayed: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TaskProposalResult {
    pub proposal: TaskProposalView,
    pub replayed: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TaskApplyResult {
    pub task_id: String,
    pub proposal_id: String,
    pub changeset_id: String,
    pub head: String,
    pub changed_paths: Vec<String>,
    pub diff: String,
}

#[derive(Debug, Clone)]
struct TaskRow {
    id: String,
    workspace: String,
    client_request_id: Option<String>,
    request_fingerprint: String,
    base_head: String,
    graph_version: i64,
    status: String,
    context_query: Option<String>,
    context_sha256: Option<String>,
    stale_reason: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct ProposalRow {
    id: String,
    task_id: String,
    idempotency_key: Option<String>,
    request_fingerprint: String,
    expected_head: String,
    patch_sha256: String,
    patch: String,
    expected_files_json: String,
    changed_paths_json: String,
    status: String,
    changeset_id: Option<String>,
    created_at: i64,
    applied_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredFileExpectation {
    path: String,
    sha256: Option<String>,
}

type TaskDbRow = (
    String,
    String,
    Option<String>,
    String,
    String,
    i64,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    i64,
);

type ProposalDbRow = (
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    i64,
    Option<i64>,
);

type EventDbRow = (i64, String, String, i64);

fn sha256(input: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(input.as_ref()))
}

fn validate_key(value: &str, name: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > MAX_KEY_BYTES
        || !value.is_ascii()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(AppError::InvalidRequest(format!(
            "{name} must be 1-{MAX_KEY_BYTES} ASCII bytes using letters, digits, '-', '_', '.', or ':'"
        )));
    }
    Ok(())
}

fn validate_context_query(query: Option<&str>) -> AppResult<()> {
    if let Some(query) = query {
        if query.trim().is_empty() {
            return Err(AppError::InvalidRequest(
                "context_query must not be blank when provided".into(),
            ));
        }
        if query.len() > MAX_CONTEXT_QUERY_BYTES {
            return Err(AppError::InvalidRequest(format!(
                "context_query exceeds {MAX_CONTEXT_QUERY_BYTES} bytes"
            )));
        }
    }
    Ok(())
}

fn task_fingerprint(req: &TaskBeginRequest) -> AppResult<String> {
    let payload = serde_json::to_vec(&(
        &req.workspace,
        &req.client_request_id,
        &req.context_query,
        req.context_max_bytes,
        req.context_max_items,
    ))
    .map_err(anyhow::Error::from)?;
    Ok(sha256(payload))
}

fn stored_expectations(expected: &[FileExpectation]) -> Vec<StoredFileExpectation> {
    let mut values: Vec<_> = expected
        .iter()
        .map(|item| StoredFileExpectation {
            path: item.path.clone(),
            sha256: item.sha256.clone(),
        })
        .collect();
    values.sort_by(|left, right| left.path.cmp(&right.path));
    values
}

fn proposal_fingerprint(
    patch: &str,
    expectations: &[StoredFileExpectation],
) -> AppResult<String> {
    let payload = serde_json::to_vec(&(patch, expectations)).map_err(anyhow::Error::from)?;
    Ok(sha256(payload))
}

fn task_from_row(row: TaskDbRow) -> TaskRow {
    TaskRow {
        id: row.0,
        workspace: row.1,
        client_request_id: row.2,
        request_fingerprint: row.3,
        base_head: row.4,
        graph_version: row.5,
        status: row.6,
        context_query: row.7,
        context_sha256: row.8,
        stale_reason: row.9,
        created_at: row.10,
        updated_at: row.11,
    }
}

fn proposal_from_row(row: ProposalDbRow) -> ProposalRow {
    ProposalRow {
        id: row.0,
        task_id: row.1,
        idempotency_key: row.2,
        request_fingerprint: row.3,
        expected_head: row.4,
        patch_sha256: row.5,
        patch: row.6,
        expected_files_json: row.7,
        changed_paths_json: row.8,
        status: row.9,
        changeset_id: row.10,
        created_at: row.11,
        applied_at: row.12,
    }
}

fn task_view(row: &TaskRow) -> TaskView {
    TaskView {
        id: row.id.clone(),
        workspace: row.workspace.clone(),
        client_request_id: row.client_request_id.clone(),
        base_head: row.base_head.clone(),
        graph_version: row.graph_version,
        status: row.status.clone(),
        context_query: row.context_query.clone(),
        context_sha256: row.context_sha256.clone(),
        stale_reason: row.stale_reason.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn proposal_view(row: &ProposalRow) -> AppResult<TaskProposalView> {
    Ok(TaskProposalView {
        id: row.id.clone(),
        task_id: row.task_id.clone(),
        idempotency_key: row.idempotency_key.clone(),
        expected_head: row.expected_head.clone(),
        patch_sha256: row.patch_sha256.clone(),
        changed_paths: serde_json::from_str(&row.changed_paths_json)
            .map_err(anyhow::Error::from)?,
        status: row.status.clone(),
        changeset_id: row.changeset_id.clone(),
        created_at: row.created_at,
        applied_at: row.applied_at,
    })
}

async fn load_task(state: &AppState, task_id: &str) -> AppResult<TaskRow> {
    let row: Option<TaskDbRow> = sqlx::query_as(
        "SELECT id, workspace_id, client_request_id, request_fingerprint, base_head, graph_version, status, \
                context_query, context_sha256, stale_reason, created_at, updated_at \
         FROM tasks WHERE id=?1",
    )
    .bind(task_id)
    .fetch_optional(&state.db)
    .await?;
    row.map(task_from_row)
        .ok_or_else(|| AppError::InvalidRequest(format!("task not found: {task_id}")))
}

async fn load_proposal(
    state: &AppState,
    task_id: &str,
    proposal_id: &str,
) -> AppResult<ProposalRow> {
    let row: Option<ProposalDbRow> = sqlx::query_as(
        "SELECT id, task_id, idempotency_key, request_fingerprint, expected_head, patch_sha256, patch, \
                expected_files_json, changed_paths_json, status, changeset_id, created_at, applied_at \
         FROM task_proposals WHERE id=?1 AND task_id=?2",
    )
    .bind(proposal_id)
    .bind(task_id)
    .fetch_optional(&state.db)
    .await?;
    row.map(proposal_from_row).ok_or_else(|| {
        AppError::InvalidRequest(format!(
            "proposal not found for task {task_id}: {proposal_id}"
        ))
    })
}

async fn insert_event_tx(
    tx: &mut Transaction<'_, Sqlite>,
    task_id: &str,
    event_type: &str,
    metadata: &serde_json::Value,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO task_events(task_id, event_type, metadata_json, created_at) \
         VALUES(?1, ?2, ?3, unixepoch())",
    )
    .bind(task_id)
    .bind(event_type)
    .bind(serde_json::to_string(metadata).map_err(anyhow::Error::from)?)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn graph_state(state: &AppState, workspace_id: &str) -> AppResult<(i64, Option<String>)> {
    Ok(sqlx::query_as(
        "SELECT graph_version, indexed_head FROM workspaces WHERE id=?1",
    )
    .bind(workspace_id)
    .fetch_one(&state.db)
    .await?)
}

async fn refresh_task_state(state: &AppState, mut task: TaskRow) -> AppResult<TaskRow> {
    if task.status != "active" {
        return Ok(task);
    }

    let workspace = state.workspaces.get(&task.workspace)?;
    let current_head = git::head(&workspace.root).await?;
    let dirty = !git::status(&workspace.root).await?.is_empty();
    let (current_graph, indexed_head) = graph_state(state, &task.workspace).await?;

    let reason = if dirty {
        Some("dirty_working_tree")
    } else if current_head != task.base_head {
        Some("git_head_changed")
    } else if current_graph != task.graph_version {
        Some("graph_version_changed")
    } else if indexed_head.as_deref() != Some(current_head.as_str()) {
        Some("indexed_head_changed")
    } else {
        None
    };

    if let Some(reason) = reason {
        let mut tx = state.db.begin().await?;
        let result = sqlx::query(
            "UPDATE tasks SET status='stale', stale_reason=?1, updated_at=unixepoch() \
             WHERE id=?2 AND status='active'",
        )
        .bind(reason)
        .bind(&task.id)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 1 {
            insert_event_tx(
                &mut tx,
                &task.id,
                "task_stale",
                &serde_json::json!({ "reason": reason }),
            )
            .await?;
        }
        tx.commit().await?;
        task = load_task(state, &task.id).await?;
    }
    Ok(task)
}

async fn require_active_task(state: &AppState, task_id: &str) -> AppResult<TaskRow> {
    let task = refresh_task_state(state, load_task(state, task_id).await?).await?;
    if task.status != "active" {
        return Err(AppError::InvalidRequest(format!(
            "task {task_id} is not active (status={})",
            task.status
        )));
    }
    Ok(task)
}

pub async fn begin(state: &AppState, req: TaskBeginRequest) -> AppResult<TaskBeginResult> {
    if let Some(key) = req.client_request_id.as_deref() {
        validate_key(key, "client_request_id")?;
    }
    validate_context_query(req.context_query.as_deref())?;
    state.workspaces.get(&req.workspace)?;
    let fingerprint = task_fingerprint(&req)?;

    if let Some(client_request_id) = req.client_request_id.as_deref() {
        let existing: Option<(String, String)> = sqlx::query_as(
            "SELECT id, request_fingerprint FROM tasks WHERE workspace_id=?1 AND client_request_id=?2",
        )
        .bind(&req.workspace)
        .bind(client_request_id)
        .fetch_optional(&state.db)
        .await?;
        if let Some((task_id, existing_fingerprint)) = existing {
            if existing_fingerprint != fingerprint {
                return Err(AppError::InvalidRequest(
                    "client_request_id already exists with a different task request".into(),
                ));
            }
            let snapshot = get(state, TaskIdRequest { task_id }).await?;
            return Ok(TaskBeginResult {
                task: snapshot.task,
                context: None,
                replayed: true,
            });
        }
    }

    let workspace = state.workspaces.get(&req.workspace)?;
    let head = git::head(&workspace.root).await?;
    if !git::status(&workspace.root).await?.is_empty() {
        return Err(AppError::InvalidRequest(
            "task_begin requires a clean working tree".into(),
        ));
    }
    let (graph_version, indexed_head) = graph_state(state, &req.workspace).await?;
    if indexed_head.as_deref() != Some(head.as_str()) {
        return Err(AppError::InvalidRequest(
            "task_begin requires repository intelligence indexed at current Git HEAD".into(),
        ));
    }

    let context = if let Some(query) = req.context_query.as_ref() {
        Some(
            context::pack(
                state,
                ContextPackRequest {
                    workspace: req.workspace.clone(),
                    query: query.clone(),
                    seed_symbol_keys: Vec::new(),
                    max_bytes: req.context_max_bytes.unwrap_or(DEFAULT_CONTEXT_BYTES),
                    max_items: req.context_max_items.unwrap_or(DEFAULT_CONTEXT_ITEMS),
                    require_clean: true,
                },
            )
            .await?,
        )
    } else {
        None
    };
    let context_sha256 = context
        .as_ref()
        .map(serde_json::to_vec)
        .transpose()
        .map_err(anyhow::Error::from)?
        .map(sha256);

    let head_after = git::head(&workspace.root).await?;
    let dirty_after = !git::status(&workspace.root).await?.is_empty();
    let (graph_after, indexed_after) = graph_state(state, &req.workspace).await?;
    if dirty_after
        || head_after != head
        || graph_after != graph_version
        || indexed_after.as_deref() != Some(head.as_str())
    {
        return Err(AppError::InvalidRequest(
            "repository changed while beginning task".into(),
        ));
    }

    let task_id = Uuid::new_v4().to_string();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO tasks(\
            id, workspace_id, client_request_id, request_fingerprint, base_head, graph_version, status, \
            context_query, context_sha256, created_at, updated_at\
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, unixepoch(), unixepoch())",
    )
    .bind(&task_id)
    .bind(&req.workspace)
    .bind(&req.client_request_id)
    .bind(&fingerprint)
    .bind(&head)
    .bind(graph_version)
    .bind(&req.context_query)
    .bind(&context_sha256)
    .execute(&mut *tx)
    .await?;
    insert_event_tx(
        &mut tx,
        &task_id,
        "task_begun",
        &serde_json::json!({
            "base_head": head,
            "graph_version": graph_version,
            "has_context": context.is_some(),
            "context_sha256": context_sha256,
        }),
    )
    .await?;
    tx.commit().await?;

    let task = load_task(state, &task_id).await?;
    Ok(TaskBeginResult {
        task: task_view(&task),
        context,
        replayed: false,
    })
}

pub async fn get(state: &AppState, req: TaskIdRequest) -> AppResult<TaskSnapshot> {
    let task = refresh_task_state(state, load_task(state, &req.task_id).await?).await?;
    let proposal_rows: Vec<ProposalDbRow> = sqlx::query_as(
        "SELECT id, task_id, idempotency_key, request_fingerprint, expected_head, patch_sha256, patch, \
                expected_files_json, changed_paths_json, status, changeset_id, created_at, applied_at \
         FROM task_proposals WHERE task_id=?1 ORDER BY created_at, id",
    )
    .bind(&task.id)
    .fetch_all(&state.db)
    .await?;
    let proposals = proposal_rows
        .into_iter()
        .map(proposal_from_row)
        .map(|row| proposal_view(&row))
        .collect::<AppResult<Vec<_>>>()?;
    let event_rows: Vec<EventDbRow> = sqlx::query_as(
        "SELECT id, event_type, metadata_json, created_at FROM task_events \
         WHERE task_id=?1 ORDER BY id",
    )
    .bind(&task.id)
    .fetch_all(&state.db)
    .await?;
    let events = event_rows
        .into_iter()
        .map(|(id, event_type, metadata_json, created_at)| {
            Ok(TaskEventView {
                id,
                event_type,
                metadata: serde_json::from_str(&metadata_json).map_err(anyhow::Error::from)?,
                created_at,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;

    Ok(TaskSnapshot {
        task: task_view(&task),
        proposals,
        events,
    })
}

pub async fn cancel(state: &AppState, req: TaskIdRequest) -> AppResult<TaskView> {
    let task = refresh_task_state(state, load_task(state, &req.task_id).await?).await?;
    if task.status == "applied" {
        return Err(AppError::InvalidRequest(
            "an applied task cannot be cancelled".into(),
        ));
    }
    if task.status == "cancelled" {
        return Ok(task_view(&task));
    }

    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE tasks SET status='cancelled', updated_at=unixepoch() WHERE id=?1",
    )
    .bind(&task.id)
    .execute(&mut *tx)
    .await?;
    insert_event_tx(
        &mut tx,
        &task.id,
        "task_cancelled",
        &serde_json::json!({}),
    )
    .await?;
    tx.commit().await?;
    Ok(task_view(&load_task(state, &task.id).await?))
}

pub async fn propose_patch(
    state: &AppState,
    req: TaskProposePatchRequest,
) -> AppResult<TaskProposalResult> {
    if let Some(key) = req.idempotency_key.as_deref() {
        validate_key(key, "idempotency_key")?;
    }
    let task = require_active_task(state, &req.task_id).await?;
    let expectations = stored_expectations(&req.expected_files);
    let fingerprint = proposal_fingerprint(&req.patch, &expectations)?;

    if let Some(key) = req.idempotency_key.as_deref() {
        let existing: Option<ProposalDbRow> = sqlx::query_as(
            "SELECT id, task_id, idempotency_key, request_fingerprint, expected_head, patch_sha256, patch, \
                    expected_files_json, changed_paths_json, status, changeset_id, created_at, applied_at \
             FROM task_proposals WHERE task_id=?1 AND idempotency_key=?2",
        )
        .bind(&task.id)
        .bind(key)
        .fetch_optional(&state.db)
        .await?;
        if let Some(row) = existing {
            let proposal = proposal_from_row(row);
            if proposal.request_fingerprint != fingerprint {
                return Err(AppError::InvalidRequest(
                    "idempotency_key already exists with a different patch proposal".into(),
                ));
            }
            return Ok(TaskProposalResult {
                proposal: proposal_view(&proposal)?,
                replayed: true,
            });
        }
    }

    let preview = state
        .preview_patch(PatchRequest {
            workspace: task.workspace.clone(),
            expected_head: task.base_head.clone(),
            expected_files: req.expected_files,
            patch: req.patch.clone(),
        })
        .await?;
    let proposal_id = Uuid::new_v4().to_string();
    let expected_files_json =
        serde_json::to_string(&expectations).map_err(anyhow::Error::from)?;
    let changed_paths_json =
        serde_json::to_string(&preview.changed_paths).map_err(anyhow::Error::from)?;

    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO task_proposals(\
            id, task_id, idempotency_key, request_fingerprint, expected_head, patch_sha256, patch, \
            expected_files_json, changed_paths_json, status, created_at\
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'proposed', unixepoch())",
    )
    .bind(&proposal_id)
    .bind(&task.id)
    .bind(&req.idempotency_key)
    .bind(&fingerprint)
    .bind(&task.base_head)
    .bind(&preview.patch_sha256)
    .bind(&req.patch)
    .bind(&expected_files_json)
    .bind(&changed_paths_json)
    .execute(&mut *tx)
    .await?;
    insert_event_tx(
        &mut tx,
        &task.id,
        "patch_proposed",
        &serde_json::json!({
            "proposal_id": proposal_id,
            "patch_sha256": preview.patch_sha256,
            "changed_paths": preview.changed_paths,
        }),
    )
    .await?;
    tx.commit().await?;

    let proposal = load_proposal(state, &task.id, &proposal_id).await?;
    Ok(TaskProposalResult {
        proposal: proposal_view(&proposal)?,
        replayed: false,
    })
}

pub async fn apply_patch(
    state: &AppState,
    req: TaskApplyPatchRequest,
) -> AppResult<TaskApplyResult> {
    let task = require_active_task(state, &req.task_id).await?;
    let proposal = load_proposal(state, &task.id, &req.proposal_id).await?;
    if proposal.status == "applied" {
        return Err(AppError::InvalidRequest(
            "proposal has already been applied".into(),
        ));
    }
    if proposal.status != "proposed" {
        return Err(AppError::InvalidRequest(format!(
            "proposal is not applicable (status={})",
            proposal.status
        )));
    }
    let stored: Vec<StoredFileExpectation> =
        serde_json::from_str(&proposal.expected_files_json).map_err(anyhow::Error::from)?;
    let expected_files = stored
        .into_iter()
        .map(|item| FileExpectation {
            path: item.path,
            sha256: item.sha256,
        })
        .collect();

    let applied = state
        .apply_patch(PatchRequest {
            workspace: task.workspace.clone(),
            expected_head: proposal.expected_head.clone(),
            expected_files,
            patch: proposal.patch.clone(),
        })
        .await?;

    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE task_proposals SET status='applied', changeset_id=?1, applied_at=unixepoch() \
         WHERE id=?2 AND task_id=?3 AND status='proposed'",
    )
    .bind(&applied.changeset_id)
    .bind(&proposal.id)
    .bind(&task.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE tasks SET status='applied', updated_at=unixepoch() WHERE id=?1 AND status='active'",
    )
    .bind(&task.id)
    .execute(&mut *tx)
    .await?;
    insert_event_tx(
        &mut tx,
        &task.id,
        "patch_applied",
        &serde_json::json!({
            "proposal_id": proposal.id,
            "changeset_id": applied.changeset_id,
            "changed_paths": applied.changed_paths,
        }),
    )
    .await?;
    tx.commit().await?;

    Ok(TaskApplyResult {
        task_id: task.id,
        proposal_id: req.proposal_id,
        changeset_id: applied.changeset_id,
        head: applied.head,
        changed_paths: applied.changed_paths,
        diff: applied.diff,
    })
}
