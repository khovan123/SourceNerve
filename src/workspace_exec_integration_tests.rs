use std::sync::Arc;

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
        })
        .await
        .expect_err("program path escape must fail");
    assert!(matches!(error, AppError::PathOutsideWorkspace));
}
