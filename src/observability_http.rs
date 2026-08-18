use axum::{
    Router,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};

use crate::{error::AppError, observability, service::AppState};

pub fn protected_router() -> Router<AppState> {
    Router::new().route("/metrics", get(metrics))
}

pub fn public_router() -> Router {
    Router::new().route("/metrics", get(metrics))
}

async fn metrics() -> Result<Response, AppError> {
    let body = observability::render_metrics()?;
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")],
        body,
    )
        .into_response())
}
