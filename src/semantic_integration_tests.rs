use std::{path::Path, process::Command, sync::Arc};

use tempfile::TempDir;
use tokio::sync::Mutex;

use crate::{
    config::WorkspaceConfig,
    context::{self, ContextPackRequest},
    db, memory,
    semantic::{self, SemanticChunkImport, SemanticImportRequest, SemanticSearchRequest},
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
    std::fs::create_dir_all(repo.path().join("src")).expect("create src");
    std::fs::write(
        repo.path().join("src/pricing.rs"),
        "pub fn calculate_total(subtotal: i64) -> i64 {\n    subtotal + 42\n}\n",
    )
    .expect("write pricing");
    std::fs::write(
        repo.path().join("src/noise.rs"),
        "pub fn unrelated_feature() -> &'static str {\n    \"noise\"\n}\n",
    )
    .expect("write noise");
    std::fs::write(repo.path().join("src/lib.rs"), "mod pricing;\nmod noise;\n")
        .expect("write lib");
    commit_all(repo.path(), "semantic fixture");

    let registry = WorkspaceRegistry::build(&[WorkspaceConfig {
        id: "semantic".into(),
        name: "Semantic Fixture".into(),
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
        workspaces: registry.clone(),
        db: pool,
        mutation_lock: Arc::new(Mutex::new(())),
        github_token: None,
    };
    memory::index_workspace(&state, "semantic")
        .await
        .expect("index workspace");
    (repo, state_dir, registry, state)
}

async fn file_hash(state: &AppState, path: &str) -> String {
    sqlx::query_scalar("SELECT content_hash FROM files WHERE workspace_id='semantic' AND path=?1")
        .bind(path)
        .fetch_one(&state.db)
        .await
        .expect("indexed file hash")
}

async fn import_request(state: &AppState) -> SemanticImportRequest {
    SemanticImportRequest {
        workspace: "semantic".into(),
        client_run_id: "semantic:test:v1".into(),
        provider: "fixture".into(),
        model: "two-dim".into(),
        dimension: 2,
        chunks: vec![
            SemanticChunkImport {
                path: "src/pricing.rs".into(),
                start_line: 1,
                end_line: 3,
                file_sha256: file_hash(state, "src/pricing.rs").await,
                vector: vec![1.0, 0.0],
            },
            SemanticChunkImport {
                path: "src/noise.rs".into(),
                start_line: 1,
                end_line: 3,
                file_sha256: file_hash(state, "src/noise.rs").await,
                vector: vec![0.0, 1.0],
            },
        ],
    }
}

#[tokio::test]
async fn import_is_replay_safe_search_is_deterministic_and_survives_restart() {
    let (_repo, state_dir, registry, state) = fixture().await;
    let first = semantic::import(&state, import_request(&state).await)
        .await
        .expect("first semantic import");
    assert!(!first.replayed);
    assert_eq!(first.imported_chunks, 2);

    let replay = semantic::import(&state, import_request(&state).await)
        .await
        .expect("replayed semantic import");
    assert!(replay.replayed);
    assert_eq!(replay.run.id, first.run.id);

    let search_request = SemanticSearchRequest {
        workspace: "semantic".into(),
        query_vector: vec![1.0, 0.1],
        limit: 10,
    };
    let search = semantic::search(&state, search_request)
        .await
        .expect("semantic search");
    assert_eq!(
        search.run.as_ref().map(|run| run.id.as_str()),
        Some(first.run.id.as_str())
    );
    assert_eq!(search.hits[0].path, "src/pricing.rs");
    assert!(search.hits[0].score > search.hits[1].score);

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
    let after_restart = semantic::search(
        &restarted,
        SemanticSearchRequest {
            workspace: "semantic".into(),
            query_vector: vec![1.0, 0.1],
            limit: 10,
        },
    )
    .await
    .expect("semantic search after restart");
    assert_eq!(after_restart.hits[0].path, "src/pricing.rs");
}

#[tokio::test]
async fn semantic_context_adds_reason_and_no_vector_preserves_baseline() {
    let (_repo, _state_dir, _registry, state) = fixture().await;
    semantic::import(&state, import_request(&state).await)
        .await
        .expect("semantic import");

    let baseline = context::pack(
        &state,
        ContextPackRequest {
            workspace: "semantic".into(),
            query: "noise".into(),
            seed_symbol_keys: Vec::new(),
            max_bytes: 4096,
            max_items: 10,
            require_clean: true,
        },
    )
    .await
    .expect("baseline context");
    let wrapped = semantic_context::pack(
        &state,
        SemanticContextPackRequest {
            workspace: "semantic".into(),
            query: "noise".into(),
            seed_symbol_keys: Vec::new(),
            max_bytes: 4096,
            max_items: 10,
            require_clean: true,
            query_vector: None,
            provider_semantic: false,
        },
    )
    .await
    .expect("wrapped baseline context");
    assert_eq!(
        serde_json::to_value(&baseline).expect("baseline json"),
        serde_json::to_value(&wrapped).expect("wrapped json")
    );

    let semantic_pack = semantic_context::pack(
        &state,
        SemanticContextPackRequest {
            workspace: "semantic".into(),
            query: "noise".into(),
            seed_symbol_keys: Vec::new(),
            max_bytes: 4096,
            max_items: 10,
            require_clean: true,
            query_vector: Some(vec![1.0, 0.0]),
            provider_semantic: false,
        },
    )
    .await
    .expect("semantic context pack");
    assert!(semantic_pack.items.iter().any(|item| {
        item.path == "src/pricing.rs"
            && item
                .reasons
                .iter()
                .any(|reason| reason.signal == "semantic-vector")
    }));
    assert!(semantic_pack.used_bytes <= semantic_pack.max_bytes);
}

#[tokio::test]
async fn source_change_and_reindex_excludes_stale_semantic_run() {
    let (repo, _state_dir, _registry, state) = fixture().await;
    semantic::import(&state, import_request(&state).await)
        .await
        .expect("semantic import");

    std::fs::write(
        repo.path().join("src/pricing.rs"),
        "pub fn calculate_total(subtotal: i64) -> i64 {\n    subtotal + 99\n}\n",
    )
    .expect("update pricing");
    commit_all(repo.path(), "change pricing");
    memory::index_workspace(&state, "semantic")
        .await
        .expect("reindex changed workspace");

    let result = semantic::search(
        &state,
        SemanticSearchRequest {
            workspace: "semantic".into(),
            query_vector: vec![1.0, 0.0],
            limit: 10,
        },
    )
    .await
    .expect("search after reindex");
    assert!(result.run.is_none());
    assert!(result.hits.is_empty());
}
