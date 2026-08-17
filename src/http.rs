use std::sync::Arc;

use axum::{Json, Router, extract::State, http::{HeaderMap, Request, StatusCode}, middleware::{self, Next}, response::Response, routing::{get, post}};
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager};

use crate::{memory::{self, MemorySearchRequest}, mcp::SourceNerveMcp, service::{AppState, PatchRequest, ReadFileRequest, SearchRequest, WorkspaceArg}};

#[derive(Clone)]
struct AuthState { token: Arc<String> }

fn extract_token(headers: &HeaderMap) -> Option<&str> {
    headers.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ")
}

async fn auth_middleware(
    State(auth): State<AuthState>,
    headers: HeaderMap,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    match extract_token(&headers) {
        Some(token) if token.as_bytes() == auth.token.as_bytes() => Ok(next.run(request).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

pub fn router(state: AppState, bearer_token: String) -> Router {
    let auth = AuthState { token: Arc::new(bearer_token) };
    let mcp_state = state.clone();
    let mcp_service = StreamableHttpService::new(
        move || Ok(SourceNerveMcp::new(mcp_state.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default().with_legacy_session_mode(false).with_json_response(true),
    );

    let api = Router::new()
        .route("/workspaces", get(list_workspaces))
        .route("/index", post(index_workspace))
        .route("/memory/search", post(memory_search))
        .route("/snapshot", post(snapshot))
        .route("/search", post(search))
        .route("/read", post(read_file))
        .route("/diff", post(diff))
        .route("/patch/preview", post(preview_patch))
        .route("/patch/apply", post(apply_patch))
        .with_state(state.clone());

    let protected = Router::new()
        .nest("/api/v1", api)
        .nest_service("/mcp", mcp_service)
        .layer(middleware::from_fn_with_state(auth, auth_middleware));

    Router::new().route("/healthz", get(health)).merge(protected)
}

async fn health() -> Json<serde_json::Value> { Json(serde_json::json!({"status":"ok","service":"sourcenerve"})) }
async fn list_workspaces(State(s): State<AppState>) -> Result<Json<serde_json::Value>, crate::error::AppError> { Ok(Json(serde_json::to_value(s.list_workspaces().await?).unwrap())) }
async fn index_workspace(State(s): State<AppState>, Json(a): Json<WorkspaceArg>) -> Result<Json<serde_json::Value>, crate::error::AppError> { Ok(Json(serde_json::to_value(memory::index_workspace(&s, &a.workspace).await?).unwrap())) }
async fn memory_search(State(s): State<AppState>, Json(a): Json<MemorySearchRequest>) -> Result<Json<serde_json::Value>, crate::error::AppError> { Ok(Json(serde_json::to_value(memory::search_memory(&s, a).await?).unwrap())) }
async fn snapshot(State(s): State<AppState>, Json(a): Json<WorkspaceArg>) -> Result<Json<serde_json::Value>, crate::error::AppError> { Ok(Json(serde_json::to_value(s.snapshot(&a.workspace).await?).unwrap())) }
async fn search(State(s): State<AppState>, Json(a): Json<SearchRequest>) -> Result<Json<serde_json::Value>, crate::error::AppError> { Ok(Json(serde_json::to_value(s.search(a).await?).unwrap())) }
async fn read_file(State(s): State<AppState>, Json(a): Json<ReadFileRequest>) -> Result<Json<serde_json::Value>, crate::error::AppError> { Ok(Json(serde_json::to_value(s.read_file(a).await?).unwrap())) }
async fn diff(State(s): State<AppState>, Json(a): Json<WorkspaceArg>) -> Result<Json<serde_json::Value>, crate::error::AppError> { Ok(Json(serde_json::json!({"diff":s.diff(&a.workspace).await?}))) }
async fn preview_patch(State(s): State<AppState>, Json(a): Json<PatchRequest>) -> Result<Json<serde_json::Value>, crate::error::AppError> { Ok(Json(serde_json::to_value(s.preview_patch(a).await?).unwrap())) }
async fn apply_patch(State(s): State<AppState>, Json(a): Json<PatchRequest>) -> Result<Json<serde_json::Value>, crate::error::AppError> { Ok(Json(serde_json::to_value(s.apply_patch(a).await?).unwrap())) }
