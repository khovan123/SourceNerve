use std::sync::Arc;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use sha2::{Digest, Sha256};

use crate::{github_webhook, service::AppState};

pub const MAX_GITHUB_WEBHOOK_BODY_BYTES: usize = 256 * 1024;
const DELIVERY_HEADER: &str = "x-github-delivery";
const EVENT_HEADER: &str = "x-github-event";
const SIGNATURE_HEADER: &str = "x-hub-signature-256";

#[derive(Clone)]
struct GitHubWebhookState {
    app: AppState,
    secret: Arc<String>,
}

pub fn router(state: AppState, secret: String) -> Router {
    Router::new()
        .route("/webhooks/v1/github", post(webhook_ingest))
        .layer(DefaultBodyLimit::max(MAX_GITHUB_WEBHOOK_BODY_BYTES))
        .with_state(GitHubWebhookState {
            app: state,
            secret: Arc::new(secret),
        })
}

fn hmac_sha256(secret: &[u8], body: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut key = [0_u8; BLOCK];
    if secret.len() > BLOCK {
        let digest = Sha256::digest(secret);
        key[..digest.len()].copy_from_slice(&digest);
    } else {
        key[..secret.len()].copy_from_slice(secret);
    }

    let mut inner_pad = [0x36_u8; BLOCK];
    let mut outer_pad = [0x5c_u8; BLOCK];
    for ((inner, outer), key_byte) in inner_pad
        .iter_mut()
        .zip(outer_pad.iter_mut())
        .zip(key.iter())
    {
        *inner ^= *key_byte;
        *outer ^= *key_byte;
    }

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(body);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_hash);
    let digest = outer.finalize();
    let mut result = [0_u8; 32];
    result.copy_from_slice(&digest);
    result
}

fn constant_time_eq(left: &[u8; 32], right: &[u8; 32]) -> bool {
    let mut difference = 0_u8;
    for (&left_byte, &right_byte) in left.iter().zip(right.iter()) {
        difference |= left_byte ^ right_byte;
    }
    difference == 0
}

fn verify_signature(headers: &HeaderMap, body: &[u8], secret: &str) -> bool {
    let signature = match headers
        .get(SIGNATURE_HEADER)
        .and_then(|value| value.to_str().ok())
    {
        Some(value) => value,
        None => return false,
    };
    let encoded = match signature.strip_prefix("sha256=") {
        Some(value) if value.len() == 64 => value,
        _ => return false,
    };
    let decoded = match hex::decode(encoded) {
        Ok(value) if value.len() == 32 => value,
        _ => return false,
    };
    let mut supplied = [0_u8; 32];
    supplied.copy_from_slice(&decoded);
    let expected = hmac_sha256(secret.as_bytes(), body);
    constant_time_eq(&supplied, &expected)
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": "invalid GitHub webhook signature" })),
    )
        .into_response()
}

async fn webhook_ingest(
    State(state): State<GitHubWebhookState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !verify_signature(&headers, &body, state.secret.as_str()) {
        return unauthorized();
    }

    let delivery_id = match headers
        .get(DELIVERY_HEADER)
        .and_then(|value| value.to_str().ok())
    {
        Some(value) => value,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "missing X-GitHub-Delivery header" })),
            )
                .into_response();
        }
    };
    let event = match headers
        .get(EVENT_HEADER)
        .and_then(|value| value.to_str().ok())
    {
        Some(value) => value,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "missing X-GitHub-Event header" })),
            )
                .into_response();
        }
    };
    let payload: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid GitHub webhook JSON body" })),
            )
                .into_response();
        }
    };

    match github_webhook::ingest(&state.app, delivery_id, event, &body, &payload).await {
        Ok(result) => {
            let status = if result.accepted && !result.replayed {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            (status, Json(serde_json::to_value(result).unwrap())).into_response()
        }
        Err(error) => error.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};

    use super::{SIGNATURE_HEADER, hmac_sha256, verify_signature};

    #[test]
    fn hmac_matches_github_documented_vector() {
        assert_eq!(
            hex::encode(hmac_sha256(b"It's a Secret to Everybody", b"Hello, World!")),
            "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"
        );
    }

    #[test]
    fn signature_is_bound_to_exact_raw_body() {
        let secret = "0123456789abcdef0123456789abcdef";
        let body = br#"{"action":"completed"}"#;
        let signature = hex::encode(hmac_sha256(secret.as_bytes(), body));
        let mut headers = HeaderMap::new();
        headers.insert(
            SIGNATURE_HEADER,
            HeaderValue::from_str(&format!("sha256={signature}")).unwrap(),
        );
        assert!(verify_signature(&headers, body, secret));
        assert!(!verify_signature(
            &headers,
            br#"{"action":"completed","changed":true}"#,
            secret
        ));
    }
}
