use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    routing::post,
};

use crate::{
    error::AppError,
    scip_analyzer::{self, ScipAnalyzeRequest},
    scip_enrichment::{self, MAX_SCIP_ENCODED_BYTES, ScipImportRequest},
    service::{AppState, WorkspaceArg},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/graph/scip/status", post(scip_status))
        .route("/graph/scip/analyzers/status", post(scip_analyzer_status))
        .route("/graph/scip/analyze", post(scip_analyze))
        .route(
            "/graph/scip/import",
            post(scip_import).layer(DefaultBodyLimit::max(MAX_SCIP_ENCODED_BYTES + 64 * 1024)),
        )
}

async fn scip_status(
    State(state): State<AppState>,
    Json(request): Json<WorkspaceArg>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(scip_enrichment::status(&state, &request.workspace).await?).unwrap(),
    ))
}

async fn scip_analyzer_status(
    State(state): State<AppState>,
    Json(request): Json<WorkspaceArg>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(scip_analyzer::status(&state, &request.workspace).await?).unwrap(),
    ))
}

async fn scip_analyze(
    State(state): State<AppState>,
    Json(request): Json<ScipAnalyzeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(scip_analyzer::analyze(&state, request).await?).unwrap(),
    ))
}

async fn scip_import(
    State(state): State<AppState>,
    Json(request): Json<ScipImportRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(scip_enrichment::import(&state, request).await?).unwrap(),
    ))
}
