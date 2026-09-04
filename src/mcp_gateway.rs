use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Tool, ToolAnnotations,
};
use sqlx::SqlitePool;
use tokio::sync::{Mutex, RwLock};

use crate::{
    error::{AppError, AppResult},
    mcp_extension_audit::{
        self, ApprovalDecision as AuditApprovalDecision, AuditEvent,
        PolicyDecision as AuditPolicyDecision, ResultCategory as AuditResultCategory,
    },
    mcp_extension_client,
    mcp_extension_policy::{ApprovalMode, PolicyDecision, evaluate_tool_policy},
    mcp_extension_registry::{self, ExtensionAuthType, ExtensionRecord, ExtensionToolRecord},
    mcp_extension_runtime,
    oauth::{OAuthPrincipal, Principal, READ_SCOPE},
    service::AppState,
};

pub const APPROVAL_TTL: Duration = Duration::from_secs(120);
const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;
const MAX_ENV_ENTRIES: usize = 32;
const MAX_ENV_VALUE_BYTES: usize = 32 * 1024;

static MATERIALIZED_CREDENTIALS: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();
static MATERIALIZED_ENVIRONMENTS: OnceLock<RwLock<HashMap<String, BTreeMap<String, String>>>> =
    OnceLock::new();
static ONE_SHOT_APPROVALS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

#[derive(Debug, Clone)]
struct ToolRoute {
    extension: ExtensionRecord,
    tool: ExtensionToolRecord,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeDispatcher {
    Read,
    Write,
}

impl BridgeDispatcher {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }
}

fn credentials() -> &'static RwLock<HashMap<String, String>> {
    MATERIALIZED_CREDENTIALS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn environments() -> &'static RwLock<HashMap<String, BTreeMap<String, String>>> {
    MATERIALIZED_ENVIRONMENTS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn approvals() -> &'static Mutex<HashMap<String, Instant>> {
    ONE_SHOT_APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn materialize_credential(extension_id: &str, credential: &str) -> AppResult<()> {
    if !safe_route_key(extension_id, 64) {
        return Err(AppError::InvalidRequest(
            "invalid MCP extension credential target".into(),
        ));
    }
    if credential.is_empty()
        || credential.len() > MAX_CREDENTIAL_BYTES
        || credential.contains(['\r', '\n', '\0'])
    {
        return Err(AppError::InvalidRequest(
            "MCP extension credential material is invalid".into(),
        ));
    }
    credentials()
        .write()
        .await
        .insert(extension_id.to_owned(), credential.to_owned());
    Ok(())
}

pub async fn materialized_credential(extension_id: &str) -> Option<String> {
    credentials().read().await.get(extension_id).cloned()
}

pub async fn clear_materialized_credential(extension_id: &str) {
    credentials().write().await.remove(extension_id);
}

pub async fn materialize_environment(
    extension_id: &str,
    values: &BTreeMap<String, String>,
) -> AppResult<()> {
    if !safe_route_key(extension_id, 64) {
        return Err(AppError::InvalidRequest(
            "invalid MCP extension environment target".into(),
        ));
    }
    if values.len() > MAX_ENV_ENTRIES {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension environment may contain at most {MAX_ENV_ENTRIES} values"
        )));
    }
    for (key, value) in values {
        if !valid_env_key(key) || value.len() > MAX_ENV_VALUE_BYTES || value.contains('\0') {
            return Err(AppError::InvalidRequest(
                "MCP extension environment material is invalid".into(),
            ));
        }
    }
    if values.is_empty() {
        environments().write().await.remove(extension_id);
    } else {
        environments()
            .write()
            .await
            .insert(extension_id.to_owned(), values.clone());
    }
    Ok(())
}

pub async fn materialized_environment(extension_id: &str) -> Option<BTreeMap<String, String>> {
    environments().read().await.get(extension_id).cloned()
}

pub async fn clear_materialized_environment(extension_id: &str) {
    environments().write().await.remove(extension_id);
}

pub async fn approve_once(public_tool: &str) -> AppResult<()> {
    if !safe_route_key(public_tool, 120) {
        return Err(AppError::InvalidRequest(
            "invalid MCP extension public tool name".into(),
        ));
    }
    approvals()
        .lock()
        .await
        .insert(public_tool.to_owned(), Instant::now() + APPROVAL_TTL);
    Ok(())
}

async fn consume_approval(public_tool: &str) -> bool {
    let mut approvals = approvals().lock().await;
    let now = Instant::now();
    approvals.retain(|_, expires_at| *expires_at > now);
    approvals
        .remove(public_tool)
        .is_some_and(|expires_at| expires_at > now)
}

pub async fn list_tools(pool: &SqlitePool, principal: &Principal) -> AppResult<Vec<Tool>> {
    ensure_initial_discovery(pool).await?;
    let mut result = Vec::new();
    for route in routes(pool).await? {
        if !route.tool.policy.enabled || route.tool.policy.approval == ApprovalMode::Blocked {
            continue;
        }
        if !principal_can_use(principal, &route.tool, None) {
            continue;
        }
        match public_tool(&route.tool) {
            Ok(tool) => result.push(tool),
            Err(error) => {
                tracing::warn!(
                    extension = %route.extension.id,
                    tool = %route.tool.public_name,
                    error = %error,
                    "omitting invalid downstream MCP tool schema"
                );
            }
        }
    }
    Ok(result)
}

pub async fn bridge_catalog(pool: &SqlitePool, principal: &Principal) -> AppResult<Vec<Tool>> {
    list_tools(pool, principal).await
}

pub async fn bridge_call(
    state: &AppState,
    principal: &Principal,
    public_tool: &str,
    arguments: serde_json::Map<String, serde_json::Value>,
    dispatcher: BridgeDispatcher,
) -> AppResult<CallToolResponse> {
    let Some(route) = resolve_route(&state.db, public_tool).await? else {
        return Ok(tool_error(format!(
            "MCP extension tool `{public_tool}` is not installed and enabled"
        )));
    };

    let is_read_only = route.tool.policy.classification.read_only == Some(true);
    let dispatcher_matches = match dispatcher {
        BridgeDispatcher::Read => is_read_only,
        BridgeDispatcher::Write => !is_read_only,
    };
    if !dispatcher_matches {
        return Ok(tool_error(format!(
            "SourceNerve stable extension {} dispatcher rejects `{public_tool}` because its current classification belongs to the {} dispatcher",
            dispatcher.as_str(),
            if is_read_only { "read" } else { "write" }
        )));
    }

    let mut downstream = CallToolRequestParams::new(public_tool.to_owned());
    downstream.arguments = Some(arguments);
    match try_call(state, principal, &downstream).await? {
        Some(response) => Ok(response),
        None => Ok(tool_error(format!(
            "MCP extension tool `{public_tool}` disappeared before dispatch"
        ))),
    }
}

pub async fn try_call(
    state: &AppState,
    principal: &Principal,
    request: &CallToolRequestParams,
) -> AppResult<Option<CallToolResponse>> {
    let Some(route) = resolve_route(&state.db, request.name.as_ref()).await? else {
        return Ok(None);
    };
    let started = Instant::now();
    let workspace = request
        .arguments
        .as_ref()
        .and_then(|arguments| arguments.get("workspace"))
        .and_then(serde_json::Value::as_str);

    if !principal_can_use(principal, &route.tool, workspace) {
        record_audit(
            state,
            principal,
            workspace,
            &route,
            AuditPolicyDecision::AuthorizationDenied,
            AuditApprovalDecision::NotApplicable,
            AuditResultCategory::Denied,
            started,
            None,
            None,
        )
        .await;
        return Ok(Some(tool_error(
            "authorization denied: SourceNerve identity does not grant this extension tool",
        )));
    }

    let user_approved = if route.tool.policy.approval == ApprovalMode::Ask {
        consume_approval(&route.tool.public_name).await
    } else {
        false
    };
    let approval_decision = match route.tool.policy.approval {
        ApprovalMode::Ask if user_approved => AuditApprovalDecision::Approved,
        ApprovalMode::Ask => AuditApprovalDecision::Missing,
        ApprovalMode::Automatic => AuditApprovalDecision::NotRequired,
        ApprovalMode::Blocked => AuditApprovalDecision::NotApplicable,
    };
    match evaluate_tool_policy(Some(route.tool.policy), user_approved) {
        PolicyDecision::Deny => {
            record_audit(
                state,
                principal,
                workspace,
                &route,
                AuditPolicyDecision::Blocked,
                approval_decision,
                AuditResultCategory::Denied,
                started,
                None,
                None,
            )
            .await;
            tracing::info!(
                extension = %route.extension.id,
                public_tool = %route.tool.public_name,
                policy = "blocked",
                "MCP extension tool call denied by policy"
            );
            return Ok(Some(tool_error(
                "SourceNerve policy blocks this MCP extension tool",
            )));
        }
        PolicyDecision::RequireApproval => {
            record_audit(
                state,
                principal,
                workspace,
                &route,
                AuditPolicyDecision::Ask,
                approval_decision,
                AuditResultCategory::ApprovalRequired,
                started,
                None,
                None,
            )
            .await;
            tracing::info!(
                extension = %route.extension.id,
                public_tool = %route.tool.public_name,
                policy = "ask",
                "MCP extension tool call requires explicit approval"
            );
            return Ok(Some(tool_error(
                "SourceNerve policy requires explicit approval before this MCP extension tool can run",
            )));
        }
        PolicyDecision::Allow => {}
    }

    let credential = match route.extension.auth_type {
        ExtensionAuthType::None => None,
        ExtensionAuthType::Bearer | ExtensionAuthType::Oauth => {
            let Some(credential) = materialized_credential(&route.extension.id).await else {
                record_audit(
                    state,
                    principal,
                    workspace,
                    &route,
                    AuditPolicyDecision::ConfigurationError,
                    approval_decision,
                    AuditResultCategory::ConfigurationError,
                    started,
                    Some("credential-unavailable"),
                    Some("Credential is not materialized in SourceNerve secure storage"),
                )
                .await;
                return Ok(Some(tool_error(
                    "This MCP extension requires credential materialization from SourceNerve secure storage",
                )));
            };
            Some(credential)
        }
    };
    let environment = materialized_environment(&route.extension.id).await;

    let call = mcp_extension_client::call_tool(
        &route.extension,
        &route.tool.original_name,
        request.arguments.clone(),
        credential.as_deref(),
        environment.as_ref(),
    )
    .await;
    match call {
        Ok(result) => {
            let downstream_error = result.is_error == Some(true);
            let category = if downstream_error {
                AuditResultCategory::DownstreamError
            } else {
                AuditResultCategory::Success
            };
            let diagnostic = downstream_error
                .then(|| downstream_result_diagnostic(&result))
                .flatten();
            record_audit(
                state,
                principal,
                workspace,
                &route,
                AuditPolicyDecision::Allow,
                approval_decision,
                category,
                started,
                downstream_error.then_some("downstream-tool-error"),
                diagnostic.as_deref(),
            )
            .await;
            tracing::info!(
                extension = %route.extension.id,
                public_tool = %route.tool.public_name,
                downstream_tool = %route.tool.original_name,
                schema_hash = %route.tool.schema_hash,
                approval = %route.tool.policy.approval.as_str(),
                elapsed_ms = started.elapsed().as_millis(),
                "MCP extension tool call completed"
            );
            Ok(Some(ensure_extension_structured_content(result).into()))
        }
        Err(error) => {
            let previous_runtime_failure =
                if mcp_extension_runtime::is_runtime_circuit_open_error(&error)
                    || mcp_extension_runtime::is_fail_closed_error(&error)
                {
                    mcp_extension_runtime::health(&state.db, &route.extension.id)
                        .await
                        .ok()
                        .and_then(|snapshot| snapshot.last_error_category)
                } else {
                    None
                };
            let error_category =
                mcp_extension_runtime::audit_error_category(&error, previous_runtime_failure);
            let diagnostic = mcp_extension_audit::sanitize_diagnostic(&error.to_string());
            record_audit(
                state,
                principal,
                workspace,
                &route,
                AuditPolicyDecision::Allow,
                approval_decision,
                AuditResultCategory::DownstreamError,
                started,
                Some(&error_category),
                diagnostic.as_deref(),
            )
            .await;
            let registry_error = diagnostic.as_deref().unwrap_or(&error_category);
            let _ =
                mcp_extension_registry::mark_error(&state.db, &route.extension.id, registry_error)
                    .await;
            tracing::warn!(
                extension = %route.extension.id,
                public_tool = %route.tool.public_name,
                downstream_tool = %route.tool.original_name,
                elapsed_ms = started.elapsed().as_millis(),
                error_category = %error_category,
                "MCP extension tool call failed"
            );
            Ok(Some(tool_error(format!(
                "downstream MCP extension `{}` failed to execute `{}`: {error}",
                route.extension.name, route.tool.original_name
            ))))
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn record_audit(
    state: &AppState,
    principal: &Principal,
    workspace: Option<&str>,
    route: &ToolRoute,
    policy_decision: AuditPolicyDecision,
    approval_decision: AuditApprovalDecision,
    result_category: AuditResultCategory,
    started: Instant,
    error_category: Option<&str>,
    diagnostic: Option<&str>,
) {
    let event = AuditEvent {
        principal,
        workspace_id: workspace,
        extension_id: &route.extension.id,
        extension_version: &route.extension.version,
        public_tool: &route.tool.public_name,
        original_tool: &route.tool.original_name,
        schema_hash: &route.tool.schema_hash,
        policy_decision,
        approval_decision,
        result_category,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        error_category,
        diagnostic,
    };
    if let Err(error) = mcp_extension_audit::record(&state.db, event).await {
        tracing::error!(
            extension = %route.extension.id,
            public_tool = %route.tool.public_name,
            error = %bounded_error(&error.to_string()),
            "failed to persist MCP invocation audit metadata"
        );
    }
}

pub async fn refresh_extension(
    pool: &SqlitePool,
    extension_id: &str,
    bearer: Option<&str>,
) -> AppResult<Vec<ExtensionToolRecord>> {
    let extension = mcp_extension_registry::get(pool, extension_id)
        .await?
        .ok_or_else(|| {
            AppError::InvalidRequest(format!("MCP extension `{extension_id}` is not registered"))
        })?;
    if !extension.enabled {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension `{extension_id}` must be enabled before discovery"
        )));
    }
    let environment = materialized_environment(extension_id).await;

    match mcp_extension_client::discover_tools(&extension, bearer, environment.as_ref()).await {
        Ok(discovered) => {
            let tools =
                mcp_extension_registry::replace_discovered_tools(pool, extension_id, &discovered)
                    .await?;
            let _ = mcp_extension_registry::set_enabled(pool, extension_id, true).await?;
            tracing::info!(
                extension = %extension.id,
                discovered_tools = tools.len(),
                "MCP extension discovery completed"
            );
            Ok(tools)
        }
        Err(error) => {
            let category = mcp_extension_runtime::classify_error(&error);
            let diagnostic = mcp_extension_audit::sanitize_diagnostic(&error.to_string())
                .unwrap_or_else(|| category.as_str().to_owned());
            let _ = mcp_extension_registry::mark_error(pool, extension_id, &diagnostic).await;
            Err(error)
        }
    }
}

async fn ensure_initial_discovery(pool: &SqlitePool) -> AppResult<()> {
    for extension in mcp_extension_registry::list(pool).await? {
        if !extension.enabled {
            continue;
        }
        let cached = mcp_extension_registry::list_tools(pool, &extension.id).await?;
        if !cached.is_empty() {
            continue;
        }
        let credential = match extension.auth_type {
            ExtensionAuthType::None => None,
            ExtensionAuthType::Bearer | ExtensionAuthType::Oauth => {
                let credential = materialized_credential(&extension.id).await;
                if credential.is_none() {
                    if extension.required {
                        return Err(AppError::InvalidRequest(format!(
                            "required MCP extension `{}` needs secure credential materialization before discovery",
                            extension.id
                        )));
                    }
                    tracing::debug!(
                        extension = %extension.id,
                        "skipping automatic discovery for MCP extension without materialized credential"
                    );
                    continue;
                }
                credential
            }
        };
        if let Err(error) = refresh_extension(pool, &extension.id, credential.as_deref()).await {
            if extension.required {
                return Err(error);
            }
            tracing::warn!(
                extension = %extension.id,
                error = %error,
                "optional MCP extension discovery failed; continuing without its tools"
            );
        }
    }
    Ok(())
}

async fn routes(pool: &SqlitePool) -> AppResult<Vec<ToolRoute>> {
    let mut result = Vec::new();
    for extension in mcp_extension_registry::list(pool).await? {
        if !extension.enabled {
            continue;
        }
        for tool in mcp_extension_registry::list_tools(pool, &extension.id).await? {
            result.push(ToolRoute {
                extension: extension.clone(),
                tool,
            });
        }
    }
    Ok(result)
}

async fn resolve_route(pool: &SqlitePool, public_name: &str) -> AppResult<Option<ToolRoute>> {
    if !safe_route_key(public_name, 120) {
        return Ok(None);
    }
    for route in routes(pool).await? {
        if route.tool.public_name == public_name {
            return Ok(Some(route));
        }
    }
    Ok(None)
}

fn safe_route_key(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .chars()
            .all(|ch| !matches!(ch, '\r' | '\n' | '\0') && !ch.is_control())
}

fn valid_env_key(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z') | Some(b'_'))
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && value.len() <= 128
}

fn principal_can_use(
    principal: &Principal,
    tool: &ExtensionToolRecord,
    workspace: Option<&str>,
) -> bool {
    match principal {
        Principal::Operator => true,
        Principal::OAuth(principal) => oauth_can_use(principal, tool, workspace),
    }
}

fn oauth_can_use(
    principal: &OAuthPrincipal,
    tool: &ExtensionToolRecord,
    workspace: Option<&str>,
) -> bool {
    let read_only = tool.policy.classification.read_only == Some(true);
    match (read_only, workspace) {
        (true, Some(workspace)) => principal.can_read(workspace),
        (false, Some(workspace)) => principal.can_write(workspace),
        (true, None) => principal.scopes.contains(READ_SCOPE) && !principal.grants.is_empty(),
        (false, None) => principal.has_any_write(),
    }
}

fn extension_output_schema(tool_name: &str) -> Arc<serde_json::Map<String, serde_json::Value>> {
    Arc::new(
        serde_json::json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "description": format!(
                "Structured result forwarded by SourceNerve from MCP extension tool `{tool_name}`."
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
        .expect("extension output schema must be a JSON object")
        .clone(),
    )
}

fn public_tool(tool: &ExtensionToolRecord) -> AppResult<Tool> {
    let schema = tool.input_schema.as_object().ok_or_else(|| {
        AppError::InvalidRequest(format!(
            "MCP extension tool `{}` has a non-object input schema",
            tool.public_name
        ))
    })?;
    let title = format!("MCP Extension · {}", tool.original_name);
    let mut result = Tool::new(
        tool.public_name.clone(),
        tool.description
            .clone()
            .unwrap_or_else(|| format!("Forwarded MCP extension tool `{}`", tool.original_name)),
        Arc::new(schema.clone()),
    );
    let classification = tool.policy.classification;
    result.title = Some(title.clone());
    result.output_schema = Some(extension_output_schema(&tool.public_name));
    result.annotations = Some(
        ToolAnnotations::with_title(title)
            .read_only(classification.read_only.unwrap_or(false))
            .destructive(classification.destructive.unwrap_or(true))
            .idempotent(classification.idempotent.unwrap_or(false))
            .open_world(classification.open_world.unwrap_or(true)),
    );
    Ok(result)
}

fn ensure_extension_structured_content(mut result: CallToolResult) -> CallToolResult {
    if result.is_error == Some(true) || result.structured_content.is_some() {
        return result;
    }
    result.structured_content = result
        .content
        .iter()
        .find_map(ContentBlock::as_text)
        .map(|text| {
            serde_json::from_str(&text.text)
                .unwrap_or_else(|_| serde_json::Value::String(text.text.clone()))
        })
        .or(Some(serde_json::Value::Null));
    result
}

fn tool_error(message: impl Into<String>) -> CallToolResponse {
    CallToolResult::error(vec![ContentBlock::text(message.into())]).into()
}

fn downstream_result_diagnostic(result: &CallToolResult) -> Option<String> {
    result
        .content
        .iter()
        .find_map(ContentBlock::as_text)
        .and_then(|text| mcp_extension_audit::sanitize_diagnostic(&text.text))
}

fn bounded_error(message: &str) -> String {
    const MAX_ERROR_BYTES: usize = 4096;
    let sanitized = message
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>();
    if sanitized.len() <= MAX_ERROR_BYTES {
        return sanitized;
    }
    let mut end = MAX_ERROR_BYTES;
    while !sanitized.is_char_boundary(end) {
        end -= 1;
    }
    sanitized[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::*;
    use crate::{
        mcp_extension_policy::{ToolClassification, ToolPolicy},
        oauth::{GrantAccess, WRITE_SCOPE},
    };

    fn tool(read_only: Option<bool>) -> ExtensionToolRecord {
        ExtensionToolRecord {
            extension_id: "memory".into(),
            original_name: "search".into(),
            public_name: "memory__search".into(),
            description: Some("Search".into()),
            input_schema: serde_json::json!({ "type": "object" }),
            schema_hash: "abc".into(),
            policy: ToolPolicy {
                enabled: true,
                approval: ApprovalMode::Automatic,
                classification: ToolClassification {
                    read_only,
                    destructive: None,
                    idempotent: None,
                    open_world: None,
                },
            },
            created_at: 0,
            updated_at: 0,
        }
    }

    fn oauth(write: bool) -> OAuthPrincipal {
        let mut scopes = HashSet::from([READ_SCOPE.to_string()]);
        if write {
            scopes.insert(WRITE_SCOPE.to_string());
        }
        OAuthPrincipal::from_parts_for_test(
            scopes,
            HashMap::from([(
                "workspace-a".to_string(),
                if write {
                    GrantAccess::ReadWrite
                } else {
                    GrantAccess::ReadOnly
                },
            )]),
        )
    }

    #[test]
    fn oauth_extension_visibility_is_conservative_for_unknown_write_semantics() {
        assert!(oauth_can_use(&oauth(false), &tool(Some(true)), None));
        assert!(!oauth_can_use(&oauth(false), &tool(None), None));
        assert!(oauth_can_use(&oauth(true), &tool(None), None));
    }

    #[test]
    fn extension_tool_schema_is_exposed_under_public_namespace() {
        let exposed = public_tool(&tool(Some(true))).expect("public tool");
        assert_eq!(exposed.name.as_ref(), "memory__search");
        assert!(exposed.output_schema.is_some());
        assert_eq!(
            exposed
                .annotations
                .as_ref()
                .and_then(|value| value.read_only_hint),
            Some(true)
        );
    }

    #[test]
    fn extension_text_results_receive_structured_content_for_output_schema() {
        let result = CallToolResult::success(vec![ContentBlock::text("plain downstream text")]);
        let result = ensure_extension_structured_content(result);
        assert_eq!(
            result.structured_content,
            Some(serde_json::Value::String("plain downstream text".into()))
        );
    }

    #[test]
    fn downstream_error_diagnostic_is_sanitized_before_audit() {
        let result = CallToolResult::error(vec![ContentBlock::text(
            "401 Unauthorized token=super-secret-value Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
        )]);
        let diagnostic = downstream_result_diagnostic(&result).expect("diagnostic");
        assert!(diagnostic.contains("401 Unauthorized"));
        assert!(!diagnostic.contains("super-secret-value"));
        assert!(!diagnostic.contains("abcdefghijklmnopqrstuvwxyz"));
    }

    #[test]
    fn downstream_error_text_is_bounded_and_single_line_safe() {
        let sanitized = bounded_error("boom\nwith\rcontrol");
        assert_eq!(sanitized, "boom with control");
    }

    #[test]
    fn route_keys_reject_control_characters() {
        assert!(safe_route_key("memory__search", 120));
        assert!(!safe_route_key("memory__search\nother", 120));
    }

    #[test]
    fn environment_keys_are_restricted() {
        assert!(valid_env_key("GITHUB_TOKEN"));
        assert!(!valid_env_key("github_token"));
        assert!(!valid_env_key("BAD-NAME"));
    }
}
