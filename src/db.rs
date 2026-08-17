use std::path::Path;

use anyhow::{Context, Result};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};

use crate::workspace::WorkspaceRegistry;

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
        .max_connections(8)
        .connect_with(opts)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    Ok(pool)
}

pub async fn register_workspaces(pool: &SqlitePool, registry: &WorkspaceRegistry) -> Result<()> {
    for w in registry.list() {
        sqlx::query(
            "INSERT INTO workspaces(id, name, writable, updated_at) VALUES(?1, ?2, ?3, unixepoch()) \
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, writable=excluded.writable, updated_at=unixepoch()"
        )
        .bind(&w.id).bind(&w.name).bind(w.writable).execute(pool).await?;
    }
    Ok(())
}
