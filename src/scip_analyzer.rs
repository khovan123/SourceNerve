use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::OnceLock,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{io::AsyncReadExt, process::Command, sync::Semaphore, time::timeout};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    git,
    scip_enrichment::{self, MAX_SCIP_BYTES, ScipImportRequest, ScipStatus},
    service::AppState,
    workspace::Workspace,
};

const CONFIG_ENV: &str = "SOURCENERVE_SCIP_ANALYZERS_JSON";
const MAX_ANALYZERS: usize = 16;
const MAX_ARGS: usize = 32;
const MAX_ARG_BYTES: usize = 512;
const MAX_MANIFESTS: usize = 16;
const MAX_SCAN_DEPTH: usize = 6;
const MAX_SCAN_ENTRIES: usize = 20_000;
const MAX_PROJECT_ROOTS: usize = 32;
const MAX_EXECUTABLE_BYTES: u64 = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS: u64 = 60;
const MAX_TIMEOUT_SECONDS: u64 = 300;
const DEFAULT_SAFE_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

static RUNTIME: OnceLock<Option<RuntimeConfig>> = OnceLock::new();
static ANALYZER_GATE: OnceLock<Semaphore> = OnceLock::new();

fn default_timeout_seconds() -> u64 {
    DEFAULT_TIMEOUT_SECONDS
}

fn default_max_output_bytes() -> usize {
    MAX_SCIP_BYTES
}

#[derive(Debug, Clone, Deserialize)]
pub struct AnalyzerSpec {
    pub id: String,
    pub executable: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    pub manifests: Vec<String>,
    #[serde(default = "default_timeout_seconds")]
    pub timeout_seconds: u64,
    #[serde(default = "default_max_output_bytes")]
    pub max_output_bytes: usize,
}

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    analyzers: BTreeMap<String, AnalyzerSpec>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ScipAnalyzeRequest {
    pub workspace: String,
    pub analyzer_id: String,
    #[serde(default)]
    pub project_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ScipAnalyzerRunStatus {
    pub run_id: String,
    pub analyzer_id: String,
    pub project_root: String,
    pub git_head: String,
    pub graph_version: i64,
    pub executable_sha256: String,
    pub status: String,
    pub failure_code: Option<String>,
    pub scip_run_id: Option<String>,
    pub provider_tool: Option<String>,
    pub provider_version: Option<String>,
    pub index_sha256: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ScipAnalyzerStatus {
    pub id: String,
    pub manifests: Vec<String>,
    pub eligible_project_roots: Vec<String>,
    pub timeout_seconds: u64,
    pub max_output_bytes: usize,
    pub latest_run: Option<ScipAnalyzerRunStatus>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ScipAnalyzerRegistryStatus {
    pub workspace: String,
    pub configured: bool,
    pub analyzers: Vec<ScipAnalyzerStatus>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ScipAnalyzeResult {
    pub analyzer: ScipAnalyzerRunStatus,
    pub enrichment: ScipStatus,
}

type RunRow = (
    String,
    String,
    String,
    String,
    i64,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    Option<i64>,
);

struct TempOutput {
    root: PathBuf,
    output: PathBuf,
}

impl TempOutput {
    async fn create() -> AppResult<Self> {
        let root = std::env::temp_dir().join(format!("sourcenerve-scip-{}", Uuid::new_v4()));
        tokio::fs::create_dir(&root).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).await?;
        }
        let output = root.join("index.scip");
        Ok(Self { root, output })
    }
}

impl Drop for TempOutput {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl RuntimeConfig {
    pub fn from_env() -> AppResult<Option<Self>> {
        let raw = match std::env::var(CONFIG_ENV) {
            Ok(value) => value,
            Err(std::env::VarError::NotPresent) => return Ok(None),
            Err(_) => {
                return Err(AppError::InvalidRequest(format!(
                    "startup preflight failed: {CONFIG_ENV} is not valid UTF-8"
                )));
            }
        };
        if raw.trim().is_empty() {
            return Err(AppError::InvalidRequest(format!(
                "startup preflight failed: {CONFIG_ENV} must not be empty"
            )));
        }
        let specs: Vec<AnalyzerSpec> = serde_json::from_str(&raw).map_err(|_| {
            AppError::InvalidRequest(format!(
                "startup preflight failed: {CONFIG_ENV} must be a JSON array of analyzer specs"
            ))
        })?;
        if specs.is_empty() || specs.len() > MAX_ANALYZERS {
            return Err(AppError::InvalidRequest(format!(
                "startup preflight failed: managed SCIP analyzer count must be 1..={MAX_ANALYZERS}"
            )));
        }

        let mut analyzers = BTreeMap::new();
        for spec in specs {
            validate_spec(&spec)?;
            if analyzers.insert(spec.id.clone(), spec).is_some() {
                return Err(AppError::InvalidRequest(
                    "startup preflight failed: managed SCIP analyzer IDs must be unique".into(),
                ));
            }
        }
        Ok(Some(Self { analyzers }))
    }
}

pub fn install_runtime(config: Option<RuntimeConfig>) -> AppResult<()> {
    RUNTIME.set(config).map_err(|_| {
        AppError::InvalidRequest("managed SCIP analyzer runtime was configured more than once".into())
    })
}

pub async fn preflight(config: Option<&RuntimeConfig>) -> AppResult<()> {
    let Some(config) = config else {
        return Ok(());
    };
    for spec in config.analyzers.values() {
        let metadata = tokio::fs::metadata(&spec.executable).await.map_err(|_| {
            AppError::InvalidRequest(format!(
                "startup preflight failed: managed SCIP analyzer `{}` executable is unavailable",
                spec.id
            ))
        })?;
        if !metadata.is_file() {
            return Err(AppError::InvalidRequest(format!(
                "startup preflight failed: managed SCIP analyzer `{}` executable is not a regular file",
                spec.id
            )));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err(AppError::InvalidRequest(format!(
                    "startup preflight failed: managed SCIP analyzer `{}` executable is not executable",
                    spec.id
                )));
            }
        }
    }
    Ok(())
}

fn validate_spec(spec: &AnalyzerSpec) -> AppResult<()> {
    if spec.id.is_empty()
        || spec.id.len() > 64
        || !spec
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(AppError::InvalidRequest(
            "startup preflight failed: managed SCIP analyzer id is invalid".into(),
        ));
    }
    if !spec.executable.is_absolute() {
        return Err(AppError::InvalidRequest(format!(
            "startup preflight failed: managed SCIP analyzer `{}` executable must be an absolute path",
            spec.id
        )));
    }
    if spec.args.len() > MAX_ARGS {
        return Err(AppError::InvalidRequest(format!(
            "startup preflight failed: managed SCIP analyzer `{}` has too many arguments",
            spec.id
        )));
    }
    let mut output_placeholder = false;
    for arg in &spec.args {
        if arg.len() > MAX_ARG_BYTES || arg.contains('\0') {
            return Err(AppError::InvalidRequest(format!(
                "startup preflight failed: managed SCIP analyzer `{}` has an invalid argument",
                spec.id
            )));
        }
        if arg.contains("{output}") {
            output_placeholder = true;
        }
        let remainder = arg.replace("{output}", "");
        if remainder.contains('{') || remainder.contains('}') {
            return Err(AppError::InvalidRequest(format!(
                "startup preflight failed: managed SCIP analyzer `{}` uses an unsupported argument placeholder",
                spec.id
            )));
        }
    }
    if !output_placeholder {
        return Err(AppError::InvalidRequest(format!(
            "startup preflight failed: managed SCIP analyzer `{}` args must include {{output}}",
            spec.id
        )));
    }
    if spec.manifests.is_empty() || spec.manifests.len() > MAX_MANIFESTS {
        return Err(AppError::InvalidRequest(format!(
            "startup preflight failed: managed SCIP analyzer `{}` manifest count must be 1..={MAX_MANIFESTS}",
            spec.id
        )));
    }
    for manifest in &spec.manifests {
        let path = Path::new(manifest);
        if manifest.is_empty()
            || manifest.len() > 128
            || path.components().count() != 1
            || !matches!(path.components().next(), Some(Component::Normal(_)))
        {
            return Err(AppError::InvalidRequest(format!(
                "startup preflight failed: managed SCIP analyzer `{}` manifests must be simple file names",
                spec.id
            )));
        }
    }
    if !(1..=MAX_TIMEOUT_SECONDS).contains(&spec.timeout_seconds) {
        return Err(AppError::InvalidRequest(format!(
            "startup preflight failed: managed SCIP analyzer `{}` timeout must be 1..={MAX_TIMEOUT_SECONDS} seconds",
            spec.id
        )));
    }
    if !(1..=MAX_SCIP_BYTES).contains(&spec.max_output_bytes) {
        return Err(AppError::InvalidRequest(format!(
            "startup preflight failed: managed SCIP analyzer `{}` output limit must be 1..={MAX_SCIP_BYTES} bytes",
            spec.id
        )));
    }
    Ok(())
}

fn runtime() -> AppResult<&'static RuntimeConfig> {
    RUNTIME
        .get()
        .and_then(Option::as_ref)
        .ok_or_else(|| AppError::InvalidRequest("managed SCIP analyzers are not configured".into()))
}

fn normalized_project_root(raw: &str) -> AppResult<String> {
    if raw == "." {
        return Ok(".".into());
    }
    let path = Path::new(raw);
    if raw.trim().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(AppError::InvalidRequest("invalid analyzer project root".into()));
    }
    let normalized = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            Component::CurDir => None,
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        return Err(AppError::InvalidRequest("invalid analyzer project root".into()));
    }
    Ok(normalized)
}

fn scan_project_roots(root: &Path, manifests: &BTreeSet<String>) -> AppResult<Vec<String>> {
    fn visit(
        workspace_root: &Path,
        dir: &Path,
        depth: usize,
        manifests: &BTreeSet<String>,
        entries_seen: &mut usize,
        roots: &mut BTreeSet<String>,
    ) -> AppResult<()> {
        if depth > MAX_SCAN_DEPTH {
            return Ok(());
        }
        let mut entries = std::fs::read_dir(dir)
            .map_err(|_| AppError::InvalidRequest("unable to scan analyzer project roots".into()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| AppError::InvalidRequest("unable to scan analyzer project roots".into()))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            *entries_seen += 1;
            if *entries_seen > MAX_SCAN_ENTRIES {
                return Err(AppError::InvalidRequest(
                    "analyzer project-root scan exceeded its entry limit".into(),
                ));
            }
            let file_type = entry
                .file_type()
                .map_err(|_| AppError::InvalidRequest("unable to inspect analyzer project roots".into()))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if file_type.is_file() && manifests.contains(&name) {
                let parent = entry.path().parent().unwrap_or(workspace_root).to_path_buf();
                let relative = parent.strip_prefix(workspace_root).map_err(|_| {
                    AppError::InvalidRequest("analyzer project root escaped workspace".into())
                })?;
                let rendered = if relative.as_os_str().is_empty() {
                    ".".to_string()
                } else {
                    relative.to_string_lossy().replace('\\', "/")
                };
                roots.insert(rendered);
                if roots.len() > MAX_PROJECT_ROOTS {
                    return Err(AppError::InvalidRequest(
                        "analyzer project-root scan found too many eligible roots".into(),
                    ));
                }
            } else if file_type.is_dir() && depth < MAX_SCAN_DEPTH {
                if matches!(name.as_str(), ".git" | "node_modules" | "target" | "vendor" | ".venv") {
                    continue;
                }
                visit(
                    workspace_root,
                    &entry.path(),
                    depth + 1,
                    manifests,
                    entries_seen,
                    roots,
                )?;
            }
        }
        Ok(())
    }

    let mut roots = BTreeSet::new();
    let mut entries_seen = 0;
    visit(
        root,
        root,
        0,
        manifests,
        &mut entries_seen,
        &mut roots,
    )?;
    Ok(roots.into_iter().collect())
}

async fn detect_project_roots(workspace: &Workspace, spec: &AnalyzerSpec) -> AppResult<Vec<String>> {
    let root = workspace.root.clone();
    let manifests = spec.manifests.iter().cloned().collect::<BTreeSet<_>>();
    tokio::task::spawn_blocking(move || scan_project_roots(&root, &manifests))
        .await
        .map_err(|_| AppError::InvalidRequest("analyzer project-root scan failed".into()))?
}

async fn executable_sha256(path: &Path) -> AppResult<String> {
    let metadata = tokio::fs::metadata(path).await.map_err(|_| {
        AppError::InvalidRequest("configured SCIP analyzer executable is unavailable".into())
    })?;
    if !metadata.is_file() || metadata.len() > MAX_EXECUTABLE_BYTES {
        return Err(AppError::InvalidRequest(
            "configured SCIP analyzer executable cannot be fingerprinted safely".into(),
        ));
    }
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

async fn latest_run(
    state: &AppState,
    workspace: &str,
    analyzer_id: &str,
) -> AppResult<Option<ScipAnalyzerRunStatus>> {
    let row: Option<RunRow> = sqlx::query_as(
        "SELECT id, analyzer_id, project_root, git_head, graph_version, executable_sha256, status, \
                failure_code, scip_run_id, provider_tool, provider_version, index_sha256, started_at, finished_at \
         FROM scip_analyzer_runs WHERE workspace_id=?1 AND analyzer_id=?2 \
         ORDER BY started_at DESC, id DESC LIMIT 1",
    )
    .bind(workspace)
    .bind(analyzer_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(|row| ScipAnalyzerRunStatus {
        run_id: row.0,
        analyzer_id: row.1,
        project_root: row.2,
        git_head: row.3,
        graph_version: row.4,
        executable_sha256: row.5,
        status: row.6,
        failure_code: row.7,
        scip_run_id: row.8,
        provider_tool: row.9,
        provider_version: row.10,
        index_sha256: row.11,
        started_at: row.12,
        finished_at: row.13,
    }))
}

pub async fn status(state: &AppState, workspace_id: &str) -> AppResult<ScipAnalyzerRegistryStatus> {
    let workspace = state.workspaces.get(workspace_id)?;
    let Some(config) = RUNTIME.get().and_then(Option::as_ref) else {
        return Ok(ScipAnalyzerRegistryStatus {
            workspace: workspace.id,
            configured: false,
            analyzers: Vec::new(),
        });
    };

    let mut analyzers = Vec::with_capacity(config.analyzers.len());
    for spec in config.analyzers.values() {
        analyzers.push(ScipAnalyzerStatus {
            id: spec.id.clone(),
            manifests: spec.manifests.clone(),
            eligible_project_roots: detect_project_roots(&workspace, spec).await?,
            timeout_seconds: spec.timeout_seconds,
            max_output_bytes: spec.max_output_bytes,
            latest_run: latest_run(state, &workspace.id, &spec.id).await?,
        });
    }
    Ok(ScipAnalyzerRegistryStatus {
        workspace: workspace.id,
        configured: true,
        analyzers,
    })
}

async fn record_running(
    state: &AppState,
    run_id: &str,
    workspace: &str,
    analyzer_id: &str,
    project_root: &str,
    git_head: &str,
    graph_version: i64,
    executable_hash: &str,
) -> AppResult<()> {
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE scip_analyzer_runs SET status='failed', failure_code='interrupted', finished_at=unixepoch() \
         WHERE workspace_id=?1 AND analyzer_id=?2 AND status='running'",
    )
    .bind(workspace)
    .bind(analyzer_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO scip_analyzer_runs(\
            id, workspace_id, analyzer_id, project_root, git_head, graph_version, executable_sha256, status, started_at\
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', unixepoch())",
    )
    .bind(run_id)
    .bind(workspace)
    .bind(analyzer_id)
    .bind(project_root)
    .bind(git_head)
    .bind(graph_version)
    .bind(executable_hash)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn record_failure(state: &AppState, run_id: &str, code: &str) -> AppResult<()> {
    sqlx::query(
        "UPDATE scip_analyzer_runs SET status='failed', failure_code=?2, finished_at=unixepoch() WHERE id=?1",
    )
    .bind(run_id)
    .bind(code)
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn record_success(
    state: &AppState,
    run_id: &str,
    enrichment: &ScipStatus,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE scip_analyzer_runs SET status='succeeded', failure_code=NULL, scip_run_id=?2, \
                provider_tool=?3, provider_version=?4, index_sha256=?5, finished_at=unixepoch() WHERE id=?1",
    )
    .bind(run_id)
    .bind(&enrichment.run_id)
    .bind(&enrichment.provider_tool)
    .bind(&enrichment.provider_version)
    .bind(&enrichment.index_sha256)
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn run_process(spec: &AnalyzerSpec, cwd: &Path, temp: &TempOutput) -> AppResult<()> {
    let output = temp.output.to_string_lossy();
    let args = spec
        .args
        .iter()
        .map(|arg| arg.replace("{output}", output.as_ref()))
        .collect::<Vec<_>>();

    let mut command = Command::new(&spec.executable);
    command
        .current_dir(cwd)
        .args(&args)
        .env_clear()
        .env("PATH", DEFAULT_SAFE_PATH)
        .env("HOME", &temp.root)
        .env("TMPDIR", &temp.root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("CI", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut child = command.spawn().map_err(|_| {
        AppError::InvalidRequest("configured SCIP analyzer could not be started".into())
    })?;
    let status = match timeout(Duration::from_secs(spec.timeout_seconds), child.wait()).await {
        Ok(result) => result.map_err(|_| {
            AppError::InvalidRequest("configured SCIP analyzer process failed".into())
        })?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(AppError::InvalidRequest("configured SCIP analyzer timed out".into()));
        }
    };
    if !status.success() {
        return Err(AppError::InvalidRequest(
            "configured SCIP analyzer exited unsuccessfully".into(),
        ));
    }
    Ok(())
}

async fn read_output(spec: &AnalyzerSpec, temp: &TempOutput) -> AppResult<Vec<u8>> {
    let metadata = tokio::fs::symlink_metadata(&temp.output).await.map_err(|_| {
        AppError::InvalidRequest("configured SCIP analyzer did not produce an index".into())
    })?;
    if !metadata.file_type().is_file() {
        return Err(AppError::InvalidRequest(
            "configured SCIP analyzer output is not a regular file".into(),
        ));
    }
    let size = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    if size == 0 || size > spec.max_output_bytes || size > MAX_SCIP_BYTES {
        return Err(AppError::InvalidRequest(
            "configured SCIP analyzer output exceeded its size contract".into(),
        ));
    }
    let bytes = tokio::fs::read(&temp.output).await?;
    if bytes.len() != size {
        return Err(AppError::InvalidRequest(
            "configured SCIP analyzer output changed while being read".into(),
        ));
    }
    Ok(bytes)
}

fn failure_code(error: &AppError) -> &'static str {
    match error {
        AppError::InvalidRequest(message) if message.contains("timed out") => "timeout",
        AppError::InvalidRequest(message) if message.contains("exited unsuccessfully") => {
            "non_zero_exit"
        }
        AppError::InvalidRequest(message) if message.contains("size contract") => "oversized_output",
        AppError::InvalidRequest(message) if message.contains("did not produce") => "missing_output",
        AppError::InvalidRequest(message) if message.contains("regular file") => "invalid_output_type",
        _ => "analyzer_failed",
    }
}

pub async fn analyze(state: &AppState, request: ScipAnalyzeRequest) -> AppResult<ScipAnalyzeResult> {
    let config = runtime()?;
    let spec = config.analyzers.get(&request.analyzer_id).ok_or_else(|| {
        AppError::InvalidRequest("unknown or unconfigured managed SCIP analyzer id".into())
    })?;
    let workspace = state.workspaces.get(&request.workspace)?;
    let roots = detect_project_roots(&workspace, spec).await?;
    let project_root = match request.project_root.as_deref() {
        Some(raw) => {
            let root = normalized_project_root(raw)?;
            if !roots.iter().any(|candidate| candidate == &root) {
                return Err(AppError::InvalidRequest(
                    "requested analyzer project root is not currently eligible".into(),
                ));
            }
            root
        }
        None if roots.len() == 1 => roots[0].clone(),
        None if roots.is_empty() => {
            return Err(AppError::InvalidRequest(
                "managed SCIP analyzer found no eligible project root".into(),
            ));
        }
        None => {
            return Err(AppError::InvalidRequest(
                "managed SCIP analyzer found multiple eligible project roots; select one from analyzer status"
                    .into(),
            ));
        }
    };

    let _permit = ANALYZER_GATE
        .get_or_init(|| Semaphore::new(1))
        .acquire()
        .await
        .map_err(|_| AppError::InvalidRequest("managed SCIP analyzer gate is unavailable".into()))?;

    let head = git::head(&workspace.root).await?;
    if !git::status(&workspace.root).await?.is_empty() {
        return Err(AppError::InvalidRequest(
            "managed SCIP analysis requires a clean working tree".into(),
        ));
    }
    let (graph_version, indexed_head): (i64, Option<String>) =
        sqlx::query_as("SELECT graph_version, indexed_head FROM workspaces WHERE id=?1")
            .bind(&workspace.id)
            .fetch_one(&state.db)
            .await?;
    if indexed_head.as_deref() != Some(head.as_str()) {
        return Err(AppError::InvalidRequest(
            "deterministic graph is not indexed at the current Git HEAD".into(),
        ));
    }

    let executable_hash = executable_sha256(&spec.executable).await?;
    let run_id = Uuid::new_v4().to_string();
    record_running(
        state,
        &run_id,
        &workspace.id,
        &spec.id,
        &project_root,
        &head,
        graph_version,
        &executable_hash,
    )
    .await?;

    let temp = TempOutput::create().await?;
    let cwd = if project_root == "." {
        workspace.root.clone()
    } else {
        workspace.root.join(&project_root)
    };
    if let Err(error) = run_process(spec, &cwd, &temp).await {
        record_failure(state, &run_id, failure_code(&error)).await?;
        return Err(error);
    }
    let bytes = match read_output(spec, &temp).await {
        Ok(bytes) => bytes,
        Err(error) => {
            record_failure(state, &run_id, failure_code(&error)).await?;
            return Err(error);
        }
    };

    let imported = match scip_enrichment::import(
        state,
        ScipImportRequest {
            workspace: workspace.id.clone(),
            expected_head: head,
            expected_graph_version: graph_version,
            index_base64: STANDARD.encode(bytes),
        },
    )
    .await
    {
        Ok(imported) => imported,
        Err(error) => {
            record_failure(state, &run_id, "activation_rejected").await?;
            return Err(error);
        }
    };
    record_success(state, &run_id, &imported.run).await?;
    let analyzer = latest_run(state, &workspace.id, &spec.id)
        .await?
        .ok_or_else(|| AppError::InvalidRequest("managed SCIP analyzer run disappeared".into()))?;
    Ok(ScipAnalyzeResult {
        analyzer,
        enrichment: imported.run,
    })
}

#[cfg(test)]
mod tests {
    use super::{AnalyzerSpec, RuntimeConfig, normalized_project_root, validate_spec};
    use std::path::PathBuf;

    fn spec() -> AnalyzerSpec {
        AnalyzerSpec {
            id: "rust-scip".into(),
            executable: PathBuf::from("/usr/bin/scip-rust"),
            args: vec!["--output".into(), "{output}".into()],
            manifests: vec!["Cargo.toml".into()],
            timeout_seconds: 60,
            max_output_bytes: 1024,
        }
    }

    #[test]
    fn rejects_client_escapable_registry_shapes() {
        let mut value = spec();
        value.executable = PathBuf::from("scip-rust");
        assert!(validate_spec(&value).is_err());

        let mut value = spec();
        value.args = vec!["{client_args}".into(), "{output}".into()];
        assert!(validate_spec(&value).is_err());

        let mut value = spec();
        value.manifests = vec!["../Cargo.toml".into()];
        assert!(validate_spec(&value).is_err());
    }

    #[test]
    fn normalizes_only_workspace_relative_project_roots() {
        assert_eq!(normalized_project_root(".").unwrap(), ".");
        assert_eq!(normalized_project_root("./crates/core").unwrap(), "crates/core");
        assert!(normalized_project_root("../outside").is_err());
        assert!(normalized_project_root("/outside").is_err());
    }

    #[test]
    fn parses_bounded_runtime_json() {
        let raw = r#"[{"id":"ci","executable":"/bin/cp","args":["fixture.scip","{output}"],"manifests":["Cargo.toml"],"timeout_seconds":5,"max_output_bytes":4096}]"#;
        let specs: Vec<AnalyzerSpec> = serde_json::from_str(raw).unwrap();
        assert_eq!(specs.len(), 1);
        validate_spec(&specs[0]).unwrap();
        let runtime = RuntimeConfig {
            analyzers: specs.into_iter().map(|spec| (spec.id.clone(), spec)).collect(),
        };
        assert!(runtime.analyzers.contains_key("ci"));
    }
}
