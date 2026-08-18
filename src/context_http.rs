use axum::{Json, Router, extract::State, routing::post};

use crate::{
    context::{self, ContextPackRequest},
    error::AppError,
    service::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/context/pack", post(context_pack))
}

async fn context_pack(
    State(state): State<AppState>,
    Json(request): Json<ContextPackRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(context::pack(&state, request).await?).unwrap(),
    ))
}
