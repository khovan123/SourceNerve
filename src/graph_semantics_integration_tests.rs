use std::path::Path;

use sqlx::SqlitePool;
use tempfile::TempDir;

use crate::{db, index, workspace::Workspace};

async fn fixture_workspace(name: &str, root: &Path) -> (TempDir, SqlitePool, Workspace) {
    let state = tempfile::tempdir().expect("state tempdir");
    let pool = db::connect(state.path()).await.expect("connect sqlite");
    sqlx::query(
        "INSERT INTO workspaces(id, name, writable, updated_at) VALUES(?1, ?1, 1, unixepoch())",
    )
    .bind(name)
    .execute(&pool)
    .await
    .expect("insert workspace");
    let workspace = Workspace {
        id: name.to_string(),
        name: name.to_string(),
        root: root.to_path_buf(),
        writable: true,
    };
    (state, pool, workspace)
}

fn write_file(root: &Path, path: &str, content: &str) {
    let full = root.join(path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).expect("create fixture directory");
    }
    std::fs::write(full, content).expect("write fixture source");
}

async fn edge_count(
    pool: &SqlitePool,
    workspace_id: &str,
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
    .bind(workspace_id)
    .bind(edge_type)
    .bind(source_qualified_name)
    .bind(target_qualified_name)
    .fetch_one(pool)
    .await
    .expect("count graph edge")
}

async fn graph_snapshot(pool: &SqlitePool, workspace_id: &str) -> Vec<(String, String, String)> {
    sqlx::query_as(
        "SELECT source.qualified_name, e.edge_type, target.qualified_name \
         FROM edges e \
         JOIN symbols source ON source.id=e.source_symbol_id \
         JOIN symbols target ON target.id=e.target_symbol_id \
         WHERE e.workspace_id=?1 \
         ORDER BY source.qualified_name, e.edge_type, target.qualified_name",
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .expect("read graph snapshot")
}

#[tokio::test]
async fn resolves_import_extends_and_implements_edges() {
    let repo = tempfile::tempdir().expect("repo tempdir");
    write_file(
        repo.path(),
        "src/base.ts",
        "export interface Contract {}\nexport class Base {}\n",
    );
    write_file(
        repo.path(),
        "src/child.ts",
        "import { Base, Contract } from './base';\nexport class Child extends Base implements Contract {}\n",
    );

    let (_state, pool, workspace) = fixture_workspace("edges", repo.path()).await;
    index::sync_paths(
        &pool,
        &workspace,
        &["src/base.ts".into(), "src/child.ts".into()],
    )
    .await
    .expect("index structural graph");

    assert_eq!(
        edge_count(&pool, "edges", "IMPORTS", "src/child.ts", "src/base.ts").await,
        1
    );
    assert_eq!(
        edge_count(
            &pool,
            "edges",
            "EXTENDS",
            "src/child.ts::Child",
            "src/base.ts::Base",
        )
        .await,
        1
    );
    assert_eq!(
        edge_count(
            &pool,
            "edges",
            "IMPLEMENTS",
            "src/child.ts::Child",
            "src/base.ts::Contract",
        )
        .await,
        1
    );
}

#[tokio::test]
async fn incremental_modify_rename_and_rebuild_are_consistent() {
    let repo = tempfile::tempdir().expect("repo tempdir");
    write_file(
        repo.path(),
        "src/base.ts",
        "export class Base { value = 1; }\n",
    );
    write_file(
        repo.path(),
        "src/child.ts",
        "import { Base } from './base';\nexport class Child extends Base {}\n",
    );

    let (_incremental_state, incremental_pool, incremental_workspace) =
        fixture_workspace("incremental", repo.path()).await;
    index::sync_paths(
        &incremental_pool,
        &incremental_workspace,
        &["src/base.ts".into(), "src/child.ts".into()],
    )
    .await
    .expect("initial graph sync");

    write_file(
        repo.path(),
        "src/base.ts",
        "export class Base { value = 2; }\n",
    );
    index::sync_paths(
        &incremental_pool,
        &incremental_workspace,
        &["src/base.ts".into()],
    )
    .await
    .expect("incremental base modification");
    assert_eq!(
        edge_count(
            &incremental_pool,
            "incremental",
            "EXTENDS",
            "src/child.ts::Child",
            "src/base.ts::Base",
        )
        .await,
        1,
        "reverse inheritance dependency must reconnect after target symbol replacement"
    );

    std::fs::remove_file(repo.path().join("src/base.ts")).expect("remove old module");
    write_file(
        repo.path(),
        "src/model.ts",
        "export class Base { value = 3; }\n",
    );
    index::sync_paths(
        &incremental_pool,
        &incremental_workspace,
        &["src/base.ts".into(), "src/model.ts".into()],
    )
    .await
    .expect("incremental module rename");

    assert_eq!(
        edge_count(
            &incremental_pool,
            "incremental",
            "IMPORTS",
            "src/child.ts",
            "src/model.ts",
        )
        .await,
        0,
        "an unresolved old import must not silently retarget to a same-named symbol"
    );
    assert_eq!(
        edge_count(
            &incremental_pool,
            "incremental",
            "EXTENDS",
            "src/child.ts::Child",
            "src/model.ts::Base",
        )
        .await,
        0,
        "broken import scope must prevent a fabricated inheritance edge"
    );

    write_file(
        repo.path(),
        "src/child.ts",
        "import { Base } from './model';\nexport class Child extends Base {}\n",
    );
    index::sync_paths(
        &incremental_pool,
        &incremental_workspace,
        &["src/child.ts".into()],
    )
    .await
    .expect("refresh importing file");
    assert_eq!(
        edge_count(
            &incremental_pool,
            "incremental",
            "IMPORTS",
            "src/child.ts",
            "src/model.ts",
        )
        .await,
        1
    );
    assert_eq!(
        edge_count(
            &incremental_pool,
            "incremental",
            "EXTENDS",
            "src/child.ts::Child",
            "src/model.ts::Base",
        )
        .await,
        1
    );

    let incremental = graph_snapshot(&incremental_pool, "incremental").await;

    let (_rebuilt_state, rebuilt_pool, rebuilt_workspace) =
        fixture_workspace("rebuilt", repo.path()).await;
    index::sync_paths(
        &rebuilt_pool,
        &rebuilt_workspace,
        &["src/model.ts".into(), "src/child.ts".into()],
    )
    .await
    .expect("full-state rebuild from final files");
    let rebuilt = graph_snapshot(&rebuilt_pool, "rebuilt").await;

    assert_eq!(
        incremental, rebuilt,
        "incremental dependency state must equal a rebuild from the same final files"
    );
}
