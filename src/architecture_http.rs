use axum::{Json, Router, extract::State, routing::post};

use crate::{
    architecture::{self, ArchitectureClusterRequest, ArchitectureMapRequest},
    error::AppError,
    service::{AppState, WorkspaceArg},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/architecture/rebuild", post(architecture_rebuild))
        .route("/architecture/map", post(architecture_map))
        .route("/architecture/cluster", post(architecture_cluster))
}

async fn architecture_rebuild(
    State(state): State<AppState>,
    Json(request): Json<WorkspaceArg>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(architecture::rebuild(&state, &request.workspace).await?).unwrap(),
    ))
}

async fn architecture_map(
    State(state): State<AppState>,
    Json(request): Json<ArchitectureMapRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(architecture::map(&state, request).await?).unwrap(),
    ))
}

async fn architecture_cluster(
    State(state): State<AppState>,
    Json(request): Json<ArchitectureClusterRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(architecture::cluster(&state, request).await?).unwrap(),
    ))
}
