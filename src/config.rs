use std::{env, path::PathBuf};

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
    pub github: GitHubConfig,
    #[serde(default)]
    pub workspace: Vec<WorkspaceConfig>,
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
    pub bearer_token: String,
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
    /// Optional owner/repo override. When absent, github.com origin URLs are inferred.
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
        if let Ok(token) = env::var("SOURCENERVE_GITHUB_TOKEN") {
            cfg.github.token = Some(token);
        }
        if let Ok(bind) = env::var("SOURCENERVE_BIND") {
            cfg.server.bind = bind;
        }

        if cfg.auth.bearer_token.trim().len() < 24 {
            bail!("auth.bearer_token must be at least 24 characters");
        }
        if let Some(token) = cfg.github.token.as_deref() {
            if token.trim().len() < 20 {
                bail!("github.token must be empty/omitted or at least 20 characters");
            }
        }
        if cfg.workspace.is_empty() {
            bail!("at least one [[workspace]] entry is required");
        }
        Ok(cfg)
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
fn default_remote() -> String {
    "origin".into()
}
fn default_branch() -> String {
    "main".into()
}
