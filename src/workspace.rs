use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::Arc,
};

use anyhow::{Context, Result, bail};
use serde::Serialize;

use crate::{
    config::WorkspaceConfig,
    error::{AppError, AppResult},
};

#[derive(Debug, Clone)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root: PathBuf,
    pub writable: bool,
    pub remote: String,
    pub default_branch: String,
    pub provider: Option<String>,
    pub repository: Option<String>,
    pub github_repository: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceView {
    pub id: String,
    pub name: String,
    pub writable: bool,
    pub default_branch: String,
    pub provider: Option<String>,
}

#[derive(Clone)]
pub struct WorkspaceRegistry {
    by_id: Arc<HashMap<String, Workspace>>,
}

fn infer_legacy_github_provider(root: &Path, remote_name: &str) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["remote", "get-url", remote_name])
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let remote = String::from_utf8(output.stdout).ok()?;
    crate::github::repository_from_remote(remote.trim()).map(|_| "github".to_string())
}

impl WorkspaceRegistry {
    pub fn build(configs: &[WorkspaceConfig]) -> Result<Self> {
        let mut by_id = HashMap::new();
        for cfg in configs {
            if by_id.contains_key(&cfg.id) {
                bail!("duplicate workspace id: {}", cfg.id);
            }
            let root = std::fs::canonicalize(&cfg.root).with_context(|| {
                format!(
                    "workspace '{}' root does not exist: {}",
                    cfg.id,
                    cfg.root.display()
                )
            })?;
            if !root.join(".git").exists() {
                bail!(
                    "workspace '{}' is not a git repository: {}",
                    cfg.id,
                    root.display()
                );
            }
            let writable = match cfg.access.as_str() {
                "read-write" => true,
                "read-only" => false,
                other => bail!("workspace '{}' has invalid access mode: {other}", cfg.id),
            };
            if cfg.remote.trim().is_empty() {
                bail!("workspace '{}' remote must not be empty", cfg.id);
            }
            if cfg.default_branch.trim().is_empty() {
                bail!("workspace '{}' default_branch must not be empty", cfg.id);
            }
            let provider = cfg
                .provider
                .clone()
                .or_else(|| cfg.github_repository.as_ref().map(|_| "github".to_string()))
                .or_else(|| infer_legacy_github_provider(&root, &cfg.remote));
            by_id.insert(
                cfg.id.clone(),
                Workspace {
                    id: cfg.id.clone(),
                    name: cfg.name.clone(),
                    root,
                    writable,
                    remote: cfg.remote.clone(),
                    default_branch: cfg.default_branch.clone(),
                    provider,
                    repository: cfg.repository.clone(),
                    github_repository: cfg.github_repository.clone(),
                },
            );
        }
        Ok(Self {
            by_id: Arc::new(by_id),
        })
    }

    pub fn list(&self) -> Vec<WorkspaceView> {
        let mut items: Vec<_> = self
            .by_id
            .values()
            .map(|w| WorkspaceView {
                id: w.id.clone(),
                name: w.name.clone(),
                writable: w.writable,
                default_branch: w.default_branch.clone(),
                provider: w.provider.clone(),
            })
            .collect();
        items.sort_by(|a, b| a.id.cmp(&b.id));
        items
    }

    pub fn get(&self, id: &str) -> AppResult<Workspace> {
        self.by_id
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::WorkspaceNotFound(id.into()))
    }

    pub fn resolve_existing_file(
        &self,
        workspace: &Workspace,
        relative: &str,
    ) -> AppResult<PathBuf> {
        let rel = Path::new(relative);
        if rel.is_absolute()
            || rel.components().any(|c| {
                matches!(
                    c,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(AppError::PathOutsideWorkspace);
        }
        let joined = workspace.root.join(rel);
        let canonical = std::fs::canonicalize(joined).map_err(AppError::Io)?;
        if !canonical.starts_with(&workspace.root) || !canonical.is_file() {
            return Err(AppError::PathOutsideWorkspace);
        }
        Ok(canonical)
    }
}
