use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    git, graph, index,
    service::AppState,
};

#[derive(Debug, Serialize, JsonSchema)]
pub struct WorkspaceIndexResult {
    pub workspace: String,
    pub head: String,
    pub discovered_files: usize,
    pub indexed_text_files: u64,
    pub graph: graph::GraphSyncSummary,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MemorySearchRequest {
    pub workspace: String,
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct MemorySearchHit {
    pub path: String,
    pub snippet: String,
    pub score: f64,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct MemorySearchResult {
    pub hits: Vec<MemorySearchHit>,
}

fn default_limit() -> usize {
    20
}

fn fts_query(input: &str) -> String {
    input
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .map(|part| format!("\"{}\"", part.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

pub async fn index_workspace(
    state: &AppState,
    workspace_id: &str,
) -> AppResult<WorkspaceIndexResult> {
    let _guard = state.mutation_lock.lock().await;
    let workspace = state.workspaces.get(workspace_id)?;
    let head_before = git::head(&workspace.root).await?;
    let paths = git::working_files(&workspace.root).await?;
    let indexed_text_files = index::full_sync(&state.db, &workspace, &paths).await?;
    let graph = graph::sync_paths(&state.db, &workspace, &paths).await?;
    let head_after = git::head(&workspace.root).await?;
    if head_before != head_after {
        return Err(AppError::WorkspaceChanged {
            expected: head_before,
            actual: head_after,
        });
    }

    sqlx::query(
        "UPDATE workspaces SET git_head=?1, indexed_head=?1, updated_at=unixepoch() WHERE id=?2",
    )
    .bind(&head_after)
    .bind(workspace_id)
    .execute(&state.db)
    .await?;

    Ok(WorkspaceIndexResult {
        workspace: workspace_id.to_string(),
        head: head_after,
        discovered_files: paths.len(),
        indexed_text_files,
        graph,
    })
}

pub async fn search_memory(
    state: &AppState,
    req: MemorySearchRequest,
) -> AppResult<MemorySearchResult> {
    state.workspaces.get(&req.workspace)?;
    if req.query.trim().is_empty() {
        return Err(AppError::InvalidRequest("query must not be empty".into()));
    }
    let query = fts_query(&req.query);
    if query.is_empty() {
        return Ok(MemorySearchResult { hits: Vec::new() });
    }
    let limit = req.limit.clamp(1, 100) as i64;
    let rows: Vec<(String, String, f64)> = sqlx::query_as(
        "SELECT f.path, snippet(code_fts, 1, '[', ']', ' … ', 16), bm25(code_fts) \
         FROM code_fts JOIN files f ON f.id=code_fts.rowid \
         WHERE code_fts MATCH ?1 AND f.workspace_id=?2 \
         ORDER BY bm25(code_fts) LIMIT ?3",
    )
    .bind(query)
    .bind(&req.workspace)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    Ok(MemorySearchResult {
        hits: rows
            .into_iter()
            .map(|(path, snippet, score)| MemorySearchHit {
                path,
                snippet,
                score,
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::fts_query;

    #[test]
    fn builds_safe_or_query() {
        assert_eq!(fts_query("search evidence"), "\"search\" OR \"evidence\"");
    }

    #[test]
    fn escapes_quotes() {
        assert_eq!(fts_query("a\"b"), "\"a\"\"b\"");
    }
}
