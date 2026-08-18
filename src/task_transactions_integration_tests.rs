use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

use tempfile::TempDir;
use tokio::sync::Mutex;

use crate::{
    config::WorkspaceConfig,
    db, memory,
    service::{AppState, FileExpectation, ReadFileRequest},
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
        id: "task".into(),
        name: "Task Fixture".into(),
        root: repo.to_path_buf(),
        access: "read-write".into(),
        remote: "origin".into(),
        default_branch: "main".into(),
        github_repository: None,
    }])
    .expect("build task workspace registry");
    let pool = db::connect(state_dir).await.expect("connect task db");
    db::register_workspaces(&pool, &registry)
        .await
        .expect("register task workspace");
    AppState {
        workspaces: registry,
        db: pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: None,
    }
}

async fn fixture() -> (TempDir, PathBuf, PathBuf, AppState) {
    let root = tempfile::tempdir().expect("task fixture tempdir");
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
    run_git(&repo, &["commit", "-m", "task fixture"]);

    let state = build_state(&repo, &state_dir).await;
    memory::index_workspace(&state, "task")
        .await
        .expect("index task workspace");
    (root, repo, state_dir, state)
}

fn begin_request(client_request_id: &str) -> TaskBeginRequest {
    TaskBeginRequest {
        workspace: "task".into(),
        client_request_id: Some(client_request_id.into()),
        context_query: Some("baseline".into()),
        context_max_bytes: Some(4096),
        context_max_items: Some(10),
    }
}

fn patch_to(value: u32) -> String {
    format!(
        "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-pub fn baseline() -> u32 {{ 1 }}\n+pub fn baseline() -> u32 {{ {value} }}\n"
    )
}

async fn source_hash(state: &AppState) -> String {
    state
        .read_file(ReadFileRequest {
            workspace: "task".into(),
            path: "src/lib.rs".into(),
            start_line: None,
            end_line: None,
        })
        .await
        .expect("read source")
        .sha256
}

fn expected_file(hash: &str) -> FileExpectation {
    FileExpectation {
        path: "src/lib.rs".into(),
        sha256: Some(hash.into()),
    }
}

#[tokio::test]
async fn persists_idempotent_proposal_and_applies_after_state_reconstruction() {
    let (_root, repo, state_dir, state) = fixture().await;
    let begun = task_transactions::begin(&state, begin_request("task:e2e"))
        .await
        .expect("begin durable task");
    assert!(!begun.replayed);
    assert_eq!(begun.task.status, "active");
    assert!(begun.task.context_sha256.is_some());
    assert!(
        begun
            .context
            .as_ref()
            .is_some_and(|pack| !pack.items.is_empty())
    );

    let replay = task_transactions::begin(&state, begin_request("task:e2e"))
        .await
        .expect("replay durable task");
    assert!(replay.replayed);
    assert_eq!(replay.task.id, begun.task.id);
    assert!(replay.context.is_none());

    let conflict = task_transactions::begin(
        &state,
        TaskBeginRequest {
            context_query: Some("different query".into()),
            ..begin_request("task:e2e")
        },
    )
    .await
    .expect_err("changed request must conflict with client idempotency key");
    assert!(conflict.to_string().contains("different task request"));

    let hash = source_hash(&state).await;
    let proposal = task_transactions::propose_patch(
        &state,
        TaskProposePatchRequest {
            task_id: begun.task.id.clone(),
            idempotency_key: Some("proposal:e2e".into()),
            expected_files: vec![expected_file(&hash)],
            patch: patch_to(2),
        },
    )
    .await
    .expect("create patch proposal");
    assert!(!proposal.replayed);
    assert_eq!(proposal.proposal.status, "proposed");
    assert_eq!(proposal.proposal.changed_paths, vec!["src/lib.rs"]);
    assert_eq!(
        std::fs::read_to_string(repo.join("src/lib.rs")).expect("read unchanged source"),
        "pub fn baseline() -> u32 { 1 }\n"
    );

    let proposal_replay = task_transactions::propose_patch(
        &state,
        TaskProposePatchRequest {
            task_id: begun.task.id.clone(),
            idempotency_key: Some("proposal:e2e".into()),
            expected_files: vec![expected_file(&hash)],
            patch: patch_to(2),
        },
    )
    .await
    .expect("replay patch proposal");
    assert!(proposal_replay.replayed);
    assert_eq!(proposal_replay.proposal.id, proposal.proposal.id);

    let proposal_conflict = task_transactions::propose_patch(
        &state,
        TaskProposePatchRequest {
            task_id: begun.task.id.clone(),
            idempotency_key: Some("proposal:e2e".into()),
            expected_files: vec![expected_file(&hash)],
            patch: patch_to(3),
        },
    )
    .await
    .expect_err("changed proposal must conflict with idempotency key");
    assert!(
        proposal_conflict
            .to_string()
            .contains("different patch proposal")
    );

    let before_restart = task_transactions::get(
        &state,
        TaskIdRequest {
            task_id: begun.task.id.clone(),
        },
    )
    .await
    .expect("read task before restart");
    let serialized = serde_json::to_string(&before_restart).expect("serialize task snapshot");
    assert!(!serialized.contains("baseline() -> u32 { 2 }"));
    assert!(
        before_restart
            .events
            .windows(2)
            .all(|pair| pair[0].id < pair[1].id)
    );

    let restarted = build_state(&repo, &state_dir).await;
    let after_restart = task_transactions::get(
        &restarted,
        TaskIdRequest {
            task_id: begun.task.id.clone(),
        },
    )
    .await
    .expect("read task after restart");
    assert_eq!(after_restart.task.status, "active");
    assert_eq!(after_restart.proposals.len(), 1);
    assert_eq!(after_restart.proposals[0].id, proposal.proposal.id);

    let applied = task_transactions::apply_patch(
        &restarted,
        TaskApplyPatchRequest {
            task_id: begun.task.id.clone(),
            proposal_id: proposal.proposal.id.clone(),
        },
    )
    .await
    .expect("apply stored proposal");
    assert_eq!(applied.changed_paths, vec!["src/lib.rs"]);
    assert!(!applied.changeset_id.is_empty());
    assert_eq!(
        std::fs::read_to_string(repo.join("src/lib.rs")).expect("read applied source"),
        "pub fn baseline() -> u32 { 2 }\n"
    );

    let final_snapshot = task_transactions::get(
        &restarted,
        TaskIdRequest {
            task_id: begun.task.id.clone(),
        },
    )
    .await
    .expect("read applied task");
    assert_eq!(final_snapshot.task.status, "applied");
    assert_eq!(final_snapshot.proposals[0].status, "applied");
    assert_eq!(
        final_snapshot.proposals[0].changeset_id.as_deref(),
        Some(applied.changeset_id.as_str())
    );
    assert!(
        final_snapshot
            .events
            .iter()
            .any(|event| event.event_type == "patch_applied")
    );
    assert!(
        task_transactions::cancel(
            &restarted,
            TaskIdRequest {
                task_id: begun.task.id,
            },
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn dirty_or_external_head_drift_stales_task_and_rejects_pending_proposals() {
    let (_root, repo, _state_dir, state) = fixture().await;
    let begun = task_transactions::begin(&state, begin_request("task:dirty"))
        .await
        .expect("begin dirty-drift task");
    let hash = source_hash(&state).await;
    let proposal = task_transactions::propose_patch(
        &state,
        TaskProposePatchRequest {
            task_id: begun.task.id.clone(),
            idempotency_key: Some("proposal:dirty".into()),
            expected_files: vec![expected_file(&hash)],
            patch: patch_to(2),
        },
    )
    .await
    .expect("propose before dirty drift");

    std::fs::write(repo.join("external.txt"), "dirty outside task\n").expect("dirty repository");
    let stale = task_transactions::get(
        &state,
        TaskIdRequest {
            task_id: begun.task.id.clone(),
        },
    )
    .await
    .expect("refresh stale task");
    assert_eq!(stale.task.status, "stale");
    assert_eq!(
        stale.task.stale_reason.as_deref(),
        Some("dirty_working_tree")
    );
    assert_eq!(stale.proposals[0].status, "rejected");
    assert!(stale.events.iter().any(|event| {
        event.event_type == "task_stale" && event.metadata["rejected_proposals"].as_u64() == Some(1)
    }));
    assert!(
        task_transactions::apply_patch(
            &state,
            TaskApplyPatchRequest {
                task_id: begun.task.id.clone(),
                proposal_id: proposal.proposal.id,
            },
        )
        .await
        .is_err()
    );

    let cancelled = task_transactions::cancel(
        &state,
        TaskIdRequest {
            task_id: begun.task.id,
        },
    )
    .await
    .expect("cancel stale task");
    assert_eq!(cancelled.status, "cancelled");

    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "external head drift"]);
    memory::index_workspace(&state, "task")
        .await
        .expect("reindex after external commit");

    let head_task = task_transactions::begin(&state, begin_request("task:head"))
        .await
        .expect("begin head-drift task");
    std::fs::write(repo.join("head.txt"), "new head\n").expect("write head drift file");
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "change head outside task"]);

    let head_stale = task_transactions::get(
        &state,
        TaskIdRequest {
            task_id: head_task.task.id,
        },
    )
    .await
    .expect("refresh head-stale task");
    assert_eq!(head_stale.task.status, "stale");
    assert_eq!(
        head_stale.task.stale_reason.as_deref(),
        Some("git_head_changed")
    );
}
