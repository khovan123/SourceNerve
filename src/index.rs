use std::collections::HashSet;

use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::{
    error::{AppError, AppResult},
    graph,
    workspace::Workspace,
};

async fn delete_file_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    workspace_id: &str,
    path: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM files WHERE workspace_id=?1 AND path=?2")
        .bind(workspace_id)
        .bind(path)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub async fn sync_paths(
    pool: &SqlitePool,
    workspace: &Workspace,
    paths: &[String],
) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    for path in paths {
        let joined = workspace.root.join(path);
        if !joined.starts_with(&workspace.root) {
            return Err(AppError::PathOutsideWorkspace);
        }
        if !joined.exists() {
            delete_file_row(&mut tx, &workspace.id, path).await?;
            continue;
        }

        let full = tokio::fs::canonicalize(&joined).await?;
        if !full.starts_with(&workspace.root) {
            return Err(AppError::PathOutsideWorkspace);
        }
        let metadata = tokio::fs::metadata(&full).await?;
        if !metadata.is_file() || metadata.len() > 2_000_000 {
            delete_file_row(&mut tx, &workspace.id, path).await?;
            continue;
        }

        let bytes = tokio::fs::read(&full).await?;
        if bytes.contains(&0) {
            delete_file_row(&mut tx, &workspace.id, path).await?;
            continue;
        }
        let content = match String::from_utf8(bytes.clone()) {
            Ok(v) => v,
            Err(_) => {
                delete_file_row(&mut tx, &workspace.id, path).await?;
                continue;
            }
        };
        let hash = hex::encode(Sha256::digest(&bytes));
        let language = graph::language_name_for_path(path);
        sqlx::query(
            "INSERT INTO files(workspace_id, path, language, content_hash, content, size_bytes, indexed_at) \
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, unixepoch()) \
             ON CONFLICT(workspace_id, path) DO UPDATE SET language=excluded.language, content_hash=excluded.content_hash, content=excluded.content, size_bytes=excluded.size_bytes, indexed_at=unixepoch()"
        )
        .bind(&workspace.id)
        .bind(path)
        .bind(language)
        .bind(hash)
        .bind(content)
        .bind(bytes.len() as i64)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn full_sync(
    pool: &SqlitePool,
    workspace: &Workspace,
    paths: &[String],
) -> AppResult<u64> {
    sync_paths(pool, workspace, paths).await?;

    let discovered: HashSet<&str> = paths.iter().map(String::as_str).collect();
    let existing: Vec<String> = sqlx::query_scalar("SELECT path FROM files WHERE workspace_id=?1")
        .bind(&workspace.id)
        .fetch_all(pool)
        .await?;
    let stale: Vec<String> = existing
        .into_iter()
        .filter(|path| !discovered.contains(path.as_str()))
        .collect();
    if !stale.is_empty() {
        let mut tx = pool.begin().await?;
        for path in stale {
            delete_file_row(&mut tx, &workspace.id, &path).await?;
        }
        tx.commit().await?;
    }

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM files WHERE workspace_id=?1")
        .bind(&workspace.id)
        .fetch_one(pool)
        .await?;
    Ok(count.max(0) as u64)
}
