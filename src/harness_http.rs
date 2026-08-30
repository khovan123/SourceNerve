use axum::{Json, Router, extract::State, routing::post};

use crate::{
    error::AppError,
    harness::{
        self, HarnessRunBeginRequest, HarnessRunEventsRequest, HarnessRunIdRequest,
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
    mcp::harness_approval::{self, HarnessApprovalListRequest, HarnessApprovalRespondRequest},
    service::AppState,
};

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
        .route("/harness/jobs/list", post(list_jobs))
        .route("/harness/jobs/call", post(call_job))
        .route("/harness/approvals/list", post(list_approvals))
        .route("/harness/approvals/respond", post(respond_approval))
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
    Json(request): Json<HarnessRunBeginRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::begin(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

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

async fn get(
    State(state): State<AppState>,
    Json(request): Json<HarnessRunIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::get(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn events(
    State(state): State<AppState>,
    Json(request): Json<HarnessRunEventsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::events(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
}

async fn cancel(
    State(state): State<AppState>,
    Json(request): Json<HarnessRunIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(
            harness::cancel(&state, request, harness::operator_principal_key(), true).await?,
        )
        .map_err(anyhow::Error::from)?,
    ))
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
