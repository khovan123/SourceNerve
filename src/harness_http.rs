use axum::{Json, Router, extract::State, routing::post};

use crate::{
    error::AppError,
    harness::{
        self, HarnessRunBeginRequest, HarnessRunEventsRequest, HarnessRunIdRequest,
        capability::HarnessCapabilitiesRequest,
    },
    mcp::harness_approval::{self, HarnessApprovalListRequest, HarnessApprovalRespondRequest},
    service::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/harness/capabilities", post(capabilities))
        .route("/harness/runs/begin", post(begin))
        .route("/harness/runs/get", post(get))
        .route("/harness/runs/events", post(events))
        .route("/harness/runs/cancel", post(cancel))
        .route("/harness/runs/complete", post(complete))
        .route("/harness/approvals/list", post(list_approvals))
        .route("/harness/approvals/respond", post(respond_approval))
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
