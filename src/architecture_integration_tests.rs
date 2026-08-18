use std::{path::Path, process::Command, sync::Arc};

use tempfile::TempDir;
use tokio::sync::Mutex;

use crate::{
    architecture::{self, ArchitectureMapRequest},
    architecture_context::{self, ArchitectureContextPackRequest},
    config::WorkspaceConfig,
    db, memory,
    semantic_context::{self, SemanticContextPackRequest},
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

async fn fixture() -> (TempDir, TempDir, WorkspaceRegistry, AppState) {
    let repo = tempfile::tempdir().expect("repo tempdir");
    run_git(repo.path(), &["init", "-b", "main"]);
    run_git(repo.path(), &["config", "user.name", "SourceNerve Test"]);
    run_git(
        repo.path(),
        &["config", "user.email", "sourcenerve@example.invalid"],
    );
    std::fs::create_dir_all(repo.path().join("api")).expect("create api");
    std::fs::create_dir_all(repo.path().join("domain")).expect("create domain");
    std::fs::write(
        repo.path().join("api/handler.py"),
        "from domain.service import calculate\n\ndef handler(value):\n    return calculate(value)\n",
    )
    .expect("write handler");
    std::fs::write(
        repo.path().join("domain/service.py"),
        "def calculate(value):\n    return value + 42\n",
    )
    .expect("write service");
    std::fs::write(repo.path().join("README.md"), "# Architecture fixture\n")
        .expect("write readme");
    commit_all(repo.path(), "architecture fixture");

    let registry = WorkspaceRegistry::build(&[WorkspaceConfig {
        id: "architecture".into(),
        name: "Architecture Fixture".into(),
        root: repo.path().to_path_buf(),
        access: "read-write".into(),
        remote: "origin".into(),
        default_branch: "main".into(),
        provider: None,
        repository: None,
        github_repository: None,
    }])
    .expect("build registry");

    let state_dir = tempfile::tempdir().expect("state tempdir");
    let pool = db::connect(state_dir.path()).await.expect("connect db");
    db::register_workspaces(&pool, &registry)
        .await
        .expect("register workspace");
    let state = AppState {
        workspaces: registry.clone(),
        db: pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: None,
    };
    memory::index_workspace(&state, "architecture")
        .await
        .expect("index workspace");

    let handler_id: i64 = sqlx::query_scalar(
        "SELECT id FROM symbols WHERE workspace_id='architecture' AND name='handler' ORDER BY id LIMIT 1",
    )
    .fetch_one(&state.db)
    .await
    .expect("handler symbol");
    let calculate_id: i64 = sqlx::query_scalar(
        "SELECT id FROM symbols WHERE workspace_id='architecture' AND name='calculate' ORDER BY id LIMIT 1",
    )
    .fetch_one(&state.db)
    .await
    .expect("calculate symbol");
    sqlx::query(
        "INSERT OR IGNORE INTO edges(workspace_id, source_symbol_id, target_symbol_id, edge_type, confidence, source) \
         VALUES('architecture', ?1, ?2, 'CALLS', 1.0, 'fixture')",
    )
    .bind(handler_id)
    .bind(calculate_id)
    .execute(&state.db)
    .await
    .expect("insert fixture edge");

    (repo, state_dir, registry, state)
}

#[tokio::test]
async fn architecture_snapshot_is_deterministic_replay_safe_and_restart_persistent() {
    let (_repo, state_dir, registry, state) = fixture().await;
    let first = architecture::rebuild(&state, "architecture")
        .await
        .expect("first architecture rebuild");
    assert!(!first.replayed);
    assert!(first.cluster_count >= 3);

    let map = architecture::map(
        &state,
        ArchitectureMapRequest {
            workspace: "architecture".into(),
            limit: 20,
        },
    )
    .await
    .expect("architecture map");
    assert_eq!(
        map.snapshot
            .as_ref()
            .map(|snapshot| snapshot.snapshot_hash.as_str()),
        Some(first.snapshot.snapshot_hash.as_str())
    );
    let api = map
        .clusters
        .iter()
        .find(|cluster| cluster.cluster_key == "api")
        .expect("api cluster");
    let domain = map
        .clusters
        .iter()
        .find(|cluster| cluster.cluster_key == "domain")
        .expect("domain cluster");
    assert!(api.outbound.iter().any(|dependency| {
        dependency.cluster_key == "domain"
            && dependency.edge_count >= 1
            && dependency
                .edge_types
                .iter()
                .any(|edge_type| edge_type == "CALLS")
    }));
    assert!(
        domain
            .inbound
            .iter()
            .any(|dependency| dependency.cluster_key == "api")
    );

    let replay = architecture::rebuild(&state, "architecture")
        .await
        .expect("replayed architecture rebuild");
    assert!(replay.replayed);
    assert_eq!(replay.snapshot.id, first.snapshot.id);
    assert_eq!(replay.snapshot.snapshot_hash, first.snapshot.snapshot_hash);

    drop(state);
    let pool = db::connect(state_dir.path())
        .await
        .expect("reconnect state");
    let restarted = AppState {
        workspaces: registry,
        db: pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: None,
    };
    let after_restart = architecture::map(
        &restarted,
        ArchitectureMapRequest {
            workspace: "architecture".into(),
            limit: 20,
        },
    )
    .await
    .expect("map after restart");
    assert_eq!(
        after_restart
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.snapshot_hash.as_str()),
        Some(first.snapshot.snapshot_hash.as_str())
    );
}

#[tokio::test]
async fn cluster_seed_adds_architecture_reason_and_no_seed_preserves_semantic_baseline() {
    let (_repo, _state_dir, _registry, state) = fixture().await;
    architecture::rebuild(&state, "architecture")
        .await
        .expect("architecture rebuild");

    let baseline = semantic_context::pack(
        &state,
        SemanticContextPackRequest {
            workspace: "architecture".into(),
            query: "handler".into(),
            seed_symbol_keys: Vec::new(),
            max_bytes: 4096,
            max_items: 10,
            require_clean: true,
            query_vector: None,
            provider_semantic: false,
        },
    )
    .await
    .expect("semantic baseline");
    let wrapped = architecture_context::pack(
        &state,
        ArchitectureContextPackRequest {
            workspace: "architecture".into(),
            query: "handler".into(),
            seed_symbol_keys: Vec::new(),
            seed_cluster_keys: Vec::new(),
            max_bytes: 4096,
            max_items: 10,
            require_clean: true,
            query_vector: None,
            provider_semantic: false,
        },
    )
    .await
    .expect("architecture wrapper baseline");
    assert_eq!(
        serde_json::to_value(&baseline).expect("baseline json"),
        serde_json::to_value(&wrapped).expect("wrapped json")
    );

    let seeded = architecture_context::pack(
        &state,
        ArchitectureContextPackRequest {
            workspace: "architecture".into(),
            query: "handler".into(),
            seed_symbol_keys: Vec::new(),
            seed_cluster_keys: vec!["domain".into()],
            max_bytes: 4096,
            max_items: 10,
            require_clean: true,
            query_vector: None,
            provider_semantic: false,
        },
    )
    .await
    .expect("architecture seeded context");
    assert!(seeded.items.iter().any(|item| {
        item.path == "domain/service.py"
            && item
                .reasons
                .iter()
                .any(|reason| reason.signal == "architecture-cluster")
    }));
    assert!(seeded.used_bytes <= seeded.max_bytes);

    let one_hop = architecture_context::pack(
        &state,
        ArchitectureContextPackRequest {
            workspace: "architecture".into(),
            query: "handler".into(),
            seed_symbol_keys: Vec::new(),
            seed_cluster_keys: vec!["api".into()],
            max_bytes: 4096,
            max_items: 10,
            require_clean: true,
            query_vector: None,
            provider_semantic: false,
        },
    )
    .await
    .expect("one-hop architecture context");
    assert!(one_hop.items.iter().any(|item| {
        item.path == "domain/service.py"
            && item
                .reasons
                .iter()
                .any(|reason| reason.signal == "architecture-cluster")
    }));
}

#[tokio::test]
async fn source_change_and_reindex_make_old_architecture_snapshot_ineligible() {
    let (repo, _state_dir, _registry, state) = fixture().await;
    architecture::rebuild(&state, "architecture")
        .await
        .expect("architecture rebuild");

    std::fs::write(
        repo.path().join("domain/service.py"),
        "def calculate(value):\n    return value + 99\n",
    )
    .expect("update service");
    commit_all(repo.path(), "change domain service");
    memory::index_workspace(&state, "architecture")
        .await
        .expect("reindex workspace");

    let map = architecture::map(
        &state,
        ArchitectureMapRequest {
            workspace: "architecture".into(),
            limit: 20,
        },
    )
    .await
    .expect("map after reindex");
    assert!(map.snapshot.is_none());
    assert!(map.clusters.is_empty());
}
