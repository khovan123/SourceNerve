use std::process::Stdio;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use tokio::process::Command;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    git,
    service::AppState,
};

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct DependencyReadiness {
    pub name: String,
    pub ready: bool,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct WorkspaceReadiness {
    pub workspace: String,
    pub ready: bool,
    pub head: Option<String>,
    pub clean: Option<bool>,
    pub remote_ready: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ReadinessReport {
    pub ready: bool,
    pub database_ready: bool,
    pub dependencies: Vec<DependencyReadiness>,
    pub workspaces: Vec<WorkspaceReadiness>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AuditQuery {
    pub workspace: String,
    #[serde(default = "default_audit_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AuditEvent {
    pub id: String,
    pub workspace: String,
    pub operation: String,
    pub request_id: Option<String>,
    pub target: serde_json::Value,
    pub outcome: String,
    pub result_sha: Option<String>,
    pub created_at: i64,
}

fn default_audit_limit() -> usize {
    50
}

async fn executable_ready(name: &str, required: bool) -> DependencyReadiness {
    let ready = Command::new(name)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false);
    DependencyReadiness {
        name: name.to_string(),
        ready,
        required,
    }
}

impl AppState {
    pub async fn readiness(&self) -> ReadinessReport {
        let database_ready = sqlx::query_scalar::<_, i64>("SELECT 1")
            .fetch_one(&self.db)
            .await
            .map(|value| value == 1)
            .unwrap_or(false);

        let github_required = self.github_token.is_some();
        let dependencies = vec![
            executable_ready("git", true).await,
            executable_ready("rg", true).await,
            executable_ready("gh", github_required).await,
        ];

        let mut workspaces = Vec::new();
        for view in self.workspaces.list() {
            let workspace = match self.workspaces.get(&view.id) {
                Ok(workspace) => workspace,
                Err(_) => {
                    workspaces.push(WorkspaceReadiness {
                        workspace: view.id,
                        ready: false,
                        head: None,
                        clean: None,
                        remote_ready: false,
                        reason: Some("workspace_unavailable".into()),
                    });
                    continue;
                }
            };
            let head = git::head(&workspace.root).await.ok();
            let status = git::status(&workspace.root).await.ok();
            let remote_ready = git::remote_url(&workspace.root, &workspace.remote)
                .await
                .is_ok();
            let ready = head.is_some() && status.is_some() && remote_ready;
            workspaces.push(WorkspaceReadiness {
                workspace: workspace.id,
                ready,
                head,
                clean: status.as_ref().map(|value| value.is_empty()),
                remote_ready,
                reason: (!ready).then_some("git_workspace_not_ready".into()),
            });
        }

        let dependencies_ready = dependencies
            .iter()
            .all(|dependency| !dependency.required || dependency.ready);
        let workspaces_ready = workspaces.iter().all(|workspace| workspace.ready);
        ReadinessReport {
            ready: database_ready && dependencies_ready && workspaces_ready,
            database_ready,
            dependencies,
            workspaces,
        }
    }

    pub async fn audit_events(&self, query: AuditQuery) -> AppResult<Vec<AuditEvent>> {
        self.workspaces.get(&query.workspace)?;
        let limit = query.limit.clamp(1, 200) as i64;
        let rows: Vec<(String, String, Option<String>, String, String, Option<String>, i64)> =
            sqlx::query_as(
                "SELECT id, operation, request_id, target_json, outcome, result_sha, created_at \
                 FROM mutation_audit WHERE workspace_id=?1 \
                 ORDER BY created_at DESC, rowid DESC LIMIT ?2",
            )
            .bind(&query.workspace)
            .bind(limit)
            .fetch_all(&self.db)
            .await?;
        rows.into_iter()
            .map(
                |(id, operation, request_id, target_json, outcome, result_sha, created_at)| {
                    let target = serde_json::from_str(&target_json).map_err(|error| {
                        AppError::Internal(anyhow::anyhow!("invalid persisted audit JSON: {error}"))
                    })?;
                    Ok(AuditEvent {
                        id,
                        workspace: query.workspace.clone(),
                        operation,
                        request_id,
                        target,
                        outcome,
                        result_sha,
                        created_at,
                    })
                },
            )
            .collect()
    }
}

pub(crate) fn validate_request_key(value: Option<&str>) -> AppResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.is_empty() || value.len() > 128 {
        return Err(AppError::InvalidRequest(
            "request/idempotency key must be between 1 and 128 bytes".into(),
        ));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(AppError::InvalidRequest(
            "request/idempotency key contains unsupported characters".into(),
        ));
    }
    Ok(())
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
    let target_json = serde_json::to_string(&target).map_err(anyhow::Error::from)?;
    if target_json.len() > 4096 {
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
        Err(AppError::Command(_) | AppError::Io(_) | AppError::Sqlx(_) | AppError::Internal(_)) => {
            "failed"
        }
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
    key: Option<&str>,
    request_sha256: &str,
) -> AppResult<Option<T>> {
    validate_request_key(key)?;
    let Some(key) = key else {
        return Ok(None);
    };
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT request_sha256, response_json FROM idempotency_records \
         WHERE workspace_id=?1 AND operation=?2 AND idempotency_key=?3",
    )
    .bind(workspace)
    .bind(operation)
    .bind(key)
    .fetch_optional(&state.db)
    .await?;
    let Some((stored_request_sha256, response_json)) = row else {
        return Ok(None);
    };
    if stored_request_sha256 != request_sha256 {
        return Err(AppError::InvalidRequest(
            "idempotency key was already used for a different request".into(),
        ));
    }
    let response = serde_json::from_str(&response_json).map_err(|error| {
        AppError::Internal(anyhow::anyhow!(
            "invalid persisted idempotency response: {error}"
        ))
    })?;
    Ok(Some(response))
}

pub(crate) async fn idempotency_store<T: Serialize>(
    state: &AppState,
    workspace: &str,
    operation: &str,
    key: Option<&str>,
    request_sha256: &str,
    response: &T,
) -> AppResult<()> {
    let Some(key) = key else {
        return Ok(());
    };
    validate_request_key(Some(key))?;
    let response_json = serde_json::to_string(response).map_err(anyhow::Error::from)?;
    sqlx::query(
        "INSERT INTO idempotency_records(workspace_id, operation, idempotency_key, request_sha256, response_json, created_at) \
         VALUES(?1, ?2, ?3, ?4, ?5, unixepoch())",
    )
    .bind(workspace)
    .bind(operation)
    .bind(key)
    .bind(request_sha256)
    .bind(response_json)
    .execute(&state.db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{request_fingerprint, validate_request_key};

    #[test]
    fn validates_request_keys() {
        validate_request_key(Some("agent:run-123_abc.def")).expect("valid key");
        assert!(validate_request_key(Some("contains spaces")).is_err());
        assert!(validate_request_key(Some("")).is_err());
    }

    #[test]
    fn fingerprint_is_deterministic_for_the_same_json_shape() {
        let value = serde_json::json!({"workspace":"demo","title":"same"});
        assert_eq!(
            request_fingerprint(&value).expect("first fingerprint"),
            request_fingerprint(&value).expect("second fingerprint")
        );
    }
}
