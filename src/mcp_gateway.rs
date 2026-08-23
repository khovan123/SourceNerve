use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Tool, ToolAnnotations,
};
use sqlx::SqlitePool;

use crate::{
    error::{AppError, AppResult},
    mcp_extension_client,
    mcp_extension_policy::{ApprovalMode, PolicyDecision, evaluate_tool_policy},
    mcp_extension_registry::{self, ExtensionAuthType, ExtensionRecord, ExtensionToolRecord},
    oauth::{OAuthPrincipal, Principal, READ_SCOPE},
    service::AppState,
};

#[derive(Debug, Clone)]
struct ToolRoute {
    extension: ExtensionRecord,
    tool: ExtensionToolRecord,
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

pub async fn try_call(
    state: &AppState,
    principal: &Principal,
    request: &CallToolRequestParams,
) -> AppResult<Option<CallToolResponse>> {
    let Some(route) = resolve_route(&state.db, request.name.as_ref()).await? else {
        return Ok(None);
    };

    let workspace = request
        .arguments
        .as_ref()
        .and_then(|arguments| arguments.get("workspace"))
        .and_then(serde_json::Value::as_str);
    if !principal_can_use(principal, &route.tool, workspace) {
        return Ok(Some(tool_error(
            "authorization denied: SourceNerve identity does not grant this extension tool",
        )));
    }

    match evaluate_tool_policy(Some(route.tool.policy), false) {
        PolicyDecision::Deny => {
            return Ok(Some(tool_error(
                "SourceNerve policy blocks this MCP extension tool",
            )));
        }
        PolicyDecision::RequireApproval => {
            return Ok(Some(tool_error(
                "SourceNerve policy requires explicit approval before this MCP extension tool can run",
            )));
        }
        PolicyDecision::Allow => {}
    }

    if route.extension.auth_type != ExtensionAuthType::None {
        return Ok(Some(tool_error(
            "This MCP extension requires credential materialization from SourceNerve secure storage; authenticated downstream routing is not enabled yet",
        )));
    }

    let started = std::time::Instant::now();
    let call = mcp_extension_client::call_tool(
        &route.extension,
        &route.tool.original_name,
        request.arguments.clone(),
        None,
    )
    .await;
    match call {
        Ok(result) => {
            tracing::info!(
                extension = %route.extension.id,
                public_tool = %route.tool.public_name,
                downstream_tool = %route.tool.original_name,
                schema_hash = %route.tool.schema_hash,
                elapsed_ms = started.elapsed().as_millis(),
                "MCP extension tool call completed"
            );
            Ok(Some(result.into()))
        }
        Err(error) => {
            let _ = mcp_extension_registry::mark_error(
                &state.db,
                &route.extension.id,
                &bounded_error(&error.to_string()),
            )
            .await;
            tracing::warn!(
                extension = %route.extension.id,
                public_tool = %route.tool.public_name,
                downstream_tool = %route.tool.original_name,
                elapsed_ms = started.elapsed().as_millis(),
                error = %error,
                "MCP extension tool call failed"
            );
            Ok(Some(tool_error(format!(
                "downstream MCP extension `{}` failed to execute `{}`: {error}",
                route.extension.name, route.tool.original_name
            ))))
        }
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
            AppError::InvalidRequest(format!(
                "MCP extension `{extension_id}` is not registered"
            ))
        })?;
    if !extension.enabled {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension `{extension_id}` must be enabled before discovery"
        )));
    }

    match mcp_extension_client::discover_tools(&extension, bearer).await {
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
            let message = bounded_error(&error.to_string());
            let _ = mcp_extension_registry::mark_error(pool, extension_id, &message).await;
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
        if extension.auth_type != ExtensionAuthType::None {
            if extension.required {
                return Err(AppError::InvalidRequest(format!(
                    "required MCP extension `{}` needs secure credential materialization before discovery",
                    extension.id
                )));
            }
            tracing::debug!(
                extension = %extension.id,
                "skipping automatic discovery for authenticated MCP extension"
            );
            continue;
        }
        if let Err(error) = refresh_extension(pool, &extension.id, None).await {
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
    if public_name.len() > 120 || public_name.contains(['\r', '\n', '\0']) {
        return Ok(None);
    }
    for route in routes(pool).await? {
        if route.tool.public_name == public_name {
            return Ok(Some(route));
        }
    }
    Ok(None)
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
    result.annotations = Some(
        ToolAnnotations::with_title(title)
            .read_only(classification.read_only.unwrap_or(false))
            .destructive(classification.destructive.unwrap_or(true))
            .idempotent(classification.idempotent.unwrap_or(false))
            .open_world(classification.open_world.unwrap_or(true)),
    );
    Ok(result)
}

fn tool_error(message: impl Into<String>) -> CallToolResponse {
    CallToolResult::error(vec![ContentBlock::text(message.into())]).into()
}

fn bounded_error(message: &str) -> String {
    const MAX_ERROR_BYTES: usize = 4096;
    if message.len() <= MAX_ERROR_BYTES {
        return message.to_owned();
    }
    let mut end = MAX_ERROR_BYTES;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message[..end].to_owned()
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
        assert_eq!(
            exposed
                .annotations
                .as_ref()
                .and_then(|value| value.read_only_hint),
            Some(true)
        );
    }
}
