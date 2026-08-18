use axum::{Json, Router, extract::State, routing::post};

use crate::{
    error::AppError,
    semantic_context::{self, SemanticContextPackRequest},
    service::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/context/pack", post(context_pack))
}

async fn context_pack(
    State(state): State<AppState>,
    Json(request): Json<SemanticContextPackRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(semantic_context::pack(&state, request).await?).unwrap(),
    ))
}
