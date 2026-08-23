use std::{collections::BTreeMap, env, time::Duration};

use rmcp::{
    ServiceExt,
    model::{CallToolRequestParams, CallToolResult, Tool},
    transport::{
        ConfigureCommandExt, StreamableHttpClientTransport, TokioChildProcess,
        streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::Map;
use tokio::{process::Command, time::timeout};

use crate::{
    error::{AppError, AppResult},
    mcp_extension_policy::ToolClassification,
    mcp_extension_registry::{
        DiscoveredTool, ExtensionAuthType, ExtensionRecord, ExtensionTransportConfig,
    },
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const LIST_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_BEARER_BYTES: usize = 16 * 1024;
const MAX_ENV_ENTRIES: usize = 32;
const MAX_ENV_VALUE_BYTES: usize = 32 * 1024;

const SAFE_CHILD_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "WINDIR",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
];

pub async fn discover_tools(
    extension: &ExtensionRecord,
    bearer: Option<&str>,
    environment: Option<&BTreeMap<String, String>>,
) -> AppResult<Vec<DiscoveredTool>> {
    validate_credential(extension, bearer)?;
    validate_environment(environment)?;
    match &extension.transport {
        ExtensionTransportConfig::Stdio { command, args } => {
            discover_stdio(extension, command, args, environment).await
        }
        ExtensionTransportConfig::StreamableHttp { url } => {
            if environment.is_some_and(|values| !values.is_empty()) {
                return Err(AppError::InvalidRequest(
                    "stdio environment material was supplied to a Streamable HTTP MCP extension".into(),
                ));
            }
            discover_http(extension, url, bearer).await
        }
    }
}

pub async fn call_tool(
    extension: &ExtensionRecord,
    tool_name: &str,
    arguments: Option<Map<String, serde_json::Value>>,
    bearer: Option<&str>,
    environment: Option<&BTreeMap<String, String>>,
) -> AppResult<CallToolResult> {
    validate_credential(extension, bearer)?;
    validate_environment(environment)?;
    match &extension.transport {
        ExtensionTransportConfig::Stdio { command, args } => {
            call_stdio(extension, command, args, tool_name, arguments, environment).await
        }
        ExtensionTransportConfig::StreamableHttp { url } => {
            if environment.is_some_and(|values| !values.is_empty()) {
                return Err(AppError::InvalidRequest(
                    "stdio environment material was supplied to a Streamable HTTP MCP extension".into(),
                ));
            }
            call_http(extension, url, tool_name, arguments, bearer).await
        }
    }
}

async fn discover_stdio(
    extension: &ExtensionRecord,
    command: &str,
    args: &[String],
    environment: Option<&BTreeMap<String, String>>,
) -> AppResult<Vec<DiscoveredTool>> {
    let transport = TokioChildProcess::new(build_command(command, args, environment))
        .map_err(|error| client_error(extension, "failed to create stdio transport", error))?;
    let client = timeout(CONNECT_TIMEOUT, ().serve(transport))
        .await
        .map_err(|_| client_timeout(extension, "stdio initialize", CONNECT_TIMEOUT))?
        .map_err(|error| client_error(extension, "stdio initialize failed", error))?;

    let tools = timeout(LIST_TIMEOUT, client.list_all_tools())
        .await
        .map_err(|_| client_timeout(extension, "tools/list", LIST_TIMEOUT))?
        .map_err(|error| client_error(extension, "tools/list failed", error));
    let _ = client.cancel().await;
    tools.map(|items| items.iter().map(discovered_tool).collect())
}

async fn call_stdio(
    extension: &ExtensionRecord,
    command: &str,
    args: &[String],
    tool_name: &str,
    arguments: Option<Map<String, serde_json::Value>>,
    environment: Option<&BTreeMap<String, String>>,
) -> AppResult<CallToolResult> {
    let transport = TokioChildProcess::new(build_command(command, args, environment))
        .map_err(|error| client_error(extension, "failed to create stdio transport", error))?;
    let client = timeout(CONNECT_TIMEOUT, ().serve(transport))
        .await
        .map_err(|_| client_timeout(extension, "stdio initialize", CONNECT_TIMEOUT))?
        .map_err(|error| client_error(extension, "stdio initialize failed", error))?;

    let request = downstream_call_request(tool_name, arguments);
    let result = timeout(CALL_TIMEOUT, client.call_tool(request))
        .await
        .map_err(|_| client_timeout(extension, "tools/call", CALL_TIMEOUT))?
        .map_err(|error| client_error(extension, "tools/call failed", error));
    let _ = client.cancel().await;
    result
}

async fn discover_http(
    extension: &ExtensionRecord,
    url: &str,
    bearer: Option<&str>,
) -> AppResult<Vec<DiscoveredTool>> {
    let transport = http_transport(url, bearer);
    let client = timeout(CONNECT_TIMEOUT, ().serve(transport))
        .await
        .map_err(|_| client_timeout(extension, "Streamable HTTP initialize", CONNECT_TIMEOUT))?
        .map_err(|error| client_error(extension, "Streamable HTTP initialize failed", error))?;

    let tools = timeout(LIST_TIMEOUT, client.list_all_tools())
        .await
        .map_err(|_| client_timeout(extension, "tools/list", LIST_TIMEOUT))?
        .map_err(|error| client_error(extension, "tools/list failed", error));
    let _ = client.cancel().await;
    tools.map(|items| items.iter().map(discovered_tool).collect())
}

async fn call_http(
    extension: &ExtensionRecord,
    url: &str,
    tool_name: &str,
    arguments: Option<Map<String, serde_json::Value>>,
    bearer: Option<&str>,
) -> AppResult<CallToolResult> {
    let transport = http_transport(url, bearer);
    let client = timeout(CONNECT_TIMEOUT, ().serve(transport))
        .await
        .map_err(|_| client_timeout(extension, "Streamable HTTP initialize", CONNECT_TIMEOUT))?
        .map_err(|error| client_error(extension, "Streamable HTTP initialize failed", error))?;

    let request = downstream_call_request(tool_name, arguments);
    let result = timeout(CALL_TIMEOUT, client.call_tool(request))
        .await
        .map_err(|_| client_timeout(extension, "tools/call", CALL_TIMEOUT))?
        .map_err(|error| client_error(extension, "tools/call failed", error));
    let _ = client.cancel().await;
    result
}

fn build_command(
    command: &str,
    args: &[String],
    environment: Option<&BTreeMap<String, String>>,
) -> Command {
    Command::new(command).configure(|cmd| {
        cmd.args(args);
        cmd.kill_on_drop(true);
        cmd.env_clear();
        for key in SAFE_CHILD_ENV {
            if let Ok(value) = env::var(key) {
                cmd.env(key, value);
            }
        }
        if let Some(values) = environment {
            for (key, value) in values {
                cmd.env(key, value);
            }
        }
    })
}

fn http_transport(
    url: &str,
    bearer: Option<&str>,
) -> StreamableHttpClientTransport<reqwest::Client> {
    let mut config = StreamableHttpClientTransportConfig::with_uri(url.to_owned());
    if let Some(token) = bearer {
        config = config.auth_header(token.to_owned());
    }
    StreamableHttpClientTransport::from_config(config)
}

fn downstream_call_request(
    tool_name: &str,
    arguments: Option<Map<String, serde_json::Value>>,
) -> CallToolRequestParams {
    let request = CallToolRequestParams::new(tool_name.to_owned());
    match arguments {
        Some(arguments) => request.with_arguments(arguments),
        None => request,
    }
}

fn discovered_tool(tool: &Tool) -> DiscoveredTool {
    let annotations = tool.annotations.as_ref();
    DiscoveredTool {
        name: tool.name.to_string(),
        description: tool.description.as_ref().map(ToString::to_string),
        input_schema: serde_json::Value::Object((*tool.input_schema).clone()),
        classification: ToolClassification {
            read_only: annotations.and_then(|value| value.read_only_hint),
            destructive: annotations.and_then(|value| value.destructive_hint),
            idempotent: annotations.and_then(|value| value.idempotent_hint),
            open_world: annotations.and_then(|value| value.open_world_hint),
        },
    }
}

fn validate_credential(extension: &ExtensionRecord, bearer: Option<&str>) -> AppResult<()> {
    if let Some(value) = bearer
        && (value.is_empty()
            || value.len() > MAX_BEARER_BYTES
            || value.chars().any(|ch| matches!(ch, '\r' | '\n' | '\0')))
    {
        return Err(AppError::InvalidRequest(
            "MCP extension bearer material is invalid".into(),
        ));
    }
    match extension.auth_type {
        ExtensionAuthType::None if bearer.is_some() => Err(AppError::InvalidRequest(
            "credential material was supplied to an MCP extension configured with auth_type none"
                .into(),
        )),
        ExtensionAuthType::None => Ok(()),
        ExtensionAuthType::Bearer | ExtensionAuthType::Oauth if bearer.is_none() => {
            Err(AppError::InvalidRequest(format!(
                "MCP extension `{}` requires credential material from secure storage",
                extension.id
            )))
        }
        ExtensionAuthType::Bearer | ExtensionAuthType::Oauth => Ok(()),
    }
}

fn validate_environment(environment: Option<&BTreeMap<String, String>>) -> AppResult<()> {
    let Some(values) = environment else {
        return Ok(());
    };
    if values.len() > MAX_ENV_ENTRIES {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension environment may contain at most {MAX_ENV_ENTRIES} entries"
        )));
    }
    for (key, value) in values {
        if !valid_env_key(key) || value.len() > MAX_ENV_VALUE_BYTES || value.contains('\0') {
            return Err(AppError::InvalidRequest(
                "MCP extension environment material is invalid".into(),
            ));
        }
    }
    Ok(())
}

fn valid_env_key(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z') | Some(b'_'))
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && value.len() <= 128
}

fn client_timeout(extension: &ExtensionRecord, operation: &str, duration: Duration) -> AppError {
    AppError::Command(format!(
        "MCP extension `{}` {operation} timed out after {} seconds",
        extension.id,
        duration.as_secs()
    ))
}

fn client_error(
    extension: &ExtensionRecord,
    operation: &str,
    error: impl std::fmt::Display,
) -> AppError {
    AppError::Command(format!(
        "MCP extension `{}` {operation}: {error}",
        extension.id
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::ToolAnnotations;
    use std::sync::Arc;

    #[test]
    fn downstream_annotations_are_only_recorded_as_hints() {
        let schema = Arc::new(
            serde_json::json!({ "type": "object" })
                .as_object()
                .expect("schema")
                .clone(),
        );
        let mut tool = Tool::new("search", "Search memory", schema);
        tool.annotations = Some(
            ToolAnnotations::new()
                .read_only(true)
                .destructive(false)
                .idempotent(true)
                .open_world(false),
        );
        let discovered = discovered_tool(&tool);
        assert_eq!(discovered.name, "search");
        assert_eq!(discovered.classification.read_only, Some(true));
        assert_eq!(discovered.classification.destructive, Some(false));
        assert_eq!(discovered.classification.idempotent, Some(true));
        assert_eq!(discovered.classification.open_world, Some(false));
    }

    #[test]
    fn rejects_unbounded_or_lowercase_materialized_environment() {
        let invalid = BTreeMap::from([("github_token".to_string(), "secret".to_string())]);
        assert!(validate_environment(Some(&invalid)).is_err());
        let valid = BTreeMap::from([("GITHUB_TOKEN".to_string(), "secret".to_string())]);
        assert!(validate_environment(Some(&valid)).is_ok());
    }
}
