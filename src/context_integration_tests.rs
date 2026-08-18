use std::{path::Path, process::Command, sync::Arc};

use tempfile::TempDir;
use tokio::sync::Mutex;

use crate::{
    config::WorkspaceConfig,
    context::{self, ContextPackRequest},
    db, memory,
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
        repo.path().join("src/pricing.rs"),
        "pub fn calculate_total(subtotal: i64) -> i64 {\n    subtotal + 42\n}\n",
    )
    .expect("write pricing");
    std::fs::write(
        repo.path().join("src/checkout.rs"),
        "use crate::pricing::calculate_total;\n\npub fn checkout() -> i64 {\n    calculate_total(100)\n}\n",
    )
    .expect("write checkout");
    std::fs::write(
        repo.path().join("src/noise.rs"),
        "pub fn unrelated_feature() -> &'static str { \"noise\" }\n",
    )
    .expect("write noise");
    std::fs::write(
        repo.path().join("src/lib.rs"),
        "mod pricing;\nmod checkout;\nmod noise;\n",
    )
    .expect("write lib");
    commit_all(repo.path(), "context fixture");

    let registry = WorkspaceRegistry::build(&[WorkspaceConfig {
        id: "context".into(),
        name: "Context Fixture".into(),
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
    memory::index_workspace(&state, "context")
        .await
        .expect("index workspace");
    (repo, state_dir, state)
}

fn request(max_bytes: usize) -> ContextPackRequest {
    ContextPackRequest {
        workspace: "context".into(),
        query: "calculate_total pricing".into(),
        seed_symbol_keys: Vec::new(),
        max_bytes,
        max_items: 10,
        require_clean: true,
    }
}

#[tokio::test]
async fn ranks_definition_and_graph_neighbor_deterministically_with_hashes_and_budget() {
    let (_repo, _state_dir, state) = fixture().await;
    let first = context::pack(&state, request(4096))
        .await
        .expect("first context pack");
    let second = context::pack(&state, request(4096))
        .await
        .expect("second context pack");

    assert!(!first.items.is_empty());
    assert_eq!(first.items[0].path, "src/pricing.rs");
    assert!(first.used_bytes <= first.max_bytes);
    assert!(
        first
            .items
            .iter()
            .any(|item| item.path == "src/checkout.rs")
    );
    assert!(
        first.items.iter().any(|item| item
            .reasons
            .iter()
            .any(|reason| reason.signal == "graph-neighbor")),
        "at least one packed range should be graph-expanded"
    );

    for item in &first.items {
        let expected: String = sqlx::query_scalar(
            "SELECT content_hash FROM files WHERE workspace_id='context' AND path=?1",
        )
        .bind(&item.path)
        .fetch_one(&state.db)
        .await
        .expect("indexed hash");
        assert_eq!(item.sha256, expected);
    }

    let first_order: Vec<_> = first
        .items
        .iter()
        .map(|item| (&item.path, item.start_line, item.end_line, item.score))
        .collect();
    let second_order: Vec<_> = second
        .items
        .iter()
        .map(|item| (&item.path, item.start_line, item.end_line, item.score))
        .collect();
    assert_eq!(first_order, second_order, "ranking must be deterministic");
}

#[tokio::test]
async fn enforces_small_budget_and_rejects_dirty_tree_by_default() {
    let (repo, _state_dir, state) = fixture().await;
    let small = context::pack(&state, request(256))
        .await
        .expect("small context pack");
    assert!(small.used_bytes <= 256);
    assert_eq!(small.max_bytes, 256);

    std::fs::write(
        repo.path().join("src/pricing.rs"),
        "pub fn calculate_total(subtotal: i64) -> i64 { subtotal + 99 }\n",
    )
    .expect("dirty source");
    assert!(context::pack(&state, request(4096)).await.is_err());

    let snapshot = context::pack(
        &state,
        ContextPackRequest {
            require_clean: false,
            ..request(4096)
        },
    )
    .await
    .expect("explicit indexed snapshot");
    assert!(!snapshot.clean);
    assert_eq!(snapshot.consistency, "explicit-indexed-snapshot");
}
