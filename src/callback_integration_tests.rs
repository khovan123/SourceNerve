use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

use tempfile::TempDir;
use tokio::sync::Mutex;

use crate::{
    callback::{self, CallbackDeliveryRequest},
    config::WorkspaceConfig,
    db,
    job_ingress::{self, JobSubmitRequest},
    memory,
    service::AppState,
    task_transactions::{self, TaskBeginRequest},
    workspace::WorkspaceRegistry,
};

fn run_git(root: &Path, args: &[&str]) {
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
}

async fn build_state(repo: &Path, state_dir: &Path) -> AppState {
    let registry = WorkspaceRegistry::build(&[WorkspaceConfig {
        id: "callback".into(),
        name: "Callback Fixture".into(),
        root: repo.to_path_buf(),
        access: "read-write".into(),
        remote: "origin".into(),
        default_branch: "main".into(),
        github_repository: None,
    }])
    .expect("build callback workspace registry");
    let pool = db::connect(state_dir).await.expect("connect callback db");
    db::register_workspaces(&pool, &registry)
        .await
        .expect("register callback workspace");
    AppState {
        workspaces: registry,
        db: pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: None,
    }
}

async fn fixture() -> (TempDir, PathBuf, PathBuf, AppState) {
    let root = tempfile::tempdir().expect("callback fixture tempdir");
    let repo = root.path().join("repo");
    let state_dir = root.path().join("state");
    std::fs::create_dir_all(repo.join("src")).expect("create source directory");
    run_git(&repo, &["init", "-b", "main"]);
    run_git(&repo, &["config", "user.name", "SourceNerve Test"]);
    run_git(
        &repo,
        &["config", "user.email", "sourcenerve@example.invalid"],
    );
    std::fs::write(repo.join("src/lib.rs"), "pub fn baseline() -> u32 { 1 }\n")
        .expect("write baseline source");
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "callback fixture"]);

    let state = build_state(&repo, &state_dir).await;
    memory::index_workspace(&state, "callback")
        .await
        .expect("index callback workspace");
    (root, repo, state_dir, state)
}

#[tokio::test]
async fn enabled_outbox_is_atomic_sanitized_restart_safe_and_retryable() {
    let (_root, repo, state_dir, state) = fixture().await;
    callback::configure_runtime(&state, true)
        .await
        .expect("enable callback runtime");

    let submitted = job_ingress::submit(
        &state,
        JobSubmitRequest {
            client_request_id: "callback:job".into(),
            workspace: "callback".into(),
            context_query: Some("sensitive callback prompt".into()),
            context_max_bytes: Some(4096),
            context_max_items: Some(5),
        },
    )
    .await
    .expect("submit callback job");
    assert!(submitted.job.task_id.is_some());

    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT delivery_id, event_key, status FROM callback_outbox ORDER BY id")
            .fetch_all(&state.db)
            .await
            .expect("read callback outbox");
    assert!(
        rows.len() >= 3,
        "expected job + task callback events: {rows:?}"
    );
    assert!(rows.iter().all(|row| row.2 == "pending"));

    let stored: String = sqlx::query_scalar(
        "SELECT group_concat(delivery_id || ':' || event_key || ':' || source_kind || ':' || \
                workspace_id || ':' || COALESCE(task_id, '') || ':' || COALESCE(job_id, ''), '\n') \
         FROM callback_outbox",
    )
    .fetch_one(&state.db)
    .await
    .expect("serialize callback outbox");
    assert!(!stored.contains("sensitive callback prompt"));
    assert!(!stored.contains(repo.to_string_lossy().as_ref()));

    let delivery_id = rows[0].0.clone();
    sqlx::query("UPDATE callback_outbox SET status='delivering', attempts=1 WHERE delivery_id=?1")
        .bind(&delivery_id)
        .execute(&state.db)
        .await
        .expect("simulate interrupted callback delivery");

    let restarted = build_state(&repo, &state_dir).await;
    callback::configure_runtime(&restarted, true)
        .await
        .expect("recover callback runtime");
    let recovered = callback::get(
        &restarted,
        CallbackDeliveryRequest {
            delivery_id: delivery_id.clone(),
        },
    )
    .await
    .expect("get recovered callback");
    assert_eq!(recovered.status, "pending");

    sqlx::query(
        "UPDATE callback_outbox \
         SET status='failed', attempts=5, last_http_status=503, last_error_code='http_503' \
         WHERE delivery_id=?1",
    )
    .bind(&delivery_id)
    .execute(&restarted.db)
    .await
    .expect("mark callback failed");
    let retried = callback::retry_failed(
        &restarted,
        CallbackDeliveryRequest {
            delivery_id: delivery_id.clone(),
        },
    )
    .await
    .expect("retry failed callback");
    assert_eq!(retried.status, "pending");
    assert_eq!(retried.attempts, 0);
    assert!(retried.last_http_status.is_none());
    assert!(retried.last_error_code.is_none());
}

#[tokio::test]
async fn disabled_runtime_does_not_reserve_new_callback_deliveries() {
    let (_root, _repo, _state_dir, state) = fixture().await;
    callback::configure_runtime(&state, false)
        .await
        .expect("disable callback runtime");

    task_transactions::begin(
        &state,
        TaskBeginRequest {
            workspace: "callback".into(),
            client_request_id: Some("callback:disabled".into()),
            context_query: None,
            context_max_bytes: None,
            context_max_items: None,
        },
    )
    .await
    .expect("begin task with callbacks disabled");

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM callback_outbox")
        .fetch_one(&state.db)
        .await
        .expect("count callback outbox");
    assert_eq!(count, 0);
}
