use rmcp::{ErrorData as McpError, handler::server::wrapper::Parameters, model::{CallToolResult, ContentBlock}, tool, tool_router};

use crate::service::{AppState, PatchRequest, ReadFileRequest, SearchRequest, WorkspaceArg};

#[derive(Clone)]
pub struct SourceNerveMcp { state: AppState }

impl SourceNerveMcp {
    pub fn new(state: AppState) -> Self { Self { state } }

    fn ok<T: serde::Serialize>(value: &T) -> Result<CallToolResult, McpError> {
        match serde_json::to_string_pretty(value) {
            Ok(text) => Ok(CallToolResult::success(vec![ContentBlock::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![ContentBlock::text(e.to_string())])),
        }
    }

    fn err(error: impl std::fmt::Display) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::error(vec![ContentBlock::text(error.to_string())]))
    }
}

#[tool_router(server_handler)]
impl SourceNerveMcp {
    #[tool(description = "List configured SourceNerve workspaces. Paths are intentionally not exposed.")]
    async fn workspace_list(&self) -> Result<CallToolResult, McpError> {
        match self.state.list_workspaces().await { Ok(v) => Self::ok(&v), Err(e) => Self::err(e) }
    }

    #[tool(description = "Return git HEAD and dirty status for a workspace before reading or mutating source.")]
    async fn repo_snapshot(&self, Parameters(args): Parameters<WorkspaceArg>) -> Result<CallToolResult, McpError> {
        match self.state.snapshot(&args.workspace).await { Ok(v) => Self::ok(&v), Err(e) => Self::err(e) }
    }

    #[tool(description = "Search repository source using ripgrep within a configured workspace.")]
    async fn search_code(&self, Parameters(args): Parameters<SearchRequest>) -> Result<CallToolResult, McpError> {
        match self.state.search(args).await { Ok(v) => Self::ok(&v), Err(e) => Self::err(e) }
    }

    #[tool(description = "Read a UTF-8 source file or line range. Returns a SHA-256 content hash for concurrency checks.")]
    async fn read_file(&self, Parameters(args): Parameters<ReadFileRequest>) -> Result<CallToolResult, McpError> {
        match self.state.read_file(args).await { Ok(v) => Self::ok(&v), Err(e) => Self::err(e) }
    }

    #[tool(description = "Return the current unstaged git diff for a workspace.")]
    async fn git_diff(&self, Parameters(args): Parameters<WorkspaceArg>) -> Result<CallToolResult, McpError> {
        match self.state.diff(&args.workspace).await { Ok(v) => Self::ok(&serde_json::json!({"diff": v})), Err(e) => Self::err(e) }
    }

    #[tool(description = "Validate a unified git patch without changing files. expected_head must match current HEAD.")]
    async fn patch_preview(&self, Parameters(args): Parameters<PatchRequest>) -> Result<CallToolResult, McpError> {
        match self.state.preview_patch(args).await { Ok(v) => Self::ok(&v), Err(e) => Self::err(e) }
    }

    #[tool(description = "Apply a previously reviewed unified git patch to a writable workspace, then incrementally refresh changed file memory.")]
    async fn patch_apply(&self, Parameters(args): Parameters<PatchRequest>) -> Result<CallToolResult, McpError> {
        match self.state.apply_patch(args).await { Ok(v) => Self::ok(&v), Err(e) => Self::err(e) }
    }
}
