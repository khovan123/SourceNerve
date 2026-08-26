use axum::{
    Json, Router,
    extract::{Query, State},
    routing::{delete, get},
};
use serde::{Deserialize, Serialize};

use crate::{
    error::AppResult,
    mcp_extension_audit::{self, ActivityRecord},
    service::AppState,
};

#[derive(Debug, Deserialize)]
struct ActivityQuery {
    extension_id: Option<String>,
    limit: Option<u32>,
}

#[derive(Debug, Serialize)]
struct CleanupResponse {
    removed_expired: u64,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/mcp/extensions/activity", get(list_activity))
        .route("/mcp/extensions/activity/expired", delete(clear_expired))
}

async fn list_activity(
    State(state): State<AppState>,
    Query(query): Query<ActivityQuery>,
) -> AppResult<Json<Vec<ActivityRecord>>> {
    Ok(Json(
        mcp_extension_audit::list(&state.db, query.extension_id.as_deref(), query.limit).await?,
    ))
}

async fn clear_expired(State(state): State<AppState>) -> AppResult<Json<CleanupResponse>> {
    Ok(Json(CleanupResponse {
        removed_expired: mcp_extension_audit::clear_expired(&state.db).await?,
    }))
}
