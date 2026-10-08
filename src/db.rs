use std::{path::Path, time::Instant};

use anyhow::{Context, Result, bail};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};

use crate::{runtime::STATE_SCHEMA_VERSION, workspace::WorkspaceRegistry};

#[cfg(test)]
const SQLITE_MAX_CONNECTIONS: u32 = 1;
#[cfg(not(test))]
const SQLITE_MAX_CONNECTIONS: u32 = 8;

async fn guard_future_schema(pool: &SqlitePool) -> Result<()> {
    let migration_table_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
    )
    .fetch_one(pool)
    .await?;
    if migration_table_exists == 0 {
        return Ok(());
    }
    let version: Option<i64> =
        sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations WHERE success = TRUE")
            .fetch_one(pool)
            .await?;
    if let Some(version) = version {
        if version > i64::from(STATE_SCHEMA_VERSION) {
            bail!(
                "state schema version {version} is newer than this SourceNerve binary supports ({STATE_SCHEMA_VERSION}); downgrade is unsupported, use a compatible binary or restore a compatible backup"
            );
        }
    }
    Ok(())
}

pub async fn connect(state_dir: &Path) -> Result<SqlitePool> {
    tokio::fs::create_dir_all(state_dir)
        .await
        .with_context(|| format!("failed to create state directory {}", state_dir.display()))?;
    let db_path = state_dir.join("sourcenerve.db");
    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        // Unit/acceptance tests intentionally use one connection. Some fixtures perform direct
        // graph writes immediately after a coordinated index operation; the lease Drop cleanup is
        // asynchronous and can otherwise race the next fixture write on a second SQLite connection,
        // producing nondeterministic SQLITE_BUSY failures unrelated to graph correctness.
        .max_connections(SQLITE_MAX_CONNECTIONS)
        .connect_with(opts)
        .await?;
    guard_future_schema(&pool).await?;
    sqlx::migrate!().run(&pool).await?;
    Ok(pool)
}

pub async fn prepare_workspaces(
    pool: &SqlitePool,
    registry: &WorkspaceRegistry,
) -> Result<Vec<String>> {
    let configured = registry.list();
    let mut transaction = pool.begin().await?;

    for workspace in &configured {
        sqlx::query(
            "INSERT INTO workspaces(id, name, writable, updated_at) VALUES(?1, ?2, ?3, unixepoch()) \
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, writable=excluded.writable, updated_at=unixepoch()"
        )
        .bind(&workspace.id)
        .bind(&workspace.name)
        .bind(workspace.writable)
        .execute(&mut *transaction)
        .await?;
    }

    let existing: Vec<String> = sqlx::query_scalar("SELECT id FROM workspaces")
        .fetch_all(&mut *transaction)
        .await?;
    let stale = existing
        .into_iter()
        .filter(|workspace_id| {
            !configured
                .iter()
                .any(|workspace| workspace.id == *workspace_id)
        })
        .collect();

    transaction.commit().await?;
    Ok(stale)
}

pub async fn prune_removed_workspaces(pool: &SqlitePool, workspace_ids: Vec<String>) -> Result<()> {
    for workspace_id in workspace_ids {
        let started = Instant::now();
        let mut transaction = pool.begin().await?;
        // `workspaces` is the root FK for repository-derived state. Deleting only
        // this registration lets SQLite cascade files/symbols/edges/memories and
        // other workspace-owned state without touching the repository filesystem.
        sqlx::query("DELETE FROM workspaces WHERE id = ?1")
            .bind(&workspace_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        tracing::info!(
            workspace_id = %workspace_id,
            elapsed_ms = started.elapsed().as_millis(),
            "pruned removed workspace state"
        );
    }
    Ok(())
}

#[cfg(test)]
pub async fn register_workspaces(pool: &SqlitePool, registry: &WorkspaceRegistry) -> Result<()> {
    let stale = prepare_workspaces(pool, registry).await?;
    prune_removed_workspaces(pool, stale).await
}

#[cfg(test)]
mod tests {
    use super::{connect, guard_future_schema, prepare_workspaces, register_workspaces};
    use crate::{
        config::WorkspaceConfig, runtime::STATE_SCHEMA_VERSION, workspace::WorkspaceRegistry,
    };
    use std::collections::BTreeMap;

    use sqlx::{Row, sqlite::SqlitePoolOptions};

    async fn migration_pool(version: i64) -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("pool");
        sqlx::query(
            "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, success BOOLEAN NOT NULL)",
        )
        .execute(&pool)
        .await
        .expect("migration table");
        sqlx::query("INSERT INTO _sqlx_migrations(version, success) VALUES(?1, TRUE)")
            .bind(version)
            .execute(&pool)
            .await
            .expect("migration row");
        pool
    }

    #[tokio::test]
    async fn accepts_older_state_for_forward_migration() {
        let pool = migration_pool(i64::from(STATE_SCHEMA_VERSION) - 1).await;
        guard_future_schema(&pool)
            .await
            .expect("older schema accepted");
    }

    #[tokio::test]
    async fn rejects_future_state_on_downgrade() {
        let pool = migration_pool(i64::from(STATE_SCHEMA_VERSION) + 1).await;
        let error = guard_future_schema(&pool)
            .await
            .expect_err("future schema rejected");
        assert!(error.to_string().contains("downgrade is unsupported"));
    }

    #[tokio::test]
    async fn workspace_prepare_defers_removed_workspace_state() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("pool");
        sqlx::query(
            "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, writable INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
        )
        .execute(&pool)
        .await
        .expect("workspaces table");
        sqlx::query(
            "INSERT INTO workspaces(id, name, writable, updated_at) VALUES('stale', 'Stale', 1, 0)",
        )
        .execute(&pool)
        .await
        .expect("stale workspace");

        let root = std::env::current_dir().expect("repo root");
        let registry = WorkspaceRegistry::build(&[WorkspaceConfig {
            id: "active".into(),
            name: "Active".into(),
            root,
            access: "read-only".into(),
            remote: "origin".into(),
            default_branch: "main".into(),
            provider: None,
            repository: None,
            github_repository: None,
        }])
        .expect("registry");

        let stale = prepare_workspaces(&pool, &registry).await.expect("prepare");
        assert_eq!(stale, vec!["stale"]);
        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM workspaces ORDER BY id")
            .fetch_all(&pool)
            .await
            .expect("ids");
        assert_eq!(ids, vec!["active", "stale"]);
    }

    #[tokio::test]
    async fn workspace_cascade_foreign_keys_have_supporting_indexes() {
        let root = tempfile::tempdir().expect("state dir");
        let pool = connect(root.path()).await.expect("migrated pool");
        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .expect("schema tables");
        let mut missing = Vec::new();

        for table in tables {
            let escaped_table = table.replace('"', "\"\"");
            let foreign_keys =
                sqlx::query(&format!("PRAGMA foreign_key_list(\"{escaped_table}\")"))
                    .fetch_all(&pool)
                    .await
                    .expect("foreign keys");
            let mut groups: BTreeMap<i64, (String, Vec<(i64, String)>)> = BTreeMap::new();
            for row in foreign_keys {
                let on_delete: String = row.try_get("on_delete").expect("on_delete");
                if !matches!(on_delete.as_str(), "CASCADE" | "SET NULL" | "SET DEFAULT") {
                    continue;
                }
                let id: i64 = row.try_get("id").expect("foreign-key id");
                let seq: i64 = row.try_get("seq").expect("foreign-key seq");
                let child: String = row.try_get("from").expect("foreign-key child column");
                groups
                    .entry(id)
                    .or_insert_with(|| (on_delete.clone(), Vec::new()))
                    .1
                    .push((seq, child));
            }

            let index_rows = sqlx::query(&format!("PRAGMA index_list(\"{escaped_table}\")"))
                .fetch_all(&pool)
                .await
                .expect("index list");
            let index_names: Vec<String> = index_rows
                .iter()
                .map(|row| row.try_get("name").expect("index name"))
                .collect();

            for (_id, (on_delete, mut child_columns)) in groups {
                child_columns.sort_by_key(|(seq, _)| *seq);
                let child_columns: Vec<String> = child_columns
                    .into_iter()
                    .map(|(_, column)| column)
                    .collect();
                let mut covered = false;
                for index_name in &index_names {
                    let escaped_index = index_name.replace('"', "\"\"");
                    let index_info =
                        sqlx::query(&format!("PRAGMA index_info(\"{escaped_index}\")"))
                            .fetch_all(&pool)
                            .await
                            .expect("index info");
                    let columns: Vec<String> = index_info
                        .iter()
                        .map(|row| row.try_get("name").expect("index column"))
                        .collect();
                    if columns.starts_with(&child_columns) {
                        covered = true;
                        break;
                    }
                }
                if !covered {
                    missing.push(format!(
                        "{table}({}) ON DELETE {on_delete}",
                        child_columns.join(", ")
                    ));
                }
            }
        }

        assert!(
            missing.is_empty(),
            "cascade/set-null foreign keys without a supporting child index: {}",
            missing.join("; ")
        );
    }

    #[tokio::test]
    async fn workspace_registration_prunes_removed_workspace_state() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("pool");
        sqlx::query(
            "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, writable INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
        )
        .execute(&pool)
        .await
        .expect("workspaces table");
        sqlx::query(
            "INSERT INTO workspaces(id, name, writable, updated_at) VALUES('stale', 'Stale', 1, 0)",
        )
        .execute(&pool)
        .await
        .expect("stale workspace");

        let root = std::env::current_dir().expect("repo root");
        let registry = WorkspaceRegistry::build(&[WorkspaceConfig {
            id: "active".into(),
            name: "Active".into(),
            root,
            access: "read-only".into(),
            remote: "origin".into(),
            default_branch: "main".into(),
            provider: None,
            repository: None,
            github_repository: None,
        }])
        .expect("registry");

        register_workspaces(&pool, &registry)
            .await
            .expect("reconcile");
        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM workspaces ORDER BY id")
            .fetch_all(&pool)
            .await
            .expect("ids");
        assert_eq!(ids, vec!["active"]);
    }
}
