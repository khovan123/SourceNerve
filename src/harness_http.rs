use axum::{Json, Router, extract::State, routing::post};

use crate::{
    error::AppError,
    harness::{self, HarnessRunBeginRequest, HarnessRunEventsRequest, HarnessRunIdRequest},
    service::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/harness/runs/begin", post(begin))
        .route("/harness/runs/get", post(get))
        .route("/harness/runs/events", post(events))
        .route("/harness/runs/cancel", post(cancel))
        .route("/harness/runs/complete", post(complete))
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
