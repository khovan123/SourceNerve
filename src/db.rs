use std::path::Path;

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

pub async fn register_workspaces(pool: &SqlitePool, registry: &WorkspaceRegistry) -> Result<()> {
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
    for workspace_id in existing {
        if !configured.iter().any(|workspace| workspace.id == workspace_id) {
            // `workspaces` is the root FK for repository-derived state. Deleting only
            // this registration lets SQLite cascade files/symbols/edges/memories and
            // other workspace-owned state without touching the repository filesystem.
            sqlx::query("DELETE FROM workspaces WHERE id = ?1")
                .bind(workspace_id)
                .execute(&mut *transaction)
                .await?;
        }
    }

    transaction.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{guard_future_schema, register_workspaces};
    use crate::{config::WorkspaceConfig, runtime::STATE_SCHEMA_VERSION, workspace::WorkspaceRegistry};
    use sqlx::sqlite::SqlitePoolOptions;

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
        sqlx::query("INSERT INTO workspaces(id, name, writable, updated_at) VALUES('stale', 'Stale', 1, 0)")
            .execute(&pool)
            .await
            .expect("stale workspace");

        let root = std::env::current_dir().expect("repo root");
        let registry = WorkspaceRegistry::build(&[WorkspaceConfig {
            id: "active".into(),
            name: "Active".into(),
            root: PathBuf::from(root),
            access: "read-only".into(),
            remote: "origin".into(),
            default_branch: "main".into(),
            provider: None,
            repository: None,
            github_repository: None,
        }])
        .expect("registry");

        register_workspaces(&pool, &registry).await.expect("reconcile");
        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM workspaces ORDER BY id")
            .fetch_all(&pool)
            .await
            .expect("ids");
        assert_eq!(ids, vec!["active"]);
    }
}
