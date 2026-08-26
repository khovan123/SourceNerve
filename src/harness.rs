use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    git,
    oauth::Principal,
    plugin_hub_runtime,
    runtime,
    service::AppState,
};

const DEFAULT_PROFILE: &str = "interactive-local";
const MAX_CLIENT_REQUEST_ID_BYTES: usize = 128;
const MAX_EVENT_LIMIT: usize = 200;
const DEFAULT_EVENT_LIMIT: usize = 100;
const MAX_CAPABILITY_SNAPSHOT_BYTES: usize = 512 * 1024;

const PROFILES: &[&str] = &[
    "read-only-analysis",
    "interactive-local",
    "guarded-durable",
    "background-job",
    "webhook-automation",
];

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessRunBeginRequest {
    pub workspace: String,
    #[serde(default = "default_profile")]
    pub profile: String,
    pub client_request_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessRunIdRequest {
    pub run_id: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessRunEventsRequest {
    pub run_id: String,
    pub after_seq: Option<i64>,
    #[serde(default = "default_event_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessRunView {
    pub id: String,
    pub workspace: String,
    pub principal_id: String,
    pub client_request_id: Option<String>,
    pub profile: String,
    pub status: String,
    pub base_head: String,
    pub graph_version: i64,
    pub indexed_head: Option<String>,
    pub capability_snapshot: serde_json::Value,
    pub capability_snapshot_sha256: String,
    pub parent_run_id: Option<String>,
    pub stale_reason: Option<String>,
    pub started_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessRunFreshness {
    pub state: String,
    pub reason: Option<String>,
    pub current_head: String,
    pub current_graph_version: i64,
    pub current_indexed_head: Option<String>,
    pub current_capability_snapshot_sha256: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessRunSnapshot {
    pub run: HarnessRunView,
    pub freshness: HarnessRunFreshness,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessRunBeginResult {
    pub snapshot: HarnessRunSnapshot,
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessEventView {
    pub seq: i64,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessRunEventsResult {
    pub run: HarnessRunView,
    pub events: Vec<HarnessEventView>,
    pub next_after_seq: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
struct ExtensionSnapshot {
    id: String,
    namespace: String,
    version: String,
}

#[derive(Debug, Clone)]
struct WorkspaceSnapshot {
    head: String,
    graph_version: i64,
    indexed_head: Option<String>,
    capability_snapshot_json: String,
    capability_snapshot_sha256: String,
}

#[derive(Debug, Clone)]
struct HarnessRunRow {
    id: String,
    workspace: String,
    principal_id: String,
    client_request_id: Option<String>,
    request_fingerprint: String,
    profile: String,
    status: String,
    base_head: String,
    graph_version: i64,
    indexed_head: Option<String>,
    capability_snapshot_json: String,
    capability_snapshot_sha256: String,
    parent_run_id: Option<String>,
    stale_reason: Option<String>,
    started_at: i64,
    updated_at: i64,
    completed_at: Option<i64>,
}

type HarnessRunDbRow = (
    String,
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    i64,
    Option<String>,
    String,
    String,
    Option<String>,
    Option<String>,
    i64,
    i64,
    Option<i64>,
);

type HarnessEventDbRow = (i64, String, String, i64);

fn default_profile() -> String {
    DEFAULT_PROFILE.to_string()
}

fn default_event_limit() -> usize {
    DEFAULT_EVENT_LIMIT
}

fn sha256(input: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(input.as_ref()))
}

pub fn principal_key(principal: &Principal) -> String {
    match principal {
        Principal::Operator => "operator".to_string(),
        Principal::OAuth(value) => format!("oauth:sha256:{}", sha256(value.subject.as_bytes())),
    }
}

pub fn operator_principal_key() -> &'static str {
    "operator"
}

fn validate_profile(profile: &str) -> AppResult<()> {
    if PROFILES.contains(&profile) {
        Ok(())
    } else {
        Err(AppError::InvalidRequest(format!(
            "unsupported harness profile `{profile}`"
        )))
    }
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

fn request_fingerprint(req: &HarnessRunBeginRequest) -> AppResult<String> {
    let bytes = serde_json::to_vec(&(&req.workspace, &req.profile)).map_err(anyhow::Error::from)?;
    Ok(sha256(bytes))
}

fn row_from_db(row: HarnessRunDbRow) -> HarnessRunRow {
    HarnessRunRow {
        id: row.0,
        workspace: row.1,
        principal_id: row.2,
        client_request_id: row.3,
        request_fingerprint: row.4,
        profile: row.5,
        status: row.6,
        base_head: row.7,
        graph_version: row.8,
        indexed_head: row.9,
        capability_snapshot_json: row.10,
        capability_snapshot_sha256: row.11,
        parent_run_id: row.12,
        stale_reason: row.13,
        started_at: row.14,
        updated_at: row.15,
        completed_at: row.16,
    }
}

fn run_view(row: &HarnessRunRow) -> AppResult<HarnessRunView> {
    Ok(HarnessRunView {
        id: row.id.clone(),
        workspace: row.workspace.clone(),
        principal_id: row.principal_id.clone(),
        client_request_id: row.client_request_id.clone(),
        profile: row.profile.clone(),
        status: row.status.clone(),
        base_head: row.base_head.clone(),
        graph_version: row.graph_version,
        indexed_head: row.indexed_head.clone(),
        capability_snapshot: serde_json::from_str(&row.capability_snapshot_json)
            .map_err(anyhow::Error::from)?,
        capability_snapshot_sha256: row.capability_snapshot_sha256.clone(),
        parent_run_id: row.parent_run_id.clone(),
        stale_reason: row.stale_reason.clone(),
        started_at: row.started_at,
        updated_at: row.updated_at,
        completed_at: row.completed_at,
    })
}

async fn graph_state(state: &AppState, workspace: &str) -> AppResult<(i64, Option<String>)> {
    Ok(
        sqlx::query_as("SELECT graph_version, indexed_head FROM workspaces WHERE id=?1")
            .bind(workspace)
            .fetch_one(&state.db)
            .await?,
    )
}

async fn capability_snapshot(state: &AppState) -> AppResult<(String, String)> {
    let plugins = serde_json::to_value(plugin_hub_runtime::catalog().await)
        .map_err(anyhow::Error::from)?;
    let extensions: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, namespace, version FROM mcp_extensions WHERE enabled=1 ORDER BY namespace, id",
    )
    .fetch_all(&state.db)
    .await?;
    let extensions = extensions
        .into_iter()
        .map(|(id, namespace, version)| ExtensionSnapshot {
            id,
            namespace,
            version,
        })
        .collect::<Vec<_>>();
    let snapshot = serde_json::json!({
        "runtime_capabilities": runtime::identity().capabilities,
        "plugins": plugins,
        "mcp_extensions": extensions,
    });
    let encoded = serde_json::to_string(&snapshot).map_err(anyhow::Error::from)?;
    if encoded.len() > MAX_CAPABILITY_SNAPSHOT_BYTES {
        return Err(AppError::InvalidRequest(format!(
            "harness capability snapshot exceeds {MAX_CAPABILITY_SNAPSHOT_BYTES} bytes"
        )));
    }
    let digest = sha256(encoded.as_bytes());
    Ok((encoded, digest))
}

async fn capture_workspace_snapshot(
    state: &AppState,
    workspace_id: &str,
) -> AppResult<WorkspaceSnapshot> {
    let workspace = state.workspaces.get(workspace_id)?;
    let head = git::head(&workspace.root).await?;
    let (graph_version, indexed_head) = graph_state(state, workspace_id).await?;
    let (capability_snapshot_json, capability_snapshot_sha256) = capability_snapshot(state).await?;
    Ok(WorkspaceSnapshot {
        head,
        graph_version,
        indexed_head,
        capability_snapshot_json,
        capability_snapshot_sha256,
    })
}

async fn load_run(state: &AppState, run_id: &str) -> AppResult<HarnessRunRow> {
    let row: Option<HarnessRunDbRow> = sqlx::query_as(
        "SELECT id, workspace_id, principal_id, client_request_id, request_fingerprint, profile, status, \
                base_head, graph_version, indexed_head, capability_snapshot_json, capability_snapshot_sha256, \
                parent_run_id, stale_reason, started_at, updated_at, completed_at \
         FROM harness_runs WHERE id=?1",
    )
    .bind(run_id)
    .fetch_optional(&state.db)
    .await?;
    row.map(row_from_db)
        .ok_or_else(|| AppError::InvalidRequest(format!("harness run not found: {run_id}")))
}

fn ensure_owner(row: &HarnessRunRow, principal_id: &str, operator: bool) -> AppResult<()> {
    if operator || row.principal_id == principal_id {
        Ok(())
    } else {
        Err(AppError::InvalidRequest(format!(
            "harness run not found: {}",
            row.id
        )))
    }
}

async fn allocate_event_seq_tx(
    tx: &mut Transaction<'_, Sqlite>,
    run_id: &str,
) -> AppResult<i64> {
    let seq: i64 = sqlx::query_scalar(
        "UPDATE harness_runs \
         SET next_event_seq=next_event_seq+1, updated_at=unixepoch() \
         WHERE id=?1 \
         RETURNING next_event_seq-1",
    )
    .bind(run_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(seq)
}

async fn append_event_tx(
    tx: &mut Transaction<'_, Sqlite>,
    run_id: &str,
    event_type: &str,
    payload: &serde_json::Value,
) -> AppResult<i64> {
    if event_type.is_empty() || event_type.len() > 64 || event_type.chars().any(char::is_control) {
        return Err(AppError::InvalidRequest(
            "harness event type must be 1-64 non-control characters".into(),
        ));
    }
    let payload_json = serde_json::to_string(payload).map_err(anyhow::Error::from)?;
    let seq = allocate_event_seq_tx(tx, run_id).await?;
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
    Ok(seq)
}

fn stale_reason(row: &HarnessRunRow, current: &WorkspaceSnapshot) -> Option<&'static str> {
    if current.head != row.base_head {
        Some("git_head_changed")
    } else if current.graph_version != row.graph_version {
        Some("graph_version_changed")
    } else if current.indexed_head != row.indexed_head {
        Some("indexed_head_changed")
    } else if current.capability_snapshot_sha256 != row.capability_snapshot_sha256 {
        Some("capability_snapshot_changed")
    } else {
        None
    }
}

fn freshness(
    row: &HarnessRunRow,
    current: &WorkspaceSnapshot,
) -> HarnessRunFreshness {
    let current_reason = stale_reason(row, current).map(str::to_string);
    let reason = row.stale_reason.clone().or(current_reason);
    HarnessRunFreshness {
        state: if reason.is_some() {
            "stale".to_string()
        } else {
            "current".to_string()
        },
        reason,
        current_head: current.head.clone(),
        current_graph_version: current.graph_version,
        current_indexed_head: current.indexed_head.clone(),
        current_capability_snapshot_sha256: current.capability_snapshot_sha256.clone(),
    }
}

async fn refresh_running_run(
    state: &AppState,
    mut row: HarnessRunRow,
) -> AppResult<(HarnessRunRow, WorkspaceSnapshot)> {
    let current = capture_workspace_snapshot(state, &row.workspace).await?;
    if row.status != "running" || stale_reason(&row, &current).is_none() {
        return Ok((row, current));
    }

    let _guard = state.mutation_lock.lock().await;
    row = load_run(state, &row.id).await?;
    if row.status != "running" {
        let current = capture_workspace_snapshot(state, &row.workspace).await?;
        return Ok((row, current));
    }
    let current = capture_workspace_snapshot(state, &row.workspace).await?;
    let Some(reason) = stale_reason(&row, &current) else {
        return Ok((row, current));
    };

    let mut tx = state.db.begin().await?;
    let updated = sqlx::query(
        "UPDATE harness_runs \
         SET status='stale', stale_reason=?1, updated_at=unixepoch() \
         WHERE id=?2 AND status='running'",
    )
    .bind(reason)
    .bind(&row.id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 1 {
        append_event_tx(
            &mut tx,
            &row.id,
            "run/stale",
            &serde_json::json!({ "reason": reason }),
        )
        .await?;
    }
    tx.commit().await?;
    row = load_run(state, &row.id).await?;
    Ok((row, current))
}

pub async fn begin(
    state: &AppState,
    req: HarnessRunBeginRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessRunBeginResult> {
    state.workspaces.get(&req.workspace)?;
    validate_profile(&req.profile)?;
    if let Some(client_request_id) = req.client_request_id.as_deref() {
        validate_client_request_id(client_request_id)?;
    }
    let fingerprint = request_fingerprint(&req)?;

    if let Some(client_request_id) = req.client_request_id.as_deref() {
        let existing: Option<(String, String)> = sqlx::query_as(
            "SELECT id, request_fingerprint FROM harness_runs \
             WHERE principal_id=?1 AND client_request_id=?2",
        )
        .bind(principal_id)
        .bind(client_request_id)
        .fetch_optional(&state.db)
        .await?;
        if let Some((run_id, existing_fingerprint)) = existing {
            if existing_fingerprint != fingerprint {
                return Err(AppError::InvalidRequest(
                    "client_request_id already exists with a different harness run request".into(),
                ));
            }
            return Ok(HarnessRunBeginResult {
                snapshot: get(
                    state,
                    HarnessRunIdRequest { run_id },
                    principal_id,
                    operator,
                )
                .await?,
                replayed: true,
            });
        }
    }

    let _guard = state.mutation_lock.lock().await;

    if let Some(client_request_id) = req.client_request_id.as_deref() {
        let existing: Option<(String, String)> = sqlx::query_as(
            "SELECT id, request_fingerprint FROM harness_runs \
             WHERE principal_id=?1 AND client_request_id=?2",
        )
        .bind(principal_id)
        .bind(client_request_id)
        .fetch_optional(&state.db)
        .await?;
        if let Some((run_id, existing_fingerprint)) = existing {
            if existing_fingerprint != fingerprint {
                return Err(AppError::InvalidRequest(
                    "client_request_id already exists with a different harness run request".into(),
                ));
            }
            let row = load_run(state, &run_id).await?;
            ensure_owner(&row, principal_id, operator)?;
            let current = capture_workspace_snapshot(state, &row.workspace).await?;
            return Ok(HarnessRunBeginResult {
                snapshot: HarnessRunSnapshot {
                    run: run_view(&row)?,
                    freshness: freshness(&row, &current),
                },
                replayed: true,
            });
        }
    }

    let snapshot = capture_workspace_snapshot(state, &req.workspace).await?;
    let run_id = Uuid::new_v4().to_string();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO harness_runs(\
            id, workspace_id, principal_id, client_request_id, request_fingerprint, profile, status, \
            base_head, graph_version, indexed_head, capability_snapshot_json, capability_snapshot_sha256, \
            next_event_seq, started_at, updated_at\
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7, ?8, ?9, ?10, ?11, 1, unixepoch(), unixepoch())",
    )
    .bind(&run_id)
    .bind(&req.workspace)
    .bind(principal_id)
    .bind(&req.client_request_id)
    .bind(&fingerprint)
    .bind(&req.profile)
    .bind(&snapshot.head)
    .bind(snapshot.graph_version)
    .bind(&snapshot.indexed_head)
    .bind(&snapshot.capability_snapshot_json)
    .bind(&snapshot.capability_snapshot_sha256)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO harness_events(run_id, seq, event_type, payload_json, created_at) \
         VALUES(?1, 0, 'run/started', ?2, unixepoch())",
    )
    .bind(&run_id)
    .bind(
        serde_json::to_string(&serde_json::json!({
            "workspace": req.workspace,
            "profile": req.profile,
            "base_head": snapshot.head,
            "graph_version": snapshot.graph_version,
            "indexed_head": snapshot.indexed_head,
            "capability_snapshot_sha256": snapshot.capability_snapshot_sha256,
        }))
        .map_err(anyhow::Error::from)?,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let row = load_run(state, &run_id).await?;
    Ok(HarnessRunBeginResult {
        snapshot: HarnessRunSnapshot {
            run: run_view(&row)?,
            freshness: freshness(&row, &snapshot),
        },
        replayed: false,
    })
}

pub async fn get(
    state: &AppState,
    req: HarnessRunIdRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessRunSnapshot> {
    let row = load_run(state, &req.run_id).await?;
    ensure_owner(&row, principal_id, operator)?;
    let (row, current) = refresh_running_run(state, row).await?;
    ensure_owner(&row, principal_id, operator)?;
    Ok(HarnessRunSnapshot {
        run: run_view(&row)?,
        freshness: freshness(&row, &current),
    })
}

pub async fn events(
    state: &AppState,
    req: HarnessRunEventsRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessRunEventsResult> {
    if req.limit == 0 || req.limit > MAX_EVENT_LIMIT {
        return Err(AppError::InvalidRequest(format!(
            "harness event limit must be between 1 and {MAX_EVENT_LIMIT}"
        )));
    }
    let snapshot = get(
        state,
        HarnessRunIdRequest {
            run_id: req.run_id.clone(),
        },
        principal_id,
        operator,
    )
    .await?;
    let after_seq = req.after_seq.unwrap_or(-1);
    if after_seq < -1 {
        return Err(AppError::InvalidRequest(
            "after_seq must be -1 or greater".into(),
        ));
    }
    let rows: Vec<HarnessEventDbRow> = sqlx::query_as(
        "SELECT seq, event_type, payload_json, created_at FROM harness_events \
         WHERE run_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3",
    )
    .bind(&req.run_id)
    .bind(after_seq)
    .bind(req.limit as i64)
    .fetch_all(&state.db)
    .await?;
    let events = rows
        .into_iter()
        .map(|(seq, event_type, payload_json, created_at)| {
            Ok(HarnessEventView {
                seq,
                event_type,
                payload: serde_json::from_str(&payload_json).map_err(anyhow::Error::from)?,
                created_at,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    let next_after_seq = events.last().map(|event| event.seq);
    Ok(HarnessRunEventsResult {
        run: snapshot.run,
        events,
        next_after_seq,
    })
}

pub async fn cancel(
    state: &AppState,
    req: HarnessRunIdRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessRunSnapshot> {
    let _guard = state.mutation_lock.lock().await;
    let row = load_run(state, &req.run_id).await?;
    ensure_owner(&row, principal_id, operator)?;
    if matches!(row.status.as_str(), "completed" | "cancelled" | "failed") {
        let current = capture_workspace_snapshot(state, &row.workspace).await?;
        return Ok(HarnessRunSnapshot {
            run: run_view(&row)?,
            freshness: freshness(&row, &current),
        });
    }

    let mut tx = state.db.begin().await?;
    let updated = sqlx::query(
        "UPDATE harness_runs \
         SET status='cancelled', stale_reason=NULL, completed_at=unixepoch(), updated_at=unixepoch() \
         WHERE id=?1 AND status IN ('running', 'stale')",
    )
    .bind(&row.id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 1 {
        append_event_tx(&mut tx, &row.id, "run/cancelled", &serde_json::json!({})).await?;
    }
    tx.commit().await?;
    let row = load_run(state, &row.id).await?;
    let current = capture_workspace_snapshot(state, &row.workspace).await?;
    Ok(HarnessRunSnapshot {
        run: run_view(&row)?,
        freshness: freshness(&row, &current),
    })
}

pub async fn complete(
    state: &AppState,
    req: HarnessRunIdRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessRunSnapshot> {
    let _guard = state.mutation_lock.lock().await;
    let row = load_run(state, &req.run_id).await?;
    ensure_owner(&row, principal_id, operator)?;
    if row.status == "completed" {
        let current = capture_workspace_snapshot(state, &row.workspace).await?;
        return Ok(HarnessRunSnapshot {
            run: run_view(&row)?,
            freshness: freshness(&row, &current),
        });
    }
    if row.status != "running" {
        return Err(AppError::InvalidRequest(format!(
            "harness run {} cannot complete from status {}",
            row.id, row.status
        )));
    }
    let current = capture_workspace_snapshot(state, &row.workspace).await?;
    if let Some(reason) = stale_reason(&row, &current) {
        return Err(AppError::InvalidRequest(format!(
            "harness run {} is stale: {reason}",
            row.id
        )));
    }

    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE harness_runs \
         SET status='completed', completed_at=unixepoch(), updated_at=unixepoch() \
         WHERE id=?1 AND status='running'",
    )
    .bind(&row.id)
    .execute(&mut *tx)
    .await?;
    append_event_tx(&mut tx, &row.id, "run/completed", &serde_json::json!({})).await?;
    tx.commit().await?;
    let row = load_run(state, &row.id).await?;
    Ok(HarnessRunSnapshot {
        run: run_view(&row)?,
        freshness: freshness(&row, &current),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use crate::oauth::{GrantAccess, OAuthPrincipal, READ_SCOPE};

    use super::*;

    #[test]
    fn profile_and_client_request_validation_is_bounded() {
        assert!(validate_profile("interactive-local").is_ok());
        assert!(validate_profile("unknown").is_err());
        assert!(validate_client_request_id("harness:run-1").is_ok());
        assert!(validate_client_request_id("contains space").is_err());
    }

    #[test]
    fn oauth_principal_key_is_stable_and_does_not_expose_subject() {
        let principal = OAuthPrincipal::from_parts_for_test(
            HashSet::from([READ_SCOPE.to_string()]),
            HashMap::from([("workspace".to_string(), GrantAccess::ReadOnly)]),
        );
        let subject = principal.subject.to_string();
        let key = principal_key(&Principal::OAuth(principal));
        assert!(key.starts_with("oauth:sha256:"));
        assert!(!key.contains(&subject));
        assert_eq!(key.len(), "oauth:sha256:".len() + 64);
    }
}
