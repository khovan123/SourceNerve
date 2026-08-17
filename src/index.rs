use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::{error::{AppError, AppResult}, workspace::Workspace};

pub async fn sync_paths(pool: &SqlitePool, workspace: &Workspace, paths: &[String]) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    for path in paths {
        let full = workspace.root.join(path);
        if !full.starts_with(&workspace.root) { return Err(AppError::PathOutsideWorkspace); }
        if !full.exists() {
            sqlx::query("DELETE FROM files WHERE workspace_id=?1 AND path=?2")
                .bind(&workspace.id).bind(path).execute(&mut *tx).await?;
            continue;
        }
        if !full.is_file() { continue; }
        let bytes = tokio::fs::read(&full).await?;
        if bytes.len() > 2_000_000 || bytes.contains(&0) { continue; }
        let content = match String::from_utf8(bytes.clone()) { Ok(v) => v, Err(_) => continue };
        let hash = hex::encode(Sha256::digest(&bytes));
        sqlx::query(
            "INSERT INTO files(workspace_id, path, content_hash, content, size_bytes, indexed_at) \
             VALUES(?1, ?2, ?3, ?4, ?5, unixepoch()) \
             ON CONFLICT(workspace_id, path) DO UPDATE SET content_hash=excluded.content_hash, content=excluded.content, size_bytes=excluded.size_bytes, indexed_at=unixepoch()"
        ).bind(&workspace.id).bind(path).bind(hash).bind(content).bind(bytes.len() as i64).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
