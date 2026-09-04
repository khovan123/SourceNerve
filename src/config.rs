use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

use crate::runtime::STATE_SCHEMA_VERSION;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub storage: StorageConfig,
    #[serde(default)]
    pub auth: AuthConfig,
    #[serde(default)]
    pub oauth: OAuthConfig,
    #[serde(default)]
    pub github: GitHubConfig,
    #[serde(default)]
    pub workspace: Vec<WorkspaceConfig>,
    /// Environment-only job webhook secret. It is intentionally not accepted from TOML.
    #[serde(skip)]
    pub webhook_secret: Option<String>,
    /// Environment-only GitHub webhook secret. It is intentionally not accepted from TOML.
    #[serde(skip)]
    pub github_webhook_secret: Option<String>,
    /// Environment-only callback destination. Dynamic request-provided callback URLs are unsupported.
    #[serde(skip)]
    pub callback_url: Option<String>,
    /// Environment-only callback signing secret.
    #[serde(skip)]
    pub callback_secret: Option<String>,
    /// Test/development escape hatch for a literal loopback HTTP receiver.
    #[serde(skip)]
    pub callback_allow_insecure_loopback: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    #[serde(default = "default_bind")]
    pub bind: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: default_bind(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct StorageConfig {
    #[serde(default = "default_state_dir")]
    pub state_dir: PathBuf,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            state_dir: default_state_dir(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct AuthConfig {
    /// May be omitted from TOML when SOURCENERVE_BEARER_TOKEN supplies the managed secret.
    #[serde(default)]
    pub bearer_token: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OAuthConfig {
    /// OAuth/OIDC authorization-server issuer. When omitted together with `resource`, MCP OAuth is disabled.
    pub issuer: Option<String>,
    /// Canonical public MCP resource URI, for example https://sourcenerve.example.com/mcp.
    pub resource: Option<String>,
    /// Explicit compatibility escape hatch. Keep false on a public OAuth deployment.
    #[serde(default)]
    pub allow_operator_bearer: bool,
    /// Reject provider access tokens whose declared exp-iat lifetime exceeds this bound.
    #[serde(default = "default_oauth_max_token_lifetime_seconds")]
    pub max_token_lifetime_seconds: u64,
    /// Exact OIDC subject-to-workspace grants. Provider identity and repository credentials stay separate.
    #[serde(default, rename = "grant")]
    pub grants: Vec<OAuthGrantConfig>,
}

impl Default for OAuthConfig {
    fn default() -> Self {
        Self {
            issuer: None,
            resource: None,
            allow_operator_bearer: false,
            max_token_lifetime_seconds: default_oauth_max_token_lifetime_seconds(),
            grants: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct OAuthGrantConfig {
    pub subject: String,
    pub workspace: String,
    #[serde(default = "default_oauth_access")]
    pub access: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct GitHubConfig {
    /// Prefer SOURCENERVE_GITHUB_TOKEN in production. Never exposed through API/MCP.
    pub token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceConfig {
    pub id: String,
    pub name: String,
    pub root: PathBuf,
    #[serde(default = "default_access")]
    pub access: String,
    #[serde(default = "default_remote")]
    pub remote: String,
    #[serde(default = "default_branch")]
    pub default_branch: String,
    /// Explicit repository-host lifecycle provider. Supported values: github, gitlab.
    pub provider: Option<String>,
    /// Provider repository slug. GitHub uses owner/repo; GitLab also allows subgroups.
    pub repository: Option<String>,
    /// Legacy GitHub owner/repo override retained for backward compatibility.
    pub github_repository: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LegacyImportPreview {
    pub config_path: String,
    pub workspaces: Vec<LegacyWorkspacePreview>,
    pub state: LegacyStatePreview,
    pub legacy_product: LegacyProductPreview,
    pub reconnect: LegacyReconnectPreview,
}

#[derive(Debug, Clone, Serialize)]
pub struct LegacyWorkspacePreview {
    pub id: String,
    pub name: String,
    pub root: String,
    pub access: String,
    pub remote: String,
    pub default_branch: String,
    pub provider: Option<String>,
    pub repository: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LegacyStatePreview {
    pub path: String,
    pub database_exists: bool,
    pub schema_version: Option<i64>,
    pub supported_schema_version: u32,
    pub status: String,
    pub integrity: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LegacyProductPreview {
    pub server_bind: String,
    pub oauth_issuer: Option<String>,
    pub oauth_resource: Option<String>,
    pub allow_operator_bearer: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LegacyReconnectPreview {
    pub local_bearer: bool,
    pub auth0: bool,
    pub providers: Vec<String>,
    pub ignored_inline_bearer: bool,
    pub ignored_inline_github_token: bool,
    pub shell_environment_inspected: bool,
}

impl Config {
    pub async fn load() -> Result<Self> {
        let path = env::var("SOURCENERVE_CONFIG").unwrap_or_else(|_| "sourcenerve.toml".into());
        let raw = tokio::fs::read_to_string(&path)
            .await
            .with_context(|| format!("failed to read config at {path}"))?;
        let mut cfg: Self =
            toml::from_str(&raw).context("invalid SourceNerve TOML configuration")?;

        if let Ok(token) = env::var("SOURCENERVE_BEARER_TOKEN") {
            cfg.auth.bearer_token = token;
        }
        if let Ok(issuer) = env::var("SOURCENERVE_OAUTH_ISSUER") {
            cfg.oauth.issuer = Some(issuer);
        }
        if let Ok(resource) = env::var("SOURCENERVE_OAUTH_RESOURCE") {
            cfg.oauth.resource = Some(resource);
        }
        if env::var_os("SOURCENERVE_OAUTH_ALLOW_OPERATOR_BEARER").is_some() {
            cfg.oauth.allow_operator_bearer = env_bool("SOURCENERVE_OAUTH_ALLOW_OPERATOR_BEARER")?;
        }
        if let Ok(token) = env::var("SOURCENERVE_GITHUB_TOKEN") {
            cfg.github.token = Some(token);
        }
        if let Ok(secret) = env::var("SOURCENERVE_WEBHOOK_SECRET") {
            cfg.webhook_secret = Some(secret);
        }
        if let Ok(secret) = env::var("SOURCENERVE_GITHUB_WEBHOOK_SECRET") {
            cfg.github_webhook_secret = Some(secret);
        }
        if let Ok(url) = env::var("SOURCENERVE_CALLBACK_URL") {
            cfg.callback_url = Some(url);
        }
        if let Ok(secret) = env::var("SOURCENERVE_CALLBACK_SECRET") {
            cfg.callback_secret = Some(secret);
        }
        cfg.callback_allow_insecure_loopback =
            env_bool("SOURCENERVE_CALLBACK_ALLOW_INSECURE_LOOPBACK")?;
        if let Ok(bind) = env::var("SOURCENERVE_BIND") {
            cfg.server.bind = bind;
        }

        validate_runtime_config(&cfg)?;
        Ok(cfg)
    }

    pub async fn inspect_legacy_file(path: &Path) -> Result<LegacyImportPreview> {
        let metadata = tokio::fs::metadata(path)
            .await
            .with_context(|| format!("failed to inspect legacy config at {}", path.display()))?;
        if !metadata.is_file() || metadata.len() > 2 * 1024 * 1024 {
            bail!("legacy SourceNerve config must be a regular file no larger than 2 MB");
        }
        let raw = tokio::fs::read_to_string(path)
            .await
            .with_context(|| format!("failed to read legacy config at {}", path.display()))?;
        let cfg: Self =
            toml::from_str(&raw).context("invalid legacy SourceNerve TOML configuration")?;
        validate_workspace_entries(&cfg.workspace)?;
        if cfg.workspace.is_empty() {
            bail!("legacy config must contain at least one [[workspace]] entry");
        }

        let config_path = tokio::fs::canonicalize(path).await.with_context(|| {
            format!("failed to canonicalize legacy config at {}", path.display())
        })?;
        let config_directory = config_path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("legacy config path has no parent directory"))?;
        let state_dir = resolve_legacy_path(config_directory, &cfg.storage.state_dir);
        let state = inspect_legacy_state(&state_dir).await;

        let mut providers = HashSet::new();
        let workspaces = cfg
            .workspace
            .iter()
            .map(|workspace| {
                let provider = workspace.provider.clone().or_else(|| {
                    workspace
                        .github_repository
                        .as_ref()
                        .map(|_| "github".to_string())
                });
                if let Some(value) = provider.as_deref() {
                    providers.insert(value.to_string());
                }
                LegacyWorkspacePreview {
                    id: workspace.id.clone(),
                    name: workspace.name.clone(),
                    root: resolve_legacy_path(config_directory, &workspace.root)
                        .to_string_lossy()
                        .into_owned(),
                    access: workspace.access.clone(),
                    remote: workspace.remote.clone(),
                    default_branch: workspace.default_branch.clone(),
                    provider,
                    repository: workspace
                        .repository
                        .clone()
                        .or_else(|| workspace.github_repository.clone()),
                }
            })
            .collect();
        let mut providers: Vec<String> = providers.into_iter().collect();
        providers.sort();

        Ok(LegacyImportPreview {
            config_path: config_path.to_string_lossy().into_owned(),
            workspaces,
            state,
            legacy_product: LegacyProductPreview {
                server_bind: cfg.server.bind.clone(),
                oauth_issuer: cfg.oauth.issuer.clone(),
                oauth_resource: cfg.oauth.resource.clone(),
                allow_operator_bearer: cfg.oauth.allow_operator_bearer,
            },
            reconnect: LegacyReconnectPreview {
                local_bearer: true,
                auth0: cfg.oauth.issuer.is_some() || cfg.oauth.resource.is_some(),
                providers,
                ignored_inline_bearer: !cfg.auth.bearer_token.is_empty(),
                ignored_inline_github_token: cfg.github.token.is_some(),
                shell_environment_inspected: false,
            },
        })
    }
}

fn validate_runtime_config(cfg: &Config) -> Result<()> {
    if cfg.auth.bearer_token.trim().len() < 24 {
        bail!("auth.bearer_token must be at least 24 characters");
    }
    match (cfg.oauth.issuer.as_deref(), cfg.oauth.resource.as_deref()) {
        (None, None) => {
            if !cfg.oauth.grants.is_empty() {
                bail!("oauth.grant entries require oauth.issuer and oauth.resource");
            }
        }
        (Some(issuer), Some(resource)) => {
            if issuer.trim().is_empty() || resource.trim().is_empty() {
                bail!("oauth.issuer and oauth.resource must not be blank");
            }
            if !(60..=3600).contains(&cfg.oauth.max_token_lifetime_seconds) {
                bail!("oauth.max_token_lifetime_seconds must be between 60 and 3600");
            }
        }
        _ => bail!("oauth.issuer and oauth.resource must be configured together"),
    }
    if let Some(token) = cfg.github.token.as_deref() {
        if token.trim().len() < 20 {
            bail!("github.token must be empty/omitted or at least 20 characters");
        }
    }
    if let Some(secret) = cfg.webhook_secret.as_deref() {
        validate_secret("SOURCENERVE_WEBHOOK_SECRET", secret)?;
    }
    if let Some(secret) = cfg.github_webhook_secret.as_deref() {
        validate_secret("SOURCENERVE_GITHUB_WEBHOOK_SECRET", secret)?;
    }
    match (cfg.callback_url.as_deref(), cfg.callback_secret.as_deref()) {
        (None, None) => {}
        (Some(url), Some(secret)) => {
            if url.is_empty() || url.len() > 2048 || !url.is_ascii() {
                bail!("SOURCENERVE_CALLBACK_URL must be 1-2048 ASCII bytes");
            }
            validate_secret("SOURCENERVE_CALLBACK_SECRET", secret)?;
        }
        _ => bail!(
            "SOURCENERVE_CALLBACK_URL and SOURCENERVE_CALLBACK_SECRET must be configured together"
        ),
    }
    validate_workspace_entries(&cfg.workspace)?;
    if cfg.workspace.is_empty() {
        bail!("at least one [[workspace]] entry is required");
    }
    validate_oauth_grants(&cfg.oauth, &cfg.workspace)?;
    Ok(())
}

fn validate_workspace_entries(workspaces: &[WorkspaceConfig]) -> Result<()> {
    let mut ids = HashSet::new();
    for workspace in workspaces {
        if workspace.id.is_empty()
            || workspace.id.len() > 128
            || !workspace
                .id
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-'))
        {
            bail!("workspace id must be 1-128 letters, numbers, '.', '_' or '-'");
        }
        if !ids.insert(workspace.id.as_str()) {
            bail!("duplicate workspace id '{}'", workspace.id);
        }
        if !matches!(workspace.access.as_str(), "read-only" | "read-write") {
            bail!(
                "workspace '{}' access must be read-only or read-write",
                workspace.id
            );
        }
        if let Some(provider) = workspace.provider.as_deref() {
            if !matches!(provider, "github" | "gitlab") {
                bail!(
                    "workspace '{}' provider must be github or gitlab",
                    workspace.id
                );
            }
        }
        if workspace.repository.is_some() && workspace.provider.is_none() {
            bail!(
                "workspace '{}' repository requires an explicit provider",
                workspace.id
            );
        }
        if workspace.github_repository.is_some()
            && workspace
                .provider
                .as_deref()
                .is_some_and(|value| value != "github")
        {
            bail!(
                "workspace '{}' github_repository cannot be combined with a non-github provider",
                workspace.id
            );
        }
        if workspace.repository.is_some()
            && workspace.github_repository.is_some()
            && workspace.repository != workspace.github_repository
        {
            bail!(
                "workspace '{}' repository and github_repository conflict",
                workspace.id
            );
        }
    }
    Ok(())
}

async fn inspect_legacy_state(state_dir: &Path) -> LegacyStatePreview {
    let database_path = state_dir.join("sourcenerve.db");
    if !database_path.is_file() {
        return LegacyStatePreview {
            path: state_dir.to_string_lossy().into_owned(),
            database_exists: false,
            schema_version: None,
            supported_schema_version: STATE_SCHEMA_VERSION,
            status: "missing".into(),
            integrity: None,
            message: Some(
                "No sourcenerve.db was found; workspace registrations can still be imported into fresh Desktop state."
                    .into(),
            ),
        };
    }

    let options = SqliteConnectOptions::new()
        .filename(&database_path)
        .read_only(true)
        .create_if_missing(false);
    let pool = match SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
    {
        Ok(pool) => pool,
        Err(error) => {
            return LegacyStatePreview {
                path: state_dir.to_string_lossy().into_owned(),
                database_exists: true,
                schema_version: None,
                supported_schema_version: STATE_SCHEMA_VERSION,
                status: "invalid".into(),
                integrity: None,
                message: Some(format!("Unable to open legacy state database: {error}")),
            };
        }
    };

    let integrity: Result<String, _> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&pool)
        .await;
    let table_exists: Result<i64, _> = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
    )
    .fetch_one(&pool)
    .await;
    let schema_version = if matches!(table_exists, Ok(value) if value > 0) {
        sqlx::query_scalar::<_, Option<i64>>(
            "SELECT MAX(version) FROM _sqlx_migrations WHERE success = TRUE",
        )
        .fetch_one(&pool)
        .await
        .ok()
        .flatten()
    } else {
        None
    };
    pool.close().await;

    let integrity_text = integrity.ok();
    let (status, message) = if integrity_text.as_deref() != Some("ok") {
        (
            "invalid",
            Some("Legacy state failed SQLite integrity validation.".to_string()),
        )
    } else if schema_version.is_some_and(|value| value > i64::from(STATE_SCHEMA_VERSION)) {
        (
            "future",
            Some(format!(
                "Legacy state schema {} is newer than this Desktop supports ({}).",
                schema_version.unwrap_or_default(),
                STATE_SCHEMA_VERSION
            )),
        )
    } else if schema_version.is_none() {
        (
            "unknown",
            Some("Legacy state has no recognized SourceNerve migration history; choose Fresh instead of importing this state.".to_string()),
        )
    } else {
        ("compatible", None)
    };

    LegacyStatePreview {
        path: state_dir.to_string_lossy().into_owned(),
        database_exists: true,
        schema_version,
        supported_schema_version: STATE_SCHEMA_VERSION,
        status: status.into(),
        integrity: integrity_text,
        message,
    }
}

fn resolve_legacy_path(base: &Path, value: &Path) -> PathBuf {
    if value.is_absolute() {
        value.to_path_buf()
    } else {
        base.join(value)
    }
}

fn validate_oauth_grants(oauth: &OAuthConfig, workspaces: &[WorkspaceConfig]) -> Result<()> {
    let workspace_ids: HashSet<_> = workspaces.iter().map(|item| item.id.as_str()).collect();
    let mut seen = HashSet::new();
    for grant in &oauth.grants {
        if grant.subject.is_empty()
            || grant.subject.len() > 512
            || grant.subject.chars().any(char::is_control)
        {
            bail!("oauth.grant subject must be 1-512 bytes without control characters");
        }
        if !workspace_ids.contains(grant.workspace.as_str()) {
            bail!(
                "oauth.grant for subject has unknown workspace '{}'",
                grant.workspace
            );
        }
        if !matches!(grant.access.as_str(), "read-only" | "read-write") {
            bail!(
                "oauth.grant workspace '{}' access must be read-only or read-write",
                grant.workspace
            );
        }
        if !seen.insert((grant.subject.as_str(), grant.workspace.as_str())) {
            bail!(
                "duplicate oauth.grant for workspace '{}' and the same subject",
                grant.workspace
            );
        }
    }
    Ok(())
}

fn validate_secret(name: &str, value: &str) -> Result<()> {
    if value.len() < 32 || value.len() > 256 || !value.is_ascii() {
        bail!("{name} must be 32-256 ASCII bytes when enabled");
    }
    Ok(())
}

fn env_bool(name: &str) -> Result<bool> {
    let Ok(value) = env::var(name) else {
        return Ok(false);
    };
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => bail!("{name} must be one of true/false, 1/0, yes/no, or on/off"),
    }
}

fn default_bind() -> String {
    "127.0.0.1:7331".into()
}
fn default_state_dir() -> PathBuf {
    PathBuf::from(".sourcenerve")
}
fn default_access() -> String {
    "read-write".into()
}
fn default_oauth_access() -> String {
    "read-only".into()
}
fn default_oauth_max_token_lifetime_seconds() -> u64 {
    300
}
fn default_remote() -> String {
    "origin".into()
}
fn default_branch() -> String {
    "main".into()
}
