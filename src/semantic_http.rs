use axum::{Json, Router, extract::State, routing::post};

use crate::{
    error::AppError,
    semantic::{self, SemanticImportRequest, SemanticSearchRequest},
    service::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/semantic/import", post(semantic_import))
        .route("/semantic/search", post(semantic_search))
}

async fn semantic_import(
    State(state): State<AppState>,
    Json(request): Json<SemanticImportRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(semantic::import(&state, request).await?).unwrap(),
    ))
}

async fn semantic_search(
    State(state): State<AppState>,
    Json(request): Json<SemanticSearchRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(semantic::search(&state, request).await?).unwrap(),
    ))
}
