use std::path::{Component, Path, PathBuf};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
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
const MAX_TRANSFER_FILE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceFileFetchEncoding {
    Auto,
    Utf8,
    Base64,
}

impl Default for WorkspaceFileFetchEncoding {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WorkspaceFileFetchRequest {
    pub workspace: String,
    pub path: String,
    #[serde(default)]
    pub encoding: WorkspaceFileFetchEncoding,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct WorkspaceFileFetchResponse {
    pub workspace: String,
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
    pub encoding: String,
    pub content: String,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceFilePutEncoding {
    Utf8,
    Base64,
}

impl Default for WorkspaceFilePutEncoding {
    fn default() -> Self {
        Self::Utf8
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WorkspaceFilePutRequest {
    pub workspace: String,
    pub path: String,
    /// SHA-256 returned by workspace_file_fetch/read_file for an existing file. Use null only when creating a file that must not already exist.
    pub expected_sha256: Option<String>,
    pub content: String,
    #[serde(default)]
    pub encoding: WorkspaceFilePutEncoding,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct WorkspaceFilePutResponse {
    pub workspace: String,
    pub path: String,
    pub created: bool,
    pub bytes: usize,
    pub sha256: String,
    pub encoding: String,
}

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
    /// SHA-256 returned by read_file/workspace_file_fetch. Deletion always requires an exact existing-file hash.
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

fn decode_put_content(request: &WorkspaceFilePutRequest) -> AppResult<Vec<u8>> {
    let bytes = match request.encoding {
        WorkspaceFilePutEncoding::Utf8 => request.content.as_bytes().to_vec(),
        WorkspaceFilePutEncoding::Base64 => BASE64_STANDARD
            .decode(request.content.as_bytes())
            .map_err(|_| {
                AppError::InvalidRequest("workspace file base64 content is invalid".into())
            })?,
    };
    if bytes.len() > MAX_TRANSFER_FILE_BYTES {
        return Err(AppError::InvalidRequest(
            "workspace file transfer exceeds 4 MiB limit".into(),
        ));
    }
    Ok(bytes)
}

impl AppState {
    pub async fn workspace_file_fetch(
        &self,
        request: WorkspaceFileFetchRequest,
    ) -> AppResult<WorkspaceFileFetchResponse> {
        let workspace = self.workspaces.get(&request.workspace)?;
        let (target, exists) = resolve_target(&workspace, &request.path).await?;
        if !exists {
            return Err(AppError::InvalidRequest(
                "workspace file does not exist".into(),
            ));
        }
        let bytes = tokio::fs::read(&target).await?;
        if bytes.len() > MAX_TRANSFER_FILE_BYTES {
            return Err(AppError::InvalidRequest(
                "workspace file transfer exceeds 4 MiB limit".into(),
            ));
        }
        let byte_len = bytes.len();
        let sha256 = hash_bytes(&bytes);
        let (encoding, content) = match request.encoding {
            WorkspaceFileFetchEncoding::Base64 => {
                ("base64".to_string(), BASE64_STANDARD.encode(&bytes))
            }
            WorkspaceFileFetchEncoding::Utf8 => {
                let content = String::from_utf8(bytes).map_err(|_| {
                    AppError::InvalidRequest(
                        "workspace file is not valid UTF-8; fetch it with encoding=base64 or auto"
                            .into(),
                    )
                })?;
                ("utf8".to_string(), content)
            }
            WorkspaceFileFetchEncoding::Auto => match String::from_utf8(bytes.clone()) {
                Ok(content) => ("utf8".to_string(), content),
                Err(_) => ("base64".to_string(), BASE64_STANDARD.encode(&bytes)),
            },
        };
        Ok(WorkspaceFileFetchResponse {
            workspace: request.workspace,
            path: request.path,
            bytes: byte_len,
            sha256,
            encoding,
            content,
        })
    }

    pub async fn workspace_file_put(
        &self,
        request: WorkspaceFilePutRequest,
    ) -> AppResult<WorkspaceFilePutResponse> {
        ops::validate_request_key(request.request_id.as_deref())?;
        let bytes = decode_put_content(&request)?;
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

        let result: AppResult<WorkspaceFilePutResponse> = async {
            tokio::fs::write(&target, &bytes).await?;
            let written = tokio::fs::read(&target).await?;
            let sha256 = hash_bytes(&written);
            Ok(WorkspaceFilePutResponse {
                workspace: request.workspace.clone(),
                path: request.path.clone(),
                created: !existed,
                bytes: written.len(),
                sha256,
                encoding: match request.encoding {
                    WorkspaceFilePutEncoding::Utf8 => "utf8",
                    WorkspaceFilePutEncoding::Base64 => "base64",
                }
                .to_string(),
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
            "workspace_file_put",
            request.request_id.as_deref(),
            serde_json::json!({
                "path": request.path,
                "created": !existed,
                "bytes": bytes.len(),
                "encoding": match request.encoding {
                    WorkspaceFilePutEncoding::Utf8 => "utf8",
                    WorkspaceFilePutEncoding::Base64 => "base64",
                },
                "mode": "interactive-local",
            }),
            ops::audit_outcome(&result),
            result_sha,
        )
        .await
        {
            tracing::error!(workspace = %request.workspace, error = %error, "failed to audit direct file put");
        }
        result
    }

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

#[cfg(test)]
mod tests {
    use std::{path::Path, process::Command, sync::Arc};

    use tempfile::TempDir;
    use tokio::sync::Mutex;

    use super::*;
    use crate::{config::WorkspaceConfig, db, workspace::WorkspaceRegistry};

    fn run_git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .expect("run git fixture command");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    async fn fixture() -> (TempDir, std::path::PathBuf, std::path::PathBuf, AppState) {
        let root = tempfile::tempdir().expect("fixture root");
        let repo = root.path().join("repo");
        let remote = root.path().join("remote.git");
        let state_dir = root.path().join("state");
        std::fs::create_dir_all(&repo).expect("create repo");
        std::fs::create_dir_all(&remote).expect("create remote");
        run_git(&remote, &["init", "--bare"]);
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "user.name", "SourceNerve Test"]);
        run_git(
            &repo,
            &["config", "user.email", "sourcenerve@example.invalid"],
        );
        std::fs::write(repo.join("target.txt"), "baseline\n").expect("write target");
        std::fs::write(repo.join("unrelated.txt"), "baseline\n").expect("write unrelated");
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "-m", "baseline"]);
        run_git(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        run_git(&repo, &["push", "-u", "origin", "main"]);

        let registry = WorkspaceRegistry::build(&[WorkspaceConfig {
            id: "direct".into(),
            name: "Direct Workspace Fixture".into(),
            root: repo.clone(),
            access: "read-write".into(),
            remote: "origin".into(),
            default_branch: "main".into(),
            provider: None,
            repository: None,
            github_repository: None,
        }])
        .expect("build workspace registry");
        let pool = db::connect(&state_dir).await.expect("connect state db");
        db::register_workspaces(&pool, &registry)
            .await
            .expect("register workspace");
        let state = AppState {
            workspaces: registry,
            db: pool,
            mutation_lock: Arc::new(Mutex::new(())),
            github_token: None,
        };
        (root, repo, remote, state)
    }

    #[tokio::test]
    async fn fetch_auto_returns_utf8_and_exact_hash() {
        let (_root, repo, _remote, state) = fixture().await;
        let response = state
            .workspace_file_fetch(WorkspaceFileFetchRequest {
                workspace: "direct".into(),
                path: "target.txt".into(),
                encoding: WorkspaceFileFetchEncoding::Auto,
            })
            .await
            .expect("fetch text");
        assert_eq!(response.encoding, "utf8");
        assert_eq!(response.content, "baseline\n");
        assert_eq!(response.bytes, 9);
        assert_eq!(
            response.sha256,
            hash_bytes(&std::fs::read(repo.join("target.txt")).unwrap())
        );
    }

    #[tokio::test]
    async fn binary_put_and_fetch_round_trip_base64() {
        let (_root, repo, _remote, state) = fixture().await;
        let binary = vec![0_u8, 159, 146, 150, 255, 1, 2, 3];
        let put = state
            .workspace_file_put(WorkspaceFilePutRequest {
                workspace: "direct".into(),
                path: "binary.bin".into(),
                expected_sha256: None,
                content: BASE64_STANDARD.encode(&binary),
                encoding: WorkspaceFilePutEncoding::Base64,
                request_id: Some("direct:binary-put".into()),
            })
            .await
            .expect("put binary");
        assert!(put.created);
        assert_eq!(std::fs::read(repo.join("binary.bin")).unwrap(), binary);

        let fetched = state
            .workspace_file_fetch(WorkspaceFileFetchRequest {
                workspace: "direct".into(),
                path: "binary.bin".into(),
                encoding: WorkspaceFileFetchEncoding::Auto,
            })
            .await
            .expect("fetch binary");
        assert_eq!(fetched.encoding, "base64");
        assert_eq!(BASE64_STANDARD.decode(fetched.content).unwrap(), binary);
        assert_eq!(fetched.sha256, put.sha256);
    }

    #[tokio::test]
    async fn direct_write_preserves_dirty_tree_and_never_commits_or_pushes() {
        let (_root, repo, remote, state) = fixture().await;
        let expected = hash_bytes(&std::fs::read(repo.join("target.txt")).unwrap());
        let head_before = run_git(&repo, &["rev-parse", "HEAD"]);
        let remote_before = run_git(&remote, &["rev-parse", "refs/heads/main"]);

        std::fs::write(repo.join("unrelated.txt"), "user dirty change\n")
            .expect("write unrelated dirty change");
        state
            .workspace_file_write(WorkspaceFileWriteRequest {
                workspace: "direct".into(),
                path: "target.txt".into(),
                expected_sha256: Some(expected),
                content: "direct edit\n".into(),
                request_id: Some("direct:dirty-tree".into()),
            })
            .await
            .expect("direct write in dirty tree");

        assert_eq!(
            std::fs::read_to_string(repo.join("unrelated.txt")).unwrap(),
            "user dirty change\n"
        );
        assert_eq!(run_git(&repo, &["rev-parse", "HEAD"]), head_before);
        assert_eq!(
            run_git(&remote, &["rev-parse", "refs/heads/main"]),
            remote_before
        );
        let status = run_git(&repo, &["status", "--porcelain"]);
        assert!(status.contains("target.txt"));
        assert!(status.contains("unrelated.txt"));
    }

    #[tokio::test]
    async fn direct_write_rejects_concurrent_file_change_without_overwriting_it() {
        let (_root, repo, _remote, state) = fixture().await;
        let expected = hash_bytes(&std::fs::read(repo.join("target.txt")).unwrap());
        std::fs::write(repo.join("target.txt"), "concurrent user edit\n")
            .expect("write concurrent edit");

        let error = state
            .workspace_file_write(WorkspaceFileWriteRequest {
                workspace: "direct".into(),
                path: "target.txt".into(),
                expected_sha256: Some(expected),
                content: "should not win\n".into(),
                request_id: Some("direct:concurrent".into()),
            })
            .await
            .expect_err("stale hash must fail");
        assert!(matches!(error, AppError::FileChanged { .. }));
        assert_eq!(
            std::fs::read_to_string(repo.join("target.txt")).unwrap(),
            "concurrent user edit\n"
        );
    }

    #[tokio::test]
    async fn binary_put_rejects_stale_hash_without_overwriting() {
        let (_root, repo, _remote, state) = fixture().await;
        let expected = hash_bytes(&std::fs::read(repo.join("target.txt")).unwrap());
        std::fs::write(repo.join("target.txt"), "concurrent\n").expect("write concurrent");
        let error = state
            .workspace_file_put(WorkspaceFilePutRequest {
                workspace: "direct".into(),
                path: "target.txt".into(),
                expected_sha256: Some(expected),
                content: BASE64_STANDARD.encode(b"replacement"),
                encoding: WorkspaceFilePutEncoding::Base64,
                request_id: Some("direct:stale-put".into()),
            })
            .await
            .expect_err("stale put must fail");
        assert!(matches!(error, AppError::FileChanged { .. }));
        assert_eq!(
            std::fs::read(repo.join("target.txt")).unwrap(),
            b"concurrent\n"
        );
    }

    #[tokio::test]
    async fn direct_create_rejects_workspace_escape() {
        let (root, _repo, _remote, state) = fixture().await;
        let error = state
            .workspace_file_write(WorkspaceFileWriteRequest {
                workspace: "direct".into(),
                path: "../outside.txt".into(),
                expected_sha256: None,
                content: "escape\n".into(),
                request_id: Some("direct:escape".into()),
            })
            .await
            .expect_err("workspace escape must fail");
        assert!(matches!(error, AppError::PathOutsideWorkspace));
        assert!(!root.path().join("outside.txt").exists());
    }

    #[tokio::test]
    async fn fetch_rejects_workspace_escape() {
        let (_root, _repo, _remote, state) = fixture().await;
        let error = state
            .workspace_file_fetch(WorkspaceFileFetchRequest {
                workspace: "direct".into(),
                path: "../outside.bin".into(),
                encoding: WorkspaceFileFetchEncoding::Auto,
            })
            .await
            .expect_err("fetch escape must fail");
        assert!(matches!(error, AppError::PathOutsideWorkspace));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn direct_file_tools_reject_symlink_targets() {
        use std::os::unix::fs::symlink;

        let (root, repo, _remote, state) = fixture().await;
        let outside = root.path().join("outside.txt");
        std::fs::write(&outside, "outside\n").expect("write outside fixture");
        symlink(&outside, repo.join("link.txt")).expect("create symlink fixture");

        let fetch_error = state
            .workspace_file_fetch(WorkspaceFileFetchRequest {
                workspace: "direct".into(),
                path: "link.txt".into(),
                encoding: WorkspaceFileFetchEncoding::Auto,
            })
            .await
            .expect_err("symlink fetch must fail");
        assert!(matches!(fetch_error, AppError::PathOutsideWorkspace));

        let put_error = state
            .workspace_file_put(WorkspaceFilePutRequest {
                workspace: "direct".into(),
                path: "link.txt".into(),
                expected_sha256: None,
                content: "replacement".into(),
                encoding: WorkspaceFilePutEncoding::Utf8,
                request_id: Some("direct:symlink-put".into()),
            })
            .await
            .expect_err("symlink put must fail");
        assert!(matches!(put_error, AppError::PathOutsideWorkspace));
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "outside\n");
    }
}
