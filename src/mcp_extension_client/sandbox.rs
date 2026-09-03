use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::OnceLock,
};

use tokio::process::Command;

use crate::error::{AppError, AppResult};

const MODE_ENV: &str = "SOURCENERVE_MCP_STDIO_SANDBOX";
const NETWORK_ENV: &str = "SOURCENERVE_MCP_STDIO_NETWORK";
const ROOTS_ENV: &str = "SOURCENERVE_MCP_STDIO_ALLOWED_ROOTS";
const MEMORY_ENV: &str = "SOURCENERVE_MCP_STDIO_MAX_MEMORY_MB";
const PROCESSES_ENV: &str = "SOURCENERVE_MCP_STDIO_MAX_PROCESSES";
const CPU_ENV: &str = "SOURCENERVE_MCP_STDIO_CPU_SECONDS";

const SAFE_PARENT_ENV: &[&str] = &["PATH", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"];
const RESERVED_EXTENSION_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
    "GIT_ASKPASS",
    "SSH_AUTH_SOCK",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SandboxMode {
    Auto,
    Required,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NetworkPolicy {
    Inherit,
    Deny,
}

#[derive(Debug, Clone)]
struct SandboxPolicy {
    mode: SandboxMode,
    network: NetworkPolicy,
    allowed_roots: Vec<PathBuf>,
    max_memory_mb: Option<u64>,
    max_processes: Option<u64>,
    cpu_seconds: Option<u64>,
}

impl SandboxPolicy {
    fn from_environment() -> AppResult<Self> {
        let mode = match env::var(MODE_ENV)
            .unwrap_or_else(|_| "auto".into())
            .as_str()
        {
            "auto" => SandboxMode::Auto,
            "required" => SandboxMode::Required,
            "disabled" => SandboxMode::Disabled,
            _ => {
                return Err(AppError::InvalidRequest(format!(
                    "{MODE_ENV} must be one of auto, required, or disabled"
                )));
            }
        };
        let network = match env::var(NETWORK_ENV)
            .unwrap_or_else(|_| "inherit".into())
            .as_str()
        {
            "inherit" => NetworkPolicy::Inherit,
            "deny" => NetworkPolicy::Deny,
            _ => {
                return Err(AppError::InvalidRequest(format!(
                    "{NETWORK_ENV} must be inherit or deny"
                )));
            }
        };
        let allowed_roots = match env::var_os(ROOTS_ENV) {
            Some(value) => env::split_paths(&value)
                .map(validate_allowed_root)
                .collect::<AppResult<Vec<_>>>()?,
            None => Vec::new(),
        };
        Ok(Self {
            mode,
            network,
            allowed_roots,
            max_memory_mb: parse_limit(MEMORY_ENV, 64, 1_048_576)?,
            max_processes: parse_limit(PROCESSES_ENV, 1, 4096)?,
            cpu_seconds: parse_limit(CPU_ENV, 1, 86_400)?,
        })
    }

    fn requires_kernel_enforcement(&self) -> bool {
        self.mode == SandboxMode::Required
            || self.network == NetworkPolicy::Deny
            || !self.allowed_roots.is_empty()
            || self.has_resource_limits()
    }

    fn has_resource_limits(&self) -> bool {
        self.max_memory_mb.is_some() || self.max_processes.is_some() || self.cpu_seconds.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostPlatform {
    Linux,
    Macos,
    Windows,
    Other,
}

#[derive(Debug, Clone)]
struct Capabilities {
    platform: HostPlatform,
    bwrap: Option<PathBuf>,
    sandbox_exec: Option<PathBuf>,
    prlimit: Option<PathBuf>,
}

impl Capabilities {
    fn detect() -> Self {
        let platform = if cfg!(target_os = "linux") {
            HostPlatform::Linux
        } else if cfg!(target_os = "macos") {
            HostPlatform::Macos
        } else if cfg!(target_os = "windows") {
            HostPlatform::Windows
        } else {
            HostPlatform::Other
        };
        let bwrap = if platform == HostPlatform::Linux {
            usable_linux_bwrap()
        } else {
            None
        };
        Self {
            platform,
            bwrap,
            sandbox_exec: find_program("sandbox-exec"),
            prlimit: find_program("prlimit"),
        }
    }
}

#[derive(Debug, Clone)]
struct SandboxLayout {
    root: PathBuf,
    home: PathBuf,
    temp: PathBuf,
}

impl SandboxLayout {
    fn prepare(extension_id: &str) -> AppResult<Self> {
        let base = sandbox_base_dir();
        std::fs::create_dir_all(&base).map_err(|error| {
            AppError::Command(format!("failed to prepare MCP sandbox base: {error}"))
        })?;
        make_private_directory(&base).map_err(|error| {
            AppError::Command(format!("failed to secure MCP sandbox base: {error}"))
        })?;
        let root = base.join(extension_id);
        let home = root.join("home");
        let temp = root.join("tmp");
        for (path, label) in [(&root, "root"), (&home, "home"), (&temp, "temp")] {
            std::fs::create_dir_all(path).map_err(|error| {
                AppError::Command(format!("failed to prepare MCP sandbox {label}: {error}"))
            })?;
            make_private_directory(path).map_err(|error| {
                AppError::Command(format!("failed to secure MCP sandbox {label}: {error}"))
            })?;
        }
        Ok(Self { root, home, temp })
    }
}

fn sandbox_base_dir() -> PathBuf {
    sandbox_base_dir_from(
        env::var_os("XDG_CACHE_HOME"),
        env::var_os("HOME"),
        env::temp_dir(),
    )
}

fn sandbox_base_dir_from(
    xdg_cache_home: Option<OsString>,
    home: Option<OsString>,
    temp: PathBuf,
) -> PathBuf {
    if let Some(path) = xdg_cache_home
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        return path.join("sourcenerve").join("mcp-sandbox");
    }
    if let Some(path) = home.map(PathBuf::from).filter(|path| path.is_absolute()) {
        return path.join(".cache").join("sourcenerve").join("mcp-sandbox");
    }
    temp.join("sourcenerve-mcp")
}

fn make_private_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct PlannedCommand {
    program: PathBuf,
    args: Vec<OsString>,
    kernel_isolated: bool,
}

impl PlannedCommand {
    fn direct(program: PathBuf, args: &[String]) -> Self {
        Self {
            program,
            args: args.iter().map(OsString::from).collect(),
            kernel_isolated: false,
        }
    }
}

pub(super) fn build_command(
    extension_id: &str,
    command: &str,
    args: &[String],
    environment: Option<&BTreeMap<String, String>>,
) -> AppResult<Command> {
    validate_extension_id(extension_id)?;
    validate_extension_environment(environment)?;
    let policy = SandboxPolicy::from_environment()?;
    let capabilities = Capabilities::detect();
    let layout = SandboxLayout::prepare(extension_id)?;
    build_command_with(command, args, environment, &policy, &capabilities, &layout)
}

fn build_command_with(
    command: &str,
    args: &[String],
    environment: Option<&BTreeMap<String, String>>,
    policy: &SandboxPolicy,
    capabilities: &Capabilities,
    layout: &SandboxLayout,
) -> AppResult<Command> {
    let executable = resolve_executable(command).unwrap_or_else(|| PathBuf::from(command));
    let mut planned = match policy.mode {
        SandboxMode::Disabled => PlannedCommand::direct(executable, args),
        SandboxMode::Auto | SandboxMode::Required => match capabilities.platform {
            HostPlatform::Linux if capabilities.bwrap.is_some() => {
                linux_plan(&executable, args, policy, capabilities, layout)?
            }
            HostPlatform::Macos if capabilities.sandbox_exec.is_some() => {
                macos_plan(&executable, args, policy, capabilities, layout)?
            }
            HostPlatform::Windows
            | HostPlatform::Other
            | HostPlatform::Linux
            | HostPlatform::Macos => {
                if policy.requires_kernel_enforcement() {
                    return Err(unsupported_error(capabilities.platform));
                }
                PlannedCommand::direct(executable, args)
            }
        },
    };

    if capabilities.platform != HostPlatform::Linux && policy.has_resource_limits() {
        return Err(AppError::InvalidRequest(
            "configured MCP stdio CPU/memory/process limits cannot be enforced on this platform; the extension was not launched"
                .into(),
        ));
    }
    if capabilities.platform == HostPlatform::Linux && policy.has_resource_limits() {
        let prlimit = capabilities.prlimit.as_ref().ok_or_else(|| {
            AppError::InvalidRequest(
                "configured MCP stdio resource limits require `prlimit` on Linux; the extension was not launched"
                    .into(),
            )
        })?;
        planned = linux_prlimit_plan(prlimit, planned, policy)?;
    }

    let mut process = Command::new(&planned.program);
    process.args(&planned.args);
    process.kill_on_drop(true);
    process.env_clear();
    for (key, value) in sandbox_environment(layout, environment, planned.kernel_isolated) {
        process.env(key, value);
    }
    process.current_dir(&layout.temp);
    Ok(process)
}

fn sandbox_environment(
    layout: &SandboxLayout,
    environment: Option<&BTreeMap<String, String>>,
    kernel_isolated: bool,
) -> BTreeMap<OsString, OsString> {
    let mut result = BTreeMap::new();
    for key in SAFE_PARENT_ENV {
        if let Ok(value) = env::var(key) {
            result.insert(OsString::from(key), OsString::from(value));
        }
    }
    result.insert(
        OsString::from("HOME"),
        layout.home.as_os_str().to_os_string(),
    );
    result.insert(
        OsString::from("USERPROFILE"),
        layout.home.as_os_str().to_os_string(),
    );
    for key in ["TMPDIR", "TMP", "TEMP"] {
        result.insert(OsString::from(key), layout.temp.as_os_str().to_os_string());
    }
    result.insert(
        OsString::from("SOURCENERVE_MCP_SANDBOX_ROOT"),
        layout.root.as_os_str().to_os_string(),
    );
    result.insert(
        OsString::from("SOURCENERVE_MCP_SANDBOX_LEVEL"),
        OsString::from(if kernel_isolated {
            "kernel"
        } else {
            "environment"
        }),
    );
    if let Some(values) = environment {
        for (key, value) in values {
            result.insert(OsString::from(key), OsString::from(value));
        }
    }
    result
}

fn linux_plan(
    executable: &Path,
    args: &[String],
    policy: &SandboxPolicy,
    capabilities: &Capabilities,
    layout: &SandboxLayout,
) -> AppResult<PlannedCommand> {
    let bwrap = capabilities.bwrap.as_ref().expect("checked by caller");
    let mut planned = PlannedCommand {
        program: bwrap.clone(),
        args: vec![
            "--die-with-parent".into(),
            "--new-session".into(),
            "--unshare-user".into(),
            "--unshare-pid".into(),
            "--unshare-ipc".into(),
            "--unshare-uts".into(),
            "--proc".into(),
            "/proc".into(),
            "--dev".into(),
            "/dev".into(),
            "--tmpfs".into(),
            "/tmp".into(),
        ],
        kernel_isolated: true,
    };
    if policy.network == NetworkPolicy::Deny {
        planned.args.push("--unshare-net".into());
    }
    for root in ["/usr", "/bin", "/lib", "/lib64", "/etc/ssl"] {
        push_ro_bind_if_exists(&mut planned.args, Path::new(root));
    }
    if policy.network == NetworkPolicy::Inherit {
        for root in ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf"] {
            push_ro_bind_if_exists(&mut planned.args, Path::new(root));
        }
    }
    bind_executable_parent_if_needed(&mut planned.args, executable)?;
    for root in &policy.allowed_roots {
        push_bind(&mut planned.args, root, false);
    }
    push_bind(&mut planned.args, &layout.root, false);
    planned.args.push("--chdir".into());
    planned.args.push(layout.temp.as_os_str().to_os_string());
    planned.args.push("--".into());
    planned.args.push(executable.as_os_str().to_os_string());
    planned.args.extend(args.iter().map(OsString::from));
    Ok(planned)
}

fn macos_plan(
    executable: &Path,
    args: &[String],
    policy: &SandboxPolicy,
    capabilities: &Capabilities,
    layout: &SandboxLayout,
) -> AppResult<PlannedCommand> {
    if policy.has_resource_limits() {
        return Err(AppError::InvalidRequest(
            "configured MCP stdio resource limits are not enforceable by the macOS sandbox; the extension was not launched"
                .into(),
        ));
    }
    let sandbox_exec = capabilities
        .sandbox_exec
        .as_ref()
        .expect("checked by caller");
    let mut profile = String::from(
        "(version 1) (deny default) (allow process*) (allow sysctl-read) (allow file-read* (subpath \"/System\") (subpath \"/usr\") (subpath \"/bin\") (subpath \"/Library\")) ",
    );
    profile.push_str(&format!(
        "(allow file-read* file-write* (subpath \"{}\")) ",
        profile_escape(&layout.root)
    ));
    if let Some(parent) = executable.parent() {
        profile.push_str(&format!(
            "(allow file-read* (subpath \"{}\")) ",
            profile_escape(parent)
        ));
    }
    for root in &policy.allowed_roots {
        profile.push_str(&format!(
            "(allow file-read* file-write* (subpath \"{}\")) ",
            profile_escape(root)
        ));
    }
    if policy.network == NetworkPolicy::Inherit {
        profile.push_str("(allow network*)");
    }
    let mut planned = PlannedCommand {
        program: sandbox_exec.clone(),
        args: vec![
            "-p".into(),
            profile.into(),
            executable.as_os_str().to_os_string(),
        ],
        kernel_isolated: true,
    };
    planned.args.extend(args.iter().map(OsString::from));
    Ok(planned)
}

fn linux_prlimit_plan(
    prlimit: &Path,
    inner: PlannedCommand,
    policy: &SandboxPolicy,
) -> AppResult<PlannedCommand> {
    let mut args = Vec::new();
    if let Some(memory_mb) = policy.max_memory_mb {
        let bytes = memory_mb.checked_mul(1024 * 1024).ok_or_else(|| {
            AppError::InvalidRequest("MCP stdio memory limit is too large".into())
        })?;
        args.push(format!("--as={bytes}").into());
    }
    if let Some(processes) = policy.max_processes {
        args.push(format!("--nproc={processes}").into());
    }
    if let Some(seconds) = policy.cpu_seconds {
        args.push(format!("--cpu={seconds}").into());
    }
    args.push("--".into());
    args.push(inner.program.as_os_str().to_os_string());
    args.extend(inner.args);
    Ok(PlannedCommand {
        program: prlimit.to_path_buf(),
        args,
        kernel_isolated: inner.kernel_isolated,
    })
}

fn push_ro_bind_if_exists(args: &mut Vec<OsString>, path: &Path) {
    if path.exists() {
        push_bind(args, path, true);
    }
}

fn push_bind(args: &mut Vec<OsString>, path: &Path, read_only: bool) {
    args.push(if read_only {
        "--ro-bind".into()
    } else {
        "--bind".into()
    });
    args.push(path.as_os_str().to_os_string());
    args.push(path.as_os_str().to_os_string());
}

fn bind_executable_parent_if_needed(args: &mut Vec<OsString>, executable: &Path) -> AppResult<()> {
    let parent = executable.parent().ok_or_else(|| {
        AppError::InvalidRequest(
            "stdio MCP executable path does not have a parent directory".into(),
        )
    })?;
    if ["/usr", "/bin", "/lib", "/lib64"]
        .iter()
        .any(|root| parent.starts_with(root))
    {
        return Ok(());
    }
    if let Some(runtime_root) = linux_node_runtime_root(executable) {
        let runtime_root = validate_allowed_root(runtime_root)?;
        push_bind(args, &runtime_root, true);
        return Ok(());
    }
    let parent = validate_allowed_root(parent.to_path_buf())?;
    push_bind(args, &parent, true);
    Ok(())
}

fn linux_node_runtime_root(executable: &Path) -> Option<PathBuf> {
    for ancestor in executable.ancestors() {
        let bin_root = ancestor.join("bin");
        let npm_root = ancestor.join("lib").join("node_modules").join("npm");
        if bin_root.join("node").is_file()
            && (executable.starts_with(&bin_root) || executable.starts_with(&npm_root))
        {
            return ancestor
                .canonicalize()
                .ok()
                .or_else(|| Some(ancestor.to_path_buf()));
        }
    }
    None
}

fn resolve_executable(command: &str) -> Option<PathBuf> {
    let path = Path::new(command);
    if path.components().count() > 1 {
        return path.canonicalize().ok();
    }
    find_program(command)
}

static USABLE_LINUX_BWRAP: OnceLock<Option<PathBuf>> = OnceLock::new();

fn usable_linux_bwrap() -> Option<PathBuf> {
    USABLE_LINUX_BWRAP
        .get_or_init(|| find_program("bwrap").filter(|path| probe_bwrap(path)))
        .clone()
}

fn probe_bwrap(path: &Path) -> bool {
    let mut command = StdCommand::new(path);
    command.args([
        "--die-with-parent",
        "--new-session",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
    ]);
    for root in ["/usr", "/bin", "/lib", "/lib64"] {
        if Path::new(root).exists() {
            command.args(["--ro-bind", root, root]);
        }
    }
    command
        .args(["--", "/bin/true"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn find_program(name: &str) -> Option<PathBuf> {
    let path = Path::new(name);
    if path.components().count() > 1 {
        return path.is_file().then(|| path.to_path_buf());
    }
    let search = env::var_os("PATH")?;
    for directory in env::split_paths(&search) {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return candidate.canonicalize().ok().or(Some(candidate));
        }
        #[cfg(windows)]
        {
            let candidate = directory.join(format!("{name}.exe"));
            if candidate.is_file() {
                return candidate.canonicalize().ok().or(Some(candidate));
            }
        }
    }
    None
}

fn validate_allowed_root(path: PathBuf) -> AppResult<PathBuf> {
    let canonical = path.canonicalize().map_err(|_| {
        AppError::InvalidRequest(format!(
            "MCP stdio allowed root `{}` must exist and be canonicalizable",
            path.display()
        ))
    })?;
    if !canonical.is_absolute() || canonical.parent().is_none() || canonical == Path::new("/") {
        return Err(AppError::InvalidRequest(
            "MCP stdio allowed roots must be specific existing absolute directories, not a filesystem root"
                .into(),
        ));
    }
    if !canonical.is_dir() {
        return Err(AppError::InvalidRequest(
            "MCP stdio allowed roots must be directories".into(),
        ));
    }
    Ok(canonical)
}

fn validate_extension_id(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 64
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
    {
        return Err(AppError::InvalidRequest(
            "invalid MCP extension id for sandbox path".into(),
        ));
    }
    Ok(())
}

fn validate_extension_environment(environment: Option<&BTreeMap<String, String>>) -> AppResult<()> {
    let Some(values) = environment else {
        return Ok(());
    };
    for key in values.keys() {
        if RESERVED_EXTENSION_ENV.contains(&key.as_str()) || key.starts_with("SOURCENERVE_") {
            return Err(AppError::InvalidRequest(format!(
                "MCP extension environment key `{key}` is reserved by the stdio sandbox"
            )));
        }
    }
    Ok(())
}

fn parse_limit(name: &str, min: u64, max: u64) -> AppResult<Option<u64>> {
    let Ok(raw) = env::var(name) else {
        return Ok(None);
    };
    let value = raw
        .parse::<u64>()
        .map_err(|_| AppError::InvalidRequest(format!("{name} must be an unsigned integer")))?;
    if !(min..=max).contains(&value) {
        return Err(AppError::InvalidRequest(format!(
            "{name} must be between {min} and {max}"
        )));
    }
    Ok(Some(value))
}

fn profile_escape(path: &Path) -> String {
    path.display()
        .to_string()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

fn unsupported_error(platform: HostPlatform) -> AppError {
    let message = match platform {
        HostPlatform::Linux => {
            "required MCP stdio sandbox restrictions need `bwrap` (bubblewrap) on Linux; the extension was not launched"
        }
        HostPlatform::Macos => {
            "required MCP stdio sandbox restrictions need `sandbox-exec` on macOS; the extension was not launched"
        }
        HostPlatform::Windows => {
            "required MCP stdio filesystem/network sandbox restrictions are not enforceable by this SourceNerve Windows runtime; the extension was not launched"
        }
        HostPlatform::Other => {
            "required MCP stdio sandbox restrictions are not supported on this platform; the extension was not launched"
        }
    };
    AppError::InvalidRequest(message.into())
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use super::*;
    use tempfile::tempdir;

    fn policy(mode: SandboxMode) -> SandboxPolicy {
        SandboxPolicy {
            mode,
            network: NetworkPolicy::Inherit,
            allowed_roots: Vec::new(),
            max_memory_mb: None,
            max_processes: None,
            cpu_seconds: None,
        }
    }

    fn layout() -> SandboxLayout {
        let root = tempdir().expect("tempdir").keep();
        let home = root.join("home");
        let temp = root.join("tmp");
        std::fs::create_dir_all(&home).expect("home");
        std::fs::create_dir_all(&temp).expect("temp");
        SandboxLayout { root, home, temp }
    }

    #[test]
    fn extension_ids_cannot_escape_the_sandbox_root() {
        assert!(validate_extension_id("memory-1").is_ok());
        assert!(validate_extension_id("../memory").is_err());
        assert!(validate_extension_id("memory/child").is_err());
    }

    #[test]
    fn extension_environment_cannot_replace_sandbox_boundaries() {
        let values = BTreeMap::from([("HOME".to_string(), "/tmp/escape".to_string())]);
        assert!(validate_extension_environment(Some(&values)).is_err());
        let values = BTreeMap::from([("GITHUB_TOKEN".to_string(), "explicit".to_string())]);
        assert!(validate_extension_environment(Some(&values)).is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unusable_bwrap_is_not_treated_as_a_linux_sandbox_capability() {
        assert!(!probe_bwrap(Path::new("/bin/false")));
    }

    #[test]
    fn auto_policy_falls_back_to_environment_isolation_without_usable_bwrap() {
        let capabilities = Capabilities {
            platform: HostPlatform::Linux,
            bwrap: None,
            sandbox_exec: None,
            prlimit: None,
        };
        let command = build_command_with(
            "/bin/true",
            &[],
            None,
            &policy(SandboxMode::Auto),
            &capabilities,
            &layout(),
        )
        .expect("auto mode should use environment isolation when bwrap is unusable");
        assert_eq!(
            Path::new(command.as_std().get_program()).file_name(),
            Some(OsStr::new("true"))
        );
    }

    #[test]
    fn required_policy_fails_closed_when_platform_has_no_kernel_sandbox() {
        let capabilities = Capabilities {
            platform: HostPlatform::Windows,
            bwrap: None,
            sandbox_exec: None,
            prlimit: None,
        };
        let error = build_command_with(
            "tool",
            &[],
            None,
            &policy(SandboxMode::Required),
            &capabilities,
            &layout(),
        )
        .expect_err("strict sandbox must fail closed");
        assert!(error.to_string().contains("not enforceable"));
    }

    #[test]
    fn linux_network_deny_plan_unshares_network_and_pid_namespace() {
        let root = tempdir().expect("root");
        let executable = root.path().join("tool");
        std::fs::write(&executable, b"test").expect("tool");
        let mut sandbox_policy = policy(SandboxMode::Required);
        sandbox_policy.network = NetworkPolicy::Deny;
        let capabilities = Capabilities {
            platform: HostPlatform::Linux,
            bwrap: Some(PathBuf::from("/usr/bin/bwrap")),
            sandbox_exec: None,
            prlimit: None,
        };
        let planned = linux_plan(&executable, &[], &sandbox_policy, &capabilities, &layout())
            .expect("linux plan");
        let args = planned
            .args
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>();
        assert!(args.iter().any(|value| value == "--unshare-net"));
        assert!(args.iter().any(|value| value == "--unshare-pid"));
        assert!(planned.kernel_isolated);
    }

    #[test]
    fn linux_npx_runtime_binds_the_node_prefix_read_only() {
        let runtime = tempdir().expect("runtime");
        let node = runtime.path().join("bin/node");
        let npx = runtime.path().join("lib/node_modules/npm/bin/npx-cli.js");
        std::fs::create_dir_all(node.parent().expect("node parent")).expect("node bin");
        std::fs::create_dir_all(npx.parent().expect("npx parent")).expect("npm bin");
        std::fs::write(&node, b"node").expect("node");
        std::fs::write(&npx, b"#!/usr/bin/env node\n").expect("npx");

        let mut args = Vec::new();
        bind_executable_parent_if_needed(&mut args, &npx).expect("bind runtime");
        let runtime_root = runtime.path().canonicalize().expect("runtime root");
        let values = args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(values[0], "--ro-bind");
        assert_eq!(PathBuf::from(&values[1]), runtime_root);
        assert_eq!(PathBuf::from(&values[2]), runtime_root);
    }

    #[test]
    fn sandbox_base_prefers_user_cache_over_world_writable_temp() {
        assert_eq!(
            sandbox_base_dir_from(
                Some(OsString::from("/home/example/.cache")),
                Some(OsString::from("/home/example")),
                PathBuf::from("/tmp"),
            ),
            PathBuf::from("/home/example/.cache/sourcenerve/mcp-sandbox")
        );
        assert_eq!(
            sandbox_base_dir_from(
                None,
                Some(OsString::from("/home/example")),
                PathBuf::from("/tmp"),
            ),
            PathBuf::from("/home/example/.cache/sourcenerve/mcp-sandbox")
        );
    }

    #[test]
    fn environment_only_plan_uses_private_home_and_temp() {
        let layout = layout();
        let envs = sandbox_environment(&layout, None, false);
        assert_eq!(
            envs.get(OsStr::new("HOME")),
            Some(&layout.home.as_os_str().to_os_string())
        );
        assert_eq!(
            envs.get(OsStr::new("TMPDIR")),
            Some(&layout.temp.as_os_str().to_os_string())
        );
        assert!(!envs.contains_key(OsStr::new("SSH_AUTH_SOCK")));
    }
}
