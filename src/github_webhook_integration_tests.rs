use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

use tempfile::TempDir;
use tokio::sync::Mutex;

use crate::{
    config::WorkspaceConfig,
    db, github_webhook, memory,
    service::AppState,
    task_transactions::{self, TaskBeginRequest},
    workspace::WorkspaceRegistry,
};

const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

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
        id: "github-hook".into(),
        name: "GitHub Hook Fixture".into(),
        root: repo.to_path_buf(),
        access: "read-write".into(),
        remote: "origin".into(),
        default_branch: "main".into(),
        github_repository: Some("owner/repo".into()),
    }])
    .expect("build GitHub hook registry");
    let pool = db::connect(state_dir).await.expect("connect GitHub hook db");
    db::register_workspaces(&pool, &registry)
        .await
        .expect("register GitHub hook workspace");
    AppState {
        workspaces: registry,
        db: pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: None,
    }
}

async fn fixture() -> (TempDir, PathBuf, PathBuf, AppState, String) {
    let root = tempfile::tempdir().expect("GitHub hook fixture tempdir");
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
    run_git(&repo, &["commit", "-m", "github webhook fixture"]);

    let state = build_state(&repo, &state_dir).await;
    memory::index_workspace(&state, "github-hook")
        .await
        .expect("index GitHub hook workspace");
    let begun = task_transactions::begin(
        &state,
        TaskBeginRequest {
            workspace: "github-hook".into(),
            client_request_id: Some("github-hook:e2e".into()),
            context_query: None,
            context_max_bytes: None,
            context_max_items: None,
        },
    )
    .await
    .expect("begin GitHub hook task");
    sqlx::query(
        "UPDATE task_lifecycle \
         SET phase='pr_open', branch='feat/test', commit_sha=?1, push_sha=?1, \
             pull_number=42, pull_head_sha=?1, updated_at=unixepoch() \
         WHERE task_id=?2",
    )
    .bind(HEAD)
    .bind(&begun.task.id)
    .execute(&state.db)
    .await
    .expect("seed linked PR lifecycle");

    (root, repo, state_dir, state, begun.task.id)
}

fn check_payload(conclusion: &str) -> (Vec<u8>, serde_json::Value) {
    let value = serde_json::json!({
        "action": "completed",
        "repository": { "full_name": "owner/repo" },
        "check_run": {
            "head_sha": HEAD,
            "status": "completed",
            "conclusion": conclusion,
            "pull_requests": [{ "number": 42 }],
            "output": { "summary": "sensitive provider text must not persist" }
        }
    });
    let raw = serde_json::to_vec(&value).expect("encode check payload");
    (raw, value)
}

#[tokio::test]
async fn linked_delivery_is_idempotent_sanitized_and_restart_safe() {
    let (_root, repo, state_dir, state, task_id) = fixture().await;
    let (raw, payload) = check_payload("success");

    let created = github_webhook::ingest(&state, "delivery-1", "check_run", &raw, &payload)
        .await
        .expect("ingest linked delivery");
    assert!(created.accepted);
    assert!(!created.replayed);
    assert_eq!(created.workspace.as_deref(), Some("github-hook"));
    assert_eq!(created.task_id.as_deref(), Some(task_id.as_str()));
    assert_eq!(created.pull_number, Some(42));

    let replay = github_webhook::ingest(&state, "delivery-1", "check_run", &raw, &payload)
        .await
        .expect("replay linked delivery");
    assert!(replay.accepted);
    assert!(replay.replayed);
    assert_eq!(replay.task_id, created.task_id);

    let (changed_raw, changed_payload) = check_payload("failure");
    let conflict = github_webhook::ingest(
        &state,
        "delivery-1",
        "check_run",
        &changed_raw,
        &changed_payload,
    )
    .await
    .expect_err("changed delivery payload must fail closed");
    assert!(conflict.to_string().contains("different payload"));

    let summary = github_webhook::summary_for_task(&state, &task_id)
        .await
        .expect("load GitHub observation")
        .expect("observation exists");
    assert_eq!(summary.repository, "owner/repo");
    assert_eq!(summary.pull_number, 42);
    assert_eq!(summary.pull_head_sha, HEAD);
    assert_eq!(summary.latest_check_status.as_deref(), Some("completed"));
    assert_eq!(summary.latest_check_conclusion.as_deref(), Some("success"));
    assert_eq!(summary.last_event, "check_run");

    let stored: Vec<String> = sqlx::query_scalar(
        "SELECT event_name || ':' || COALESCE(action, '') || ':' || COALESCE(check_conclusion, '') \
         FROM github_webhook_deliveries WHERE task_id=?1",
    )
    .bind(&task_id)
    .fetch_all(&state.db)
    .await
    .expect("read stored webhook delivery");
    let task_events: Vec<String> =
        sqlx::query_scalar("SELECT metadata_json FROM task_events WHERE task_id=?1 ORDER BY id")
            .bind(&task_id)
            .fetch_all(&state.db)
            .await
            .expect("read task event metadata");
    let serialized = format!("{}\n{}", stored.join("\n"), task_events.join("\n"));
    assert!(!serialized.contains("sensitive provider text"));
    assert!(!serialized.contains(repo.to_string_lossy().as_ref()));

    let restarted = build_state(&repo, &state_dir).await;
    let after_restart = github_webhook::summary_for_task(&restarted, &task_id)
        .await
        .expect("load observation after restart")
        .expect("observation survives restart");
    assert_eq!(after_restart.latest_check_conclusion.as_deref(), Some("success"));
    assert_eq!(after_restart.last_delivery_id, "delivery-1");
}

#[tokio::test]
async fn unrelated_repository_or_head_does_not_attach_to_task() {
    let (_root, _repo, _state_dir, state, _task_id) = fixture().await;

    let unrelated = serde_json::json!({
        "action": "closed",
        "repository": { "full_name": "other/repo" },
        "pull_request": {
            "number": 42,
            "state": "closed",
            "merged": false,
            "head": { "sha": HEAD }
        }
    });
    let raw = serde_json::to_vec(&unrelated).expect("encode unrelated payload");
    let result = github_webhook::ingest(
        &state,
        "delivery-unrelated",
        "pull_request",
        &raw,
        &unrelated,
    )
    .await
    .expect("ignore unrelated repository");
    assert!(!result.accepted);
    assert!(result.task_id.is_none());

    let wrong_head = serde_json::json!({
        "action": "closed",
        "repository": { "full_name": "owner/repo" },
        "pull_request": {
            "number": 42,
            "state": "closed",
            "merged": false,
            "head": { "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
        }
    });
    let wrong_raw = serde_json::to_vec(&wrong_head).expect("encode wrong-head payload");
    let wrong = github_webhook::ingest(
        &state,
        "delivery-wrong-head",
        "pull_request",
        &wrong_raw,
        &wrong_head,
    )
    .await
    .expect("ignore wrong head");
    assert!(!wrong.accepted);
    assert!(wrong.task_id.is_none());

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM github_webhook_deliveries")
        .fetch_one(&state.db)
        .await
        .expect("count linked deliveries");
    assert_eq!(count, 0);
}
