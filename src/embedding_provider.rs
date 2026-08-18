use std::{
    collections::BTreeSet,
    env,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::OnceLock,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncWriteExt, process::Command};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    git,
    semantic::{
        self, SemanticChunkImport, SemanticImportRequest, SemanticImportResult, SemanticRunView,
        SemanticSearchRequest, SemanticSearchResult,
    },
    service::AppState,
};

const PROVIDER: &str = "openai";
const OFFICIAL_EMBEDDING_URL: &str = "https://api.openai.com/v1/embeddings";
const DEFAULT_MODEL: &str = "text-embedding-3-small";
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
const MAX_VECTOR_DIMENSION: usize = 4096;
const MAX_SEARCH_LIMIT: usize = 100;

static RUNTIME: OnceLock<Option<RuntimeConfig>> = OnceLock::new();

#[derive(Clone)]
pub struct RuntimeConfig {
    api_key: String,
    model: String,
    endpoint: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SemanticProviderIndexRequest {
    pub workspace: String,
    pub client_run_id: String,
    #[serde(default = "default_max_chunks")]
    pub max_chunks: usize,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SemanticSearchTextRequest {
    pub workspace: String,
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
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

struct TempBody {
    path: PathBuf,
}

impl Drop for TempBody {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn default_max_chunks() -> usize {
    DEFAULT_MAX_CHUNKS
}

fn default_limit() -> usize {
    20
}

fn env_bool(name: &str) -> AppResult<bool> {
    let Ok(value) = env::var(name) else {
        return Ok(false);
    };
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(AppError::InvalidRequest(format!(
            "{name} must be one of true/false, 1/0, yes/no, or on/off"
        ))),
    }
}

fn validate_api_key(value: &str) -> AppResult<()> {
    if value.len() < 20
        || value.len() > 1024
        || value.trim() != value
        || !value.is_ascii()
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(AppError::InvalidRequest(
            "SOURCENERVE_OPENAI_API_KEY must be 20-1024 non-whitespace ASCII bytes".into(),
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
            "SOURCENERVE_OPENAI_EMBEDDING_MODEL must be 1-128 ASCII model-id characters".into(),
        ));
    }
    Ok(())
}

fn validate_loopback_override(value: &str, allow: bool) -> AppResult<()> {
    if !allow {
        return Err(AppError::InvalidRequest(
            "SOURCENERVE_OPENAI_EMBEDDING_URL is test-only and requires SOURCENERVE_OPENAI_EMBEDDING_ALLOW_INSECURE_LOOPBACK=true"
                .into(),
        ));
    }
    if value.is_empty()
        || value.len() > 2048
        || !value.is_ascii()
        || value.bytes().any(|byte| byte.is_ascii_control())
        || value.chars().any(char::is_whitespace)
        || value.contains('#')
        || value.contains('@')
    {
        return Err(AppError::InvalidRequest(
            "test embedding URL must be a bounded ASCII loopback URL without credentials or fragments"
                .into(),
        ));
    }
    let rest = value.strip_prefix("http://127.0.0.1:").ok_or_else(|| {
        AppError::InvalidRequest(
            "test embedding URL must use a literal http://127.0.0.1:<port> endpoint".into(),
        )
    })?;
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let port = &rest[..authority_end];
    let port = port
        .parse::<u16>()
        .map_err(|_| AppError::InvalidRequest("test embedding URL port is invalid".into()))?;
    if port == 0 {
        return Err(AppError::InvalidRequest(
            "test embedding URL port must be non-zero".into(),
        ));
    }
    Ok(())
}

impl RuntimeConfig {
    pub fn from_env() -> AppResult<Option<Self>> {
        let api_key = env::var("SOURCENERVE_OPENAI_API_KEY").ok();
        let model_env = env::var("SOURCENERVE_OPENAI_EMBEDDING_MODEL").ok();
        let endpoint_env = env::var("SOURCENERVE_OPENAI_EMBEDDING_URL").ok();
        let allow_loopback = env_bool("SOURCENERVE_OPENAI_EMBEDDING_ALLOW_INSECURE_LOOPBACK")?;

        let Some(api_key) = api_key else {
            if model_env.is_some() || endpoint_env.is_some() || allow_loopback {
                return Err(AppError::InvalidRequest(
                    "managed embeddings configuration requires SOURCENERVE_OPENAI_API_KEY".into(),
                ));
            }
            return Ok(None);
        };
        validate_api_key(&api_key)?;
        let model = model_env.unwrap_or_else(|| DEFAULT_MODEL.to_string());
        validate_model(&model)?;
        let endpoint = if let Some(value) = endpoint_env {
            validate_loopback_override(&value, allow_loopback)?;
            value
        } else {
            OFFICIAL_EMBEDDING_URL.to_string()
        };
        Ok(Some(Self {
            api_key,
            model,
            endpoint,
        }))
    }
}

pub fn install_runtime(runtime: Option<RuntimeConfig>) -> AppResult<()> {
    RUNTIME.set(runtime).map_err(|_| {
        AppError::Internal(anyhow::anyhow!(
            "managed embedding runtime was configured more than once"
        ))
    })
}

pub fn is_configured() -> bool {
    RUNTIME.get().and_then(|runtime| runtime.as_ref()).is_some()
}

fn configured_runtime() -> AppResult<&'static RuntimeConfig> {
    RUNTIME
        .get()
        .and_then(|runtime| runtime.as_ref())
        .ok_or_else(|| {
            AppError::InvalidRequest(
                "managed embeddings are disabled; configure SOURCENERVE_OPENAI_API_KEY".into(),
            )
        })
}

pub async fn preflight(runtime: Option<&RuntimeConfig>) -> AppResult<()> {
    if runtime.is_none() {
        return Ok(());
    }
    let status = Command::new("curl")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(_) | Err(_) => Err(AppError::InvalidRequest(
            "startup preflight failed: managed embeddings require curl".into(),
        )),
    }
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

fn temp_body(bytes: &[u8]) -> AppResult<TempBody> {
    let path = env::temp_dir().join(format!(
        ".sourcenerve-embedding-request-{}.json",
        Uuid::new_v4()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    file.write_all(bytes)?;
    file.flush()?;
    Ok(TempBody { path })
}

fn split_body_and_status(stdout: &[u8]) -> AppResult<(&[u8], u16)> {
    let Some(position) = stdout.iter().rposition(|byte| *byte == b'\n') else {
        return Err(AppError::Command(
            "embedding provider returned an invalid HTTP status trailer".into(),
        ));
    };
    let body = &stdout[..position];
    let status = std::str::from_utf8(&stdout[position + 1..])
        .map_err(|_| AppError::Command("embedding provider returned invalid status text".into()))?
        .trim()
        .parse::<u16>()
        .map_err(|_| AppError::Command("embedding provider returned invalid HTTP status".into()))?;
    Ok((body, status))
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
        dimension = Some(item.embedding.len());
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

async fn request_embeddings(
    runtime: &RuntimeConfig,
    inputs: &[String],
) -> AppResult<Vec<Vec<f32>>> {
    if inputs.is_empty() || inputs.len() > EMBEDDING_BATCH_SIZE {
        return Err(AppError::InvalidRequest(format!(
            "embedding provider batch must contain 1-{EMBEDDING_BATCH_SIZE} inputs"
        )));
    }
    let body = serde_json::to_vec(&serde_json::json!({
        "model": runtime.model,
        "input": inputs,
    }))
    .map_err(anyhow::Error::from)?;
    let temp = temp_body(&body)?;

    let mut command = Command::new("curl");
    command
        .arg("--silent")
        .arg("--show-error")
        .arg("--request")
        .arg("POST")
        .arg("--connect-timeout")
        .arg("5")
        .arg("--max-time")
        .arg("30")
        .arg("--max-filesize")
        .arg(MAX_PROVIDER_RESPONSE_BYTES.to_string())
        .arg("--header")
        .arg("@-")
        .arg("--data-binary")
        .arg(format!("@{}", temp.path.display()))
        .arg("--write-out")
        .arg("\n%{http_code}")
        .arg(&runtime.endpoint)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| AppError::Command("failed to start embedding provider transport".into()))?;
    let mut stdin = child.stdin.take().ok_or_else(|| {
        AppError::Internal(anyhow::anyhow!("embedding provider stdin was unavailable"))
    })?;
    let headers = format!(
        "Authorization: Bearer {}\nContent-Type: application/json\n",
        runtime.api_key
    );
    stdin.write_all(headers.as_bytes()).await?;
    drop(stdin);
    let output = child.wait_with_output().await?;
    if !output.status.success() {
        return Err(AppError::Command(
            "embedding provider transport failed or exceeded configured limits".into(),
        ));
    }
    if output.stdout.len() > MAX_PROVIDER_RESPONSE_BYTES + 16 {
        return Err(AppError::Command(
            "embedding provider response exceeded the configured limit".into(),
        ));
    }
    let (response_body, status) = split_body_and_status(&output.stdout)?;
    if !(200..300).contains(&status) {
        return Err(AppError::Command(format!(
            "embedding provider returned HTTP {status}"
        )));
    }
    let response: EmbeddingResponse = serde_json::from_slice(response_body)
        .map_err(|_| AppError::Command("embedding provider returned invalid JSON".into()))?;
    normalize_vectors(response.data, inputs.len())
}

async fn existing_replay(
    state: &AppState,
    runtime: &RuntimeConfig,
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
    if existing.provider != PROVIDER
        || existing.model != runtime.model
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

async fn current_managed_run(
    state: &AppState,
    runtime: &RuntimeConfig,
    workspace: &str,
) -> AppResult<SemanticRunView> {
    state.workspaces.get(workspace)?;
    let (head, graph_version) = current_index_state(state, workspace).await?;
    let row = sqlx::query_as::<_, (String, String, String, i64, String, i64, String, i64, i64)>(
        "SELECT id, client_run_id, provider, dimension, git_head, graph_version, status, created_at, activated_at \
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
    if row.2 != PROVIDER {
        return Err(AppError::InvalidRequest(
            "current semantic run was not generated by the managed OpenAI provider".into(),
        ));
    }
    let model: String = sqlx::query_scalar("SELECT model FROM semantic_runs WHERE id=?1")
        .bind(&row.0)
        .fetch_one(&state.db)
        .await?;
    if model != runtime.model {
        return Err(AppError::InvalidRequest(
            "current semantic run model does not match the configured managed embedding model"
                .into(),
        ));
    }
    let dimension = usize::try_from(row.3)
        .map_err(|_| AppError::Internal(anyhow::anyhow!("stored semantic dimension is invalid")))?;
    Ok(SemanticRunView {
        id: row.0,
        workspace: workspace.to_string(),
        client_run_id: row.1,
        provider: row.2,
        model,
        dimension,
        git_head: row.4,
        graph_version: row.5,
        status: row.6,
        created_at: row.7,
        activated_at: row.8,
    })
}

async fn embed_query_with_runtime(
    state: &AppState,
    runtime: &RuntimeConfig,
    workspace: &str,
    query: &str,
) -> AppResult<Vec<f32>> {
    validate_query(query)?;
    let before = current_managed_run(state, runtime, workspace).await?;
    let mut vectors = request_embeddings(runtime, &[query.to_string()]).await?;
    let vector = vectors.pop().ok_or_else(|| {
        AppError::Internal(anyhow::anyhow!(
            "embedding provider returned no query vector"
        ))
    })?;
    if vector.len() != before.dimension {
        return Err(AppError::Command(format!(
            "query vector dimension mismatch: current run={}, provider={}",
            before.dimension,
            vector.len()
        )));
    }
    let after = current_managed_run(state, runtime, workspace).await?;
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
    let runtime = configured_runtime()?;
    validate_client_run_id(&request.client_run_id)?;
    let (head, graph_version) = require_clean_indexed_state(state, &request.workspace).await?;
    let planned = plan_chunks(state, &request.workspace, request.max_chunks).await?;
    if let Some(existing) =
        existing_replay(state, runtime, &request, &head, graph_version, &planned).await?
    {
        return Ok(existing);
    }

    let mut vectors = Vec::with_capacity(planned.len());
    for batch in planned.chunks(EMBEDDING_BATCH_SIZE) {
        let inputs = batch
            .iter()
            .map(|chunk| chunk.text.clone())
            .collect::<Vec<_>>();
        vectors.extend(request_embeddings(runtime, &inputs).await?);
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
            provider: PROVIDER.into(),
            model: runtime.model.clone(),
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
    let runtime = configured_runtime()?;
    if !(1..=MAX_SEARCH_LIMIT).contains(&request.limit) {
        return Err(AppError::InvalidRequest(format!(
            "limit must be between 1 and {MAX_SEARCH_LIMIT}"
        )));
    }
    let vector =
        embed_query_with_runtime(state, runtime, &request.workspace, &request.query).await?;
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
    let runtime = configured_runtime()?;
    embed_query_with_runtime(state, runtime, workspace, query).await
}

#[cfg(test)]
mod tests {
    use super::{
        EmbeddingDatum, MAX_SINGLE_LINE_BYTES, chunks_for_file, normalize_vectors,
        validate_loopback_override, validate_model, validate_query,
    };

    #[test]
    fn chunk_planner_is_stable_and_bounded_by_lines() {
        let content = (1..=170)
            .map(|index| format!("line-{index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let first = chunks_for_file("src/lib.rs", "abc", &content);
        let second = chunks_for_file("src/lib.rs", "abc", &content);
        assert_eq!(first.len(), 3);
        assert_eq!(first[0].start_line, 1);
        assert_eq!(first[0].end_line, 80);
        assert_eq!(first[1].start_line, 81);
        assert_eq!(first[1].end_line, 160);
        assert_eq!(first[2].start_line, 161);
        assert_eq!(first[2].end_line, 170);
        assert_eq!(
            first
                .iter()
                .map(|chunk| (&chunk.path, chunk.start_line, chunk.end_line, &chunk.text))
                .collect::<Vec<_>>(),
            second
                .iter()
                .map(|chunk| (&chunk.path, chunk.start_line, chunk.end_line, &chunk.text))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn chunk_planner_skips_pathological_single_lines() {
        let huge = "x".repeat(MAX_SINGLE_LINE_BYTES + 1);
        let content = format!("alpha\n{huge}\nomega");
        let chunks = chunks_for_file("src/lib.rs", "abc", &content);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].text, "alpha");
        assert_eq!(chunks[0].start_line, 1);
        assert_eq!(chunks[1].text, "omega");
        assert_eq!(chunks[1].start_line, 3);
    }

    #[test]
    fn provider_vector_indexes_are_normalized() {
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

    #[test]
    fn provider_vector_indexes_fail_closed() {
        let error = normalize_vectors(
            vec![
                EmbeddingDatum {
                    index: 0,
                    embedding: vec![1.0, 0.0],
                },
                EmbeddingDatum {
                    index: 0,
                    embedding: vec![0.0, 1.0],
                },
            ],
            2,
        )
        .expect_err("duplicate index must fail");
        assert!(error.to_string().contains("duplicate or out-of-range"));
    }

    #[test]
    fn managed_provider_inputs_are_bounded() {
        assert!(validate_model("text-embedding-3-small").is_ok());
        assert!(validate_model("bad model").is_err());
        assert!(validate_query("repository billing flow").is_ok());
        assert!(validate_query("").is_err());
        assert!(validate_loopback_override("http://127.0.0.1:7444/v1/embeddings", true).is_ok());
        assert!(validate_loopback_override("http://10.0.0.1:7444/v1/embeddings", true).is_err());
        assert!(validate_loopback_override("http://127.0.0.1:7444/v1/embeddings", false).is_err());
    }
}
