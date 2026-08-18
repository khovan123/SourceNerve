use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::OnceLock,
    time::Duration,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::timeout,
};

use crate::{
    embedding_provider,
    error::{AppError, AppResult},
    git,
    semantic::{
        self, SemanticChunkImport, SemanticImportRequest, SemanticImportResult, SemanticRunView,
        SemanticSearchRequest, SemanticSearchResult,
    },
    service::AppState,
};

const OPENAI_PROVIDER_ID: &str = "openai";
const DEFAULT_OPENAI_MODEL: &str = "text-embedding-3-small";
const DEFAULT_MAX_CHUNKS: usize = 128;
const MAX_INDEX_CHUNKS: usize = 256;
const MAX_CHUNK_LINES: usize = 80;
const TARGET_CHUNK_BYTES: usize = 8 * 1024;
const MAX_SINGLE_LINE_BYTES: usize = 32 * 1024;
const MAX_TOTAL_SOURCE_BYTES: usize = 512 * 1024;
const EMBEDDING_BATCH_SIZE: usize = 16;
const MAX_PROVIDER_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_QUERY_BYTES: usize = 16 * 1024;
const MAX_MODEL_BYTES: usize = 128;
const MAX_PROVIDER_ID_BYTES: usize = 64;
const MAX_SEARCH_LIMIT: usize = 100;
const MAX_VECTOR_DIMENSION: usize = 4096;
const MAX_PROVIDER_CONFIG_BYTES: usize = 16 * 1024;
const MAX_PROVIDERS: usize = 8;
const MAX_EXEC_ARGS: usize = 16;
const MAX_EXEC_ARG_BYTES: usize = 256;
const PROVIDER_TIMEOUT_SECS: u64 = 30;

static RUNTIME: OnceLock<Option<RuntimeConfig>> = OnceLock::new();

type EmbedFuture<'a> = Pin<Box<dyn Future<Output = AppResult<Vec<Vec<f32>>>> + Send + 'a>>;

#[derive(Clone)]
pub struct RuntimeConfig {
    providers: BTreeMap<String, EmbeddingProvider>,
    default_provider: String,
}

#[derive(Clone)]
struct EmbeddingProvider {
    id: String,
    model: String,
    backend: ProviderBackend,
}

#[derive(Clone)]
enum ProviderBackend {
    OpenAi,
    Executable(ExecutableProvider),
}

#[derive(Clone)]
struct ExecutableProvider {
    executable: PathBuf,
    args: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderConfigEntry {
    id: String,
    kind: String,
    model: String,
    executable: Option<String>,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SemanticProviderIndexRequest {
    pub workspace: String,
    pub client_run_id: String,
    #[serde(default = "default_max_chunks")]
    pub max_chunks: usize,
    #[serde(default)]
    pub provider_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SemanticSearchTextRequest {
    pub workspace: String,
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub provider_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ProviderRegistryStatus {
    pub configured: bool,
    pub default_provider: Option<String>,
    pub providers: Vec<ProviderStatusItem>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ProviderStatusItem {
    pub id: String,
    pub model: String,
    pub kind: &'static str,
    pub is_default: bool,
}

#[derive(Debug, Clone)]
struct PlannedChunk {
    path: String,
    start_line: usize,
    end_line: usize,
    file_sha256: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingDatum>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingDatum {
    index: usize,
    embedding: Vec<f32>,
}

#[derive(Debug)]
struct ExistingRunRow {
    id: String,
    provider: String,
    model: String,
    dimension: i64,
    git_head: String,
    graph_version: i64,
    status: String,
    created_at: i64,
    activated_at: i64,
}

fn default_max_chunks() -> usize {
    DEFAULT_MAX_CHUNKS
}

fn default_limit() -> usize {
    20
}

fn valid_identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn validate_provider_id(value: &str) -> AppResult<()> {
    if !valid_identifier(value, MAX_PROVIDER_ID_BYTES) {
        return Err(AppError::InvalidRequest(
            "provider_id must be 1-64 ASCII characters using letters, digits, '.', '_', or '-'"
                .into(),
        ));
    }
    Ok(())
}

fn validate_model(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > MAX_MODEL_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
    {
        return Err(AppError::InvalidRequest(
            "embedding provider model must be 1-128 bounded ASCII model-id characters".into(),
        ));
    }
    Ok(())
}

fn validate_client_run_id(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(AppError::InvalidRequest(
            "client_run_id must be 1-128 ASCII characters using letters, digits, '.', '_', ':', or '-'"
                .into(),
        ));
    }
    Ok(())
}

fn validate_query(value: &str) -> AppResult<()> {
    if value.trim().is_empty() || value.len() > MAX_QUERY_BYTES {
        return Err(AppError::InvalidRequest(format!(
            "semantic text query must be non-empty and at most {MAX_QUERY_BYTES} UTF-8 bytes"
        )));
    }
    if value
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err(AppError::InvalidRequest(
            "semantic text query contains unsupported control characters".into(),
        ));
    }
    Ok(())
}

fn validate_executable(path: &str) -> AppResult<PathBuf> {
    if path.is_empty()
        || path.len() > 1024
        || !path.is_ascii()
        || path.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(AppError::InvalidRequest(
            "embedding provider executable must be a bounded ASCII absolute path".into(),
        ));
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(AppError::InvalidRequest(
            "embedding provider executable must be an absolute path".into(),
        ));
    }
    Ok(path)
}

fn validate_args(args: &[String]) -> AppResult<()> {
    if args.len() > MAX_EXEC_ARGS {
        return Err(AppError::InvalidRequest(format!(
            "embedding provider args must contain at most {MAX_EXEC_ARGS} entries"
        )));
    }
    for arg in args {
        if arg.len() > MAX_EXEC_ARG_BYTES
            || !arg.is_ascii()
            || arg.bytes().any(|byte| byte == 0 || byte.is_ascii_control())
        {
            return Err(AppError::InvalidRequest(
                "embedding provider args must be bounded printable ASCII strings".into(),
            ));
        }
    }
    Ok(())
}

fn parse_secondary_providers(value: &str) -> AppResult<Vec<ProviderConfigEntry>> {
    if value.len() > MAX_PROVIDER_CONFIG_BYTES {
        return Err(AppError::InvalidRequest(format!(
            "SOURCENERVE_EMBEDDING_PROVIDERS_JSON must be at most {MAX_PROVIDER_CONFIG_BYTES} bytes"
        )));
    }
    let entries: Vec<ProviderConfigEntry> = serde_json::from_str(value).map_err(|_| {
        AppError::InvalidRequest(
            "SOURCENERVE_EMBEDDING_PROVIDERS_JSON must be a valid provider array".into(),
        )
    })?;
    if entries.len() > MAX_PROVIDERS {
        return Err(AppError::InvalidRequest(format!(
            "at most {MAX_PROVIDERS} managed embedding providers may be configured"
        )));
    }
    Ok(entries)
}

impl RuntimeConfig {
    pub fn from_env(openai_enabled: bool) -> AppResult<Option<Self>> {
        let mut providers = BTreeMap::new();
        if openai_enabled {
            let model = env::var("SOURCENERVE_OPENAI_EMBEDDING_MODEL")
                .unwrap_or_else(|_| DEFAULT_OPENAI_MODEL.to_string());
            validate_model(&model)?;
            providers.insert(
                OPENAI_PROVIDER_ID.to_string(),
                EmbeddingProvider {
                    id: OPENAI_PROVIDER_ID.to_string(),
                    model,
                    backend: ProviderBackend::OpenAi,
                },
            );
        }

        if let Ok(raw) = env::var("SOURCENERVE_EMBEDDING_PROVIDERS_JSON") {
            for entry in parse_secondary_providers(&raw)? {
                validate_provider_id(&entry.id)?;
                validate_model(&entry.model)?;
                if entry.kind != "executable" {
                    return Err(AppError::InvalidRequest(format!(
                        "embedding provider `{}` has unsupported kind; only `executable` is accepted for secondary providers",
                        entry.id
                    )));
                }
                let executable = entry.executable.as_deref().ok_or_else(|| {
                    AppError::InvalidRequest(format!(
                        "embedding provider `{}` requires an executable path",
                        entry.id
                    ))
                })?;
                let executable = validate_executable(executable)?;
                validate_args(&entry.args)?;
                if providers.contains_key(&entry.id) {
                    return Err(AppError::InvalidRequest(format!(
                        "duplicate managed embedding provider id `{}`",
                        entry.id
                    )));
                }
                providers.insert(
                    entry.id.clone(),
                    EmbeddingProvider {
                        id: entry.id,
                        model: entry.model,
                        backend: ProviderBackend::Executable(ExecutableProvider {
                            executable,
                            args: entry.args,
                        }),
                    },
                );
            }
        }

        let default_env = env::var("SOURCENERVE_EMBEDDING_DEFAULT_PROVIDER").ok();
        if providers.is_empty() {
            if default_env.is_some() {
                return Err(AppError::InvalidRequest(
                    "SOURCENERVE_EMBEDDING_DEFAULT_PROVIDER requires at least one configured managed embedding provider"
                        .into(),
                ));
            }
            return Ok(None);
        }

        let default_provider = if let Some(value) = default_env {
            validate_provider_id(&value)?;
            if !providers.contains_key(&value) {
                return Err(AppError::InvalidRequest(format!(
                    "default managed embedding provider `{value}` is not configured"
                )));
            }
            value
        } else if providers.contains_key(OPENAI_PROVIDER_ID) {
            OPENAI_PROVIDER_ID.to_string()
        } else if providers.len() == 1 {
            providers.keys().next().cloned().unwrap()
        } else {
            return Err(AppError::InvalidRequest(
                "multiple managed embedding providers require SOURCENERVE_EMBEDDING_DEFAULT_PROVIDER"
                    .into(),
            ));
        };

        Ok(Some(Self {
            providers,
            default_provider,
        }))
    }
}

pub fn install_runtime(runtime: Option<RuntimeConfig>) -> AppResult<()> {
    RUNTIME.set(runtime).map_err(|_| {
        AppError::Internal(anyhow::anyhow!(
            "managed embedding provider registry was configured more than once"
        ))
    })
}

fn runtime() -> AppResult<&'static RuntimeConfig> {
    RUNTIME
        .get()
        .and_then(|runtime| runtime.as_ref())
        .ok_or_else(|| {
            AppError::InvalidRequest(
                "managed embeddings are disabled; configure an embedding provider".into(),
            )
        })
}

fn provider_by_id(provider_id: Option<&str>) -> AppResult<&'static EmbeddingProvider> {
    let runtime = runtime()?;
    let id = provider_id.unwrap_or(&runtime.default_provider);
    validate_provider_id(id)?;
    runtime.providers.get(id).ok_or_else(|| {
        AppError::InvalidRequest(format!(
            "managed embedding provider `{id}` is not configured"
        ))
    })
}

pub fn status() -> ProviderRegistryStatus {
    let Some(Some(runtime)) = RUNTIME.get() else {
        return ProviderRegistryStatus {
            configured: false,
            default_provider: None,
            providers: Vec::new(),
        };
    };
    ProviderRegistryStatus {
        configured: true,
        default_provider: Some(runtime.default_provider.clone()),
        providers: runtime
            .providers
            .values()
            .map(|provider| ProviderStatusItem {
                id: provider.id.clone(),
                model: provider.model.clone(),
                kind: match provider.backend {
                    ProviderBackend::OpenAi => "openai",
                    ProviderBackend::Executable(_) => "executable",
                },
                is_default: provider.id == runtime.default_provider,
            })
            .collect(),
    }
}

pub async fn preflight(runtime: Option<&RuntimeConfig>) -> AppResult<()> {
    let Some(runtime) = runtime else {
        return Ok(());
    };
    for provider in runtime.providers.values() {
        if let ProviderBackend::Executable(executable) = &provider.backend {
            let metadata = tokio::fs::metadata(&executable.executable)
                .await
                .map_err(|_| {
                    AppError::InvalidRequest(format!(
                        "startup preflight failed: executable embedding provider `{}` is unavailable",
                        provider.id
                    ))
                })?;
            if !metadata.is_file() {
                return Err(AppError::InvalidRequest(format!(
                    "startup preflight failed: executable embedding provider `{}` is not a file",
                    provider.id
                )));
            }
        }
    }
    Ok(())
}

impl EmbeddingProvider {
    fn embed<'a>(&'a self, inputs: &'a [String]) -> EmbedFuture<'a> {
        Box::pin(async move {
            match &self.backend {
                ProviderBackend::OpenAi => Err(AppError::Internal(anyhow::anyhow!(
                    "OpenAI batch embedding is delegated to the compatibility runtime"
                ))),
                ProviderBackend::Executable(executable) => {
                    request_executable_embeddings(self, executable, inputs).await
                }
            }
        })
    }
}

async fn current_index_state(state: &AppState, workspace: &str) -> AppResult<(String, i64)> {
    let row: (Option<String>, i64) =
        sqlx::query_as("SELECT indexed_head, graph_version FROM workspaces WHERE id=?1")
            .bind(workspace)
            .fetch_one(&state.db)
            .await?;
    let head = row
        .0
        .ok_or_else(|| AppError::InvalidRequest("workspace has not been indexed yet".into()))?;
    Ok((head, row.1))
}

async fn require_clean_indexed_state(
    state: &AppState,
    workspace: &str,
) -> AppResult<(String, i64)> {
    let configured = state.workspaces.get(workspace)?;
    let actual_head = git::head(&configured.root).await?;
    if !git::status(&configured.root).await?.is_empty() {
        return Err(AppError::InvalidRequest(
            "managed semantic indexing requires a clean working tree".into(),
        ));
    }
    let (indexed_head, graph_version) = current_index_state(state, workspace).await?;
    if actual_head != indexed_head {
        return Err(AppError::InvalidRequest(format!(
            "managed semantic indexing requires repository intelligence at current HEAD: indexed {indexed_head}, current {actual_head}"
        )));
    }
    Ok((indexed_head, graph_version))
}

fn chunks_for_file(path: &str, sha256: &str, content: &str) -> Vec<PlannedChunk> {
    let mut chunks = Vec::new();
    let mut start_line = 0usize;
    let mut end_line = 0usize;
    let mut selected = Vec::<&str>::new();
    let mut selected_bytes = 0usize;

    let flush = |chunks: &mut Vec<PlannedChunk>,
                 selected: &mut Vec<&str>,
                 selected_bytes: &mut usize,
                 start_line: &mut usize,
                 end_line: &mut usize| {
        if selected.is_empty() {
            return;
        }
        let text = selected.join("\n");
        if !text.trim().is_empty() {
            chunks.push(PlannedChunk {
                path: path.to_string(),
                start_line: *start_line,
                end_line: *end_line,
                file_sha256: sha256.to_string(),
                text,
            });
        }
        selected.clear();
        *selected_bytes = 0;
        *start_line = 0;
        *end_line = 0;
    };

    for (index, line) in content.lines().enumerate() {
        let line_number = index + 1;
        if line.len() > MAX_SINGLE_LINE_BYTES {
            flush(
                &mut chunks,
                &mut selected,
                &mut selected_bytes,
                &mut start_line,
                &mut end_line,
            );
            continue;
        }
        let additional = line.len() + usize::from(!selected.is_empty());
        if !selected.is_empty()
            && (selected.len() >= MAX_CHUNK_LINES
                || selected_bytes + additional > TARGET_CHUNK_BYTES)
        {
            flush(
                &mut chunks,
                &mut selected,
                &mut selected_bytes,
                &mut start_line,
                &mut end_line,
            );
        }
        if selected.is_empty() {
            start_line = line_number;
        }
        selected.push(line);
        selected_bytes += line.len() + usize::from(selected.len() > 1);
        end_line = line_number;
    }
    flush(
        &mut chunks,
        &mut selected,
        &mut selected_bytes,
        &mut start_line,
        &mut end_line,
    );
    chunks
}

async fn plan_chunks(
    state: &AppState,
    workspace: &str,
    max_chunks: usize,
) -> AppResult<Vec<PlannedChunk>> {
    if !(1..=MAX_INDEX_CHUNKS).contains(&max_chunks) {
        return Err(AppError::InvalidRequest(format!(
            "max_chunks must be between 1 and {MAX_INDEX_CHUNKS}"
        )));
    }
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT path, content_hash, content FROM files \
         WHERE workspace_id=?1 AND content IS NOT NULL ORDER BY path",
    )
    .bind(workspace)
    .fetch_all(&state.db)
    .await?;
    let mut planned = Vec::new();
    let mut total_bytes = 0usize;
    'files: for (path, sha256, content) in rows {
        for chunk in chunks_for_file(&path, &sha256, &content) {
            if planned.len() >= max_chunks {
                break 'files;
            }
            if total_bytes + chunk.text.len() > MAX_TOTAL_SOURCE_BYTES {
                break 'files;
            }
            total_bytes += chunk.text.len();
            planned.push(chunk);
        }
    }
    if planned.is_empty() {
        return Err(AppError::InvalidRequest(
            "managed semantic indexing found no eligible indexed UTF-8 source chunks".into(),
        ));
    }
    Ok(planned)
}

fn normalize_vectors(data: Vec<EmbeddingDatum>, expected: usize) -> AppResult<Vec<Vec<f32>>> {
    if data.len() != expected {
        return Err(AppError::Command(format!(
            "embedding provider returned {} vectors for {expected} inputs",
            data.len()
        )));
    }
    let mut seen = BTreeSet::new();
    let mut ordered = vec![None; expected];
    let mut dimension = None;
    for item in data {
        if item.index >= expected || !seen.insert(item.index) {
            return Err(AppError::Command(
                "embedding provider returned duplicate or out-of-range vector indexes".into(),
            ));
        }
        if item.embedding.is_empty() || item.embedding.len() > MAX_VECTOR_DIMENSION {
            return Err(AppError::Command(
                "embedding provider returned an unsupported vector dimension".into(),
            ));
        }
        if dimension.is_some_and(|value| value != item.embedding.len()) {
            return Err(AppError::Command(
                "embedding provider returned inconsistent vector dimensions".into(),
            ));
        }
        let mut norm = 0.0_f64;
        for value in &item.embedding {
            if !value.is_finite() {
                return Err(AppError::Command(
                    "embedding provider returned non-finite vector values".into(),
                ));
            }
            let value = f64::from(*value);
            norm += value * value;
        }
        if !norm.is_finite() || norm <= f64::EPSILON {
            return Err(AppError::Command(
                "embedding provider returned a zero or invalid vector".into(),
            ));
        }
        ordered[item.index] = Some(item.embedding);
    }
    ordered
        .into_iter()
        .map(|value| {
            value.ok_or_else(|| {
                AppError::Command("embedding provider omitted an expected vector index".into())
            })
        })
        .collect()
}

async fn request_executable_embeddings(
    provider: &EmbeddingProvider,
    executable: &ExecutableProvider,
    inputs: &[String],
) -> AppResult<Vec<Vec<f32>>> {
    if inputs.is_empty() || inputs.len() > EMBEDDING_BATCH_SIZE {
        return Err(AppError::InvalidRequest(format!(
            "embedding provider batch must contain 1-{EMBEDDING_BATCH_SIZE} inputs"
        )));
    }
    let body = serde_json::to_vec(&serde_json::json!({
        "model": provider.model,
        "input": inputs,
    }))
    .map_err(anyhow::Error::from)?;

    let mut command = Command::new(&executable.executable);
    command
        .args(&executable.args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", "/nonexistent")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| {
        AppError::Command(format!(
            "failed to start managed embedding provider `{}`",
            provider.id
        ))
    })?;
    let mut stdin = child.stdin.take().ok_or_else(|| {
        AppError::Internal(anyhow::anyhow!(
            "managed embedding provider stdin was unavailable"
        ))
    })?;
    stdin.write_all(&body).await?;
    drop(stdin);
    let stdout = child.stdout.take().ok_or_else(|| {
        AppError::Internal(anyhow::anyhow!(
            "managed embedding provider stdout was unavailable"
        ))
    })?;
    let mut stdout = stdout.take((MAX_PROVIDER_RESPONSE_BYTES + 1) as u64);
    let mut response = Vec::new();

    let result = timeout(Duration::from_secs(PROVIDER_TIMEOUT_SECS), async {
        let read = stdout.read_to_end(&mut response);
        let (status, read_result) = tokio::join!(child.wait(), read);
        read_result?;
        Ok::<_, std::io::Error>(status?)
    })
    .await;
    let status = match result {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => {
            return Err(AppError::Command(
                "managed embedding provider execution failed".into(),
            ));
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(AppError::Command(
                "managed embedding provider exceeded the configured timeout".into(),
            ));
        }
    };
    if !status.success() {
        return Err(AppError::Command(format!(
            "managed embedding provider `{}` exited unsuccessfully",
            provider.id
        )));
    }
    if response.len() > MAX_PROVIDER_RESPONSE_BYTES {
        return Err(AppError::Command(
            "managed embedding provider response exceeded the configured limit".into(),
        ));
    }
    let response: EmbeddingResponse = serde_json::from_slice(&response).map_err(|_| {
        AppError::Command("managed embedding provider returned invalid JSON".into())
    })?;
    normalize_vectors(response.data, inputs.len())
}

async fn existing_replay(
    state: &AppState,
    provider: &EmbeddingProvider,
    request: &SemanticProviderIndexRequest,
    head: &str,
    graph_version: i64,
    planned: &[PlannedChunk],
) -> AppResult<Option<SemanticImportResult>> {
    let row = sqlx::query_as::<_, (String, String, String, i64, String, i64, String, i64, i64)>(
        "SELECT id, provider, model, dimension, git_head, graph_version, status, created_at, activated_at \
         FROM semantic_runs WHERE workspace_id=?1 AND client_run_id=?2",
    )
    .bind(&request.workspace)
    .bind(&request.client_run_id)
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let existing = ExistingRunRow {
        id: row.0,
        provider: row.1,
        model: row.2,
        dimension: row.3,
        git_head: row.4,
        graph_version: row.5,
        status: row.6,
        created_at: row.7,
        activated_at: row.8,
    };
    if existing.provider != provider.id
        || existing.model != provider.model
        || existing.git_head != head
        || existing.graph_version != graph_version
    {
        return Err(AppError::InvalidRequest(
            "client_run_id already exists for a different provider/model/repository state".into(),
        ));
    }
    let stored: Vec<(String, i64, i64, String)> = sqlx::query_as(
        "SELECT path, start_line, end_line, file_sha256 FROM semantic_chunks \
         WHERE run_id=?1 ORDER BY path, start_line, end_line",
    )
    .bind(&existing.id)
    .fetch_all(&state.db)
    .await?;
    if stored.len() != planned.len()
        || stored.iter().zip(planned).any(|(stored, planned)| {
            stored.0 != planned.path
                || usize::try_from(stored.1).ok() != Some(planned.start_line)
                || usize::try_from(stored.2).ok() != Some(planned.end_line)
                || stored.3 != planned.file_sha256
        })
    {
        return Err(AppError::InvalidRequest(
            "client_run_id already exists with a different managed chunk plan".into(),
        ));
    }
    let dimension = usize::try_from(existing.dimension)
        .map_err(|_| AppError::Internal(anyhow::anyhow!("stored semantic dimension is invalid")))?;
    Ok(Some(SemanticImportResult {
        run: SemanticRunView {
            id: existing.id,
            workspace: request.workspace.clone(),
            client_run_id: request.client_run_id.clone(),
            provider: existing.provider,
            model: existing.model,
            dimension,
            git_head: existing.git_head,
            graph_version: existing.graph_version,
            status: existing.status,
            created_at: existing.created_at,
            activated_at: existing.activated_at,
        },
        imported_chunks: stored.len(),
        replayed: true,
    }))
}

async fn current_run(
    state: &AppState,
    provider: &EmbeddingProvider,
    workspace: &str,
) -> AppResult<SemanticRunView> {
    state.workspaces.get(workspace)?;
    let (head, graph_version) = current_index_state(state, workspace).await?;
    let row = sqlx::query_as::<_, (String, String, String, String, i64, String, i64, String, i64, i64)>(
        "SELECT id, client_run_id, provider, model, dimension, git_head, graph_version, status, created_at, activated_at \
         FROM semantic_runs \
         WHERE workspace_id=?1 AND status='active' AND git_head=?2 AND graph_version=?3 \
         ORDER BY activated_at DESC, id DESC LIMIT 1",
    )
    .bind(workspace)
    .bind(&head)
    .bind(graph_version)
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else {
        return Err(AppError::InvalidRequest(
            "no current semantic run exists; run semantic_provider_index first".into(),
        ));
    };
    if row.2 != provider.id || row.3 != provider.model {
        return Err(AppError::InvalidRequest(format!(
            "current semantic run does not match selected managed embedding provider `{}`",
            provider.id
        )));
    }
    let dimension = usize::try_from(row.4)
        .map_err(|_| AppError::Internal(anyhow::anyhow!("stored semantic dimension is invalid")))?;
    Ok(SemanticRunView {
        id: row.0,
        workspace: workspace.to_string(),
        client_run_id: row.1,
        provider: row.2,
        model: row.3,
        dimension,
        git_head: row.5,
        graph_version: row.6,
        status: row.7,
        created_at: row.8,
        activated_at: row.9,
    })
}

async fn active_provider_identity(
    state: &AppState,
    workspace: &str,
) -> AppResult<(String, String)> {
    state.workspaces.get(workspace)?;
    let (head, graph_version) = current_index_state(state, workspace).await?;
    sqlx::query_as::<_, (String, String)>(
        "SELECT provider, model FROM semantic_runs \
         WHERE workspace_id=?1 AND status='active' AND git_head=?2 AND graph_version=?3 \
         ORDER BY activated_at DESC, id DESC LIMIT 1",
    )
    .bind(workspace)
    .bind(head)
    .bind(graph_version)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::InvalidRequest("no current semantic run exists".into()))
}

async fn embed_query_with_provider(
    state: &AppState,
    provider: &EmbeddingProvider,
    workspace: &str,
    query: &str,
) -> AppResult<Vec<f32>> {
    validate_query(query)?;
    match provider.backend {
        ProviderBackend::OpenAi => {
            return embedding_provider::embed_query_vector(state, workspace, query).await;
        }
        ProviderBackend::Executable(_) => {}
    }
    let before = current_run(state, provider, workspace).await?;
    let mut vectors = provider.embed(&[query.to_string()]).await?;
    let vector = vectors.pop().ok_or_else(|| {
        AppError::Internal(anyhow::anyhow!(
            "managed embedding provider returned no query vector"
        ))
    })?;
    if vector.len() != before.dimension {
        return Err(AppError::Command(format!(
            "query vector dimension mismatch: current run={}, provider={}",
            before.dimension,
            vector.len()
        )));
    }
    let after = current_run(state, provider, workspace).await?;
    if before.id != after.id {
        return Err(AppError::InvalidRequest(
            "semantic run changed while embedding the query; retry against the current run".into(),
        ));
    }
    Ok(vector)
}

pub async fn index(
    state: &AppState,
    request: SemanticProviderIndexRequest,
) -> AppResult<SemanticImportResult> {
    let provider = provider_by_id(request.provider_id.as_deref())?;
    if matches!(provider.backend, ProviderBackend::OpenAi) {
        return embedding_provider::index(
            state,
            embedding_provider::SemanticProviderIndexRequest {
                workspace: request.workspace,
                client_run_id: request.client_run_id,
                max_chunks: request.max_chunks,
            },
        )
        .await;
    }

    validate_client_run_id(&request.client_run_id)?;
    let (head, graph_version) = require_clean_indexed_state(state, &request.workspace).await?;
    let planned = plan_chunks(state, &request.workspace, request.max_chunks).await?;
    if let Some(existing) =
        existing_replay(state, provider, &request, &head, graph_version, &planned).await?
    {
        return Ok(existing);
    }

    let mut vectors = Vec::with_capacity(planned.len());
    for batch in planned.chunks(EMBEDDING_BATCH_SIZE) {
        let inputs = batch
            .iter()
            .map(|chunk| chunk.text.clone())
            .collect::<Vec<_>>();
        vectors.extend(provider.embed(&inputs).await?);
    }
    let dimension = vectors
        .first()
        .map(Vec::len)
        .ok_or_else(|| AppError::Command("embedding provider returned no vectors".into()))?;
    if vectors.iter().any(|vector| vector.len() != dimension) {
        return Err(AppError::Command(
            "embedding provider returned inconsistent vector dimensions".into(),
        ));
    }
    let chunks = planned
        .into_iter()
        .zip(vectors)
        .map(|(planned, vector)| SemanticChunkImport {
            path: planned.path,
            start_line: planned.start_line,
            end_line: planned.end_line,
            file_sha256: planned.file_sha256,
            vector,
        })
        .collect();
    semantic::import(
        state,
        SemanticImportRequest {
            workspace: request.workspace,
            client_run_id: request.client_run_id,
            provider: provider.id.clone(),
            model: provider.model.clone(),
            dimension,
            chunks,
        },
    )
    .await
}

pub async fn search_text(
    state: &AppState,
    request: SemanticSearchTextRequest,
) -> AppResult<SemanticSearchResult> {
    let provider = provider_by_id(request.provider_id.as_deref())?;
    if matches!(provider.backend, ProviderBackend::OpenAi) {
        return embedding_provider::search_text(
            state,
            embedding_provider::SemanticSearchTextRequest {
                workspace: request.workspace,
                query: request.query,
                limit: request.limit,
            },
        )
        .await;
    }
    if !(1..=MAX_SEARCH_LIMIT).contains(&request.limit) {
        return Err(AppError::InvalidRequest(format!(
            "limit must be between 1 and {MAX_SEARCH_LIMIT}"
        )));
    }
    let vector =
        embed_query_with_provider(state, provider, &request.workspace, &request.query).await?;
    semantic::search(
        state,
        SemanticSearchRequest {
            workspace: request.workspace,
            query_vector: vector,
            limit: request.limit,
        },
    )
    .await
}

pub async fn embed_query_vector(
    state: &AppState,
    workspace: &str,
    query: &str,
) -> AppResult<Vec<f32>> {
    let (provider_id, model) = active_provider_identity(state, workspace).await?;
    let provider = provider_by_id(Some(&provider_id))?;
    if provider.model != model {
        return Err(AppError::InvalidRequest(format!(
            "current semantic run model does not match configured provider `{provider_id}`"
        )));
    }
    embed_query_with_provider(state, provider, workspace, query).await
}

#[cfg(test)]
mod tests {
    use super::{
        EmbeddingDatum, MAX_SINGLE_LINE_BYTES, chunks_for_file, normalize_vectors,
        parse_secondary_providers, validate_provider_id,
    };

    #[test]
    fn secondary_provider_config_is_bounded_and_strict() {
        let entries = parse_secondary_providers(
            r#"[{"id":"local","kind":"executable","model":"fixture-3","executable":"/usr/local/bin/embed","args":["--json"]}]"#,
        )
        .expect("provider config");
        assert_eq!(entries.len(), 1);
        assert!(validate_provider_id("local-1").is_ok());
        assert!(validate_provider_id("bad provider").is_err());
        assert!(
            parse_secondary_providers(
                r#"[{"id":"x","kind":"http","model":"m","executable":"/bin/x"}]"#
            )
            .is_ok()
        );
    }

    #[test]
    fn chunk_planner_is_stable() {
        let content = (1..=170)
            .map(|index| format!("line-{index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let chunks = chunks_for_file("src/lib.rs", "abc", &content);
        assert_eq!(chunks.len(), 3);
        assert_eq!((chunks[0].start_line, chunks[0].end_line), (1, 80));
        assert_eq!((chunks[2].start_line, chunks[2].end_line), (161, 170));
    }

    #[test]
    fn chunk_planner_skips_pathological_lines() {
        let huge = "x".repeat(MAX_SINGLE_LINE_BYTES + 1);
        let chunks = chunks_for_file("src/lib.rs", "abc", &format!("alpha\n{huge}\nomega"));
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].text, "alpha");
        assert_eq!(chunks[1].text, "omega");
    }

    #[test]
    fn executable_provider_vectors_are_index_normalized() {
        let vectors = normalize_vectors(
            vec![
                EmbeddingDatum {
                    index: 1,
                    embedding: vec![0.0, 1.0],
                },
                EmbeddingDatum {
                    index: 0,
                    embedding: vec![1.0, 0.0],
                },
            ],
            2,
        )
        .expect("vectors");
        assert_eq!(vectors, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
    }
}
