use std::{path::Path, process::Command, sync::Arc};

use tempfile::TempDir;
use tokio::sync::Mutex;

use crate::{
    config::WorkspaceConfig,
    db,
    graph::{self, SymbolKeyRequest, SymbolSearchRequest, TraceRequest},
    index, memory,
    service::AppState,
    workspace::{Workspace, WorkspaceRegistry},
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

fn write_file(root: &Path, path: &str, content: &str) {
    let full = root.join(path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).expect("create fixture directory");
    }
    std::fs::write(full, content).expect("write fixture source");
}

async fn fixture(id: &str, files: &[(&str, &str)]) -> (TempDir, TempDir, AppState) {
    let repo = tempfile::tempdir().expect("repo tempdir");
    run_git(repo.path(), &["init", "-b", "main"]);
    run_git(repo.path(), &["config", "user.name", "SourceNerve Test"]);
    run_git(
        repo.path(),
        &["config", "user.email", "sourcenerve@example.invalid"],
    );
    for (path, content) in files {
        write_file(repo.path(), path, content);
    }
    commit_all(repo.path(), "graph baseline fixture");

    let registry = WorkspaceRegistry::build(&[WorkspaceConfig {
        id: id.into(),
        name: format!("{id} Fixture"),
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
    memory::index_workspace(&state, id)
        .await
        .expect("index workspace");
    (repo, state_dir, state)
}

async fn edge_count(
    state: &AppState,
    workspace: &str,
    edge_type: &str,
    source_qualified_name: &str,
    target_qualified_name: &str,
) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM edges e \
         JOIN symbols source ON source.id=e.source_symbol_id \
         JOIN symbols target ON target.id=e.target_symbol_id \
         WHERE e.workspace_id=?1 AND e.edge_type=?2 \
           AND source.qualified_name=?3 AND target.qualified_name=?4",
    )
    .bind(workspace)
    .bind(edge_type)
    .bind(source_qualified_name)
    .bind(target_qualified_name)
    .fetch_one(&state.db)
    .await
    .expect("count edge")
}

async fn symbol_key(state: &AppState, workspace: &str, qualified_name: &str) -> String {
    sqlx::query_scalar("SELECT symbol_key FROM symbols WHERE workspace_id=?1 AND qualified_name=?2")
        .bind(workspace)
        .bind(qualified_name)
        .fetch_one(&state.db)
        .await
        .expect("symbol key")
}

async fn graph_snapshot(state: &AppState, workspace: &str) -> Vec<(String, String, String)> {
    sqlx::query_as(
        "SELECT source.qualified_name, e.edge_type, target.qualified_name \
         FROM edges e \
         JOIN symbols source ON source.id=e.source_symbol_id \
         JOIN symbols target ON target.id=e.target_symbol_id \
         WHERE e.workspace_id=?1 AND e.source!='scip' \
         ORDER BY source.qualified_name, e.edge_type, target.qualified_name",
    )
    .bind(workspace)
    .fetch_all(&state.db)
    .await
    .expect("graph snapshot")
}

#[tokio::test]
async fn import_scope_resolves_calls_and_references_without_global_same_name_guessing() {
    let files = [
        (
            "ts/a.ts",
            "export class SharedType {}\nexport function shared(): string { return 'a'; }\n",
        ),
        (
            "ts/b.ts",
            "export class SharedType {}\nexport function shared(): string { return 'b'; }\n",
        ),
        (
            "ts/caller.ts",
            "import { SharedType, shared } from './a';\nexport function run(input: SharedType): string { return shared(); }\n",
        ),
        ("py/a.py", "def shared():\n    return 'a'\n"),
        ("py/b.py", "def shared():\n    return 'b'\n"),
        (
            "py/caller.py",
            "from .a import shared\n\ndef run():\n    return shared()\n",
        ),
        ("rustproj/src/a.rs", "pub fn shared() -> i32 { 1 }\n"),
        ("rustproj/src/b.rs", "pub fn shared() -> i32 { 2 }\n"),
        (
            "rustproj/src/caller.rs",
            "use crate::a::shared;\npub fn run() -> i32 { shared() }\n",
        ),
    ];
    let (_repo, _state_dir, state) = fixture("scope", &files).await;

    assert_eq!(
        edge_count(
            &state,
            "scope",
            "CALLS",
            "ts/caller.ts::run",
            "ts/a.ts::shared",
        )
        .await,
        1
    );
    assert_eq!(
        edge_count(
            &state,
            "scope",
            "CALLS",
            "ts/caller.ts::run",
            "ts/b.ts::shared",
        )
        .await,
        0
    );
    assert_eq!(
        edge_count(
            &state,
            "scope",
            "REFERENCES",
            "ts/caller.ts::run",
            "ts/a.ts::SharedType",
        )
        .await,
        1
    );
    assert_eq!(
        edge_count(
            &state,
            "scope",
            "REFERENCES",
            "ts/caller.ts::run",
            "ts/b.ts::SharedType",
        )
        .await,
        0
    );
    assert_eq!(
        edge_count(
            &state,
            "scope",
            "CALLS",
            "py/caller.py::run",
            "py/a.py::shared",
        )
        .await,
        1
    );
    assert_eq!(
        edge_count(
            &state,
            "scope",
            "CALLS",
            "py/caller.py::run",
            "py/b.py::shared",
        )
        .await,
        0
    );
    assert_eq!(
        edge_count(
            &state,
            "scope",
            "CALLS",
            "rustproj/src/caller.rs::run",
            "rustproj/src/a.rs::shared",
        )
        .await,
        1
    );
    assert_eq!(
        edge_count(
            &state,
            "scope",
            "CALLS",
            "rustproj/src/caller.rs::run",
            "rustproj/src/b.rs::shared",
        )
        .await,
        0
    );
}

#[tokio::test]
async fn ambiguous_import_scopes_remain_unresolved() {
    let files = [
        (
            "src/a.ts",
            "export function shared(): number { return 1; }\n",
        ),
        (
            "src/b.ts",
            "export function shared(): number { return 2; }\n",
        ),
        (
            "src/caller.ts",
            "import { shared as aShared } from './a';\nimport { shared as bShared } from './b';\nexport function run(): number { return shared(); }\n",
        ),
    ];
    let (_repo, _state_dir, state) = fixture("ambiguous", &files).await;

    let resolved: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM symbol_references r \
         JOIN symbols source ON source.id=r.source_symbol_id \
         WHERE r.workspace_id='ambiguous' AND source.qualified_name='src/caller.ts::run' \
           AND r.name='shared' AND r.target_symbol_id IS NOT NULL",
    )
    .fetch_one(&state.db)
    .await
    .expect("resolved reference count");
    assert_eq!(
        resolved, 0,
        "ambiguous imported target must remain unresolved"
    );
}

#[tokio::test]
async fn target_rename_invalidates_reverse_calls_and_caller_refresh_restores_rebuild_equivalence() {
    let files = [
        (
            "src/a.ts",
            "export function shared(): number { return 1; }\n",
        ),
        (
            "src/caller.ts",
            "import { shared } from './a';\nexport function run(): number { return shared(); }\n",
        ),
    ];
    let (repo, _state_dir, state) = fixture("incremental-calls", &files).await;
    let workspace: Workspace = state
        .workspaces
        .get("incremental-calls")
        .expect("workspace");

    assert_eq!(
        edge_count(
            &state,
            "incremental-calls",
            "CALLS",
            "src/caller.ts::run",
            "src/a.ts::shared",
        )
        .await,
        1
    );

    write_file(
        repo.path(),
        "src/a.ts",
        "export function renamed(): number { return 2; }\n",
    );
    index::sync_paths(&state.db, &workspace, &["src/a.ts".into()])
        .await
        .expect("sync renamed target");
    assert_eq!(
        edge_count(
            &state,
            "incremental-calls",
            "CALLS",
            "src/caller.ts::run",
            "src/a.ts::renamed",
        )
        .await,
        0,
        "old call name must not silently retarget after target rename"
    );

    write_file(
        repo.path(),
        "src/caller.ts",
        "import { renamed } from './a';\nexport function run(): number { return renamed(); }\n",
    );
    index::sync_paths(&state.db, &workspace, &["src/caller.ts".into()])
        .await
        .expect("sync caller rename");
    assert_eq!(
        edge_count(
            &state,
            "incremental-calls",
            "CALLS",
            "src/caller.ts::run",
            "src/a.ts::renamed",
        )
        .await,
        1
    );

    let incremental = graph_snapshot(&state, "incremental-calls").await;
    commit_all(repo.path(), "final call rename");

    let registry = WorkspaceRegistry::build(&[WorkspaceConfig {
        id: "rebuild-calls".into(),
        name: "Rebuild Calls".into(),
        root: repo.path().to_path_buf(),
        access: "read-write".into(),
        remote: "origin".into(),
        default_branch: "main".into(),
        github_repository: None,
    }])
    .expect("build rebuild registry");
    let rebuild_state_dir = tempfile::tempdir().expect("rebuild state");
    let rebuild_pool = db::connect(rebuild_state_dir.path())
        .await
        .expect("connect rebuild db");
    db::register_workspaces(&rebuild_pool, &registry)
        .await
        .expect("register rebuild workspace");
    let rebuild_state = AppState {
        workspaces: registry,
        db: rebuild_pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: None,
    };
    memory::index_workspace(&rebuild_state, "rebuild-calls")
        .await
        .expect("clean rebuild");
    let rebuilt = graph_snapshot(&rebuild_state, "rebuild-calls").await;
    assert_eq!(
        incremental, rebuilt,
        "incremental calls must equal clean rebuild"
    );
}

#[tokio::test]
async fn graph_query_surfaces_expose_scoped_edges_without_host_paths() {
    let files = [
        (
            "src/a.ts",
            "export function shared(): number { return 1; }\n",
        ),
        (
            "src/b.ts",
            "export function shared(): number { return 2; }\n",
        ),
        (
            "src/caller.ts",
            "import { shared } from './a';\nexport function run(): number { return shared(); }\n",
        ),
    ];
    let (repo, _state_dir, state) = fixture("queries", &files).await;
    let target = symbol_key(&state, "queries", "src/a.ts::shared").await;
    let caller = symbol_key(&state, "queries", "src/caller.ts::run").await;

    let search = graph::search_symbols(
        &state,
        SymbolSearchRequest {
            workspace: "queries".into(),
            query: "shared".into(),
            kind: None,
            limit: 20,
        },
    )
    .await
    .expect("symbol search");
    assert_eq!(search.symbols.len(), 2);
    assert!(
        search
            .symbols
            .iter()
            .all(|symbol| !symbol.path.starts_with('/'))
    );
    assert!(search.symbols.iter().all(|symbol| {
        !symbol
            .path
            .contains(&repo.path().to_string_lossy().to_string())
    }));

    let callers = graph::trace_callers(
        &state,
        TraceRequest {
            workspace: "queries".into(),
            symbol_key: target.clone(),
            depth: 1,
        },
    )
    .await
    .expect("trace callers");
    assert!(callers.nodes.iter().any(|node| {
        node.symbol.symbol_key == caller && node.via == "CALLS" && node.source == "resolver"
    }));

    let callees = graph::trace_callees(
        &state,
        TraceRequest {
            workspace: "queries".into(),
            symbol_key: caller.clone(),
            depth: 1,
        },
    )
    .await
    .expect("trace callees");
    assert!(
        callees
            .nodes
            .iter()
            .any(|node| node.symbol.symbol_key == target && node.via == "CALLS")
    );

    let context = graph::symbol_context(
        &state,
        SymbolKeyRequest {
            workspace: "queries".into(),
            symbol_key: caller,
        },
    )
    .await
    .expect("symbol context");
    assert!(
        context
            .outgoing
            .iter()
            .any(|edge| edge.edge_type == "CALLS" && edge.symbol.symbol_key == target)
    );

    let impact = graph::impact_analysis(
        &state,
        TraceRequest {
            workspace: "queries".into(),
            symbol_key: target,
            depth: 1,
        },
    )
    .await
    .expect("impact analysis");
    assert!(impact.nodes.iter().any(|node| node.via == "CALLS"));

    let status = graph::status(&state, "queries")
        .await
        .expect("graph status");
    assert_eq!(status.failed_files, 0);
    assert!(status.parsed_files >= 3);
}

#[tokio::test]
async fn semantic_parse_failure_preserves_prior_structural_import_state() {
    let files = [
        ("src/base.ts", "export class Base {}\n"),
        (
            "src/child.ts",
            "import { Base } from './base';\nexport class Child extends Base {}\n",
        ),
    ];
    let (repo, _state_dir, state) = fixture("parse-preserve", &files).await;
    let workspace = state.workspaces.get("parse-preserve").expect("workspace");

    assert_eq!(
        edge_count(
            &state,
            "parse-preserve",
            "IMPORTS",
            "src/child.ts",
            "src/base.ts",
        )
        .await,
        1
    );

    write_file(
        repo.path(),
        "src/child.ts",
        "import { Base } from './base';\nexport class Child extends Base {\n",
    );
    index::sync_paths(&state.db, &workspace, &["src/child.ts".into()])
        .await
        .expect("partial parser sync");

    let structural_rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM structural_references r \
         JOIN files f ON f.id=r.source_file_id \
         WHERE r.workspace_id='parse-preserve' AND f.path='src/child.ts' AND r.relation_type='IMPORTS'",
    )
    .fetch_one(&state.db)
    .await
    .expect("structural references");
    assert_eq!(
        structural_rows, 1,
        "semantic parse failure must preserve previously committed structural references"
    );
}
