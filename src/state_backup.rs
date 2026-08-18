use std::{
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    runtime::STATE_SCHEMA_VERSION,
    service::AppState,
};

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct BackupCreateRequest {
    #[serde(default = "default_retain")]
    pub retain: usize,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct BackupCreateResponse {
    pub backup: String,
    pub bytes: u64,
    pub retained: usize,
    pub pruned: usize,
    pub state_schema_version: u32,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct BackupValidateRequest {
    pub backup: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct BackupValidateResponse {
    pub backup: String,
    pub valid: bool,
    pub bytes: u64,
    pub integrity: String,
    pub migration_count: i64,
    pub state_schema_version: u32,
}

fn default_retain() -> usize {
    5
}

async fn database_file(pool: &SqlitePool) -> AppResult<PathBuf> {
    let rows: Vec<(i64, String, String)> = sqlx::query_as("PRAGMA database_list")
        .fetch_all(pool)
        .await?;
    let file = rows
        .into_iter()
        .find(|(_, name, _)| name == "main")
        .map(|(_, _, file)| file)
        .filter(|file| !file.is_empty())
        .ok_or_else(|| {
            AppError::Internal(anyhow::anyhow!("SQLite main database has no file path"))
        })?;
    Ok(PathBuf::from(file))
}

async fn backup_directory(pool: &SqlitePool) -> AppResult<PathBuf> {
    let database = database_file(pool).await?;
    let parent = database.parent().ok_or_else(|| {
        AppError::Internal(anyhow::anyhow!(
            "SQLite database path has no parent directory"
        ))
    })?;
    let directory = parent.join("backups");
    tokio::fs::create_dir_all(&directory).await?;
    Ok(directory)
}

fn safe_backup_name(value: &str) -> AppResult<&str> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(AppError::InvalidRequest(
            "backup must be a relative generated backup path".into(),
        ));
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            AppError::InvalidRequest("backup path must contain a UTF-8 file name".into())
        })?;
    if !value.starts_with("backups/")
        || !file_name.starts_with("sourcenerve-")
        || !file_name.ends_with(".sqlite3")
    {
        return Err(AppError::InvalidRequest(
            "backup must reference a SourceNerve-generated file under backups/".into(),
        ));
    }
    Ok(file_name)
}

async fn generated_backups(directory: &Path) -> AppResult<Vec<PathBuf>> {
    let mut entries = tokio::fs::read_dir(directory).await?;
    let mut backups = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if !entry.file_type().await?.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.starts_with("sourcenerve-") && name.ends_with(".sqlite3") {
            backups.push(path);
        }
    }
    backups.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    Ok(backups)
}

async fn prune_backups(directory: &Path, retain: usize) -> AppResult<(usize, usize)> {
    let backups = generated_backups(directory).await?;
    let retained = backups.len().min(retain);
    let mut pruned = 0;
    for path in backups.into_iter().skip(retain) {
        tokio::fs::remove_file(path).await?;
        pruned += 1;
    }
    Ok((retained, pruned))
}

impl AppState {
    pub async fn state_backup_create(
        &self,
        request: BackupCreateRequest,
    ) -> AppResult<BackupCreateResponse> {
        let retain = request.retain.clamp(1, 50);
        let _guard = self.mutation_lock.lock().await;
        let directory = backup_directory(&self.db).await?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| {
                AppError::Internal(anyhow::anyhow!(
                    "system clock is before Unix epoch: {error}"
                ))
            })?
            .as_secs();
        let file_name = format!("sourcenerve-{timestamp}-{}.sqlite3", Uuid::new_v4());
        let target = directory.join(&file_name);
        if target.exists() {
            return Err(AppError::Internal(anyhow::anyhow!(
                "generated backup path unexpectedly already exists"
            )));
        }

        sqlx::query("VACUUM INTO ?1")
            .bind(target.to_string_lossy().to_string())
            .execute(&self.db)
            .await?;
        let bytes = tokio::fs::metadata(&target).await?.len();
        let (retained, pruned) = prune_backups(&directory, retain).await?;
        Ok(BackupCreateResponse {
            backup: format!("backups/{file_name}"),
            bytes,
            retained,
            pruned,
            state_schema_version: STATE_SCHEMA_VERSION,
        })
    }

    pub async fn state_backup_validate(
        &self,
        request: BackupValidateRequest,
    ) -> AppResult<BackupValidateResponse> {
        let file_name = safe_backup_name(&request.backup)?;
        let directory = backup_directory(&self.db).await?;
        let directory = tokio::fs::canonicalize(&directory).await?;
        let target = tokio::fs::canonicalize(directory.join(file_name)).await?;
        if !target.starts_with(&directory) || !target.is_file() {
            return Err(AppError::PathOutsideWorkspace);
        }
        let bytes = tokio::fs::metadata(&target).await?.len();
        let options = SqliteConnectOptions::new()
            .filename(&target)
            .read_only(true)
            .create_if_missing(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&pool)
            .await?;
        let migration_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&pool)
            .await?;
        let workspaces_table: Option<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'",
        )
        .fetch_optional(&pool)
        .await?;
        pool.close().await;
        let valid = integrity == "ok" && migration_count > 0 && workspaces_table.is_some();
        Ok(BackupValidateResponse {
            backup: request.backup,
            valid,
            bytes,
            integrity,
            migration_count,
            state_schema_version: STATE_SCHEMA_VERSION,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::safe_backup_name;

    #[test]
    fn accepts_only_generated_relative_backup_paths() {
        assert_eq!(
            safe_backup_name("backups/sourcenerve-123-id.sqlite3").expect("valid backup"),
            "sourcenerve-123-id.sqlite3"
        );
        assert!(safe_backup_name("../sourcenerve-123-id.sqlite3").is_err());
        assert!(safe_backup_name("backups/manual.sqlite3").is_err());
        assert!(safe_backup_name("/tmp/sourcenerve-123-id.sqlite3").is_err());
    }
}
