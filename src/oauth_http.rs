use std::sync::Arc;

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue, Request, StatusCode, header},
    middleware::Next,
    response::{Html, IntoResponse, Response},
    routing::get,
};

use crate::oauth::{self, Principal};

const LANDING_HTML: &str = include_str!("../public/index.html");
const PRIVACY_HTML: &str = include_str!("../public/privacy.html");
const TERMS_HTML: &str = include_str!("../public/terms.html");
const SUPPORT_HTML: &str = include_str!("../public/support.html");
const ICON_SVG: &str = include_str!("../public/icon.svg");
const OPENAI_APPS_CHALLENGE_ENV: &str = "SOURCENERVE_OPENAI_APPS_CHALLENGE";
const OPENAI_APPS_CHALLENGE_MAX_BYTES: usize = 1024;

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
    if std::env::var("SOURCENERVE_DEBUG_AUTH").is_ok() {
        if let Some(t) = token {
            tracing::info!("DEBUG: Received OAuth MCP Token: {}", t);
        } else {
            tracing::warn!("DEBUG: No Authorization header / Bearer token found");
        }
    }

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
                return unauthorized(runtime, None);
            };
            match runtime.authenticate(token).await {
                Ok(principal) => {
                    request.extensions_mut().insert(Principal::OAuth(principal));
                    next.run(request).await
                }
                Err(e) => {
                    if std::env::var("SOURCENERVE_DEBUG_AUTH").is_ok() {
                        tracing::error!(
                            "DEBUG: JWT Authentication failed: {:?}",
                            e
                        );
                    }
                    match e {
                        oauth::AuthError::InvalidToken => unauthorized(runtime, Some("invalid_token")),
                        oauth::AuthError::InsufficientScope => insufficient_scope(),
                    }
                }
            }
        }
    }
}

fn unauthorized(runtime: &oauth::Runtime, error: Option<&str>) -> Response {
    let challenge = bearer_challenge(runtime.metadata_url(), error, oauth::READ_SCOPE);
    let mut response = (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": error.unwrap_or("unauthorized") })),
    )
        .into_response();
    if let Ok(value) = HeaderValue::from_str(&challenge) {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, value);
    }
    response
}

fn bearer_challenge(resource_metadata: &str, error: Option<&str>, scope: &str) -> String {
    match error {
        Some(error) => format!(
            "Bearer error=\"{error}\", resource_metadata=\"{resource_metadata}\", scope=\"{scope}\""
        ),
        None => format!("Bearer resource_metadata=\"{resource_metadata}\", scope=\"{scope}\""),
    }
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

fn valid_openai_apps_challenge(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= OPENAI_APPS_CHALLENGE_MAX_BYTES
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}

async fn openai_apps_challenge() -> Response {
    let Ok(value) = std::env::var(OPENAI_APPS_CHALLENGE_ENV) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !valid_openai_apps_challenge(&value) {
        return StatusCode::NOT_FOUND.into_response();
    }
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        value,
    )
        .into_response()
}

async fn plugin_icon() -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/svg+xml; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        ICON_SVG,
    )
        .into_response()
}

fn publication_router() -> Router {
    Router::new()
        .route("/", get(|| async { Html(LANDING_HTML) }))
        .route("/privacy", get(|| async { Html(PRIVACY_HTML) }))
        .route("/terms", get(|| async { Html(TERMS_HTML) }))
        .route("/support", get(|| async { Html(SUPPORT_HTML) }))
        .route("/icon.svg", get(plugin_icon))
        .route(
            "/.well-known/openai-apps-challenge",
            get(openai_apps_challenge),
        )
}

pub fn metadata_router(runtime: Option<oauth::Runtime>) -> Router {
    let public = publication_router();
    let Some(runtime) = runtime else {
        return public;
    };
    let root_runtime = runtime.clone();
    let path_runtime = runtime;
    public
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

    #[test]
    fn bearer_challenge_distinguishes_discovery_from_invalid_token() {
        let metadata = "https://sourcenerve.example.test/.well-known/oauth-protected-resource/mcp";
        let initial = bearer_challenge(metadata, None, oauth::READ_SCOPE);
        assert!(initial.contains("resource_metadata=\"https://sourcenerve.example.test/"));
        assert!(!initial.contains("error="));

        let invalid = bearer_challenge(metadata, Some("invalid_token"), oauth::READ_SCOPE);
        assert!(invalid.contains("error=\"invalid_token\""));
        assert!(invalid.contains("scope=\"sourcenerve:read\""));
    }

    #[test]
    fn openai_apps_challenge_requires_one_bounded_raw_token() {
        assert!(valid_openai_apps_challenge("challenge-token_123"));
        assert!(valid_openai_apps_challenge(&"x".repeat(1024)));
        assert!(!valid_openai_apps_challenge(""));
        assert!(!valid_openai_apps_challenge("contains space"));
        assert!(!valid_openai_apps_challenge("token\nsecond"));
        assert!(!valid_openai_apps_challenge(&"x".repeat(1025)));
    }

    #[test]
    fn publication_pages_and_icon_are_embedded() {
        assert!(LANDING_HTML.contains("SourceNerve"));
        assert!(PRIVACY_HTML.contains("Privacy Policy"));
        assert!(TERMS_HTML.contains("Terms of Use"));
        assert!(SUPPORT_HTML.contains("SourceNerve Support"));
        assert!(ICON_SVG.contains("<svg"));
    }
}
