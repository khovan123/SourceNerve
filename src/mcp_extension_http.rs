use std::{
    collections::BTreeMap,
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};

use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use rmcp::{Peer, RoleServer};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::{
    error::{AppError, AppResult},
    mcp_extension_policy::ApprovalMode,
    mcp_extension_registry::{
        self, ExtensionAuthType, ExtensionRecord, ExtensionToolRecord, RegisterExtensionRequest,
    },
    mcp_gateway,
    service::AppState,
};

static TOOL_CATALOG_VERSION: AtomicU64 = AtomicU64::new(1);
static TOOL_LIST_PEERS: OnceLock<Mutex<Vec<Peer<RoleServer>>>> = OnceLock::new();

fn tool_list_peers() -> &'static Mutex<Vec<Peer<RoleServer>>> {
    TOOL_LIST_PEERS.get_or_init(|| Mutex::new(Vec::new()))
}

pub(crate) fn tool_catalog_version() -> u64 {
    TOOL_CATALOG_VERSION.load(Ordering::Acquire)
}

pub(crate) async fn register_tool_list_peer(peer: Peer<RoleServer>) {
    tool_list_peers().lock().await.push(peer);
}

pub(crate) async fn publish_tool_catalog_change(reason: &'static str) -> u64 {
    let version = TOOL_CATALOG_VERSION.fetch_add(1, Ordering::AcqRel) + 1;
    let connected = {
        let mut peers = tool_list_peers().lock().await;
        std::mem::take(&mut *peers)
    };
    let mut alive = Vec::with_capacity(connected.len());
    for peer in connected {
        match peer.notify_tool_list_changed().await {
            Ok(()) => alive.push(peer),
            Err(error) => {
                tracing::debug!(
                    error = %error,
                    catalog_version = version,
                    "dropping disconnected MCP tool-list notification peer"
                );
            }
        }
    }
    let active_peers = alive.len();
    tool_list_peers().lock().await.extend(alive);
    tracing::info!(
        catalog_version = version,
        reason,
        active_peers,
        "MCP tool catalog changed"
    );
    version
}

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
struct EnvironmentRequest {
    extension_id: String,
    values: BTreeMap<String, String>,
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
struct EnvironmentStatusResponse {
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
    pub environment_materialized: bool,
    pub catalog_version: u64,
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
        .route(
            "/mcp/extensions/environment/materialize",
            post(materialize_environment),
        )
        .route("/mcp/extensions/environment/clear", post(clear_environment))
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
    let extension = mcp_extension_registry::register(&state.db, request).await?;
    publish_tool_catalog_change("extension-installed").await;
    Ok(Json(extension))
}

async fn enable_extension(
    State(state): State<AppState>,
    Json(request): Json<ExtensionIdRequest>,
) -> AppResult<Json<ExtensionRecord>> {
    let extension =
        mcp_extension_registry::set_enabled(&state.db, &request.extension_id, true).await?;
    let result: AppResult<Json<ExtensionRecord>> = async {
        let bearer = mcp_gateway::materialized_credential(&extension.id).await;
        if extension.auth_type == ExtensionAuthType::None || bearer.is_some() {
            mcp_gateway::refresh_extension(&state.db, &extension.id, bearer.as_deref()).await?;
        }
        let extension = mcp_extension_registry::get(&state.db, &request.extension_id)
            .await?
            .ok_or_else(|| AppError::InvalidRequest("enabled MCP extension disappeared".into()))?;
        Ok(Json(extension))
    }
    .await;
    publish_tool_catalog_change("extension-enabled").await;
    result
}

async fn disable_extension(
    State(state): State<AppState>,
    Json(request): Json<ExtensionIdRequest>,
) -> AppResult<Json<ExtensionRecord>> {
    mcp_gateway::clear_materialized_credential(&request.extension_id).await;
    mcp_gateway::clear_materialized_environment(&request.extension_id).await;
    let extension =
        mcp_extension_registry::set_enabled(&state.db, &request.extension_id, false).await?;
    publish_tool_catalog_change("extension-disabled").await;
    Ok(Json(extension))
}

async fn remove_extension(
    State(state): State<AppState>,
    Json(request): Json<ExtensionIdRequest>,
) -> AppResult<Json<RemoveResponse>> {
    mcp_gateway::clear_materialized_credential(&request.extension_id).await;
    mcp_gateway::clear_materialized_environment(&request.extension_id).await;
    let removed = mcp_extension_registry::remove(&state.db, &request.extension_id).await?;
    if removed {
        publish_tool_catalog_change("extension-removed").await;
    }
    Ok(Json(RemoveResponse { removed }))
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
    let tools = mcp_gateway::refresh_extension(&state.db, &extension.id, bearer.as_deref()).await?;
    publish_tool_catalog_change("extension-restarted").await;
    Ok(Json(tools))
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
    let tool = mcp_extension_registry::set_tool_policy(
        &state.db,
        &request.extension_id,
        &request.tool_name,
        request.enabled,
        request.approval,
    )
    .await?;
    publish_tool_catalog_change("extension-tool-policy-changed").await;
    Ok(Json(tool))
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

async fn materialize_environment(
    State(state): State<AppState>,
    Json(request): Json<EnvironmentRequest>,
) -> AppResult<Json<EnvironmentStatusResponse>> {
    let extension = mcp_extension_registry::get(&state.db, &request.extension_id)
        .await?
        .ok_or_else(|| {
            AppError::InvalidRequest(format!(
                "MCP extension `{}` is not registered",
                request.extension_id
            ))
        })?;
    if !matches!(
        extension.transport,
        mcp_extension_registry::ExtensionTransportConfig::Stdio { .. }
    ) {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension `{}` does not accept stdio environment material",
            extension.id
        )));
    }
    mcp_gateway::materialize_environment(&extension.id, &request.values).await?;
    Ok(Json(EnvironmentStatusResponse {
        extension_id: extension.id,
        materialized: !request.values.is_empty(),
    }))
}

async fn clear_environment(
    State(state): State<AppState>,
    Json(request): Json<ExtensionIdRequest>,
) -> AppResult<Json<EnvironmentStatusResponse>> {
    if mcp_extension_registry::get(&state.db, &request.extension_id)
        .await?
        .is_none()
    {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension `{}` is not registered",
            request.extension_id
        )));
    }
    mcp_gateway::clear_materialized_environment(&request.extension_id).await;
    Ok(Json(EnvironmentStatusResponse {
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
            environment_materialized: mcp_gateway::materialized_environment(&extension.id)
                .await
                .is_some(),
            discovered_tools: tools.len(),
            exposed_tools: tools
                .iter()
                .filter(|tool| tool.policy.enabled && tool.policy.approval != ApprovalMode::Blocked)
                .count(),
            catalog_version: tool_catalog_version(),
            extension,
        });
    }
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use axum::Router;
    use rmcp::{
        ClientHandler, RoleClient, ServiceExt,
        model::CallToolRequestParams,
        service::NotificationContext,
        tool, tool_router,
        transport::{
            StreamableHttpClientTransport,
            streamable_http_client::StreamableHttpClientTransportConfig,
            streamable_http_server::{
                StreamableHttpServerConfig, StreamableHttpService,
                session::local::LocalSessionManager,
            },
        },
    };
    use tokio::{net::TcpListener, sync::Mutex, time::timeout};

    use super::*;
    use crate::{db, service::AppState, workspace::WorkspaceRegistry};

    #[derive(Clone)]
    struct FakeMemoryMcp {
        calls: Arc<AtomicUsize>,
    }

    #[tool_router(server_handler)]
    impl FakeMemoryMcp {
        #[tool(description = "Search fake downstream memory.")]
        async fn search(&self) -> String {
            self.calls.fetch_add(1, Ordering::SeqCst);
            "fake-memory-hit".to_string()
        }
    }

    #[derive(Clone, Default)]
    struct RecordingClient {
        tool_list_changes: Arc<AtomicUsize>,
    }

    impl ClientHandler for RecordingClient {
        async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) {
            self.tool_list_changes.fetch_add(1, Ordering::SeqCst);
        }
    }

    async fn spawn_fake_memory_mcp(
        calls: Arc<AtomicUsize>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let service = StreamableHttpService::new(
            move || {
                Ok(FakeMemoryMcp {
                    calls: calls.clone(),
                })
            },
            LocalSessionManager::default().into(),
            StreamableHttpServerConfig::default()
                .with_legacy_session_mode(false)
                .with_json_response(true)
                .with_allowed_hosts(["127.0.0.1", "localhost"]),
        );
        let app = Router::new().nest_service("/mcp", service);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake MCP listener");
        let address = listener.local_addr().expect("fake MCP local address");
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve fake downstream MCP");
        });
        (format!("http://{address}/mcp"), task)
    }

    async fn spawn_sourcenerve(
        state: AppState,
        bearer: &str,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let app = crate::http::router(state, bearer.to_owned(), None, None, None, false);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind SourceNerve test listener");
        let address = listener.local_addr().expect("SourceNerve local address");
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve SourceNerve test router");
        });
        (format!("http://{address}"), task)
    }

    async fn admin_post(base: &str, path: &str, bearer: &str, body: serde_json::Value) {
        let response = reqwest::Client::new()
            .post(format!("{base}{path}"))
            .bearer_auth(bearer)
            .json(&body)
            .send()
            .await
            .expect("send SourceNerve admin request");
        let status = response.status();
        let text = response.text().await.expect("read admin response");
        assert!(status.is_success(), "{path} returned {status}: {text}");
    }

    async fn wait_for_notification(client: &RecordingClient, previous: usize) {
        timeout(Duration::from_secs(3), async {
            loop {
                if client.tool_list_changes.load(Ordering::SeqCst) > previous {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("connected MCP client should receive tools/list_changed");
    }

    #[tokio::test]
    async fn extension_lifecycle_notifies_connected_client_and_routes_discovered_tool() {
        let fixture = tempfile::tempdir().expect("fixture tempdir");
        let registry = WorkspaceRegistry::build(&[]).expect("empty workspace registry");
        let pool = db::connect(&fixture.path().join("state"))
            .await
            .expect("connect fixture database");
        let state = AppState {
            workspaces: registry,
            db: pool,
            mutation_lock: Arc::new(Mutex::new(())),
            github_token: None,
        };

        let downstream_calls = Arc::new(AtomicUsize::new(0));
        let (downstream_url, downstream_task) =
            spawn_fake_memory_mcp(downstream_calls.clone()).await;
        let bearer = "mcp-extension-integration-test-bearer";
        let (base_url, sourcenerve_task) = spawn_sourcenerve(state, bearer).await;

        let recording_client = RecordingClient::default();
        let transport = StreamableHttpClientTransport::from_config(
            StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
                .auth_header(bearer.to_owned()),
        );
        let client = recording_client
            .clone()
            .serve(transport)
            .await
            .expect("connect SourceNerve MCP client");

        let initial_tools = client.list_all_tools().await.expect("list initial tools");
        assert!(
            initial_tools
                .iter()
                .all(|tool| tool.name.as_ref() != "memory__search")
        );

        let mut version = tool_catalog_version();
        let mut notifications = recording_client.tool_list_changes.load(Ordering::SeqCst);
        admin_post(
            &base_url,
            "/api/v1/mcp/extensions/register",
            bearer,
            serde_json::json!({
                "id": "memory",
                "name": "Fake Memory",
                "version": "1.0.0",
                "namespace": "memory",
                "source": "test:fake-memory",
                "transport": {
                    "transport": "streamable-http",
                    "url": downstream_url
                },
                "auth_type": "none",
                "required": false,
                "update_channel": "stable"
            }),
        )
        .await;
        assert!(tool_catalog_version() > version);
        version = tool_catalog_version();
        wait_for_notification(&recording_client, notifications).await;
        notifications = recording_client.tool_list_changes.load(Ordering::SeqCst);

        admin_post(
            &base_url,
            "/api/v1/mcp/extensions/enable",
            bearer,
            serde_json::json!({ "extension_id": "memory" }),
        )
        .await;
        assert!(tool_catalog_version() > version);
        version = tool_catalog_version();
        wait_for_notification(&recording_client, notifications).await;
        notifications = recording_client.tool_list_changes.load(Ordering::SeqCst);

        admin_post(
            &base_url,
            "/api/v1/mcp/extensions/tools/policy",
            bearer,
            serde_json::json!({
                "extension_id": "memory",
                "tool_name": "search",
                "enabled": true,
                "approval": "automatic"
            }),
        )
        .await;
        assert!(tool_catalog_version() > version);
        version = tool_catalog_version();
        wait_for_notification(&recording_client, notifications).await;

        let exposed_tools = client.list_all_tools().await.expect("list exposed tools");
        assert!(
            exposed_tools
                .iter()
                .any(|tool| tool.name.as_ref() == "memory__search")
        );
        client
            .call_tool(CallToolRequestParams::new("memory__search"))
            .await
            .expect("call namespaced downstream tool");
        assert_eq!(downstream_calls.load(Ordering::SeqCst), 1);

        notifications = recording_client.tool_list_changes.load(Ordering::SeqCst);
        admin_post(
            &base_url,
            "/api/v1/mcp/extensions/disable",
            bearer,
            serde_json::json!({ "extension_id": "memory" }),
        )
        .await;
        assert!(tool_catalog_version() > version);
        version = tool_catalog_version();
        wait_for_notification(&recording_client, notifications).await;
        let disabled_tools = client.list_all_tools().await.expect("list disabled tools");
        assert!(
            disabled_tools
                .iter()
                .all(|tool| tool.name.as_ref() != "memory__search")
        );

        notifications = recording_client.tool_list_changes.load(Ordering::SeqCst);
        admin_post(
            &base_url,
            "/api/v1/mcp/extensions/enable",
            bearer,
            serde_json::json!({ "extension_id": "memory" }),
        )
        .await;
        assert!(tool_catalog_version() > version);
        version = tool_catalog_version();
        wait_for_notification(&recording_client, notifications).await;
        let reenabled_tools = client
            .list_all_tools()
            .await
            .expect("list re-enabled tools");
        assert!(
            reenabled_tools
                .iter()
                .any(|tool| tool.name.as_ref() == "memory__search")
        );

        notifications = recording_client.tool_list_changes.load(Ordering::SeqCst);
        admin_post(
            &base_url,
            "/api/v1/mcp/extensions/remove",
            bearer,
            serde_json::json!({ "extension_id": "memory" }),
        )
        .await;
        assert!(tool_catalog_version() > version);
        wait_for_notification(&recording_client, notifications).await;
        let removed_tools = client
            .list_all_tools()
            .await
            .expect("list tools after remove");
        assert!(
            removed_tools
                .iter()
                .all(|tool| tool.name.as_ref() != "memory__search")
        );

        client
            .cancel()
            .await
            .expect("disconnect SourceNerve MCP client");
        sourcenerve_task.abort();
        downstream_task.abort();
    }
}
