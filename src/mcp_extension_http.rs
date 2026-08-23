use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    mcp_extension_policy::ApprovalMode,
    mcp_extension_registry::{
        self, ExtensionAuthType, ExtensionRecord, ExtensionToolRecord, RegisterExtensionRequest,
    },
    mcp_gateway,
    service::AppState,
};

#[derive(Debug, Deserialize)]
struct ExtensionIdRequest {
    extension_id: String,
}

#[derive(Debug, Deserialize)]
struct ToolPolicyRequest {
    extension_id: String,
    tool_name: String,
    enabled: bool,
    approval: ApprovalMode,
}

#[derive(Debug, Deserialize)]
struct CredentialRequest {
    extension_id: String,
    credential: String,
}

#[derive(Debug, Deserialize)]
struct ApprovalRequest {
    public_tool: String,
}

#[derive(Debug, Serialize)]
struct RemoveResponse {
    removed: bool,
}

#[derive(Debug, Serialize)]
struct CredentialStatusResponse {
    extension_id: String,
    materialized: bool,
}

#[derive(Debug, Serialize)]
struct ApprovalResponse {
    public_tool: String,
    approved_once: bool,
    expires_in_seconds: u64,
}

#[derive(Debug, Serialize)]
pub struct ExtensionHealthView {
    pub extension: ExtensionRecord,
    pub discovered_tools: usize,
    pub exposed_tools: usize,
    pub credential_materialized: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/mcp/extensions", get(list_extensions))
        .route("/mcp/extensions/register", post(register_extension))
        .route("/mcp/extensions/enable", post(enable_extension))
        .route("/mcp/extensions/disable", post(disable_extension))
        .route("/mcp/extensions/remove", post(remove_extension))
        .route("/mcp/extensions/restart", post(restart_extension))
        .route("/mcp/extensions/tools", post(list_extension_tools))
        .route("/mcp/extensions/tools/policy", post(set_tool_policy))
        .route(
            "/mcp/extensions/credential/materialize",
            post(materialize_credential),
        )
        .route("/mcp/extensions/credential/clear", post(clear_credential))
        .route("/mcp/extensions/approve-next", post(approve_next_call))
        .route("/mcp/extensions/health", get(extension_health))
}

async fn list_extensions(State(state): State<AppState>) -> AppResult<Json<Vec<ExtensionRecord>>> {
    Ok(Json(mcp_extension_registry::list(&state.db).await?))
}

async fn register_extension(
    State(state): State<AppState>,
    Json(request): Json<RegisterExtensionRequest>,
) -> AppResult<Json<ExtensionRecord>> {
    Ok(Json(
        mcp_extension_registry::register(&state.db, request).await?,
    ))
}

async fn enable_extension(
    State(state): State<AppState>,
    Json(request): Json<ExtensionIdRequest>,
) -> AppResult<Json<ExtensionRecord>> {
    let extension =
        mcp_extension_registry::set_enabled(&state.db, &request.extension_id, true).await?;
    let bearer = mcp_gateway::materialized_credential(&extension.id).await;
    if extension.auth_type == ExtensionAuthType::None || bearer.is_some() {
        mcp_gateway::refresh_extension(&state.db, &extension.id, bearer.as_deref()).await?;
    }
    let extension = mcp_extension_registry::get(&state.db, &request.extension_id)
        .await?
        .ok_or_else(|| AppError::InvalidRequest("enabled MCP extension disappeared".into()))?;
    Ok(Json(extension))
}

async fn disable_extension(
    State(state): State<AppState>,
    Json(request): Json<ExtensionIdRequest>,
) -> AppResult<Json<ExtensionRecord>> {
    mcp_gateway::clear_materialized_credential(&request.extension_id).await;
    Ok(Json(
        mcp_extension_registry::set_enabled(&state.db, &request.extension_id, false).await?,
    ))
}

async fn remove_extension(
    State(state): State<AppState>,
    Json(request): Json<ExtensionIdRequest>,
) -> AppResult<Json<RemoveResponse>> {
    mcp_gateway::clear_materialized_credential(&request.extension_id).await;
    Ok(Json(RemoveResponse {
        removed: mcp_extension_registry::remove(&state.db, &request.extension_id).await?,
    }))
}

async fn restart_extension(
    State(state): State<AppState>,
    Json(request): Json<ExtensionIdRequest>,
) -> AppResult<Json<Vec<ExtensionToolRecord>>> {
    let extension = mcp_extension_registry::get(&state.db, &request.extension_id)
        .await?
        .ok_or_else(|| {
            AppError::InvalidRequest(format!(
                "MCP extension `{}` is not registered",
                request.extension_id
            ))
        })?;
    if !extension.enabled {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension `{}` must be enabled before restart",
            extension.id
        )));
    }
    let bearer = mcp_gateway::materialized_credential(&extension.id).await;
    Ok(Json(
        mcp_gateway::refresh_extension(&state.db, &extension.id, bearer.as_deref()).await?,
    ))
}

async fn list_extension_tools(
    State(state): State<AppState>,
    Json(request): Json<ExtensionIdRequest>,
) -> AppResult<Json<Vec<ExtensionToolRecord>>> {
    if mcp_extension_registry::get(&state.db, &request.extension_id)
        .await?
        .is_none()
    {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension `{}` is not registered",
            request.extension_id
        )));
    }
    Ok(Json(
        mcp_extension_registry::list_tools(&state.db, &request.extension_id).await?,
    ))
}

async fn set_tool_policy(
    State(state): State<AppState>,
    Json(request): Json<ToolPolicyRequest>,
) -> AppResult<Json<ExtensionToolRecord>> {
    Ok(Json(
        mcp_extension_registry::set_tool_policy(
            &state.db,
            &request.extension_id,
            &request.tool_name,
            request.enabled,
            request.approval,
        )
        .await?,
    ))
}

async fn materialize_credential(
    State(state): State<AppState>,
    Json(request): Json<CredentialRequest>,
) -> AppResult<Json<CredentialStatusResponse>> {
    let extension = mcp_extension_registry::get(&state.db, &request.extension_id)
        .await?
        .ok_or_else(|| {
            AppError::InvalidRequest(format!(
                "MCP extension `{}` is not registered",
                request.extension_id
            ))
        })?;
    if extension.auth_type == ExtensionAuthType::None {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension `{}` does not accept credential material",
            extension.id
        )));
    }
    mcp_gateway::materialize_credential(&extension.id, &request.credential).await?;
    Ok(Json(CredentialStatusResponse {
        extension_id: extension.id,
        materialized: true,
    }))
}

async fn clear_credential(
    State(state): State<AppState>,
    Json(request): Json<ExtensionIdRequest>,
) -> AppResult<Json<CredentialStatusResponse>> {
    if mcp_extension_registry::get(&state.db, &request.extension_id)
        .await?
        .is_none()
    {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension `{}` is not registered",
            request.extension_id
        )));
    }
    mcp_gateway::clear_materialized_credential(&request.extension_id).await;
    Ok(Json(CredentialStatusResponse {
        extension_id: request.extension_id,
        materialized: false,
    }))
}

async fn approve_next_call(
    State(state): State<AppState>,
    Json(request): Json<ApprovalRequest>,
) -> AppResult<Json<ApprovalResponse>> {
    let mut found = false;
    for extension in mcp_extension_registry::list(&state.db).await? {
        if mcp_extension_registry::list_tools(&state.db, &extension.id)
            .await?
            .iter()
            .any(|tool| tool.public_name == request.public_tool)
        {
            found = true;
            break;
        }
    }
    if !found {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension tool `{}` is not discovered",
            request.public_tool
        )));
    }
    mcp_gateway::approve_once(&request.public_tool).await?;
    Ok(Json(ApprovalResponse {
        public_tool: request.public_tool,
        approved_once: true,
        expires_in_seconds: mcp_gateway::APPROVAL_TTL.as_secs(),
    }))
}

async fn extension_health(
    State(state): State<AppState>,
) -> AppResult<Json<Vec<ExtensionHealthView>>> {
    let mut result = Vec::new();
    for extension in mcp_extension_registry::list(&state.db).await? {
        let tools = mcp_extension_registry::list_tools(&state.db, &extension.id).await?;
        result.push(ExtensionHealthView {
            credential_materialized: mcp_gateway::materialized_credential(&extension.id)
                .await
                .is_some(),
            discovered_tools: tools.len(),
            exposed_tools: tools
                .iter()
                .filter(|tool| tool.policy.enabled && tool.policy.approval != ApprovalMode::Blocked)
                .count(),
            extension,
        });
    }
    Ok(Json(result))
}
