use std::sync::Arc;

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};

use crate::{
    graph::{self, SymbolKeyRequest, SymbolSearchRequest, TraceRequest},
    mcp::SourceNerveMcp,
    memory::{self, MemorySearchRequest},
    oauth,
    oauth_http::{self, McpAuthState},
    observability,
    ops::AuditQuery,
    runtime,
    service::{AppState, PatchRequest, ReadFileRequest, SearchRequest, WorkspaceArg},
    state_backup::{BackupCreateRequest, BackupValidateRequest},
};

#[derive(Clone)]
struct AuthState {
    token: Arc<String>,
}

fn extract_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
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

pub fn router(
    state: AppState,
    bearer_token: String,
    oauth_runtime: Option<oauth::Runtime>,
    webhook_secret: Option<String>,
    github_webhook_secret: Option<String>,
    callback_enabled: bool,
) -> Router {
    let api_auth = AuthState {
        token: Arc::new(bearer_token.clone()),
    };
    let mcp_auth = McpAuthState::new(bearer_token, oauth_runtime.clone());
    let mcp_state = state.clone();
    let mcp_service = StreamableHttpService::new(
        move || Ok(SourceNerveMcp::new(mcp_state.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true),
    );

    let mut api = Router::new()
        .route("/status", get(service_status))
        .route("/readiness", get(readiness))
        .route("/state/backup", post(state_backup_create))
        .route("/state/backup/validate", post(state_backup_validate))
        .route("/audit", post(audit_events))
        .route("/workspaces", get(list_workspaces))
        .route("/index", post(index_workspace))
        .route("/memory/search", post(memory_search))
        .route("/graph/status", post(graph_status))
        .route("/graph/symbols/search", post(symbol_search))
        .route("/graph/symbols/context", post(symbol_context))
        .route("/graph/trace/callers", post(trace_callers))
        .route("/graph/trace/callees", post(trace_callees))
        .route("/graph/references", post(references))
        .route("/graph/impact", post(impact_analysis))
        .route("/snapshot", post(snapshot))
        .route("/search", post(search))
        .route("/read", post(read_file))
        .route("/diff", post(diff))
        .route("/patch/preview", post(preview_patch))
        .route("/patch/apply", post(apply_patch))
        .merge(crate::workflow_http::router())
        .merge(crate::scip_http::router())
        .merge(crate::semantic_http::router())
        .merge(crate::architecture_http::router())
        .merge(crate::context_http::router())
        .merge(crate::task_http::router())
        .merge(crate::job_http::api_router());
    if callback_enabled {
        api = api.merge(crate::callback_http::router());
    }
    if observability::metrics_enabled() {
        api = api.merge(crate::observability_http::protected_router());
    }
    let api = api.with_state(state.clone());

    let protected_api = Router::new()
        .nest("/api/v1", api)
        .route_layer(middleware::from_fn_with_state(api_auth, auth_middleware));
    let protected_mcp = Router::new().nest_service("/mcp", mcp_service).route_layer(
        middleware::from_fn_with_state(mcp_auth, oauth_http::mcp_auth_middleware),
    );

    let readiness_state = state.clone();
    let mut public = Router::new()
        .route("/healthz", get(health))
        .route("/gpt-actions/openapi.json", get(gpt_actions_openapi))
        .route(
            "/readyz",
            get(move || {
                let state = readiness_state.clone();
                async move { public_readiness(state).await }
            }),
        )
        .merge(oauth_http::metadata_router(oauth_runtime));
    if observability::metrics_public() {
        public = public.merge(crate::observability_http::public_router());
    }
    if let Some(secret) = webhook_secret {
        public = public.merge(crate::job_http::webhook_router(state.clone(), secret));
    }
    if let Some(secret) = github_webhook_secret {
        public = public.merge(crate::github_webhook_http::router(state, secret));
    }
    public
        .merge(protected_api)
        .merge(protected_mcp)
        .layer(middleware::from_fn(observability::request_middleware))
}

fn safe_forwarded_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)?
        .to_str()
        .ok()?
        .split(',')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn safe_public_host(value: &str) -> Option<&str> {
    if value.len() > 255
        || !value.is_ascii()
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':' | b'[' | b']')
        })
    {
        return None;
    }
    Some(value)
}

fn public_origin(headers: &HeaderMap) -> String {
    let scheme = safe_forwarded_value(headers, "x-forwarded-proto")
        .filter(|value| matches!(*value, "http" | "https"))
        .unwrap_or("http");
    let host = safe_forwarded_value(headers, "x-forwarded-host")
        .and_then(safe_public_host)
        .or_else(|| {
            headers
                .get(header::HOST)
                .and_then(|value| value.to_str().ok())
                .and_then(safe_public_host)
        })
        .unwrap_or("127.0.0.1:7331");
    format!("{scheme}://{host}")
}

async fn gpt_actions_openapi(headers: HeaderMap) -> Response {
    let body = include_str!("../docs/gpt-actions-openapi.json")
        .replace("__SOURCENERVE_BASE_URL__", &public_origin(&headers));
    (
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

async fn health() -> Json<serde_json::Value> {
    let identity = runtime::identity();
    Json(serde_json::json!({
        "status": "ok",
        "service": identity.service,
        "version": identity.version,
        "build_commit": identity.build_commit,
        "state_schema_version": identity.state_schema_version,
    }))
}

async fn public_readiness(state: AppState) -> Response {
    let report = state.readiness().await;
    observability::set_readiness(report.ready);
    let status = if report.ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    let value = if report.ready { "ready" } else { "not_ready" };
    (status, Json(serde_json::json!({ "status": value }))).into_response()
}

async fn service_status(State(s): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::to_value(s.service_status()).unwrap())
}

async fn readiness(State(s): State<AppState>) -> Json<serde_json::Value> {
    let report = s.readiness().await;
    observability::set_readiness(report.ready);
    Json(serde_json::to_value(report).unwrap())
}

async fn state_backup_create(
    State(s): State<AppState>,
    Json(a): Json<BackupCreateRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(s.state_backup_create(a).await?).unwrap(),
    ))
}

async fn state_backup_validate(
    State(s): State<AppState>,
    Json(a): Json<BackupValidateRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(s.state_backup_validate(a).await?).unwrap(),
    ))
}

async fn audit_events(
    State(s): State<AppState>,
    Json(a): Json<AuditQuery>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(s.audit_events(a).await?).unwrap(),
    ))
}

async fn list_workspaces(
    State(s): State<AppState>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(s.list_workspaces().await?).unwrap(),
    ))
}

async fn index_workspace(
    State(s): State<AppState>,
    Json(a): Json<WorkspaceArg>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(memory::index_workspace(&s, &a.workspace).await?).unwrap(),
    ))
}

async fn memory_search(
    State(s): State<AppState>,
    Json(a): Json<MemorySearchRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(memory::search_memory(&s, a).await?).unwrap(),
    ))
}

async fn graph_status(
    State(s): State<AppState>,
    Json(a): Json<WorkspaceArg>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(graph::status(&s, &a.workspace).await?).unwrap(),
    ))
}

async fn symbol_search(
    State(s): State<AppState>,
    Json(a): Json<SymbolSearchRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(graph::search_symbols(&s, a).await?).unwrap(),
    ))
}

async fn symbol_context(
    State(s): State<AppState>,
    Json(a): Json<SymbolKeyRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(graph::symbol_context(&s, a).await?).unwrap(),
    ))
}

async fn trace_callers(
    State(s): State<AppState>,
    Json(a): Json<TraceRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(graph::trace_callers(&s, a).await?).unwrap(),
    ))
}

async fn trace_callees(
    State(s): State<AppState>,
    Json(a): Json<TraceRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(graph::trace_callees(&s, a).await?).unwrap(),
    ))
}

async fn references(
    State(s): State<AppState>,
    Json(a): Json<TraceRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(graph::references(&s, a).await?).unwrap(),
    ))
}

async fn impact_analysis(
    State(s): State<AppState>,
    Json(a): Json<TraceRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(graph::impact_analysis(&s, a).await?).unwrap(),
    ))
}

async fn snapshot(
    State(s): State<AppState>,
    Json(a): Json<WorkspaceArg>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(s.snapshot(&a.workspace).await?).unwrap(),
    ))
}

async fn search(
    State(s): State<AppState>,
    Json(a): Json<SearchRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(serde_json::to_value(s.search(a).await?).unwrap()))
}

async fn read_file(
    State(s): State<AppState>,
    Json(a): Json<ReadFileRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(serde_json::to_value(s.read_file(a).await?).unwrap()))
}

async fn diff(
    State(s): State<AppState>,
    Json(a): Json<WorkspaceArg>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::json!({"diff":s.diff(&a.workspace).await?}),
    ))
}

async fn preview_patch(
    State(s): State<AppState>,
    Json(a): Json<PatchRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(s.preview_patch(a).await?).unwrap(),
    ))
}

async fn apply_patch(
    State(s): State<AppState>,
    Json(a): Json<PatchRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(serde_json::to_value(s.apply_patch(a).await?).unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpt_actions_origin_prefers_forwarded_https_host() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        headers.insert("x-forwarded-host", "source.example.test".parse().unwrap());
        headers.insert(header::HOST, "127.0.0.1:7331".parse().unwrap());

        assert_eq!(public_origin(&headers), "https://source.example.test");
    }

    #[test]
    fn gpt_actions_origin_rejects_unsafe_forwarded_host() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        headers.insert("x-forwarded-host", "bad/host".parse().unwrap());
        headers.insert(header::HOST, "127.0.0.1:7331".parse().unwrap());

        assert_eq!(public_origin(&headers), "https://127.0.0.1:7331");
    }
}
