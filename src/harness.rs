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

#[path = "harness_agent.rs"]
pub mod agent;
#[path = "harness_capability.rs"]
pub mod capability;
#[path = "harness_context_gate.rs"]
pub mod context_gate;
#[path = "harness_eval.rs"]
pub mod eval;
#[path = "harness_memory.rs"]
pub mod memory;
#[path = "harness_recovery.rs"]
pub mod recovery;
#[path = "harness_repository_context.rs"]
pub mod repository_context;

const MAX_CLIENT_REQUEST_ID_BYTES: usize = 128;
const MAX_EVENT_LIMIT: usize = 200;
const DEFAULT_EVENT_LIMIT: usize = 100;
const MAX_RUN_LIST_LIMIT: usize = 100;
const DEFAULT_RUN_LIST_LIMIT: usize = 50;
const MAX_CHILD_CAPABILITIES: usize = 4096;
const MAX_CAPABILITY_SNAPSHOT_BYTES: usize = 512 * 1024;
const MAX_CHILD_SUMMARIES: usize = 100;
const MAX_LEARNING_HINTS: usize = 5;

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
    pub origin: String,
    pub status: String,
    pub base_head: String,
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
    pub closed_loop: HarnessClosedLoopView,
    pub repository_context: repository_context::HarnessRepositoryContext,
    pub children: Vec<HarnessChildRunSummary>,
    pub children_truncated: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessLearningHint {
    pub tool: String,
    pub error_category: String,
    pub failures: i64,
    pub recoveries: i64,
    pub confirmations: i64,
    pub state: String,
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessClosedLoopView {
    pub phase: String,
    pub work_shape: String,
    pub work_scope: Option<String>,
    pub context_reads: i64,
    pub executions: i64,
    pub verification_required: bool,
    pub verification_status: String,
    pub recovery_status: String,
    pub selected_proof_type: Option<String>,
    pub selected_proof_source: Option<String>,
    pub selected_proof_command: Option<String>,
    pub satisfied_proofs: Vec<String>,
    pub failure_count: i64,
    pub learning_count: i64,
    pub last_failure_tool: Option<String>,
    pub last_failure_category: Option<String>,
    pub learning_hints: Vec<HarnessLearningHint>,
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
    origin: String,
    status: String,
    base_head: String,
    capability_snapshot_json: String,
    capability_snapshot_sha256: String,
    parent_run_id: Option<String>,
    stale_reason: Option<String>,
    started_at: i64,
    updated_at: i64,
    completed_at: Option<i64>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct HarnessRunDbRow {
    id: String,
    workspace_id: String,
    principal_id: String,
    client_request_id: Option<String>,
    profile: String,
    origin: String,
    status: String,
    base_head: String,
    #[sqlx(rename = "graph_version")]
    _graph_version: i64,
    #[sqlx(rename = "indexed_head")]
    _indexed_head: Option<String>,
    capability_snapshot_json: String,
    capability_snapshot_sha256: String,
    parent_run_id: Option<String>,
    stale_reason: Option<String>,
    started_at: i64,
    updated_at: i64,
    completed_at: Option<i64>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct HarnessVerificationDbRow {
    workspace_id: String,
    last_failure_tool: Option<String>,
    last_failure_category: Option<String>,
    recovery_status: String,
    work_shape: String,
    selected_proof_type: Option<String>,
    selected_proof_source: Option<String>,
}

type HarnessEventDbRow = (i64, String, String, i64);
type HarnessChildDbRow = (String, String, String, String, i64, i64, Option<i64>);
type HarnessLoopDbRow = (
    String,
    i64,
    i64,
    i64,
    String,
    String,
    i64,
    i64,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);
type HarnessLearningDbRow = (String, String, i64, i64, i64);

fn default_profile() -> String {
    capability::DEFAULT_PROFILE.to_string()
}

fn initial_work_shape(profile: &str) -> &'static str {
    match profile {
        "guarded-durable" | "background-job" | "webhook-automation" => "durable",
        _ => "read-only",
    }
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
        id: row.id,
        workspace: row.workspace_id,
        principal_id: row.principal_id,
        client_request_id: row.client_request_id,
        profile: row.profile,
        origin: row.origin,
        status: row.status,
        base_head: row.base_head,
        capability_snapshot_json: row.capability_snapshot_json,
        capability_snapshot_sha256: row.capability_snapshot_sha256,
        parent_run_id: row.parent_run_id,
        stale_reason: row.stale_reason,
        started_at: row.started_at,
        updated_at: row.updated_at,
        completed_at: row.completed_at,
    }
}

fn run_view(row: &HarnessRunRow) -> AppResult<HarnessRunView> {
    Ok(HarnessRunView {
        id: row.id.clone(),
        workspace: row.workspace.clone(),
        principal_id: row.principal_id.clone(),
        client_request_id: row.client_request_id.clone(),
        profile: row.profile.clone(),
        origin: row.origin.clone(),
        status: row.status.clone(),
        base_head: row.base_head.clone(),
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
    let (capability_snapshot_json, _) = capability::snapshot(state, workspace_id, profile).await?;
    let (capability_snapshot_json, capability_snapshot_sha256) =
        apply_sandbox_override(capability_snapshot_json, sandbox)?;
    Ok(WorkspaceSnapshot {
        head,
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
    let (capability_snapshot_json, capability_snapshot_sha256) = if row.parent_run_id.is_some() {
        refresh_restricted_capability_snapshot(state, row).await?
    } else {
        let (snapshot_json, _) = capability::snapshot(state, &row.workspace, &row.profile).await?;
        let sandbox = stored_sandbox_override(row)?;
        apply_sandbox_override(snapshot_json, sandbox.as_deref())?
    };
    Ok(WorkspaceSnapshot {
        head,
        capability_snapshot_json,
        capability_snapshot_sha256,
    })
}

async fn load_run(state: &AppState, run_id: &str) -> AppResult<HarnessRunRow> {
    let row: Option<HarnessRunDbRow> = sqlx::query_as(
        "SELECT id, workspace_id, principal_id, client_request_id, profile, origin, status, \
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HarnessLoopToolRole {
    Context,
    Execute,
    Verify,
    Ignore,
}

pub(crate) struct ClosedLoopToolStarted<'a> {
    pub(crate) tool: &'a str,
    pub(crate) role: HarnessLoopToolRole,
    pub(crate) work_shape: Option<&'a str>,
    pub(crate) work_scope: Option<&'a str>,
    pub(crate) selected_proof_type: Option<&'a str>,
    pub(crate) selected_proof_source: Option<&'a str>,
    pub(crate) selected_proof_command: Option<&'a str>,
    pub(crate) proof_type: Option<&'a str>,
}

pub(crate) struct ClosedLoopToolFinished<'a> {
    pub(crate) tool: &'a str,
    pub(crate) role: HarnessLoopToolRole,
    pub(crate) requires_verification: bool,
    pub(crate) proof_type: Option<&'a str>,
    pub(crate) proof_source: Option<&'a str>,
    pub(crate) success: bool,
    pub(crate) error_category: Option<&'a str>,
}

pub(crate) fn repository_context_note(
    context: &repository_context::HarnessRepositoryContext,
    learning_hints: &[HarnessLearningHint],
) -> String {
    fn compact(label: &str, values: &[String]) -> Option<String> {
        if values.is_empty() {
            return None;
        }
        Some(format!(
            "{label}: {}",
            values
                .iter()
                .take(6)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }

    let mut parts = Vec::new();
    if let Some(value) = compact("entrypoints", &context.entrypoints) {
        parts.push(value);
    }
    if let Some(value) = compact("guidance", &context.guidance) {
        parts.push(value);
    }
    if let Some(value) = compact("active plans", &context.active_plans) {
        parts.push(value);
    }
    if let Some(value) = compact("validation owners", &context.validation_owners) {
        parts.push(value);
    }
    if !context.proof_candidates.is_empty() {
        let proofs = context
            .proof_candidates
            .iter()
            .take(6)
            .map(|candidate| format!("{} via {}", candidate.proof_type, candidate.command))
            .collect::<Vec<_>>()
            .join(" | ");
        parts.push(format!("proof catalog: {proofs}"));
    }
    if !learning_hints.is_empty() {
        let hints = learning_hints
            .iter()
            .take(3)
            .map(|hint| hint.suggestion.clone())
            .collect::<Vec<_>>()
            .join(" | ");
        parts.push(format!("prior Harness learning: {hints}"));
    }
    if parts.is_empty() {
        return "Harness context: no conventional repository guidance or validation surfaces were discovered; inspect the smallest relevant source and proof surface before mutation.".to_string();
    }
    format!(
        "Harness context map (repository paths are candidates, not authority by filename alone): {}. Inspect only the smallest relevant surface before mutation.",
        parts.join("; ")
    )
}

fn learning_suggestion(
    tool: &str,
    error_category: &str,
    failures: i64,
    recoveries: i64,
    confirmations: i64,
) -> String {
    let action = match error_category {
        "protocol-error" => "check runtime/tool health before retrying the same operation",
        "sandbox-permission" => {
            "use a compatible sandbox or request the exact approved escalation instead of repeating the blocked command"
        }
        "command-exit" => {
            "inspect the command failure, change the implementation or inputs, then rerun verification"
        }
        "timeout" => {
            "reduce or split the operation, or use the bounded long-running process path before verifying again"
        }
        "tool-error" => {
            "inspect the failed result, adjust workspace state or inputs, then verify again"
        }
        "denied" => "use the allowed capability path instead of repeating a denied operation",
        _ => "inspect the failure evidence before retrying and require a fresh verification",
    };
    let freshness = if confirmations > 0 {
        format!("{confirmations} fresh-run validation(s)")
    } else {
        "fresh rerun pending".to_string()
    };
    format!(
        "{tool} failed {failures} time(s) with {error_category}; {recoveries} recovery/recoveries; {freshness}. Next time, {action}."
    )
}

async fn learning_hints(state: &AppState, workspace: &str) -> AppResult<Vec<HarnessLearningHint>> {
    let rows: Vec<HarnessLearningDbRow> = sqlx::query_as(
        "SELECT tool_name, error_category, failures, recoveries, confirmations \
         FROM harness_learning_patterns WHERE workspace_id=?1 \
         ORDER BY confirmations DESC, failures DESC, recoveries DESC, last_seen_at DESC LIMIT ?2",
    )
    .bind(workspace)
    .bind(MAX_LEARNING_HINTS as i64)
    .fetch_all(&state.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(tool, error_category, failures, recoveries, confirmations)| HarnessLearningHint {
                suggestion: learning_suggestion(
                    &tool,
                    &error_category,
                    failures,
                    recoveries,
                    confirmations,
                ),
                tool,
                error_category,
                failures,
                recoveries,
                confirmations,
                state: if confirmations > 0 {
                    "fresh-run-validated".to_string()
                } else {
                    "candidate".to_string()
                },
            },
        )
        .collect())
}

async fn closed_loop_view(
    state: &AppState,
    row: &HarnessRunRow,
    repository_context: &repository_context::HarnessRepositoryContext,
) -> AppResult<HarnessClosedLoopView> {
    let loop_row: HarnessLoopDbRow = sqlx::query_as(
        "SELECT phase, context_reads, executions, verification_required, verification_status, \
                recovery_status, failure_count, learning_count, last_failure_tool, last_failure_category, \
                work_shape, work_scope, selected_proof_type, selected_proof_source, selected_proof_command \
         FROM harness_run_loops WHERE run_id=?1",
    )
    .bind(&row.id)
    .fetch_one(&state.db)
    .await?;
    let (
        phase,
        context_reads,
        executions,
        verification_required,
        verification_status,
        recovery_status,
        failure_count,
        learning_count,
        last_failure_tool,
        last_failure_category,
        work_shape,
        work_scope,
        persisted_selected_proof_type,
        persisted_selected_proof_source,
        persisted_selected_proof_command,
    ) = loop_row;
    let selected_candidate = repository_context::select_proof_candidate(
        &work_shape,
        repository_context,
        work_scope.as_deref(),
    );
    let selected_proof_type = persisted_selected_proof_type
        .or_else(|| selected_candidate.map(|candidate| candidate.proof_type.clone()))
        .or_else(|| repository_context::select_proof_type(&work_shape, repository_context));
    let selected_proof_source = persisted_selected_proof_source
        .or_else(|| selected_candidate.map(|candidate| candidate.source.clone()));
    let selected_proof_command = persisted_selected_proof_command
        .or_else(|| selected_candidate.map(|candidate| candidate.command.clone()));
    let satisfied_proofs: Vec<String> = sqlx::query_scalar(
        "SELECT proof_type FROM harness_run_proofs WHERE run_id=?1 AND status='passed' ORDER BY proof_type",
    )
    .bind(&row.id)
    .fetch_all(&state.db)
    .await?;
    Ok(HarnessClosedLoopView {
        phase,
        work_shape,
        work_scope,
        context_reads,
        executions,
        verification_required: verification_required != 0,
        verification_status,
        recovery_status,
        selected_proof_type,
        selected_proof_source,
        selected_proof_command,
        satisfied_proofs,
        failure_count,
        learning_count,
        last_failure_tool,
        last_failure_category,
        learning_hints: learning_hints(state, &row.workspace).await?,
    })
}

async fn record_learning_failure_tx(
    tx: &mut Transaction<'_, Sqlite>,
    run_id: &str,
    workspace: &str,
    tool: &str,
    error_category: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO harness_learning_patterns(workspace_id, tool_name, error_category, failures, recoveries, last_seen_at) \
         VALUES(?1, ?2, ?3, 1, 0, unixepoch()) \
         ON CONFLICT(workspace_id, tool_name, error_category) DO UPDATE SET \
             failures=failures+1, last_seen_at=unixepoch()",
    )
    .bind(workspace)
    .bind(tool)
    .bind(error_category)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "UPDATE harness_run_learning_exposures SET outcome='failed', exercised_at=COALESCE(exercised_at, unixepoch()), completed_at=unixepoch() \
         WHERE run_id=?1 AND tool_name=?2 AND outcome IN ('pending', 'exercised')",
    )
    .bind(run_id)
    .bind(tool)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn exercise_learning_exposures_tx(
    tx: &mut Transaction<'_, Sqlite>,
    run_id: &str,
    tool: &str,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE harness_run_learning_exposures SET outcome='exercised', exercised_at=unixepoch() \
         WHERE run_id=?1 AND tool_name=?2 AND outcome='pending'",
    )
    .bind(run_id)
    .bind(tool)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn confirm_exercised_learning_tx(
    tx: &mut Transaction<'_, Sqlite>,
    run_id: &str,
    workspace: &str,
) -> AppResult<i64> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT tool_name, error_category FROM harness_run_learning_exposures \
         WHERE run_id=?1 AND outcome='exercised' ORDER BY tool_name, error_category",
    )
    .bind(run_id)
    .fetch_all(&mut **tx)
    .await?;
    if rows.is_empty() {
        return Ok(0);
    }
    for (tool, error_category) in &rows {
        sqlx::query(
            "UPDATE harness_learning_patterns SET confirmations=confirmations+1, last_confirmed_at=unixepoch() \
             WHERE workspace_id=?1 AND tool_name=?2 AND error_category=?3",
        )
        .bind(workspace)
        .bind(tool)
        .bind(error_category)
        .execute(&mut **tx)
        .await?;
    }
    sqlx::query(
        "UPDATE harness_run_learning_exposures SET outcome='passed', completed_at=unixepoch() \
         WHERE run_id=?1 AND outcome='exercised'",
    )
    .bind(run_id)
    .execute(&mut **tx)
    .await?;
    Ok(rows.len() as i64)
}

async fn record_learning_recovery_tx(
    tx: &mut Transaction<'_, Sqlite>,
    workspace: &str,
    tool: &str,
    error_category: &str,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE harness_learning_patterns SET recoveries=recoveries+1, last_recovered_at=unixepoch() \
         WHERE workspace_id=?1 AND tool_name=?2 AND error_category=?3",
    )
    .bind(workspace)
    .bind(tool)
    .bind(error_category)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn record_closed_loop_failure(
    state: &AppState,
    run_id: &str,
    tool: &str,
    error_category: Option<&str>,
    verification: bool,
) -> AppResult<()> {
    let category = error_category.unwrap_or("tool-error");
    let workspace: String = sqlx::query_scalar("SELECT workspace_id FROM harness_runs WHERE id=?1")
        .bind(run_id)
        .fetch_one(&state.db)
        .await?;
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE harness_run_loops SET phase='recover', recovery_status='needed', failure_count=failure_count+1, \
             verification_status=CASE WHEN ?1=1 THEN 'failed' ELSE verification_status END, \
             last_failure_tool=?2, last_failure_category=?3, updated_at=unixepoch() WHERE run_id=?4",
    )
    .bind(i64::from(verification))
    .bind(tool)
    .bind(category)
    .bind(run_id)
    .execute(&mut *tx)
    .await?;
    record_learning_failure_tx(&mut tx, run_id, &workspace, tool, category).await?;
    append_event_tx(
        &mut tx,
        run_id,
        "loop/recovery_needed",
        &serde_json::json!({
            "tool": tool,
            "error_category": category,
            "verification": verification,
        }),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn record_run_proof_tx(
    tx: &mut Transaction<'_, Sqlite>,
    run_id: &str,
    proof_type: &str,
    proof_source: Option<&str>,
    status: &str,
    tool: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO harness_run_proofs(run_id, proof_type, proof_source, status, tool_name, updated_at) \
         VALUES(?1, ?2, ?3, ?4, ?5, unixepoch()) \
         ON CONFLICT(run_id, proof_type) DO UPDATE SET \
             proof_source=excluded.proof_source, status=excluded.status, tool_name=excluded.tool_name, updated_at=unixepoch()",
    )
    .bind(run_id)
    .bind(proof_type)
    .bind(proof_source)
    .bind(status)
    .bind(tool)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(crate) async fn closed_loop_tool_started(
    state: &AppState,
    run_id: &str,
    input: ClosedLoopToolStarted<'_>,
) -> AppResult<()> {
    let ClosedLoopToolStarted {
        tool,
        role,
        work_shape,
        work_scope,
        selected_proof_type,
        selected_proof_source,
        selected_proof_command,
        proof_type,
    } = input;
    match role {
        HarnessLoopToolRole::Context | HarnessLoopToolRole::Ignore => return Ok(()),
        HarnessLoopToolRole::Verify => {
            let mut tx = state.db.begin().await?;
            sqlx::query(
                "UPDATE harness_run_loops SET phase='verify', verification_status='pending', updated_at=unixepoch() WHERE run_id=?1",
            )
            .bind(run_id)
            .execute(&mut *tx)
            .await?;
            append_event_tx(
                &mut tx,
                run_id,
                "loop/verify_started",
                &serde_json::json!({
                    "tool": tool,
                    "proof_type": proof_type,
                }),
            )
            .await?;
            tx.commit().await?;
        }
        HarnessLoopToolRole::Execute => {
            let current: (String, String) = sqlx::query_as(
                "SELECT recovery_status, work_shape FROM harness_run_loops WHERE run_id=?1",
            )
            .bind(run_id)
            .fetch_one(&state.db)
            .await?;
            let recovering = matches!(current.0.as_str(), "needed" | "in-progress");
            let shape_changed = work_shape.is_some_and(|shape| shape != current.1);
            let mut tx = state.db.begin().await?;
            sqlx::query(
                "UPDATE harness_run_loops SET phase=?1, executions=executions+1, \
                 recovery_status=CASE WHEN ?2=1 THEN 'in-progress' ELSE recovery_status END, \
                 work_shape=COALESCE(?3, work_shape), \
                 work_scope=CASE WHEN ?3 IS NULL THEN work_scope ELSE COALESCE(?4, work_scope) END, \
                 selected_proof_type=CASE WHEN ?3 IS NULL THEN selected_proof_type ELSE ?5 END, \
                 selected_proof_source=CASE WHEN ?3 IS NULL THEN selected_proof_source ELSE ?6 END, \
                 selected_proof_command=CASE WHEN ?3 IS NULL THEN selected_proof_command ELSE ?7 END, \
                 updated_at=unixepoch() WHERE run_id=?8",
            )
            .bind(if recovering { "recover" } else { "execute" })
            .bind(i64::from(recovering))
            .bind(work_shape)
            .bind(work_scope)
            .bind(selected_proof_type)
            .bind(selected_proof_source)
            .bind(selected_proof_command)
            .bind(run_id)
            .execute(&mut *tx)
            .await?;
            if shape_changed {
                append_event_tx(
                    &mut tx,
                    run_id,
                    "loop/work_shape_classified",
                    &serde_json::json!({
                        "work_shape": work_shape,
                        "work_scope": work_scope,
                        "selected_proof_type": selected_proof_type,
                        "selected_proof_source": selected_proof_source,
                    }),
                )
                .await?;
            }
            append_event_tx(
                &mut tx,
                run_id,
                if recovering {
                    "loop/recovery_started"
                } else {
                    "loop/execute_started"
                },
                &serde_json::json!({
                    "tool": tool,
                    "work_shape": work_shape,
                    "work_scope": work_scope,
                    "selected_proof_type": selected_proof_type,
                    "selected_proof_source": selected_proof_source,
                }),
            )
            .await?;
            tx.commit().await?;
        }
    }
    Ok(())
}

pub(crate) async fn closed_loop_tool_finished(
    state: &AppState,
    run_id: &str,
    input: ClosedLoopToolFinished<'_>,
) -> AppResult<()> {
    let ClosedLoopToolFinished {
        tool,
        role,
        requires_verification,
        proof_type,
        proof_source,
        success,
        error_category,
    } = input;
    if !success {
        if role == HarnessLoopToolRole::Verify
            && let Some(proof_type) = proof_type
        {
            let mut tx = state.db.begin().await?;
            record_run_proof_tx(&mut tx, run_id, proof_type, proof_source, "failed", tool).await?;
            append_event_tx(
                &mut tx,
                run_id,
                "loop/proof_recorded",
                &serde_json::json!({
                    "tool": tool,
                    "proof_type": proof_type,
                    "proof_source": proof_source,
                    "proof_status": "failed",
                }),
            )
            .await?;
            tx.commit().await?;
        }
        if matches!(
            role,
            HarnessLoopToolRole::Execute | HarnessLoopToolRole::Verify
        ) {
            record_closed_loop_failure(
                state,
                run_id,
                tool,
                error_category,
                role == HarnessLoopToolRole::Verify,
            )
            .await?;
        }
        return Ok(());
    }

    if matches!(
        role,
        HarnessLoopToolRole::Execute | HarnessLoopToolRole::Verify
    ) {
        let mut tx = state.db.begin().await?;
        exercise_learning_exposures_tx(&mut tx, run_id, tool).await?;
        tx.commit().await?;
    }

    match role {
        HarnessLoopToolRole::Ignore => {}
        HarnessLoopToolRole::Context => {
            sqlx::query(
                "UPDATE harness_run_loops SET context_reads=context_reads+1, \
                 phase=CASE WHEN phase='learn' THEN 'context' ELSE phase END, updated_at=unixepoch() WHERE run_id=?1",
            )
            .bind(run_id)
            .execute(&state.db)
            .await?;
        }
        HarnessLoopToolRole::Execute if requires_verification => {
            let mut tx = state.db.begin().await?;
            sqlx::query(
                "UPDATE harness_run_loops SET phase='verify', verification_required=1, verification_status='pending', updated_at=unixepoch() WHERE run_id=?1",
            )
            .bind(run_id)
            .execute(&mut *tx)
            .await?;
            let selected_proof_type: Option<String> = sqlx::query_scalar(
                "SELECT selected_proof_type FROM harness_run_loops WHERE run_id=?1",
            )
            .bind(run_id)
            .fetch_one(&mut *tx)
            .await?;
            append_event_tx(
                &mut tx,
                run_id,
                "loop/verify_required",
                &serde_json::json!({
                    "tool": tool,
                    "selected_proof_type": selected_proof_type,
                }),
            )
            .await?;
            tx.commit().await?;
        }
        HarnessLoopToolRole::Execute => {}
        HarnessLoopToolRole::Verify => {
            let row: HarnessVerificationDbRow = sqlx::query_as(
                    "SELECT r.workspace_id, l.last_failure_tool, l.last_failure_category, l.recovery_status, \
                            l.work_shape, l.selected_proof_type, l.selected_proof_source \
                     FROM harness_run_loops l JOIN harness_runs r ON r.id=l.run_id WHERE l.run_id=?1",
                )
                .bind(run_id)
                .fetch_one(&state.db)
                .await?;
            let recovered = matches!(row.recovery_status.as_str(), "needed" | "in-progress")
                && row.last_failure_tool.is_some()
                && row.last_failure_category.is_some();
            let mut tx = state.db.begin().await?;
            if let Some(proof_type) = proof_type {
                record_run_proof_tx(&mut tx, run_id, proof_type, proof_source, "passed", tool)
                    .await?;
                append_event_tx(
                    &mut tx,
                    run_id,
                    "loop/proof_recorded",
                    &serde_json::json!({
                        "tool": tool,
                        "proof_type": proof_type,
                        "proof_source": proof_source,
                        "proof_status": "passed",
                    }),
                )
                .await?;
            }

            let selected_proof_type = row.selected_proof_type.clone();
            let selected_proof_source = row.selected_proof_source.clone();
            let selected_proof_satisfied = if let Some(required) = selected_proof_type.as_deref() {
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM harness_run_proofs \
                     WHERE run_id=?1 AND proof_type=?2 AND status='passed' \
                       AND (?3 IS NULL OR proof_source=?3)",
                )
                .bind(run_id)
                .bind(required)
                .bind(selected_proof_source.as_deref())
                .fetch_one(&mut *tx)
                .await?
                    > 0
            } else {
                row.work_shape == "read-only"
            };

            if !selected_proof_satisfied {
                sqlx::query(
                    "UPDATE harness_run_loops SET phase='verify', verification_required=1, verification_status='pending', updated_at=unixepoch() WHERE run_id=?1",
                )
                .bind(run_id)
                .execute(&mut *tx)
                .await?;
                append_event_tx(
                    &mut tx,
                    run_id,
                    "loop/verify_pending",
                    &serde_json::json!({
                        "verification_tool": tool,
                        "proof_type": proof_type,
                        "proof_source": proof_source,
                        "selected_proof_type": selected_proof_type,
                        "selected_proof_source": selected_proof_source,
                    }),
                )
                .await?;
                tx.commit().await?;
                return Ok(());
            }

            if recovered {
                record_learning_recovery_tx(
                    &mut tx,
                    &row.workspace_id,
                    row.last_failure_tool
                        .as_deref()
                        .expect("recovered failure tool"),
                    row.last_failure_category
                        .as_deref()
                        .expect("recovered failure category"),
                )
                .await?;
            }
            let fresh_confirmations =
                confirm_exercised_learning_tx(&mut tx, run_id, &row.workspace_id).await?;
            sqlx::query(
                "UPDATE harness_run_loops SET phase='learn', verification_required=0, verification_status='passed', \
                 recovery_status=CASE WHEN ?1=1 THEN 'recovered' ELSE recovery_status END, \
                 learning_count=learning_count+1, updated_at=unixepoch() WHERE run_id=?2",
            )
            .bind(i64::from(recovered))
            .bind(run_id)
            .execute(&mut *tx)
            .await?;
            append_event_tx(
                &mut tx,
                run_id,
                "loop/verify_passed",
                &serde_json::json!({
                    "tool": tool,
                    "proof_type": proof_type,
                    "proof_source": proof_source,
                    "selected_proof_type": selected_proof_type,
                    "selected_proof_source": selected_proof_source,
                }),
            )
            .await?;
            if recovered {
                append_event_tx(
                    &mut tx,
                    run_id,
                    "loop/recovered",
                    &serde_json::json!({
                        "tool": row.last_failure_tool,
                        "error_category": row.last_failure_category,
                    }),
                )
                .await?;
            }
            append_event_tx(
                &mut tx,
                run_id,
                "loop/learned",
                &serde_json::json!({
                    "verification_tool": tool,
                    "proof_type": proof_type,
                    "proof_source": proof_source,
                    "selected_proof_type": selected_proof_type,
                    "selected_proof_source": selected_proof_source,
                    "recovered": recovered,
                    "fresh_confirmations": fresh_confirmations,
                }),
            )
            .await?;
            tx.commit().await?;
        }
    }
    Ok(())
}

fn stale_reason(row: &HarnessRunRow, current: &WorkspaceSnapshot) -> Option<&'static str> {
    if current.head != row.base_head {
        Some("git_head_changed")
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
    let workspace = state.workspaces.get(&row.workspace)?;
    let repository_context = repository_context::discover(&workspace.root);
    let closed_loop = closed_loop_view(state, &row, &repository_context).await?;
    let (children, children_truncated) = child_summaries(state, &row).await?;
    Ok(HarnessRunSnapshot {
        run: run_view(&row)?,
        freshness: freshness(&row, &current),
        recovery,
        closed_loop,
        repository_context,
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

pub async fn ensure_automatic(
    state: &AppState,
    workspace: &str,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessRunSnapshot> {
    state.workspaces.get(workspace)?;

    let candidates: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM harness_runs \
         WHERE workspace_id=?1 AND principal_id=?2 AND parent_run_id IS NULL AND status='running' \
         ORDER BY updated_at DESC, started_at DESC, id DESC LIMIT 32",
    )
    .bind(workspace)
    .bind(principal_id)
    .fetch_all(&state.db)
    .await?;

    for run_id in candidates {
        let snapshot = get(
            state,
            HarnessRunIdRequest { run_id },
            principal_id,
            operator,
        )
        .await?;
        if snapshot.run.status == "running" && snapshot.freshness.state == "current" {
            return Ok(snapshot);
        }
    }

    let created = begin(
        state,
        HarnessRunBeginRequest {
            workspace: workspace.to_string(),
            profile: capability::DEFAULT_PROFILE.to_string(),
            sandbox: None,
            client_request_id: None,
            parent_run_id: None,
            capability_ids: None,
        },
        principal_id,
        operator,
    )
    .await?;
    let created_id = created.snapshot.run.id.clone();

    let marked = sqlx::query(
        "UPDATE OR IGNORE harness_runs SET origin='automatic', updated_at=unixepoch() \
         WHERE id=?1 AND parent_run_id IS NULL AND status='running'",
    )
    .bind(&created_id)
    .execute(&state.db)
    .await?;

    if marked.rows_affected() == 1 {
        let mut tx = state.db.begin().await?;
        append_event_tx(
            &mut tx,
            &created_id,
            "run/automatic",
            &serde_json::json!({
                "workspace": workspace,
                "profile": capability::DEFAULT_PROFILE,
            }),
        )
        .await?;
        tx.commit().await?;
        return get(
            state,
            HarnessRunIdRequest { run_id: created_id },
            principal_id,
            operator,
        )
        .await;
    }

    let _ = cancel(
        state,
        HarnessRunIdRequest { run_id: created_id },
        principal_id,
        operator,
    )
    .await?;
    let winner: String = sqlx::query_scalar(
        "SELECT id FROM harness_runs \
         WHERE workspace_id=?1 AND principal_id=?2 AND origin='automatic' \
           AND parent_run_id IS NULL AND status='running' \
         ORDER BY updated_at DESC, started_at DESC, id DESC LIMIT 1",
    )
    .bind(workspace)
    .bind(principal_id)
    .fetch_one(&state.db)
    .await?;
    get(
        state,
        HarnessRunIdRequest { run_id: winner },
        principal_id,
        operator,
    )
    .await
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
    .bind(0_i64)
    .bind(Option::<String>::None)
    .bind(&snapshot.capability_snapshot_json)
    .bind(&snapshot.capability_snapshot_sha256)
    .bind(&parent_run_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE harness_run_loops SET work_shape=?1, updated_at=unixepoch() WHERE run_id=?2",
    )
    .bind(initial_work_shape(&req.profile))
    .bind(&run_id)
    .execute(&mut *tx)
    .await?;
    if parent_run_id.is_none() {
        sqlx::query(
            "INSERT INTO harness_run_learning_exposures(run_id, tool_name, error_category, outcome, exposed_at) \
             SELECT ?1, tool_name, error_category, 'pending', unixepoch() \
             FROM harness_learning_patterns WHERE workspace_id=?2 \
             ORDER BY confirmations DESC, failures DESC, recoveries DESC, last_seen_at DESC LIMIT ?3",
        )
        .bind(&run_id)
        .bind(&req.workspace)
        .bind(MAX_LEARNING_HINTS as i64)
        .execute(&mut *tx)
        .await?;
    }
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
    let workspace = state.workspaces.get(&row.workspace)?;
    let repository_context = repository_context::discover(&workspace.root);
    let loop_state = closed_loop_view(state, &row, &repository_context).await?;
    if loop_state.verification_required {
        return Err(AppError::InvalidRequest(format!(
            "harness run {} cannot complete while verification is required",
            row.id
        )));
    }
    if matches!(
        loop_state.recovery_status.as_str(),
        "needed" | "in-progress"
    ) {
        return Err(AppError::InvalidRequest(format!(
            "harness run {} cannot complete while recovery is unresolved",
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
        child.capability_ids = Some(vec!["core.context.read".into()]);
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
