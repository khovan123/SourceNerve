use std::sync::Arc;

use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult,
        PaginatedRequestParams, ServerInfo, Tool, ToolAnnotations,
    },
    service::{NotificationContext, RequestContext},
};

use crate::{
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
                    "args": {
                        "type": "array",
                        "items": { "type": "string" },
                        "maxItems": 256,
                        "default": []
                    },
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
                    "tail_bytes": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 1000000,
                        "default": 65536
                    }
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
        }
        Ok(result)
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        process_tool(name).or_else(|| ServerHandler::get_tool(&self.inner, name))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        if !matches!(
            request.name.as_ref(),
            WORKSPACE_PROCESS_START_TOOL
                | WORKSPACE_PROCESS_LOGS_TOOL
                | WORKSPACE_PROCESS_STOP_TOOL
        ) {
            return ServerHandler::call_tool(&self.inner, request, context).await;
        }

        let Some(principal) = request_principal(&context) else {
            return Ok(Self::authorization_error(
                "authorization denied: authenticated request context is unavailable",
            ));
        };
        if let Err(message) = self.authorize_process_call(&principal, &request) {
            return Ok(Self::authorization_error(message));
        }

        match request.name.as_ref() {
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
}
