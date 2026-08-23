use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use rmcp::{
    ErrorData as McpError, Peer, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Icon,
        Implementation, ListToolsResult, PaginatedRequestParams, ServerInfo, Tool, ToolAnnotations,
    },
    service::{NotificationContext, RequestContext},
};

use crate::{
    mcp_core::SourceNerveMcp as CoreSourceNerveMcp,
    mcp_gateway,
    oauth::{GrantAccess, Principal},
    service::AppState,
};

const SERVER_INSTRUCTIONS: &str = "\
SourceNerve provides guarded repository intelligence, controlled mutation, and policy-gated MCP extension tools. \
Third-party MCP tools are exposed only when enabled by SourceNerve policy and are always routed through the SourceNerve gateway. \
For ALL SourceNerve repository modifications, writes, or code updates, you MUST use the guarded Task Lifecycle. \
Direct patch application (such as `patch_apply`) is disabled on this server. \
To write code, run these steps sequentially: \
1. Call `task_begin` to initiate a task. \
2. Call `task_branch_checkout` to prepare the target branch. \
3. Call `task_propose_patch` with your code changes. \
4. Call `task_apply_patch` to apply and persist the changes. \
Never attempt to write or modify SourceNerve-managed repository files without this flow.";
const SERVER_WEBSITE_URL: &str = "https://sourcenerve.fogewise.io.vn/";
const SERVER_ICON_URL: &str = "https://raw.githubusercontent.com/khovan123/SourceNerve/main/plugins/sourcenerve/assets/icon.png";

#[derive(Clone)]
pub struct SourceNerveMcp {
    inner: CoreSourceNerveMcp,
    state: AppState,
    tool_list_peer_registered: Arc<AtomicBool>,
}

impl SourceNerveMcp {
    pub fn new(state: AppState) -> Self {
        Self {
            inner: CoreSourceNerveMcp::new(state.clone()),
            state,
            tool_list_peer_registered: Arc::new(AtomicBool::new(false)),
        }
    }

    async fn register_tool_list_peer_once(&self, peer: Peer<RoleServer>) {
        if self
            .tool_list_peer_registered
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            crate::mcp_extension_http::register_tool_list_peer(peer).await;
        }
    }

    fn authorization_error(message: &str) -> CallToolResponse {
        CallToolResult::error(vec![ContentBlock::text(message)]).into()
    }

    async fn task_workspace(&self, task_id: &str) -> Option<String> {
        sqlx::query_scalar::<_, String>("SELECT workspace_id FROM tasks WHERE id = ?")
            .bind(task_id)
            .fetch_optional(&self.state.db)
            .await
            .ok()
            .flatten()
    }

    async fn job_workspace(&self, job_id: &str) -> Option<String> {
        sqlx::query_scalar::<_, String>("SELECT workspace_id FROM jobs WHERE id = ?")
            .bind(job_id)
            .fetch_optional(&self.state.db)
            .await
            .ok()
            .flatten()
    }

    async fn request_workspace(&self, request: &CallToolRequestParams) -> Option<String> {
        if let Some(workspace) = request
            .arguments
            .as_ref()
            .and_then(|arguments| arguments.get("workspace"))
            .and_then(serde_json::Value::as_str)
        {
            return Some(workspace.to_owned());
        }
        if let Some(task_id) = request
            .arguments
            .as_ref()
            .and_then(|arguments| arguments.get("task_id"))
            .and_then(serde_json::Value::as_str)
        {
            return self.task_workspace(task_id).await;
        }
        if let Some(job_id) = request
            .arguments
            .as_ref()
            .and_then(|arguments| arguments.get("job_id"))
            .and_then(serde_json::Value::as_str)
        {
            return self.job_workspace(job_id).await;
        }
        None
    }

    async fn authorize_oauth_call(
        &self,
        principal: &crate::oauth::OAuthPrincipal,
        request: &CallToolRequestParams,
    ) -> Result<(), &'static str> {
        let name = request.name.as_ref();
        if matches!(name, "service_status" | "readiness" | "workspace_list") {
            return Ok(());
        }
        if name == "patch_apply" {
            return Err(
                "SourceNerve forbids direct patch application for security. Please use the guarded Task Lifecycle instead: call `task_begin` -> `task_branch_checkout` -> `task_propose_patch` -> `task_apply_patch`.",
            );
        }
        if matches!(name, "state_backup_create" | "state_backup_validate") {
            return Err("authorization denied: state backup tools are operator-only");
        }
        let policy = explicit_tool_policy(name)
            .ok_or("authorization denied: tool is not classified for OAuth access")?;
        let workspace = self
            .request_workspace(request)
            .await
            .ok_or("authorization denied: tool target is unavailable")?;
        if !principal.can_read(&workspace) {
            return Err("authorization denied: workspace is not granted");
        }
        if !policy.read_only {
            if !principal.can_write(&workspace) {
                return Err("authorization denied: workspace is not granted read-write access");
            }
            let configured_writable = self
                .state
                .workspaces
                .get(&workspace)
                .map(|item| item.writable)
                .unwrap_or(false);
            if !configured_writable {
                return Err("authorization denied: workspace is configured read-only");
            }
        }
        Ok(())
    }

    async fn oauth_workspace_list(
        &self,
        principal: &crate::oauth::OAuthPrincipal,
    ) -> CallToolResponse {
        if std::env::var("SOURCENERVE_DEBUG_AUTH").is_ok() {
            tracing::info!(
                "DEBUG: listing workspaces. Principal scopes: {:?}, grants: {:?}",
                principal.scopes,
                principal.grants
            );
        }
        match self.state.list_workspaces().await {
            Ok(mut workspaces) => {
                workspaces.retain(|item| {
                    let can_read = principal.can_read(&item.id);
                    if std::env::var("SOURCENERVE_DEBUG_AUTH").is_ok() {
                        tracing::info!("DEBUG: workspace '{}' can_read = {}", item.id, can_read);
                    }
                    can_read
                });
                for workspace in &mut workspaces {
                    workspace.writable = workspace.writable
                        && principal.workspace_access(&workspace.id)
                            == Some(GrantAccess::ReadWrite)
                        && principal.can_write(&workspace.id);
                }
                serialized_result(&workspaces)
            }
            Err(_) => Self::authorization_error("workspace listing failed"),
        }
    }

    async fn oauth_readiness(&self, principal: &crate::oauth::OAuthPrincipal) -> CallToolResponse {
        let mut report = self.state.readiness().await;
        report
            .workspaces
            .retain(|workspace| principal.can_read(&workspace.workspace));
        serialized_result(&report)
    }
}

fn request_principal(context: &RequestContext<RoleServer>) -> Option<Principal> {
    context
        .extensions
        .get::<axum::http::request::Parts>()
        .and_then(|parts| parts.extensions.get::<Principal>())
        .cloned()
}

fn serialized_result<T: serde::Serialize>(value: &T) -> CallToolResponse {
    match serde_json::to_value(value) {
        Ok(structured) => match serde_json::to_string_pretty(&structured) {
            Ok(text) => {
                let mut result = CallToolResult::success(vec![ContentBlock::text(text)]);
                result.structured_content = Some(structured);
                result.into()
            }
            Err(_) => {
                CallToolResult::error(vec![ContentBlock::text("serialization failed")]).into()
            }
        },
        Err(_) => CallToolResult::error(vec![ContentBlock::text("serialization failed")]).into(),
    }
}

fn ensure_structured_content(response: CallToolResponse) -> CallToolResponse {
    match response {
        CallToolResponse::Complete(mut result) => {
            if result.is_error != Some(true) && result.structured_content.is_none() {
                result.structured_content = result
                    .content
                    .iter()
                    .find_map(ContentBlock::as_text)
                    .and_then(|text| serde_json::from_str(&text.text).ok());
            }
            CallToolResponse::Complete(result)
        }
        other => other,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ToolPolicy {
    read_only: bool,
    destructive: bool,
    idempotent: bool,
    open_world: bool,
}

const fn policy(
    read_only: bool,
    destructive: bool,
    idempotent: bool,
    open_world: bool,
) -> ToolPolicy {
    ToolPolicy {
        read_only,
        destructive,
        idempotent,
        open_world,
    }
}

const CONSERVATIVE_POLICY: ToolPolicy = policy(false, true, false, true);

fn explicit_tool_policy(name: &str) -> Option<ToolPolicy> {
    let value = match name {
        "service_status"
        | "readiness"
        | "state_backup_validate"
        | "mutation_audit"
        | "workspace_list"
        | "memory_search"
        | "semantic_search"
        | "architecture_map"
        | "architecture_cluster"
        | "job_get"
        | "graph_status"
        | "symbol_search"
        | "symbol_context"
        | "trace_callers"
        | "trace_callees"
        | "references"
        | "impact_analysis"
        | "repo_snapshot"
        | "search_code"
        | "read_file"
        | "git_diff"
        | "git_review"
        | "patch_preview"
        | "scip_status"
        | "scip_analyzer_status" => policy(true, false, true, false),
        "semantic_search_text" | "context_pack" | "github_pull_get" => {
            policy(true, false, true, true)
        }
        "state_backup_create" => policy(false, false, false, false),
        "workspace_index" | "semantic_import" | "architecture_rebuild" | "scip_import" => {
            policy(false, false, true, false)
        }
        "scip_analyze" => policy(false, false, false, false),
        "semantic_provider_index" => policy(false, false, true, true),
        "task_begin" | "task_propose_patch" => policy(false, false, false, false),
        "task_get" | "task_git_review" => policy(false, false, true, false),
        "task_cancel" => policy(false, true, false, false),
        "task_apply_patch" => policy(false, true, false, false),
        "task_branch_checkout" | "task_git_commit" => policy(false, false, true, false),
        "task_git_push" | "task_default_sync" => policy(false, false, true, true),
        "task_github_issue_create"
        | "task_github_pull_create"
        | "task_provider_issue_create"
        | "task_provider_pull_create" => policy(false, false, true, true),
        "task_github_pull_get" | "task_provider_pull_get" => policy(false, false, true, true),
        "task_github_pull_merge" | "task_provider_pull_merge" => policy(false, true, true, true),
        "git_branch_checkout" | "git_commit" => policy(false, false, false, false),
        "git_push" | "git_default_sync" => policy(false, false, true, true),
        "github_issue_create" | "github_pull_create" => policy(false, false, false, true),
        "github_pull_merge" => policy(false, true, false, true),
        "patch_apply" => policy(false, true, false, false),
        _ => return None,
    };
    Some(value)
}

fn tool_policy(name: &str) -> ToolPolicy {
    explicit_tool_policy(name).unwrap_or(CONSERVATIVE_POLICY)
}

fn human_title(name: &str) -> String {
    name.split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn output_schema(tool_name: &str) -> Arc<serde_json::Map<String, serde_json::Value>> {
    Arc::new(
        serde_json::json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "description": format!(
                "Structured JSON result returned by the SourceNerve `{tool_name}` tool."
            ),
            "oneOf": [
                { "type": "object" },
                { "type": "array" },
                { "type": "string" },
                { "type": "number" },
                { "type": "boolean" },
                { "type": "null" }
            ]
        })
        .as_object()
        .expect("output schema must be a JSON object")
        .clone(),
    )
}

fn annotate_tool(mut tool: Tool) -> Tool {
    let tool_name = tool.name.as_ref();
    let policy = tool_policy(tool_name);
    let title = human_title(tool_name);
    tool.title = Some(title.clone());
    tool.output_schema = Some(output_schema(tool_name));
    tool.annotations = Some(
        ToolAnnotations::with_title(title)
            .read_only(policy.read_only)
            .destructive(policy.destructive)
            .idempotent(policy.idempotent)
            .open_world(policy.open_world),
    );
    tool
}

impl ServerHandler for SourceNerveMcp {
    fn get_info(&self) -> ServerInfo {
        let mut info = self.inner.get_info();
        info.capabilities
            .tools
            .get_or_insert_with(Default::default)
            .list_changed = Some(true);
        info.with_server_info(
            Implementation::new("sourcenerve", env!("CARGO_PKG_VERSION"))
                .with_title("SourceNerve")
                .with_description(
                    "Persistent repository intelligence, guarded workflows, and controlled MCP extension routing",
                )
                .with_website_url(SERVER_WEBSITE_URL)
                .with_icons(vec![Icon::new(SERVER_ICON_URL).with_mime_type("image/png")]),
        )
        .with_instructions(SERVER_INSTRUCTIONS)
    }

    async fn on_initialized(&self, context: NotificationContext<RoleServer>) {
        self.register_tool_list_peer_once(context.peer).await;
    }

    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        self.register_tool_list_peer_once(context.peer.clone())
            .await;
        let mut result = self.inner.list_tools(request, context.clone()).await?;
        result.tools = result.tools.into_iter().map(annotate_tool).collect();
        let principal = request_principal(&context);
        match &principal {
            Some(Principal::Operator) => {}
            Some(Principal::OAuth(principal)) => {
                result.tools.retain(|tool| {
                    let name = tool.name.as_ref();
                    if matches!(name, "state_backup_create" | "state_backup_validate") {
                        return false;
                    }
                    let policy = tool_policy(name);
                    policy.read_only || principal.has_any_write()
                });
            }
            None => result.tools.clear(),
        }

        if let Some(principal) = principal {
            let mut extension_tools = mcp_gateway::list_tools(&self.state.db, &principal)
                .await
                .map_err(|error| {
                    McpError::internal_error(
                        format!("MCP extension gateway tool discovery failed: {error}"),
                        None,
                    )
                })?;
            result.tools.append(&mut extension_tools);
        }
        Ok(result)
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.inner.get_tool(name).map(annotate_tool)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let Some(principal) = request_principal(&context) else {
            return Ok(Self::authorization_error(
                "authorization denied: authenticated request context is unavailable",
            ));
        };

        match mcp_gateway::try_call(&self.state, &principal, &request).await {
            Ok(Some(response)) => return Ok(response),
            Ok(None) => {}
            Err(error) => {
                return Ok(Self::authorization_error(&format!(
                    "MCP extension gateway failed: {error}"
                )));
            }
        }

        match &principal {
            Principal::Operator => self
                .inner
                .call_tool(request, context)
                .await
                .map(ensure_structured_content),
            Principal::OAuth(oauth_principal) => {
                if let Err(message) = self.authorize_oauth_call(oauth_principal, &request).await {
                    return Ok(Self::authorization_error(message));
                }
                match request.name.as_ref() {
                    "workspace_list" => Ok(self.oauth_workspace_list(oauth_principal).await),
                    "readiness" => Ok(self.oauth_readiness(oauth_principal).await),
                    _ => self
                        .inner
                        .call_tool(request, context)
                        .await
                        .map(ensure_structured_content),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::*;
    use crate::oauth::{OAuthPrincipal, READ_SCOPE, WRITE_SCOPE};

    const PUBLIC_TOOL_NAMES: &[&str] = &[
        "service_status",
        "readiness",
        "state_backup_create",
        "state_backup_validate",
        "mutation_audit",
        "workspace_list",
        "workspace_index",
        "memory_search",
        "semantic_import",
        "semantic_search",
        "semantic_provider_index",
        "semantic_search_text",
        "architecture_rebuild",
        "architecture_map",
        "architecture_cluster",
        "context_pack",
        "job_get",
        "task_begin",
        "task_get",
        "task_cancel",
        "task_propose_patch",
        "task_apply_patch",
        "task_branch_checkout",
        "task_git_review",
        "task_git_commit",
        "task_git_push",
        "task_github_issue_create",
        "task_github_pull_create",
        "task_github_pull_get",
        "task_github_pull_merge",
        "task_provider_issue_create",
        "task_provider_pull_create",
        "task_provider_pull_get",
        "task_provider_pull_merge",
        "task_default_sync",
        "scip_status",
        "scip_analyzer_status",
        "scip_analyze",
        "scip_import",
        "graph_status",
        "symbol_search",
        "symbol_context",
        "trace_callers",
        "trace_callees",
        "references",
        "impact_analysis",
        "repo_snapshot",
        "search_code",
        "read_file",
        "git_diff",
        "git_review",
        "git_branch_checkout",
        "git_default_sync",
        "git_commit",
        "git_push",
        "github_issue_create",
        "github_pull_create",
        "github_pull_get",
        "github_pull_merge",
        "patch_preview",
        "patch_apply",
    ];

    fn principal(access: GrantAccess, write_scope: bool) -> OAuthPrincipal {
        let mut scopes = HashSet::from([READ_SCOPE.to_string()]);
        if write_scope {
            scopes.insert(WRITE_SCOPE.to_string());
        }
        OAuthPrincipal::from_parts_for_test(
            scopes,
            HashMap::from([("workspace-a".to_string(), access)]),
        )
    }

    #[test]
    fn current_public_tools_have_explicit_policies() {
        for name in PUBLIC_TOOL_NAMES {
            assert!(
                explicit_tool_policy(name).is_some(),
                "tool {name} must have an explicit safety policy"
            );
        }
    }

    #[test]
    fn output_schema_is_published_for_every_public_tool() {
        let input_schema = Arc::new(
            serde_json::json!({ "type": "object" })
                .as_object()
                .expect("input schema")
                .clone(),
        );
        for name in PUBLIC_TOOL_NAMES {
            let tool = Tool::new(*name, "test tool", input_schema.clone());
            let decorated = annotate_tool(tool);
            assert!(
                decorated.output_schema.is_some(),
                "tool {name} must publish outputSchema"
            );
        }
    }

    #[test]
    fn serialized_results_include_structured_content() {
        let response = serialized_result(&serde_json::json!({ "ok": true }));
        match response {
            CallToolResponse::Complete(result) => {
                assert_eq!(
                    result.structured_content,
                    Some(serde_json::json!({ "ok": true }))
                );
            }
            _ => panic!("serialized result must complete synchronously"),
        }
    }

    #[test]
    fn legacy_json_text_results_are_promoted_to_structured_content() {
        let response: CallToolResponse =
            CallToolResult::success(vec![ContentBlock::text("{\"workspace\":\"workspace-a\"}")])
                .into();
        match ensure_structured_content(response) {
            CallToolResponse::Complete(result) => {
                assert_eq!(
                    result.structured_content,
                    Some(serde_json::json!({ "workspace": "workspace-a" }))
                );
            }
            _ => panic!("tool result must complete synchronously"),
        }
    }

    #[test]
    fn mutation_and_provider_policies_are_conservative() {
        assert_eq!(tool_policy("read_file"), policy(true, false, true, false));
        assert_eq!(
            tool_policy("github_pull_get"),
            policy(true, false, true, true)
        );
        assert_eq!(
            tool_policy("patch_apply"),
            policy(false, true, false, false)
        );
        assert_eq!(
            tool_policy("github_pull_merge"),
            policy(false, true, false, true)
        );
        assert_eq!(
            tool_policy("task_provider_pull_merge"),
            policy(false, true, true, true)
        );
    }

    #[test]
    fn oauth_read_only_and_read_write_grants_are_distinct() {
        let read_only = principal(GrantAccess::ReadOnly, true);
        assert!(read_only.can_read("workspace-a"));
        assert!(!read_only.can_write("workspace-a"));
        let read_write_without_scope = principal(GrantAccess::ReadWrite, false);
        assert!(read_write_without_scope.can_read("workspace-a"));
        assert!(!read_write_without_scope.can_write("workspace-a"));
        let read_write = principal(GrantAccess::ReadWrite, true);
        assert!(read_write.can_write("workspace-a"));
        assert!(!read_write.can_read("workspace-b"));
    }

    #[test]
    fn unknown_tool_metadata_fails_conservative() {
        assert!(explicit_tool_policy("future_unclassified_tool").is_none());
        assert_eq!(tool_policy("future_unclassified_tool"), CONSERVATIVE_POLICY);
    }

    #[test]
    fn titles_are_human_readable() {
        assert_eq!(
            human_title("task_provider_pull_merge"),
            "Task Provider Pull Merge"
        );
    }
}
