use std::{
    collections::HashMap,
    env,
    path::{Component, Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::{Arc, LazyLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "linux")]
use std::collections::HashSet;

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
    service::{
        AppState,
        sandbox::{self, SandboxEnforcement, SandboxMode},
    },
    workspace::Workspace,
};

const MAX_PROCESS_OUTPUT_BYTES: usize = 1_000_000;
const MAX_PROCESS_ARGUMENT_BYTES: usize = 64_000;
const MAX_PROCESS_SESSIONS: usize = 8;
const MAX_PROCESS_LIFETIME_SECS: u64 = 6 * 60 * 60;
#[cfg(unix)]
const SIGKILL: i32 = 9;
#[cfg(target_os = "linux")]
const ESRCH: i32 = 3;

#[cfg(unix)]
unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WorkspaceProcessStartRequest {
    pub workspace: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    /// Requested process sandbox. The secure direct-call default is workspace-write.
    #[serde(default)]
    pub sandbox: SandboxMode,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct WorkspaceProcessStartResponse {
    pub workspace: String,
    pub session_id: String,
    pub program: String,
    pub sandbox: SandboxMode,
    pub sandbox_enforcement: SandboxEnforcement,
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
    pub sandbox: SandboxMode,
    pub sandbox_enforcement: SandboxEnforcement,
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

#[derive(Default)]
struct CapturedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

struct ProcessSession {
    workspace: String,
    program: String,
    sandbox: SandboxMode,
    sandbox_enforcement: SandboxEnforcement,
    child: Child,
    stdout: Arc<Mutex<CapturedOutput>>,
    stderr: Arc<Mutex<CapturedOutput>>,
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

#[cfg(target_os = "macos")]
fn configure_process_tree(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.as_std_mut().process_group(0);
}

#[cfg(not(target_os = "macos"))]
fn configure_process_tree(_: &mut Command) {}

#[cfg(target_os = "linux")]
fn linux_direct_children(process_id: i32) -> Vec<i32> {
    let task_root = PathBuf::from(format!("/proc/{process_id}/task"));
    let Ok(entries) = std::fs::read_dir(task_root) else {
        return Vec::new();
    };
    let mut children = Vec::new();
    for entry in entries.flatten() {
        let Ok(raw) = std::fs::read_to_string(entry.path().join("children")) else {
            continue;
        };
        children.extend(
            raw.split_whitespace()
                .filter_map(|value| value.parse::<i32>().ok())
                .filter(|value| *value > 0),
        );
    }
    children.sort_unstable();
    children.dedup();
    children
}

#[cfg(target_os = "linux")]
fn linux_descendants(process_id: i32) -> Vec<i32> {
    let mut seen = HashSet::from([process_id]);
    let mut pending = vec![process_id];
    let mut descendants = Vec::new();
    while let Some(parent) = pending.pop() {
        for child in linux_direct_children(parent) {
            if seen.insert(child) {
                descendants.push(child);
                pending.push(child);
            }
        }
    }
    descendants
}

#[cfg(target_os = "linux")]
fn terminate_linux_descendants(process_id: i32) {
    // bubblewrap may keep a monitor PID outside the session it creates for the sandboxed command.
    // Snapshot descendants before killing that monitor so background children cannot be orphaned.
    for descendant in linux_descendants(process_id).into_iter().rev() {
        if unsafe { kill(descendant, SIGKILL) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(ESRCH) {
                tracing::warn!(pid = descendant, error = %error, "failed to stop workspace process descendant");
            }
        }
    }
}

async fn terminate_session(session: &mut ProcessSession) -> AppResult<ExitStatus> {
    if let Some(status) = session.child.try_wait().map_err(|error| {
        AppError::Command(format!("failed to inspect workspace process: {error}"))
    })? {
        return Ok(status);
    }

    #[cfg(unix)]
    {
        if let Some(process_id) = session.child.id() {
            let process_group = i32::try_from(process_id).map_err(|_| {
                AppError::Command(
                    "workspace process id exceeds the Unix process-group range".into(),
                )
            })?;
            #[cfg(target_os = "linux")]
            terminate_linux_descendants(process_group);
            let killed = unsafe { kill(-process_group, SIGKILL) };
            if killed != 0 {
                let error = std::io::Error::last_os_error();
                if let Some(status) = session.child.try_wait().map_err(|inspect_error| {
                    AppError::Command(format!(
                        "failed to inspect workspace process after process-group termination error: {inspect_error}"
                    ))
                })? {
                    return Ok(status);
                }
                #[cfg(target_os = "linux")]
                if error.raw_os_error() == Some(ESRCH) {
                    session.child.start_kill().map_err(|kill_error| {
                        AppError::Command(format!(
                            "failed to stop workspace process during bubblewrap session startup: {kill_error}"
                        ))
                    })?;
                } else {
                    return Err(AppError::Command(format!(
                        "failed to stop workspace process group {process_group}: {error}"
                    )));
                }
                #[cfg(not(target_os = "linux"))]
                return Err(AppError::Command(format!(
                    "failed to stop workspace process group {process_group}: {error}"
                )));
            }
        } else {
            session.child.start_kill().map_err(|error| {
                AppError::Command(format!("failed to stop workspace process: {error}"))
            })?;
        }
    }

    #[cfg(not(unix))]
    session
        .child
        .start_kill()
        .map_err(|error| AppError::Command(format!("failed to stop workspace process: {error}")))?;

    session
        .child
        .wait()
        .await
        .map_err(|error| AppError::Command(format!("failed to reap workspace process: {error}")))
}

async fn expire_session(session_id: &str) -> AppResult<bool> {
    let session = {
        let mut sessions = PROCESS_SESSIONS.lock().await;
        sessions.remove(session_id)
    };
    let Some(mut session) = session else {
        return Ok(false);
    };
    terminate_session(&mut session).await?;
    Ok(true)
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

fn append_bounded(target: &mut CapturedOutput, bytes: &[u8]) {
    target.bytes.extend_from_slice(bytes);
    if target.bytes.len() > MAX_PROCESS_OUTPUT_BYTES {
        let overflow = target.bytes.len() - MAX_PROCESS_OUTPUT_BYTES;
        target.bytes.drain(..overflow);
        target.truncated = true;
    }
}

fn spawn_capture<R>(mut reader: R, target: Arc<Mutex<CapturedOutput>>)
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

fn render_tail(output: &CapturedOutput, requested: usize) -> (String, bool) {
    let requested = requested.clamp(1, MAX_PROCESS_OUTPUT_BYTES);
    let tail_truncated = output.bytes.len() > requested;
    let start = output.bytes.len().saturating_sub(requested);
    (
        String::from_utf8_lossy(&output.bytes[start..]).into_owned(),
        output.truncated || tail_truncated,
    )
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
        let sandbox_mode = request.sandbox;
        let prepared =
            sandbox::prepare_command(&workspace.root, &cwd, &program, &request.args, sandbox_mode)?;
        let enforcement = prepared.enforcement;
        let mut command = prepared.command;
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        configure_process_tree(&mut command);
        inherit_safe_command_environment(&mut command);

        let mut child = command.spawn().map_err(|error| {
            AppError::Sandbox(format!(
                "failed to start sandboxed workspace process: {error}"
            ))
        })?;
        let stdout = Arc::new(Mutex::new(CapturedOutput::default()));
        let stderr = Arc::new(Mutex::new(CapturedOutput::default()));
        if let Some(reader) = child.stdout.take() {
            spawn_capture(reader, stdout.clone());
        }
        if let Some(reader) = child.stderr.take() {
            spawn_capture(reader, stderr.clone());
        }

        let session_id = Uuid::new_v4().to_string();
        let started_at = unix_timestamp();
        let mut pending_session = Some(ProcessSession {
            workspace: request.workspace.clone(),
            program: request.program.clone(),
            sandbox: sandbox_mode,
            sandbox_enforcement: enforcement,
            child,
            stdout,
            stderr,
            started_at,
        });
        let inserted = {
            let mut sessions = PROCESS_SESSIONS.lock().await;
            if sessions.len() >= MAX_PROCESS_SESSIONS {
                false
            } else {
                sessions.insert(
                    session_id.clone(),
                    pending_session
                        .take()
                        .expect("pending process session must exist before insertion"),
                );
                true
            }
        };
        if !inserted {
            let mut session = pending_session
                .take()
                .expect("rejected process session must remain available for cleanup");
            let _ = terminate_session(&mut session).await;
            return Err(AppError::InvalidRequest(format!(
                "workspace process session limit reached ({MAX_PROCESS_SESSIONS})"
            )));
        }

        let expiry_session = session_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(MAX_PROCESS_LIFETIME_SECS)).await;
            if let Err(error) = expire_session(&expiry_session).await {
                tracing::warn!(session_id = %expiry_session, error = %error, "failed to expire workspace process session");
            }
        });

        let response = WorkspaceProcessStartResponse {
            workspace: request.workspace.clone(),
            session_id,
            program: request.program.clone(),
            sandbox: sandbox_mode,
            sandbox_enforcement: enforcement,
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
                "sandbox": sandbox_mode.as_str(),
                "sandbox_enforcement": enforcement.as_str(),
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
        let (program, sandbox, sandbox_enforcement, running, exit_code, started_at, stdout, stderr) = {
            let mut sessions = PROCESS_SESSIONS.lock().await;
            let session = sessions.get_mut(&request.session_id).ok_or_else(|| {
                AppError::InvalidRequest("workspace process session was not found".into())
            })?;
            if session.workspace != request.workspace {
                return Err(AppError::InvalidRequest(
                    "workspace process session belongs to a different workspace".into(),
                ));
            }
            let status = session.child.try_wait().map_err(|error| {
                AppError::Command(format!("failed to inspect workspace process: {error}"))
            })?;
            (
                session.program.clone(),
                session.sandbox,
                session.sandbox_enforcement,
                status.is_none(),
                status.and_then(|value| value.code()),
                session.started_at,
                session.stdout.clone(),
                session.stderr.clone(),
            )
        };

        let stdout_output = stdout.lock().await;
        let stderr_output = stderr.lock().await;
        let (stdout, stdout_truncated) = render_tail(&stdout_output, request.tail_bytes);
        let (stderr, stderr_truncated) = render_tail(&stderr_output, request.tail_bytes);
        Ok(WorkspaceProcessLogsResponse {
            workspace: request.workspace,
            session_id: request.session_id,
            program,
            sandbox,
            sandbox_enforcement,
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
        let workspace = self.workspaces.get(&request.workspace)?;
        if !workspace.writable {
            return Err(AppError::ReadOnlyWorkspace);
        }
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

        let status = terminate_session(&mut session).await?;
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
    use super::{
        CapturedOutput, MAX_PROCESS_OUTPUT_BYTES, WorkspaceProcessLogsRequest,
        WorkspaceProcessStartRequest, WorkspaceProcessStopRequest, append_bounded, expire_session,
        render_tail, safe_relative_path,
    };
    use std::time::Duration;

    use crate::service::sandbox::SandboxMode;

    #[test]
    fn direct_process_paths_reject_workspace_escape() {
        assert!(safe_relative_path("."));
        assert!(safe_relative_path("scripts/dev.sh"));
        assert!(!safe_relative_path("../outside"));
        assert!(!safe_relative_path("/tmp/outside"));
    }

    #[test]
    fn process_start_defaults_to_workspace_write_sandbox() {
        let request: WorkspaceProcessStartRequest = serde_json::from_value(serde_json::json!({
            "workspace": "fixture",
            "program": "cargo"
        }))
        .expect("deserialize process start request");
        assert_eq!(request.sandbox, SandboxMode::WorkspaceWrite);
    }

    #[test]
    fn process_output_keeps_a_bounded_tail_and_remembers_dropped_bytes() {
        let mut output = CapturedOutput::default();
        append_bounded(&mut output, &vec![b'a'; MAX_PROCESS_OUTPUT_BYTES + 32]);
        assert_eq!(output.bytes.len(), MAX_PROCESS_OUTPUT_BYTES);
        assert!(output.truncated);

        let (tail, truncated) = render_tail(&output, MAX_PROCESS_OUTPUT_BYTES);
        assert_eq!(tail.len(), MAX_PROCESS_OUTPUT_BYTES);
        assert!(truncated);
    }

    #[cfg(unix)]
    async fn process_fixture() -> (tempfile::TempDir, crate::service::AppState) {
        use std::{process::Command as StdCommand, sync::Arc};

        use crate::{config::WorkspaceConfig, db, service::AppState, workspace::WorkspaceRegistry};
        use tokio::sync::Mutex;

        let root = tempfile::tempdir().expect("fixture root");
        let workspace_root = root.path().join("workspace");
        let state_dir = root.path().join("state");
        std::fs::create_dir_all(&workspace_root).expect("create workspace");
        let git = StdCommand::new("git")
            .current_dir(&workspace_root)
            .args(["init", "-b", "main"])
            .output()
            .expect("initialize workspace git repository");
        assert!(
            git.status.success(),
            "git init failed: {}",
            String::from_utf8_lossy(&git.stderr)
        );
        let registry = WorkspaceRegistry::build(&[WorkspaceConfig {
            id: "process".into(),
            name: "Workspace Process Fixture".into(),
            root: workspace_root,
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
        (root, state)
    }

    #[cfg(unix)]
    async fn wait_for_log(state: &crate::service::AppState, session_id: &str, marker: &str) {
        for _ in 0..80 {
            let logs = state
                .workspace_process_logs(WorkspaceProcessLogsRequest {
                    workspace: "process".into(),
                    session_id: session_id.to_string(),
                    tail_bytes: 64 * 1024,
                })
                .await
                .expect("read workspace process logs");
            if logs.stdout.contains(marker) {
                return;
            }
            if !logs.running {
                panic!(
                    "workspace process exited before marker `{marker}`: exit_code={:?} stdout={:?} stderr={:?}",
                    logs.exit_code, logs.stdout, logs.stderr
                );
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("workspace process did not emit marker `{marker}` within the bounded wait");
    }

    #[cfg(unix)]
    fn process_request(
        sandbox: SandboxMode,
        args: Vec<String>,
        request_id: &str,
    ) -> WorkspaceProcessStartRequest {
        WorkspaceProcessStartRequest {
            workspace: "process".into(),
            program: "sh".into(),
            args,
            cwd: None,
            request_id: Some(request_id.into()),
            sandbox,
        }
    }

    #[cfg(unix)]
    async fn stop_process(state: &crate::service::AppState, session_id: String, request_id: &str) {
        state
            .workspace_process_stop(WorkspaceProcessStopRequest {
                workspace: "process".into(),
                session_id,
                request_id: Some(request_id.into()),
            })
            .await
            .expect("stop workspace process");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_descendant_cleanup_kills_background_child_before_it_can_escape() {
        use std::process::Command as StdCommand;

        let fixture = tempfile::tempdir().expect("process-tree fixture");
        let marker = fixture.path().join("descendant-survived.txt");
        let mut root = StdCommand::new("sh")
            .arg("-c")
            .arg("(sleep 1; printf survived > \"$1\") & wait")
            .arg("sourcenerve-process-tree-test")
            .arg(&marker)
            .spawn()
            .expect("spawn process tree fixture");
        let root_pid = i32::try_from(root.id()).expect("fixture pid fits Linux pid range");
        let mut descendants = Vec::new();
        for _ in 0..40 {
            descendants = super::linux_descendants(root_pid);
            if !descendants.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        super::terminate_linux_descendants(root_pid);
        let _ = root.kill();
        let _ = root.wait();
        std::thread::sleep(Duration::from_millis(1_200));
        assert!(
            !descendants.is_empty(),
            "Linux /proc traversal must discover a background descendant before cleanup"
        );
        assert!(
            !marker.exists(),
            "Linux descendant cleanup must prevent a background child from surviving"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_workspace_process_enforces_confinement_and_tree_cleanup() {
        #[cfg(target_os = "linux")]
        if std::process::Command::new("bwrap")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!(
                "skipping long-running Linux confinement test because bubblewrap is unavailable"
            );
            return;
        }

        let (root, state) = process_fixture().await;
        let workspace = root.path().join("workspace");

        let read_only = state
            .workspace_process_start(process_request(
                SandboxMode::ReadOnly,
                vec![
                    "-c".into(),
                    "printf denied > read-only.txt; printf attempted; sleep 30".into(),
                ],
                "process:read-only",
            ))
            .await
            .expect("start read-only workspace process");
        wait_for_log(&state, &read_only.session_id, "attempted").await;
        assert!(!workspace.join("read-only.txt").exists());
        stop_process(&state, read_only.session_id, "process:stop-read-only").await;

        let workspace_write = state
            .workspace_process_start(process_request(
                SandboxMode::WorkspaceWrite,
                vec![
                    "-c".into(),
                    "printf allowed > workspace-write.txt; printf attempted; sleep 30".into(),
                ],
                "process:workspace-write",
            ))
            .await
            .expect("start workspace-write process");
        wait_for_log(&state, &workspace_write.session_id, "attempted").await;
        assert_eq!(
            std::fs::read_to_string(workspace.join("workspace-write.txt"))
                .expect("read workspace-write result"),
            "allowed"
        );
        stop_process(
            &state,
            workspace_write.session_id,
            "process:stop-workspace-write",
        )
        .await;

        let outside = root.path().join("outside.txt");
        let outside_write = state
            .workspace_process_start(process_request(
                SandboxMode::WorkspaceWrite,
                vec![
                    "-c".into(),
                    "printf blocked > \"$1\"; printf attempted; sleep 30".into(),
                    "sourcenerve-process-test".into(),
                    outside.to_string_lossy().into_owned(),
                ],
                "process:outside-write",
            ))
            .await
            .expect("start out-of-workspace process");
        wait_for_log(&state, &outside_write.session_id, "attempted").await;
        assert!(!outside.exists());
        stop_process(
            &state,
            outside_write.session_id,
            "process:stop-outside-write",
        )
        .await;

        let stop_marker = workspace.join("stop-descendant-survived.txt");
        let stop_tree = state
            .workspace_process_start(process_request(
                SandboxMode::WorkspaceWrite,
                vec![
                    "-c".into(),
                    "(sleep 1; printf survived > stop-descendant-survived.txt) & printf spawned; sleep 30"
                        .into(),
                ],
                "process:stop-tree",
            ))
            .await
            .expect("start process tree for explicit stop");
        wait_for_log(&state, &stop_tree.session_id, "spawned").await;
        stop_process(&state, stop_tree.session_id, "process:stop-tree-now").await;
        tokio::time::sleep(Duration::from_millis(1_200)).await;
        assert!(
            !stop_marker.exists(),
            "explicit stop left a background descendant running"
        );

        let expiry_marker = workspace.join("expiry-descendant-survived.txt");
        let expiry_tree = state
            .workspace_process_start(process_request(
                SandboxMode::WorkspaceWrite,
                vec![
                    "-c".into(),
                    "(sleep 1; printf survived > expiry-descendant-survived.txt) & printf spawned; sleep 30"
                        .into(),
                ],
                "process:expiry-tree",
            ))
            .await
            .expect("start process tree for expiry cleanup");
        wait_for_log(&state, &expiry_tree.session_id, "spawned").await;
        assert!(
            expire_session(&expiry_tree.session_id)
                .await
                .expect("expire workspace process session"),
            "expiry cleanup should remove an active session"
        );
        tokio::time::sleep(Duration::from_millis(1_200)).await;
        assert!(
            !expiry_marker.exists(),
            "expiry cleanup left a background descendant running"
        );
    }
}
