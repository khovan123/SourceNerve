use std::{path::Path, process::Command, sync::Arc};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use protobuf::Message;
use scip::types::{Document, Index, Occurrence, SymbolRole};
use tempfile::TempDir;
use tokio::sync::Mutex;

use crate::{
    config::WorkspaceConfig,
    db, git, memory,
    scip_enrichment::{self, ScipImportRequest},
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

fn commit_all(root: &Path, message: &str) {
    run_git(root, &["add", "-A"]);
    run_git(root, &["commit", "-m", message]);
}

async fn fixture() -> (TempDir, TempDir, AppState) {
    let repo = tempfile::tempdir().expect("repo tempdir");
    run_git(repo.path(), &["init", "-b", "main"]);
    run_git(repo.path(), &["config", "user.name", "SourceNerve Test"]);
    run_git(
        repo.path(),
        &["config", "user.email", "sourcenerve@example.invalid"],
    );
    std::fs::create_dir_all(repo.path().join("src")).expect("create src");
    std::fs::write(
        repo.path().join("src/lib.rs"),
        "fn target() {}\nfn caller() { target(); }\n",
    )
    .expect("write source");
    commit_all(repo.path(), "initial fixture");

    let registry = WorkspaceRegistry::build(&[WorkspaceConfig {
        id: "scip".into(),
        name: "SCIP Fixture".into(),
        root: repo.path().to_path_buf(),
        access: "read-write".into(),
        remote: "origin".into(),
        default_branch: "main".into(),
        github_repository: None,
    }])
    .expect("build registry");

    let state_dir = tempfile::tempdir().expect("state tempdir");
    let pool = db::connect(state_dir.path()).await.expect("connect db");
    db::register_workspaces(&pool, &registry)
        .await
        .expect("register workspace");
    let state = AppState {
        workspaces: registry,
        db: pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: None,
    };
    memory::index_workspace(&state, "scip")
        .await
        .expect("initial deterministic index");
    (repo, state_dir, state)
}

fn occurrence(symbol: &str, line: i32, roles: i32) -> Occurrence {
    let mut occurrence = Occurrence::new();
    occurrence.symbol = symbol.into();
    occurrence.symbol_roles = roles;
    occurrence.range = vec![line, 0, 1];
    occurrence
}

fn index_bytes(relative_path: &str) -> Vec<u8> {
    let mut document = Document::new();
    document.relative_path = relative_path.into();
    document.occurrences = vec![
        occurrence("local target", 0, SymbolRole::Definition as i32),
        occurrence("local caller", 1, SymbolRole::Definition as i32),
        occurrence("local target", 1, 0),
    ];

    let mut index = Index::new();
    index.documents.push(document);
    index.write_to_bytes().expect("serialize SCIP index")
}

async fn graph_version(state: &AppState) -> i64 {
    sqlx::query_scalar("SELECT graph_version FROM workspaces WHERE id='scip'")
        .fetch_one(&state.db)
        .await
        .expect("graph version")
}

async fn scip_edge_count(state: &AppState) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM edges WHERE workspace_id='scip' AND source LIKE 'scip:%'")
        .fetch_one(&state.db)
        .await
        .expect("SCIP edge count")
}

async fn deterministic_edge_count(state: &AppState) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM edges WHERE workspace_id='scip' AND source NOT LIKE 'scip:%'")
        .fetch_one(&state.db)
        .await
        .expect("deterministic edge count")
}

#[tokio::test]
async fn imports_provenance_preserves_previous_run_and_invalidates_on_head_drift() {
    let (repo, _state_dir, state) = fixture().await;
    let head = git::head(repo.path()).await.expect("head");
    let version = graph_version(&state).await;
    let deterministic_before = deterministic_edge_count(&state).await;

    let imported = scip_enrichment::import(
        &state,
        ScipImportRequest {
            workspace: "scip".into(),
            expected_head: head.clone(),
            expected_graph_version: version,
            index_base64: STANDARD.encode(index_bytes("src/lib.rs")),
        },
    )
    .await
    .expect("import SCIP");

    assert!(imported.run.active);
    assert_eq!(imported.run.git_head.as_deref(), Some(head.as_str()));
    assert_eq!(imported.run.graph_version, Some(version));
    assert!(imported.run.mapped_symbols >= 2);
    assert!(imported.run.materialized_edges >= 1);
    assert!(scip_edge_count(&state).await >= 1);
    assert_eq!(deterministic_edge_count(&state).await, deterministic_before);

    let active_run = imported.run.run_id.clone();
    let invalid = scip_enrichment::import(
        &state,
        ScipImportRequest {
            workspace: "scip".into(),
            expected_head: head.clone(),
            expected_graph_version: version,
            index_base64: "not-base64***".into(),
        },
    )
    .await;
    assert!(invalid.is_err());
    assert_eq!(
        scip_enrichment::status(&state, "scip").await.unwrap().run_id,
        active_run,
        "failed decode must preserve the prior active run"
    );

    let traversal = scip_enrichment::import(
        &state,
        ScipImportRequest {
            workspace: "scip".into(),
            expected_head: head,
            expected_graph_version: version,
            index_base64: STANDARD.encode(index_bytes("../outside.rs")),
        },
    )
    .await;
    assert!(traversal.is_err());
    assert_eq!(
        scip_enrichment::status(&state, "scip").await.unwrap().run_id,
        active_run,
        "rejected path must not replace the active enrichment"
    );

    std::fs::write(repo.path().join("HEAD_DRIFT.txt"), "drift\n").expect("write drift file");
    commit_all(repo.path(), "external head drift");

    let status = scip_enrichment::status(&state, "scip")
        .await
        .expect("stale status");
    assert!(!status.active, "external HEAD change must stale the run");
    assert_eq!(scip_edge_count(&state).await, 0, "stale SCIP edges must be removed");
    assert_eq!(
        deterministic_edge_count(&state).await,
        deterministic_before,
        "invalidating SCIP must not mutate deterministic graph edges"
    );
}

#[tokio::test]
async fn deterministic_refresh_invalidates_active_scip_run() {
    let (repo, _state_dir, state) = fixture().await;
    let head = git::head(repo.path()).await.expect("head");
    let version = graph_version(&state).await;

    scip_enrichment::import(
        &state,
        ScipImportRequest {
            workspace: "scip".into(),
            expected_head: head,
            expected_graph_version: version,
            index_base64: STANDARD.encode(index_bytes("src/lib.rs")),
        },
    )
    .await
    .expect("import SCIP");
    assert!(scip_edge_count(&state).await >= 1);

    memory::index_workspace(&state, "scip")
        .await
        .expect("deterministic rebuild");
    let status = scip_enrichment::status(&state, "scip")
        .await
        .expect("status after rebuild");
    assert!(!status.active);
    assert_eq!(scip_edge_count(&state).await, 0);
}
