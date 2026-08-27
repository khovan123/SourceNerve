use std::{process::Command, sync::Arc};

use tempfile::TempDir;
use tokio::sync::Mutex;

use crate::{
    config::WorkspaceConfig,
    db,
    error::AppError,
    service::{AppState, WorkspaceExecRequest},
    workspace::WorkspaceRegistry,
};

async fn fixture() -> (TempDir, AppState) {
    let root = tempfile::tempdir().expect("fixture root");
    let workspace_root = root.path().join("workspace");
    let state_dir = root.path().join("state");
    std::fs::create_dir_all(&workspace_root).expect("create workspace");
    let git = Command::new("git")
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
        id: "exec".into(),
        name: "Workspace Exec Fixture".into(),
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

#[tokio::test]
async fn workspace_exec_rejects_unbounded_arguments_before_process_launch() {
    let (_root, state) = fixture().await;
    let error = state
        .workspace_exec(WorkspaceExecRequest {
            workspace: "exec".into(),
            program: "echo".into(),
            args: vec!["x".into(); 257],
            cwd: None,
            timeout_ms: 120_000,
            request_id: Some("exec:args-bound".into()),
            sandbox: Default::default(),
        })
        .await
        .expect_err("argument count above the bound must fail");
    assert!(matches!(error, AppError::InvalidRequest(_)));
}

#[tokio::test]
async fn workspace_exec_rejects_program_path_escape() {
    let (_root, state) = fixture().await;
    let error = state
        .workspace_exec(WorkspaceExecRequest {
            workspace: "exec".into(),
            program: "../outside".into(),
            args: Vec::new(),
            cwd: None,
            timeout_ms: 120_000,
            request_id: Some("exec:path-escape".into()),
            sandbox: Default::default(),
        })
        .await
        .expect_err("program path escape must fail");
    assert!(matches!(error, AppError::PathOutsideWorkspace));
}

#[tokio::test]
async fn workspace_exec_rejects_danger_full_access_without_harness_escalation() {
    let (_root, state) = fixture().await;
    let request: WorkspaceExecRequest = serde_json::from_value(serde_json::json!({
        "workspace": "exec",
        "program": "echo",
        "args": ["ok"],
        "timeout_ms": 120000,
        "request_id": "exec:danger-denied",
        "sandbox": "danger-full-access"
    }))
    .expect("deserialize danger sandbox request");
    let error = state
        .workspace_exec(request)
        .await
        .expect_err("danger-full-access must not be granted directly");
    assert!(matches!(error, AppError::InvalidRequest(_)));
}

#[tokio::test]
async fn workspace_exec_allows_danger_full_access_only_through_internal_approved_path() {
    let (_root, state) = fixture().await;
    let request: WorkspaceExecRequest = serde_json::from_value(serde_json::json!({
        "workspace": "exec",
        "program": "git",
        "args": ["--version"],
        "timeout_ms": 120000,
        "request_id": "exec:danger-approved",
        "sandbox": "danger-full-access"
    }))
    .expect("deserialize approved danger sandbox request");
    let response = state
        .workspace_exec_with_full_access_approval(request)
        .await
        .expect("approved danger-full-access execution");
    assert!(response.success);
    assert!(response.stdout.to_ascii_lowercase().contains("git version"));
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn macos_seatbelt_enforces_read_only_and_workspace_write_boundaries() {
    let (root, state) = fixture().await;
    let workspace_root = root.path().join("workspace");

    let read_only: WorkspaceExecRequest = serde_json::from_value(serde_json::json!({
        "workspace": "exec",
        "program": "sh",
        "args": ["-c", "printf denied > read-only.txt"],
        "timeout_ms": 120000,
        "request_id": "exec:macos-seatbelt-read-only",
        "sandbox": "read-only"
    }))
    .expect("deserialize read-only Seatbelt request");
    let read_only_response = state
        .workspace_exec(read_only)
        .await
        .expect("run read-only Seatbelt request");
    assert!(!read_only_response.success);
    assert!(!workspace_root.join("read-only.txt").exists());

    let workspace_write: WorkspaceExecRequest = serde_json::from_value(serde_json::json!({
        "workspace": "exec",
        "program": "sh",
        "args": ["-c", "printf allowed > workspace-write.txt"],
        "timeout_ms": 120000,
        "request_id": "exec:macos-seatbelt-workspace-write",
        "sandbox": "workspace-write"
    }))
    .expect("deserialize workspace-write Seatbelt request");
    let workspace_write_response = state
        .workspace_exec(workspace_write)
        .await
        .expect("run workspace-write Seatbelt request");
    assert!(
        workspace_write_response.success,
        "workspace write failed: {}",
        workspace_write_response.stderr
    );
    assert_eq!(
        std::fs::read_to_string(workspace_root.join("workspace-write.txt"))
            .expect("read workspace write result"),
        "allowed"
    );

    let outside_path = root.path().join("outside.txt");
    let outside_write: WorkspaceExecRequest = serde_json::from_value(serde_json::json!({
        "workspace": "exec",
        "program": "sh",
        "args": [
            "-c",
            "printf blocked > \"$1\"",
            "sourcenerve-seatbelt-test",
            outside_path.to_string_lossy()
        ],
        "timeout_ms": 120000,
        "request_id": "exec:macos-seatbelt-outside-write",
        "sandbox": "workspace-write"
    }))
    .expect("deserialize out-of-workspace Seatbelt request");
    let outside_response = state
        .workspace_exec(outside_write)
        .await
        .expect("run out-of-workspace Seatbelt request");
    assert!(!outside_response.success);
    assert!(!outside_path.exists());
}
