use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use sha2::{Digest, Sha256};

use crate::{
    job_ingress::{self, JobGetRequest, JobSubmitRequest},
    service::AppState,
};

pub const MAX_WEBHOOK_BODY_BYTES: usize = 64 * 1024;
const MAX_TIMESTAMP_SKEW_SECONDS: u64 = 300;
const TIMESTAMP_HEADER: &str = "x-sourcenerve-timestamp";
const SIGNATURE_HEADER: &str = "x-sourcenerve-signature";

#[derive(Clone)]
struct WebhookState {
    app: AppState,
    secret: Arc<String>,
}

pub fn api_router() -> Router<AppState> {
    Router::new().route("/jobs/get", post(job_get))
}

pub fn webhook_router(state: AppState, secret: String) -> Router {
    Router::new()
        .route("/webhooks/v1/jobs", post(webhook_submit))
        .layer(DefaultBodyLimit::max(MAX_WEBHOOK_BODY_BYTES))
        .with_state(WebhookState {
            app: state,
            secret: Arc::new(secret),
        })
}

fn hmac_sha256(secret: &[u8], timestamp: &[u8], body: &[u8]) -> [u8; 32] {
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
    for index in 0..BLOCK {
        inner_pad[index] ^= key[index];
        outer_pad[index] ^= key[index];
    }

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(timestamp);
    inner.update(b".");
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
    for index in 0..left.len() {
        difference |= left[index] ^ right[index];
    }
    difference == 0
}

fn verify_signature_at(headers: &HeaderMap, body: &[u8], secret: &str, now_seconds: u64) -> bool {
    let timestamp = match headers
        .get(TIMESTAMP_HEADER)
        .and_then(|value| value.to_str().ok())
    {
        Some(value) if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) => {
            value
        }
        _ => return false,
    };
    let timestamp_seconds = match timestamp.parse::<u64>() {
        Ok(value) => value,
        Err(_) => return false,
    };
    if now_seconds.abs_diff(timestamp_seconds) > MAX_TIMESTAMP_SKEW_SECONDS {
        return false;
    }

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
    let expected = hmac_sha256(secret.as_bytes(), timestamp.as_bytes(), body);
    constant_time_eq(&supplied, &expected)
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": "invalid webhook signature" })),
    )
        .into_response()
}

async fn webhook_submit(
    State(state): State<WebhookState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(value) => value.as_secs(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if !verify_signature_at(&headers, &body, state.secret.as_str(), now) {
        return unauthorized();
    }

    let request: JobSubmitRequest = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid webhook JSON body" })),
            )
                .into_response();
        }
    };
    match job_ingress::submit(&state.app, request).await {
        Ok(result) => {
            let status = if result.replayed {
                StatusCode::OK
            } else {
                StatusCode::CREATED
            };
            (status, Json(serde_json::to_value(result).unwrap())).into_response()
        }
        Err(error) => error.into_response(),
    }
}

async fn job_get(
    State(state): State<AppState>,
    Json(request): Json<JobGetRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(job_ingress::get(&state, request).await?).unwrap(),
    ))
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};

    use super::{SIGNATURE_HEADER, TIMESTAMP_HEADER, hmac_sha256, verify_signature_at};

    #[test]
    fn hmac_matches_known_sha256_vector() {
        let secret = b"0123456789abcdef0123456789abcdef";
        let timestamp = b"1723975200";
        let body = br#"{"client_request_id":"job-1","workspace":"task"}"#;
        assert_eq!(
            hex::encode(hmac_sha256(secret, timestamp, body)),
            "f0234e3efcb37b686a956349c553ad6eecda473f95ec42da4a83dcc3d4e204f7"
        );
    }

    #[test]
    fn signature_verification_is_timestamp_bounded_and_exact() {
        let secret = "0123456789abcdef0123456789abcdef";
        let timestamp = "1723975200";
        let body = br#"{"client_request_id":"job-1","workspace":"task"}"#;
        let signature = hex::encode(hmac_sha256(secret.as_bytes(), timestamp.as_bytes(), body));
        let mut headers = HeaderMap::new();
        headers.insert(TIMESTAMP_HEADER, HeaderValue::from_static("1723975200"));
        headers.insert(
            SIGNATURE_HEADER,
            HeaderValue::from_str(&format!("sha256={signature}")).unwrap(),
        );

        assert!(verify_signature_at(&headers, body, secret, 1_723_975_200));
        assert!(!verify_signature_at(
            &headers,
            br#"{"client_request_id":"job-2","workspace":"task"}"#,
            secret,
            1_723_975_200
        ));
        assert!(!verify_signature_at(&headers, body, secret, 1_723_975_501));
    }
}
