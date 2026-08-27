#[cfg(target_os = "linux")]
use std::{env, path::PathBuf};
#[cfg(target_os = "macos")]
use std::ffi::OsString;
use std::path::Path;

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
// current providers either enforce fully or fail closed before returning a result.
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

#[cfg(target_os = "macos")]
const MACOS_SEATBELT_EXECUTABLE: &str = "/usr/bin/sandbox-exec";

#[cfg(target_os = "macos")]
const MACOS_SEATBELT_BASE_POLICY: &str = r#"(version 1)
(allow default)
(deny file-write*)
(allow file-write* (literal "/dev/null"))
"#;

#[cfg(target_os = "macos")]
fn push_seatbelt_path_param(command: &mut Command, key: &str, path: &Path) {
    let mut value = OsString::from(key);
    value.push("=");
    value.push(path.as_os_str());
    command.arg("-D").arg(value);
}

#[cfg(target_os = "macos")]
fn macos_seatbelt_command(
    workspace_root: &Path,
    cwd: &Path,
    program: &Path,
    args: &[String],
    mode: SandboxMode,
) -> AppResult<PreparedCommand> {
    let seatbelt = Path::new(MACOS_SEATBELT_EXECUTABLE);
    if !seatbelt.is_file() {
        return Err(AppError::Sandbox(
            "requested confined execution is unavailable: /usr/bin/sandbox-exec was not found"
                .into(),
        ));
    }

    let workspace_root = std::fs::canonicalize(workspace_root).map_err(|error| {
        AppError::Sandbox(format!(
            "failed to resolve the workspace root for Seatbelt: {error}"
        ))
    })?;
    let mut policy = String::from(MACOS_SEATBELT_BASE_POLICY);
    if mode == SandboxMode::WorkspaceWrite {
        policy.push_str(
            "(allow file-write* (subpath (param \"WORKSPACE_ROOT\")))\n\
             (deny file-write-unlink (require-all (literal (param \"WORKSPACE_ROOT\")) (vnode-type DIRECTORY)))\n",
        );
    }

    let mut command = Command::new(seatbelt);
    if mode == SandboxMode::WorkspaceWrite {
        push_seatbelt_path_param(&mut command, "WORKSPACE_ROOT", &workspace_root);
    }
    command
        .arg("-p")
        .arg(policy)
        .arg(program)
        .args(args)
        .current_dir(cwd);
    Ok(PreparedCommand {
        command,
        enforcement: SandboxEnforcement::Full,
    })
}

fn approved_full_access_command(cwd: &Path, program: &Path, args: &[String]) -> PreparedCommand {
    let mut command = Command::new(program);
    command.current_dir(cwd).args(args);
    PreparedCommand {
        command,
        // `full` means the requested policy was fully honored. For an explicitly approved
        // danger-full-access request, the requested policy intentionally has no filesystem
        // confinement; environment sanitization still happens in the service layer.
        enforcement: SandboxEnforcement::Full,
    }
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
            "danger-full-access requires a consumed exact Harness approval escalation".into(),
        ));
    }

    #[cfg(target_os = "linux")]
    {
        linux_bubblewrap_command(workspace_root, cwd, program, args, mode)
    }

    #[cfg(target_os = "macos")]
    {
        macos_seatbelt_command(workspace_root, cwd, program, args, mode)
    }

    #[cfg(target_os = "windows")]
    {
        let command = crate::windows_sandbox_helper::prepare_command(
            workspace_root,
            cwd,
            program,
            args,
            mode == SandboxMode::WorkspaceWrite,
        )?;
        Ok(PreparedCommand {
            command,
            enforcement: SandboxEnforcement::Full,
        })
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (workspace_root, cwd, program, args, mode);
        Err(AppError::Sandbox(
            "requested confined execution is unavailable on this platform".into(),
        ))
    }
}

pub(crate) fn prepare_command_with_authorization(
    workspace_root: &Path,
    cwd: &Path,
    program: &Path,
    args: &[String],
    mode: SandboxMode,
    danger_full_access_approved: bool,
) -> AppResult<PreparedCommand> {
    if mode == SandboxMode::DangerFullAccess && danger_full_access_approved {
        return Ok(approved_full_access_command(cwd, program, args));
    }
    prepare_command(workspace_root, cwd, program, args, mode)
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

    #[test]
    fn danger_full_access_can_only_use_the_explicit_approved_path() {
        let prepared = prepare_command_with_authorization(
            Path::new("/workspace"),
            Path::new("/workspace"),
            Path::new("echo"),
            &[],
            SandboxMode::DangerFullAccess,
            true,
        )
        .expect("approved full access command");
        assert_eq!(prepared.enforcement, SandboxEnforcement::Full);
    }
}
