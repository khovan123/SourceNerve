use std::time::Instant;

use rmcp::model::CallToolRequestParams;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::harness_approval::{self, ApprovalIntent};
use crate::{
    error::{AppError, AppResult},
    harness,
    oauth::Principal,
    service::AppState,
};

const MAX_EXECUTION_ROWS: i64 = 10_000;
const RETENTION_SECONDS: i64 = 30 * 24 * 60 * 60;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolSafety {
    pub read_only: bool,
    pub destructive: bool,
    pub idempotent: bool,
    pub open_world: bool,
}

const fn safety(
    read_only: bool,
    destructive: bool,
    idempotent: bool,
    open_world: bool,
) -> ToolSafety {
    ToolSafety {
        read_only,
        destructive,
        idempotent,
        open_world,
    }
}

const CONSERVATIVE_SAFETY: ToolSafety = safety(false, true, false, true);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PolicyDecision {
    Allow,
    Ask,
    Deny,
}

impl PolicyDecision {
    fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny => "deny",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExecutionTicket {
    pub id: String,
    pub run_id: Option<String>,
    pub tool_name: String,
    pub capability_id: String,
    started: Instant,
}

#[derive(Debug, Clone)]
struct RunBinding {
    id: String,
    workspace: String,
    profile: String,
    head_sha: String,
    snapshot: serde_json::Value,
}

type DynamicToolRow = (Option<i64>, Option<i64>, Option<i64>, Option<i64>);

pub fn explicit_tool_safety(name: &str) -> Option<ToolSafety> {
    let value = match name {
        "service_status"
        | "readiness"
        | "state_backup_validate"
        | "mutation_audit"
        | "workspace_list"
        | "memory_search"
        | "semantic_search"
        | "architecture_map"
        | "architecture_cluster"
        | "job_get"
        | "graph_status"
        | "symbol_search"
        | "symbol_context"
        | "trace_callers"
        | "trace_callees"
        | "references"
        | "impact_analysis"
        | "repo_snapshot"
        | "search_code"
        | "read_file"
        | "git_diff"
        | "git_review"
        | "patch_preview"
        | "scip_status"
        | "scip_analyzer_status"
        | "workspace_file_fetch"
        | "mcp_extension_catalog"
        | "mcp_extension_call_read"
        | "plugin_catalog"
        | "plugin_skill_read"
        | "workspace_process_logs"
        | "harness_run_get"
        | "harness_run_events"
        | "harness_capabilities" => safety(true, false, true, false),
        "semantic_search_text" | "context_pack" | "github_pull_get" => {
            safety(true, false, true, true)
        }
        "state_backup_create" => safety(false, false, false, false),
        "workspace_index" | "semantic_import" | "architecture_rebuild" | "scip_import" => {
            safety(false, false, true, false)
        }
        "scip_analyze" => safety(false, false, false, false),
        "semantic_provider_index" => safety(false, false, true, true),
        "task_begin" | "task_propose_patch" => safety(false, false, false, false),
        "task_get" | "task_git_review" => safety(false, false, true, false),
        "task_cancel" | "task_apply_patch" => safety(false, true, false, false),
        "task_branch_checkout" | "task_git_commit" => safety(false, false, true, false),
        "task_git_push" | "task_default_sync" => safety(false, false, true, true),
        "task_github_issue_create"
        | "task_github_pull_create"
        | "task_provider_issue_create"
        | "task_provider_pull_create" => safety(false, false, true, true),
        "task_github_pull_get" | "task_provider_pull_get" => safety(false, false, true, true),
        "task_github_pull_merge" | "task_provider_pull_merge" => safety(false, true, true, true),
        "git_branch_checkout" | "git_commit" => safety(false, false, false, false),
        "git_push" | "git_default_sync" => safety(false, false, true, true),
        "github_issue_create" | "github_pull_create" => safety(false, false, false, true),
        "github_pull_merge" => safety(false, true, false, true),
        "patch_apply" | "workspace_file_put" | "workspace_file_write" | "workspace_file_delete" => {
            safety(false, true, false, false)
        }
        "workspace_exec" | "workspace_process_start" => safety(false, true, false, true),
        "workspace_process_stop" => safety(false, true, false, false),
        "mcp_extension_call_write" => safety(false, true, false, true),
        "harness_run_begin" => safety(false, false, false, false),
        "harness_run_cancel" => safety(false, true, true, false),
        "harness_approval_respond" => safety(false, false, true, false),
        _ => return None,
    };
    Some(value)
}

fn sha256(input: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(input.as_ref()))
}

fn request_run_id(request: &CallToolRequestParams) -> Option<String> {
    request
        .arguments
        .as_ref()
        .and_then(|arguments| arguments.get("_harness_run_id"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub fn strip_harness_context(request: &mut CallToolRequestParams) {
    if let Some(arguments) = request.arguments.as_mut() {
        arguments.remove("_harness_run_id");
    }
}

async fn request_workspace(
    state: &AppState,
    request: &CallToolRequestParams,
) -> AppResult<Option<String>> {
    let Some(arguments) = request.arguments.as_ref() else {
        return Ok(None);
    };
    if let Some(workspace) = arguments
        .get("workspace")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return Ok(Some(workspace.to_string()));
    }
    if let Some(task_id) = arguments.get("task_id").and_then(serde_json::Value::as_str) {
        return Ok(
            sqlx::query_scalar::<_, String>("SELECT workspace_id FROM tasks WHERE id=?1")
                .bind(task_id)
                .fetch_optional(&state.db)
                .await?,
        );
    }
    if let Some(job_id) = arguments.get("job_id").and_then(serde_json::Value::as_str) {
        return Ok(
            sqlx::query_scalar::<_, String>("SELECT workspace_id FROM jobs WHERE id=?1")
                .bind(job_id)
                .fetch_optional(&state.db)
                .await?,
        );
    }
    if let Some(run_id) = arguments.get("run_id").and_then(serde_json::Value::as_str) {
        return Ok(sqlx::query_scalar::<_, String>(
            "SELECT workspace_id FROM harness_runs WHERE id=?1",
        )
        .bind(run_id)
        .fetch_optional(&state.db)
        .await?);
    }
    if let Some(approval_id) = arguments
        .get("approval_id")
        .and_then(serde_json::Value::as_str)
    {
        return Ok(sqlx::query_scalar::<_, String>(
            "SELECT workspace_id FROM harness_approvals WHERE id=?1",
        )
        .bind(approval_id)
        .fetch_optional(&state.db)
        .await?);
    }
    Ok(None)
}

async fn dynamic_tool_safety(state: &AppState, name: &str) -> AppResult<Option<ToolSafety>> {
    let row: Option<DynamicToolRow> = sqlx::query_as(
        "SELECT read_only, destructive, idempotent, open_world FROM mcp_extension_tools \
         WHERE public_name=?1 AND enabled=1",
    )
    .bind(name)
    .fetch_optional(&state.db)
    .await?;
    let Some((read_only, destructive, idempotent, open_world)) = row else {
        return Ok(None);
    };
    let (Some(read_only), Some(destructive), Some(idempotent), Some(open_world)) = (
        read_only.map(|value| value != 0),
        destructive.map(|value| value != 0),
        idempotent.map(|value| value != 0),
        open_world.map(|value| value != 0),
    ) else {
        return Ok(None);
    };
    Ok(Some(ToolSafety {
        read_only,
        destructive,
        idempotent,
        open_world,
    }))
}

fn static_capability_id(name: &str) -> Option<&'static str> {
    match name {
        "service_status" | "readiness" | "workspace_list" | "mutation_audit" => {
            Some("core.repository.read")
        }
        "memory_search"
        | "semantic_search"
        | "semantic_search_text"
        | "architecture_map"
        | "architecture_cluster"
        | "graph_status"
        | "symbol_search"
        | "symbol_context"
        | "trace_callers"
        | "trace_callees"
        | "references"
        | "impact_analysis"
        | "repo_snapshot"
        | "search_code"
        | "scip_status"
        | "scip_analyzer_status" => Some("core.repository.read"),
        "context_pack" | "plugin_catalog" | "mcp_extension_catalog" => Some("core.context.read"),
        "read_file" | "workspace_file_fetch" | "patch_preview" => Some("core.files.read"),
        "workspace_file_put" | "workspace_file_write" | "workspace_file_delete" | "patch_apply" => {
            Some("core.files.write")
        }
        "workspace_exec"
        | "workspace_process_start"
        | "workspace_process_stop"
        | "scip_analyze" => Some("core.workspace.exec"),
        "workspace_process_logs" => Some("core.repository.read"),
        "task_get" | "task_git_review" => Some("core.task.read"),
        name if name.starts_with("task_") => Some("core.task.mutate"),
        "git_diff" | "git_review" => Some("core.git.read"),
        "git_branch_checkout" | "git_commit" | "git_push" | "git_default_sync" => {
            Some("core.git.mutate")
        }
        "github_pull_get" | "task_github_pull_get" | "task_provider_pull_get" => {
            Some("core.provider.read")
        }
        name if name.starts_with("github_") || name.starts_with("task_provider_") => {
            Some("core.provider.mutate")
        }
        "job_get"
        | "workspace_index"
        | "semantic_import"
        | "semantic_provider_index"
        | "architecture_rebuild"
        | "scip_import" => Some("core.jobs"),
        "harness_run_begin"
        | "harness_run_get"
        | "harness_run_events"
        | "harness_run_cancel"
        | "harness_capabilities"
        | "harness_approval_respond" => Some("core.harness.run"),
        "state_backup_create" | "state_backup_validate" => Some("core.security.audit"),
        _ => None,
    }
}

fn bridge_target(request: &CallToolRequestParams) -> Option<&str> {
    request
        .arguments
        .as_ref()
        .and_then(|arguments| arguments.get("public_tool"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
}

fn plugin_capability_id(request: &CallToolRequestParams) -> Option<String> {
    if request.name.as_ref() != "plugin_skill_read" {
        return None;
    }
    let arguments = request.arguments.as_ref()?;
    let plugin_id = arguments.get("plugin_id")?.as_str()?;
    let skill_id = arguments.get("skill_id")?.as_str()?;
    Some(format!("plugin.{plugin_id}.skill.{skill_id}"))
}

fn capability_from_snapshot(
    snapshot: &serde_json::Value,
    request: &CallToolRequestParams,
) -> Option<(String, PolicyDecision)> {
    let capabilities = snapshot.get("capabilities")?.as_array()?;
    let requested = if matches!(
        request.name.as_ref(),
        "mcp_extension_call_read" | "mcp_extension_call_write"
    ) {
        let target = bridge_target(request)?;
        capabilities.iter().find(|capability| {
            capability.get("origin").and_then(serde_json::Value::as_str) == Some("mcp-extension")
                && capability.get("name").and_then(serde_json::Value::as_str) == Some(target)
        })
    } else if let Some(id) = plugin_capability_id(request) {
        capabilities.iter().find(|capability| {
            capability.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str())
        })
    } else if let Some(id) = static_capability_id(request.name.as_ref()) {
        capabilities
            .iter()
            .find(|capability| capability.get("id").and_then(serde_json::Value::as_str) == Some(id))
    } else {
        capabilities.iter().find(|capability| {
            capability.get("origin").and_then(serde_json::Value::as_str) == Some("mcp-extension")
                && capability.get("name").and_then(serde_json::Value::as_str)
                    == Some(request.name.as_ref())
        })
    }?;
    let id = requested.get("id")?.as_str()?.to_string();
    let approval = match requested.get("approval")?.as_str()? {
        "allow" => PolicyDecision::Allow,
        "ask" => PolicyDecision::Ask,
        "deny" => PolicyDecision::Deny,
        _ => PolicyDecision::Deny,
    };
    Some((id, approval))
}

async fn load_run_binding(
    state: &AppState,
    principal: &Principal,
    run_id: &str,
) -> AppResult<RunBinding> {
    let principal_id = harness::principal_key(principal);
    let operator = matches!(principal, Principal::Operator);
    let snapshot = harness::get(
        state,
        harness::HarnessRunIdRequest {
            run_id: run_id.to_string(),
        },
        &principal_id,
        operator,
    )
    .await?;
    if snapshot.run.status != "running" || snapshot.freshness.state != "current" {
        return Err(AppError::InvalidRequest(format!(
            "harness run {run_id} is not current and running"
        )));
    }
    Ok(RunBinding {
        id: snapshot.run.id,
        workspace: snapshot.run.workspace,
        profile: snapshot.run.profile,
        head_sha: snapshot.run.base_head,
        snapshot: snapshot.run.capability_snapshot,
    })
}

async fn append_run_event(
    state: &AppState,
    run_id: &str,
    event_type: &str,
    payload: &serde_json::Value,
) -> AppResult<()> {
    let payload = serde_json::to_string(payload).map_err(anyhow::Error::from)?;
    let mut tx = state.db.begin().await?;
    let seq: i64 = sqlx::query_scalar(
        "UPDATE harness_runs SET next_event_seq=next_event_seq+1, updated_at=unixepoch() \
         WHERE id=?1 RETURNING next_event_seq-1",
    )
    .bind(run_id)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO harness_events(run_id, seq, event_type, payload_json, created_at) \
         VALUES(?1, ?2, ?3, ?4, unixepoch())",
    )
    .bind(run_id)
    .bind(seq)
    .bind(event_type)
    .bind(payload)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn prune(state: &AppState) -> AppResult<()> {
    sqlx::query("DELETE FROM harness_tool_executions WHERE started_at < unixepoch() - ?1")
        .bind(RETENTION_SECONDS)
        .execute(&state.db)
        .await?;
    sqlx::query(
        "DELETE FROM harness_tool_executions WHERE id IN (\
            SELECT id FROM harness_tool_executions ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?1\
         )",
    )
    .bind(MAX_EXECUTION_ROWS)
    .execute(&state.db)
    .await?;
    Ok(())
}

pub async fn begin(
    state: &AppState,
    principal: &Principal,
    request: &CallToolRequestParams,
) -> AppResult<ExecutionTicket> {
    let run_id = request_run_id(request);
    let mut workspace = request_workspace(state, request).await?;
    let explicit = explicit_tool_safety(request.name.as_ref());
    let classified = match explicit {
        Some(value) => Some(value),
        None => dynamic_tool_safety(state, request.name.as_ref()).await?,
    };
    let safety = classified.unwrap_or(CONSERVATIVE_SAFETY);
    if classified.is_none() {
        return Err(AppError::InvalidRequest(format!(
            "harness tool pipeline denied unclassified tool `{}` with conservative destructive/open-world policy",
            request.name
        )));
    }

    let requires_workspace_write = !safety.read_only
        && !matches!(
            request.name.as_ref(),
            "harness_run_begin" | "harness_run_cancel" | "harness_approval_respond"
        );
    if let Principal::OAuth(value) = principal
        && let Some(workspace_id) = workspace.as_deref()
    {
        if !value.can_read(workspace_id) {
            return Err(AppError::InvalidRequest(
                "authorization denied: workspace is not granted".into(),
            ));
        }
        if requires_workspace_write {
            if !value.can_write(workspace_id) {
                return Err(AppError::InvalidRequest(
                    "authorization denied: workspace is not granted read-write access".into(),
                ));
            }
            if !state.workspaces.get(workspace_id)?.writable {
                return Err(AppError::InvalidRequest(
                    "authorization denied: workspace is configured read-only".into(),
                ));
            }
        }
    }

    let mut capability_id = static_capability_id(request.name.as_ref())
        .unwrap_or("dynamic.unbound")
        .to_string();
    let mut policy = PolicyDecision::Allow;
    let mut binding = None;
    if let Some(run_id) = run_id.as_deref() {
        let run = load_run_binding(state, principal, run_id).await?;
        if let Some(explicit_workspace) = workspace.as_deref()
            && explicit_workspace != run.workspace
        {
            return Err(AppError::InvalidRequest(
                "harness run workspace does not match tool target".into(),
            ));
        }
        workspace = Some(run.workspace.clone());
        let (resolved_capability, resolved_policy) = capability_from_snapshot(
            &run.snapshot,
            request,
        )
        .ok_or_else(|| {
            AppError::InvalidRequest(format!(
                "harness run profile `{}` does not contain a classified capability for tool `{}`",
                run.profile, request.name
            ))
        })?;
        capability_id = resolved_capability;
        policy = resolved_policy;
        binding = Some(run);
    }

    let execution_id = Uuid::new_v4().to_string();
    let argument_sha256 =
        sha256(serde_json::to_vec(&request.arguments).map_err(anyhow::Error::from)?);
    let principal_id = harness::principal_key(principal);
    let approval_intent = if policy == PolicyDecision::Ask {
        let run = binding.as_ref().ok_or_else(|| {
            AppError::InvalidRequest("harness ask policy requires a bound current run".into())
        })?;
        Some(ApprovalIntent {
            run_id: run.id.clone(),
            principal_id: principal_id.clone(),
            workspace: run.workspace.clone(),
            tool: request.name.to_string(),
            capability_id: capability_id.clone(),
            argument_sha256: argument_sha256.clone(),
            head_sha: run.head_sha.clone(),
        })
    } else {
        None
    };
    let mut approval_id = match approval_intent.as_ref() {
        Some(intent) => harness_approval::consume_matching(state, intent).await?,
        None => None,
    };
    let approved =
        policy == PolicyDecision::Allow || (policy == PolicyDecision::Ask && approval_id.is_some());
    let result_category = match policy {
        PolicyDecision::Deny => "denied",
        PolicyDecision::Ask if !approved => "approval-required",
        PolicyDecision::Allow | PolicyDecision::Ask => "started",
    };

    sqlx::query(
        "INSERT INTO harness_tool_executions(\
            id, run_id, principal_id, workspace_id, tool_name, capability_id, argument_sha256, \
            read_only, destructive, idempotent, open_world, policy_decision, result_category, dispatched, approval_id\
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14)",
    )
    .bind(&execution_id)
    .bind(run_id.as_deref())
    .bind(&principal_id)
    .bind(workspace.as_deref())
    .bind(request.name.as_ref())
    .bind(&capability_id)
    .bind(&argument_sha256)
    .bind(i64::from(safety.read_only))
    .bind(i64::from(safety.destructive))
    .bind(i64::from(safety.idempotent))
    .bind(i64::from(safety.open_world))
    .bind(policy.as_str())
    .bind(result_category)
    .bind(approval_id.as_deref())
    .execute(&state.db)
    .await?;

    if let Some(run) = binding.as_ref() {
        append_run_event(
            state,
            &run.id,
            "tool/requested",
            &serde_json::json!({
                "execution_id": execution_id,
                "tool": request.name,
                "capability_id": capability_id,
                "argument_sha256": argument_sha256,
                "read_only": safety.read_only,
                "destructive": safety.destructive,
                "idempotent": safety.idempotent,
                "open_world": safety.open_world,
                "policy": policy.as_str(),
            }),
        )
        .await?;
    }

    if policy == PolicyDecision::Deny {
        if let Some(run) = binding.as_ref() {
            append_run_event(
                state,
                &run.id,
                "tool/failed",
                &serde_json::json!({
                    "execution_id": execution_id,
                    "tool": request.name,
                    "capability_id": capability_id,
                    "result": "denied",
                }),
            )
            .await?;
        }
        prune(state).await?;
        return Err(AppError::InvalidRequest(format!(
            "harness profile denied capability `{capability_id}`"
        )));
    }

    if policy == PolicyDecision::Ask && !approved {
        let intent = approval_intent
            .as_ref()
            .expect("ask policy must have approval intent");
        let (approval, _) = harness_approval::request_pending(state, intent, &execution_id).await?;
        approval_id = Some(approval.id.clone());
        sqlx::query("UPDATE harness_tool_executions SET approval_id=?1 WHERE id=?2")
            .bind(&approval.id)
            .bind(&execution_id)
            .execute(&state.db)
            .await?;
        prune(state).await?;
        return Err(AppError::InvalidRequest(format!(
            "harness approval required: approval_id={} capability=`{capability_id}` expires_at={}",
            approval.id, approval.expires_at
        )));
    }

    if let Some(run) = binding.as_ref() {
        if let Some(approval_id) = approval_id.as_deref() {
            append_run_event(
                state,
                &run.id,
                "tool/approved",
                &serde_json::json!({
                    "execution_id": execution_id,
                    "approval_id": approval_id,
                    "tool": request.name,
                    "capability_id": capability_id,
                    "argument_sha256": argument_sha256,
                    "head_sha": run.head_sha,
                }),
            )
            .await?;
        }
        append_run_event(
            state,
            &run.id,
            "tool/started",
            &serde_json::json!({
                "execution_id": execution_id,
                "tool": request.name,
                "capability_id": capability_id,
            }),
        )
        .await?;
    }
    sqlx::query("UPDATE harness_tool_executions SET dispatched=1 WHERE id=?1")
        .bind(&execution_id)
        .execute(&state.db)
        .await?;

    Ok(ExecutionTicket {
        id: execution_id,
        run_id,
        tool_name: request.name.to_string(),
        capability_id,
        started: Instant::now(),
    })
}

impl ExecutionTicket {
    pub async fn finish(
        self,
        state: &AppState,
        success: bool,
        error_category: Option<&str>,
    ) -> AppResult<()> {
        let result = if success { "success" } else { "error" };
        let duration_ms = self.started.elapsed().as_millis().min(i64::MAX as u128) as i64;
        sqlx::query(
            "UPDATE harness_tool_executions SET result_category=?1, error_category=?2, \
             duration_ms=?3, completed_at=unixepoch() WHERE id=?4",
        )
        .bind(result)
        .bind(error_category)
        .bind(duration_ms)
        .bind(&self.id)
        .execute(&state.db)
        .await?;
        if let Some(run_id) = self.run_id.as_deref() {
            append_run_event(
                state,
                run_id,
                if success {
                    "tool/result"
                } else {
                    "tool/failed"
                },
                &serde_json::json!({
                    "execution_id": self.id,
                    "tool": self.tool_name,
                    "capability_id": self.capability_id,
                    "result": result,
                    "duration_ms": duration_ms,
                    "error_category": error_category,
                }),
            )
            .await?;
        }
        prune(state).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_tools_are_conservative_and_not_explicitly_classified() {
        assert!(explicit_tool_safety("totally_unknown_tool").is_none());
        assert_eq!(CONSERVATIVE_SAFETY, safety(false, true, false, true));
    }

    #[test]
    fn core_safety_metadata_matches_expected_side_effect_boundaries() {
        assert_eq!(
            explicit_tool_safety("workspace_file_fetch"),
            Some(safety(true, false, true, false))
        );
        assert_eq!(
            explicit_tool_safety("workspace_file_write"),
            Some(safety(false, true, false, false))
        );
        assert_eq!(
            explicit_tool_safety("workspace_exec"),
            Some(safety(false, true, false, true))
        );
        assert_eq!(
            explicit_tool_safety("git_push"),
            Some(safety(false, false, true, true))
        );
    }

    #[test]
    fn side_effectful_calls_are_never_marked_replay_safe_after_dispatch() {
        for name in [
            "workspace_file_write",
            "workspace_exec",
            "git_commit",
            "github_pull_merge",
            "mcp_extension_call_write",
        ] {
            let metadata = explicit_tool_safety(name).expect("classified tool");
            assert!(
                !metadata.read_only,
                "{name} must not be treated as read-only"
            );
        }
    }

    #[test]
    fn harness_control_tools_do_not_require_workspace_write_access() {
        for name in [
            "harness_run_begin",
            "harness_run_cancel",
            "harness_approval_respond",
        ] {
            let metadata = explicit_tool_safety(name).expect("classified harness tool");
            assert!(!metadata.read_only);
            let requires_workspace_write = !metadata.read_only
                && !matches!(
                    name,
                    "harness_run_begin" | "harness_run_cancel" | "harness_approval_respond"
                );
            assert!(!requires_workspace_write);
        }
    }
}
