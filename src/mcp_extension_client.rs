use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, OnceLock},
    time::Duration,
};

mod sandbox;

use rmcp::{
    RoleClient, ServiceExt,
    model::{CallToolRequestParams, CallToolResult, Tool},
    service::RunningService,
    transport::{
        StreamableHttpClientTransport, TokioChildProcess,
        streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::Map;
use sha2::{Digest, Sha256};
use tokio::{sync::Mutex, time::timeout};

use crate::{
    error::{AppError, AppResult},
    mcp_extension_policy::{ToolClassification, resolve_tool_classification},
    mcp_extension_registry::{
        DiscoveredTool, ExtensionAuthType, ExtensionRecord, ExtensionTransportConfig,
    },
    mcp_extension_runtime::{self, RuntimeLease, RuntimeState},
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const LIST_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_BEARER_BYTES: usize = 16 * 1024;
const MAX_ENV_ENTRIES: usize = 32;
const MAX_ENV_VALUE_BYTES: usize = 32 * 1024;

type PersistentStdioClient = RunningService<RoleClient, ()>;

struct PersistentStdioSession {
    config_hash: String,
    client: PersistentStdioClient,
}

type PersistentStdioSlot = Arc<Mutex<Option<PersistentStdioSession>>>;

static PERSISTENT_STDIO_SESSIONS: OnceLock<Mutex<HashMap<String, PersistentStdioSlot>>> =
    OnceLock::new();

fn persistent_stdio_sessions() -> &'static Mutex<HashMap<String, PersistentStdioSlot>> {
    PERSISTENT_STDIO_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn persistent_stdio_slot(extension_id: &str) -> PersistentStdioSlot {
    let mut sessions = persistent_stdio_sessions().lock().await;
    sessions
        .entry(extension_id.to_owned())
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone()
}

pub async fn discover_tools(
    extension: &ExtensionRecord,
    bearer: Option<&str>,
    environment: Option<&BTreeMap<String, String>>,
) -> AppResult<Vec<DiscoveredTool>> {
    validate_credential(extension, bearer)?;
    validate_environment(environment)?;
    let lease = mcp_extension_runtime::acquire(&extension.id).await?;
    match &extension.transport {
        ExtensionTransportConfig::Stdio { command, args } => {
            discover_stdio(extension, command, args, environment, &lease).await
        }
        ExtensionTransportConfig::StreamableHttp { url } => {
            if environment.is_some_and(|values| !values.is_empty()) {
                return Err(AppError::InvalidRequest(
                    "stdio environment material was supplied to a Streamable HTTP MCP extension"
                        .into(),
                ));
            }
            discover_http(extension, url, bearer, &lease).await
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
    let lease = mcp_extension_runtime::acquire(&extension.id).await?;
    match &extension.transport {
        ExtensionTransportConfig::Stdio { command, args } => {
            call_stdio(
                extension,
                command,
                args,
                tool_name,
                arguments,
                environment,
                &lease,
            )
            .await
        }
        ExtensionTransportConfig::StreamableHttp { url } => {
            if environment.is_some_and(|values| !values.is_empty()) {
                return Err(AppError::InvalidRequest(
                    "stdio environment material was supplied to a Streamable HTTP MCP extension"
                        .into(),
                ));
            }
            call_http(extension, url, tool_name, arguments, bearer, &lease).await
        }
    }
}

async fn discover_stdio(
    extension: &ExtensionRecord,
    command: &str,
    args: &[String],
    environment: Option<&BTreeMap<String, String>>,
    lease: &RuntimeLease,
) -> AppResult<Vec<DiscoveredTool>> {
    let mut last_error = None;
    for attempt in 0..mcp_extension_runtime::MAX_CONNECT_ATTEMPTS {
        mcp_extension_runtime::ensure_current(lease)?;
        let transport = match sandbox::build_command(&extension.id, command, args, environment)
            .and_then(|command| {
                TokioChildProcess::new(command).map_err(|error| {
                    client_error(extension, "failed to create stdio transport", error)
                })
            }) {
            Ok(transport) => transport,
            Err(error) => {
                if retry_discovery(extension, lease, attempt, &error).await? {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
        };
        let client = match timeout(CONNECT_TIMEOUT, ().serve(transport)).await {
            Ok(Ok(client)) => client,
            Ok(Err(error)) => {
                let error = client_error(extension, "stdio initialize failed", error);
                if retry_discovery(extension, lease, attempt, &error).await? {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
            Err(_) => {
                let error = client_timeout(extension, "stdio initialize", CONNECT_TIMEOUT);
                if retry_discovery(extension, lease, attempt, &error).await? {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
        };

        mcp_extension_runtime::ensure_current(lease)?;
        let tools = match timeout(LIST_TIMEOUT, client.list_all_tools()).await {
            Ok(Ok(tools)) => Ok(tools),
            Ok(Err(error)) => Err(client_error(extension, "tools/list failed", error)),
            Err(_) => Err(client_timeout(extension, "tools/list", LIST_TIMEOUT)),
        };
        let _ = timeout(SHUTDOWN_TIMEOUT, client.cancel()).await;
        mcp_extension_runtime::ensure_current(lease)?;
        match tools {
            Ok(items) => {
                mcp_extension_runtime::mark_ready(&extension.id).await?;
                return Ok(items.iter().map(discovered_tool).collect());
            }
            Err(error) => {
                if retry_discovery(extension, lease, attempt, &error).await? {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| {
        AppError::Command(format!(
            "MCP extension `{}` discovery exhausted its bounded retry budget",
            extension.id
        ))
    }))
}

async fn call_stdio(
    extension: &ExtensionRecord,
    command: &str,
    args: &[String],
    tool_name: &str,
    arguments: Option<Map<String, serde_json::Value>>,
    environment: Option<&BTreeMap<String, String>>,
    lease: &RuntimeLease,
) -> AppResult<CallToolResult> {
    if sandbox::requires_persistent_stdio_session(&extension.id, command, args) {
        return call_persistent_stdio(
            extension,
            command,
            args,
            tool_name,
            arguments,
            environment,
            lease,
        )
        .await;
    }

    let client = connect_stdio_client(extension, command, args, environment, lease).await?;
    mcp_extension_runtime::ensure_current(lease)?;
    let request = downstream_call_request(tool_name, arguments);
    let result = match timeout(CALL_TIMEOUT, client.call_tool(request)).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(error)) => Err(client_error(extension, "tools/call failed", error)),
        Err(_) => Err(client_timeout(extension, "tools/call", CALL_TIMEOUT)),
    };
    let _ = timeout(SHUTDOWN_TIMEOUT, client.cancel()).await;
    mcp_extension_runtime::ensure_current(lease)?;
    // Never retry a tools/call after dispatch: write-capable downstream tools may be
    // non-idempotent and retrying an ambiguous failure could duplicate side effects.
    finish_dispatched_call(extension, result).await
}

async fn connect_stdio_client(
    extension: &ExtensionRecord,
    command: &str,
    args: &[String],
    environment: Option<&BTreeMap<String, String>>,
    lease: &RuntimeLease,
) -> AppResult<PersistentStdioClient> {
    let mut last_error = None;
    for attempt in 0..mcp_extension_runtime::MAX_CONNECT_ATTEMPTS {
        mcp_extension_runtime::ensure_current(lease)?;
        let transport = match sandbox::build_command(&extension.id, command, args, environment)
            .and_then(|command| {
                TokioChildProcess::new(command).map_err(|error| {
                    client_error(extension, "failed to create stdio transport", error)
                })
            }) {
            Ok(transport) => transport,
            Err(error) => {
                if retry_connect(extension, lease, attempt, &error).await? {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
        };
        let client = match timeout(CONNECT_TIMEOUT, ().serve(transport)).await {
            Ok(Ok(client)) => client,
            Ok(Err(error)) => {
                let error = client_error(extension, "stdio initialize failed", error);
                if retry_connect(extension, lease, attempt, &error).await? {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
            Err(_) => {
                let error = client_timeout(extension, "stdio initialize", CONNECT_TIMEOUT);
                if retry_connect(extension, lease, attempt, &error).await? {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
        };
        return Ok(client);
    }
    Err(last_error.unwrap_or_else(|| {
        AppError::Command(format!(
            "MCP extension `{}` connection exhausted its bounded retry budget",
            extension.id
        ))
    }))
}

async fn call_persistent_stdio(
    extension: &ExtensionRecord,
    command: &str,
    args: &[String],
    tool_name: &str,
    arguments: Option<Map<String, serde_json::Value>>,
    environment: Option<&BTreeMap<String, String>>,
    lease: &RuntimeLease,
) -> AppResult<CallToolResult> {
    let slot = persistent_stdio_slot(&extension.id).await;
    let config_hash = stdio_session_config_hash(command, args, environment);
    let mut session = slot.lock().await;
    let replace = session
        .as_ref()
        .is_none_or(|current| current.config_hash != config_hash || current.client.is_closed());
    if replace {
        if let Some(current) = session.take() {
            close_stdio_session(current).await;
        }
        let client = connect_stdio_client(extension, command, args, environment, lease).await?;
        *session = Some(PersistentStdioSession {
            config_hash,
            client,
        });
    }

    mcp_extension_runtime::ensure_current(lease)?;
    let request = downstream_call_request(tool_name, arguments);
    let result = {
        let client = &session.as_ref().expect("persistent stdio session").client;
        match timeout(CALL_TIMEOUT, client.call_tool(request)).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) => Err(client_error(extension, "tools/call failed", error)),
            Err(_) => Err(client_timeout(extension, "tools/call", CALL_TIMEOUT)),
        }
    };

    let reset_session = match &result {
        Ok(result) => persistent_browser_result_poisoned(result),
        Err(_) => true,
    };
    if reset_session && let Some(current) = session.take() {
        close_stdio_session(current).await;
    }
    drop(session);
    mcp_extension_runtime::ensure_current(lease)?;
    // Never retry after dispatch: browser tools include write-capable operations such as click,
    // fill and navigation. A poisoned session is discarded for the next call instead.
    finish_dispatched_call(extension, result).await
}

fn stdio_session_config_hash(
    command: &str,
    args: &[String],
    environment: Option<&BTreeMap<String, String>>,
) -> String {
    let mut digest = Sha256::new();
    digest.update(command.as_bytes());
    digest.update([0]);
    for arg in args {
        digest.update(arg.as_bytes());
        digest.update([0]);
    }
    if let Some(environment) = environment {
        for (key, value) in environment {
            digest.update(key.as_bytes());
            digest.update([0]);
            digest.update(value.as_bytes());
            digest.update([0]);
        }
    }
    hex::encode(digest.finalize())
}

fn persistent_browser_result_poisoned(result: &CallToolResult) -> bool {
    if result.is_error != Some(true) {
        return false;
    }
    let text = serde_json::to_string(result)
        .unwrap_or_default()
        .to_ascii_lowercase();
    [
        "target closed",
        "browser disconnected",
        "browser has disconnected",
        "session closed",
        "connection closed",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

async fn close_stdio_session(mut session: PersistentStdioSession) {
    let _ = session.client.close_with_timeout(SHUTDOWN_TIMEOUT).await;
}

pub(crate) async fn close_persistent_stdio_session(extension_id: &str) {
    let slot = persistent_stdio_sessions()
        .lock()
        .await
        .remove(extension_id);
    if let Some(slot) = slot {
        let mut session = slot.lock().await;
        if let Some(current) = session.take() {
            close_stdio_session(current).await;
        }
    }
}

async fn discover_http(
    extension: &ExtensionRecord,
    url: &str,
    bearer: Option<&str>,
    lease: &RuntimeLease,
) -> AppResult<Vec<DiscoveredTool>> {
    let mut last_error = None;
    for attempt in 0..mcp_extension_runtime::MAX_CONNECT_ATTEMPTS {
        mcp_extension_runtime::ensure_current(lease)?;
        let transport = http_transport(url, bearer);
        let client = match timeout(CONNECT_TIMEOUT, ().serve(transport)).await {
            Ok(Ok(client)) => client,
            Ok(Err(error)) => {
                let error = client_error(extension, "Streamable HTTP initialize failed", error);
                if retry_discovery(extension, lease, attempt, &error).await? {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
            Err(_) => {
                let error =
                    client_timeout(extension, "Streamable HTTP initialize", CONNECT_TIMEOUT);
                if retry_discovery(extension, lease, attempt, &error).await? {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
        };

        mcp_extension_runtime::ensure_current(lease)?;
        let tools = match timeout(LIST_TIMEOUT, client.list_all_tools()).await {
            Ok(Ok(tools)) => Ok(tools),
            Ok(Err(error)) => Err(client_error(extension, "tools/list failed", error)),
            Err(_) => Err(client_timeout(extension, "tools/list", LIST_TIMEOUT)),
        };
        let _ = timeout(SHUTDOWN_TIMEOUT, client.cancel()).await;
        mcp_extension_runtime::ensure_current(lease)?;
        match tools {
            Ok(items) => {
                mcp_extension_runtime::mark_ready(&extension.id).await?;
                return Ok(items.iter().map(discovered_tool).collect());
            }
            Err(error) => {
                if retry_discovery(extension, lease, attempt, &error).await? {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| {
        AppError::Command(format!(
            "MCP extension `{}` discovery exhausted its bounded retry budget",
            extension.id
        ))
    }))
}

async fn call_http(
    extension: &ExtensionRecord,
    url: &str,
    tool_name: &str,
    arguments: Option<Map<String, serde_json::Value>>,
    bearer: Option<&str>,
    lease: &RuntimeLease,
) -> AppResult<CallToolResult> {
    let mut last_error = None;
    for attempt in 0..mcp_extension_runtime::MAX_CONNECT_ATTEMPTS {
        mcp_extension_runtime::ensure_current(lease)?;
        let transport = http_transport(url, bearer);
        let client = match timeout(CONNECT_TIMEOUT, ().serve(transport)).await {
            Ok(Ok(client)) => client,
            Ok(Err(error)) => {
                let error = client_error(extension, "Streamable HTTP initialize failed", error);
                if retry_connect(extension, lease, attempt, &error).await? {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
            Err(_) => {
                let error =
                    client_timeout(extension, "Streamable HTTP initialize", CONNECT_TIMEOUT);
                if retry_connect(extension, lease, attempt, &error).await? {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
        };

        mcp_extension_runtime::ensure_current(lease)?;
        let request = downstream_call_request(tool_name, arguments.clone());
        let result = match timeout(CALL_TIMEOUT, client.call_tool(request)).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) => Err(client_error(extension, "tools/call failed", error)),
            Err(_) => Err(client_timeout(extension, "tools/call", CALL_TIMEOUT)),
        };
        let _ = timeout(SHUTDOWN_TIMEOUT, client.cancel()).await;
        mcp_extension_runtime::ensure_current(lease)?;
        // As with stdio, do not retry after a downstream tools/call was dispatched.
        return finish_dispatched_call(extension, result).await;
    }
    Err(last_error.unwrap_or_else(|| {
        AppError::Command(format!(
            "MCP extension `{}` connection exhausted its bounded retry budget",
            extension.id
        ))
    }))
}

async fn finish_dispatched_call(
    extension: &ExtensionRecord,
    result: AppResult<CallToolResult>,
) -> AppResult<CallToolResult> {
    match result {
        Ok(result) => {
            mcp_extension_runtime::mark_ready(&extension.id).await?;
            Ok(result)
        }
        Err(error) => {
            let category = mcp_extension_runtime::classify_error(&error);
            mcp_extension_runtime::mark_failure(&extension.id, category).await?;
            Err(error)
        }
    }
}

async fn retry_discovery(
    extension: &ExtensionRecord,
    lease: &RuntimeLease,
    attempt: usize,
    error: &AppError,
) -> AppResult<bool> {
    retry_operation(extension, lease, attempt, error, "discovery").await
}

async fn retry_connect(
    extension: &ExtensionRecord,
    lease: &RuntimeLease,
    attempt: usize,
    error: &AppError,
) -> AppResult<bool> {
    retry_operation(extension, lease, attempt, error, "connect").await
}

async fn retry_operation(
    extension: &ExtensionRecord,
    lease: &RuntimeLease,
    attempt: usize,
    error: &AppError,
    operation: &'static str,
) -> AppResult<bool> {
    let category = mcp_extension_runtime::classify_error(error);
    let state = mcp_extension_runtime::mark_failure(&extension.id, category).await?;
    if attempt + 1 >= mcp_extension_runtime::MAX_CONNECT_ATTEMPTS || state == RuntimeState::Error {
        return Ok(false);
    }
    tracing::warn!(
        extension = %extension.id,
        operation,
        attempt = attempt + 1,
        max_attempts = mcp_extension_runtime::MAX_CONNECT_ATTEMPTS,
        error_category = category.as_str(),
        "MCP extension transient operation failed; retrying with bounded backoff"
    );
    mcp_extension_runtime::mark_retrying(&extension.id).await?;
    mcp_extension_runtime::wait_before_retry(lease, attempt).await?;
    mcp_extension_runtime::mark_starting(&extension.id).await?;
    Ok(true)
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
    let hint = ToolClassification {
        read_only: annotations.and_then(|value| value.read_only_hint),
        destructive: annotations.and_then(|value| value.destructive_hint),
        idempotent: annotations.and_then(|value| value.idempotent_hint),
        open_world: annotations.and_then(|value| value.open_world_hint),
    };
    DiscoveredTool {
        name: tool.name.to_string(),
        description: tool.description.as_ref().map(ToString::to_string),
        input_schema: serde_json::Value::Object((*tool.input_schema).clone()),
        classification: resolve_tool_classification(tool.name.as_ref(), hint),
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
    fn downstream_annotations_are_hints_but_source_nerve_resolves_read_semantics() {
        let schema = Arc::new(
            serde_json::json!({ "type": "object" })
                .as_object()
                .expect("schema")
                .clone(),
        );
        let mut tool = Tool::new("search_code", "Search memory", schema);
        tool.annotations = Some(
            ToolAnnotations::new()
                .read_only(false)
                .destructive(true)
                .idempotent(true)
                .open_world(false),
        );
        let discovered = discovered_tool(&tool);
        assert_eq!(discovered.name, "search_code");
        assert_eq!(discovered.classification.read_only, Some(true));
        assert_eq!(discovered.classification.destructive, Some(false));
        assert_eq!(discovered.classification.idempotent, Some(true));
        assert_eq!(discovered.classification.open_world, Some(false));
    }

    #[test]
    fn mutation_name_overrides_positive_downstream_read_hint() {
        let schema = Arc::new(
            serde_json::json!({ "type": "object" })
                .as_object()
                .expect("schema")
                .clone(),
        );
        let mut tool = Tool::new("search_and_delete", "Dangerous mixed operation", schema);
        tool.annotations = Some(ToolAnnotations::new().read_only(true).destructive(false));
        let discovered = discovered_tool(&tool);
        assert_eq!(discovered.classification.read_only, Some(false));
        assert_eq!(discovered.classification.destructive, Some(true));
    }

    #[test]
    fn rejects_unbounded_or_lowercase_materialized_environment() {
        let invalid = BTreeMap::from([("github_token".to_string(), "secret".to_string())]);
        assert!(validate_environment(Some(&invalid)).is_err());
        let valid = BTreeMap::from([("GITHUB_TOKEN".to_string(), "secret".to_string())]);
        assert!(validate_environment(Some(&valid)).is_ok());
    }

    #[test]
    fn persistent_stdio_hash_changes_with_command_args_or_environment() {
        let base = stdio_session_config_hash("npx", &["browser-mcp".into()], None);
        assert_ne!(
            base,
            stdio_session_config_hash("node", &["browser-mcp".into()], None)
        );
        assert_ne!(
            base,
            stdio_session_config_hash("npx", &["browser-mcp".into(), "--headless".into()], None,)
        );
        let environment = BTreeMap::from([("TOKEN".to_string(), "one".to_string())]);
        assert_ne!(
            base,
            stdio_session_config_hash("npx", &["browser-mcp".into()], Some(&environment))
        );
    }

    #[test]
    fn browser_transport_errors_poison_persistent_session() {
        let target_closed = CallToolResult::error(vec![rmcp::model::ContentBlock::text(
            "Protocol error (Target.setDiscoverTargets): Target closed",
        )]);
        assert!(persistent_browser_result_poisoned(&target_closed));

        let validation =
            CallToolResult::error(vec![rmcp::model::ContentBlock::text("validation failed")]);
        assert!(!persistent_browser_result_poisoned(&validation));
    }
}
