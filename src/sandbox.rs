#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::ffi::OsString;
use std::{env, path::Path};
#[cfg(target_os = "linux")]
use std::{ffi::OsStr, os::unix::fs::FileTypeExt, path::PathBuf};

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
    WorkspaceGui,
    DangerFullAccess,
}

impl SandboxMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
            Self::WorkspaceGui => "workspace-gui",
            Self::DangerFullAccess => "danger-full-access",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct SandboxAuthorization {
    pub gui_session_approved: bool,
    pub danger_full_access_approved: bool,
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

const SAFE_COMMAND_ENV_KEYS: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "USERNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "LOCALAPPDATA",
    "APPDATA",
    "XDG_CACHE_HOME",
];

#[cfg(target_os = "linux")]
const LINUX_GUI_STAGE_ROOT: &str = "/run/.sourcenerve-gui-stage";

const GUI_COMMAND_ENV_KEYS: &[&str] = &[
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "XAUTHORITY",
];

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct LinuxGuiSessionBinding {
    runtime_dir: Option<PathBuf>,
    wayland_display: Option<String>,
    wayland_socket: Option<PathBuf>,
    dbus_address: Option<String>,
    dbus_socket: Option<PathBuf>,
    display: Option<String>,
    x11_socket: Option<PathBuf>,
    xauthority: Option<PathBuf>,
}

#[cfg(target_os = "linux")]
fn safe_gui_basename(value: &OsStr) -> Option<String> {
    let value = value.to_str()?;
    if value.is_empty()
        || value.len() > 128
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return None;
    }
    Some(value.to_string())
}

#[cfg(target_os = "linux")]
fn local_x11_display_socket(display: &str) -> Option<PathBuf> {
    let local = display.strip_prefix(':')?;
    let number = local.split('.').next()?;
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(PathBuf::from(format!("/tmp/.X11-unix/X{number}")))
}

#[cfg(target_os = "linux")]
fn existing_socket(path: &Path) -> Option<PathBuf> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.file_type().is_socket() {
        return None;
    }
    std::fs::canonicalize(path).ok()
}

#[cfg(target_os = "linux")]
fn existing_file(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() || !path.is_file() {
        return None;
    }
    std::fs::canonicalize(path).ok()
}

#[cfg(target_os = "linux")]
fn dbus_socket_from_address(address: &str, runtime_dir: &Path) -> Option<PathBuf> {
    let raw_path = address.strip_prefix("unix:path=")?.split(',').next()?;
    let path = PathBuf::from(raw_path);
    if !path.is_absolute() {
        return None;
    }
    let socket = existing_socket(&path)?;
    socket.starts_with(runtime_dir).then_some(socket)
}

#[cfg(target_os = "linux")]
fn detect_linux_gui_session_with(
    mut get_env: impl FnMut(&str) -> Option<OsString>,
) -> AppResult<LinuxGuiSessionBinding> {
    let runtime_dir = get_env("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_dir())
        .and_then(|path| std::fs::canonicalize(path).ok());

    let wayland_display = get_env("WAYLAND_DISPLAY")
        .as_deref()
        .and_then(safe_gui_basename);
    let wayland_socket = runtime_dir.as_ref().and_then(|runtime| {
        wayland_display
            .as_deref()
            .and_then(|name| existing_socket(&runtime.join(name)))
    });
    let wayland_display = wayland_socket.as_ref().and(wayland_display);

    let dbus_address =
        get_env("DBUS_SESSION_BUS_ADDRESS").and_then(|value| value.into_string().ok());
    let dbus_socket = runtime_dir.as_ref().and_then(|runtime| {
        dbus_address
            .as_deref()
            .and_then(|address| dbus_socket_from_address(address, runtime))
    });
    let dbus_address = dbus_socket.as_ref().and(dbus_address);

    let display = get_env("DISPLAY").and_then(|value| value.into_string().ok());
    let x11_socket = display
        .as_deref()
        .and_then(local_x11_display_socket)
        .and_then(|path| existing_socket(&path));
    let display = x11_socket.as_ref().and(display);
    let xauthority = if display.is_some() {
        get_env("XAUTHORITY")
            .map(PathBuf::from)
            .as_deref()
            .and_then(existing_file)
    } else {
        None
    };

    if wayland_socket.is_none() && x11_socket.is_none() {
        return Err(AppError::Sandbox(
            "workspace-gui requires an active local Wayland or X11 desktop session".into(),
        ));
    }

    Ok(LinuxGuiSessionBinding {
        runtime_dir,
        wayland_display,
        wayland_socket,
        dbus_address,
        dbus_socket,
        display,
        x11_socket,
        xauthority,
    })
}

#[cfg(target_os = "linux")]
fn detect_linux_gui_session() -> AppResult<LinuxGuiSessionBinding> {
    detect_linux_gui_session_with(|key| env::var_os(key))
}

#[cfg(target_os = "linux")]
fn linux_gui_environment(binding: &LinuxGuiSessionBinding) -> Vec<(&'static str, OsString)> {
    let mut values = Vec::new();
    if let Some(value) = binding.wayland_display.as_ref() {
        values.push(("WAYLAND_DISPLAY", OsString::from(value)));
    }
    if (binding.wayland_socket.is_some() || binding.dbus_socket.is_some())
        && let Some(value) = binding.runtime_dir.as_ref()
    {
        values.push(("XDG_RUNTIME_DIR", value.as_os_str().to_os_string()));
    }
    if let Some(value) = binding.dbus_address.as_ref() {
        values.push(("DBUS_SESSION_BUS_ADDRESS", OsString::from(value)));
    }
    if let Some(value) = binding.display.as_ref() {
        values.push(("DISPLAY", OsString::from(value)));
    }
    if let Some(value) = binding.xauthority.as_ref() {
        values.push(("XAUTHORITY", value.as_os_str().to_os_string()));
    }
    values
}

#[cfg(target_os = "linux")]
fn linux_runtime_dir() -> Option<PathBuf> {
    env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_dir())
        .and_then(|path| std::fs::canonicalize(path).ok())
}

#[cfg(target_os = "linux")]
fn append_linux_gui_staging(command: &mut Command, binding: &LinuxGuiSessionBinding) {
    command.arg("--dir").arg(LINUX_GUI_STAGE_ROOT);
    for (source, stage_name) in [
        (binding.wayland_socket.as_ref(), "wayland"),
        (binding.dbus_socket.as_ref(), "dbus"),
        (binding.x11_socket.as_ref(), "x11"),
        (binding.xauthority.as_ref(), "xauthority"),
    ] {
        if let Some(source) = source {
            command
                .arg("--ro-bind")
                .arg(source)
                .arg(Path::new(LINUX_GUI_STAGE_ROOT).join(stage_name));
        }
    }
}

#[cfg(target_os = "linux")]
fn append_linux_gui_destinations(command: &mut Command, binding: &LinuxGuiSessionBinding) {
    if let Some(destination) = binding.wayland_socket.as_ref() {
        command
            .arg("--ro-bind")
            .arg(Path::new(LINUX_GUI_STAGE_ROOT).join("wayland"))
            .arg(destination);
    }
    if let Some(destination) = binding.dbus_socket.as_ref() {
        command
            .arg("--ro-bind")
            .arg(Path::new(LINUX_GUI_STAGE_ROOT).join("dbus"))
            .arg(destination);
    }
    if let Some(socket) = binding.x11_socket.as_ref() {
        command
            .arg("--dir")
            .arg("/tmp/.X11-unix")
            .arg("--ro-bind")
            .arg(Path::new(LINUX_GUI_STAGE_ROOT).join("x11"))
            .arg(socket);
    }
    if let Some(xauthority) = binding.xauthority.as_ref() {
        command
            .arg("--ro-bind")
            .arg(Path::new(LINUX_GUI_STAGE_ROOT).join("xauthority"))
            .arg(xauthority);
    }
    command.arg("--tmpfs").arg(LINUX_GUI_STAGE_ROOT);
}

#[cfg(target_os = "linux")]
fn append_linux_session_masks(
    command: &mut Command,
    runtime_dir: Option<&Path>,
    workspace_under_tmp: bool,
) {
    if let Some(runtime) = runtime_dir {
        command
            .arg("--tmpfs")
            .arg(runtime)
            .arg("--chmod")
            .arg("0700")
            .arg(runtime);
    }
    if workspace_under_tmp {
        command.arg("--tmpfs").arg("/tmp/.X11-unix");
    } else {
        command.arg("--tmpfs").arg("/tmp");
    }
}

pub(crate) fn sanitize_command_environment(
    command: &mut Command,
    mode: SandboxMode,
) -> AppResult<()> {
    command.env_clear();
    for key in SAFE_COMMAND_ENV_KEYS {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
    for key in GUI_COMMAND_ENV_KEYS {
        command.env_remove(key);
    }
    if mode == SandboxMode::WorkspaceGui {
        #[cfg(target_os = "linux")]
        {
            let binding = detect_linux_gui_session()?;
            for (key, value) in linux_gui_environment(&binding) {
                if GUI_COMMAND_ENV_KEYS.contains(&key) {
                    command.env(key, value);
                }
            }
        }
    }
    command.env("GIT_TERMINAL_PROMPT", "0");
    Ok(())
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
    let workspace_under_tmp = workspace_root.starts_with(Path::new("/tmp"));
    let runtime_dir = linux_runtime_dir();
    if runtime_dir
        .as_ref()
        .is_some_and(|runtime| workspace_root.starts_with(runtime))
    {
        return Err(AppError::Sandbox(
            "confined execution cannot use a workspace inside XDG_RUNTIME_DIR".into(),
        ));
    }
    let gui_binding = if mode == SandboxMode::WorkspaceGui {
        Some(detect_linux_gui_session()?)
    } else {
        None
    };
    let mut command = Command::new(bwrap);
    command
        .arg("--die-with-parent")
        .arg("--new-session")
        .arg("--ro-bind")
        .arg("/")
        .arg("/")
        // Git, rustc, and ordinary CLI tools need writable /dev/null, but replacing the entire
        // device namespace changes bubblewrap's session/process ownership semantics. Keep the
        // host device tree read-only and grant write access only to the null device.
        .arg("--dev-bind")
        .arg("/dev/null")
        .arg("/dev/null");
    // Stage approved GUI endpoints before masking the host runtime and /tmp paths that
    // contain them. The stage itself is hidden again after the exact destination binds.
    if let Some(binding) = gui_binding.as_ref() {
        append_linux_gui_staging(&mut command, binding);
    }
    // A root ro-bind would otherwise expose all user-session sockets by path even when
    // DISPLAY/WAYLAND_DISPLAY are removed from the environment. Hide the runtime for every
    // confined command; workspace-gui selectively restores only its approved endpoints.
    // If the workspace itself is under /tmp, keep that host path available for the workspace
    // re-bind but still mask the X11 socket directory explicitly.
    append_linux_session_masks(&mut command, runtime_dir.as_deref(), workspace_under_tmp);
    if matches!(
        mode,
        SandboxMode::WorkspaceWrite | SandboxMode::WorkspaceGui
    ) {
        command
            .arg("--bind")
            .arg(workspace_root)
            .arg(workspace_root);
    }
    if let Some(binding) = gui_binding.as_ref() {
        append_linux_gui_destinations(&mut command, binding);
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
    if matches!(
        mode,
        SandboxMode::WorkspaceWrite | SandboxMode::WorkspaceGui
    ) {
        policy.push_str(
            "(allow file-write* (subpath (param \"WORKSPACE_ROOT\")))\n\
             (deny file-write-unlink (require-all (literal (param \"WORKSPACE_ROOT\")) (vnode-type DIRECTORY)))\n",
        );
    }

    let mut command = Command::new(seatbelt);
    if matches!(
        mode,
        SandboxMode::WorkspaceWrite | SandboxMode::WorkspaceGui
    ) {
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

fn prepare_confined_command(
    workspace_root: &Path,
    cwd: &Path,
    program: &Path,
    args: &[String],
    mode: SandboxMode,
) -> AppResult<PreparedCommand> {
    #[cfg(not(target_os = "linux"))]
    if mode == SandboxMode::WorkspaceGui {
        return Err(AppError::Sandbox(
            "workspace-gui GUI-session binding is currently supported only on Linux Wayland/X11"
                .into(),
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
            matches!(
                mode,
                SandboxMode::WorkspaceWrite | SandboxMode::WorkspaceGui
            ),
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

pub fn prepare_command(
    workspace_root: &Path,
    cwd: &Path,
    program: &Path,
    args: &[String],
    mode: SandboxMode,
) -> AppResult<PreparedCommand> {
    match mode {
        SandboxMode::WorkspaceGui => Err(AppError::InvalidRequest(
            "workspace-gui requires a consumed exact Harness GUI-session approval".into(),
        )),
        SandboxMode::DangerFullAccess => Err(AppError::InvalidRequest(
            "danger-full-access requires a consumed exact Harness approval escalation".into(),
        )),
        SandboxMode::ReadOnly | SandboxMode::WorkspaceWrite => {
            prepare_confined_command(workspace_root, cwd, program, args, mode)
        }
    }
}

pub(crate) fn prepare_command_with_authorization(
    workspace_root: &Path,
    cwd: &Path,
    program: &Path,
    args: &[String],
    mode: SandboxMode,
    authorization: SandboxAuthorization,
) -> AppResult<PreparedCommand> {
    match mode {
        SandboxMode::WorkspaceGui if authorization.gui_session_approved => {
            prepare_confined_command(workspace_root, cwd, program, args, mode)
        }
        SandboxMode::DangerFullAccess if authorization.danger_full_access_approved => {
            Ok(approved_full_access_command(cwd, program, args))
        }
        _ => prepare_command(workspace_root, cwd, program, args, mode),
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

    #[test]
    fn workspace_gui_is_never_automatic() {
        let result = prepare_command(
            Path::new("/workspace"),
            Path::new("/workspace"),
            Path::new("echo"),
            &[],
            SandboxMode::WorkspaceGui,
        );
        assert!(matches!(result, Err(AppError::InvalidRequest(_))));
    }

    #[test]
    fn workspace_write_environment_keeps_gui_and_secret_keys_out() {
        assert!(
            !SAFE_COMMAND_ENV_KEYS
                .iter()
                .any(|key| GUI_COMMAND_ENV_KEYS.contains(key))
        );
        for secret in [
            "GITHUB_TOKEN",
            "GH_TOKEN",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "AWS_SECRET_ACCESS_KEY",
        ] {
            assert!(!SAFE_COMMAND_ENV_KEYS.contains(&secret));
            assert!(!GUI_COMMAND_ENV_KEYS.contains(&secret));
        }
        let mut command = Command::new("env");
        sanitize_command_environment(&mut command, SandboxMode::WorkspaceWrite)
            .expect("sanitize workspace-write environment");
        let inherited = command
            .as_std()
            .get_envs()
            .filter_map(|(key, value)| value.map(|_| key.to_string_lossy().into_owned()))
            .collect::<Vec<_>>();
        for key in GUI_COMMAND_ENV_KEYS {
            assert!(!inherited.iter().any(|candidate| candidate == key));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_confined_command_binds_only_writable_dev_null() {
        if find_on_path("bwrap").is_none() {
            return;
        }
        let prepared = linux_bubblewrap_command(
            Path::new("/workspace"),
            Path::new("/workspace"),
            Path::new("/usr/bin/git"),
            &["status".to_string()],
            SandboxMode::WorkspaceWrite,
        )
        .expect("prepare Linux sandbox");
        let args = prepared
            .command
            .as_std()
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(
            args.windows(3)
                .any(|values| values == ["--dev-bind", "/dev/null", "/dev/null"]),
            "Linux sandbox must grant write access only to /dev/null",
        );
        assert!(
            !args.windows(2).any(|pair| pair == ["--dev", "/dev"]),
            "Linux sandbox must not replace the whole device namespace",
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_workspace_write_masks_session_socket_paths_without_gui_authority() {
        let mut normal = Command::new("bwrap");
        append_linux_session_masks(&mut normal, Some(Path::new("/run/user/1000")), false);
        let normal_args = normal
            .as_std()
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(
            normal_args
                .windows(2)
                .any(|pair| pair == ["--tmpfs", "/run/user/1000"])
        );
        assert!(
            normal_args
                .windows(3)
                .any(|values| values == ["--chmod", "0700", "/run/user/1000"])
        );
        assert!(
            normal_args
                .windows(2)
                .any(|pair| pair == ["--tmpfs", "/tmp"])
        );

        let mut tmp_workspace = Command::new("bwrap");
        append_linux_session_masks(&mut tmp_workspace, Some(Path::new("/run/user/1000")), true);
        let tmp_args = tmp_workspace
            .as_std()
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(
            tmp_args
                .windows(2)
                .any(|pair| pair == ["--tmpfs", "/tmp/.X11-unix"])
        );
        assert!(!tmp_args.windows(2).any(|pair| pair == ["--tmpfs", "/tmp"]));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_gui_detection_requires_real_session_sockets() {
        use std::os::unix::net::UnixListener;

        let runtime = tempfile::tempdir().expect("runtime directory");
        let wayland = runtime.path().join("wayland-9");
        let bus = runtime.path().join("bus");
        let _wayland_listener = UnixListener::bind(&wayland).expect("Wayland fixture socket");
        let _bus_listener = UnixListener::bind(&bus).expect("D-Bus fixture socket");
        let runtime_text = runtime.path().as_os_str().to_os_string();
        let bus_address = OsString::from(format!("unix:path={}", bus.display()));

        let binding = detect_linux_gui_session_with(|key| match key {
            "XDG_RUNTIME_DIR" => Some(runtime_text.clone()),
            "WAYLAND_DISPLAY" => Some(OsString::from("wayland-9")),
            "DBUS_SESSION_BUS_ADDRESS" => Some(bus_address.clone()),
            _ => None,
        })
        .expect("detect fixture GUI session");

        assert_eq!(binding.runtime_dir.as_deref(), Some(runtime.path()));
        assert_eq!(binding.wayland_display.as_deref(), Some("wayland-9"));
        assert_eq!(binding.wayland_socket.as_deref(), Some(wayland.as_path()));
        assert_eq!(binding.dbus_socket.as_deref(), Some(bus.as_path()));
        assert_eq!(binding.dbus_address.as_deref(), bus_address.to_str());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_workspace_gui_masks_runtime_and_binds_only_exact_session_sockets() {
        let binding = LinuxGuiSessionBinding {
            runtime_dir: Some(PathBuf::from("/run/user/1000")),
            wayland_display: Some("wayland-0".into()),
            wayland_socket: Some(PathBuf::from("/run/user/1000/wayland-0")),
            dbus_address: Some("unix:path=/run/user/1000/bus".into()),
            dbus_socket: Some(PathBuf::from("/run/user/1000/bus")),
            display: Some(":0".into()),
            x11_socket: Some(PathBuf::from("/tmp/.X11-unix/X0")),
            xauthority: Some(PathBuf::from("/run/user/1000/.mutter-Xwaylandauth.TEST")),
        };
        let mut command = Command::new("bwrap");
        append_linux_gui_staging(&mut command, &binding);
        command.arg("--tmpfs").arg("/run/user/1000");
        command.arg("--tmpfs").arg("/tmp");
        append_linux_gui_destinations(&mut command, &binding);
        let args = command
            .as_std()
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args.windows(3).any(|values| values
            == [
                "--ro-bind",
                "/run/user/1000/wayland-0",
                "/run/.sourcenerve-gui-stage/wayland"
            ]));
        assert!(args.windows(3).any(|values| values
            == [
                "--ro-bind",
                "/run/user/1000/bus",
                "/run/.sourcenerve-gui-stage/dbus"
            ]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--tmpfs", "/run/user/1000"])
        );
        assert!(args.windows(3).any(|values| values
            == [
                "--ro-bind",
                "/run/.sourcenerve-gui-stage/wayland",
                "/run/user/1000/wayland-0"
            ]));
        assert!(args.windows(3).any(|values| values
            == [
                "--ro-bind",
                "/run/.sourcenerve-gui-stage/dbus",
                "/run/user/1000/bus"
            ]));
        assert!(
            !args
                .windows(3)
                .any(|values| values == ["--bind", "/run/user/1000", "/run/user/1000"])
        );
        let runtime_mask = args
            .windows(2)
            .position(|pair| pair == ["--tmpfs", "/run/user/1000"])
            .expect("runtime mask");
        let staged_wayland = args
            .windows(3)
            .position(|values| {
                values
                    == [
                        "--ro-bind",
                        "/run/user/1000/wayland-0",
                        "/run/.sourcenerve-gui-stage/wayland",
                    ]
            })
            .expect("stage Wayland socket");
        let restored_wayland = args
            .windows(3)
            .position(|values| {
                values
                    == [
                        "--ro-bind",
                        "/run/.sourcenerve-gui-stage/wayland",
                        "/run/user/1000/wayland-0",
                    ]
            })
            .expect("restore Wayland socket");
        assert!(staged_wayland < runtime_mask && runtime_mask < restored_wayland);
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--tmpfs", "/run/.sourcenerve-gui-stage"])
        );
        assert_eq!(
            linux_gui_environment(&binding)
                .iter()
                .map(|(key, _)| *key)
                .collect::<Vec<_>>(),
            vec![
                "WAYLAND_DISPLAY",
                "XDG_RUNTIME_DIR",
                "DBUS_SESSION_BUS_ADDRESS",
                "DISPLAY",
                "XAUTHORITY"
            ]
        );
    }

    #[test]
    fn danger_full_access_can_only_use_the_explicit_approved_path() {
        let prepared = prepare_command_with_authorization(
            Path::new("/workspace"),
            Path::new("/workspace"),
            Path::new("echo"),
            &[],
            SandboxMode::DangerFullAccess,
            SandboxAuthorization {
                danger_full_access_approved: true,
                ..SandboxAuthorization::default()
            },
        )
        .expect("approved full access command");
        assert_eq!(prepared.enforcement, SandboxEnforcement::Full);
    }
}
