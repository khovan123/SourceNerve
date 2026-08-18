use axum::{Json, Router, extract::State, routing::post};

use crate::{
    embedding_provider::{self, SemanticProviderIndexRequest, SemanticSearchTextRequest},
    error::AppError,
    semantic::{self, SemanticImportRequest, SemanticSearchRequest},
    service::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/semantic/import", post(semantic_import))
        .route("/semantic/search", post(semantic_search))
        .route("/semantic/provider/index", post(semantic_provider_index))
        .route("/semantic/search-text", post(semantic_search_text))
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

async fn semantic_provider_index(
    State(state): State<AppState>,
    Json(request): Json<SemanticProviderIndexRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(embedding_provider::index(&state, request).await?).unwrap(),
    ))
}

async fn semantic_search_text(
    State(state): State<AppState>,
    Json(request): Json<SemanticSearchTextRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(embedding_provider::search_text(&state, request).await?).unwrap(),
    ))
}
