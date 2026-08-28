use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    git,
    oauth::Principal,
    service::AppState,
};

#[path = "harness_capability.rs"]
pub mod capability;
#[path = "harness_recovery.rs"]
pub mod recovery;

const MAX_CLIENT_REQUEST_ID_BYTES: usize = 128;
const MAX_EVENT_LIMIT: usize = 200;
const DEFAULT_EVENT_LIMIT: usize = 100;
const MAX_RUN_LIST_LIMIT: usize = 100;
const DEFAULT_RUN_LIST_LIMIT: usize = 50;
const MAX_CHILD_CAPABILITIES: usize = 4096;
const MAX_CAPABILITY_SNAPSHOT_BYTES: usize = 512 * 1024;
const MAX_CHILD_SUMMARIES: usize = 100;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessRunBeginRequest {
    pub workspace: String,
    #[serde(default = "default_profile")]
    pub profile: String,
    pub sandbox: Option<String>,
    pub client_request_id: Option<String>,
    pub parent_run_id: Option<String>,
    pub capability_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessRunIdRequest {
    pub run_id: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessRunListRequest {
    #[serde(default = "default_run_list_limit")]
    pub limit: usize,
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
pub struct HarnessChildRunSummary {
    pub id: String,
    pub profile: String,
    pub status: String,
    pub parent_run_id: String,
    pub started_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessRunSnapshot {
    pub run: HarnessRunView,
    pub freshness: HarnessRunFreshness,
    pub recovery: recovery::HarnessRunRecovery,
    pub children: Vec<HarnessChildRunSummary>,
    pub children_truncated: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessRunBeginResult {
    pub snapshot: HarnessRunSnapshot,
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessRunListResult {
    pub runs: Vec<HarnessRunSnapshot>,
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
type HarnessChildDbRow = (String, String, String, String, i64, i64, Option<i64>);

fn default_profile() -> String {
    capability::DEFAULT_PROFILE.to_string()
}

fn default_event_limit() -> usize {
    DEFAULT_EVENT_LIMIT
}

fn default_run_list_limit() -> usize {
    DEFAULT_RUN_LIST_LIMIT
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
    capability::validate_profile(profile)
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

fn validate_capability_id(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 256
        || !value.is_ascii()
        || value.chars().any(char::is_control)
    {
        return Err(AppError::InvalidRequest(
            "child capability id must be 1-256 printable ASCII characters".into(),
        ));
    }
    Ok(())
}

fn request_fingerprint(req: &HarnessRunBeginRequest) -> AppResult<String> {
    let bytes = if req.parent_run_id.is_none() && req.capability_ids.is_none() {
        if req.sandbox.is_none() {
            // Preserve the pre-sandbox fingerprint so existing idempotency keys replay across upgrades.
            serde_json::to_vec(&(&req.workspace, &req.profile)).map_err(anyhow::Error::from)?
        } else {
            serde_json::to_vec(&(
                "root-sandbox-v1",
                &req.workspace,
                &req.profile,
                &req.sandbox,
            ))
            .map_err(anyhow::Error::from)?
        }
    } else {
        let mut capability_ids = req.capability_ids.clone().unwrap_or_default();
        capability_ids.sort();
        serde_json::to_vec(&(
            "child-v1",
            &req.workspace,
            &req.profile,
            &req.parent_run_id,
            capability_ids,
        ))
        .map_err(anyhow::Error::from)?
    };
    Ok(sha256(bytes))
}

fn row_from_db(row: HarnessRunDbRow) -> HarnessRunRow {
    HarnessRunRow {
        id: row.0,
        workspace: row.1,
        principal_id: row.2,
        client_request_id: row.3,
        profile: row.4,
        status: row.5,
        base_head: row.6,
        graph_version: row.7,
        indexed_head: row.8,
        capability_snapshot_json: row.9,
        capability_snapshot_sha256: row.10,
        parent_run_id: row.11,
        stale_reason: row.12,
        started_at: row.13,
        updated_at: row.14,
        completed_at: row.15,
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

fn policy_rank(value: &str) -> AppResult<u8> {
    match value {
        "deny" => Ok(0),
        "ask" => Ok(1),
        "allow" => Ok(2),
        _ => Err(AppError::InvalidRequest(format!(
            "invalid harness capability policy `{value}`"
        ))),
    }
}

fn stricter_policy(left: &str, right: &str) -> AppResult<&'static str> {
    let rank = policy_rank(left)?.min(policy_rank(right)?);
    Ok(match rank {
        0 => "deny",
        1 => "ask",
        _ => "allow",
    })
}

fn sandbox_rank(value: &str) -> AppResult<u8> {
    match value {
        "read-only" => Ok(0),
        "workspace-write" => Ok(1),
        "danger-full-access" => Ok(2),
        _ => Err(AppError::InvalidRequest(format!(
            "invalid harness profile sandbox `{value}`"
        ))),
    }
}

fn snapshot_profile(snapshot: &serde_json::Value) -> AppResult<&serde_json::Value> {
    snapshot.get("profile").ok_or_else(|| {
        AppError::InvalidRequest("harness capability snapshot is missing profile metadata".into())
    })
}

fn profile_policy(profile: &serde_json::Value, class: &str) -> AppResult<String> {
    if class == "kernel" {
        return Ok("allow".to_string());
    }
    if !matches!(
        class,
        "read" | "write" | "exec" | "git" | "provider" | "job"
    ) {
        return Err(AppError::InvalidRequest(format!(
            "invalid harness capability class `{class}`"
        )));
    }
    profile
        .get("policies")
        .and_then(serde_json::Value::as_object)
        .and_then(|policies| policies.get(class))
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            AppError::InvalidRequest(format!(
                "harness profile is missing `{class}` policy metadata"
            ))
        })
}

fn ensure_profile_narrows(
    parent_profile: &serde_json::Value,
    child_profile: &serde_json::Value,
) -> AppResult<()> {
    let parent_sandbox = parent_profile
        .get("sandbox")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| AppError::InvalidRequest("parent profile sandbox is invalid".into()))?;
    let child_sandbox = child_profile
        .get("sandbox")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| AppError::InvalidRequest("child profile sandbox is invalid".into()))?;
    if sandbox_rank(child_sandbox)? > sandbox_rank(parent_sandbox)? {
        return Err(AppError::InvalidRequest(
            "child profile cannot widen parent sandbox authority".into(),
        ));
    }

    for class in ["read", "write", "exec", "git", "provider", "job"] {
        let parent_policy = profile_policy(parent_profile, class)?;
        let child_policy = profile_policy(child_profile, class)?;
        if policy_rank(&child_policy)? > policy_rank(&parent_policy)? {
            return Err(AppError::InvalidRequest(format!(
                "child profile cannot widen parent `{class}` authority"
            )));
        }
    }
    Ok(())
}

fn validate_root_sandbox_override(profile_name: &str, sandbox: Option<&str>) -> AppResult<()> {
    let Some(sandbox) = sandbox else {
        return Ok(());
    };
    let profile = capability::profiles()
        .into_iter()
        .find(|profile| profile.name == profile_name)
        .ok_or_else(|| {
            AppError::InvalidRequest(format!("unsupported harness profile `{profile_name}`"))
        })?;
    let base_rank = sandbox_rank(&profile.sandbox)?;
    let requested_rank = sandbox_rank(sandbox)?;
    if sandbox == "danger-full-access" {
        if profile.sandbox != "workspace-write" {
            return Err(AppError::InvalidRequest(format!(
                "danger-full-access requires a workspace-write Harness profile, not `{profile_name}`"
            )));
        }
        return Ok(());
    }
    if requested_rank > base_rank {
        return Err(AppError::InvalidRequest(format!(
            "harness sandbox `{sandbox}` exceeds profile sandbox `{}`",
            profile.sandbox
        )));
    }
    Ok(())
}

fn apply_sandbox_override(
    snapshot_json: String,
    sandbox: Option<&str>,
) -> AppResult<(String, String)> {
    let Some(sandbox) = sandbox else {
        let digest = sha256(snapshot_json.as_bytes());
        return Ok((snapshot_json, digest));
    };
    let mut snapshot: serde_json::Value =
        serde_json::from_str(&snapshot_json).map_err(anyhow::Error::from)?;
    let profile = snapshot
        .get_mut("profile")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| {
            AppError::InvalidRequest("harness capability snapshot profile is invalid".into())
        })?;
    profile.insert(
        "sandbox".to_string(),
        serde_json::Value::String(sandbox.to_string()),
    );
    snapshot
        .as_object_mut()
        .ok_or_else(|| AppError::InvalidRequest("harness capability snapshot is invalid".into()))?
        .insert(
            "sandbox_override".to_string(),
            serde_json::Value::String(sandbox.to_string()),
        );
    encode_capability_snapshot(&snapshot)
}

fn stored_sandbox_override(row: &HarnessRunRow) -> AppResult<Option<String>> {
    let snapshot: serde_json::Value =
        serde_json::from_str(&row.capability_snapshot_json).map_err(anyhow::Error::from)?;
    Ok(snapshot
        .get("sandbox_override")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned))
}

fn encode_capability_snapshot(snapshot: &serde_json::Value) -> AppResult<(String, String)> {
    let encoded = serde_json::to_string(snapshot).map_err(anyhow::Error::from)?;
    if encoded.len() > MAX_CAPABILITY_SNAPSHOT_BYTES {
        return Err(AppError::InvalidRequest(format!(
            "harness capability snapshot exceeds {MAX_CAPABILITY_SNAPSHOT_BYTES} bytes"
        )));
    }
    let digest = sha256(encoded.as_bytes());
    Ok((encoded, digest))
}

async fn derive_child_capability_snapshot(
    state: &AppState,
    parent: &HarnessRunRow,
    child_profile_name: &str,
    requested_capability_ids: &[String],
) -> AppResult<(String, String)> {
    if requested_capability_ids.len() > MAX_CHILD_CAPABILITIES {
        return Err(AppError::InvalidRequest(format!(
            "child capability subset exceeds {MAX_CHILD_CAPABILITIES} entries"
        )));
    }

    let mut requested = BTreeSet::new();
    for capability_id in requested_capability_ids {
        validate_capability_id(capability_id)?;
        if !requested.insert(capability_id.clone()) {
            return Err(AppError::InvalidRequest(format!(
                "duplicate child capability id `{capability_id}`"
            )));
        }
    }

    let mut parent_snapshot: serde_json::Value =
        serde_json::from_str(&parent.capability_snapshot_json).map_err(anyhow::Error::from)?;
    let (live_child_json, _) =
        capability::snapshot(state, &parent.workspace, child_profile_name).await?;
    let live_child: serde_json::Value =
        serde_json::from_str(&live_child_json).map_err(anyhow::Error::from)?;
    let parent_profile = snapshot_profile(&parent_snapshot)?.clone();
    let child_profile = snapshot_profile(&live_child)?.clone();
    ensure_profile_narrows(&parent_profile, &child_profile)?;

    let parent_capabilities = parent_snapshot
        .get("capabilities")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| AppError::InvalidRequest("parent capability snapshot is invalid".into()))?;
    let parent_ids = parent_capabilities
        .iter()
        .filter_map(|capability| capability.get("id").and_then(serde_json::Value::as_str))
        .collect::<BTreeSet<_>>();
    for capability_id in &requested {
        if !parent_ids.contains(capability_id.as_str()) {
            return Err(AppError::InvalidRequest(format!(
                "child capability `{capability_id}` is not present in the parent snapshot"
            )));
        }
    }

    let mut child_capabilities = Vec::new();
    for capability in parent_capabilities {
        let id = capability
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| AppError::InvalidRequest("parent capability id is invalid".into()))?;
        let class = capability
            .get("class")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| AppError::InvalidRequest("parent capability class is invalid".into()))?;
        if class != "kernel" && !requested.contains(id) {
            continue;
        }

        let parent_approval = capability
            .get("approval")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                AppError::InvalidRequest("parent capability approval is invalid".into())
            })?;
        let child_policy = profile_policy(&child_profile, class)?;
        let approval = stricter_policy(parent_approval, &child_policy)?;
        let parent_available = capability
            .get("available")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let mut narrowed = capability.clone();
        let object = narrowed
            .as_object_mut()
            .ok_or_else(|| AppError::InvalidRequest("parent capability entry is invalid".into()))?;
        object.insert(
            "approval".to_string(),
            serde_json::Value::String(approval.to_string()),
        );
        object.insert(
            "available".to_string(),
            serde_json::Value::Bool(parent_available && approval != "deny"),
        );
        child_capabilities.push(narrowed);
    }

    let object = parent_snapshot.as_object_mut().ok_or_else(|| {
        AppError::InvalidRequest("parent capability snapshot must be an object".into())
    })?;
    object.insert("profile".to_string(), child_profile);
    object.insert(
        "capabilities".to_string(),
        serde_json::Value::Array(child_capabilities),
    );
    encode_capability_snapshot(&parent_snapshot)
}

async fn refresh_restricted_capability_snapshot(
    state: &AppState,
    row: &HarnessRunRow,
) -> AppResult<(String, String)> {
    let stored: serde_json::Value =
        serde_json::from_str(&row.capability_snapshot_json).map_err(anyhow::Error::from)?;
    let (live_json, _) = capability::snapshot(state, &row.workspace, &row.profile).await?;
    let mut live: serde_json::Value =
        serde_json::from_str(&live_json).map_err(anyhow::Error::from)?;

    let stored_capabilities = stored
        .get("capabilities")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            AppError::InvalidRequest("stored child capability snapshot is invalid".into())
        })?;
    let live_capabilities = live
        .get("capabilities")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            AppError::InvalidRequest("current child capability snapshot is invalid".into())
        })?;
    let mut live_by_id = BTreeMap::new();
    for capability in live_capabilities {
        if let Some(id) = capability.get("id").and_then(serde_json::Value::as_str) {
            live_by_id.insert(id.to_string(), capability.clone());
        }
    }

    let mut restricted = Vec::new();
    for stored_capability in stored_capabilities {
        let id = stored_capability
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                AppError::InvalidRequest("stored child capability id is invalid".into())
            })?;
        let Some(mut current) = live_by_id.remove(id) else {
            continue;
        };
        let stored_approval = stored_capability
            .get("approval")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                AppError::InvalidRequest("stored child capability approval is invalid".into())
            })?;
        let live_approval = current
            .get("approval")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                AppError::InvalidRequest("current child capability approval is invalid".into())
            })?;
        let approval = stricter_policy(stored_approval, live_approval)?;
        let stored_available = stored_capability
            .get("available")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let live_available = current
            .get("available")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let object = current.as_object_mut().ok_or_else(|| {
            AppError::InvalidRequest("current child capability entry is invalid".into())
        })?;
        object.insert(
            "approval".to_string(),
            serde_json::Value::String(approval.to_string()),
        );
        object.insert(
            "available".to_string(),
            serde_json::Value::Bool(stored_available && live_available && approval != "deny"),
        );
        restricted.push(current);
    }

    let object = live.as_object_mut().ok_or_else(|| {
        AppError::InvalidRequest("current child capability snapshot must be an object".into())
    })?;
    object.insert(
        "capabilities".to_string(),
        serde_json::Value::Array(restricted),
    );
    encode_capability_snapshot(&live)
}

async fn capture_workspace_snapshot(
    state: &AppState,
    workspace_id: &str,
    profile: &str,
    sandbox: Option<&str>,
) -> AppResult<WorkspaceSnapshot> {
    let workspace = state.workspaces.get(workspace_id)?;
    let head = git::head(&workspace.root).await?;
    let (graph_version, indexed_head) = graph_state(state, workspace_id).await?;
    let (capability_snapshot_json, _) = capability::snapshot(state, workspace_id, profile).await?;
    let (capability_snapshot_json, capability_snapshot_sha256) =
        apply_sandbox_override(capability_snapshot_json, sandbox)?;
    Ok(WorkspaceSnapshot {
        head,
        graph_version,
        indexed_head,
        capability_snapshot_json,
        capability_snapshot_sha256,
    })
}

async fn capture_run_workspace_snapshot(
    state: &AppState,
    row: &HarnessRunRow,
) -> AppResult<WorkspaceSnapshot> {
    let workspace = state.workspaces.get(&row.workspace)?;
    let head = git::head(&workspace.root).await?;
    let (graph_version, indexed_head) = graph_state(state, &row.workspace).await?;
    let (capability_snapshot_json, capability_snapshot_sha256) = if row.parent_run_id.is_some() {
        refresh_restricted_capability_snapshot(state, row).await?
    } else {
        let (snapshot_json, _) = capability::snapshot(state, &row.workspace, &row.profile).await?;
        let sandbox = stored_sandbox_override(row)?;
        apply_sandbox_override(snapshot_json, sandbox.as_deref())?
    };
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
        "SELECT id, workspace_id, principal_id, client_request_id, profile, status, \
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

async fn allocate_event_seq_tx(tx: &mut Transaction<'_, Sqlite>, run_id: &str) -> AppResult<i64> {
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

fn freshness(row: &HarnessRunRow, current: &WorkspaceSnapshot) -> HarnessRunFreshness {
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

async fn child_summaries(
    state: &AppState,
    row: &HarnessRunRow,
) -> AppResult<(Vec<HarnessChildRunSummary>, bool)> {
    let mut rows: Vec<HarnessChildDbRow> = sqlx::query_as(
        "SELECT id, profile, status, parent_run_id, started_at, updated_at, completed_at \
         FROM harness_runs \
         WHERE parent_run_id=?1 AND principal_id=?2 \
         ORDER BY started_at, id LIMIT ?3",
    )
    .bind(&row.id)
    .bind(&row.principal_id)
    .bind((MAX_CHILD_SUMMARIES + 1) as i64)
    .fetch_all(&state.db)
    .await?;
    let truncated = rows.len() > MAX_CHILD_SUMMARIES;
    rows.truncate(MAX_CHILD_SUMMARIES);
    Ok((
        rows.into_iter()
            .map(
                |(id, profile, status, parent_run_id, started_at, updated_at, completed_at)| {
                    HarnessChildRunSummary {
                        id,
                        profile,
                        status,
                        parent_run_id,
                        started_at,
                        updated_at,
                        completed_at,
                    }
                },
            )
            .collect(),
        truncated,
    ))
}

async fn build_snapshot(
    state: &AppState,
    row: HarnessRunRow,
    current: WorkspaceSnapshot,
    persist_checkpoint: bool,
) -> AppResult<HarnessRunSnapshot> {
    let recovery = recovery::inspect(state, &row, &current, persist_checkpoint).await?;
    let row = if persist_checkpoint {
        load_run(state, &row.id).await?
    } else {
        row
    };
    let (children, children_truncated) = child_summaries(state, &row).await?;
    Ok(HarnessRunSnapshot {
        run: run_view(&row)?,
        freshness: freshness(&row, &current),
        recovery,
        children,
        children_truncated,
    })
}

async fn refresh_running_run(
    state: &AppState,
    mut row: HarnessRunRow,
) -> AppResult<(HarnessRunRow, WorkspaceSnapshot)> {
    let current = capture_run_workspace_snapshot(state, &row).await?;
    if row.status != "running" || stale_reason(&row, &current).is_none() {
        return Ok((row, current));
    }

    let _guard = state.mutation_lock.lock().await;
    row = load_run(state, &row.id).await?;
    if row.status != "running" {
        let current = capture_run_workspace_snapshot(state, &row).await?;
        return Ok((row, current));
    }
    let current = capture_run_workspace_snapshot(state, &row).await?;
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

async fn replay_existing(
    state: &AppState,
    run_id: String,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessRunBeginResult> {
    Ok(HarnessRunBeginResult {
        snapshot: get(
            state,
            HarnessRunIdRequest { run_id },
            principal_id,
            operator,
        )
        .await?,
        replayed: true,
    })
}

pub async fn begin(
    state: &AppState,
    req: HarnessRunBeginRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessRunBeginResult> {
    state.workspaces.get(&req.workspace)?;
    validate_profile(&req.profile)?;
    validate_root_sandbox_override(&req.profile, req.sandbox.as_deref())?;
    if let Some(client_request_id) = req.client_request_id.as_deref() {
        validate_client_request_id(client_request_id)?;
    }
    if req.parent_run_id.is_some() && req.sandbox.is_some() {
        return Err(AppError::InvalidRequest(
            "sandbox override is only supported for root harness runs".into(),
        ));
    }
    if req.parent_run_id.is_none() && req.capability_ids.is_some() {
        return Err(AppError::InvalidRequest(
            "capability_ids may only be supplied for a child harness run".into(),
        ));
    }
    if req.parent_run_id.is_some() && req.capability_ids.is_none() {
        return Err(AppError::InvalidRequest(
            "child harness run requires an explicit capability_ids subset".into(),
        ));
    }

    let parent = if let Some(parent_run_id) = req.parent_run_id.as_deref() {
        let parent = load_run(state, parent_run_id).await?;
        ensure_owner(&parent, principal_id, operator)?;
        if parent.workspace != req.workspace {
            return Err(AppError::InvalidRequest(
                "child harness run must inherit the parent workspace".into(),
            ));
        }
        Some(parent)
    } else {
        None
    };
    let effective_principal_id = parent
        .as_ref()
        .map(|parent| parent.principal_id.clone())
        .unwrap_or_else(|| principal_id.to_string());
    let fingerprint = request_fingerprint(&req)?;

    if let Some(client_request_id) = req.client_request_id.as_deref() {
        let existing: Option<(String, String)> = sqlx::query_as(
            "SELECT id, request_fingerprint FROM harness_runs \
             WHERE principal_id=?1 AND client_request_id=?2",
        )
        .bind(&effective_principal_id)
        .bind(client_request_id)
        .fetch_optional(&state.db)
        .await?;
        if let Some((run_id, existing_fingerprint)) = existing {
            if existing_fingerprint != fingerprint {
                return Err(AppError::InvalidRequest(
                    "client_request_id already exists with a different harness run request".into(),
                ));
            }
            return replay_existing(state, run_id, principal_id, operator).await;
        }
    }

    if let Some(parent) = parent {
        let (parent, current) = refresh_running_run(state, parent).await?;
        ensure_owner(&parent, principal_id, operator)?;
        if parent.status != "running" || stale_reason(&parent, &current).is_some() {
            return Err(AppError::InvalidRequest(format!(
                "parent harness run {} must be running and current before delegation",
                parent.id
            )));
        }
    }

    let _guard = state.mutation_lock.lock().await;

    if let Some(client_request_id) = req.client_request_id.as_deref() {
        let existing: Option<(String, String)> = sqlx::query_as(
            "SELECT id, request_fingerprint FROM harness_runs \
             WHERE principal_id=?1 AND client_request_id=?2",
        )
        .bind(&effective_principal_id)
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
            let current = capture_run_workspace_snapshot(state, &row).await?;
            return Ok(HarnessRunBeginResult {
                snapshot: build_snapshot(state, row, current, false).await?,
                replayed: true,
            });
        }
    }

    let (snapshot, parent_run_id) = if let Some(parent_run_id) = req.parent_run_id.as_deref() {
        let parent = load_run(state, parent_run_id).await?;
        ensure_owner(&parent, principal_id, operator)?;
        if parent.principal_id != effective_principal_id {
            return Err(AppError::InvalidRequest(
                "parent harness principal changed during child delegation".into(),
            ));
        }
        if parent.workspace != req.workspace {
            return Err(AppError::InvalidRequest(
                "child harness run must inherit the parent workspace".into(),
            ));
        }
        if parent.status != "running" {
            return Err(AppError::InvalidRequest(format!(
                "parent harness run {} must be running before delegation",
                parent.id
            )));
        }
        let parent_current = capture_run_workspace_snapshot(state, &parent).await?;
        if let Some(reason) = stale_reason(&parent, &parent_current) {
            return Err(AppError::InvalidRequest(format!(
                "parent harness run {} is stale: {reason}",
                parent.id
            )));
        }
        let capability_ids = req
            .capability_ids
            .as_deref()
            .expect("child capability subset validated above");
        let (capability_snapshot_json, capability_snapshot_sha256) =
            derive_child_capability_snapshot(state, &parent, &req.profile, capability_ids).await?;
        (
            WorkspaceSnapshot {
                head: parent_current.head,
                graph_version: parent_current.graph_version,
                indexed_head: parent_current.indexed_head,
                capability_snapshot_json,
                capability_snapshot_sha256,
            },
            Some(parent.id),
        )
    } else {
        (
            capture_workspace_snapshot(state, &req.workspace, &req.profile, req.sandbox.as_deref())
                .await?,
            None,
        )
    };

    let run_id = Uuid::new_v4().to_string();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO harness_runs(\
            id, workspace_id, principal_id, client_request_id, request_fingerprint, profile, status, \
            base_head, graph_version, indexed_head, capability_snapshot_json, capability_snapshot_sha256, \
            parent_run_id, next_event_seq, started_at, updated_at\
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7, ?8, ?9, ?10, ?11, ?12, 1, unixepoch(), unixepoch())",
    )
    .bind(&run_id)
    .bind(&req.workspace)
    .bind(&effective_principal_id)
    .bind(&req.client_request_id)
    .bind(&fingerprint)
    .bind(&req.profile)
    .bind(&snapshot.head)
    .bind(snapshot.graph_version)
    .bind(&snapshot.indexed_head)
    .bind(&snapshot.capability_snapshot_json)
    .bind(&snapshot.capability_snapshot_sha256)
    .bind(&parent_run_id)
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
            "sandbox": req.sandbox,
            "parent_run_id": parent_run_id,
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
        snapshot: build_snapshot(state, row, snapshot, false).await?,
        replayed: false,
    })
}

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
        sqlx::query_scalar("SELECT id FROM harness_runs ORDER BY updated_at DESC, id DESC LIMIT ?1")
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
    build_snapshot(state, row, current, false).await
}

pub async fn checkpoint(
    state: &AppState,
    req: HarnessRunIdRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessRunSnapshot> {
    let row = load_run(state, &req.run_id).await?;
    ensure_owner(&row, principal_id, operator)?;
    let (row, current) = refresh_running_run(state, row).await?;
    ensure_owner(&row, principal_id, operator)?;
    build_snapshot(state, row, current, true).await
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
        let current = capture_run_workspace_snapshot(state, &row).await?;
        return build_snapshot(state, row, current, false).await;
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
    let current = capture_run_workspace_snapshot(state, &row).await?;
    build_snapshot(state, row, current, false).await
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
        let current = capture_run_workspace_snapshot(state, &row).await?;
        return build_snapshot(state, row, current, false).await;
    }
    if row.status != "running" {
        return Err(AppError::InvalidRequest(format!(
            "harness run {} cannot complete from status {}",
            row.id, row.status
        )));
    }
    let current = capture_run_workspace_snapshot(state, &row).await?;
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
    build_snapshot(state, row, current, false).await
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
    fn root_fingerprint_remains_backward_compatible_and_child_binding_is_distinct() {
        let root = HarnessRunBeginRequest {
            workspace: "workspace".into(),
            profile: "interactive-local".into(),
            sandbox: None,
            client_request_id: Some("request".into()),
            parent_run_id: None,
            capability_ids: None,
        };
        let expected = sha256(
            serde_json::to_vec(&(&root.workspace, &root.profile))
                .expect("serialize legacy root fingerprint"),
        );
        assert_eq!(request_fingerprint(&root).unwrap(), expected);

        let mut child = root.clone();
        child.parent_run_id = Some("parent".into());
        child.capability_ids = Some(vec!["core.repository.read".into()]);
        assert_ne!(request_fingerprint(&child).unwrap(), expected);
    }

    #[test]
    fn profile_narrowing_orders_sandbox_and_policy_authority() {
        let parent = serde_json::json!({
            "sandbox": "workspace-write",
            "policies": {
                "read": "allow", "write": "allow", "exec": "allow",
                "git": "ask", "provider": "ask", "job": "allow"
            }
        });
        let tighter = serde_json::json!({
            "sandbox": "read-only",
            "policies": {
                "read": "allow", "write": "deny", "exec": "deny",
                "git": "deny", "provider": "deny", "job": "deny"
            }
        });
        assert!(ensure_profile_narrows(&parent, &tighter).is_ok());

        let wider = serde_json::json!({
            "sandbox": "workspace-write",
            "policies": {
                "read": "allow", "write": "allow", "exec": "allow",
                "git": "allow", "provider": "ask", "job": "allow"
            }
        });
        assert!(ensure_profile_narrows(&parent, &wider).is_err());
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
