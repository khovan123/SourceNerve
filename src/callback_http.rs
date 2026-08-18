use axum::{Json, Router, extract::State, routing::post};

use crate::{
    callback::{self, CallbackDeliveryRequest},
    error::AppError,
    service::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/callbacks/get", post(callback_get))
        .route("/callbacks/retry", post(callback_retry))
}

async fn callback_get(
    State(state): State<AppState>,
    Json(request): Json<CallbackDeliveryRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(callback::get(&state, request).await?).unwrap(),
    ))
}

async fn callback_retry(
    State(state): State<AppState>,
    Json(request): Json<CallbackDeliveryRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        serde_json::to_value(callback::retry_failed(&state, request).await?).unwrap(),
    ))
}
