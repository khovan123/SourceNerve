use std::{path::Path, process::Command, sync::Arc};

use tokio::sync::Mutex;

use crate::{
    config::WorkspaceConfig,
    db,
    error::AppError,
    git,
    github::GitHubIssue,
    ops::{self, AuditQuery},
    service::AppState,
    workflow::{
        BranchCheckoutRequest, CommitRequest, DefaultSyncRequest, GitHubIssueCreateRequest,
        PushRequest,
    },
    workspace::WorkspaceRegistry,
};

fn run_git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .expect("execute git fixture command");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn reviewed_branch_commit_push_and_default_sync_flow() {
    let fixture = tempfile::tempdir().expect("fixture tempdir");
    let repo = fixture.path().join("repo");
    let remote = fixture.path().join("remote.git");
    let state_dir = fixture.path().join("state");
    std::fs::create_dir_all(&repo).expect("create repo directory");
    std::fs::create_dir_all(&remote).expect("create remote directory");

    run_git(&remote, &["init", "--bare"]);
    run_git(&repo, &["init", "-b", "main"]);
    run_git(&repo, &["config", "user.name", "SourceNerve Test"]);
    run_git(
        &repo,
        &["config", "user.email", "sourcenerve@example.invalid"],
    );
    std::fs::create_dir_all(repo.join("src")).expect("create source directory");
    std::fs::write(repo.join("src/lib.rs"), "pub fn baseline() -> u32 { 1 }\n")
        .expect("write baseline source");
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "initial"]);
    run_git(
        &repo,
        &[
            "remote",
            "add",
            "origin",
            remote.to_str().expect("remote path"),
        ],
    );
    run_git(&repo, &["push", "-u", "origin", "main"]);

    let initial_head = git::head(&repo).await.expect("read initial head");
    let registry = WorkspaceRegistry::build(&[WorkspaceConfig {
        id: "fixture".into(),
        name: "Fixture".into(),
        root: repo.clone(),
        access: "read-write".into(),
        remote: "origin".into(),
        default_branch: "main".into(),
        github_repository: Some("example/repository".into()),
    }])
    .expect("build workspace registry");
    let pool = db::connect(&state_dir).await.expect("connect fixture db");
    db::register_workspaces(&pool, &registry)
        .await
        .expect("register fixture workspace");
    let state = AppState {
        workspaces: registry,
        db: pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: None,
    };

    let checkout = state
        .checkout_branch(BranchCheckoutRequest {
            workspace: "fixture".into(),
            expected_head: initial_head.clone(),
            branch: "feat/e2e".into(),
            request_id: Some("e2e:checkout".into()),
        })
        .await
        .expect("checkout feature branch");
    assert_eq!(checkout.branch, "feat/e2e");
    assert_eq!(checkout.head, initial_head);

    std::fs::write(repo.join("new.txt"), "reviewed once\n").expect("write untracked file");
    let stale_review = state.git_review("fixture").await.expect("first git review");
    assert!(stale_review.dirty);
    assert!(stale_review.diff.contains("new.txt"));
    assert!(stale_review.diff.contains("reviewed once"));

    std::fs::write(repo.join("new.txt"), "changed after review\n").expect("mutate after review");
    let stale_commit = state
        .commit_reviewed(CommitRequest {
            workspace: "fixture".into(),
            expected_head: stale_review.head.clone(),
            expected_diff_sha256: stale_review.diff_sha256,
            message: "feat: stale commit must fail".into(),
            request_id: Some("e2e:stale-commit".into()),
        })
        .await
        .expect_err("stale diff hash must reject commit");
    assert!(matches!(
        stale_commit,
        AppError::InvalidRequest(message) if message.contains("working diff changed")
    ));

    let review = state.git_review("fixture").await.expect("fresh git review");
    let committed = state
        .commit_reviewed(CommitRequest {
            workspace: "fixture".into(),
            expected_head: review.head.clone(),
            expected_diff_sha256: review.diff_sha256,
            message: "feat: commit reviewed fixture".into(),
            request_id: Some("e2e:commit".into()),
        })
        .await
        .expect("commit reviewed diff");
    assert!(committed.clean);
    assert_ne!(committed.commit, initial_head);

    let stale_checkout = state
        .checkout_branch(BranchCheckoutRequest {
            workspace: "fixture".into(),
            expected_head: initial_head.clone(),
            branch: "feat/stale".into(),
            request_id: Some("e2e:stale-checkout".into()),
        })
        .await
        .expect_err("stale HEAD must reject checkout");
    assert!(matches!(stale_checkout, AppError::WorkspaceChanged { .. }));

    let pushed = state
        .push_current_branch(PushRequest {
            workspace: "fixture".into(),
            expected_head: committed.commit.clone(),
            request_id: Some("e2e:push".into()),
        })
        .await
        .expect("push current feature branch");
    assert_eq!(pushed.branch, "feat/e2e");
    assert_eq!(pushed.head, committed.commit);
    assert_eq!(
        git::remote_branch_head(&repo, "origin", "feat/e2e")
            .await
            .expect("read feature remote head")
            .as_deref(),
        Some(pushed.head.as_str())
    );

    let synced = state
        .sync_default_branch(DefaultSyncRequest {
            workspace: "fixture".into(),
            request_id: Some("e2e:sync".into()),
        })
        .await
        .expect("sync default branch");
    assert_eq!(synced.branch, "main");
    assert_eq!(synced.head, initial_head);
    assert_eq!(
        git::current_branch(&repo).await.expect("read branch"),
        "main"
    );
    assert!(
        git::status(&repo)
            .await
            .expect("read final status")
            .is_empty()
    );

    let audit = state
        .audit_events(AuditQuery {
            workspace: "fixture".into(),
            limit: 20,
        })
        .await
        .expect("read mutation audit");
    assert!(audit.iter().any(|event| {
        event.operation == "git_commit"
            && event.request_id.as_deref() == Some("e2e:stale-commit")
            && event.outcome == "rejected"
    }));
    assert!(audit.iter().any(|event| {
        event.operation == "git_push"
            && event.request_id.as_deref() == Some("e2e:push")
            && event.outcome == "success"
            && event.result_sha.as_deref() == Some(pushed.head.as_str())
    }));

    let readiness = state.readiness().await;
    assert!(readiness.database_ready);
    assert!(
        readiness
            .workspaces
            .iter()
            .any(|workspace| workspace.workspace == "fixture" && workspace.ready)
    );
    assert!(readiness.ready);

    let idempotency_key = "e2e:issue";
    let title = "Idempotent fixture issue";
    let body = "No provider call should happen during replay.";
    let fingerprint = ops::request_fingerprint(&serde_json::json!({
        "title": title,
        "body": body,
    }))
    .expect("fingerprint issue request");
    let stored_issue = GitHubIssue {
        number: 42,
        title: title.into(),
        url: "https://github.com/example/repository/issues/42".into(),
    };
    ops::idempotency_store(
        &state,
        "fixture",
        "github_issue_create",
        Some(idempotency_key),
        &fingerprint,
        &stored_issue,
    )
    .await
    .expect("seed idempotency response");

    let replay = state
        .github_issue_create(GitHubIssueCreateRequest {
            workspace: "fixture".into(),
            title: title.into(),
            body: body.into(),
            idempotency_key: Some(idempotency_key.into()),
        })
        .await
        .expect("replay stored provider response without token");
    assert_eq!(replay.number, stored_issue.number);
    assert_eq!(replay.url, stored_issue.url);

    let conflict = state
        .github_issue_create(GitHubIssueCreateRequest {
            workspace: "fixture".into(),
            title: "Different request".into(),
            body: body.into(),
            idempotency_key: Some(idempotency_key.into()),
        })
        .await
        .expect_err("same idempotency key with different request must fail");
    assert!(matches!(
        conflict,
        AppError::InvalidRequest(message) if message.contains("idempotency key was already used")
    ));
}
