use std::{path::Path, process::Stdio};

use schemars::JsonSchema;
use serde::Serialize;
use tokio::process::Command;

use crate::{
    config::{Config, WorkspaceConfig},
    error::{AppError, AppResult},
    service::AppState,
};

pub const STATE_SCHEMA_VERSION: u32 = 18;

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct BuildIdentity {
    pub service: &'static str,
    pub version: &'static str,
    pub build_commit: &'static str,
    pub state_schema_version: u32,
    pub capabilities: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ServiceStatus {
    pub identity: BuildIdentity,
    pub github_lifecycle_configured: bool,
    pub workspace_count: usize,
}

pub fn identity() -> BuildIdentity {
    BuildIdentity {
        service: "sourcenerve",
        version: env!("CARGO_PKG_VERSION"),
        build_commit: option_env!("SOURCENERVE_BUILD_COMMIT").unwrap_or("unknown"),
        state_schema_version: STATE_SCHEMA_VERSION,
        capabilities: vec![
            "mcp-streamable-http",
            "mcp-extension-registry",
            "mcp-extension-client-stdio",
            "mcp-extension-client-streamable-http",
            "mcp-extension-gateway",
            "repository-memory",
            "structural-graph",
            "scip-enrichment",
            "managed-scip-analyzers",
            "semantic-vector-enrichment",
            "semantic-ann-hnsw",
            "managed-embeddings",
            "embedding-provider-registry",
            "architecture-intelligence",
            "context-pack",
            "task-transactions",
            "task-git-pr-lifecycle",
            "webhook-job-ingress",
            "github-webhook-observations",
            "durable-outbound-callbacks",
            "distributed-mutation-coordination",
            "reviewed-patch",
            "git-lifecycle",
            "git-provider-lifecycle",
            "github-lifecycle",
            "gitlab-lifecycle",
            "production-observability",
            "prometheus-metrics",
            "otlp-http-json-tracing",
            "deployment-hardening",
            "mutation-audit",
            "provider-idempotency",
            "state-backup",
            "desktop-bootstrap-broker",
        ],
    }
}

impl AppState {
    pub fn service_status(&self) -> ServiceStatus {
        ServiceStatus {
            identity: identity(),
            github_lifecycle_configured: self.github_token.is_some(),
            workspace_count: self.workspaces.list().len(),
        }
    }
}

async fn executable_required(name: &str) -> AppResult<()> {
    let result = Command::new(name)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
    match result {
        Ok(status) if status.success() => Ok(()),
        Ok(_) | Err(_) => Err(AppError::InvalidRequest(format!(
            "startup preflight failed: required executable `{name}` is unavailable"
        ))),
    }
}

fn startup_required_executables(callback_enabled: bool) -> Vec<&'static str> {
    let mut required = vec!["git"];
    if callback_enabled {
        required.push("curl");
    }
    required
}

async fn git_output(root: &Path, args: &[&str]) -> AppResult<String> {
    let output = Command::new("git")
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| AppError::Command(format!("failed to execute git: {error}")))?;
    if !output.status.success() {
        return Err(AppError::Command(format!(
            "git command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub async fn startup_preflight(config: &Config) -> AppResult<()> {
    for executable in startup_required_executables(config.callback.enabled) {
        executable_required(executable).await?;
    }
    for workspace in &config.workspace {
        let root = workspace.root.canonicalize().map_err(|error| {
            AppError::InvalidRequest(format!(
                "workspace `{}` root cannot be resolved: {error}",
                workspace.id
            ))
        })?;
        if !root.is_dir() {
            return Err(AppError::InvalidRequest(format!(
                "workspace `{}` root is not a directory",
                workspace.id
            )));
        }
        let git_dir = git_output(&root, &["rev-parse", "--git-dir"]).await?;
        if git_dir.is_empty() {
            return Err(AppError::InvalidRequest(format!(
                "workspace `{}` is not a git repository",
                workspace.id
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_has_no_runtime_secret_material() {
        let identity = identity();
        let json = serde_json::to_string(&identity).expect("identity JSON");
        assert!(!json.contains("token"));
        assert!(!json.contains("secret"));
    }

    #[test]
    fn desktop_startup_only_requires_core_process_dependencies() {
        assert_eq!(startup_required_executables(false), vec!["git"]);
        assert_eq!(startup_required_executables(true), vec!["git", "curl"]);
    }
}
