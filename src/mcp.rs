use rmcp::{
    ErrorData as McpError,
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock},
    tool, tool_router,
};

use crate::{
    graph::{self, SymbolKeyRequest, SymbolSearchRequest, TraceRequest},
    memory::{self, MemorySearchRequest},
    ops::AuditQuery,
    service::{AppState, PatchRequest, ReadFileRequest, SearchRequest, WorkspaceArg},
    state_backup::{BackupCreateRequest, BackupValidateRequest},
    workflow::{
        BranchCheckoutRequest, CommitRequest, DefaultSyncRequest, GitHubIssueCreateRequest,
        GitHubPullCreateRequest, GitHubPullGetRequest, GitHubPullMergeRequest, PushRequest,
    },
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
        description = "Return SourceNerve build identity and production capability summary without exposing host paths or credentials."
    )]
    async fn service_status(&self) -> Result<CallToolResult, McpError> {
        Self::ok(&self.state.service_status())
    }

    #[tool(
        description = "Return production readiness for SQLite, required executables, and configured Git workspaces without exposing paths or credentials."
    )]
    async fn readiness(&self) -> Result<CallToolResult, McpError> {
        Self::ok(&self.state.readiness().await)
    }

    #[tool(
        description = "Create a consistent SQLite state backup under the configured state directory with bounded generated-backup retention."
    )]
    async fn state_backup_create(
        &self,
        Parameters(args): Parameters<BackupCreateRequest>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.state_backup_create(args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Validate a SourceNerve-generated SQLite backup read-only without replacing the live database."
    )]
    async fn state_backup_validate(
        &self,
        Parameters(args): Parameters<BackupValidateRequest>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.state_backup_validate(args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Read a bounded workspace-scoped mutation audit trail. Audit records contain sanitized metadata only, never tokens, patch bodies, or complete diffs."
    )]
    async fn mutation_audit(
        &self,
        Parameters(args): Parameters<AuditQuery>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.audit_events(args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

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

    #[tool(description = "Return a symbol plus its resolved incoming and outgoing graph edges.")]
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

    #[tool(
        description = "Return the complete reviewable Git diff from HEAD, including non-ignored untracked files."
    )]
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
        description = "Return branch, HEAD, status, complete review diff, and SHA-256 used as the commit concurrency gate."
    )]
    async fn git_review(
        &self,
        Parameters(args): Parameters<WorkspaceArg>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.git_review(&args.workspace).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Create and checkout a new feature branch only from the exact expected HEAD and a clean working tree."
    )]
    async fn git_branch_checkout(
        &self,
        Parameters(args): Parameters<BranchCheckoutRequest>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.checkout_branch(args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Return to the configured default branch, fetch it, fast-forward only, then rebuild repository memory and graph."
    )]
    async fn git_default_sync(
        &self,
        Parameters(args): Parameters<DefaultSyncRequest>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.sync_default_branch(args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Commit the reviewed working-tree delta only when expected HEAD and expected review-diff SHA-256 still match. Direct default-branch commits are rejected."
    )]
    async fn git_commit(
        &self,
        Parameters(args): Parameters<CommitRequest>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.commit_reviewed(args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Push only the current clean feature branch to its configured remote without force."
    )]
    async fn git_push(
        &self,
        Parameters(args): Parameters<PushRequest>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.push_current_branch(args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Create a GitHub issue for the workspace repository using server-side GitHub credentials."
    )]
    async fn github_issue_create(
        &self,
        Parameters(args): Parameters<GitHubIssueCreateRequest>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.github_issue_create(args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Create a GitHub pull request from the current clean feature branch after verifying the remote branch matches expected local HEAD."
    )]
    async fn github_pull_create(
        &self,
        Parameters(args): Parameters<GitHubPullCreateRequest>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.github_pull_create(args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Read current GitHub pull request state and its exact head SHA for review/merge gating."
    )]
    async fn github_pull_get(
        &self,
        Parameters(args): Parameters<GitHubPullGetRequest>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.github_pull_get(args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Merge an open non-draft GitHub pull request only when its current head SHA exactly matches expected_head_sha. GitHub branch protections and required checks remain authoritative."
    )]
    async fn github_pull_merge(
        &self,
        Parameters(args): Parameters<GitHubPullMergeRequest>,
    ) -> Result<CallToolResult, McpError> {
        match self.state.github_pull_merge(args).await {
            Ok(v) => Self::ok(&v),
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
