use std::sync::Arc;

use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult,
        PaginatedRequestParams, ServerInfo, Tool, ToolAnnotations,
    },
    service::{NotificationContext, RequestContext},
};

#[path = "harness_approval.rs"]
pub(crate) mod harness_approval;
#[path = "harness_tool_pipeline.rs"]
pub(crate) mod harness_tool_pipeline;

use crate::{
    harness::{
        self, HarnessRunBeginRequest, HarnessRunEventsRequest, HarnessRunIdRequest,
        capability::HarnessCapabilitiesRequest,
    },
    mcp_base::SourceNerveMcp as BaseSourceNerveMcp,
    oauth::Principal,
    service::AppState,
    workspace_process::{
        WorkspaceProcessLogsRequest, WorkspaceProcessStartRequest, WorkspaceProcessStopRequest,
    },
};

const WORKSPACE_PROCESS_START_TOOL: &str = "workspace_process_start";
const WORKSPACE_PROCESS_LOGS_TOOL: &str = "workspace_process_logs";
const WORKSPACE_PROCESS_STOP_TOOL: &str = "workspace_process_stop";
const HARNESS_RUN_BEGIN_TOOL: &str = "harness_run_begin";
const HARNESS_RUN_GET_TOOL: &str = "harness_run_get";
const HARNESS_RUN_EVENTS_TOOL: &str = "harness_run_events";
const HARNESS_RUN_CANCEL_TOOL: &str = "harness_run_cancel";
const HARNESS_CAPABILITIES_TOOL: &str = "harness_capabilities";
const HARNESS_APPROVAL_RESPOND_TOOL: &str = "harness_approval_respond";

#[derive(Clone)]
pub struct SourceNerveMcp {
    inner: BaseSourceNerveMcp,
    state: AppState,
}

impl SourceNerveMcp {
    pub fn new(state: AppState) -> Self {
        Self {
            inner: BaseSourceNerveMcp::new(state.clone()),
            state,
        }
    }

    fn authorization_error(message: &str) -> CallToolResponse {
        CallToolResult::error(vec![ContentBlock::text(message)]).into()
    }

    fn request_workspace(request: &CallToolRequestParams) -> Option<String> {
        request
            .arguments
            .as_ref()
            .and_then(|arguments| arguments.get("workspace"))
            .and_then(serde_json::Value::as_str)
            .filter(|workspace| !workspace.is_empty())
            .map(ToOwned::to_owned)
    }

    fn request_run_id(request: &CallToolRequestParams) -> Option<String> {
        request
            .arguments
            .as_ref()
            .and_then(|arguments| arguments.get("run_id"))
            .and_then(serde_json::Value::as_str)
            .filter(|run_id| !run_id.is_empty())
            .map(ToOwned::to_owned)
    }

    fn request_approval_id(request: &CallToolRequestParams) -> Option<String> {
        request
            .arguments
            .as_ref()
            .and_then(|arguments| arguments.get("approval_id"))
            .and_then(serde_json::Value::as_str)
            .filter(|approval_id| !approval_id.is_empty())
            .map(ToOwned::to_owned)
    }

    fn authorize_process_call(
        &self,
        principal: &Principal,
        request: &CallToolRequestParams,
    ) -> Result<(), &'static str> {
        let workspace = Self::request_workspace(request)
            .ok_or("authorization denied: workspace process target is unavailable")?;
        match principal {
            Principal::Operator => Ok(()),
            Principal::OAuth(value) => {
                if !value.can_read(&workspace) {
                    return Err("authorization denied: workspace is not granted");
                }
                if request.name.as_ref() != WORKSPACE_PROCESS_LOGS_TOOL {
                    if !value.can_write(&workspace) {
                        return Err(
                            "authorization denied: workspace is not granted read-write access",
                        );
                    }
                    let writable = self
                        .state
                        .workspaces
                        .get(&workspace)
                        .map(|item| item.writable)
                        .unwrap_or(false);
                    if !writable {
                        return Err("authorization denied: workspace is configured read-only");
                    }
                }
                Ok(())
            }
        }
    }

    async fn harness_workspace(&self, request: &CallToolRequestParams) -> Option<String> {
        if matches!(
            request.name.as_ref(),
            HARNESS_RUN_BEGIN_TOOL | HARNESS_CAPABILITIES_TOOL
        ) {
            return Self::request_workspace(request);
        }
        if request.name.as_ref() == HARNESS_APPROVAL_RESPOND_TOOL {
            let approval_id = Self::request_approval_id(request)?;
            return sqlx::query_scalar::<_, String>(
                "SELECT workspace_id FROM harness_approvals WHERE id=?1",
            )
            .bind(approval_id)
            .fetch_optional(&self.state.db)
            .await
            .ok()
            .flatten();
        }
        let run_id = Self::request_run_id(request)?;
        sqlx::query_scalar::<_, String>("SELECT workspace_id FROM harness_runs WHERE id=?1")
            .bind(run_id)
            .fetch_optional(&self.state.db)
            .await
            .ok()
            .flatten()
    }

    async fn authorize_harness_call(
        &self,
        principal: &Principal,
        request: &CallToolRequestParams,
    ) -> Result<(), &'static str> {
        let workspace = self
            .harness_workspace(request)
            .await
            .ok_or("authorization denied: harness run target is unavailable")?;
        match principal {
            Principal::Operator => Ok(()),
            Principal::OAuth(value) if value.can_read(&workspace) => Ok(()),
            Principal::OAuth(_) => Err("authorization denied: workspace is not granted"),
        }
    }

    async fn dispatch_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let name = request.name.as_ref();
        let is_process_tool = matches!(
            name,
            WORKSPACE_PROCESS_START_TOOL
                | WORKSPACE_PROCESS_LOGS_TOOL
                | WORKSPACE_PROCESS_STOP_TOOL
        );
        let is_harness_tool = matches!(
            name,
            HARNESS_RUN_BEGIN_TOOL
                | HARNESS_RUN_GET_TOOL
                | HARNESS_RUN_EVENTS_TOOL
                | HARNESS_RUN_CANCEL_TOOL
                | HARNESS_CAPABILITIES_TOOL
                | HARNESS_APPROVAL_RESPOND_TOOL
        );
        if !is_process_tool && !is_harness_tool {
            return ServerHandler::call_tool(&self.inner, request, context).await;
        }

        let Some(principal) = request_principal(&context) else {
            return Ok(Self::authorization_error(
                "authorization denied: authenticated request context is unavailable",
            ));
        };

        if is_harness_tool {
            if let Err(message) = self.authorize_harness_call(&principal, &request).await {
                return Ok(Self::authorization_error(message));
            }
            let principal_id = harness::principal_key(&principal);
            let operator = matches!(&principal, Principal::Operator);
            return match name {
                HARNESS_CAPABILITIES_TOOL => {
                    let arguments = match local_tool_arguments::<HarnessCapabilitiesRequest>(
                        &request,
                        HARNESS_CAPABILITIES_TOOL,
                    ) {
                        Ok(value) => value,
                        Err(message) => return Ok(Self::authorization_error(&message)),
                    };
                    match harness::capability::resolve(&self.state, arguments).await {
                        Ok(response) => Ok(serialized_result(&response)),
                        Err(error) => Ok(Self::authorization_error(&format!(
                            "harness capabilities failed: {error}"
                        ))),
                    }
                }
                HARNESS_RUN_BEGIN_TOOL => {
                    let arguments = match local_tool_arguments::<HarnessRunBeginRequest>(
                        &request,
                        HARNESS_RUN_BEGIN_TOOL,
                    ) {
                        Ok(value) => value,
                        Err(message) => return Ok(Self::authorization_error(&message)),
                    };
                    match harness::begin(&self.state, arguments, &principal_id, operator).await {
                        Ok(response) => Ok(serialized_result(&response)),
                        Err(error) => Ok(Self::authorization_error(&format!(
                            "harness run begin failed: {error}"
                        ))),
                    }
                }
                HARNESS_RUN_GET_TOOL => {
                    let arguments = match local_tool_arguments::<HarnessRunIdRequest>(
                        &request,
                        HARNESS_RUN_GET_TOOL,
                    ) {
                        Ok(value) => value,
                        Err(message) => return Ok(Self::authorization_error(&message)),
                    };
                    match harness::get(&self.state, arguments, &principal_id, operator).await {
                        Ok(response) => Ok(serialized_result(&response)),
                        Err(error) => Ok(Self::authorization_error(&format!(
                            "harness run get failed: {error}"
                        ))),
                    }
                }
                HARNESS_RUN_EVENTS_TOOL => {
                    let arguments = match local_tool_arguments::<HarnessRunEventsRequest>(
                        &request,
                        HARNESS_RUN_EVENTS_TOOL,
                    ) {
                        Ok(value) => value,
                        Err(message) => return Ok(Self::authorization_error(&message)),
                    };
                    match harness::events(&self.state, arguments, &principal_id, operator).await {
                        Ok(response) => Ok(serialized_result(&response)),
                        Err(error) => Ok(Self::authorization_error(&format!(
                            "harness run events failed: {error}"
                        ))),
                    }
                }
                HARNESS_RUN_CANCEL_TOOL => {
                    let arguments = match local_tool_arguments::<HarnessRunIdRequest>(
                        &request,
                        HARNESS_RUN_CANCEL_TOOL,
                    ) {
                        Ok(value) => value,
                        Err(message) => return Ok(Self::authorization_error(&message)),
                    };
                    match harness::cancel(&self.state, arguments, &principal_id, operator).await {
                        Ok(response) => Ok(serialized_result(&response)),
                        Err(error) => Ok(Self::authorization_error(&format!(
                            "harness run cancel failed: {error}"
                        ))),
                    }
                }
                HARNESS_APPROVAL_RESPOND_TOOL => {
                    let arguments = match local_tool_arguments::<
                        harness_approval::HarnessApprovalRespondRequest,
                    >(&request, HARNESS_APPROVAL_RESPOND_TOOL)
                    {
                        Ok(value) => value,
                        Err(message) => return Ok(Self::authorization_error(&message)),
                    };
                    match harness_approval::respond(
                        &self.state,
                        arguments,
                        &principal_id,
                        operator,
                    )
                    .await
                    {
                        Ok(response) => Ok(serialized_result(&response)),
                        Err(error) => Ok(Self::authorization_error(&format!(
                            "harness approval response failed: {error}"
                        ))),
                    }
                }
                _ => unreachable!("harness tool name matched above"),
            };
        }

        if let Err(message) = self.authorize_process_call(&principal, &request) {
            return Ok(Self::authorization_error(message));
        }

        match name {
            WORKSPACE_PROCESS_START_TOOL => {
                let arguments = match local_tool_arguments::<WorkspaceProcessStartRequest>(
                    &request,
                    WORKSPACE_PROCESS_START_TOOL,
                ) {
                    Ok(value) => value,
                    Err(message) => return Ok(Self::authorization_error(&message)),
                };
                match self.state.workspace_process_start(arguments).await {
                    Ok(response) => Ok(serialized_result(&response)),
                    Err(error) => Ok(Self::authorization_error(&format!(
                        "workspace process start failed: {error}"
                    ))),
                }
            }
            WORKSPACE_PROCESS_LOGS_TOOL => {
                let arguments = match local_tool_arguments::<WorkspaceProcessLogsRequest>(
                    &request,
                    WORKSPACE_PROCESS_LOGS_TOOL,
                ) {
                    Ok(value) => value,
                    Err(message) => return Ok(Self::authorization_error(&message)),
                };
                match self.state.workspace_process_logs(arguments).await {
                    Ok(response) => Ok(serialized_result(&response)),
                    Err(error) => Ok(Self::authorization_error(&format!(
                        "workspace process logs failed: {error}"
                    ))),
                }
            }
            WORKSPACE_PROCESS_STOP_TOOL => {
                let arguments = match local_tool_arguments::<WorkspaceProcessStopRequest>(
                    &request,
                    WORKSPACE_PROCESS_STOP_TOOL,
                ) {
                    Ok(value) => value,
                    Err(message) => return Ok(Self::authorization_error(&message)),
                };
                match self.state.workspace_process_stop(arguments).await {
                    Ok(response) => Ok(serialized_result(&response)),
                    Err(error) => Ok(Self::authorization_error(&format!(
                        "workspace process stop failed: {error}"
                    ))),
                }
            }
            _ => unreachable!("workspace process tool name matched above"),
        }
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

fn response_is_success(response: &CallToolResponse) -> bool {
    match response {
        CallToolResponse::Complete(result) => result.is_error != Some(true),
        _ => true,
    }
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
        .expect("output schema must be an object")
        .clone(),
    )
}

fn with_harness_context(mut tool: Tool) -> Tool {
    let mut schema = (*tool.input_schema).clone();
    let properties = schema
        .entry("properties".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if let Some(properties) = properties.as_object_mut() {
        properties.insert(
            "_harness_run_id".to_string(),
            serde_json::json!({
                "type": ["string", "null"],
                "minLength": 1,
                "maxLength": 128,
                "default": null,
                "description": "Optional current SourceNerve Harness run to bind this execution to. The run must be owned by the authenticated principal, current, and scoped to the same workspace."
            }),
        );
    }
    tool.input_schema = Arc::new(schema);
    tool
}

fn process_tool(name: &str) -> Option<Tool> {
    let (title, description, schema, read_only, destructive, idempotent, open_world) = match name {
        WORKSPACE_PROCESS_START_TOOL => (
            "Workspace Process Start",
            "Start one bounded long-running process session inside a configured read-write workspace. The process inherits only the sanitized runtime environment used by SourceNerve workspace execution, captures bounded stdout/stderr, is limited to eight concurrent sessions, and is automatically killed after six hours. Use workspace_process_logs to inspect it and workspace_process_stop when finished.",
            serde_json::json!({
                "type": "object",
                "required": ["workspace", "program"],
                "properties": {
                    "workspace": { "type": "string", "minLength": 1 },
                    "program": { "type": "string", "minLength": 1, "maxLength": 512 },
                    "args": { "type": "array", "items": { "type": "string" }, "maxItems": 256, "default": [] },
                    "cwd": { "type": ["string", "null"], "default": null },
                    "request_id": { "type": ["string", "null"], "maxLength": 128, "default": null }
                },
                "additionalProperties": false
            }),
            false,
            true,
            false,
            true,
        ),
        WORKSPACE_PROCESS_LOGS_TOOL => (
            "Workspace Process Logs",
            "Read a bounded tail of stdout/stderr for one workspace process session. The session must belong to the requested workspace. This does not execute a new command.",
            serde_json::json!({
                "type": "object",
                "required": ["workspace", "session_id"],
                "properties": {
                    "workspace": { "type": "string", "minLength": 1 },
                    "session_id": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "tail_bytes": { "type": "integer", "minimum": 1, "maximum": 1000000, "default": 65536 }
                },
                "additionalProperties": false
            }),
            true,
            false,
            true,
            false,
        ),
        WORKSPACE_PROCESS_STOP_TOOL => (
            "Workspace Process Stop",
            "Stop and reap one previously started workspace process session. The session must belong to the requested read-write workspace. Stopping a session also removes it from the in-memory session registry.",
            serde_json::json!({
                "type": "object",
                "required": ["workspace", "session_id"],
                "properties": {
                    "workspace": { "type": "string", "minLength": 1 },
                    "session_id": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "request_id": { "type": ["string", "null"], "maxLength": 128, "default": null }
                },
                "additionalProperties": false
            }),
            false,
            true,
            false,
            false,
        ),
        _ => return None,
    };
    let mut tool = Tool::new(
        name.to_owned(),
        description,
        Arc::new(schema.as_object()?.clone()),
    );
    tool.title = Some(title.to_owned());
    tool.output_schema = Some(output_schema(name));
    tool.annotations = Some(
        ToolAnnotations::with_title(title)
            .read_only(read_only)
            .destructive(destructive)
            .idempotent(idempotent)
            .open_world(open_world),
    );
    Some(tool)
}

fn harness_tool(name: &str) -> Option<Tool> {
    let (title, description, schema, read_only, destructive, idempotent) = match name {
        HARNESS_RUN_BEGIN_TOOL => (
            "Harness Run Begin",
            "Begin a durable SourceNerve Harness execution run for one authorized workspace. The run snapshots Git HEAD, graph/index state, and the profile-resolved capability registry so later changes are surfaced as stale. client_request_id provides idempotent replay when supplied.",
            serde_json::json!({
                "type": "object",
                "required": ["workspace"],
                "properties": {
                    "workspace": { "type": "string", "minLength": 1 },
                    "profile": { "type": "string", "enum": ["read-only-analysis", "interactive-local", "guarded-durable", "background-job", "webhook-automation"], "default": "interactive-local" },
                    "client_request_id": { "type": ["string", "null"], "maxLength": 128, "default": null }
                },
                "additionalProperties": false
            }),
            false,
            false,
            false,
        ),
        HARNESS_RUN_GET_TOOL => (
            "Harness Run Get",
            "Return one durable Harness run owned by the authenticated principal, together with current freshness against Git HEAD, graph/index state, and the same profile-resolved capability registry.",
            serde_json::json!({ "type": "object", "required": ["run_id"], "properties": { "run_id": { "type": "string", "minLength": 1, "maxLength": 128 } }, "additionalProperties": false }),
            true,
            false,
            true,
        ),
        HARNESS_RUN_EVENTS_TOOL => (
            "Harness Run Events",
            "Read a bounded ordered page of safe persisted Harness execution events for one owned run. Event payloads contain execution metadata only, not OAuth/provider secrets or arbitrary raw tool results.",
            serde_json::json!({ "type": "object", "required": ["run_id"], "properties": { "run_id": { "type": "string", "minLength": 1, "maxLength": 128 }, "after_seq": { "type": ["integer", "null"], "minimum": -1, "default": null }, "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 100 } }, "additionalProperties": false }),
            true,
            false,
            true,
        ),
        HARNESS_RUN_CANCEL_TOOL => (
            "Harness Run Cancel",
            "Cancel one running or stale Harness run owned by the authenticated principal. Cancellation is idempotent for already-terminal runs and records a durable run/cancelled event when it changes state.",
            serde_json::json!({ "type": "object", "required": ["run_id"], "properties": { "run_id": { "type": "string", "minLength": 1, "maxLength": 128 } }, "additionalProperties": false }),
            false,
            true,
            true,
        ),
        HARNESS_CAPABILITIES_TOOL => (
            "Harness Capabilities",
            "Resolve the current SourceNerve Harness capability registry for one authorized workspace and built-in profile. Returns deterministic namespaced core, plugin-skill, and enabled MCP-extension tool capabilities with effective allow/ask/deny policy. This is composition metadata, not an authorization grant.",
            serde_json::json!({ "type": "object", "required": ["workspace"], "properties": { "workspace": { "type": "string", "minLength": 1 }, "profile": { "type": "string", "enum": ["read-only-analysis", "interactive-local", "guarded-durable", "background-job", "webhook-automation"], "default": "interactive-local" } }, "additionalProperties": false }),
            true,
            false,
            true,
        ),
        HARNESS_APPROVAL_RESPOND_TOOL => (
            "Harness Approval Respond",
            "Resolve one pending Harness approval with allow or deny. The approval is bound to the exact run, workspace, tool, argument SHA-256, and Git HEAD that requested it. Allowed approvals are one-shot and expire after a short bounded TTL; changed arguments require a new approval.",
            serde_json::json!({
                "type": "object",
                "required": ["approval_id", "decision"],
                "properties": {
                    "approval_id": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "decision": { "type": "string", "enum": ["allow", "deny"] }
                },
                "additionalProperties": false
            }),
            false,
            false,
            true,
        ),
        _ => return None,
    };
    let mut tool = Tool::new(
        name.to_owned(),
        description,
        Arc::new(schema.as_object()?.clone()),
    );
    tool.title = Some(title.to_owned());
    tool.output_schema = Some(output_schema(name));
    tool.annotations = Some(
        ToolAnnotations::with_title(title)
            .read_only(read_only)
            .destructive(destructive)
            .idempotent(idempotent)
            .open_world(false),
    );
    Some(tool)
}

fn process_tools_for(principal: &Principal) -> Vec<Tool> {
    let names: &[&str] = match principal {
        Principal::Operator => &[
            WORKSPACE_PROCESS_START_TOOL,
            WORKSPACE_PROCESS_LOGS_TOOL,
            WORKSPACE_PROCESS_STOP_TOOL,
        ],
        Principal::OAuth(value) if value.has_any_write() => &[
            WORKSPACE_PROCESS_START_TOOL,
            WORKSPACE_PROCESS_LOGS_TOOL,
            WORKSPACE_PROCESS_STOP_TOOL,
        ],
        Principal::OAuth(_) => &[WORKSPACE_PROCESS_LOGS_TOOL],
    };
    names.iter().filter_map(|name| process_tool(name)).collect()
}

fn harness_tools() -> Vec<Tool> {
    [
        HARNESS_RUN_BEGIN_TOOL,
        HARNESS_RUN_GET_TOOL,
        HARNESS_RUN_EVENTS_TOOL,
        HARNESS_RUN_CANCEL_TOOL,
        HARNESS_CAPABILITIES_TOOL,
        HARNESS_APPROVAL_RESPOND_TOOL,
    ]
    .into_iter()
    .filter_map(harness_tool)
    .collect()
}

fn local_tool_arguments<T: serde::de::DeserializeOwned>(
    request: &CallToolRequestParams,
    name: &str,
) -> Result<T, String> {
    let arguments = request
        .arguments
        .as_ref()
        .ok_or_else(|| format!("{name} requires arguments"))?;
    serde_json::from_value(serde_json::Value::Object(arguments.clone()))
        .map_err(|error| format!("invalid {name} arguments: {error}"))
}

impl ServerHandler for SourceNerveMcp {
    fn get_info(&self) -> ServerInfo {
        ServerHandler::get_info(&self.inner)
    }

    async fn on_initialized(&self, context: NotificationContext<RoleServer>) {
        ServerHandler::on_initialized(&self.inner, context).await;
    }

    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let principal = request_principal(&context);
        let mut result = ServerHandler::list_tools(&self.inner, request, context).await?;
        if let Some(principal) = principal {
            result.tools.extend(process_tools_for(&principal));
            result.tools.extend(harness_tools());
            result.tools = result.tools.into_iter().map(with_harness_context).collect();
        }
        Ok(result)
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        harness_tool(name)
            .or_else(|| process_tool(name))
            .or_else(|| ServerHandler::get_tool(&self.inner, name))
            .map(with_harness_context)
    }

    async fn call_tool(
        &self,
        mut request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let Some(principal) = request_principal(&context) else {
            return Ok(Self::authorization_error(
                "authorization denied: authenticated request context is unavailable",
            ));
        };

        let execution = match harness_tool_pipeline::begin(&self.state, &principal, &request).await
        {
            Ok(execution) => execution,
            Err(error) => {
                return Ok(Self::authorization_error(&format!(
                    "harness tool pipeline denied execution: {error}"
                )));
            }
        };
        harness_tool_pipeline::strip_harness_context(&mut request);

        let response = self.dispatch_tool(request, context).await;
        match &response {
            Ok(value) => {
                let success = response_is_success(value);
                if let Err(error) = execution
                    .finish(
                        &self.state,
                        success,
                        if success { None } else { Some("tool-error") },
                    )
                    .await
                {
                    return Ok(Self::authorization_error(&format!(
                        "harness tool pipeline audit failed: {error}"
                    )));
                }
            }
            Err(_) => {
                if let Err(error) = execution
                    .finish(&self.state, false, Some("protocol-error"))
                    .await
                {
                    tracing::warn!(error = %error, "failed to persist Harness tool execution failure");
                }
            }
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_tools_publish_bounded_schemas_and_conservative_annotations() {
        let start = process_tool(WORKSPACE_PROCESS_START_TOOL).expect("start tool");
        let logs = process_tool(WORKSPACE_PROCESS_LOGS_TOOL).expect("logs tool");
        let stop = process_tool(WORKSPACE_PROCESS_STOP_TOOL).expect("stop tool");
        assert_eq!(
            start
                .annotations
                .as_ref()
                .and_then(|value| value.read_only_hint),
            Some(false)
        );
        assert_eq!(
            start
                .annotations
                .as_ref()
                .and_then(|value| value.open_world_hint),
            Some(true)
        );
        assert_eq!(
            logs.annotations
                .as_ref()
                .and_then(|value| value.read_only_hint),
            Some(true)
        );
        assert_eq!(
            logs.input_schema["properties"]["tail_bytes"]["maximum"],
            1_000_000
        );
        assert_eq!(
            stop.annotations
                .as_ref()
                .and_then(|value| value.destructive_hint),
            Some(true)
        );
    }

    #[test]
    fn harness_tools_publish_stable_bounded_schemas() {
        let begin = with_harness_context(harness_tool(HARNESS_RUN_BEGIN_TOOL).expect("begin"));
        let events = with_harness_context(harness_tool(HARNESS_RUN_EVENTS_TOOL).expect("events"));
        let capabilities =
            with_harness_context(harness_tool(HARNESS_CAPABILITIES_TOOL).expect("capabilities"));
        let approval = with_harness_context(
            harness_tool(HARNESS_APPROVAL_RESPOND_TOOL).expect("approval respond"),
        );
        assert_eq!(
            begin.input_schema["properties"]["client_request_id"]["maxLength"],
            128
        );
        assert_eq!(events.input_schema["properties"]["limit"]["maximum"], 200);
        assert_eq!(
            capabilities.input_schema["properties"]["profile"]["default"],
            "interactive-local"
        );
        assert_eq!(
            capabilities.input_schema["properties"]["_harness_run_id"]["maxLength"],
            128
        );
        assert_eq!(
            approval.input_schema["properties"]["decision"]["enum"],
            serde_json::json!(["allow", "deny"])
        );
    }
}
