use axum::{Json, Router, extract::State, http::HeaderMap, routing::post};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const DESKTOP_HARNESS_VIEW_HEADER: &str = "x-sourcenerve-harness-view";
const DESKTOP_HARNESS_VIEW: &str = "desktop-compact";

use crate::{
    error::AppError,
    harness::{
        self, ClosedLoopToolFinished, ClosedLoopToolStarted, HarnessLoopToolRole,
        HarnessRunBeginRequest, HarnessRunEventsRequest, HarnessRunIdRequest,
        HarnessRunListRequest,
        agent::{
            HarnessAgentTurnBeginRequest, HarnessAgentTurnCompleteRequest,
            HarnessAgentTurnIdRequest, HarnessAgentTurnIterationRequest,
            HarnessAgentTurnListRequest,
        },
        capability::HarnessCapabilitiesRequest,
        context_gate::HarnessContextRouteRequest,
        eval::{
            HarnessAgentEvaluateRequest, HarnessAgentEvaluationListRequest,
            HarnessAgentJudgeRecordRequest,
        },
        memory::HarnessMemoryRequest,
    },
    job_ingress::harness_job::{self, HarnessJobCallRequest, HarnessJobListRequest},
    mcp::harness_approval::{
        self, HarnessApprovalListRequest, HarnessApprovalRespondRequest,
        HarnessNativeApprovalResolveRequest,
    },
    service::{AppState, WorkspaceExecRequest, sandbox::SandboxMode},
};

const MAX_HARNESS_COMMAND_BYTES: usize = 32 * 1024;
const MAX_HARNESS_COMMAND_STREAM_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
struct HarnessCommandExecuteRequest {
    workspace: String,
    command: String,
    request_id: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
struct HarnessCommandExecuteResponse {
    workspace: String,
    command: String,
    request_id: String,
    status: String,
    sandbox: Option<String>,
    sandbox_enforcement: Option<String>,
    success: Option<bool>,
    exit_code: Option<i32>,
    timed_out: Option<bool>,
    stdout: Option<String>,
    stderr: Option<String>,
    truncated: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct HarnessNativeExecutionStartRequest {
    run_id: String,
}

#[derive(Debug, Deserialize)]
struct HarnessNativeExecutionFinishRequest {
    run_id: String,
    success: bool,
    error_category: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HarnessNativeVerificationRunRequest {
    run_id: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
struct HarnessNativeExecutionView {
    run_id: String,
    phase: String,
    verification_required: bool,
    verification_status: String,
    recovery_status: String,
}

#[derive(Debug, Serialize)]
struct HarnessNativeVerificationView {
    run_id: String,
    skipped: bool,
    proof_type: Option<String>,
    proof_source: Option<String>,
    proof_command: Option<String>,
    success: bool,
    exit_code: Option<i32>,
    timed_out: bool,
    stdout: String,
    stderr: String,
    truncated: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/harness/context/route", post(context_route))
        .route("/harness/agent/turns/begin", post(agent_turn_begin))
        .route("/harness/agent/turns/get", post(agent_turn_get))
        .route("/harness/agent/turns/list", post(agent_turn_list))
        .route("/harness/agent/turns/iteration", post(agent_turn_iteration))
        .route("/harness/agent/turns/complete", post(agent_turn_complete))
        .route("/harness/agent/memory", post(agent_memory))
        .route("/harness/agent/evaluations/run", post(agent_evaluate))
        .route("/harness/agent/evaluations/list", post(agent_evaluations))
        .route("/harness/agent/evaluations/judge", post(agent_judge))
        .route("/harness/capabilities", post(capabilities))
        .route("/harness/runs/begin", post(begin))
        .route("/harness/runs/list", post(list_runs))
        .route("/harness/runs/get", post(get))
        .route("/harness/runs/events", post(events))
        .route("/harness/runs/cancel", post(cancel))
        .route("/harness/runs/complete", post(complete))
        .route("/harness/commands/execute", post(execute_command))
        .route(
            "/harness/native/execution/start",
            post(native_execution_start),
        )
        .route(
            "/harness/native/execution/finish",
            post(native_execution_finish),
        )
        .route(
            "/harness/native/verification/run",
            post(native_verification_run),
        )
        .route("/harness/jobs/list", post(list_jobs))
        .route("/harness/jobs/call", post(call_job))
        .route("/harness/approvals/list", post(list_approvals))
        .route("/harness/approvals/respond", post(respond_approval))
        .route(
            "/harness/approvals/native/resolve",
            post(resolve_native_approval),
        )
}

async fn context_route(
    State(state): State<AppState>,
    Json(request): Json<HarnessContextRouteRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::context_gate::route(&state, request, harness::operator_principal_key(), true)
                .await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn agent_turn_begin(
    State(state): State<AppState>,
    Json(request): Json<HarnessAgentTurnBeginRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::agent::begin(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn agent_turn_get(
    State(state): State<AppState>,
    Json(request): Json<HarnessAgentTurnIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::agent::get(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn agent_turn_list(
    State(state): State<AppState>,
    Json(request): Json<HarnessAgentTurnListRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::agent::list(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn agent_turn_iteration(
    State(state): State<AppState>,
    Json(request): Json<HarnessAgentTurnIterationRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::agent::record_iteration(
                &state,
                request,
                harness::operator_principal_key(),
                true,
            )
            .await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn agent_turn_complete(
    State(state): State<AppState>,
    Json(request): Json<HarnessAgentTurnCompleteRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::agent::complete(&state, request, harness::operator_principal_key(), true)
                .await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn agent_memory(
    State(state): State<AppState>,
    Json(request): Json<HarnessMemoryRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::memory::retrieve(&state, request, harness::operator_principal_key(), true)
                .await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn agent_evaluate(
    State(state): State<AppState>,
    Json(request): Json<HarnessAgentEvaluateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::eval::evaluate(&state, request, harness::operator_principal_key(), true)
                .await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn agent_evaluations(
    State(state): State<AppState>,
    Json(request): Json<HarnessAgentEvaluationListRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::eval::list(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn agent_judge(
    State(state): State<AppState>,
    Json(request): Json<HarnessAgentJudgeRecordRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::eval::record_judge(&state, request, harness::operator_principal_key(), true)
                .await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn capabilities(
    State(state): State<AppState>,
    Json(request): Json<HarnessCapabilitiesRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(harness::capability::resolve(&state, request).await?)
            .map_err(anyhow::Error::from)?,
    ))
}

async fn begin(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<HarnessRunBeginRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(compact_desktop_harness_response(
        serde_json::to_value(
            harness::begin(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
        &headers,
    )))
}

async fn list_runs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<HarnessRunListRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(compact_desktop_harness_response(
        serde_json::to_value(
            harness::list(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
        &headers,
    )))
}

async fn get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<HarnessRunIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(compact_desktop_harness_response(
        serde_json::to_value(
            harness::get(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
        &headers,
    )))
}

async fn events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<HarnessRunEventsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(compact_desktop_harness_response(
        serde_json::to_value(
            harness::events(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
        &headers,
    )))
}

async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<HarnessRunIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(compact_desktop_harness_response(
        serde_json::to_value(
            harness::cancel(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
        &headers,
    )))
}

async fn complete(
    State(state): State<AppState>,
    Json(request): Json<HarnessRunIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::complete(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn native_execution_start(
    State(state): State<AppState>,
    Json(request): Json<HarnessNativeExecutionStartRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let snapshot = require_current_native_run(&state, &request.run_id).await?;
    harness::closed_loop_tool_started(
        &state,
        &request.run_id,
        ClosedLoopToolStarted {
            tool: "native-codex",
            role: HarnessLoopToolRole::Execute,
            work_shape: None,
            work_scope: None,
            selected_proof_type: None,
            selected_proof_source: None,
            selected_proof_command: None,
            proof_type: None,
        },
    )
    .await?;
    let updated = harness::get(
        &state,
        HarnessRunIdRequest {
            run_id: snapshot.run.id,
        },
        harness::operator_principal_key(),
        true,
    )
    .await?;
    native_execution_json(&updated)
}

async fn native_execution_finish(
    State(state): State<AppState>,
    Json(request): Json<HarnessNativeExecutionFinishRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_native_error_category(request.error_category.as_deref())?;
    let snapshot = require_current_native_run(&state, &request.run_id).await?;
    let requires_verification = snapshot.closed_loop.work_shape != "read-only";
    harness::closed_loop_tool_finished(
        &state,
        &request.run_id,
        ClosedLoopToolFinished {
            tool: "native-codex",
            role: HarnessLoopToolRole::Execute,
            requires_verification,
            proof_type: None,
            proof_source: None,
            success: request.success,
            error_category: request.error_category.as_deref(),
        },
    )
    .await?;
    if request.success && !requires_verification {
        harness::closed_loop_complete_without_verification(&state, &request.run_id, "native-codex")
            .await?;
    }
    let updated = harness::get(
        &state,
        HarnessRunIdRequest {
            run_id: request.run_id,
        },
        harness::operator_principal_key(),
        true,
    )
    .await?;
    native_execution_json(&updated)
}

async fn native_verification_run(
    State(state): State<AppState>,
    Json(request): Json<HarnessNativeVerificationRunRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    if request
        .timeout_ms
        .is_some_and(|timeout| !(100..=600_000).contains(&timeout))
    {
        return Err(AppError::InvalidRequest(
            "Harness native verification timeout must be between 100 and 600000 ms".into(),
        ));
    }
    let snapshot = require_current_native_run(&state, &request.run_id).await?;
    if !snapshot.closed_loop.verification_required {
        return native_verification_json(HarnessNativeVerificationView {
            run_id: request.run_id,
            skipped: true,
            proof_type: snapshot.closed_loop.selected_proof_type,
            proof_source: snapshot.closed_loop.selected_proof_source,
            proof_command: snapshot.closed_loop.selected_proof_command,
            success: true,
            exit_code: Some(0),
            timed_out: false,
            stdout: String::new(),
            stderr: String::new(),
            truncated: false,
        });
    }

    // Re-select the proof from the live repository context on every verification.
    // Recovery may add or change tests/scripts, so cycle-start proof metadata is
    // only a hint; the current repository is authoritative for the next proof.
    let live_candidate = harness::repository_context::select_proof_candidate(
        &snapshot.closed_loop.work_shape,
        &snapshot.repository_context,
        snapshot.closed_loop.work_scope.as_deref(),
    )
    .cloned();
    let desired_proof_type = live_candidate
        .as_ref()
        .map(|candidate| candidate.proof_type.clone())
        .or_else(|| {
            harness::repository_context::select_proof_type(
                &snapshot.closed_loop.work_shape,
                &snapshot.repository_context,
            )
        })
        .or_else(|| snapshot.closed_loop.selected_proof_type.clone());

    let Some(candidate) = live_candidate else {
        harness::closed_loop_select_proof(
            &state,
            &request.run_id,
            desired_proof_type.as_deref(),
            None,
            None,
        )
        .await?;
        harness::closed_loop_tool_started(
            &state,
            &request.run_id,
            ClosedLoopToolStarted {
                tool: "native-proof",
                role: HarnessLoopToolRole::Verify,
                work_shape: None,
                work_scope: None,
                selected_proof_type: None,
                selected_proof_source: None,
                selected_proof_command: None,
                proof_type: desired_proof_type.as_deref(),
            },
        )
        .await?;
        harness::closed_loop_tool_finished(
            &state,
            &request.run_id,
            ClosedLoopToolFinished {
                tool: "native-proof",
                role: HarnessLoopToolRole::Verify,
                requires_verification: false,
                proof_type: desired_proof_type.as_deref(),
                proof_source: None,
                success: false,
                error_category: Some("proof-unavailable"),
            },
        )
        .await?;
        return native_verification_json(HarnessNativeVerificationView {
            run_id: request.run_id,
            skipped: false,
            proof_type: desired_proof_type,
            proof_source: None,
            proof_command: None,
            success: false,
            exit_code: None,
            timed_out: false,
            stdout: String::new(),
            stderr: "No concrete repository proof command is available for this work shape.".into(),
            truncated: false,
        });
    };

    let proof_type = candidate.proof_type;
    let proof_source = Some(candidate.source);
    let proof_command = candidate.command;
    let proof_cwd = candidate.cwd;
    harness::closed_loop_select_proof(
        &state,
        &request.run_id,
        Some(&proof_type),
        proof_source.as_deref(),
        Some(&proof_command),
    )
    .await?;

    harness::closed_loop_tool_started(
        &state,
        &request.run_id,
        ClosedLoopToolStarted {
            tool: "native-proof",
            role: HarnessLoopToolRole::Verify,
            work_shape: None,
            work_scope: None,
            selected_proof_type: None,
            selected_proof_source: None,
            selected_proof_command: None,
            proof_type: Some(&proof_type),
        },
    )
    .await?;

    let (program, args) = harness_command_shell(&proof_command);
    let execution = state
        .workspace_exec(WorkspaceExecRequest {
            workspace: snapshot.run.workspace.clone(),
            program,
            args,
            cwd: proof_cwd,
            timeout_ms: request.timeout_ms.unwrap_or(600_000),
            request_id: Some(format!("native-proof:{}", Uuid::new_v4())),
            sandbox: SandboxMode::WorkspaceWrite,
        })
        .await;

    let result = match execution {
        Ok(result) => result,
        Err(error) => {
            harness::closed_loop_tool_finished(
                &state,
                &request.run_id,
                ClosedLoopToolFinished {
                    tool: "native-proof",
                    role: HarnessLoopToolRole::Verify,
                    requires_verification: false,
                    proof_type: Some(&proof_type),
                    proof_source: proof_source.as_deref(),
                    success: false,
                    error_category: Some("tool-error"),
                },
            )
            .await?;
            return Err(error);
        }
    };
    let error_category = if result.success {
        None
    } else if result.timed_out {
        Some("timeout")
    } else {
        Some("command-exit")
    };
    harness::closed_loop_tool_finished(
        &state,
        &request.run_id,
        ClosedLoopToolFinished {
            tool: "native-proof",
            role: HarnessLoopToolRole::Verify,
            requires_verification: false,
            proof_type: Some(&proof_type),
            proof_source: proof_source.as_deref(),
            success: result.success,
            error_category,
        },
    )
    .await?;
    let (stdout, stdout_truncated) = truncate_harness_command_stream(result.stdout);
    let (stderr, stderr_truncated) = truncate_harness_command_stream(result.stderr);
    native_verification_json(HarnessNativeVerificationView {
        run_id: request.run_id,
        skipped: false,
        proof_type: Some(proof_type),
        proof_source,
        proof_command: Some(proof_command),
        success: result.success,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        stdout,
        stderr,
        truncated: result.truncated || stdout_truncated || stderr_truncated,
    })
}

async fn require_current_native_run(
    state: &AppState,
    run_id: &str,
) -> Result<harness::HarnessRunSnapshot, AppError> {
    if run_id.is_empty() || run_id.len() > 128 || run_id.chars().any(char::is_control) {
        return Err(AppError::InvalidRequest(
            "Harness native run id is invalid".into(),
        ));
    }
    let snapshot = harness::get(
        state,
        HarnessRunIdRequest {
            run_id: run_id.to_string(),
        },
        harness::operator_principal_key(),
        true,
    )
    .await?;
    if snapshot.run.status != "running" || snapshot.freshness.state != "current" {
        return Err(AppError::InvalidRequest(
            "Harness native execution requires a current running run".into(),
        ));
    }
    Ok(snapshot)
}

fn validate_native_error_category(value: Option<&str>) -> Result<(), AppError> {
    if value.is_some_and(|value| {
        value.is_empty() || value.len() > 64 || value.chars().any(char::is_control)
    }) {
        return Err(AppError::InvalidRequest(
            "Harness native error category is invalid".into(),
        ));
    }
    Ok(())
}

fn native_execution_json(
    snapshot: &harness::HarnessRunSnapshot,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(HarnessNativeExecutionView {
            run_id: snapshot.run.id.clone(),
            phase: snapshot.closed_loop.phase.clone(),
            verification_required: snapshot.closed_loop.verification_required,
            verification_status: snapshot.closed_loop.verification_status.clone(),
            recovery_status: snapshot.closed_loop.recovery_status.clone(),
        })
        .map_err(anyhow::Error::from)?,
    ))
}

fn native_verification_json(
    response: HarnessNativeVerificationView,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(response).map_err(anyhow::Error::from)?,
    ))
}

async fn execute_command(
    State(state): State<AppState>,
    Json(request): Json<HarnessCommandExecuteRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_harness_command_request(&request)?;

    // Bang commands are explicit user-authored shell actions, not agent tool calls.
    // Keep them workspace-confined and bounded, but do not route them through
    // Harness capability policy, Git/provider classification, or approval flows.
    let (program, args) = harness_command_shell(&request.command);
    let result = state
        .workspace_exec(WorkspaceExecRequest {
            workspace: request.workspace.clone(),
            program,
            args,
            cwd: None,
            timeout_ms: request.timeout_ms.unwrap_or(120_000),
            request_id: Some(request.request_id.clone()),
            sandbox: SandboxMode::WorkspaceWrite,
        })
        .await?;
    let (stdout, stdout_truncated) = truncate_harness_command_stream(result.stdout);
    let (stderr, stderr_truncated) = truncate_harness_command_stream(result.stderr);
    command_json(HarnessCommandExecuteResponse {
        workspace: request.workspace,
        command: request.command,
        request_id: request.request_id,
        status: "completed".into(),
        sandbox: Some(result.sandbox.as_str().into()),
        sandbox_enforcement: Some(result.sandbox_enforcement.as_str().into()),
        success: Some(result.success),
        exit_code: result.exit_code,
        timed_out: Some(result.timed_out),
        stdout: Some(stdout),
        stderr: Some(stderr),
        truncated: Some(result.truncated || stdout_truncated || stderr_truncated),
    })
}

fn validate_harness_command_request(
    request: &HarnessCommandExecuteRequest,
) -> Result<(), AppError> {
    if request.workspace.is_empty()
        || request.workspace.len() > 128
        || request.request_id.is_empty()
        || request.request_id.len() > 128
        || request
            .request_id
            .chars()
            .any(|ch| ch == '\0' || ch == '\r' || ch == '\n')
    {
        return Err(AppError::InvalidRequest(
            "Harness command identifiers are invalid".into(),
        ));
    }
    if request.command.trim().is_empty()
        || request.command.len() > MAX_HARNESS_COMMAND_BYTES
        || request.command.contains('\0')
    {
        return Err(AppError::InvalidRequest(
            "Harness command must be non-empty, NUL-free, and at most 32 KiB".into(),
        ));
    }
    if request
        .timeout_ms
        .is_some_and(|timeout| !(100..=600_000).contains(&timeout))
    {
        return Err(AppError::InvalidRequest(
            "Harness command timeout must be between 100 and 600000 ms".into(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn harness_command_shell(command: &str) -> (String, Vec<String>) {
    (
        "powershell.exe".into(),
        vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-Command".into(),
            command.into(),
        ],
    )
}

#[cfg(not(target_os = "windows"))]
fn harness_command_shell(command: &str) -> (String, Vec<String>) {
    ("bash".into(), vec!["-lc".into(), command.into()])
}

fn truncate_harness_command_stream(value: String) -> (String, bool) {
    if value.len() <= MAX_HARNESS_COMMAND_STREAM_BYTES {
        return (value, false);
    }
    let mut start = value.len() - MAX_HARNESS_COMMAND_STREAM_BYTES;
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    (
        format!(
            "[desktop output truncated; showing last {} bytes]\n{}",
            MAX_HARNESS_COMMAND_STREAM_BYTES,
            &value[start..]
        ),
        true,
    )
}

fn command_json(
    response: HarnessCommandExecuteResponse,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(response).map_err(anyhow::Error::from)?,
    ))
}

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

async fn list_approvals(
    State(state): State<AppState>,
    Json(request): Json<HarnessApprovalListRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness_approval::list(&state, request, harness::operator_principal_key(), true)
                .await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn resolve_native_approval(
    State(state): State<AppState>,
    Json(request): Json<HarnessNativeApprovalResolveRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness_approval::resolve_native(
                &state,
                request,
                harness::operator_principal_key(),
                true,
            )
            .await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn respond_approval(
    State(state): State<AppState>,
    Json(request): Json<HarnessApprovalRespondRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness_approval::respond(&state, request, harness::operator_principal_key(), true)
                .await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}
fn compact_desktop_harness_response(
    mut value: serde_json::Value,
    headers: &HeaderMap,
) -> serde_json::Value {
    let compact = headers
        .get(DESKTOP_HARNESS_VIEW_HEADER)
        .and_then(|value| value.to_str().ok())
        == Some(DESKTOP_HARNESS_VIEW);
    if compact {
        compact_capability_snapshots(&mut value);
    }
    value
}

fn compact_capability_snapshots(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                compact_capability_snapshots(item);
            }
        }
        serde_json::Value::Object(object) => {
            if let Some(snapshot) = object.get_mut("capability_snapshot") {
                if let serde_json::Value::Object(fields) = snapshot {
                    let mut compact = serde_json::Map::new();
                    for key in [
                        "registry_version",
                        "profile",
                        "workspace_writable",
                        "requires_runtime_authorization",
                        "runtime_features",
                    ] {
                        if let Some(field) = fields.get(key) {
                            compact.insert(key.to_string(), field.clone());
                        }
                    }
                    compact.insert(
                        "capabilities_omitted".to_string(),
                        serde_json::Value::Bool(fields.contains_key("capabilities")),
                    );
                    *snapshot = serde_json::Value::Object(compact);
                }
            }
            for child in object.values_mut() {
                compact_capability_snapshots(child);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DESKTOP_HARNESS_VIEW, DESKTOP_HARNESS_VIEW_HEADER, HarnessCommandExecuteRequest,
        MAX_HARNESS_COMMAND_BYTES, MAX_HARNESS_COMMAND_STREAM_BYTES,
        compact_desktop_harness_response, harness_command_shell, truncate_harness_command_stream,
        validate_harness_command_request,
    };
    use axum::http::{HeaderMap, HeaderValue};
    use serde_json::json;
    #[test]
    fn harness_command_request_validation_enforces_bounds_and_timeout() {
        let valid = HarnessCommandExecuteRequest {
            workspace: "repo".into(),
            command: "npm test".into(),
            request_id: "bang-1".into(),
            timeout_ms: Some(120_000),
        };
        assert!(validate_harness_command_request(&valid).is_ok());

        let blank = HarnessCommandExecuteRequest {
            command: "   ".into(),
            ..valid
        };
        assert!(validate_harness_command_request(&blank).is_err());

        let nul = HarnessCommandExecuteRequest {
            command: "echo\0unsafe".into(),
            ..blank
        };
        assert!(validate_harness_command_request(&nul).is_err());

        let oversized = HarnessCommandExecuteRequest {
            command: "x".repeat(MAX_HARNESS_COMMAND_BYTES + 1),
            ..nul
        };
        assert!(validate_harness_command_request(&oversized).is_err());

        let low_timeout = HarnessCommandExecuteRequest {
            command: "echo ok".into(),
            timeout_ms: Some(99),
            ..oversized
        };
        assert!(validate_harness_command_request(&low_timeout).is_err());

        let high_timeout = HarnessCommandExecuteRequest {
            timeout_ms: Some(600_001),
            ..low_timeout
        };
        assert!(validate_harness_command_request(&high_timeout).is_err());
    }

    #[test]
    fn harness_command_stream_truncation_keeps_utf8_tail_and_marks_truncation() {
        let short = "hello".to_string();
        assert_eq!(
            truncate_harness_command_stream(short.clone()),
            (short, false)
        );

        let prefix = "x".repeat(MAX_HARNESS_COMMAND_STREAM_BYTES);
        let value = format!("{prefix}é-tail");
        let (truncated, did_truncate) = truncate_harness_command_stream(value);
        assert!(did_truncate);
        assert!(truncated.starts_with("[desktop output truncated; showing last "));
        assert!(truncated.ends_with("é-tail"));
        assert!(!truncated.contains('�'));
    }

    #[test]
    fn harness_command_shell_preserves_exact_user_authored_command() {
        let command = "git pull && npm test";
        let (_program, args) = harness_command_shell(command);
        assert_eq!(args.last().map(String::as_str), Some(command));
    }

    #[test]
    fn desktop_harness_view_omits_capability_schemas_but_keeps_profile() {
        let huge_schema = "x".repeat(3 * 1024 * 1024);
        let original = json!({
            "snapshot": {
                "run": {
                    "capability_snapshot": {
                        "registry_version": 1,
                        "profile": {
                            "id": "interactive-local",
                            "description": "Interactive local",
                            "sandbox": "workspace-write",
                            "policies": { "read": "allow" }
                        },
                        "workspace_writable": true,
                        "requires_runtime_authorization": true,
                        "runtime_features": ["approvals"],
                        "capabilities": [{ "id": "plugin.large", "input_schema": huge_schema }]
                    }
                }
            }
        });
        let mut headers = HeaderMap::new();
        headers.insert(
            DESKTOP_HARNESS_VIEW_HEADER,
            HeaderValue::from_static(DESKTOP_HARNESS_VIEW),
        );

        let compact = compact_desktop_harness_response(original, &headers);
        let snapshot = &compact["snapshot"]["run"]["capability_snapshot"];
        assert_eq!(snapshot["profile"]["id"], "interactive-local");
        assert_eq!(snapshot["capabilities_omitted"], true);
        assert!(snapshot.get("capabilities").is_none());
        assert!(
            serde_json::to_vec(&compact)
                .expect("serialize compact response")
                .len()
                < 4096
        );
    }

    #[test]
    fn ordinary_harness_http_response_keeps_full_capability_snapshot() {
        let original = json!({
            "run": {
                "capability_snapshot": {
                    "profile": { "id": "interactive-local" },
                    "capabilities": [{ "id": "core.repo_snapshot" }]
                }
            }
        });

        let response = compact_desktop_harness_response(original, &HeaderMap::new());
        assert_eq!(
            response["run"]["capability_snapshot"]["capabilities"][0]["id"],
            "core.repo_snapshot"
        );
    }
}
