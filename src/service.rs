use std::{collections::HashSet, path::Component, process::Stdio, sync::Arc};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tokio::{process::Command, sync::Mutex};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    git, index,
    workspace::{Workspace, WorkspaceRegistry, WorkspaceView},
};

const MAX_READ_BYTES: u64 = 1_000_000;
const MAX_DIFF_BYTES: usize = 2_000_000;
const MAX_PATCH_BYTES: usize = 1_000_000;

#[derive(Clone)]
pub struct AppState {
    pub workspaces: WorkspaceRegistry,
    pub db: SqlitePool,
    pub mutation_lock: Arc<Mutex<()>>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct RepoSnapshot {
    pub workspace: String,
    pub head: String,
    pub dirty: bool,
    pub status: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WorkspaceArg {
    pub workspace: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SearchRequest {
    pub workspace: String,
    pub query: String,
    #[serde(default = "default_search_limit")]
    pub limit: usize,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct SearchHit {
    pub path: String,
    pub line: u64,
    pub text: String,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadFileRequest {
    pub workspace: String,
    pub path: String,
    pub start_line: Option<usize>,
    pub end_line: Option<usize>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ReadFileResponse {
    pub path: String,
    pub sha256: String,
    pub start_line: usize,
    pub end_line: usize,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct FileExpectation {
    pub path: String,
    /// SHA-256 returned by read_file. Use null only when the file is expected not to exist yet.
    pub sha256: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PatchRequest {
    pub workspace: String,
    pub expected_head: String,
    pub expected_files: Vec<FileExpectation>,
    pub patch: String,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct PatchPreview {
    pub valid: bool,
    pub head: String,
    pub changed_paths: Vec<String>,
    pub patch_sha256: String,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct PatchApplied {
    pub changeset_id: String,
    pub head: String,
    pub changed_paths: Vec<String>,
    pub diff: String,
}

fn default_search_limit() -> usize {
    50
}

fn safe_relative_path(path: &str) -> bool {
    let p = std::path::Path::new(path);
    !p.is_absolute()
        && !p.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}

impl AppState {
    pub async fn list_workspaces(&self) -> AppResult<Vec<WorkspaceView>> {
        Ok(self.workspaces.list())
    }

    pub async fn snapshot(&self, id: &str) -> AppResult<RepoSnapshot> {
        let w = self.workspaces.get(id)?;
        let head = git::head(&w.root).await?;
        let status = git::status(&w.root).await?;
        Ok(RepoSnapshot {
            workspace: id.into(),
            head,
            dirty: !status.is_empty(),
            status,
        })
    }

    pub async fn search(&self, req: SearchRequest) -> AppResult<SearchResponse> {
        if req.query.trim().is_empty() {
            return Err(AppError::InvalidRequest("query must not be empty".into()));
        }
        let w = self.workspaces.get(&req.workspace)?;
        let limit = req.limit.clamp(1, 200);
        let out = Command::new("rg")
            .current_dir(&w.root)
            .args([
                "-n",
                "--no-heading",
                "--color",
                "never",
                "--hidden",
                "--glob",
                "!.git/**",
                "--",
                &req.query,
                ".",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|e| AppError::Command(format!("failed to execute ripgrep: {e}")))?;
        if !out.status.success() && out.status.code() != Some(1) {
            return Err(AppError::Command(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut hits = Vec::new();
        let mut truncated = false;
        for line in text.lines() {
            if hits.len() >= limit {
                truncated = true;
                break;
            }
            let mut parts = line.splitn(3, ':');
            let path = parts
                .next()
                .unwrap_or("")
                .trim_start_matches("./")
                .to_string();
            let number = parts
                .next()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            let content = parts.next().unwrap_or("").to_string();
            if !path.is_empty() {
                hits.push(SearchHit {
                    path,
                    line: number,
                    text: content,
                });
            }
        }
        Ok(SearchResponse { hits, truncated })
    }

    pub async fn read_file(&self, req: ReadFileRequest) -> AppResult<ReadFileResponse> {
        let w = self.workspaces.get(&req.workspace)?;
        let full = self.workspaces.resolve_existing_file(&w, &req.path)?;
        let metadata = tokio::fs::metadata(&full).await?;
        if metadata.len() > MAX_READ_BYTES {
            return Err(AppError::InvalidRequest(
                "file exceeds 1 MB read limit".into(),
            ));
        }
        let bytes = tokio::fs::read(&full).await?;
        if bytes.contains(&0) {
            return Err(AppError::InvalidRequest(
                "binary file reads are not supported".into(),
            ));
        }
        let sha256 = hex::encode(Sha256::digest(&bytes));
        let text = String::from_utf8(bytes)
            .map_err(|_| AppError::InvalidRequest("file is not valid UTF-8".into()))?;
        let lines: Vec<&str> = text.lines().collect();
        let start = req.start_line.unwrap_or(1).max(1);
        let end = req.end_line.unwrap_or(lines.len()).min(lines.len());
        if end < start && !lines.is_empty() {
            return Err(AppError::InvalidRequest(
                "end_line must be >= start_line".into(),
            ));
        }
        let content = if lines.is_empty() {
            String::new()
        } else {
            lines[start.saturating_sub(1)..end].join("\n")
        };
        Ok(ReadFileResponse {
            path: req.path,
            sha256,
            start_line: start,
            end_line: end,
            content,
        })
    }

    pub async fn diff(&self, id: &str) -> AppResult<String> {
        let w = self.workspaces.get(id)?;
        let diff = git::diff(&w.root).await?;
        if diff.len() > MAX_DIFF_BYTES {
            return Err(AppError::InvalidRequest(
                "diff exceeds 2 MB response limit".into(),
            ));
        }
        Ok(diff)
    }

    async fn verify_file_expectations(
        &self,
        workspace: &Workspace,
        paths: &[String],
        expected: &[FileExpectation],
    ) -> AppResult<()> {
        if expected.len() != paths.len() {
            return Err(AppError::InvalidRequest(
                "expected_files must contain exactly one entry for every patched path".into(),
            ));
        }
        let unique: HashSet<&str> = expected.iter().map(|item| item.path.as_str()).collect();
        if unique.len() != expected.len() {
            return Err(AppError::InvalidRequest(
                "expected_files contains duplicate paths".into(),
            ));
        }

        for path in paths {
            let expectation = expected
                .iter()
                .find(|item| item.path == *path)
                .ok_or_else(|| {
                    AppError::InvalidRequest(format!(
                        "missing expected_files entry for patched path: {path}"
                    ))
                })?;
            if !safe_relative_path(path) {
                return Err(AppError::PathOutsideWorkspace);
            }

            let joined = workspace.root.join(path);
            if !joined.exists() {
                if expectation.sha256.is_some() {
                    return Err(AppError::FileChanged { path: path.clone() });
                }
                continue;
            }

            let full = tokio::fs::canonicalize(&joined).await?;
            if !full.starts_with(&workspace.root) || !full.is_file() {
                return Err(AppError::PathOutsideWorkspace);
            }
            let expected_hash = expectation
                .sha256
                .as_ref()
                .ok_or_else(|| AppError::FileChanged { path: path.clone() })?;
            let current_hash = hex::encode(Sha256::digest(tokio::fs::read(&full).await?));
            if &current_hash != expected_hash {
                return Err(AppError::FileChanged { path: path.clone() });
            }
        }
        Ok(())
    }

    async fn validate_patch(
        &self,
        req: &PatchRequest,
    ) -> AppResult<(Workspace, String, Vec<String>, String)> {
        if req.patch.is_empty() || req.patch.len() > MAX_PATCH_BYTES {
            return Err(AppError::InvalidRequest(
                "patch must be between 1 byte and 1 MB".into(),
            ));
        }
        let w = self.workspaces.get(&req.workspace)?;
        if !w.writable {
            return Err(AppError::ReadOnlyWorkspace);
        }
        let head = git::head(&w.root).await?;
        if head != req.expected_head {
            return Err(AppError::WorkspaceChanged {
                expected: req.expected_head.clone(),
                actual: head,
            });
        }
        let paths = git::patch_paths(&req.patch);
        if paths.is_empty() {
            return Err(AppError::InvalidRequest(
                "patch does not contain any writable target paths".into(),
            ));
        }
        for path in &paths {
            if !safe_relative_path(path) {
                return Err(AppError::PathOutsideWorkspace);
            }
        }
        self.verify_file_expectations(&w, &paths, &req.expected_files)
            .await?;
        git::check_patch(&w.root, &req.patch).await?;
        let patch_hash = hex::encode(Sha256::digest(req.patch.as_bytes()));
        Ok((w, head, paths, patch_hash))
    }

    pub async fn preview_patch(&self, req: PatchRequest) -> AppResult<PatchPreview> {
        let (_w, head, paths, hash) = self.validate_patch(&req).await?;
        Ok(PatchPreview {
            valid: true,
            head,
            changed_paths: paths,
            patch_sha256: hash,
        })
    }

    pub async fn apply_patch(&self, req: PatchRequest) -> AppResult<PatchApplied> {
        let _guard = self.mutation_lock.lock().await;
        let (w, head, paths, patch_hash) = self.validate_patch(&req).await?;
        git::apply_patch(&w.root, &req.patch).await?;
        index::sync_paths(&self.db, &w, &paths).await?;
        let diff = git::diff(&w.root).await?;
        let changeset_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO changesets(id, workspace_id, base_head, patch_sha256, paths_json, created_at) VALUES(?1, ?2, ?3, ?4, ?5, unixepoch())",
        )
        .bind(&changeset_id)
        .bind(&w.id)
        .bind(&head)
        .bind(&patch_hash)
        .bind(serde_json::to_string(&paths).map_err(anyhow::Error::from)?)
        .execute(&self.db)
        .await?;
        Ok(PatchApplied {
            changeset_id,
            head,
            changed_paths: paths,
            diff,
        })
    }
}
