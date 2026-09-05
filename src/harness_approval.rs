use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    harness::{self, HarnessRunIdRequest},
    service::AppState,
};

pub const APPROVAL_TTL_SECONDS: i64 = 5 * 60;
const DEFAULT_LIST_LIMIT: usize = 100;
const MAX_LIST_LIMIT: usize = 200;
const MAX_NATIVE_REQUEST_ID_BYTES: usize = 128;
const MAX_NATIVE_PAYLOAD_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessApprovalListRequest {
    pub run_id: String,
    pub status: Option<String>,
    #[serde(default = "default_list_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessApprovalRespondRequest {
    pub approval_id: String,
    pub decision: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct HarnessNativeApprovalResolveRequest {
    pub run_id: String,
    pub request_id: String,
    pub method: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessNativeApprovalResolveResult {
    pub decision: String,
    pub approval: HarnessApprovalView,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema, PartialEq, Eq)]
pub struct HarnessApprovalView {
    pub id: String,
    pub run_id: String,
    pub principal_id: String,
    pub workspace: String,
    pub tool: String,
    pub capability_id: String,
    pub argument_sha256: String,
    pub head_sha: String,
    pub policy: String,
    pub status: String,
    pub requested_execution_id: Option<String>,
    pub requested_at: i64,
    pub expires_at: i64,
    pub resolved_at: Option<i64>,
    pub resolved_by: Option<String>,
    pub consumed_at: Option<i64>,
    pub external_request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessApprovalListResult {
    pub run_id: String,
    pub approvals: Vec<HarnessApprovalView>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HarnessApprovalRespondResult {
    pub approval: HarnessApprovalView,
    pub replayed: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ApprovalIntent {
    pub run_id: String,
    pub principal_id: String,
    pub workspace: String,
    pub tool: String,
    pub capability_id: String,
    pub argument_sha256: String,
    pub head_sha: String,
}

#[derive(Debug, sqlx::FromRow)]
struct ApprovalDbRow {
    id: String,
    run_id: String,
    principal_id: String,
    workspace_id: String,
    tool_name: String,
    capability_id: String,
    argument_sha256: String,
    head_sha: String,
    policy: String,
    status: String,
    requested_execution_id: Option<String>,
    requested_at: i64,
    expires_at: i64,
    resolved_at: Option<i64>,
    resolved_by: Option<String>,
    consumed_at: Option<i64>,
    external_request_id: Option<String>,
}

fn default_list_limit() -> usize {
    DEFAULT_LIST_LIMIT
}

fn row_to_view(row: ApprovalDbRow) -> HarnessApprovalView {
    HarnessApprovalView {
        id: row.id,
        run_id: row.run_id,
        principal_id: row.principal_id,
        workspace: row.workspace_id,
        tool: row.tool_name,
        capability_id: row.capability_id,
        argument_sha256: row.argument_sha256,
        head_sha: row.head_sha,
        policy: row.policy,
        status: row.status,
        requested_execution_id: row.requested_execution_id,
        requested_at: row.requested_at,
        expires_at: row.expires_at,
        resolved_at: row.resolved_at,
        resolved_by: row.resolved_by,
        consumed_at: row.consumed_at,
        external_request_id: row.external_request_id,
    }
}

fn validate_status(status: &str) -> AppResult<()> {
    if matches!(
        status,
        "pending" | "allowed" | "denied" | "consumed" | "expired"
    ) {
        Ok(())
    } else {
        Err(AppError::InvalidRequest(format!(
            "unsupported harness approval status `{status}`"
        )))
    }
}

fn decision_status(decision: &str) -> AppResult<&'static str> {
    match decision {
        "allow" => Ok("allowed"),
        "deny" => Ok("denied"),
        other => Err(AppError::InvalidRequest(format!(
            "unsupported harness approval decision `{other}`; expected allow or deny"
        ))),
    }
}

async fn append_event_tx(
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

async fn expire_for_run(state: &AppState, run_id: &str) -> AppResult<()> {
    sqlx::query(
        "UPDATE harness_approvals SET status='expired', resolved_at=COALESCE(resolved_at, unixepoch()) \
         WHERE run_id=?1 AND status IN ('pending', 'allowed') AND expires_at <= unixepoch()",
    )
    .bind(run_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn load(state: &AppState, approval_id: &str) -> AppResult<HarnessApprovalView> {
    let row: Option<ApprovalDbRow> = sqlx::query_as(
        "SELECT id, run_id, principal_id, workspace_id, tool_name, capability_id, argument_sha256, \
                head_sha, policy, status, requested_execution_id, requested_at, expires_at, \
                resolved_at, resolved_by, consumed_at, external_request_id \
         FROM harness_approvals WHERE id=?1",
    )
    .bind(approval_id)
    .fetch_optional(&state.db)
    .await?;
    row.map(row_to_view).ok_or_else(|| {
        AppError::InvalidRequest(format!("harness approval not found: {approval_id}"))
    })
}

fn ensure_owner(
    approval: &HarnessApprovalView,
    principal_id: &str,
    operator: bool,
) -> AppResult<()> {
    if operator || approval.principal_id == principal_id {
        Ok(())
    } else {
        Err(AppError::InvalidRequest(format!(
            "harness approval not found: {}",
            approval.id
        )))
    }
}

pub(crate) async fn request_pending(
    state: &AppState,
    intent: &ApprovalIntent,
    execution_id: Option<&str>,
    external_request_id: Option<&str>,
) -> AppResult<(HarnessApprovalView, bool)> {
    expire_for_run(state, &intent.run_id).await?;
    let existing: Option<ApprovalDbRow> = sqlx::query_as(
        "SELECT id, run_id, principal_id, workspace_id, tool_name, capability_id, argument_sha256, \
                head_sha, policy, status, requested_execution_id, requested_at, expires_at, \
                resolved_at, resolved_by, consumed_at, external_request_id \
         FROM harness_approvals \
         WHERE run_id=?1 AND principal_id=?2 AND workspace_id=?3 AND tool_name=?4 \
           AND capability_id=?5 AND argument_sha256=?6 AND head_sha=?7 \
           AND status='pending' AND expires_at > unixepoch() \
         ORDER BY requested_at DESC, id DESC LIMIT 1",
    )
    .bind(&intent.run_id)
    .bind(&intent.principal_id)
    .bind(&intent.workspace)
    .bind(&intent.tool)
    .bind(&intent.capability_id)
    .bind(&intent.argument_sha256)
    .bind(&intent.head_sha)
    .fetch_optional(&state.db)
    .await?;
    if let Some(row) = existing {
        return Ok((row_to_view(row), false));
    }

    let id = Uuid::new_v4().to_string();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO harness_approvals(\
            id, run_id, principal_id, workspace_id, tool_name, capability_id, argument_sha256, \
            head_sha, policy, status, requested_execution_id, external_request_id, expires_at\
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'ask', 'pending', ?9, ?10, unixepoch()+?11)",
    )
    .bind(&id)
    .bind(&intent.run_id)
    .bind(&intent.principal_id)
    .bind(&intent.workspace)
    .bind(&intent.tool)
    .bind(&intent.capability_id)
    .bind(&intent.argument_sha256)
    .bind(&intent.head_sha)
    .bind(execution_id)
    .bind(external_request_id)
    .bind(APPROVAL_TTL_SECONDS)
    .execute(&mut *tx)
    .await?;
    append_event_tx(
        &mut tx,
        &intent.run_id,
        "approval/requested",
        &serde_json::json!({
            "approval_id": id,
            "execution_id": execution_id,
            "external_request_id": external_request_id,
            "tool": intent.tool,
            "capability_id": intent.capability_id,
            "argument_sha256": intent.argument_sha256,
            "workspace": intent.workspace,
            "head_sha": intent.head_sha,
            "expires_in_seconds": APPROVAL_TTL_SECONDS,
        }),
    )
    .await?;
    tx.commit().await?;
    Ok((load(state, &id).await?, true))
}

pub(crate) async fn consume_matching(
    state: &AppState,
    intent: &ApprovalIntent,
) -> AppResult<Option<String>> {
    expire_for_run(state, &intent.run_id).await?;
    let candidate: Option<String> = sqlx::query_scalar(
        "SELECT id FROM harness_approvals \
         WHERE run_id=?1 AND principal_id=?2 AND workspace_id=?3 AND tool_name=?4 \
           AND capability_id=?5 AND argument_sha256=?6 AND head_sha=?7 \
           AND status='allowed' AND expires_at > unixepoch() \
         ORDER BY resolved_at DESC, id DESC LIMIT 1",
    )
    .bind(&intent.run_id)
    .bind(&intent.principal_id)
    .bind(&intent.workspace)
    .bind(&intent.tool)
    .bind(&intent.capability_id)
    .bind(&intent.argument_sha256)
    .bind(&intent.head_sha)
    .fetch_optional(&state.db)
    .await?;
    let Some(id) = candidate else {
        return Ok(None);
    };
    let result = sqlx::query(
        "UPDATE harness_approvals SET status='consumed', consumed_at=unixepoch() \
         WHERE id=?1 AND status='allowed' AND expires_at > unixepoch()",
    )
    .bind(&id)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 1 {
        Ok(Some(id))
    } else {
        Ok(None)
    }
}

#[derive(Debug)]
struct NativeApprovalTarget {
    tool: &'static str,
    capability_id: &'static str,
    required_capabilities: &'static [&'static str],
}

fn bounded_native_text(value: &str, label: &str, max_bytes: usize) -> AppResult<()> {
    if value.is_empty()
        || value.len() > max_bytes
        || value
            .chars()
            .any(|ch| ch == '\0' || ch == '\r' || ch == '\n')
    {
        return Err(AppError::InvalidRequest(format!("{label} is invalid")));
    }
    Ok(())
}

fn payload_object<'a>(
    payload: &'a serde_json::Value,
    label: &str,
) -> AppResult<&'a serde_json::Map<String, serde_json::Value>> {
    payload
        .as_object()
        .ok_or_else(|| AppError::InvalidRequest(format!("{label} payload is invalid")))
}

fn bounded_payload_id(
    payload: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> AppResult<()> {
    let value = payload
        .get(key)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            AppError::InvalidRequest(format!("Codex native approval {key} is invalid"))
        })?;
    bounded_native_text(value, &format!("Codex native approval {key}"), 256)
}

fn is_protected_native_command(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    if lower.contains(".git/") || lower.contains(".git\\") || lower.contains("git_dir") {
        return true;
    }
    lower
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'))
        .any(|token| matches!(token, "git" | "gh" | "glab" | "github" | "gitlab"))
}

fn path_is_within_workspace(root: &std::path::Path, candidate: &str) -> bool {
    use std::path::Component;
    let path = std::path::Path::new(candidate);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return false;
    }
    let Ok(root) = std::fs::canonicalize(root) else {
        return false;
    };
    let Ok(path) = std::fs::canonicalize(path) else {
        return false;
    };
    path.starts_with(root)
}

fn validate_file_system_permissions(
    root: &std::path::Path,
    file_system: &serde_json::Value,
) -> AppResult<bool> {
    if file_system.is_null() {
        return Ok(false);
    }
    let object = payload_object(file_system, "Codex file-system permission")?;
    let mut requested = false;
    for key in ["read", "write"] {
        let Some(value) = object.get(key) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        let paths = value.as_array().ok_or_else(|| {
            AppError::InvalidRequest(format!(
                "Codex file-system permission {key} list is invalid"
            ))
        })?;
        if paths.len() > 64 {
            return Err(AppError::InvalidRequest(
                "Codex file-system permission list is too large".into(),
            ));
        }
        for path in paths {
            let path = path.as_str().ok_or_else(|| {
                AppError::InvalidRequest("Codex file-system permission path is invalid".into())
            })?;
            if !path_is_within_workspace(root, path) {
                return Err(AppError::InvalidRequest("Codex native permission cannot widen file-system access outside the managed workspace".into()));
            }
            requested = true;
        }
    }
    if let Some(entries) = object.get("entries") {
        let entries = entries.as_array().ok_or_else(|| {
            AppError::InvalidRequest("Codex file-system permission entries are invalid".into())
        })?;
        if entries.len() > 64 {
            return Err(AppError::InvalidRequest(
                "Codex file-system permission entries are too large".into(),
            ));
        }
        for entry in entries {
            let entry = payload_object(entry, "Codex file-system permission entry")?;
            let access = entry
                .get("access")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    AppError::InvalidRequest(
                        "Codex file-system permission access is invalid".into(),
                    )
                })?;
            if !matches!(access, "read" | "write" | "deny") {
                return Err(AppError::InvalidRequest(
                    "Codex file-system permission access is invalid".into(),
                ));
            }
            let path = payload_object(
                entry.get("path").ok_or_else(|| {
                    AppError::InvalidRequest("Codex file-system permission path is missing".into())
                })?,
                "Codex file-system permission path",
            )?;
            if path.get("type").and_then(serde_json::Value::as_str) != Some("path") {
                return Err(AppError::InvalidRequest(
                    "Codex native permission does not allow glob or special file-system escalation"
                        .into(),
                ));
            }
            let raw = path
                .get("path")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    AppError::InvalidRequest("Codex file-system permission path is invalid".into())
                })?;
            if !path_is_within_workspace(root, raw) {
                return Err(AppError::InvalidRequest("Codex native permission cannot widen file-system access outside the managed workspace".into()));
            }
            requested = true;
        }
    }
    Ok(requested)
}

fn classify_native_request(
    method: &str,
    payload: &serde_json::Value,
    workspace_root: &std::path::Path,
) -> AppResult<NativeApprovalTarget> {
    let object = payload_object(payload, "Codex native approval")?;
    for key in ["threadId", "turnId", "itemId"] {
        bounded_payload_id(object, key)?;
    }
    match method {
        "item/commandExecution/requestApproval" => {
            let command = object
                .get("command")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    AppError::InvalidRequest(
                        "Codex command approval is missing the exact command".into(),
                    )
                })?;
            if command.is_empty() || command.len() > 32 * 1024 || command.contains('\0') {
                return Err(AppError::InvalidRequest(
                    "Codex command approval command is invalid".into(),
                ));
            }
            if is_protected_native_command(command) {
                return Err(AppError::InvalidRequest(
                    "Codex native Git/provider mutation escalation is blocked; use the guarded SourceNerve Git/provider workflow".into(),
                ));
            }
            Ok(NativeApprovalTarget {
                tool: "codex_native_command_execution",
                capability_id: "core.workspace.exec",
                required_capabilities: &["core.workspace.exec"],
            })
        }
        "item/fileChange/requestApproval" => {
            let grant_root = object
                .get("grantRoot")
                .filter(|value| !value.is_null())
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    AppError::InvalidRequest(
                        "Codex native file-change approval requires an explicit bounded grant root"
                            .into(),
                    )
                })?;
            if !path_is_within_workspace(workspace_root, grant_root) {
                return Err(AppError::InvalidRequest("Codex native file-change escalation cannot widen writes outside the managed workspace".into()));
            }
            Ok(NativeApprovalTarget {
                tool: "codex_native_file_change",
                capability_id: "core.files.write",
                required_capabilities: &["core.files.write"],
            })
        }
        "item/permissions/requestApproval" => {
            let permissions = payload_object(
                object.get("permissions").ok_or_else(|| {
                    AppError::InvalidRequest(
                        "Codex permission approval is missing permissions".into(),
                    )
                })?,
                "Codex permission approval",
            )?;
            let network = permissions
                .get("network")
                .filter(|value| !value.is_null())
                .and_then(serde_json::Value::as_object)
                .and_then(|value| value.get("enabled"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let files = validate_file_system_permissions(
                workspace_root,
                permissions
                    .get("fileSystem")
                    .unwrap_or(&serde_json::Value::Null),
            )?;
            if !network && !files {
                return Err(AppError::InvalidRequest(
                    "Codex permission approval does not request a supported escalation".into(),
                ));
            }
            Ok(if network && files {
                NativeApprovalTarget {
                    tool: "codex_native_permissions",
                    capability_id: "core.workspace.exec",
                    required_capabilities: &["core.workspace.exec", "core.files.write"],
                }
            } else if network {
                NativeApprovalTarget {
                    tool: "codex_native_permissions",
                    capability_id: "core.workspace.exec",
                    required_capabilities: &["core.workspace.exec"],
                }
            } else {
                NativeApprovalTarget {
                    tool: "codex_native_permissions",
                    capability_id: "core.files.write",
                    required_capabilities: &["core.files.write"],
                }
            })
        }
        _ => Err(AppError::InvalidRequest(format!(
            "unsupported Codex native approval method `{method}`"
        ))),
    }
}

fn ensure_native_capabilities(snapshot: &serde_json::Value, required: &[&str]) -> AppResult<()> {
    let capabilities = snapshot
        .get("capabilities")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            AppError::InvalidRequest(
                "Harness capability snapshot is missing native approval capabilities".into(),
            )
        })?;
    for required_id in required {
        let capability = capabilities
            .iter()
            .find(|value| value.get("id").and_then(serde_json::Value::as_str) == Some(*required_id))
            .ok_or_else(|| {
                AppError::InvalidRequest(format!(
                    "Harness capability `{required_id}` is unavailable for Codex native approval"
                ))
            })?;
        let available = capability
            .get("available")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let approval = capability
            .get("approval")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("deny");
        if !available || approval == "deny" {
            return Err(AppError::InvalidRequest(format!(
                "Harness capability `{required_id}` denies Codex native approval"
            )));
        }
    }
    Ok(())
}

fn canonical_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(canonical_json).collect())
        }
        serde_json::Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();
            let mut canonical = serde_json::Map::new();
            for key in keys {
                canonical.insert(key.clone(), canonical_json(&object[key]));
            }
            serde_json::Value::Object(canonical)
        }
        other => other.clone(),
    }
}

fn native_argument_sha256(request: &HarnessNativeApprovalResolveRequest) -> AppResult<String> {
    bounded_native_text(&request.run_id, "Codex native approval run id", 128)?;
    bounded_native_text(
        &request.request_id,
        "Codex native approval request id",
        MAX_NATIVE_REQUEST_ID_BYTES,
    )?;
    bounded_native_text(&request.method, "Codex native approval method", 128)?;
    let canonical = serde_json::json!({
        "request_id": request.request_id,
        "method": request.method,
        "payload": canonical_json(&request.payload),
    });
    let bytes = serde_json::to_vec(&canonical).map_err(anyhow::Error::from)?;
    if bytes.len() > MAX_NATIVE_PAYLOAD_BYTES {
        return Err(AppError::InvalidRequest(
            "Codex native approval payload exceeds 64 KiB".into(),
        ));
    }
    Ok(hex::encode(Sha256::digest(bytes)))
}

async fn latest_matching(
    state: &AppState,
    intent: &ApprovalIntent,
) -> AppResult<Option<HarnessApprovalView>> {
    expire_for_run(state, &intent.run_id).await?;
    let row: Option<ApprovalDbRow> = sqlx::query_as(
        "SELECT id, run_id, principal_id, workspace_id, tool_name, capability_id, argument_sha256, \
                head_sha, policy, status, requested_execution_id, requested_at, expires_at, \
                resolved_at, resolved_by, consumed_at, external_request_id \
         FROM harness_approvals \
         WHERE run_id=?1 AND principal_id=?2 AND workspace_id=?3 AND tool_name=?4 \
           AND capability_id=?5 AND argument_sha256=?6 AND head_sha=?7 \
         ORDER BY requested_at DESC, id DESC LIMIT 1",
    )
    .bind(&intent.run_id)
    .bind(&intent.principal_id)
    .bind(&intent.workspace)
    .bind(&intent.tool)
    .bind(&intent.capability_id)
    .bind(&intent.argument_sha256)
    .bind(&intent.head_sha)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(row_to_view))
}

pub async fn resolve_native(
    state: &AppState,
    request: HarnessNativeApprovalResolveRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessNativeApprovalResolveResult> {
    let argument_sha256 = native_argument_sha256(&request)?;
    let snapshot = harness::get(
        state,
        HarnessRunIdRequest {
            run_id: request.run_id.clone(),
        },
        principal_id,
        operator,
    )
    .await?;
    if snapshot.run.status != "running" || snapshot.freshness.state != "current" {
        return Err(AppError::InvalidRequest(
            "Codex native approval requires a current running Harness run".into(),
        ));
    }
    let workspace = state.workspaces.get(&snapshot.run.workspace)?;
    let target = classify_native_request(&request.method, &request.payload, &workspace.root)?;
    ensure_native_capabilities(
        &snapshot.run.capability_snapshot,
        target.required_capabilities,
    )?;
    let intent = ApprovalIntent {
        run_id: snapshot.run.id.clone(),
        principal_id: snapshot.run.principal_id.clone(),
        workspace: snapshot.run.workspace.clone(),
        tool: target.tool.to_string(),
        capability_id: target.capability_id.to_string(),
        argument_sha256,
        head_sha: snapshot.freshness.current_head.clone(),
    };

    if let Some(existing) = latest_matching(state, &intent).await? {
        match existing.status.as_str() {
            "allowed" => {
                if let Some(approval_id) = consume_matching(state, &intent).await? {
                    let approval = load(state, &approval_id).await?;
                    let mut tx = state.db.begin().await?;
                    append_event_tx(
                        &mut tx,
                        &intent.run_id,
                        "approval/consumed",
                        &serde_json::json!({
                            "approval_id": approval.id,
                            "tool": approval.tool,
                            "capability_id": approval.capability_id,
                            "argument_sha256": approval.argument_sha256,
                            "workspace": approval.workspace,
                            "head_sha": approval.head_sha,
                            "source": "codex-native",
                        }),
                    )
                    .await?;
                    tx.commit().await?;
                    return Ok(HarnessNativeApprovalResolveResult {
                        decision: "allow".into(),
                        approval,
                        created: false,
                    });
                }
                let approval = latest_matching(state, &intent).await?.ok_or_else(|| {
                    AppError::InvalidRequest(
                        "Codex native approval disappeared during consumption".into(),
                    )
                })?;
                return Ok(HarnessNativeApprovalResolveResult {
                    decision: "deny".into(),
                    approval,
                    created: false,
                });
            }
            "pending" => {
                return Ok(HarnessNativeApprovalResolveResult {
                    decision: "pending".into(),
                    approval: existing,
                    created: false,
                });
            }
            "denied" | "expired" | "consumed" => {
                return Ok(HarnessNativeApprovalResolveResult {
                    decision: "deny".into(),
                    approval: existing,
                    created: false,
                });
            }
            _ => {
                return Err(AppError::InvalidRequest(
                    "Codex native approval has an invalid durable state".into(),
                ));
            }
        }
    }

    let (approval, created) =
        request_pending(state, &intent, None, Some(&request.request_id)).await?;
    Ok(HarnessNativeApprovalResolveResult {
        decision: "pending".into(),
        approval,
        created,
    })
}

pub async fn list(
    state: &AppState,
    request: HarnessApprovalListRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessApprovalListResult> {
    if request.limit == 0 || request.limit > MAX_LIST_LIMIT {
        return Err(AppError::InvalidRequest(format!(
            "harness approval list limit must be 1-{MAX_LIST_LIMIT}"
        )));
    }
    if let Some(status) = request.status.as_deref() {
        validate_status(status)?;
    }
    let owner: Option<String> =
        sqlx::query_scalar("SELECT principal_id FROM harness_runs WHERE id=?1")
            .bind(&request.run_id)
            .fetch_optional(&state.db)
            .await?;
    let owner = owner.ok_or_else(|| {
        AppError::InvalidRequest(format!("harness run not found: {}", request.run_id))
    })?;
    if !operator && owner != principal_id {
        return Err(AppError::InvalidRequest(format!(
            "harness run not found: {}",
            request.run_id
        )));
    }
    expire_for_run(state, &request.run_id).await?;
    let rows: Vec<ApprovalDbRow> = sqlx::query_as(
        "SELECT id, run_id, principal_id, workspace_id, tool_name, capability_id, argument_sha256, \
                head_sha, policy, status, requested_execution_id, requested_at, expires_at, \
                resolved_at, resolved_by, consumed_at, external_request_id \
         FROM harness_approvals \
         WHERE run_id=?1 AND (?2 IS NULL OR status=?2) \
         ORDER BY requested_at DESC, id DESC LIMIT ?3",
    )
    .bind(&request.run_id)
    .bind(request.status.as_deref())
    .bind(request.limit as i64)
    .fetch_all(&state.db)
    .await?;
    Ok(HarnessApprovalListResult {
        run_id: request.run_id,
        approvals: rows.into_iter().map(row_to_view).collect(),
    })
}

pub async fn respond(
    state: &AppState,
    request: HarnessApprovalRespondRequest,
    principal_id: &str,
    operator: bool,
) -> AppResult<HarnessApprovalRespondResult> {
    let target_status = decision_status(&request.decision)?;
    let mut approval = load(state, &request.approval_id).await?;
    ensure_owner(&approval, principal_id, operator)?;
    expire_for_run(state, &approval.run_id).await?;
    approval = load(state, &request.approval_id).await?;
    ensure_owner(&approval, principal_id, operator)?;

    if approval.status == target_status {
        return Ok(HarnessApprovalRespondResult {
            approval,
            replayed: true,
        });
    }
    if approval.status == "expired" {
        return Err(AppError::InvalidRequest(format!(
            "harness approval {} has expired",
            approval.id
        )));
    }
    if approval.status != "pending" {
        return Err(AppError::InvalidRequest(format!(
            "harness approval {} is already {}",
            approval.id, approval.status
        )));
    }

    let resolver = if operator {
        "operator".to_string()
    } else {
        principal_id.to_string()
    };
    let mut tx = state.db.begin().await?;
    let result = sqlx::query(
        "UPDATE harness_approvals SET status=?1, resolved_by=?2, resolved_at=unixepoch() \
         WHERE id=?3 AND status='pending' AND expires_at > unixepoch()",
    )
    .bind(target_status)
    .bind(&resolver)
    .bind(&approval.id)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() != 1 {
        tx.rollback().await?;
        expire_for_run(state, &approval.run_id).await?;
        return Err(AppError::InvalidRequest(format!(
            "harness approval {} is no longer pending",
            approval.id
        )));
    }
    append_event_tx(
        &mut tx,
        &approval.run_id,
        "approval/resolved",
        &serde_json::json!({
            "approval_id": approval.id,
            "tool": approval.tool,
            "capability_id": approval.capability_id,
            "argument_sha256": approval.argument_sha256,
            "workspace": approval.workspace,
            "head_sha": approval.head_sha,
            "decision": request.decision,
            "resolved_by": resolver,
        }),
    )
    .await?;
    tx.commit().await?;

    Ok(HarnessApprovalRespondResult {
        approval: load(state, &request.approval_id).await?,
        replayed: false,
    })
}
