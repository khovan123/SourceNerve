use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    service::AppState,
};

const MAX_REQUEST_KEY_BYTES: usize = 128;
const MAX_AUDIT_TARGET_BYTES: usize = 4096;
const IDEMPOTENCY_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;
const IDEMPOTENCY_MAX_ROWS_PER_WORKSPACE: i64 = 5000;

pub(crate) fn now_epoch_seconds() -> AppResult<i64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(anyhow::Error::from)?;
    i64::try_from(duration.as_secs()).map_err(|_| anyhow::anyhow!("system time overflow").into())
}

pub(crate) fn validate_request_key(value: Option<&str>) -> AppResult<()> {
    if let Some(value) = value {
        if value.is_empty() || value.len() > MAX_REQUEST_KEY_BYTES || value.chars().any(char::is_control)
        {
            return Err(AppError::InvalidRequest(format!(
                "request id must be 1-{MAX_REQUEST_KEY_BYTES} bytes and must not contain control characters"
            )));
        }
    }
    Ok(())
}

pub(crate) fn normalize_request_key(value: Option<&str>) -> Option<String> {
    value.map(ToOwned::to_owned)
}

pub(crate) fn sanitize_target(value: serde_json::Value) -> AppResult<serde_json::Value> {
    fn visit(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(map) => serde_json::Value::Object(
                map.into_iter()
                    .map(|(key, value)| {
                        let lower = key.to_ascii_lowercase();
                        let value = if lower.contains("token")
                            || lower.contains("secret")
                            || lower.contains("password")
                            || lower.contains("authorization")
                            || lower == "body"
                            || lower == "content"
                            || lower == "patch"
                        {
                            serde_json::Value::String("[redacted]".into())
                        } else {
                            visit(value)
                        };
                        (key, value)
                    })
                    .collect(),
            ),
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(visit).collect())
            }
            other => other,
        }
    }
    let sanitized = visit(value);
    let bytes = serde_json::to_vec(&sanitized).map_err(anyhow::Error::from)?;
    if bytes.len() > MAX_AUDIT_TARGET_BYTES {
        return Err(AppError::InvalidRequest(
            "sanitized audit target exceeds 4 KB".into(),
        ));
    }
    Ok(sanitized)
}

pub(crate) async fn record_audit(
    state: &AppState,
    workspace: &str,
    operation: &str,
    request_id: Option<&str>,
    target: serde_json::Value,
    outcome: &str,
    result_sha: Option<&str>,
) -> AppResult<()> {
    validate_request_key(request_id)?;
    let target = sanitize_target(target)?;
    let target_json = serde_json::to_string(&target).map_err(anyhow::Error::from)?;
    if target_json.len() > MAX_AUDIT_TARGET_BYTES {
        return Err(AppError::InvalidRequest(
            "sanitized audit target exceeds 4 KB".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO mutation_audit(id, workspace_id, operation, request_id, target_json, outcome, result_sha, created_at) \
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, unixepoch())",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(workspace)
    .bind(operation)
    .bind(request_id)
    .bind(target_json)
    .bind(outcome)
    .bind(result_sha)
    .execute(&state.db)
    .await?;
    Ok(())
}

pub(crate) fn audit_outcome<T>(result: &AppResult<T>) -> &'static str {
    match result {
        Ok(_) => "success",
        Err(
            AppError::WorkspaceNotFound(_)
            | AppError::PathOutsideWorkspace
            | AppError::ReadOnlyWorkspace
            | AppError::WorkspaceChanged { .. }
            | AppError::FileChanged { .. }
            | AppError::InvalidRequest(_),
        ) => "rejected",
        Err(
            AppError::Sandbox(_)
            | AppError::Command(_)
            | AppError::Io(_)
            | AppError::Sqlx(_)
            | AppError::Internal(_),
        ) => "failed",
    }
}

pub(crate) fn request_fingerprint(value: &serde_json::Value) -> AppResult<String> {
    let bytes = serde_json::to_vec(value).map_err(anyhow::Error::from)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

pub(crate) async fn idempotency_lookup<T: DeserializeOwned>(
    state: &AppState,
    workspace: &str,
    operation: &str,
    key: &str,
    request_sha256: &str,
) -> AppResult<Option<T>> {
    validate_request_key(Some(key))?;
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT request_sha256, response_json FROM idempotency_records \
         WHERE workspace_id=?1 AND operation=?2 AND idempotency_key=?3",
    )
    .bind(workspace)
    .bind(operation)
    .bind(key)
    .fetch_optional(&state.db)
    .await?;
    let Some((stored_sha, response_json)) = row else {
        return Ok(None);
    };
    if stored_sha != request_sha256 {
        return Err(AppError::InvalidRequest(
            "idempotency key was already used for a different request".into(),
        ));
    }
    let response = serde_json::from_str(&response_json).map_err(anyhow::Error::from)?;
    Ok(Some(response))
}

pub(crate) async fn idempotency_store<T: Serialize>(
    state: &AppState,
    workspace: &str,
    operation: &str,
    key: &str,
    request_sha256: &str,
    response: &T,
) -> AppResult<()> {
    validate_request_key(Some(key))?;
    let response_json = serde_json::to_string(response).map_err(anyhow::Error::from)?;
    sqlx::query(
        "INSERT INTO idempotency_records(workspace_id, operation, idempotency_key, request_sha256, response_json, created_at) \
         VALUES(?1, ?2, ?3, ?4, ?5, unixepoch()) \
         ON CONFLICT(workspace_id, operation, idempotency_key) DO UPDATE SET \
           response_json=excluded.response_json, created_at=excluded.created_at \
         WHERE idempotency_records.request_sha256=excluded.request_sha256",
    )
    .bind(workspace)
    .bind(operation)
    .bind(key)
    .bind(request_sha256)
    .bind(response_json)
    .execute(&state.db)
    .await?;
    prune_idempotency(state, workspace).await
}

async fn prune_idempotency(state: &AppState, workspace: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM idempotency_records WHERE created_at < unixepoch() - ?1")
        .bind(IDEMPOTENCY_TTL_SECONDS)
        .execute(&state.db)
        .await?;
    sqlx::query(
        "DELETE FROM idempotency_records WHERE rowid IN (\
            SELECT rowid FROM idempotency_records WHERE workspace_id=?1 \
            ORDER BY created_at DESC LIMIT -1 OFFSET ?2\
         )",
    )
    .bind(workspace)
    .bind(IDEMPOTENCY_MAX_ROWS_PER_WORKSPACE)
    .execute(&state.db)
    .await?;
    Ok(())
}
