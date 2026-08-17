use axum::{Json, Router, extract::State, routing::{get, post}};

use crate::{
    error::AppError,
    runtime,
    service::AppState,
    state_backup::{BackupCreateRequest, BackupValidateRequest},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/status", get(service_status))
        .route("/state/backup", post(state_backup_create))
        .route("/state/backup/validate", post(state_backup_validate))
}

async fn service_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::to_value(runtime::status(&state)).unwrap())
}

async fn state_backup_create(
    State(state): State<AppState>,
    Json(request): Json<BackupCreateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(state.state_backup_create(request).await?).unwrap(),
    ))
}

async fn state_backup_validate(
    State(state): State<AppState>,
    Json(request): Json<BackupValidateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(state.state_backup_validate(request).await?).unwrap(),
    ))
}
