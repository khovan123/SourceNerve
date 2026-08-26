use std::path::Path;
#[cfg(target_os = "linux")]
use std::{env, path::PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    ReadOnly,
    #[default]
    WorkspaceWrite,
    DangerFullAccess,
}

impl SandboxMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
            Self::DangerFullAccess => "danger-full-access",
        }
    }
}

// `partial` and `unavailable` are part of the stable enforcement vocabulary even though
// this initial Linux provider either enforces fully or fails closed before returning a result.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxEnforcement {
    Full,
    Partial,
    Unavailable,
}

impl SandboxEnforcement {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Partial => "partial",
            Self::Unavailable => "unavailable",
        }
    }
}

pub struct PreparedCommand {
    pub command: Command,
    pub enforcement: SandboxEnforcement,
}

#[cfg(target_os = "linux")]
fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|entry| entry.join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg(target_os = "linux")]
fn linux_bubblewrap_command(
    workspace_root: &Path,
    cwd: &Path,
    program: &Path,
    args: &[String],
    mode: SandboxMode,
) -> AppResult<PreparedCommand> {
    let bwrap = find_on_path("bwrap").ok_or_else(|| {
        AppError::Sandbox(
            "requested confined execution is unavailable: bubblewrap was not found on PATH".into(),
        )
    })?;
    let mut command = Command::new(bwrap);
    command
        .arg("--die-with-parent")
        .arg("--new-session")
        .arg("--ro-bind")
        .arg("/")
        .arg("/")
        .arg("--tmpfs")
        .arg("/tmp");
    if mode == SandboxMode::WorkspaceWrite {
        command
            .arg("--bind")
            .arg(workspace_root)
            .arg(workspace_root);
    }
    command
        .arg("--chdir")
        .arg(cwd)
        .arg("--")
        .arg(program)
        .args(args);
    Ok(PreparedCommand {
        command,
        enforcement: SandboxEnforcement::Full,
    })
}

pub fn prepare_command(
    workspace_root: &Path,
    cwd: &Path,
    program: &Path,
    args: &[String],
    mode: SandboxMode,
) -> AppResult<PreparedCommand> {
    if mode == SandboxMode::DangerFullAccess {
        return Err(AppError::InvalidRequest(
            "danger-full-access requires an explicit Harness approval escalation and is not available through workspace_exec yet"
                .into(),
        ));
    }

    #[cfg(target_os = "linux")]
    {
        linux_bubblewrap_command(workspace_root, cwd, program, args, mode)
    }

    #[cfg(target_os = "macos")]
    {
        let _ = (workspace_root, cwd, program, args, mode);
        Err(AppError::Sandbox(
            "requested confined execution is unavailable: macOS sandbox provider is not implemented yet"
                .into(),
        ))
    }

    #[cfg(target_os = "windows")]
    {
        let _ = (workspace_root, cwd, program, args, mode);
        Err(AppError::Sandbox(
            "requested confined execution is unavailable: Windows restricted-token provider is not implemented yet"
                .into(),
        ))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (workspace_root, cwd, program, args, mode);
        Err(AppError::Sandbox(
            "requested confined execution is unavailable on this platform".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_write_is_the_secure_default() {
        assert_eq!(SandboxMode::default(), SandboxMode::WorkspaceWrite);
    }

    #[test]
    fn danger_full_access_is_never_automatic() {
        let result = prepare_command(
            Path::new("/workspace"),
            Path::new("/workspace"),
            Path::new("echo"),
            &[],
            SandboxMode::DangerFullAccess,
        );
        assert!(matches!(result, Err(AppError::InvalidRequest(_))));
    }
}
