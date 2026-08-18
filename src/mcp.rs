use rmcp::{
    ErrorData as McpError,
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock},
    tool, tool_router,
};

use crate::{
    architecture::{self, ArchitectureClusterRequest, ArchitectureMapRequest},
    architecture_context::{self, ArchitectureContextPackRequest},
    embedding_provider::{self, SemanticProviderIndexRequest, SemanticSearchTextRequest},
    graph::{self, SymbolKeyRequest, SymbolSearchRequest, TraceRequest},
    job_ingress::{self, JobGetRequest},
    memory::{self, MemorySearchRequest},
    ops::AuditQuery,
    scip_analyzer::{self, ScipAnalyzeRequest},
    scip_enrichment::{self, ScipImportRequest},
    semantic::{self, SemanticImportRequest, SemanticSearchRequest},
    service::{AppState, PatchRequest, ReadFileRequest, SearchRequest, WorkspaceArg},
    state_backup::{BackupCreateRequest, BackupValidateRequest},
    task_lifecycle::{
        self, TaskBranchCheckoutRequest, TaskCommitRequest, TaskIssueCreateRequest,
        TaskPullCreateRequest, TaskPullMergeRequest,
    },
    task_transactions::{
        self, TaskApplyPatchRequest, TaskBeginRequest, TaskIdRequest, TaskProposePatchRequest,
    },
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
        description = "Import a bounded externally generated embedding run for the exact clean indexed Git HEAD. Vectors are additive enrichment with provider/model provenance and never replace deterministic graph state."
    )]
    async fn semantic_import(
        &self,
        Parameters(args): Parameters<SemanticImportRequest>,
    ) -> Result<CallToolResult, McpError> {
        match semantic::import(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Run deterministic exact cosine search over the current semantic vector enrichment for one clean indexed workspace. Returns relative chunk ranges and provenance without source bodies."
    )]
    async fn semantic_search(
        &self,
        Parameters(args): Parameters<SemanticSearchRequest>,
    ) -> Result<CallToolResult, McpError> {
        match semantic::search(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Generate and activate a bounded deterministic OpenAI embedding run for the exact clean indexed workspace. Source leaves SourceNerve only when this tool is explicitly called."
    )]
    async fn semantic_provider_index(
        &self,
        Parameters(args): Parameters<SemanticProviderIndexRequest>,
    ) -> Result<CallToolResult, McpError> {
        match embedding_provider::index(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Embed one bounded text query through the configured OpenAI embedding provider and run exact cosine search against the current managed semantic run. Query text is not persisted."
    )]
    async fn semantic_search_text(
        &self,
        Parameters(args): Parameters<SemanticSearchTextRequest>,
    ) -> Result<CallToolResult, McpError> {
        match embedding_provider::search_text(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Build or replay a deterministic architecture snapshot for the exact clean indexed Git HEAD and graph version. Derived clusters never overwrite graph facts."
    )]
    async fn architecture_rebuild(
        &self,
        Parameters(args): Parameters<WorkspaceArg>,
    ) -> Result<CallToolResult, McpError> {
        match architecture::rebuild(&self.state, &args.workspace).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Return a bounded deterministic architecture map of current module clusters, representative files/symbols, and aggregated resolved dependencies."
    )]
    async fn architecture_map(
        &self,
        Parameters(args): Parameters<ArchitectureMapRequest>,
    ) -> Result<CallToolResult, McpError> {
        match architecture::map(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Return one current architecture cluster with bounded representative files/symbols and incoming/outgoing cluster dependencies, without source bodies."
    )]
    async fn architecture_cluster(
        &self,
        Parameters(args): Parameters<ArchitectureClusterRequest>,
    ) -> Result<CallToolResult, McpError> {
        match architecture::cluster(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Build a bounded repository context pack from FTS, symbols, graph proximity, optional semantic vectors, and optional architecture cluster seeds. Without cluster seeds the previous semantic/context behavior is unchanged."
    )]
    async fn context_pack(
        &self,
        Parameters(args): Parameters<ArchitectureContextPackRequest>,
    ) -> Result<CallToolResult, McpError> {
        match architecture_context::pack(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Return a durable webhook job and its sanitized task/lifecycle status. Job status is derived from the linked task and lifecycle rather than maintained by a second mutation engine."
    )]
    async fn job_get(
        &self,
        Parameters(args): Parameters<JobGetRequest>,
    ) -> Result<CallToolResult, McpError> {
        match job_ingress::get(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Begin or idempotently replay a durable repository task bound to the exact clean Git HEAD and deterministic graph version. Optionally returns an initial graph-ranked context pack while persisting only its hash."
    )]
    async fn task_begin(
        &self,
        Parameters(args): Parameters<TaskBeginRequest>,
    ) -> Result<CallToolResult, McpError> {
        match task_transactions::begin(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Return durable task state, proposal metadata, and sanitized ordered task events. Active tasks are stale-checked against Git HEAD, working-tree cleanliness, and graph version before being returned."
    )]
    async fn task_get(
        &self,
        Parameters(args): Parameters<TaskIdRequest>,
    ) -> Result<CallToolResult, McpError> {
        let task_id = args.task_id.clone();
        match task_transactions::get(&self.state, args).await {
            Ok(snapshot) => match task_lifecycle::load_view(&self.state, &task_id).await {
                Ok(lifecycle) => {
                    let mut value = serde_json::to_value(snapshot).unwrap();
                    if let serde_json::Value::Object(object) = &mut value {
                        object.insert("lifecycle".into(), serde_json::to_value(lifecycle).unwrap());
                    }
                    Self::ok(&value)
                }
                Err(e) => Self::err(e),
            },
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Cancel a durable task. Applied tasks cannot be cancelled; pending proposals are rejected without applying their stored patch."
    )]
    async fn task_cancel(
        &self,
        Parameters(args): Parameters<TaskIdRequest>,
    ) -> Result<CallToolResult, McpError> {
        match task_transactions::cancel(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Validate and persist a bounded patch proposal for an active snapshot-bound task without changing repository files. Supports task-scoped idempotency keys."
    )]
    async fn task_propose_patch(
        &self,
        Parameters(args): Parameters<TaskProposePatchRequest>,
    ) -> Result<CallToolResult, McpError> {
        match task_transactions::propose_patch(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Apply one stored task proposal through the existing reviewed patch guard. The task snapshot and per-file expectations must still be current; successful application persists the changeset and task outcome."
    )]
    async fn task_apply_patch(
        &self,
        Parameters(args): Parameters<TaskApplyPatchRequest>,
    ) -> Result<CallToolResult, McpError> {
        match task_transactions::apply_patch(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Create or recover the task feature branch from the task's exact base HEAD. Lifecycle state is persisted and replay-safe."
    )]
    async fn task_branch_checkout(
        &self,
        Parameters(args): Parameters<TaskBranchCheckoutRequest>,
    ) -> Result<CallToolResult, McpError> {
        match task_lifecycle::branch_checkout(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Review the applied task delta and persist only its SHA-256 concurrency token; the diff body is returned but not stored in lifecycle state."
    )]
    async fn task_git_review(
        &self,
        Parameters(args): Parameters<TaskIdRequest>,
    ) -> Result<CallToolResult, McpError> {
        match task_lifecycle::review(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Commit the previously reviewed task delta. The reviewed diff hash must still match; restart recovery accepts only the direct child commit of the task base on the task branch."
    )]
    async fn task_git_commit(
        &self,
        Parameters(args): Parameters<TaskCommitRequest>,
    ) -> Result<CallToolResult, McpError> {
        match task_lifecycle::commit(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Push the exact persisted task commit on its feature branch using the existing non-force push guard. Remote-SHA recovery makes retries restart-safe."
    )]
    async fn task_git_push(
        &self,
        Parameters(args): Parameters<TaskIdRequest>,
    ) -> Result<CallToolResult, McpError> {
        match task_lifecycle::push(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Optionally create one GitHub issue for a pushed task using a task-derived provider idempotency key."
    )]
    async fn task_github_issue_create(
        &self,
        Parameters(args): Parameters<TaskIssueCreateRequest>,
    ) -> Result<CallToolResult, McpError> {
        match task_lifecycle::issue_create(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Create or replay the GitHub pull request for the exact pushed task SHA and persist PR number/head state."
    )]
    async fn task_github_pull_create(
        &self,
        Parameters(args): Parameters<TaskPullCreateRequest>,
    ) -> Result<CallToolResult, McpError> {
        match task_lifecycle::pull_create(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Read the task pull request and persist its observed head SHA for resume/audit without polling in the background."
    )]
    async fn task_github_pull_get(
        &self,
        Parameters(args): Parameters<TaskIdRequest>,
    ) -> Result<CallToolResult, McpError> {
        match task_lifecycle::pull_get(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Merge the task pull request only when its current GitHub head still equals the exact SHA pushed by the task. GitHub protections remain authoritative."
    )]
    async fn task_github_pull_merge(
        &self,
        Parameters(args): Parameters<TaskPullMergeRequest>,
    ) -> Result<CallToolResult, McpError> {
        match task_lifecycle::pull_merge(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "After the task PR is merged, return to the configured default branch with fetch + fast-forward-only sync, rebuild repository intelligence, and mark lifecycle completed."
    )]
    async fn task_default_sync(
        &self,
        Parameters(args): Parameters<TaskIdRequest>,
    ) -> Result<CallToolResult, McpError> {
        match task_lifecycle::default_sync(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Return the current HEAD-aware SCIP enrichment run for a workspace. Stale enrichment is invalidated before status is returned."
    )]
    async fn scip_status(
        &self,
        Parameters(args): Parameters<WorkspaceArg>,
    ) -> Result<CallToolResult, McpError> {
        match scip_enrichment::status(&self.state, &args.workspace).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Return the operator-configured managed SCIP analyzers and bounded eligible project roots for one workspace. Executable paths and command arguments are never exposed."
    )]
    async fn scip_analyzer_status(
        &self,
        Parameters(args): Parameters<WorkspaceArg>,
    ) -> Result<CallToolResult, McpError> {
        match scip_analyzer::status(&self.state, &args.workspace).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Run one server-owned managed SCIP analyzer for a detected project root. Clients cannot supply executables or command arguments; successful output activates only through the existing exact HEAD/graph SCIP importer."
    )]
    async fn scip_analyze(
        &self,
        Parameters(args): Parameters<ScipAnalyzeRequest>,
    ) -> Result<CallToolResult, McpError> {
        match scip_analyzer::analyze(&self.state, args).await {
            Ok(v) => Self::ok(&v),
            Err(e) => Self::err(e),
        }
    }

    #[tool(
        description = "Import a bounded base64 official SCIP protobuf index for the exact clean Git HEAD and deterministic graph version. Ambiguous symbols remain unresolved and deterministic graph facts are never overwritten."
    )]
    async fn scip_import(
        &self,
        Parameters(args): Parameters<ScipImportRequest>,
    ) -> Result<CallToolResult, McpError> {
        match scip_enrichment::import(&self.state, args).await {
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
