use std::{env, path::PathBuf};

use anyhow::{Context, Result, bail};
use axum::{Json, Router, http::StatusCode, middleware, response::IntoResponse, routing::get};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::{
    config::Config, desktop_broker, oauth, oauth_http, observability, observability_http, runtime,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeMode {
    DataPlane,
    ControlPlane,
}

impl Default for RuntimeMode {
    fn default() -> Self {
        Self::DataPlane
    }
}

#[derive(Debug, Default, Deserialize)]
struct RuntimeSection {
    #[serde(default)]
    mode: RuntimeMode,
}

#[derive(Debug, Default, Deserialize)]
struct RuntimeEnvelope {
    #[serde(default)]
    runtime: RuntimeSection,
}

fn config_path() -> PathBuf {
    env::var_os("SOURCENERVE_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("sourcenerve.toml"))
}

pub async fn runtime_mode() -> Result<RuntimeMode> {
    let path = config_path();
    let raw = tokio::fs::read_to_string(&path)
        .await
        .with_context(|| format!("failed to read config at {}", path.display()))?;
    runtime_mode_from_toml(&raw)
        .with_context(|| format!("invalid runtime mode in {}", path.display()))
}

fn runtime_mode_from_toml(raw: &str) -> Result<RuntimeMode> {
    let envelope: RuntimeEnvelope =
        toml::from_str(raw).context("invalid SourceNerve TOML configuration")?;
    Ok(envelope.runtime.mode)
}

pub fn broker_enabled() -> Result<bool> {
    env_bool("SOURCENERVE_DESKTOP_BROKER_ENABLED")
}

pub async fn load_config() -> Result<Config> {
    let path = config_path();
    let raw = tokio::fs::read_to_string(&path)
        .await
        .with_context(|| format!("failed to read config at {}", path.display()))?;
    let mut cfg: Config = toml::from_str(&raw).context("invalid SourceNerve TOML configuration")?;

    // Control-plane deployments consume only the server bind override.
    // Repository/provider credentials and public MCP execution belong to Desktop
    // data-plane daemons and are intentionally ignored here.
    if let Ok(bind) = env::var("SOURCENERVE_BIND") {
        cfg.server.bind = bind;
    }

    validate_config(&cfg)?;
    Ok(cfg)
}

fn validate_config(cfg: &Config) -> Result<()> {
    if !cfg.workspace.is_empty() {
        bail!(
            "control-plane runtime must not configure [[workspace]] entries; repositories/workspaces belong to Desktop data-plane daemons"
        );
    }
    if cfg.github.token.is_some() {
        bail!(
            "control-plane runtime must not configure github.token; Git provider credentials belong to Desktop secure storage"
        );
    }
    if cfg.oauth.issuer.is_some()
        || cfg.oauth.resource.is_some()
        || !cfg.oauth.grants.is_empty()
        || cfg.oauth.allow_operator_bearer
    {
        bail!("control-plane runtime no longer accepts OAuth configuration");
    }
    Ok(())
}

pub fn router(pool: SqlitePool, broker_runtime: desktop_broker::Runtime) -> Router {
    let readiness_pool = pool.clone();
    let mut public = Router::new()
        .route("/healthz", get(health))
        .route(
            "/readyz",
            get(move || {
                let pool = readiness_pool.clone();
                async move { readiness(pool).await }
            }),
        )
        .merge(oauth_http::metadata_router(None))
        .merge(desktop_broker::router(pool, broker_runtime));

    if observability::metrics_public() {
        public = public.merge(observability_http::public_router());
    }

    public.layer(middleware::from_fn(observability::request_middleware))
}

async fn health() -> Json<serde_json::Value> {
    let identity = runtime::identity();
    Json(serde_json::json!({
        "status": "ok",
        "service": identity.service,
        "version": identity.version,
        "build_commit": identity.build_commit,
        "state_schema_version": identity.state_schema_version,
        "runtime_mode": "control-plane",
    }))
}

async fn readiness(pool: SqlitePool) -> impl IntoResponse {
    match sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&pool)
        .await
    {
        Ok(1) => (
            StatusCode::OK,
            Json(serde_json::json!({"status": "ready", "runtime_mode": "control-plane"})),
        ),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"status": "not_ready", "runtime_mode": "control-plane"})),
        ),
    }
}

fn required_env(name: &str) -> Result<String> {
    let value = env::var(name).with_context(|| format!("{name} must be configured in .env"))?;
    let value = value.trim().to_string();
    if value.is_empty() {
        bail!("{name} must not be empty");
    }
    Ok(value)
}

fn env_bool(name: &str) -> Result<bool> {
    let Some(value) = env::var_os(name) else {
        return Ok(false);
    };
    let value = value
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("{name} must be valid UTF-8"))?;
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" | "" => Ok(false),
        _ => bail!("{name} must be a boolean"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_mode_defaults_to_data_plane() {
        assert_eq!(
            runtime_mode_from_toml("[server]\nbind='127.0.0.1:7331'\n").unwrap(),
            RuntimeMode::DataPlane
        );
    }

    #[test]
    fn runtime_mode_accepts_control_plane() {
        assert_eq!(
            runtime_mode_from_toml("[runtime]\nmode='control-plane'\n").unwrap(),
            RuntimeMode::ControlPlane
        );
    }

    #[test]
    fn control_plane_rejects_repository_state() {
        let raw = r#"
            [server]
            bind = "127.0.0.1:7331"
            [storage]
            state_dir = ".sourcenerve"
            [oauth]
            issuer = "https://tenant.example.com/"
            resource = "https://broker.example.com/mcp"
            [[workspace]]
            id = "repo"
            name = "repo"
            root = "."
        "#;
        let cfg: Config = toml::from_str(raw).unwrap();
        let error = validate_config(&cfg).unwrap_err().to_string();
        assert!(error.contains("must not configure [[workspace]]"));
    }

    #[test]
    fn control_plane_allows_no_workspace_or_operator_bearer() {
        let raw = r#"
            [server]
            bind = "127.0.0.1:7331"
            [storage]
            state_dir = ".sourcenerve"
            [oauth]
            issuer = "https://tenant.example.com/"
            resource = "https://broker.example.com/mcp"
            allow_operator_bearer = false
        "#;
        let cfg: Config = toml::from_str(raw).unwrap();
        validate_config(&cfg).unwrap();
    }
}
