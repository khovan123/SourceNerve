use std::{
    collections::HashSet,
    env,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tokio::{process::Command, sync::Mutex};
use uuid::Uuid;

#[path = "sandbox.rs"]
mod sandbox;

use crate::{
    error::{AppError, AppResult},
    git, index, ops,
    workspace::{Workspace, WorkspaceRegistry, WorkspaceView},
};
use sandbox::{SandboxEnforcement, SandboxMode};

const MAX_READ_BYTES: u64 = 1_000_000;
const MAX_DIFF_BYTES: usize = 2_000_000;
const MAX_PATCH_BYTES: usize = 1_000_000;
const MAX_COMMAND_OUTPUT_BYTES: usize = 1_000_000;
const MAX_COMMAND_ARGUMENT_BYTES: usize = 64_000;
const MAX_COMMAND_TIMEOUT_MS: u64 = 600_000;

#[derive(Clone)]
pub struct AppState {
    pub workspaces: WorkspaceRegistry,
    pub db: SqlitePool,
    pub mutation_lock: Arc<Mutex<()>>,
    pub github_token: Option<Arc<String>>,
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

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WorkspaceExecRequest {
    pub workspace: String,
    /// Executable name resolved from the sanitized PATH, or a safe relative executable path inside the workspace.
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Optional safe relative working directory inside the workspace.
    pub cwd: Option<String>,
    #[serde(default = "default_command_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub request_id: Option<String>,
    /// Requested process sandbox. The secure default is workspace-write.
    #[serde(default)]
    pub sandbox: SandboxMode,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct WorkspaceExecResponse {
    pub workspace: String,
    pub program: String,
    pub sandbox: SandboxMode,
    pub sandbox_enforcement: SandboxEnforcement,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

fn default_search_limit() -> usize {
    50
}

fn default_command_timeout_ms() -> u64 {
    120_000
}

fn safe_relative_path(path: &str) -> bool {
    let p = Path::new(path);
    !p.is_absolute()
        && !p.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}

fn bounded_output(bytes: &[u8]) -> (String, bool) {
    if bytes.len() <= MAX_COMMAND_OUTPUT_BYTES {
        return (String::from_utf8_lossy(bytes).into_owned(), false);
    }
    let start = bytes.len() - MAX_COMMAND_OUTPUT_BYTES;
    (
        format!(
            "[output truncated; showing last {} bytes]\n{}",
            MAX_COMMAND_OUTPUT_BYTES,
            String::from_utf8_lossy(&bytes[start..])
        ),
        true,
    )
}

fn inherit_safe_command_environment(command: &mut Command) {
    command.env_clear();
    for key in [
        "PATH",
        "HOME",
        "USER",
        "USERNAME",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SystemRoot",
        "COMSPEC",
        "PATHEXT",
        "LOCALAPPDATA",
        "APPDATA",
        "XDG_CACHE_HOME",
    ] {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
    command.env("GIT_TERMINAL_PROMPT", "0");
}

async fn resolve_command_cwd(workspace: &Workspace, cwd: Option<&str>) -> AppResult<PathBuf> {
    let Some(cwd) = cwd else {
        return Ok(workspace.root.clone());
    };
    if cwd.is_empty() || cwd == "." {
        return Ok(workspace.root.clone());
    }
    if !safe_relative_path(cwd) {
        return Err(AppError::PathOutsideWorkspace);
    }
    let full = tokio::fs::canonicalize(workspace.root.join(cwd)).await?;
    if !full.starts_with(&workspace.root) || !full.is_dir() {
        return Err(AppError::PathOutsideWorkspace);
    }
    Ok(full)
}

async fn resolve_command_program(workspace: &Workspace, program: &str) -> AppResult<PathBuf> {
    if program.trim() != program || program.is_empty() || program.len() > 512 {
        return Err(AppError::InvalidRequest(
            "program must be between 1 and 512 bytes and must not be padded".into(),
        ));
    }
    let candidate = Path::new(program);
    if candidate.is_absolute()
        || candidate.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(AppError::PathOutsideWorkspace);
    }
    if program.contains('/') || program.contains('\\') {
        let full = tokio::fs::canonicalize(workspace.root.join(candidate)).await?;
        if !full.starts_with(&workspace.root) || !full.is_file() {
            return Err(AppError::PathOutsideWorkspace);
        }
        return Ok(full);
    }
    Ok(PathBuf::from(program))
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

    pub async fn workspace_exec(
        &self,
        req: WorkspaceExecRequest,
    ) -> AppResult<WorkspaceExecResponse> {
        ops::validate_request_key(req.request_id.as_deref())?;
        let workspace = self.workspaces.get(&req.workspace)?;
        if !workspace.writable {
            return Err(AppError::ReadOnlyWorkspace);
        }
        if req.args.len() > 256
            || req.args.iter().map(String::len).sum::<usize>() > MAX_COMMAND_ARGUMENT_BYTES
        {
            return Err(AppError::InvalidRequest(
                "command arguments exceed the bounded execution limit".into(),
            ));
        }
        let cwd = resolve_command_cwd(&workspace, req.cwd.as_deref()).await?;
        let program = resolve_command_program(&workspace, &req.program).await?;
        let timeout_ms = req.timeout_ms.clamp(100, MAX_COMMAND_TIMEOUT_MS);
        let sandbox_mode = req.sandbox;
        let prepared =
            sandbox::prepare_command(&workspace.root, &cwd, &program, &req.args, sandbox_mode)?;
        let enforcement = prepared.enforcement;
        let mut command = prepared.command;
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        inherit_safe_command_environment(&mut command);

        let result: AppResult<WorkspaceExecResponse> =
            match tokio::time::timeout(Duration::from_millis(timeout_ms), command.output()).await {
                Ok(Ok(output)) => {
                    let (stdout, stdout_truncated) = bounded_output(&output.stdout);
                    let (stderr, stderr_truncated) = bounded_output(&output.stderr);
                    Ok(WorkspaceExecResponse {
                        workspace: req.workspace.clone(),
                        program: req.program.clone(),
                        sandbox: sandbox_mode,
                        sandbox_enforcement: enforcement,
                        success: output.status.success(),
                        exit_code: output.status.code(),
                        timed_out: false,
                        stdout,
                        stderr,
                        truncated: stdout_truncated || stderr_truncated,
                    })
                }
                Ok(Err(error)) => Err(AppError::Sandbox(format!(
                    "failed to launch sandboxed workspace command: {error}"
                ))),
                Err(_) => Ok(WorkspaceExecResponse {
                    workspace: req.workspace.clone(),
                    program: req.program.clone(),
                    sandbox: sandbox_mode,
                    sandbox_enforcement: enforcement,
                    success: false,
                    exit_code: None,
                    timed_out: true,
                    stdout: String::new(),
                    stderr: format!("command exceeded the bounded timeout of {timeout_ms} ms"),
                    truncated: false,
                }),
            };

        if let Err(error) = ops::record_audit(
            self,
            &req.workspace,
            "workspace_exec",
            req.request_id.as_deref(),
            serde_json::json!({
                "program": req.program,
                "args_count": req.args.len(),
                "cwd": req.cwd.as_deref().unwrap_or("."),
                "timeout_ms": timeout_ms,
                "sandbox": sandbox_mode.as_str(),
                "sandbox_enforcement": enforcement.as_str(),
            }),
            ops::audit_outcome(&result),
            None,
        )
        .await
        {
            tracing::error!(workspace = %req.workspace, error = %error, "failed to audit workspace command");
        }
        result
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

    async fn record_patch_applied(
        &self,
        workspace: &Workspace,
        head: String,
        paths: Vec<String>,
        patch_hash: String,
    ) -> AppResult<PatchApplied> {
        let diff = git::diff(&workspace.root).await?;
        let changeset_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO changesets(id, workspace_id, base_head, patch_sha256, paths_json, created_at) VALUES(?1, ?2, ?3, ?4, ?5, unixepoch())",
        )
        .bind(&changeset_id)
        .bind(&workspace.id)
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

    pub async fn preview_patch(&self, req: PatchRequest) -> AppResult<PatchPreview> {
        let (_w, head, paths, hash) = self.validate_patch(&req).await?;
        Ok(PatchPreview {
            valid: true,
            head,
            changed_paths: paths,
            patch_sha256: hash,
        })
    }

    /// Interactive local edit path. This deliberately does not acquire the distributed
    /// coordination lease and does not require graph/index refresh. Per-file hashes and
    /// the current Git HEAD still protect against overwriting a concurrently changed file.
    pub async fn apply_patch(&self, req: PatchRequest) -> AppResult<PatchApplied> {
        let _guard = self.mutation_lock.lock().await;
        let audit_workspace = req.workspace.clone();
        let result: AppResult<PatchApplied> = async {
            let (workspace, head, paths, patch_hash) = self.validate_patch(&req).await?;
            git::apply_patch(&workspace.root, &req.patch).await?;
            self.record_patch_applied(&workspace, head, paths, patch_hash)
                .await
        }
        .await;
        let result_sha = result.as_ref().ok().map(|value| value.head.as_str());
        if let Err(error) = ops::record_audit(
            self,
            &audit_workspace,
            "patch_apply",
            None,
            serde_json::json!({
                "paths": result.as_ref().ok().map(|value| value.changed_paths.clone()).unwrap_or_default(),
                "mode": "interactive-local",
            }),
            ops::audit_outcome(&result),
            result_sha,
        )
        .await
        {
            tracing::error!(workspace = %audit_workspace, error = %error, "failed to audit direct patch application");
        }
        result
    }

    /// Durable task path. Task transactions keep the previous incremental index refresh
    /// semantics and call this only while their stronger task/coordination guards hold.
    pub(crate) async fn apply_patch_locked(&self, req: PatchRequest) -> AppResult<PatchApplied> {
        let (w, head, paths, patch_hash) = self.validate_patch(&req).await?;
        git::apply_patch(&w.root, &req.patch).await?;
        index::sync_paths(&self.db, &w, &paths).await?;
        self.record_patch_applied(&w, head, paths, patch_hash).await
    }
}
