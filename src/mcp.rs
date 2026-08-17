use rmcp::{
    ErrorData as McpError,
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock},
    tool, tool_router,
};

use crate::{
    graph::{self, SymbolKeyRequest, SymbolSearchRequest, TraceRequest},
    memory::{self, MemorySearchRequest},
    service::{AppState, PatchRequest, ReadFileRequest, SearchRequest, WorkspaceArg},
};

#[derive(Clone)]
pub struct SourceNerveMcp {
    state: AppState,
}

impl SourceNerveMcp {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }

    fn ok<T: serde::Serialize>(value: &T) -> Result<CallToolResult, McpError> {
        match serde_json::to_string_pretty(value) {
            Ok(text) => Ok(CallToolResult::success(vec![ContentBlock::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![ContentBlock::text(
                e.to_string(),
            )])),
        }
    }

    fn err(error: impl std::fmt::Display) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::error(vec![ContentBlock::text(
            error.to_string(),
        )]))
    }
}

#[tool_router(server_handler)]
impl SourceNerveMcp {
    #[tool(
        description = "List configured SourceNerve workspaces. Paths are intentionally not exposed."
    )]
    async fn workspace_list(&self) -> Result<CallToolResult, McpError> {
        match self.state.list_workspaces().await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Bootstrap or refresh persistent SQLite file memory and the Tree-sitter symbol graph for one workspace."
    )]
    async fn workspace_index(
        &self,
        Parameters(args): Parameters<WorkspaceArg>,
    ) -> Result<CallToolResult, McpError> {
        match memory::index_workspace(&self.state, &args.workspace).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Search persistent SQLite/FTS5 repository memory. Use search_code when fresh raw working-tree grep is required."
    )]
    async fn memory_search(
        &self,
        Parameters(args): Parameters<MemorySearchRequest>,
    ) -> Result<CallToolResult, McpError> {
        match memory::search_memory(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Return Tree-sitter graph health, parse coverage, symbol/edge counts, graph version, and unresolved reference count."
    )]
    async fn graph_status(
        &self,
        Parameters(args): Parameters<WorkspaceArg>,
    ) -> Result<CallToolResult, McpError> {
        match graph::status(&self.state, &args.workspace).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Search Tree-sitter symbols by name or qualified name, optionally filtered by symbol kind."
    )]
    async fn symbol_search(
        &self,
        Parameters(args): Parameters<SymbolSearchRequest>,
    ) -> Result<CallToolResult, McpError> {
        match graph::search_symbols(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Return a symbol plus its resolved incoming and outgoing graph edges."
    )]
    async fn symbol_context(
        &self,
        Parameters(args): Parameters<SymbolKeyRequest>,
    ) -> Result<CallToolResult, McpError> {
        match graph::symbol_context(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(description = "Trace resolved CALLS edges toward callers up to a bounded depth.")]
    async fn trace_callers(
        &self,
        Parameters(args): Parameters<TraceRequest>,
    ) -> Result<CallToolResult, McpError> {
        match graph::trace_callers(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(description = "Trace resolved CALLS edges toward callees up to a bounded depth.")]
    async fn trace_callees(
        &self,
        Parameters(args): Parameters<TraceRequest>,
    ) -> Result<CallToolResult, McpError> {
        match graph::trace_callees(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Trace symbols that reference or structurally depend on the requested symbol."
    )]
    async fn references(
        &self,
        Parameters(args): Parameters<TraceRequest>,
    ) -> Result<CallToolResult, McpError> {
        match graph::references(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Perform bounded reverse dependency impact analysis from one symbol over resolved graph edges."
    )]
    async fn impact_analysis(
        &self,
        Parameters(args): Parameters<TraceRequest>,
    ) -> Result<CallToolResult, McpError> {
        match graph::impact_analysis(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Return git HEAD and dirty status for a workspace before reading or mutating source."
    )]
    async fn repo_snapshot(
        &self,
        Parameters(args): Parameters<WorkspaceArg>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.snapshot(&args.workspace).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(description = "Search repository source using ripgrep within a configured workspace.")]
    async fn search_code(
        &self,
        Parameters(args): Parameters<SearchRequest>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.search(args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Read a UTF-8 source file or line range. Returns a SHA-256 hash of the full file for patch concurrency checks."
    )]
    async fn read_file(
        &self,
        Parameters(args): Parameters<ReadFileRequest>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.read_file(args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(description = "Return the current unstaged git diff for a workspace.")]
    async fn git_diff(
        &self,
        Parameters(args): Parameters<WorkspaceArg>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.diff(&args.workspace).await {
            Ok(v) => Self::ok(&serde_json::json!({"diff": v})),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Validate a unified git patch without changing files. expected_head and every expected_files hash must still match the working tree."
    )]
    async fn patch_preview(
        &self,
        Parameters(args): Parameters<PatchRequest>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.preview_patch(args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Apply a reviewed unified git patch after rechecking HEAD and per-file hashes, then incrementally refresh changed file memory and graph state."
    )]
    async fn patch_apply(
        &self,
        Parameters(args): Parameters<PatchRequest>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.apply_patch(args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }
}
