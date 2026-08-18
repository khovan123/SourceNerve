use std::{path::Path, process::Stdio};

use schemars::JsonSchema;
use serde::Serialize;
use tokio::process::Command;

use crate::{
    config::{Config, WorkspaceConfig},
    error::{AppError, AppResult},
    service::AppState,
};

pub const STATE_SCHEMA_VERSION: u32 = 13;

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
            "repository-memory",
            "structural-graph",
            "scip-enrichment",
            "semantic-vector-enrichment",
            "managed-embeddings",
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
            "github-lifecycle",
            "mutation-audit",
            "provider-idempotency",
            "state-backup",
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
        return Err(AppError::Command(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn preflight_workspace(workspace: &WorkspaceConfig) -> AppResult<()> {
    if !workspace.root.is_dir() {
        return Err(AppError::InvalidRequest(format!(
            "startup preflight failed for workspace `{}`: root is not a directory",
            workspace.id
        )));
    }
    git_output(&workspace.root, &["rev-parse", "--is-inside-work-tree"])
        .await
        .map_err(|_| {
            AppError::InvalidRequest(format!(
                "startup preflight failed for workspace `{}`: root is not a readable Git worktree",
                workspace.id
            ))
        })?;
    git_output(&workspace.root, &["remote", "get-url", &workspace.remote])
        .await
        .map_err(|_| {
            AppError::InvalidRequest(format!(
                "startup preflight failed for workspace `{}`: configured remote is unavailable",
                workspace.id
            ))
        })?;
    git_output(
        &workspace.root,
        &[
            "rev-parse",
            "--verify",
            &format!("{}^{{commit}}", workspace.default_branch),
        ],
    )
    .await
    .map_err(|_| {
        AppError::InvalidRequest(format!(
            "startup preflight failed for workspace `{}`: configured default branch is unavailable",
            workspace.id
        ))
    })?;

    if let Some(repository) = workspace.github_repository.as_deref() {
        let mut parts = repository.split('/');
        let valid = matches!(
            (parts.next(), parts.next(), parts.next()),
            (Some(owner), Some(repo), None) if !owner.is_empty() && !repo.is_empty()
        );
        if !valid {
            return Err(AppError::InvalidRequest(format!(
                "startup preflight failed for workspace `{}`: github_repository must use owner/repo form",
                workspace.id
            )));
        }
    }
    Ok(())
}

async fn preflight_state_dir(path: &Path) -> AppResult<()> {
    tokio::fs::create_dir_all(path).await?;
    let probe = path.join(format!(".sourcenerve-write-probe-{}", uuid::Uuid::new_v4()));
    tokio::fs::write(&probe, b"preflight").await.map_err(|_| {
        AppError::InvalidRequest(
            "startup preflight failed: configured state directory is not writable".into(),
        )
    })?;
    tokio::fs::remove_file(&probe).await?;
    Ok(())
}

pub async fn preflight(config: &Config) -> AppResult<()> {
    executable_required("git").await?;
    executable_required("rg").await?;
    if config.github.token.is_some() {
        executable_required("gh").await?;
    }
    if config.callback_url.is_some() {
        executable_required("curl").await?;
    }
    preflight_state_dir(&config.storage.state_dir).await?;
    for workspace in &config.workspace {
        preflight_workspace(workspace).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::identity;

    #[test]
    fn identity_has_no_runtime_secret_material() {
        let identity = identity();
        let encoded = serde_json::to_string(&identity).expect("serialize identity");
        assert!(!encoded.contains("token"));
        assert!(!encoded.contains("secret"));
        assert!(!encoded.contains("/home/"));
        assert_eq!(identity.state_schema_version, 13);
        assert!(identity.capabilities.contains(&"task-git-pr-lifecycle"));
        assert!(identity.capabilities.contains(&"webhook-job-ingress"));
        assert!(
            identity
                .capabilities
                .contains(&"github-webhook-observations")
        );
        assert!(
            identity
                .capabilities
                .contains(&"durable-outbound-callbacks")
        );
        assert!(
            identity
                .capabilities
                .contains(&"semantic-vector-enrichment")
        );
        assert!(identity.capabilities.contains(&"managed-embeddings"));
        assert!(identity.capabilities.contains(&"architecture-intelligence"));
        assert!(
            identity
                .capabilities
                .contains(&"distributed-mutation-coordination")
        );
    }
}
