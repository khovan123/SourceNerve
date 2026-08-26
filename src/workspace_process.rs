use std::{
    collections::HashMap,
    env,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{Arc, LazyLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    sync::Mutex,
};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    ops,
    service::AppState,
    workspace::Workspace,
};

const MAX_PROCESS_OUTPUT_BYTES: usize = 1_000_000;
const MAX_PROCESS_ARGUMENT_BYTES: usize = 64_000;
const MAX_PROCESS_SESSIONS: usize = 8;
const MAX_PROCESS_LIFETIME_SECS: u64 = 6 * 60 * 60;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WorkspaceProcessStartRequest {
    pub workspace: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct WorkspaceProcessStartResponse {
    pub workspace: String,
    pub session_id: String,
    pub program: String,
    pub started_at: i64,
    pub max_lifetime_seconds: u64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WorkspaceProcessLogsRequest {
    pub workspace: String,
    pub session_id: String,
    #[serde(default = "default_tail_bytes")]
    pub tail_bytes: usize,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct WorkspaceProcessLogsResponse {
    pub workspace: String,
    pub session_id: String,
    pub program: String,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub started_at: i64,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WorkspaceProcessStopRequest {
    pub workspace: String,
    pub session_id: String,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct WorkspaceProcessStopResponse {
    pub workspace: String,
    pub session_id: String,
    pub stopped: bool,
    pub exit_code: Option<i32>,
}

struct ProcessSession {
    workspace: String,
    program: String,
    child: Child,
    stdout: Arc<Mutex<Vec<u8>>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    started_at: i64,
}

static PROCESS_SESSIONS: LazyLock<Mutex<HashMap<String, ProcessSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn default_tail_bytes() -> usize {
    64 * 1024
}

fn safe_relative_path(path: &str) -> bool {
    let value = Path::new(path);
    !value.is_absolute()
        && !value.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
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

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn append_bounded(target: &mut Vec<u8>, bytes: &[u8]) {
    target.extend_from_slice(bytes);
    if target.len() > MAX_PROCESS_OUTPUT_BYTES {
        let overflow = target.len() - MAX_PROCESS_OUTPUT_BYTES;
        target.drain(..overflow);
    }
}

fn spawn_capture<R>(mut reader: R, target: Arc<Mutex<Vec<u8>>>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut chunk = [0_u8; 8192];
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) => break,
                Ok(read) => {
                    let mut buffer = target.lock().await;
                    append_bounded(&mut buffer, &chunk[..read]);
                }
                Err(_) => break,
            }
        }
    });
}

fn render_tail(bytes: &[u8], requested: usize) -> (String, bool) {
    let requested = requested.clamp(1, MAX_PROCESS_OUTPUT_BYTES);
    let truncated = bytes.len() > requested;
    let start = bytes.len().saturating_sub(requested);
    (String::from_utf8_lossy(&bytes[start..]).into_owned(), truncated)
}

impl AppState {
    pub async fn workspace_process_start(
        &self,
        request: WorkspaceProcessStartRequest,
    ) -> AppResult<WorkspaceProcessStartResponse> {
        ops::validate_request_key(request.request_id.as_deref())?;
        let workspace = self.workspaces.get(&request.workspace)?;
        if !workspace.writable {
            return Err(AppError::ReadOnlyWorkspace);
        }
        if request.args.len() > 256
            || request.args.iter().map(String::len).sum::<usize>() > MAX_PROCESS_ARGUMENT_BYTES
        {
            return Err(AppError::InvalidRequest(
                "process arguments exceed the bounded execution limit".into(),
            ));
        }

        let cwd = resolve_command_cwd(&workspace, request.cwd.as_deref()).await?;
        let program = resolve_command_program(&workspace, &request.program).await?;

        let mut command = Command::new(&program);
        command
            .current_dir(cwd)
            .args(&request.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        inherit_safe_command_environment(&mut command);

        let mut child = command
            .spawn()
            .map_err(|error| AppError::Command(format!("failed to start workspace process: {error}")))?;
        let stdout = Arc::new(Mutex::new(Vec::new()));
        let stderr = Arc::new(Mutex::new(Vec::new()));
        if let Some(reader) = child.stdout.take() {
            spawn_capture(reader, stdout.clone());
        }
        if let Some(reader) = child.stderr.take() {
            spawn_capture(reader, stderr.clone());
        }

        let session_id = Uuid::new_v4().to_string();
        let started_at = unix_timestamp();
        {
            let mut sessions = PROCESS_SESSIONS.lock().await;
            if sessions.len() >= MAX_PROCESS_SESSIONS {
                let _ = child.start_kill();
                return Err(AppError::InvalidRequest(format!(
                    "workspace process session limit reached ({MAX_PROCESS_SESSIONS})"
                )));
            }
            sessions.insert(
                session_id.clone(),
                ProcessSession {
                    workspace: request.workspace.clone(),
                    program: request.program.clone(),
                    child,
                    stdout,
                    stderr,
                    started_at,
                },
            );
        }

        let expiry_session = session_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(MAX_PROCESS_LIFETIME_SECS)).await;
            let mut sessions = PROCESS_SESSIONS.lock().await;
            if let Some(mut session) = sessions.remove(&expiry_session) {
                let _ = session.child.start_kill();
            }
        });

        let response = WorkspaceProcessStartResponse {
            workspace: request.workspace.clone(),
            session_id,
            program: request.program.clone(),
            started_at,
            max_lifetime_seconds: MAX_PROCESS_LIFETIME_SECS,
        };
        if let Err(error) = ops::record_audit(
            self,
            &request.workspace,
            "workspace_process_start",
            request.request_id.as_deref(),
            serde_json::json!({
                "program": request.program,
                "args_count": request.args.len(),
                "cwd": request.cwd.as_deref().unwrap_or("."),
                "session_id": response.session_id,
                "max_lifetime_seconds": MAX_PROCESS_LIFETIME_SECS,
            }),
            "success",
            None,
        )
        .await
        {
            tracing::error!(workspace = %request.workspace, error = %error, "failed to audit workspace process start");
        }
        Ok(response)
    }

    pub async fn workspace_process_logs(
        &self,
        request: WorkspaceProcessLogsRequest,
    ) -> AppResult<WorkspaceProcessLogsResponse> {
        self.workspaces.get(&request.workspace)?;
        let (program, running, exit_code, started_at, stdout, stderr) = {
            let mut sessions = PROCESS_SESSIONS.lock().await;
            let session = sessions.get_mut(&request.session_id).ok_or_else(|| {
                AppError::InvalidRequest("workspace process session was not found".into())
            })?;
            if session.workspace != request.workspace {
                return Err(AppError::InvalidRequest(
                    "workspace process session belongs to a different workspace".into(),
                ));
            }
            let status = session
                .child
                .try_wait()
                .map_err(|error| AppError::Command(format!("failed to inspect workspace process: {error}")))?;
            (
                session.program.clone(),
                status.is_none(),
                status.and_then(|value| value.code()),
                session.started_at,
                session.stdout.clone(),
                session.stderr.clone(),
            )
        };

        let stdout_bytes = stdout.lock().await.clone();
        let stderr_bytes = stderr.lock().await.clone();
        let (stdout, stdout_truncated) = render_tail(&stdout_bytes, request.tail_bytes);
        let (stderr, stderr_truncated) = render_tail(&stderr_bytes, request.tail_bytes);
        Ok(WorkspaceProcessLogsResponse {
            workspace: request.workspace,
            session_id: request.session_id,
            program,
            running,
            exit_code,
            started_at,
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
        })
    }

    pub async fn workspace_process_stop(
        &self,
        request: WorkspaceProcessStopRequest,
    ) -> AppResult<WorkspaceProcessStopResponse> {
        ops::validate_request_key(request.request_id.as_deref())?;
        self.workspaces.get(&request.workspace)?;
        let mut session = {
            let mut sessions = PROCESS_SESSIONS.lock().await;
            let session = sessions.remove(&request.session_id).ok_or_else(|| {
                AppError::InvalidRequest("workspace process session was not found".into())
            })?;
            if session.workspace != request.workspace {
                sessions.insert(request.session_id.clone(), session);
                return Err(AppError::InvalidRequest(
                    "workspace process session belongs to a different workspace".into(),
                ));
            }
            session
        };

        let status = match session
            .child
            .try_wait()
            .map_err(|error| AppError::Command(format!("failed to inspect workspace process: {error}")))?
        {
            Some(status) => status,
            None => {
                session
                    .child
                    .kill()
                    .await
                    .map_err(|error| AppError::Command(format!("failed to stop workspace process: {error}")))?;
                session
                    .child
                    .wait()
                    .await
                    .map_err(|error| AppError::Command(format!("failed to reap workspace process: {error}")))?
            }
        };
        let response = WorkspaceProcessStopResponse {
            workspace: request.workspace.clone(),
            session_id: request.session_id.clone(),
            stopped: true,
            exit_code: status.code(),
        };
        if let Err(error) = ops::record_audit(
            self,
            &request.workspace,
            "workspace_process_stop",
            request.request_id.as_deref(),
            serde_json::json!({"session_id": request.session_id}),
            "success",
            None,
        )
        .await
        {
            tracing::error!(workspace = %request.workspace, error = %error, "failed to audit workspace process stop");
        }
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_PROCESS_OUTPUT_BYTES, append_bounded, render_tail, safe_relative_path};

    #[test]
    fn direct_process_paths_reject_workspace_escape() {
        assert!(safe_relative_path("."));
        assert!(safe_relative_path("scripts/dev.sh"));
        assert!(!safe_relative_path("../outside"));
        assert!(!safe_relative_path("/tmp/outside"));
    }

    #[test]
    fn process_output_keeps_a_bounded_tail() {
        let mut buffer = Vec::new();
        append_bounded(&mut buffer, &vec![b'a'; MAX_PROCESS_OUTPUT_BYTES + 32]);
        assert_eq!(buffer.len(), MAX_PROCESS_OUTPUT_BYTES);
        let (tail, truncated) = render_tail(&buffer, 64);
        assert_eq!(tail.len(), 64);
        assert!(truncated);
    }
}
