use std::{collections::HashSet, env, path::PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub storage: StorageConfig,
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

#[derive(Debug, Clone, Deserialize)]
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
        for workspace in &cfg.workspace {
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
        if cfg.workspace.is_empty() {
            bail!("at least one [[workspace]] entry is required");
        }
        validate_oauth_grants(&cfg.oauth, &cfg.workspace)?;
        Ok(cfg)
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
