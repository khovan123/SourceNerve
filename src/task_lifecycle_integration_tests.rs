use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

use tempfile::TempDir;
use tokio::sync::Mutex;

use crate::{
    config::WorkspaceConfig,
    db, git, memory,
    service::{AppState, FileExpectation, ReadFileRequest},
    task_lifecycle::{self, TaskBranchCheckoutRequest, TaskCommitRequest},
    task_transactions::{
        self, TaskApplyPatchRequest, TaskBeginRequest, TaskIdRequest, TaskProposePatchRequest,
    },
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
        id: "task-life".into(),
        name: "Task Lifecycle Fixture".into(),
        root: repo.to_path_buf(),
        access: "read-write".into(),
        remote: "origin".into(),
        default_branch: "main".into(),
        provider: None,
        repository: None,
        github_repository: None,
    }])
    .expect("build workspace registry");
    let pool = db::connect(state_dir).await.expect("connect task db");
    db::register_workspaces(&pool, &registry)
        .await
        .expect("register workspace");
    AppState {
        workspaces: registry,
        db: pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: None,
    }
}

async fn fixture() -> (TempDir, PathBuf, PathBuf, PathBuf, AppState) {
    let root = tempfile::tempdir().expect("fixture root");
    let repo = root.path().join("repo");
    let remote = root.path().join("remote.git");
    let state_dir = root.path().join("state");
    std::fs::create_dir_all(repo.join("src")).expect("create repo source");
    std::fs::create_dir_all(&remote).expect("create remote");
    run_git(&remote, &["init", "--bare"]);
    run_git(&repo, &["init", "-b", "main"]);
    run_git(&repo, &["config", "user.name", "SourceNerve Test"]);
    run_git(
        &repo,
        &["config", "user.email", "sourcenerve@example.invalid"],
    );
    std::fs::write(repo.join("src/lib.rs"), "pub fn value() -> u32 { 1 }\n")
        .expect("write baseline");
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "baseline"]);
    run_git(
        &repo,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    run_git(&repo, &["push", "-u", "origin", "main"]);

    let state = build_state(&repo, &state_dir).await;
    memory::index_workspace(&state, "task-life")
        .await
        .expect("index workspace");
    (root, repo, remote, state_dir, state)
}

async fn source_hash(state: &AppState) -> String {
    state
        .read_file(ReadFileRequest {
            workspace: "task-life".into(),
            path: "src/lib.rs".into(),
            start_line: None,
            end_line: None,
        })
        .await
        .expect("read source")
        .sha256
}

fn patch_to(value: u32) -> String {
    format!(
        "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-pub fn value() -> u32 {{ 1 }}\n+pub fn value() -> u32 {{ {value} }}\n"
    )
}

async fn begin_apply_and_review(state: &AppState) -> (String, String) {
    let begun = task_transactions::begin(
        state,
        TaskBeginRequest {
            workspace: "task-life".into(),
            client_request_id: Some("task:lifecycle".into()),
            context_query: Some("value".into()),
            context_max_bytes: Some(4096),
            context_max_items: Some(10),
        },
    )
    .await
    .expect("begin task");
    let task_id = begun.task.id;
    task_lifecycle::branch_checkout(
        state,
        TaskBranchCheckoutRequest {
            task_id: task_id.clone(),
            branch: "feat/task-lifecycle".into(),
        },
    )
    .await
    .expect("checkout task branch");

    let hash = source_hash(state).await;
    let proposal = task_transactions::propose_patch(
        state,
        TaskProposePatchRequest {
            task_id: task_id.clone(),
            idempotency_key: Some("proposal:lifecycle".into()),
            expected_files: vec![FileExpectation {
                path: "src/lib.rs".into(),
                sha256: Some(hash),
            }],
            patch: patch_to(2),
        },
    )
    .await
    .expect("propose patch");
    task_transactions::apply_patch(
        state,
        TaskApplyPatchRequest {
            task_id: task_id.clone(),
            proposal_id: proposal.proposal.id,
        },
    )
    .await
    .expect("apply patch");
    assert_eq!(
        task_lifecycle::load_view(state, &task_id)
            .await
            .expect("patched lifecycle")
            .phase,
        "patched"
    );
    let reviewed = task_lifecycle::review(
        state,
        TaskIdRequest {
            task_id: task_id.clone(),
        },
    )
    .await
    .expect("review task diff");
    assert_eq!(reviewed.lifecycle.phase, "reviewed");
    (task_id, reviewed.review.diff_sha256)
}

#[tokio::test]
async fn lifecycle_recovers_commit_push_and_completes_default_sync_after_restart() {
    let (_root, repo, remote, state_dir, state) = fixture().await;
    let (task_id, reviewed_sha) = begin_apply_and_review(&state).await;
    assert_eq!(
        task_lifecycle::load_view(&state, &task_id)
            .await
            .unwrap()
            .reviewed_diff_sha256
            .as_deref(),
        Some(reviewed_sha.as_str())
    );

    // Simulate a process crash after Git committed but before lifecycle persistence.
    run_git(&repo, &["add", "-A"]);
    run_git(&repo, &["commit", "-m", "task change"]);
    let committed = git::head(&repo).await.expect("committed head");
    let restarted = build_state(&repo, &state_dir).await;
    let recovered_commit = task_lifecycle::commit(
        &restarted,
        TaskCommitRequest {
            task_id: task_id.clone(),
            message: "task change".into(),
        },
    )
    .await
    .expect("recover task commit");
    assert!(recovered_commit.replayed);
    assert_eq!(recovered_commit.lifecycle.phase, "committed");
    assert_eq!(
        recovered_commit.lifecycle.commit_sha.as_deref(),
        Some(committed.as_str())
    );

    // Simulate a crash after push but before lifecycle persistence.
    run_git(&repo, &["push", "-u", "origin", "feat/task-lifecycle"]);
    let restarted = build_state(&repo, &state_dir).await;
    let recovered_push = task_lifecycle::push(
        &restarted,
        TaskIdRequest {
            task_id: task_id.clone(),
        },
    )
    .await
    .expect("recover task push");
    assert!(recovered_push.replayed);
    assert_eq!(recovered_push.lifecycle.phase, "pushed");
    assert_eq!(
        recovered_push.lifecycle.push_sha.as_deref(),
        Some(committed.as_str())
    );

    // Stand in for GitHub merge provider behavior by advancing remote main to the pushed commit.
    run_git(
        &remote,
        &["update-ref", "refs/heads/main", committed.as_str()],
    );
    sqlx::query(
        "UPDATE task_lifecycle SET phase='merged', merge_sha=?1, updated_at=unixepoch() WHERE task_id=?2",
    )
    .bind(&committed)
    .bind(&task_id)
    .execute(&restarted.db)
    .await
    .expect("persist simulated merge");

    let synced = task_lifecycle::default_sync(
        &restarted,
        TaskIdRequest {
            task_id: task_id.clone(),
        },
    )
    .await
    .expect("sync completed task");
    assert_eq!(synced.lifecycle.phase, "completed");
    assert_eq!(git::current_branch(&repo).await.unwrap(), "main");
    assert_eq!(git::head(&repo).await.unwrap(), committed);

    let replay = task_lifecycle::default_sync(
        &restarted,
        TaskIdRequest {
            task_id: task_id.clone(),
        },
    )
    .await
    .expect("replay completed sync");
    assert!(replay.replayed);

    let events: Vec<String> =
        sqlx::query_scalar("SELECT event_type FROM task_events WHERE task_id=?1 ORDER BY id")
            .bind(&task_id)
            .fetch_all(&restarted.db)
            .await
            .expect("load events");
    for expected in [
        "task_begun",
        "branch_checked_out",
        "patch_proposed",
        "patch_applied",
        "git_reviewed",
        "git_committed",
        "git_pushed",
        "task_completed",
    ] {
        assert!(
            events.iter().any(|event| event == expected),
            "missing {expected}"
        );
    }
}

#[tokio::test]
async fn commit_rejects_working_diff_changed_after_task_review() {
    let (_root, repo, _remote, _state_dir, state) = fixture().await;
    let (task_id, _reviewed_sha) = begin_apply_and_review(&state).await;
    std::fs::write(repo.join("src/lib.rs"), "pub fn value() -> u32 { 99 }\n")
        .expect("modify after review");

    let error = task_lifecycle::commit(
        &state,
        TaskCommitRequest {
            task_id,
            message: "must not commit".into(),
        },
    )
    .await
    .expect_err("changed diff must fail closed");
    assert!(
        error
            .to_string()
            .contains("working diff changed after review")
    );
}
