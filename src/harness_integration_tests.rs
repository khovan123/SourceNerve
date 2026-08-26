use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

use tempfile::TempDir;
use tokio::sync::Mutex;

use crate::{
    config::WorkspaceConfig,
    db, harness,
    harness::{HarnessRunBeginRequest, HarnessRunEventsRequest, HarnessRunIdRequest},
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
        id: "harness".into(),
        name: "Harness Fixture".into(),
        root: repo.to_path_buf(),
        access: "read-write".into(),
        remote: "origin".into(),
        default_branch: "main".into(),
        provider: None,
        repository: None,
        github_repository: None,
    }])
    .expect("build harness workspace registry");
    let pool = db::connect(state_dir).await.expect("connect harness db");
    db::register_workspaces(&pool, &registry)
        .await
        .expect("register harness workspace");
    AppState {
        workspaces: registry,
        db: pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: None,
    }
}

async fn fixture() -> (TempDir, PathBuf, PathBuf, AppState) {
    let root = tempfile::tempdir().expect("harness fixture tempdir");
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
    run_git(&repo, &["commit", "-m", "harness fixture"]);

    let state = build_state(&repo, &state_dir).await;
    memory::index_workspace(&state, "harness")
        .await
        .expect("index harness workspace");
    (root, repo, state_dir, state)
}

fn begin_request(client_request_id: &str) -> HarnessRunBeginRequest {
    HarnessRunBeginRequest {
        workspace: "harness".into(),
        profile: "interactive-local".into(),
        client_request_id: Some(client_request_id.into()),
    }
}

#[tokio::test]
async fn run_kernel_is_idempotent_restart_safe_and_marks_external_head_changes_stale() {
    let (_root, repo, state_dir, state) = fixture().await;
    let principal = harness::operator_principal_key();

    let begun = harness::begin(&state, begin_request("harness:e2e"), principal, true)
        .await
        .expect("begin harness run");
    assert!(!begun.replayed);
    assert_eq!(begun.snapshot.run.status, "running");
    assert_eq!(begun.snapshot.freshness.state, "current");
    assert_eq!(begun.snapshot.run.profile, "interactive-local");
    assert!(!begun.snapshot.run.capability_snapshot_sha256.is_empty());

    let replay = harness::begin(&state, begin_request("harness:e2e"), principal, true)
        .await
        .expect("replay harness run");
    assert!(replay.replayed);
    assert_eq!(replay.snapshot.run.id, begun.snapshot.run.id);

    let initial_events = harness::events(
        &state,
        HarnessRunEventsRequest {
            run_id: begun.snapshot.run.id.clone(),
            after_seq: None,
            limit: 100,
        },
        principal,
        true,
    )
    .await
    .expect("read initial harness events");
    assert_eq!(initial_events.events.len(), 1);
    assert_eq!(initial_events.events[0].seq, 0);
    assert_eq!(initial_events.events[0].event_type, "run/started");

    drop(state);
    let restarted = build_state(&repo, &state_dir).await;
    let restored = harness::get(
        &restarted,
        HarnessRunIdRequest {
            run_id: begun.snapshot.run.id.clone(),
        },
        principal,
        true,
    )
    .await
    .expect("restore harness run after restart");
    assert_eq!(restored.run.status, "running");
    assert_eq!(restored.freshness.state, "current");

    std::fs::write(repo.join("src/lib.rs"), "pub fn baseline() -> u32 { 2 }\n")
        .expect("change source");
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "external change"]);

    let stale = harness::get(
        &restarted,
        HarnessRunIdRequest {
            run_id: begun.snapshot.run.id.clone(),
        },
        principal,
        true,
    )
    .await
    .expect("refresh stale harness run");
    assert_eq!(stale.run.status, "stale");
    assert_eq!(stale.run.stale_reason.as_deref(), Some("git_head_changed"));
    assert_eq!(stale.freshness.state, "stale");

    let events = harness::events(
        &restarted,
        HarnessRunEventsRequest {
            run_id: begun.snapshot.run.id.clone(),
            after_seq: Some(0),
            limit: 100,
        },
        principal,
        true,
    )
    .await
    .expect("read stale event");
    assert_eq!(events.events.len(), 1);
    assert_eq!(events.events[0].seq, 1);
    assert_eq!(events.events[0].event_type, "run/stale");

    let cancelled = harness::cancel(
        &restarted,
        HarnessRunIdRequest {
            run_id: begun.snapshot.run.id,
        },
        principal,
        true,
    )
    .await
    .expect("cancel stale run");
    assert_eq!(cancelled.run.status, "cancelled");
    assert!(cancelled.run.completed_at.is_some());
}

#[tokio::test]
async fn run_kernel_completes_only_while_snapshot_is_current() {
    let (_root, _repo, _state_dir, state) = fixture().await;
    let principal = harness::operator_principal_key();
    let begun = harness::begin(&state, begin_request("harness:complete"), principal, true)
        .await
        .expect("begin completion run");

    let completed = harness::complete(
        &state,
        HarnessRunIdRequest {
            run_id: begun.snapshot.run.id.clone(),
        },
        principal,
        true,
    )
    .await
    .expect("complete current run");
    assert_eq!(completed.run.status, "completed");

    let events = harness::events(
        &state,
        HarnessRunEventsRequest {
            run_id: begun.snapshot.run.id,
            after_seq: None,
            limit: 100,
        },
        principal,
        true,
    )
    .await
    .expect("read completion events");
    assert_eq!(
        events
            .events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec!["run/started", "run/completed"]
    );
    assert!(
        events
            .events
            .windows(2)
            .all(|pair| pair[0].seq < pair[1].seq)
    );
}

#[tokio::test]
async fn running_run_keeps_stored_capabilities_and_marks_extension_changes_stale() {
    let (_root, _repo, _state_dir, state) = fixture().await;
    let principal = harness::operator_principal_key();
    let begun = harness::begin(
        &state,
        begin_request("harness:capability-snapshot"),
        principal,
        true,
    )
    .await
    .expect("begin capability snapshot run");
    let stored_digest = begun.snapshot.run.capability_snapshot_sha256.clone();

    sqlx::query(
        "INSERT INTO mcp_extensions(\
            id, name, version, namespace, transport, source, config_json, status, enabled\
         ) VALUES('phase2-ext', 'Phase 2 Extension', '1.0.0', 'phase2', 'stdio', 'test', '{}', 'enabled', 1)",
    )
    .execute(&state.db)
    .await
    .expect("insert enabled extension");
    sqlx::query(
        "INSERT INTO mcp_extension_tools(\
            extension_id, original_name, public_name, description, input_schema_json, schema_hash, \
            read_only, destructive, idempotent, open_world, approval_mode, enabled\
         ) VALUES(\
            'phase2-ext', 'lookup', 'phase2_lookup', 'Read fixture data', '{}', 'schema-v1', \
            1, 0, 1, 0, 'automatic', 1\
         )",
    )
    .execute(&state.db)
    .await
    .expect("insert enabled extension tool");

    let stale = harness::get(
        &state,
        HarnessRunIdRequest {
            run_id: begun.snapshot.run.id.clone(),
        },
        principal,
        true,
    )
    .await
    .expect("refresh run after capability registry change");

    assert_eq!(stale.run.status, "stale");
    assert_eq!(
        stale.run.stale_reason.as_deref(),
        Some("capability_snapshot_changed")
    );
    assert_eq!(stale.run.capability_snapshot_sha256, stored_digest);
    assert_ne!(
        stale.freshness.current_capability_snapshot_sha256,
        stale.run.capability_snapshot_sha256
    );
    assert_eq!(
        stale.run.capability_snapshot,
        begun.snapshot.run.capability_snapshot
    );

    let events = harness::events(
        &state,
        HarnessRunEventsRequest {
            run_id: begun.snapshot.run.id,
            after_seq: Some(0),
            limit: 100,
        },
        principal,
        true,
    )
    .await
    .expect("read capability stale event");
    assert_eq!(events.events.len(), 1);
    assert_eq!(events.events[0].event_type, "run/stale");
    assert_eq!(
        events.events[0].payload["reason"],
        "capability_snapshot_changed"
    );
}
