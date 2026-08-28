use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

use rmcp::model::CallToolRequestParams;
use tempfile::TempDir;
use tokio::sync::Mutex;

use crate::{
    config::WorkspaceConfig,
    db, harness,
    harness::{HarnessRunBeginRequest, HarnessRunEventsRequest, HarnessRunIdRequest},
    mcp::{harness_approval, harness_tool_pipeline},
    memory,
    oauth::Principal,
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
    std::fs::create_dir_all(repo.join("tests")).expect("create tests directory");
    run_git(&repo, &["init", "-b", "main"]);
    run_git(&repo, &["config", "user.name", "SourceNerve Test"]);
    run_git(
        &repo,
        &["config", "user.email", "sourcenerve@example.invalid"],
    );
    std::fs::write(repo.join("src/lib.rs"), "pub fn baseline() -> u32 { 1 }\n")
        .expect("write baseline source");
    std::fs::write(
        repo.join("Cargo.toml"),
        "[package]\nname = \"harness-fixture\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
    )
    .expect("write fixture Cargo manifest");
    std::fs::write(
        repo.join("tests/smoke.rs"),
        "#[test]\nfn integration_smoke() { assert_eq!(2 + 2, 4); }\n",
    )
    .expect("write fixture integration proof");
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "harness fixture"]);

    let state = build_state(&repo, &state_dir).await;
    memory::index_workspace(&state, "harness")
        .await
        .expect("index harness workspace");
    (root, repo, state_dir, state)
}

fn begin_request(client_request_id: &str) -> HarnessRunBeginRequest {
    begin_request_with_profile(client_request_id, "interactive-local")
}

fn begin_request_with_profile(client_request_id: &str, profile: &str) -> HarnessRunBeginRequest {
    HarnessRunBeginRequest {
        workspace: "harness".into(),
        profile: profile.into(),
        sandbox: None,
        client_request_id: Some(client_request_id.into()),
        parent_run_id: None,
        capability_ids: None,
    }
}

fn child_request(
    parent_run_id: &str,
    client_request_id: &str,
    profile: &str,
    capability_ids: &[&str],
) -> HarnessRunBeginRequest {
    HarnessRunBeginRequest {
        workspace: "harness".into(),
        profile: profile.into(),
        sandbox: None,
        client_request_id: Some(client_request_id.into()),
        parent_run_id: Some(parent_run_id.into()),
        capability_ids: Some(
            capability_ids
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
        ),
    }
}

fn tool_request(name: &str, arguments: serde_json::Value) -> CallToolRequestParams {
    let mut request = CallToolRequestParams::new(name.to_string());
    request.arguments = Some(
        arguments
            .as_object()
            .expect("tool request arguments must be an object")
            .clone(),
    );
    request
}

async fn observe_context(state: &AppState, run_id: &str) {
    let context = tool_request(
        "workspace_file_fetch",
        serde_json::json!({
            "workspace": "harness",
            "path": "src/lib.rs",
            "_harness_run_id": run_id,
        }),
    );
    harness_tool_pipeline::begin(state, &Principal::Operator, &context)
        .await
        .expect("observe Harness Context")
        .finish(state, true, None)
        .await
        .expect("finish Harness Context observation");
}

#[tokio::test]
async fn root_run_persists_explicit_execution_sandbox_without_becoming_stale() {
    let (_root, _repo, _state_dir, state) = fixture().await;
    let principal = harness::operator_principal_key();
    let mut request = begin_request("harness:danger-sandbox");
    request.sandbox = Some("danger-full-access".into());

    let begun = harness::begin(&state, request, principal, true)
        .await
        .expect("begin danger-full-access run");
    assert_eq!(begun.snapshot.run.status, "running");
    assert_eq!(begun.snapshot.freshness.state, "current");
    assert_eq!(
        begun.snapshot.run.capability_snapshot["profile"]["sandbox"],
        "danger-full-access"
    );
    assert_eq!(
        begun.snapshot.run.capability_snapshot["sandbox_override"],
        "danger-full-access"
    );

    let refreshed = harness::get(
        &state,
        HarnessRunIdRequest {
            run_id: begun.snapshot.run.id,
        },
        principal,
        true,
    )
    .await
    .expect("refresh explicit sandbox run");
    assert_eq!(refreshed.run.status, "running");
    assert_eq!(refreshed.freshness.state, "current");
    assert_eq!(
        refreshed.run.capability_snapshot["profile"]["sandbox"],
        "danger-full-access"
    );

    let mut denied = begin_request_with_profile("harness:danger-read-only", "read-only-analysis");
    denied.sandbox = Some("danger-full-access".into());
    let error = harness::begin(&state, denied, principal, true)
        .await
        .expect_err("read-only profile must not widen to danger-full-access");
    assert!(
        error
            .to_string()
            .contains("workspace-write Harness profile")
    );
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
    assert_eq!(restored.recovery.state, "resumable");

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
    assert_eq!(stale.recovery.state, "stale");

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
    assert_eq!(cancelled.recovery.state, "terminal");
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
    assert_eq!(completed.recovery.state, "terminal");

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

#[tokio::test]
async fn child_run_is_scoped_restart_safe_and_independently_cancelled() {
    let (_root, repo, state_dir, state) = fixture().await;
    let parent = harness::begin(
        &state,
        begin_request("harness:parent"),
        "principal-a",
        false,
    )
    .await
    .expect("begin parent run");
    let child = harness::begin(
        &state,
        child_request(
            &parent.snapshot.run.id,
            "harness:child",
            "guarded-durable",
            &["core.repository.read", "core.files.read"],
        ),
        "principal-a",
        false,
    )
    .await
    .expect("begin child run");

    assert_eq!(
        child.snapshot.run.parent_run_id.as_deref(),
        Some(parent.snapshot.run.id.as_str())
    );
    assert_eq!(child.snapshot.run.workspace, parent.snapshot.run.workspace);
    assert_eq!(
        child.snapshot.run.principal_id,
        parent.snapshot.run.principal_id
    );
    let capability_ids = child.snapshot.run.capability_snapshot["capabilities"]
        .as_array()
        .expect("child capabilities")
        .iter()
        .filter_map(|capability| capability["id"].as_str())
        .collect::<Vec<_>>();
    assert!(capability_ids.contains(&"core.repository.read"));
    assert!(capability_ids.contains(&"core.files.read"));
    assert!(!capability_ids.contains(&"core.files.write"));

    let refreshed_parent = harness::get(
        &state,
        HarnessRunIdRequest {
            run_id: parent.snapshot.run.id.clone(),
        },
        "principal-a",
        false,
    )
    .await
    .expect("read parent with child summary");
    assert_eq!(refreshed_parent.children.len(), 1);
    assert_eq!(refreshed_parent.children[0].id, child.snapshot.run.id);
    assert_eq!(
        refreshed_parent.children[0].parent_run_id,
        parent.snapshot.run.id
    );

    let cross_principal = harness::begin(
        &state,
        child_request(
            &parent.snapshot.run.id,
            "harness:child-cross-principal",
            "guarded-durable",
            &["core.repository.read"],
        ),
        "principal-b",
        false,
    )
    .await
    .expect_err("cross-principal child delegation must fail closed");
    assert!(
        cross_principal
            .to_string()
            .contains("harness run not found")
    );

    drop(state);
    let restarted = build_state(&repo, &state_dir).await;
    let restored_child = harness::get(
        &restarted,
        HarnessRunIdRequest {
            run_id: child.snapshot.run.id.clone(),
        },
        "principal-a",
        false,
    )
    .await
    .expect("restore child after restart");
    assert_eq!(restored_child.run.status, "running");
    assert_eq!(restored_child.freshness.state, "current");
    assert_eq!(
        restored_child.run.parent_run_id.as_deref(),
        Some(parent.snapshot.run.id.as_str())
    );

    let cancelled_child = harness::cancel(
        &restarted,
        HarnessRunIdRequest {
            run_id: child.snapshot.run.id,
        },
        "principal-a",
        false,
    )
    .await
    .expect("cancel child run");
    assert_eq!(cancelled_child.run.status, "cancelled");
    let parent_after_child_cancel = harness::get(
        &restarted,
        HarnessRunIdRequest {
            run_id: parent.snapshot.run.id,
        },
        "principal-a",
        false,
    )
    .await
    .expect("parent remains independently running");
    assert_eq!(parent_after_child_cancel.run.status, "running");
}

#[tokio::test]
async fn child_run_rejects_authority_widening_and_ignores_new_capabilities() {
    let (_root, _repo, _state_dir, state) = fixture().await;
    let read_only_parent = harness::begin(
        &state,
        begin_request_with_profile("harness:read-only-parent", "read-only-analysis"),
        "principal-a",
        false,
    )
    .await
    .expect("begin read-only parent");
    let wider = harness::begin(
        &state,
        child_request(
            &read_only_parent.snapshot.run.id,
            "harness:wider-child",
            "interactive-local",
            &["core.repository.read"],
        ),
        "principal-a",
        false,
    )
    .await
    .expect_err("child profile widening must fail");
    assert!(wider.to_string().contains("cannot widen parent"));

    let parent = harness::begin(
        &state,
        begin_request("harness:subset-parent"),
        "principal-a",
        false,
    )
    .await
    .expect("begin subset parent");
    let unknown = harness::begin(
        &state,
        child_request(
            &parent.snapshot.run.id,
            "harness:unknown-capability",
            "guarded-durable",
            &["plugin.not-in-parent.skill.read"],
        ),
        "principal-a",
        false,
    )
    .await
    .expect_err("child capability must come from parent snapshot");
    assert!(
        unknown
            .to_string()
            .contains("not present in the parent snapshot")
    );

    let child = harness::begin(
        &state,
        child_request(
            &parent.snapshot.run.id,
            "harness:stable-subset-child",
            "guarded-durable",
            &["core.repository.read", "core.files.read"],
        ),
        "principal-a",
        false,
    )
    .await
    .expect("begin stable subset child");
    let stored_digest = child.snapshot.run.capability_snapshot_sha256.clone();

    sqlx::query(
        "INSERT INTO mcp_extensions(\
            id, name, version, namespace, transport, source, config_json, status, enabled\
         ) VALUES('child-new-ext', 'Child New Extension', '1.0.0', 'childnew', 'stdio', 'test', '{}', 'enabled', 1)",
    )
    .execute(&state.db)
    .await
    .expect("insert extension after child start");
    sqlx::query(
        "INSERT INTO mcp_extension_tools(\
            extension_id, original_name, public_name, description, input_schema_json, schema_hash, \
            read_only, destructive, idempotent, open_world, approval_mode, enabled\
         ) VALUES(\
            'child-new-ext', 'lookup', 'childnew_lookup', 'Read fixture data', '{}', 'schema-v1', \
            1, 0, 1, 0, 'automatic', 1\
         )",
    )
    .execute(&state.db)
    .await
    .expect("insert extension tool after child start");

    let current_child = harness::get(
        &state,
        HarnessRunIdRequest {
            run_id: child.snapshot.run.id,
        },
        "principal-a",
        false,
    )
    .await
    .expect("refresh child after unrelated capability addition");
    assert_eq!(current_child.run.status, "running");
    assert_eq!(current_child.freshness.state, "current");
    assert_eq!(
        current_child.freshness.current_capability_snapshot_sha256,
        stored_digest
    );
    assert!(
        !serde_json::to_string(&current_child.run.capability_snapshot)
            .unwrap()
            .contains("childnew")
    );
}

#[tokio::test]
async fn tool_pipeline_records_safe_run_events_and_never_persists_raw_arguments() {
    let (_root, _repo, _state_dir, state) = fixture().await;
    let begun = harness::begin(
        &state,
        begin_request("harness:pipeline-read"),
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("begin pipeline run");
    let marker = "RAW_ARGUMENT_MARKER_MUST_NOT_BE_PERSISTED";
    let request = tool_request(
        "workspace_file_fetch",
        serde_json::json!({
            "workspace": "harness",
            "path": "src/lib.rs",
            "marker": marker,
            "_harness_run_id": begun.snapshot.run.id,
        }),
    );

    let ticket = harness_tool_pipeline::begin(&state, &Principal::Operator, &request)
        .await
        .expect("authorize classified read tool");
    let row: (String, String, i64, String) = sqlx::query_as(
        "SELECT capability_id, result_category, dispatched, argument_sha256 \
         FROM harness_tool_executions WHERE id=?1",
    )
    .bind(&ticket.id)
    .fetch_one(&state.db)
    .await
    .expect("read started execution");
    assert_eq!(row.0, "core.files.read");
    assert_eq!(row.1, "started");
    assert_eq!(row.2, 1);
    assert_eq!(row.3.len(), 64);
    assert!(!row.3.contains(marker));

    ticket
        .finish(&state, true, None)
        .await
        .expect("finish read execution");
    let result: String =
        sqlx::query_scalar("SELECT result_category FROM harness_tool_executions ORDER BY started_at DESC, id DESC LIMIT 1")
            .fetch_one(&state.db)
            .await
            .expect("read completed execution");
    assert_eq!(result, "success");

    let events = harness::events(
        &state,
        HarnessRunEventsRequest {
            run_id: begun.snapshot.run.id,
            after_seq: Some(0),
            limit: 100,
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("read tool pipeline events");
    assert_eq!(
        events
            .events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec!["tool/requested", "tool/started", "tool/result"]
    );
    assert!(!serde_json::to_string(&events).unwrap().contains(marker));
}

#[tokio::test]
async fn tool_pipeline_auto_attaches_a_current_harness_without_prompt_run_id() {
    let (_root, _repo, _state_dir, state) = fixture().await;
    let request = tool_request(
        "workspace_file_fetch",
        serde_json::json!({
            "workspace": "harness",
            "path": "src/lib.rs",
        }),
    );

    let first = harness_tool_pipeline::begin(&state, &Principal::Operator, &request)
        .await
        .expect("auto-attach first workspace operation");
    let first_run_id = first.run_id.clone().expect("automatic Harness run id");
    first
        .finish(&state, true, None)
        .await
        .expect("finish first auto-bound read");

    let origin: String = sqlx::query_scalar("SELECT origin FROM harness_runs WHERE id=?1")
        .bind(&first_run_id)
        .fetch_one(&state.db)
        .await
        .expect("read automatic run origin");
    assert_eq!(origin, "automatic");

    let second = harness_tool_pipeline::begin(&state, &Principal::Operator, &request)
        .await
        .expect("reuse current automatic Harness run");
    assert_eq!(second.run_id.as_deref(), Some(first_run_id.as_str()));
    second
        .finish(&state, true, None)
        .await
        .expect("finish second auto-bound read");

    let running_automatic: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM harness_runs \
         WHERE workspace_id='harness' AND principal_id='operator' AND origin='automatic' \
           AND parent_run_id IS NULL AND status='running'",
    )
    .fetch_one(&state.db)
    .await
    .expect("count active automatic Harness runs");
    assert_eq!(running_automatic, 1);
}

#[tokio::test]
async fn closed_loop_blocks_mutation_until_context_has_been_observed() {
    let (_root, _repo, _state_dir, state) = fixture().await;
    let begun = harness::begin(
        &state,
        begin_request("harness:context-gate"),
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("begin context-gated run");
    let run_id = begun.snapshot.run.id.clone();

    let mutation = tool_request(
        "workspace_file_write",
        serde_json::json!({
            "workspace": "harness",
            "path": "src/lib.rs",
            "content": "blocked before context",
            "_harness_run_id": run_id.clone(),
        }),
    );
    let error = harness_tool_pipeline::begin(&state, &Principal::Operator, &mutation)
        .await
        .expect_err("mutation before Context must be rejected");
    assert!(error.to_string().contains("requires Context"));
    assert!(error.to_string().contains("Harness context"));

    let context = tool_request(
        "workspace_file_fetch",
        serde_json::json!({
            "workspace": "harness",
            "path": "src/lib.rs",
            "_harness_run_id": run_id.clone(),
        }),
    );
    harness_tool_pipeline::begin(&state, &Principal::Operator, &context)
        .await
        .expect("context read is allowed")
        .finish(&state, true, None)
        .await
        .expect("finish context read");

    harness_tool_pipeline::begin(&state, &Principal::Operator, &mutation)
        .await
        .expect("mutation is allowed after Context")
        .finish(&state, true, None)
        .await
        .expect("finish mutation after Context");
}

#[tokio::test]
async fn closed_loop_moves_from_context_through_recovery_to_learn_and_reuses_workspace_learning() {
    let (_root, _repo, _state_dir, state) = fixture().await;
    let begun = harness::begin(
        &state,
        begin_request("harness:closed-loop"),
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("begin closed-loop run");
    let run_id = begun.snapshot.run.id.clone();
    assert_eq!(begun.snapshot.closed_loop.phase, "context");
    assert!(begun.snapshot.closed_loop.learning_hints.is_empty());

    let context = tool_request(
        "workspace_file_fetch",
        serde_json::json!({
            "workspace": "harness",
            "path": "src/lib.rs",
            "_harness_run_id": run_id.clone(),
        }),
    );
    harness_tool_pipeline::begin(&state, &Principal::Operator, &context)
        .await
        .expect("start context read")
        .finish(&state, true, None)
        .await
        .expect("finish context read");
    let snapshot = harness::get(
        &state,
        HarnessRunIdRequest {
            run_id: run_id.clone(),
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("read context state");
    assert_eq!(snapshot.closed_loop.context_reads, 1);
    assert_eq!(snapshot.closed_loop.phase, "context");

    let execute = tool_request(
        "workspace_file_write",
        serde_json::json!({
            "workspace": "harness",
            "path": "src/lib.rs",
            "content": "simulated mutation",
            "_harness_run_id": run_id.clone(),
        }),
    );
    let execute_ticket = harness_tool_pipeline::begin(&state, &Principal::Operator, &execute)
        .await
        .expect("start execute step");
    let executing = harness::get(
        &state,
        HarnessRunIdRequest {
            run_id: run_id.clone(),
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("read execute state");
    assert_eq!(executing.closed_loop.phase, "execute");
    execute_ticket
        .finish(&state, true, None)
        .await
        .expect("finish execute step");
    let needs_verify = harness::get(
        &state,
        HarnessRunIdRequest {
            run_id: run_id.clone(),
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("read verify-required state");
    assert_eq!(needs_verify.closed_loop.phase, "verify");
    assert_eq!(needs_verify.closed_loop.work_shape, "bounded");
    assert_eq!(
        needs_verify.closed_loop.work_scope.as_deref(),
        Some("src/lib.rs")
    );
    assert_eq!(
        needs_verify.closed_loop.selected_proof_type.as_deref(),
        Some("focused-test")
    );
    assert_eq!(
        needs_verify.closed_loop.selected_proof_source.as_deref(),
        Some("Cargo.toml")
    );
    assert_eq!(
        needs_verify.closed_loop.selected_proof_command.as_deref(),
        Some("cargo test <focused-target>")
    );
    assert!(needs_verify.closed_loop.satisfied_proofs.is_empty());
    assert!(needs_verify.closed_loop.verification_required);
    assert_eq!(needs_verify.closed_loop.verification_status, "pending");

    let supporting_check = tool_request(
        "workspace_exec",
        serde_json::json!({
            "workspace": "harness",
            "program": "npm",
            "args": ["run", "typecheck"],
            "_harness_run_id": run_id.clone(),
        }),
    );
    harness_tool_pipeline::begin(&state, &Principal::Operator, &supporting_check)
        .await
        .expect("static supporting check may run")
        .finish(&state, true, None)
        .await
        .expect("finish supporting check");
    let after_supporting_check = harness::get(
        &state,
        HarnessRunIdRequest {
            run_id: run_id.clone(),
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("read state after static check");
    assert!(after_supporting_check.closed_loop.verification_required);
    assert!(
        after_supporting_check
            .closed_loop
            .satisfied_proofs
            .is_empty()
    );

    let wrong_proof = tool_request(
        "workspace_exec",
        serde_json::json!({
            "workspace": "harness",
            "program": "cargo",
            "args": ["test", "--test", "smoke"],
            "_harness_run_id": run_id.clone(),
        }),
    );
    harness_tool_pipeline::begin(&state, &Principal::Operator, &wrong_proof)
        .await
        .expect("non-selected integration proof may still run")
        .finish(&state, true, None)
        .await
        .expect("record non-selected integration proof");
    let after_wrong_proof = harness::get(
        &state,
        HarnessRunIdRequest {
            run_id: run_id.clone(),
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("read state after wrong proof");
    assert!(after_wrong_proof.closed_loop.verification_required);
    assert_eq!(after_wrong_proof.closed_loop.phase, "verify");
    assert_eq!(
        after_wrong_proof.closed_loop.satisfied_proofs,
        vec!["integration"]
    );

    let premature_commit = tool_request(
        "git_commit",
        serde_json::json!({
            "workspace": "harness",
            "message": "must verify first",
            "_harness_run_id": run_id.clone(),
        }),
    );
    let publish_gate_error =
        harness_tool_pipeline::begin(&state, &Principal::Operator, &premature_commit)
            .await
            .expect_err("unverified mutation must not reach commit approval");
    assert!(publish_gate_error.to_string().contains("focused-test"));
    assert!(publish_gate_error.to_string().contains("proof"));

    let completion_error = harness::complete(
        &state,
        HarnessRunIdRequest {
            run_id: run_id.clone(),
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect_err("pending verification must block completion");
    assert!(
        completion_error
            .to_string()
            .contains("verification is required")
    );

    let verify = tool_request(
        "workspace_exec",
        serde_json::json!({
            "workspace": "harness",
            "program": "cargo",
            "args": ["test", "closed_loop"],
            "_harness_run_id": run_id.clone(),
        }),
    );
    harness_tool_pipeline::begin(&state, &Principal::Operator, &verify)
        .await
        .expect("start failing verification")
        .finish(&state, false, Some("tool-error"))
        .await
        .expect("record failing verification");
    let recovering = harness::get(
        &state,
        HarnessRunIdRequest {
            run_id: run_id.clone(),
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("read recovery state");
    assert_eq!(recovering.closed_loop.phase, "recover");
    assert_eq!(recovering.closed_loop.recovery_status, "needed");
    assert_eq!(recovering.closed_loop.failure_count, 1);
    assert_eq!(
        recovering.closed_loop.last_failure_tool.as_deref(),
        Some("workspace_exec")
    );
    let recovery_completion_error = harness::complete(
        &state,
        HarnessRunIdRequest {
            run_id: run_id.clone(),
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect_err("unresolved recovery must block completion");
    assert!(
        recovery_completion_error
            .to_string()
            .contains("verification is required")
            || recovery_completion_error
                .to_string()
                .contains("recovery is unresolved")
    );

    let recovery = harness_tool_pipeline::begin(&state, &Principal::Operator, &execute)
        .await
        .expect("start recovery mutation");
    let recovering_in_progress = harness::get(
        &state,
        HarnessRunIdRequest {
            run_id: run_id.clone(),
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("read recovery in progress");
    assert_eq!(recovering_in_progress.closed_loop.phase, "recover");
    assert_eq!(
        recovering_in_progress.closed_loop.recovery_status,
        "in-progress"
    );
    recovery
        .finish(&state, true, None)
        .await
        .expect("finish recovery mutation");

    harness_tool_pipeline::begin(&state, &Principal::Operator, &verify)
        .await
        .expect("start passing verification")
        .finish(&state, true, None)
        .await
        .expect("finish passing verification");
    let learned = harness::get(
        &state,
        HarnessRunIdRequest {
            run_id: run_id.clone(),
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("read learned state");
    assert_eq!(learned.closed_loop.phase, "learn");
    assert!(!learned.closed_loop.verification_required);
    assert_eq!(learned.closed_loop.verification_status, "passed");
    assert_eq!(learned.closed_loop.recovery_status, "recovered");
    assert_eq!(
        learned.closed_loop.selected_proof_type.as_deref(),
        Some("focused-test")
    );
    assert!(
        learned
            .closed_loop
            .satisfied_proofs
            .contains(&"focused-test".to_string())
    );
    assert!(
        learned
            .closed_loop
            .satisfied_proofs
            .contains(&"integration".to_string())
    );
    assert_eq!(learned.closed_loop.learning_count, 1);
    assert_eq!(learned.closed_loop.learning_hints.len(), 1);
    assert_eq!(learned.closed_loop.learning_hints[0].tool, "workspace_exec");
    assert_eq!(learned.closed_loop.learning_hints[0].failures, 1);
    assert_eq!(learned.closed_loop.learning_hints[0].recoveries, 1);
    assert_eq!(learned.closed_loop.learning_hints[0].confirmations, 0);
    assert_eq!(learned.closed_loop.learning_hints[0].state, "candidate");
    let completed = harness::complete(
        &state,
        HarnessRunIdRequest {
            run_id: run_id.clone(),
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("verified learned run can complete");
    assert_eq!(completed.run.status, "completed");

    let next = harness::begin(
        &state,
        begin_request("harness:closed-loop-next"),
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("begin next run with learned workspace hints");
    assert_eq!(next.snapshot.closed_loop.phase, "context");
    assert_eq!(next.snapshot.closed_loop.learning_hints.len(), 1);
    assert_eq!(next.snapshot.closed_loop.learning_hints[0].recoveries, 1);
    assert_eq!(next.snapshot.closed_loop.learning_hints[0].confirmations, 0);
    assert_eq!(
        next.snapshot.closed_loop.learning_hints[0].state,
        "candidate"
    );
    let next_run_id = next.snapshot.run.id.clone();

    let next_context = tool_request(
        "workspace_file_fetch",
        serde_json::json!({
            "workspace": "harness",
            "path": "src/lib.rs",
            "_harness_run_id": next_run_id.clone(),
        }),
    );
    harness_tool_pipeline::begin(&state, &Principal::Operator, &next_context)
        .await
        .expect("fresh run context read")
        .finish(&state, true, None)
        .await
        .expect("finish fresh run context read");

    let exercise = tool_request(
        "workspace_exec",
        serde_json::json!({
            "workspace": "harness",
            "program": "python3",
            "args": ["-c", "print('exercise recovered path')"],
            "_harness_run_id": next_run_id.clone(),
        }),
    );
    harness_tool_pipeline::begin(&state, &Principal::Operator, &exercise)
        .await
        .expect("fresh run exercises learned tool")
        .finish(&state, true, None)
        .await
        .expect("finish fresh-run exercise");

    let fresh_verify = tool_request(
        "workspace_exec",
        serde_json::json!({
            "workspace": "harness",
            "program": "cargo",
            "args": ["test", "closed_loop"],
            "_harness_run_id": next_run_id.clone(),
        }),
    );
    harness_tool_pipeline::begin(&state, &Principal::Operator, &fresh_verify)
        .await
        .expect("fresh run verification")
        .finish(&state, true, None)
        .await
        .expect("fresh run verification passes");

    let confirmed = harness::get(
        &state,
        HarnessRunIdRequest {
            run_id: next_run_id,
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("read fresh-run-confirmed learning");
    assert_eq!(confirmed.closed_loop.learning_hints[0].confirmations, 1);
    assert_eq!(
        confirmed.closed_loop.learning_hints[0].state,
        "fresh-run-validated"
    );
}

#[tokio::test]
async fn tool_pipeline_stops_ask_and_deny_before_dispatch() {
    let (_root, _repo, _state_dir, state) = fixture().await;
    let ask_run = harness::begin(
        &state,
        begin_request("harness:pipeline-ask"),
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("begin interactive run");
    observe_context(&state, &ask_run.snapshot.run.id).await;
    let ask = tool_request(
        "git_commit",
        serde_json::json!({
            "workspace": "harness",
            "message": "guarded",
            "_harness_run_id": ask_run.snapshot.run.id,
        }),
    );
    let ask_error = harness_tool_pipeline::begin(&state, &Principal::Operator, &ask)
        .await
        .expect_err("interactive Git mutation must require approval");
    assert!(ask_error.to_string().contains("approval required"));
    let ask_row: (String, String, i64) = sqlx::query_as(
        "SELECT policy_decision, result_category, dispatched FROM harness_tool_executions \
         WHERE run_id=?1 AND tool_name='git_commit' ORDER BY started_at DESC, id DESC LIMIT 1",
    )
    .bind(&ask_run.snapshot.run.id)
    .fetch_one(&state.db)
    .await
    .expect("read ask execution");
    assert_eq!(ask_row, ("ask".into(), "approval-required".into(), 0));
    let pending = harness_approval::list(
        &state,
        harness_approval::HarnessApprovalListRequest {
            run_id: ask_run.snapshot.run.id.clone(),
            status: Some("pending".into()),
            limit: 10,
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("list pending approval");
    assert_eq!(pending.approvals.len(), 1);
    assert_eq!(pending.approvals[0].tool, "git_commit");

    let deny_run = harness::begin(
        &state,
        begin_request_with_profile("harness:pipeline-deny", "read-only-analysis"),
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("begin read-only run");
    observe_context(&state, &deny_run.snapshot.run.id).await;
    let deny = tool_request(
        "workspace_file_write",
        serde_json::json!({
            "workspace": "harness",
            "path": "src/lib.rs",
            "content": "denied",
            "_harness_run_id": deny_run.snapshot.run.id,
        }),
    );
    let deny_error = harness_tool_pipeline::begin(&state, &Principal::Operator, &deny)
        .await
        .expect_err("read-only profile must deny workspace write");
    assert!(
        deny_error
            .to_string()
            .contains("harness policy denied capability")
    );
    let deny_row: (String, String, i64) = sqlx::query_as(
        "SELECT policy_decision, result_category, dispatched FROM harness_tool_executions \
         WHERE run_id=?1 AND tool_name='workspace_file_write' ORDER BY started_at DESC, id DESC LIMIT 1",
    )
    .bind(&deny_run.snapshot.run.id)
    .fetch_one(&state.db)
    .await
    .expect("read denied execution");
    assert_eq!(deny_row, ("deny".into(), "denied".into(), 0));
}

#[tokio::test]
async fn approval_is_exact_one_shot_and_changed_arguments_need_new_request() {
    let (_root, _repo, _state_dir, state) = fixture().await;
    let begun = harness::begin(
        &state,
        begin_request("harness:approval-one-shot"),
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("begin approval run");
    observe_context(&state, &begun.snapshot.run.id).await;
    let request = tool_request(
        "git_commit",
        serde_json::json!({
            "workspace": "harness",
            "message": "approved once",
            "_harness_run_id": begun.snapshot.run.id,
        }),
    );

    harness_tool_pipeline::begin(&state, &Principal::Operator, &request)
        .await
        .expect_err("first ask must create approval");
    let pending = harness_approval::list(
        &state,
        harness_approval::HarnessApprovalListRequest {
            run_id: begun.snapshot.run.id.clone(),
            status: Some("pending".into()),
            limit: 10,
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("list first approval");
    assert_eq!(pending.approvals.len(), 1);
    let first = pending.approvals[0].clone();

    let resolved = harness_approval::respond(
        &state,
        harness_approval::HarnessApprovalRespondRequest {
            approval_id: first.id.clone(),
            decision: "allow".into(),
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("allow exact approval");
    assert_eq!(resolved.approval.status, "allowed");
    assert!(!resolved.replayed);

    let ticket = harness_tool_pipeline::begin(&state, &Principal::Operator, &request)
        .await
        .expect("exact approved call may dispatch once");
    let approval_id: Option<String> =
        sqlx::query_scalar("SELECT approval_id FROM harness_tool_executions WHERE id=?1")
            .bind(&ticket.id)
            .fetch_one(&state.db)
            .await
            .expect("read consumed approval link");
    assert_eq!(approval_id.as_deref(), Some(first.id.as_str()));
    ticket
        .finish(&state, true, None)
        .await
        .expect("finish approved execution");
    let consumed: String = sqlx::query_scalar("SELECT status FROM harness_approvals WHERE id=?1")
        .bind(&first.id)
        .fetch_one(&state.db)
        .await
        .expect("read consumed approval");
    assert_eq!(consumed, "consumed");

    harness_tool_pipeline::begin(&state, &Principal::Operator, &request)
        .await
        .expect_err("one-shot approval cannot dispatch twice");
    let second = harness_approval::list(
        &state,
        harness_approval::HarnessApprovalListRequest {
            run_id: begun.snapshot.run.id.clone(),
            status: Some("pending".into()),
            limit: 10,
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("list second pending approval");
    assert_eq!(second.approvals.len(), 1);
    assert_ne!(second.approvals[0].id, first.id);
    assert_eq!(second.approvals[0].argument_sha256, first.argument_sha256);

    let changed = tool_request(
        "git_commit",
        serde_json::json!({
            "workspace": "harness",
            "message": "different arguments",
            "_harness_run_id": begun.snapshot.run.id,
        }),
    );
    harness_tool_pipeline::begin(&state, &Principal::Operator, &changed)
        .await
        .expect_err("changed arguments require another approval");
    let all_pending = harness_approval::list(
        &state,
        harness_approval::HarnessApprovalListRequest {
            run_id: begun.snapshot.run.id.clone(),
            status: Some("pending".into()),
            limit: 10,
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("list changed-argument approvals");
    assert_eq!(all_pending.approvals.len(), 2);
    assert!(
        all_pending
            .approvals
            .iter()
            .any(|approval| approval.argument_sha256 != first.argument_sha256)
    );

    let events = harness::events(
        &state,
        HarnessRunEventsRequest {
            run_id: begun.snapshot.run.id,
            after_seq: Some(0),
            limit: 100,
        },
        harness::operator_principal_key(),
        true,
    )
    .await
    .expect("read approval timeline");
    let event_types = events
        .events
        .iter()
        .map(|event| event.event_type.as_str())
        .collect::<Vec<_>>();
    assert!(event_types.contains(&"approval/requested"));
    assert!(event_types.contains(&"approval/resolved"));
    assert!(event_types.contains(&"tool/approved"));
}

#[tokio::test]
async fn recovery_checkpoint_is_restart_safe_and_deduplicates_pending_approval() {
    let (_root, repo, state_dir, state) = fixture().await;
    let principal = harness::operator_principal_key();
    let begun = harness::begin(
        &state,
        begin_request("harness:recovery-approval"),
        principal,
        true,
    )
    .await
    .expect("begin recovery approval run");
    observe_context(&state, &begun.snapshot.run.id).await;
    let marker = "RECOVERY_RAW_ARGUMENT_MUST_NOT_PERSIST";
    let request = tool_request(
        "git_commit",
        serde_json::json!({
            "workspace": "harness",
            "message": marker,
            "_harness_run_id": begun.snapshot.run.id,
        }),
    );
    harness_tool_pipeline::begin(&state, &Principal::Operator, &request)
        .await
        .expect_err("Git mutation must request approval");

    let first = harness::checkpoint(
        &state,
        HarnessRunIdRequest {
            run_id: begun.snapshot.run.id.clone(),
        },
        principal,
        true,
    )
    .await
    .expect("materialize recovery checkpoint");
    assert_eq!(first.recovery.state, "requires-review");
    assert_eq!(first.recovery.reason, "approval_pending");
    assert_eq!(first.recovery.pending_approvals, 1);
    let checkpoint = first
        .recovery
        .checkpoint
        .clone()
        .expect("checkpoint persisted");

    let facts_json: String =
        sqlx::query_scalar("SELECT facts_json FROM harness_checkpoints WHERE id=?1")
            .bind(&checkpoint.id)
            .fetch_one(&state.db)
            .await
            .expect("read checkpoint facts");
    assert!(!facts_json.contains(marker));
    let event_payload: String = sqlx::query_scalar(
        "SELECT payload_json FROM harness_events \
         WHERE run_id=?1 AND event_type='checkpoint/created' ORDER BY seq DESC LIMIT 1",
    )
    .bind(&begun.snapshot.run.id)
    .fetch_one(&state.db)
    .await
    .expect("read checkpoint event");
    assert!(!event_payload.contains(marker));

    drop(state);
    let restarted = build_state(&repo, &state_dir).await;
    let restored = harness::checkpoint(
        &restarted,
        HarnessRunIdRequest {
            run_id: begun.snapshot.run.id.clone(),
        },
        principal,
        true,
    )
    .await
    .expect("reconstruct recovery checkpoint after restart");
    assert_eq!(restored.recovery.state, "requires-review");
    assert_eq!(restored.recovery.reason, "approval_pending");
    assert_eq!(
        restored
            .recovery
            .checkpoint
            .as_ref()
            .expect("checkpoint after restart")
            .id,
        checkpoint.id
    );
    let checkpoint_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM harness_checkpoints WHERE run_id=?1")
            .bind(&begun.snapshot.run.id)
            .fetch_one(&restarted.db)
            .await
            .expect("count checkpoints");
    assert_eq!(checkpoint_count, 1);
    let checkpoint_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM harness_events WHERE run_id=?1 AND event_type='checkpoint/created'",
    )
    .bind(&begun.snapshot.run.id)
    .fetch_one(&restarted.db)
    .await
    .expect("count checkpoint events");
    assert_eq!(checkpoint_events, 1);
}

#[tokio::test]
async fn recovery_requires_review_for_uncertain_mutation_but_allows_safe_read_retry() {
    let (_root, repo, state_dir, state) = fixture().await;
    let principal = harness::operator_principal_key();

    let mutating_run = harness::begin(
        &state,
        begin_request("harness:recovery-mutation"),
        principal,
        true,
    )
    .await
    .expect("begin mutating recovery run");
    observe_context(&state, &mutating_run.snapshot.run.id).await;
    let mutation = tool_request(
        "workspace_file_write",
        serde_json::json!({
            "workspace": "harness",
            "path": "src/recovery.txt",
            "content": "not actually dispatched by this fixture",
            "_harness_run_id": mutating_run.snapshot.run.id,
        }),
    );
    let ticket = harness_tool_pipeline::begin(&state, &Principal::Operator, &mutation)
        .await
        .expect("authorize workspace mutation");
    drop(ticket);
    drop(state);

    let restarted = build_state(&repo, &state_dir).await;
    let uncertain = harness::checkpoint(
        &restarted,
        HarnessRunIdRequest {
            run_id: mutating_run.snapshot.run.id.clone(),
        },
        principal,
        true,
    )
    .await
    .expect("reconstruct uncertain mutation");
    assert_eq!(uncertain.recovery.state, "requires-review");
    assert_eq!(
        uncertain.recovery.reason,
        "post_dispatch_mutation_uncertain"
    );
    assert_eq!(uncertain.recovery.uncertain_mutations, 1);
    assert!(!repo.join("src/recovery.txt").exists());

    let read_run = harness::begin(
        &restarted,
        begin_request("harness:recovery-read"),
        principal,
        true,
    )
    .await
    .expect("begin read recovery run");
    let read = tool_request(
        "workspace_file_fetch",
        serde_json::json!({
            "workspace": "harness",
            "path": "src/lib.rs",
            "_harness_run_id": read_run.snapshot.run.id,
        }),
    );
    let read_ticket = harness_tool_pipeline::begin(&restarted, &Principal::Operator, &read)
        .await
        .expect("authorize read execution");
    drop(read_ticket);

    let retryable = harness::checkpoint(
        &restarted,
        HarnessRunIdRequest {
            run_id: read_run.snapshot.run.id,
        },
        principal,
        true,
    )
    .await
    .expect("classify retryable read");
    assert_eq!(retryable.recovery.state, "resumable");
    assert_eq!(retryable.recovery.reason, "safe_retry_available");
    assert_eq!(retryable.recovery.retryable_read_executions, 1);
    assert_eq!(retryable.recovery.uncertain_mutations, 0);
}
