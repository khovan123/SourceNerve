use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    coordination,
    error::{AppError, AppResult},
    git, graph, graph_reference_scope, graph_semantics, index, index_progress, scip_enrichment,
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
    let lease = coordination::acquire(state, workspace_id).await?;
    let result = index_workspace_locked(state, workspace_id).await;
    if result.is_err() {
        index_progress::fail(workspace_id);
    }
    let result = result?;
    if let Err(error) = lease.assert_current().await {
        index_progress::fail(workspace_id);
        return Err(error);
    }
    index_progress::complete(workspace_id);
    Ok(result)
}

pub(crate) async fn index_workspace_locked(
    state: &AppState,
    workspace_id: &str,
) -> AppResult<WorkspaceIndexResult> {
    let workspace = state.workspaces.get(workspace_id)?;
    let head_before = git::head(&workspace.root).await?;
    index_progress::begin(workspace_id, 100);
    index_progress::set(workspace_id, "discovering-files", 2, 100);
    let paths = git::working_files(&workspace.root).await?;
    index_progress::set(workspace_id, "syncing-files", 5, 100);
    let indexed_text_files = index::full_sync(&state.db, &workspace, &paths).await?;
    index_progress::set(workspace_id, "building-graph", 60, 100);
    let graph = graph::sync_paths(&state.db, &workspace, &paths).await?;
    index_progress::set(workspace_id, "analyzing-references", 72, 100);
    graph_semantics::sync_paths(&state.db, &workspace, &paths).await?;
    index_progress::set(workspace_id, "resolving-reference-scope", 84, 100);
    graph_reference_scope::resolve(&state.db, &workspace.id).await?;
    index_progress::set(workspace_id, "invalidating-scip", 91, 100);
    scip_enrichment::invalidate_for_graph_change(&state.db, &workspace.id).await?;
    index_progress::set(workspace_id, "verifying-workspace", 96, 100);
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
    index_progress::set(workspace_id, "finalizing", 99, 100);

    Ok(WorkspaceIndexResult {
        workspace: workspace_id.to_string(),
        head: head_after,
        discovered_files: paths.len(),
        indexed_text_files,
        graph,
    })
}

pub fn workspace_index_progress(workspace_id: &str) -> index_progress::IndexProgress {
    index_progress::snapshot(workspace_id)
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
