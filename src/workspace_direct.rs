use std::path::{Component, Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    error::{AppError, AppResult},
    ops,
    service::AppState,
    workspace::Workspace,
};

const MAX_DIRECT_FILE_BYTES: usize = 1_000_000;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WorkspaceFileWriteRequest {
    pub workspace: String,
    pub path: String,
    /// SHA-256 returned by read_file for an existing file. Use null only when creating a file that must not already exist.
    pub expected_sha256: Option<String>,
    pub content: String,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct WorkspaceFileWriteResponse {
    pub workspace: String,
    pub path: String,
    pub created: bool,
    pub bytes: usize,
    pub sha256: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WorkspaceFileDeleteRequest {
    pub workspace: String,
    pub path: String,
    /// SHA-256 returned by read_file. Deletion always requires an exact existing-file hash.
    pub expected_sha256: String,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct WorkspaceFileDeleteResponse {
    pub workspace: String,
    pub path: String,
    pub deleted: bool,
    pub deleted_sha256: String,
}

fn safe_relative_path(path: &str) -> bool {
    let value = Path::new(path);
    !path.is_empty()
        && !value.is_absolute()
        && !value.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}

fn hash_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

async fn resolve_target(workspace: &Workspace, path: &str) -> AppResult<(PathBuf, bool)> {
    if !safe_relative_path(path) {
        return Err(AppError::PathOutsideWorkspace);
    }
    let joined = workspace.root.join(path);
    match tokio::fs::symlink_metadata(&joined).await {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(AppError::PathOutsideWorkspace);
            }
            let canonical = tokio::fs::canonicalize(&joined).await?;
            if !canonical.starts_with(&workspace.root) {
                return Err(AppError::PathOutsideWorkspace);
            }
            Ok((canonical, true))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = joined.parent().ok_or(AppError::PathOutsideWorkspace)?;
            let canonical_parent = tokio::fs::canonicalize(parent).await.map_err(|_| {
                AppError::InvalidRequest(
                    "parent directory must already exist for direct file creation".into(),
                )
            })?;
            if !canonical_parent.starts_with(&workspace.root) || !canonical_parent.is_dir() {
                return Err(AppError::PathOutsideWorkspace);
            }
            let file_name = joined.file_name().ok_or(AppError::PathOutsideWorkspace)?;
            Ok((canonical_parent.join(file_name), false))
        }
        Err(error) => Err(AppError::Io(error)),
    }
}

async fn verify_expected_hash(
    target: &Path,
    path: &str,
    exists: bool,
    expected_sha256: Option<&str>,
) -> AppResult<Option<String>> {
    if !exists {
        if expected_sha256.is_some() {
            return Err(AppError::FileChanged {
                path: path.to_string(),
            });
        }
        return Ok(None);
    }
    let expected = expected_sha256.ok_or_else(|| AppError::FileChanged {
        path: path.to_string(),
    })?;
    let bytes = tokio::fs::read(target).await?;
    let actual = hash_bytes(&bytes);
    if actual != expected {
        return Err(AppError::FileChanged {
            path: path.to_string(),
        });
    }
    Ok(Some(actual))
}

impl AppState {
    pub async fn workspace_file_write(
        &self,
        request: WorkspaceFileWriteRequest,
    ) -> AppResult<WorkspaceFileWriteResponse> {
        ops::validate_request_key(request.request_id.as_deref())?;
        if request.content.len() > MAX_DIRECT_FILE_BYTES {
            return Err(AppError::InvalidRequest(
                "direct file content exceeds 1 MB limit".into(),
            ));
        }
        let workspace = self.workspaces.get(&request.workspace)?;
        if !workspace.writable {
            return Err(AppError::ReadOnlyWorkspace);
        }
        let _guard = self.mutation_lock.lock().await;
        let (target, existed) = resolve_target(&workspace, &request.path).await?;
        verify_expected_hash(
            &target,
            &request.path,
            existed,
            request.expected_sha256.as_deref(),
        )
        .await?;

        let result: AppResult<WorkspaceFileWriteResponse> = async {
            tokio::fs::write(&target, request.content.as_bytes()).await?;
            let bytes = tokio::fs::read(&target).await?;
            let sha256 = hash_bytes(&bytes);
            Ok(WorkspaceFileWriteResponse {
                workspace: request.workspace.clone(),
                path: request.path.clone(),
                created: !existed,
                bytes: bytes.len(),
                sha256,
            })
        }
        .await;
        let result_sha = result
            .as_ref()
            .ok()
            .map(|response| response.sha256.as_str());
        if let Err(error) = ops::record_audit(
            self,
            &request.workspace,
            "workspace_file_write",
            request.request_id.as_deref(),
            serde_json::json!({
                "path": request.path,
                "created": !existed,
                "bytes": request.content.len(),
                "mode": "interactive-local",
            }),
            ops::audit_outcome(&result),
            result_sha,
        )
        .await
        {
            tracing::error!(workspace = %request.workspace, error = %error, "failed to audit direct file write");
        }
        result
    }

    pub async fn workspace_file_delete(
        &self,
        request: WorkspaceFileDeleteRequest,
    ) -> AppResult<WorkspaceFileDeleteResponse> {
        ops::validate_request_key(request.request_id.as_deref())?;
        let workspace = self.workspaces.get(&request.workspace)?;
        if !workspace.writable {
            return Err(AppError::ReadOnlyWorkspace);
        }
        let _guard = self.mutation_lock.lock().await;
        let (target, exists) = resolve_target(&workspace, &request.path).await?;
        if !exists {
            return Err(AppError::FileChanged {
                path: request.path.clone(),
            });
        }
        let deleted_sha256 =
            verify_expected_hash(&target, &request.path, true, Some(&request.expected_sha256))
                .await?
                .expect("existing direct-delete target must have a hash");

        let result: AppResult<WorkspaceFileDeleteResponse> = async {
            tokio::fs::remove_file(&target).await?;
            Ok(WorkspaceFileDeleteResponse {
                workspace: request.workspace.clone(),
                path: request.path.clone(),
                deleted: true,
                deleted_sha256: deleted_sha256.clone(),
            })
        }
        .await;
        if let Err(error) = ops::record_audit(
            self,
            &request.workspace,
            "workspace_file_delete",
            request.request_id.as_deref(),
            serde_json::json!({
                "path": request.path,
                "mode": "interactive-local",
            }),
            ops::audit_outcome(&result),
            result
                .as_ref()
                .ok()
                .map(|response| response.deleted_sha256.as_str()),
        )
        .await
        {
            tracing::error!(workspace = %request.workspace, error = %error, "failed to audit direct file delete");
        }
        result
    }
}
