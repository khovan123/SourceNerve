use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

use tempfile::TempDir;
use tokio::sync::Mutex;

use crate::{
    config::WorkspaceConfig,
    db,
    job_ingress::{self, JobGetRequest, JobSubmitRequest},
    memory,
    service::AppState,
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
        id: "job".into(),
        name: "Job Fixture".into(),
        root: repo.to_path_buf(),
        access: "read-write".into(),
        remote: "origin".into(),
        default_branch: "main".into(),
        provider: None,
        repository: None,
        github_repository: None,
    }])
    .expect("build job workspace registry");
    let pool = db::connect(state_dir).await.expect("connect job db");
    db::register_workspaces(&pool, &registry)
        .await
        .expect("register job workspace");
    AppState {
        workspaces: registry,
        db: pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: None,
    }
}

async fn fixture() -> (TempDir, PathBuf, PathBuf, AppState) {
    let root = tempfile::tempdir().expect("job fixture tempdir");
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
    run_git(&repo, &["commit", "-m", "job fixture"]);

    let state = build_state(&repo, &state_dir).await;
    memory::index_workspace(&state, "job")
        .await
        .expect("index job workspace");
    (root, repo, state_dir, state)
}

fn request(client_request_id: &str) -> JobSubmitRequest {
    JobSubmitRequest {
        client_request_id: client_request_id.into(),
        workspace: "job".into(),
        context_query: Some("baseline".into()),
        context_max_bytes: Some(4096),
        context_max_items: Some(10),
    }
}

#[tokio::test]
async fn webhook_job_is_idempotent_sanitized_and_restart_safe() {
    let (_root, repo, state_dir, state) = fixture().await;
    let created = job_ingress::submit(&state, request("webhook:e2e"))
        .await
        .expect("submit webhook job");
    assert!(!created.replayed);
    assert_eq!(created.job.status, "active");
    assert_eq!(
        created.task.as_ref().map(|task| task.status.as_str()),
        Some("active")
    );
    assert_eq!(
        created
            .lifecycle
            .as_ref()
            .map(|lifecycle| lifecycle.phase.as_str()),
        Some("snapshot")
    );
    let task_id = created.job.task_id.clone().expect("linked task id");

    let replay = job_ingress::submit(&state, request("webhook:e2e"))
        .await
        .expect("replay webhook job");
    assert!(replay.replayed);
    assert_eq!(replay.job.id, created.job.id);
    assert_eq!(replay.job.task_id.as_deref(), Some(task_id.as_str()));

    let conflict = job_ingress::submit(
        &state,
        JobSubmitRequest {
            context_query: Some("changed prompt must not be accepted".into()),
            ..request("webhook:e2e")
        },
    )
    .await
    .expect_err("changed request must fail closed");
    assert!(
        conflict
            .to_string()
            .contains("different webhook job request")
    );

    let event_json: Vec<String> =
        sqlx::query_scalar("SELECT metadata_json FROM job_events WHERE job_id=?1 ORDER BY id")
            .bind(&created.job.id)
            .fetch_all(&state.db)
            .await
            .expect("read job events");
    assert_eq!(event_json.len(), 2);
    let serialized_events = event_json.join("\n");
    assert!(!serialized_events.contains("baseline"));
    assert!(!serialized_events.contains(repo.to_string_lossy().as_ref()));

    let restarted = build_state(&repo, &state_dir).await;
    let after_restart = job_ingress::get(
        &restarted,
        JobGetRequest {
            job_id: created.job.id.clone(),
        },
    )
    .await
    .expect("get webhook job after restart");
    assert_eq!(after_restart.job.task_id.as_deref(), Some(task_id.as_str()));
    assert_eq!(after_restart.job.status, "active");
    assert_eq!(
        after_restart
            .lifecycle
            .as_ref()
            .map(|lifecycle| lifecycle.phase.as_str()),
        Some("snapshot")
    );
}

#[tokio::test]
async fn reservation_accepts_dirty_tree_and_still_blocks_changed_request() {
    let (_root, repo, _state_dir, state) = fixture().await;
    std::fs::write(repo.join("dirty.txt"), "dirty\n").expect("dirty working tree");

    let first = job_ingress::submit(&state, request("webhook:reserved"))
        .await
        .expect("dirty repository may begin a snapshotted task");
    assert!(!first.replayed);
    assert!(first.task.is_some());

    let jobs: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM jobs WHERE ingress='webhook' AND client_request_id='webhook:reserved'",
    )
    .fetch_one(&state.db)
    .await
    .expect("count reserved jobs");
    let tasks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks")
        .fetch_one(&state.db)
        .await
        .expect("count tasks");
    assert_eq!(jobs, 1);
    assert_eq!(tasks, 1);

    let changed = job_ingress::submit(
        &state,
        JobSubmitRequest {
            context_query: Some("different".into()),
            ..request("webhook:reserved")
        },
    )
    .await
    .expect_err("reserved key must reject changed payload");
    assert!(
        changed
            .to_string()
            .contains("different webhook job request")
    );
    let tasks_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks")
        .fetch_one(&state.db)
        .await
        .expect("count tasks after conflict");
    assert_eq!(tasks_after, 1);
}
