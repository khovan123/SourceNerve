use schemars::JsonSchema;
use serde::Serialize;

use crate::{
    error::{AppError, AppResult},
    git, index,
    service::AppState,
};

#[derive(Debug, Serialize, JsonSchema)]
pub struct WorkspaceIndexResult {
    pub workspace: String,
    pub head: String,
    pub discovered_files: usize,
    pub indexed_text_files: u64,
}

pub async fn index_workspace(state: &AppState, workspace_id: &str) -> AppResult<WorkspaceIndexResult> {
    let _guard = state.mutation_lock.lock().await;
    let workspace = state.workspaces.get(workspace_id)?;
    let head_before = git::head(&workspace.root).await?;
    let paths = git::working_files(&workspace.root).await?;
    let indexed_text_files = index::full_sync(&state.db, &workspace, &paths).await?;
    let head_after = git::head(&workspace.root).await?;
    if head_before != head_after {
        return Err(AppError::WorkspaceChanged {
            expected: head_before,
            actual: head_after,
        });
    }

    sqlx::query(
        "UPDATE workspaces SET git_head=?1, indexed_head=?1, graph_version=graph_version+1, updated_at=unixepoch() WHERE id=?2",
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
    })
}
