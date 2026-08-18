use std::sync::Arc;

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue, Request, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
};

use crate::oauth::{self, Principal};

#[derive(Clone)]
pub struct McpAuthState {
    operator_token: Arc<String>,
    oauth: Option<oauth::Runtime>,
}

impl McpAuthState {
    pub fn new(operator_token: String, oauth: Option<oauth::Runtime>) -> Self {
        Self {
            operator_token: Arc::new(operator_token),
            oauth,
        }
    }
}

fn extract_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

pub async fn mcp_auth_middleware(
    State(auth): State<McpAuthState>,
    headers: HeaderMap,
    mut request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let token = extract_token(&headers);
    match auth.oauth.as_ref() {
        None => match token {
            Some(token) if token.as_bytes() == auth.operator_token.as_bytes() => {
                request.extensions_mut().insert(Principal::Operator);
                next.run(request).await
            }
            _ => StatusCode::UNAUTHORIZED.into_response(),
        },
        Some(runtime) => {
            if runtime.allow_operator_bearer()
                && token.is_some_and(|value| value.as_bytes() == auth.operator_token.as_bytes())
            {
                request.extensions_mut().insert(Principal::Operator);
                return next.run(request).await;
            }
            let Some(token) = token else {
                return unauthorized(runtime);
            };
            match runtime.authenticate(token).await {
                Ok(principal) => {
                    request.extensions_mut().insert(Principal::OAuth(principal));
                    next.run(request).await
                }
                Err(oauth::AuthError::InvalidToken) => unauthorized(runtime),
                Err(oauth::AuthError::InsufficientScope) => insufficient_scope(),
            }
        }
    }
}

fn unauthorized(runtime: &oauth::Runtime) -> Response {
    let challenge = format!(
        "Bearer resource_metadata=\"{}\", scope=\"{}\"",
        runtime.metadata_url(),
        oauth::READ_SCOPE
    );
    let mut response = (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": "unauthorized" })),
    )
        .into_response();
    if let Ok(value) = HeaderValue::from_str(&challenge) {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, value);
    }
    response
}

fn insufficient_scope() -> Response {
    let challenge = format!(
        "Bearer error=\"insufficient_scope\", scope=\"{}\"",
        oauth::READ_SCOPE
    );
    let mut response = (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({ "error": "insufficient_scope" })),
    )
        .into_response();
    if let Ok(value) = HeaderValue::from_str(&challenge) {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, value);
    }
    response
}

pub fn metadata_router(runtime: Option<oauth::Runtime>) -> Router {
    let Some(runtime) = runtime else {
        return Router::new();
    };
    let root_runtime = runtime.clone();
    let path_runtime = runtime;
    Router::new()
        .route(
            "/.well-known/oauth-protected-resource",
            get(move || {
                let runtime = root_runtime.clone();
                async move { Json(runtime.protected_resource_metadata()) }
            }),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(move || {
                let runtime = path_runtime.clone();
                async move { Json(runtime.protected_resource_metadata()) }
            }),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_extraction_rejects_non_bearer_schemes() {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Basic abc".parse().unwrap());
        assert!(extract_token(&headers).is_none());
        headers.insert(header::AUTHORIZATION, "Bearer token".parse().unwrap());
        assert_eq!(extract_token(&headers), Some("token"));
    }
}
