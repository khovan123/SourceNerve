use axum::{Json, Router, extract::State, routing::post};

use crate::{
    error::AppError,
    service::AppState,
    task_transactions::{
        self, TaskApplyPatchRequest, TaskBeginRequest, TaskIdRequest, TaskProposePatchRequest,
    },
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/tasks/begin", post(task_begin))
        .route("/tasks/get", post(task_get))
        .route("/tasks/cancel", post(task_cancel))
        .route("/tasks/proposals/create", post(task_propose_patch))
        .route("/tasks/proposals/apply", post(task_apply_patch))
}

async fn task_begin(
    State(state): State<AppState>,
    Json(request): Json<TaskBeginRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(task_transactions::begin(&state, request).await?).unwrap(),
    ))
}

async fn task_get(
    State(state): State<AppState>,
    Json(request): Json<TaskIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(task_transactions::get(&state, request).await?).unwrap(),
    ))
}

async fn task_cancel(
    State(state): State<AppState>,
    Json(request): Json<TaskIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(task_transactions::cancel(&state, request).await?).unwrap(),
    ))
}

async fn task_propose_patch(
    State(state): State<AppState>,
    Json(request): Json<TaskProposePatchRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(task_transactions::propose_patch(&state, request).await?).unwrap(),
    ))
}

async fn task_apply_patch(
    State(state): State<AppState>,
    Json(request): Json<TaskApplyPatchRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(task_transactions::apply_patch(&state, request).await?).unwrap(),
    ))
}
