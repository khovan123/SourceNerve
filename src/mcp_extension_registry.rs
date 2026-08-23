use std::collections::{BTreeMap, BTreeSet};

use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, SqlitePool};
use url::Url;

use crate::{
    error::{AppError, AppResult},
    mcp_extension_policy::{ApprovalMode, ToolClassification, ToolPolicy},
};

const MAX_EXTENSION_ID_BYTES: usize = 64;
const MAX_NAMESPACE_BYTES: usize = 48;
const MAX_NAME_BYTES: usize = 128;
const MAX_VERSION_BYTES: usize = 64;
const MAX_SOURCE_BYTES: usize = 2048;
const MAX_SECRET_REF_BYTES: usize = 256;
const MAX_UPDATE_CHANNEL_BYTES: usize = 32;
const MAX_COMMAND_BYTES: usize = 1024;
const MAX_ARGS: usize = 64;
const MAX_ARG_BYTES: usize = 1024;
const MAX_TOOL_NAME_BYTES: usize = 128;
const MAX_TOOL_DESCRIPTION_BYTES: usize = 16 * 1024;
const MAX_TOOL_SCHEMA_BYTES: usize = 256 * 1024;
const MAX_PUBLIC_TOOL_NAME_BYTES: usize = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExtensionAuthType {
    None,
    Bearer,
    Oauth,
}

impl ExtensionAuthType {
    const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Bearer => "bearer",
            Self::Oauth => "oauth",
        }
    }

    fn parse(value: &str) -> AppResult<Self> {
        match value {
            "none" => Ok(Self::None),
            "bearer" => Ok(Self::Bearer),
            "oauth" => Ok(Self::Oauth),
            other => Err(corrupt_registry(format!(
                "invalid extension auth type `{other}`"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExtensionStatus {
    Installed,
    Enabled,
    Disabled,
    Error,
    Updating,
}

impl ExtensionStatus {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Installed => "installed",
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
            Self::Error => "error",
            Self::Updating => "updating",
        }
    }

    fn parse(value: &str) -> AppResult<Self> {
        match value {
            "installed" => Ok(Self::Installed),
            "enabled" => Ok(Self::Enabled),
            "disabled" => Ok(Self::Disabled),
            "error" => Ok(Self::Error),
            "updating" => Ok(Self::Updating),
            other => Err(corrupt_registry(format!(
                "invalid extension status `{other}`"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "kebab-case")]
pub enum ExtensionTransportConfig {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
    },
    StreamableHttp {
        url: String,
    },
}

impl ExtensionTransportConfig {
    const fn kind(&self) -> &'static str {
        match self {
            Self::Stdio { .. } => "stdio",
            Self::StreamableHttp { .. } => "streamable-http",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterExtensionRequest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub namespace: String,
    pub source: String,
    pub transport: ExtensionTransportConfig,
    #[serde(default)]
    pub auth_type: Option<ExtensionAuthType>,
    #[serde(default)]
    pub secret_ref: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default = "default_update_channel")]
    pub update_channel: String,
}

fn default_update_channel() -> String {
    "stable".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionRecord {
    pub id: String,
    pub name: String,
    pub version: String,
    pub namespace: String,
    pub source: String,
    pub transport: ExtensionTransportConfig,
    pub auth_type: ExtensionAuthType,
    pub secret_ref: Option<String>,
    pub status: ExtensionStatus,
    pub enabled: bool,
    pub required: bool,
    pub update_channel: String,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredTool {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub input_schema: Value,
    #[serde(default)]
    pub classification: ToolClassification,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionToolRecord {
    pub extension_id: String,
    pub original_name: String,
    pub public_name: String,
    pub description: Option<String>,
    pub input_schema: Value,
    pub schema_hash: String,
    pub policy: ToolPolicy,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, FromRow)]
struct ExtensionRow {
    id: String,
    name: String,
    version: String,
    namespace: String,
    source: String,
    transport: String,
    config_json: String,
    auth_type: String,
    secret_ref: Option<String>,
    status: String,
    enabled: bool,
    required: bool,
    update_channel: String,
    last_error: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, FromRow)]
struct ToolRow {
    extension_id: String,
    original_name: String,
    public_name: String,
    description: Option<String>,
    input_schema_json: String,
    schema_hash: String,
    read_only: Option<bool>,
    destructive: Option<bool>,
    idempotent: Option<bool>,
    open_world: Option<bool>,
    approval_mode: String,
    enabled: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Copy)]
struct PreservedPolicy {
    approval: ApprovalMode,
    enabled: bool,
}

pub async fn register(
    pool: &SqlitePool,
    request: RegisterExtensionRequest,
) -> AppResult<ExtensionRecord> {
    validate_registration(&request)?;
    let auth_type = request.auth_type.unwrap_or(ExtensionAuthType::None);
    validate_auth(auth_type, request.secret_ref.as_deref())?;
    let config_json = serde_json::to_string(&request.transport)
        .map_err(|error| AppError::Internal(anyhow!(error)))?;

    let result = sqlx::query(
        "INSERT INTO mcp_extensions(\
            id, name, version, namespace, transport, source, config_json, auth_type, secret_ref, status, enabled, required, update_channel\
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'installed', 0, ?10, ?11)",
    )
    .bind(&request.id)
    .bind(&request.name)
    .bind(&request.version)
    .bind(&request.namespace)
    .bind(request.transport.kind())
    .bind(&request.source)
    .bind(config_json)
    .bind(auth_type.as_str())
    .bind(request.secret_ref.as_deref())
    .bind(request.required)
    .bind(&request.update_channel)
    .execute(pool)
    .await;

    if let Err(error) = result {
        if is_unique_violation(&error) {
            return Err(AppError::InvalidRequest(format!(
                "MCP extension id `{}` or namespace `{}` is already registered",
                request.id, request.namespace
            )));
        }
        return Err(error.into());
    }

    get(pool, &request.id)
        .await?
        .ok_or_else(|| corrupt_registry("registered MCP extension disappeared"))
}

pub async fn list(pool: &SqlitePool) -> AppResult<Vec<ExtensionRecord>> {
    let rows = sqlx::query_as::<_, ExtensionRow>(
        "SELECT id, name, version, namespace, source, transport, config_json, auth_type, secret_ref, status, enabled, required, update_channel, last_error, created_at, updated_at \
         FROM mcp_extensions ORDER BY name COLLATE NOCASE, id",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(extension_from_row).collect()
}

pub async fn get(pool: &SqlitePool, id: &str) -> AppResult<Option<ExtensionRecord>> {
    validate_extension_id(id)?;
    let row = sqlx::query_as::<_, ExtensionRow>(
        "SELECT id, name, version, namespace, source, transport, config_json, auth_type, secret_ref, status, enabled, required, update_channel, last_error, created_at, updated_at \
         FROM mcp_extensions WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    row.map(extension_from_row).transpose()
}

pub async fn set_enabled(
    pool: &SqlitePool,
    id: &str,
    enabled: bool,
) -> AppResult<ExtensionRecord> {
    validate_extension_id(id)?;
    let status = if enabled {
        ExtensionStatus::Enabled
    } else {
        ExtensionStatus::Disabled
    };
    let changed = sqlx::query(
        "UPDATE mcp_extensions SET enabled = ?2, status = ?3, last_error = NULL, updated_at = unixepoch() WHERE id = ?1",
    )
    .bind(id)
    .bind(enabled)
    .bind(status.as_str())
    .execute(pool)
    .await?
    .rows_affected();
    if changed == 0 {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension `{id}` is not registered"
        )));
    }
    get(pool, id)
        .await?
        .ok_or_else(|| corrupt_registry("updated MCP extension disappeared"))
}

pub async fn mark_error(pool: &SqlitePool, id: &str, message: &str) -> AppResult<()> {
    validate_extension_id(id)?;
    if message.is_empty() || message.len() > 4096 || has_unsupported_controls(message) {
        return Err(AppError::InvalidRequest(
            "MCP extension error text must be 1-4096 UTF-8 bytes without unsupported control characters"
                .into(),
        ));
    }
    let changed = sqlx::query(
        "UPDATE mcp_extensions SET status = 'error', last_error = ?2, updated_at = unixepoch() WHERE id = ?1",
    )
    .bind(id)
    .bind(message)
    .execute(pool)
    .await?
    .rows_affected();
    if changed == 0 {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension `{id}` is not registered"
        )));
    }
    Ok(())
}

pub async fn remove(pool: &SqlitePool, id: &str) -> AppResult<bool> {
    validate_extension_id(id)?;
    let changed = sqlx::query("DELETE FROM mcp_extensions WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?
        .rows_affected();
    Ok(changed > 0)
}

pub async fn replace_discovered_tools(
    pool: &SqlitePool,
    extension_id: &str,
    tools: &[DiscoveredTool],
) -> AppResult<Vec<ExtensionToolRecord>> {
    let extension = get(pool, extension_id)
        .await?
        .ok_or_else(|| AppError::InvalidRequest(format!("MCP extension `{extension_id}` is not registered")))?;
    if tools.len() > 512 {
        return Err(AppError::InvalidRequest(
            "an MCP extension may expose at most 512 tools".into(),
        ));
    }

    let existing_rows = sqlx::query_as::<_, ToolRow>(
        "SELECT extension_id, original_name, public_name, description, input_schema_json, schema_hash, read_only, destructive, idempotent, open_world, approval_mode, enabled, created_at, updated_at \
         FROM mcp_extension_tools WHERE extension_id = ?1",
    )
    .bind(extension_id)
    .fetch_all(pool)
    .await?;
    let mut preserved = BTreeMap::new();
    for row in existing_rows {
        preserved.insert(
            row.original_name,
            PreservedPolicy {
                approval: ApprovalMode::parse(&row.approval_mode)
                    .map_err(|error| corrupt_registry(error.to_string()))?,
                enabled: row.enabled,
            },
        );
    }

    let prepared = prepare_tools(&extension.namespace, tools)?;
    let mut transaction = pool.begin().await?;
    sqlx::query("DELETE FROM mcp_extension_tools WHERE extension_id = ?1")
        .bind(extension_id)
        .execute(&mut *transaction)
        .await?;

    for tool in &prepared {
        let policy = preserved
            .get(&tool.original_name)
            .copied()
            .unwrap_or(PreservedPolicy {
                approval: ApprovalMode::Blocked,
                enabled: false,
            });
        sqlx::query(
            "INSERT INTO mcp_extension_tools(\
                extension_id, original_name, public_name, description, input_schema_json, schema_hash, read_only, destructive, idempotent, open_world, approval_mode, enabled\
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )
        .bind(extension_id)
        .bind(&tool.original_name)
        .bind(&tool.public_name)
        .bind(tool.description.as_deref())
        .bind(&tool.input_schema_json)
        .bind(&tool.schema_hash)
        .bind(tool.classification.read_only)
        .bind(tool.classification.destructive)
        .bind(tool.classification.idempotent)
        .bind(tool.classification.open_world)
        .bind(policy.approval.as_str())
        .bind(policy.enabled)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    list_tools(pool, extension_id).await
}

pub async fn list_tools(
    pool: &SqlitePool,
    extension_id: &str,
) -> AppResult<Vec<ExtensionToolRecord>> {
    validate_extension_id(extension_id)?;
    let rows = sqlx::query_as::<_, ToolRow>(
        "SELECT extension_id, original_name, public_name, description, input_schema_json, schema_hash, read_only, destructive, idempotent, open_world, approval_mode, enabled, created_at, updated_at \
         FROM mcp_extension_tools WHERE extension_id = ?1 ORDER BY public_name",
    )
    .bind(extension_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(tool_from_row).collect()
}

pub async fn set_tool_policy(
    pool: &SqlitePool,
    extension_id: &str,
    original_name: &str,
    enabled: bool,
    approval: ApprovalMode,
) -> AppResult<ExtensionToolRecord> {
    validate_extension_id(extension_id)?;
    validate_tool_name(original_name)?;
    let changed = sqlx::query(
        "UPDATE mcp_extension_tools SET enabled = ?3, approval_mode = ?4, updated_at = unixepoch() \
         WHERE extension_id = ?1 AND original_name = ?2",
    )
    .bind(extension_id)
    .bind(original_name)
    .bind(enabled)
    .bind(approval.as_str())
    .execute(pool)
    .await?
    .rows_affected();
    if changed == 0 {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension tool `{extension_id}/{original_name}` is not discovered"
        )));
    }
    let row = sqlx::query_as::<_, ToolRow>(
        "SELECT extension_id, original_name, public_name, description, input_schema_json, schema_hash, read_only, destructive, idempotent, open_world, approval_mode, enabled, created_at, updated_at \
         FROM mcp_extension_tools WHERE extension_id = ?1 AND original_name = ?2",
    )
    .bind(extension_id)
    .bind(original_name)
    .fetch_one(pool)
    .await?;
    tool_from_row(row)
}

pub fn public_tool_name(namespace: &str, original_name: &str) -> AppResult<String> {
    validate_namespace(namespace)?;
    validate_tool_name(original_name)?;
    let mut segment = String::with_capacity(original_name.len());
    let mut changed = false;
    for ch in original_name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            segment.push(ch.to_ascii_lowercase());
        } else {
            segment.push('_');
            changed = true;
        }
    }
    if segment.is_empty() {
        segment.push_str("tool");
        changed = true;
    }

    let base_prefix = format!("{namespace}__");
    let max_segment = MAX_PUBLIC_TOOL_NAME_BYTES.saturating_sub(base_prefix.len());
    if segment.len() > max_segment.saturating_sub(10) {
        segment.truncate(max_segment.saturating_sub(10));
        changed = true;
    }
    if changed {
        let hash = sha256_hex(original_name.as_bytes());
        segment.push_str("__");
        segment.push_str(&hash[..8]);
    }
    let result = format!("{base_prefix}{segment}");
    if result.len() > MAX_PUBLIC_TOOL_NAME_BYTES {
        return Err(AppError::InvalidRequest(
            "generated MCP public tool name exceeds the supported limit".into(),
        ));
    }
    Ok(result)
}

struct PreparedTool {
    original_name: String,
    public_name: String,
    description: Option<String>,
    input_schema_json: String,
    schema_hash: String,
    classification: ToolClassification,
}

fn prepare_tools(namespace: &str, tools: &[DiscoveredTool]) -> AppResult<Vec<PreparedTool>> {
    let mut original_names = BTreeSet::new();
    let mut public_names = BTreeSet::new();
    let mut prepared = Vec::with_capacity(tools.len());
    for tool in tools {
        validate_tool_name(&tool.name)?;
        if !original_names.insert(tool.name.clone()) {
            return Err(AppError::InvalidRequest(format!(
                "downstream MCP returned duplicate tool name `{}`",
                tool.name
            )));
        }
        if let Some(description) = &tool.description {
            if description.len() > MAX_TOOL_DESCRIPTION_BYTES || has_unsupported_controls(description)
            {
                return Err(AppError::InvalidRequest(format!(
                    "description for MCP tool `{}` exceeds the supported bounds",
                    tool.name
                )));
            }
        }
        let input_schema_json = serde_json::to_string(&tool.input_schema)
            .map_err(|error| AppError::Internal(anyhow!(error)))?;
        if input_schema_json.len() > MAX_TOOL_SCHEMA_BYTES {
            return Err(AppError::InvalidRequest(format!(
                "input schema for MCP tool `{}` exceeds {MAX_TOOL_SCHEMA_BYTES} bytes",
                tool.name
            )));
        }
        let public_name = public_tool_name(namespace, &tool.name)?;
        if !public_names.insert(public_name.clone()) {
            return Err(AppError::InvalidRequest(format!(
                "MCP namespace normalization produced a duplicate public tool `{public_name}`"
            )));
        }
        prepared.push(PreparedTool {
            original_name: tool.name.clone(),
            public_name,
            description: tool.description.clone(),
            schema_hash: sha256_hex(input_schema_json.as_bytes()),
            input_schema_json,
            classification: tool.classification,
        });
    }
    Ok(prepared)
}

fn extension_from_row(row: ExtensionRow) -> AppResult<ExtensionRecord> {
    let transport: ExtensionTransportConfig = serde_json::from_str(&row.config_json)
        .map_err(|error| corrupt_registry(format!("invalid extension transport JSON: {error}")))?;
    if transport.kind() != row.transport {
        return Err(corrupt_registry(format!(
            "extension `{}` transport column does not match config",
            row.id
        )));
    }
    Ok(ExtensionRecord {
        id: row.id,
        name: row.name,
        version: row.version,
        namespace: row.namespace,
        source: row.source,
        transport,
        auth_type: ExtensionAuthType::parse(&row.auth_type)?,
        secret_ref: row.secret_ref,
        status: ExtensionStatus::parse(&row.status)?,
        enabled: row.enabled,
        required: row.required,
        update_channel: row.update_channel,
        last_error: row.last_error,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn tool_from_row(row: ToolRow) -> AppResult<ExtensionToolRecord> {
    let input_schema = serde_json::from_str(&row.input_schema_json)
        .map_err(|error| corrupt_registry(format!("invalid persisted MCP tool schema: {error}")))?;
    Ok(ExtensionToolRecord {
        extension_id: row.extension_id,
        original_name: row.original_name,
        public_name: row.public_name,
        description: row.description,
        input_schema,
        schema_hash: row.schema_hash,
        policy: ToolPolicy {
            enabled: row.enabled,
            approval: ApprovalMode::parse(&row.approval_mode)
                .map_err(|error| corrupt_registry(error.to_string()))?,
            classification: ToolClassification {
                read_only: row.read_only,
                destructive: row.destructive,
                idempotent: row.idempotent,
                open_world: row.open_world,
            },
        },
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn validate_registration(request: &RegisterExtensionRequest) -> AppResult<()> {
    validate_extension_id(&request.id)?;
    validate_namespace(&request.namespace)?;
    if request.namespace == "sourcenerve" {
        return Err(AppError::InvalidRequest(
            "the `sourcenerve` MCP namespace is reserved for native tools".into(),
        ));
    }
    validate_text(&request.name, "extension name", MAX_NAME_BYTES)?;
    validate_text(&request.version, "extension version", MAX_VERSION_BYTES)?;
    validate_text(&request.source, "extension source", MAX_SOURCE_BYTES)?;
    validate_identifier(
        &request.update_channel,
        "update_channel",
        MAX_UPDATE_CHANNEL_BYTES,
    )?;
    match &request.transport {
        ExtensionTransportConfig::Stdio { command, args } => {
            validate_stdio(command, args)?;
        }
        ExtensionTransportConfig::StreamableHttp { url } => validate_http_url(url)?,
    }
    Ok(())
}

fn validate_auth(auth: ExtensionAuthType, secret_ref: Option<&str>) -> AppResult<()> {
    match (auth, secret_ref) {
        (ExtensionAuthType::None, Some(_)) => Err(AppError::InvalidRequest(
            "MCP extension with auth_type `none` must not declare a secret_ref".into(),
        )),
        (ExtensionAuthType::Bearer, None) => Err(AppError::InvalidRequest(
            "MCP extension with bearer auth requires a secure-store secret_ref".into(),
        )),
        (_, Some(value)) => validate_secret_ref(value),
        _ => Ok(()),
    }
}

fn validate_extension_id(value: &str) -> AppResult<()> {
    validate_identifier(value, "extension id", MAX_EXTENSION_ID_BYTES)
}

fn validate_namespace(value: &str) -> AppResult<()> {
    validate_identifier(value, "extension namespace", MAX_NAMESPACE_BYTES)
}

fn validate_identifier(value: &str, field: &str, max: usize) -> AppResult<()> {
    if value.is_empty()
        || value.len() > max
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-'))
    {
        return Err(AppError::InvalidRequest(format!(
            "{field} must be 1-{max} lowercase ASCII characters using letters, digits, '_' or '-'"
        )));
    }
    Ok(())
}

fn validate_text(value: &str, field: &str, max: usize) -> AppResult<()> {
    if value.trim().is_empty() || value.len() > max || has_unsupported_controls(value) {
        return Err(AppError::InvalidRequest(format!(
            "{field} must be non-empty, at most {max} UTF-8 bytes, and contain no unsupported control characters"
        )));
    }
    Ok(())
}

fn validate_secret_ref(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > MAX_SECRET_REF_BYTES
        || !value.is_ascii()
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(AppError::InvalidRequest(
            "MCP extension secret_ref must be a bounded printable ASCII secure-store reference"
                .into(),
        ));
    }
    Ok(())
}

fn validate_stdio(command: &str, args: &[String]) -> AppResult<()> {
    if command.is_empty()
        || command.len() > MAX_COMMAND_BYTES
        || !command.is_ascii()
        || command.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(AppError::InvalidRequest(
            "stdio MCP command must be a bounded printable ASCII executable name or path".into(),
        ));
    }
    if args.len() > MAX_ARGS {
        return Err(AppError::InvalidRequest(format!(
            "stdio MCP command may define at most {MAX_ARGS} arguments"
        )));
    }
    for arg in args {
        if arg.len() > MAX_ARG_BYTES || arg.bytes().any(|byte| byte == 0 || byte.is_ascii_control())
        {
            return Err(AppError::InvalidRequest(
                "stdio MCP arguments must be bounded strings without control characters".into(),
            ));
        }
    }
    Ok(())
}

fn validate_http_url(value: &str) -> AppResult<()> {
    if value.len() > MAX_SOURCE_BYTES {
        return Err(AppError::InvalidRequest(
            "Streamable HTTP MCP URL exceeds the supported limit".into(),
        ));
    }
    let url = Url::parse(value)
        .map_err(|_| AppError::InvalidRequest("invalid Streamable HTTP MCP URL".into()))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::InvalidRequest(
            "Streamable HTTP MCP URL must be an http/https URL without embedded credentials or fragments"
                .into(),
        ));
    }
    Ok(())
}

fn validate_tool_name(value: &str) -> AppResult<()> {
    if value.trim().is_empty()
        || value.len() > MAX_TOOL_NAME_BYTES
        || has_unsupported_controls(value)
    {
        return Err(AppError::InvalidRequest(format!(
            "downstream MCP tool name must be non-empty and at most {MAX_TOOL_NAME_BYTES} UTF-8 bytes"
        )));
    }
    Ok(())
}

fn has_unsupported_controls(value: &str) -> bool {
    value
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
}

fn sha256_hex(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

fn corrupt_registry(message: impl Into<String>) -> AppError {
    AppError::Internal(anyhow!(
        "corrupt MCP extension registry state: {}",
        message.into()
    ))
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    matches!(error, sqlx::Error::Database(database) if database.is_unique_violation())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("pool");
        sqlx::migrate!().run(&pool).await.expect("migrations");
        pool
    }

    fn stdio_extension(id: &str, namespace: &str) -> RegisterExtensionRequest {
        RegisterExtensionRequest {
            id: id.into(),
            name: "Codebase Memory".into(),
            version: "1.0.0".into(),
            namespace: namespace.into(),
            source: "catalog:codebase-memory".into(),
            transport: ExtensionTransportConfig::Stdio {
                command: "codebase-memory".into(),
                args: vec!["serve".into()],
            },
            auth_type: Some(ExtensionAuthType::None),
            secret_ref: None,
            required: false,
            update_channel: "stable".into(),
        }
    }

    #[tokio::test]
    async fn registers_and_restores_extension() {
        let pool = test_pool().await;
        let created = register(&pool, stdio_extension("codebase-memory", "memory"))
            .await
            .expect("register");
        assert_eq!(created.status, ExtensionStatus::Installed);
        assert!(!created.enabled);

        let restored = list(&pool).await.expect("list");
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].namespace, "memory");
        assert!(matches!(
            restored[0].transport,
            ExtensionTransportConfig::Stdio { .. }
        ));
    }

    #[tokio::test]
    async fn rejects_duplicate_namespace() {
        let pool = test_pool().await;
        register(&pool, stdio_extension("memory-one", "memory"))
            .await
            .expect("first");
        let error = register(&pool, stdio_extension("memory-two", "memory"))
            .await
            .expect_err("duplicate rejected");
        assert!(error.to_string().contains("already registered"));
    }

    #[tokio::test]
    async fn discovered_tools_start_fail_closed_and_preserve_policy_on_refresh() {
        let pool = test_pool().await;
        register(&pool, stdio_extension("codebase-memory", "memory"))
            .await
            .expect("register");
        let discovered = vec![DiscoveredTool {
            name: "search-code".into(),
            description: Some("Search remembered code context".into()),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"]
            }),
            classification: ToolClassification {
                read_only: Some(true),
                destructive: Some(false),
                idempotent: Some(true),
                open_world: Some(false),
            },
        }];
        let tools = replace_discovered_tools(&pool, "codebase-memory", &discovered)
            .await
            .expect("discover");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].public_name.len() <= MAX_PUBLIC_TOOL_NAME_BYTES, true);
        assert_eq!(tools[0].policy.approval, ApprovalMode::Blocked);
        assert!(!tools[0].policy.enabled);

        set_tool_policy(
            &pool,
            "codebase-memory",
            "search-code",
            true,
            ApprovalMode::Automatic,
        )
        .await
        .expect("policy");

        let refreshed = replace_discovered_tools(&pool, "codebase-memory", &discovered)
            .await
            .expect("refresh");
        assert!(refreshed[0].policy.enabled);
        assert_eq!(refreshed[0].policy.approval, ApprovalMode::Automatic);
    }

    #[test]
    fn namespace_normalization_is_deterministic_and_collision_resistant() {
        assert_eq!(
            public_tool_name("memory", "search_code").expect("plain"),
            "memory__search_code"
        );
        let dashed = public_tool_name("memory", "search-code").expect("dashed");
        assert!(dashed.starts_with("memory__search_code__"));
        assert_ne!(dashed, "memory__search_code");
    }

    #[test]
    fn reserved_native_namespace_is_rejected() {
        let request = stdio_extension("fake-native", "sourcenerve");
        let error = validate_registration(&request).expect_err("reserved");
        assert!(error.to_string().contains("reserved"));
    }
}
