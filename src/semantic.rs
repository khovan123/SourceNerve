use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    git,
    service::AppState,
};

const MAX_DIMENSION: usize = 4096;
const MAX_CHUNKS: usize = 1024;
const MAX_LIMIT: usize = 100;
const MAX_KEY_BYTES: usize = 128;
const MAX_PROVIDER_BYTES: usize = 128;
const MAX_MODEL_BYTES: usize = 192;

type RunDbRow = (
    String,
    String,
    String,
    String,
    String,
    i64,
    String,
    i64,
    String,
    i64,
    i64,
);

type ExistingRunRow = (String, String);
type ChunkDbRow = (String, i64, i64, String, Vec<u8>, f64);

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SemanticChunkImport {
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub file_sha256: String,
    pub vector: Vec<f32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SemanticImportRequest {
    pub workspace: String,
    pub client_run_id: String,
    pub provider: String,
    pub model: String,
    pub dimension: usize,
    pub chunks: Vec<SemanticChunkImport>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SemanticRunView {
    pub id: String,
    pub workspace: String,
    pub client_run_id: String,
    pub provider: String,
    pub model: String,
    pub dimension: usize,
    pub git_head: String,
    pub graph_version: i64,
    pub status: String,
    pub created_at: i64,
    pub activated_at: i64,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct SemanticImportResult {
    pub run: SemanticRunView,
    pub imported_chunks: usize,
    pub replayed: bool,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SemanticSearchRequest {
    pub workspace: String,
    pub query_vector: Vec<f32>,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SemanticSearchHit {
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub score: f64,
    pub file_sha256: String,
    pub run_id: String,
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct SemanticSearchResult {
    pub run: Option<SemanticRunView>,
    pub hits: Vec<SemanticSearchHit>,
}

fn default_limit() -> usize {
    20
}

fn validate_client_run_id(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > MAX_KEY_BYTES
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

fn validate_label(value: &str, field: &str, max_bytes: usize) -> AppResult<()> {
    if value.trim().is_empty() || value.len() > max_bytes || value.chars().any(|ch| ch.is_control())
    {
        return Err(AppError::InvalidRequest(format!(
            "{field} must be non-empty, bounded UTF-8 without control characters"
        )));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> AppResult<()> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::InvalidRequest(
            "file_sha256 must be a 64-character hexadecimal SHA-256".into(),
        ));
    }
    Ok(())
}

fn validate_dimension(dimension: usize) -> AppResult<()> {
    if !(1..=MAX_DIMENSION).contains(&dimension) {
        return Err(AppError::InvalidRequest(format!(
            "dimension must be between 1 and {MAX_DIMENSION}"
        )));
    }
    Ok(())
}

fn vector_norm(vector: &[f32], expected_dimension: usize) -> AppResult<f64> {
    if vector.len() != expected_dimension {
        return Err(AppError::InvalidRequest(format!(
            "vector dimension mismatch: expected {expected_dimension}, got {}",
            vector.len()
        )));
    }
    let mut sum = 0.0_f64;
    for value in vector {
        if !value.is_finite() {
            return Err(AppError::InvalidRequest(
                "vectors must contain only finite numbers".into(),
            ));
        }
        let value = f64::from(*value);
        sum += value * value;
    }
    let norm = sum.sqrt();
    if !norm.is_finite() || norm <= f64::EPSILON {
        return Err(AppError::InvalidRequest(
            "vectors must have a non-zero finite norm".into(),
        ));
    }
    Ok(norm)
}

fn encode_vector(vector: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vector.len() * 4);
    for value in vector {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn decode_vector(bytes: &[u8], dimension: usize) -> AppResult<Vec<f32>> {
    if bytes.len() != dimension * 4 {
        return Err(AppError::Internal(anyhow::anyhow!(
            "stored semantic vector has invalid byte length"
        )));
    }
    let mut values = Vec::with_capacity(dimension);
    for chunk in bytes.chunks_exact(4) {
        values.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(values)
}

fn hash_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn request_fingerprint(
    req: &SemanticImportRequest,
    head: &str,
    graph_version: i64,
    chunks: &[SemanticChunkImport],
) -> String {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, req.workspace.as_bytes());
    hash_field(&mut hasher, req.client_run_id.as_bytes());
    hash_field(&mut hasher, req.provider.as_bytes());
    hash_field(&mut hasher, req.model.as_bytes());
    hasher.update((req.dimension as u64).to_le_bytes());
    hash_field(&mut hasher, head.as_bytes());
    hasher.update(graph_version.to_le_bytes());
    for chunk in chunks {
        hash_field(&mut hasher, chunk.path.as_bytes());
        hasher.update((chunk.start_line as u64).to_le_bytes());
        hasher.update((chunk.end_line as u64).to_le_bytes());
        hash_field(&mut hasher, chunk.file_sha256.as_bytes());
        for value in &chunk.vector {
            hasher.update(value.to_bits().to_le_bytes());
        }
    }
    hex::encode(hasher.finalize())
}

fn run_from_row(row: RunDbRow) -> AppResult<SemanticRunView> {
    let dimension = usize::try_from(row.5)
        .map_err(|_| AppError::Internal(anyhow::anyhow!("invalid semantic run dimension")))?;
    Ok(SemanticRunView {
        id: row.0,
        workspace: row.1,
        client_run_id: row.2,
        provider: row.3,
        model: row.4,
        dimension,
        git_head: row.6,
        graph_version: row.7,
        status: row.8,
        created_at: row.9,
        activated_at: row.10,
    })
}

async fn load_run(state: &AppState, run_id: &str) -> AppResult<SemanticRunView> {
    let row: RunDbRow = sqlx::query_as(
        "SELECT id, workspace_id, client_run_id, provider, model, dimension, git_head, graph_version, status, created_at, activated_at \
         FROM semantic_runs WHERE id=?1",
    )
    .bind(run_id)
    .fetch_one(&state.db)
    .await?;
    run_from_row(row)
}

async fn current_index_state(state: &AppState, workspace_id: &str) -> AppResult<(String, i64)> {
    let row: (Option<String>, i64) =
        sqlx::query_as("SELECT indexed_head, graph_version FROM workspaces WHERE id=?1")
            .bind(workspace_id)
            .fetch_one(&state.db)
            .await?;
    let head = row
        .0
        .ok_or_else(|| AppError::InvalidRequest("workspace has not been indexed yet".into()))?;
    Ok((head, row.1))
}

async fn current_run(state: &AppState, workspace_id: &str) -> AppResult<Option<SemanticRunView>> {
    let (indexed_head, graph_version) = current_index_state(state, workspace_id).await?;
    let row: Option<RunDbRow> = sqlx::query_as(
        "SELECT id, workspace_id, client_run_id, provider, model, dimension, git_head, graph_version, status, created_at, activated_at \
         FROM semantic_runs \
         WHERE workspace_id=?1 AND status='active' AND git_head=?2 AND graph_version=?3 \
         ORDER BY activated_at DESC, id DESC LIMIT 1",
    )
    .bind(workspace_id)
    .bind(indexed_head)
    .bind(graph_version)
    .fetch_optional(&state.db)
    .await?;
    row.map(run_from_row).transpose()
}

pub async fn import(
    state: &AppState,
    mut req: SemanticImportRequest,
) -> AppResult<SemanticImportResult> {
    state.workspaces.get(&req.workspace)?;
    validate_client_run_id(&req.client_run_id)?;
    validate_label(&req.provider, "provider", MAX_PROVIDER_BYTES)?;
    validate_label(&req.model, "model", MAX_MODEL_BYTES)?;
    validate_dimension(req.dimension)?;
    if req.chunks.is_empty() || req.chunks.len() > MAX_CHUNKS {
        return Err(AppError::InvalidRequest(format!(
            "chunks must contain between 1 and {MAX_CHUNKS} items"
        )));
    }

    req.chunks.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.start_line.cmp(&right.start_line))
            .then_with(|| left.end_line.cmp(&right.end_line))
    });
    for pair in req.chunks.windows(2) {
        if pair[0].path == pair[1].path
            && pair[0].start_line == pair[1].start_line
            && pair[0].end_line == pair[1].end_line
        {
            return Err(AppError::InvalidRequest(
                "semantic import contains duplicate chunk ranges".into(),
            ));
        }
    }

    let _guard = state.mutation_lock.lock().await;
    let workspace = state.workspaces.get(&req.workspace)?;
    let actual_head = git::head(&workspace.root).await?;
    if !git::status(&workspace.root).await?.is_empty() {
        return Err(AppError::InvalidRequest(
            "semantic import requires a clean working tree".into(),
        ));
    }
    let (indexed_head, graph_version) = current_index_state(state, &req.workspace).await?;
    if actual_head != indexed_head {
        return Err(AppError::InvalidRequest(format!(
            "semantic import requires repository intelligence at current HEAD: indexed {indexed_head}, current {actual_head}"
        )));
    }

    for chunk in &req.chunks {
        validate_sha256(&chunk.file_sha256)?;
        vector_norm(&chunk.vector, req.dimension)?;
        if chunk.start_line == 0 || chunk.end_line < chunk.start_line {
            return Err(AppError::InvalidRequest(
                "semantic chunk line range is invalid".into(),
            ));
        }
        state
            .workspaces
            .resolve_existing_file(&workspace, &chunk.path)?;
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT content_hash, content FROM files WHERE workspace_id=?1 AND path=?2",
        )
        .bind(&req.workspace)
        .bind(&chunk.path)
        .fetch_optional(&state.db)
        .await?;
        let Some((current_sha, content)) = row else {
            return Err(AppError::InvalidRequest(format!(
                "semantic chunk path is not indexed: {}",
                chunk.path
            )));
        };
        if current_sha != chunk.file_sha256 {
            return Err(AppError::FileChanged {
                path: chunk.path.clone(),
            });
        }
        let line_count = content
            .as_deref()
            .map(|value| value.lines().count())
            .unwrap_or(0);
        if line_count == 0 || chunk.end_line > line_count {
            return Err(AppError::InvalidRequest(format!(
                "semantic chunk range exceeds indexed file lines: {}:{}-{}",
                chunk.path, chunk.start_line, chunk.end_line
            )));
        }
    }

    let fingerprint = request_fingerprint(&req, &indexed_head, graph_version, &req.chunks);
    let existing: Option<ExistingRunRow> = sqlx::query_as(
        "SELECT id, request_fingerprint FROM semantic_runs WHERE workspace_id=?1 AND client_run_id=?2",
    )
    .bind(&req.workspace)
    .bind(&req.client_run_id)
    .fetch_optional(&state.db)
    .await?;
    if let Some((run_id, previous_fingerprint)) = existing {
        if previous_fingerprint != fingerprint {
            return Err(AppError::InvalidRequest(
                "client_run_id already exists with a different semantic import".into(),
            ));
        }
        let imported_chunks: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM semantic_chunks WHERE run_id=?1")
                .bind(&run_id)
                .fetch_one(&state.db)
                .await?;
        return Ok(SemanticImportResult {
            run: load_run(state, &run_id).await?,
            imported_chunks: imported_chunks.max(0) as usize,
            replayed: true,
        });
    }

    let run_id = Uuid::new_v4().to_string();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE semantic_runs SET status='superseded' WHERE workspace_id=?1 AND status='active'",
    )
    .bind(&req.workspace)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO semantic_runs(\
            id, workspace_id, client_run_id, provider, model, dimension, git_head, graph_version, request_fingerprint, status, created_at, activated_at\
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', unixepoch(), unixepoch())",
    )
    .bind(&run_id)
    .bind(&req.workspace)
    .bind(&req.client_run_id)
    .bind(&req.provider)
    .bind(&req.model)
    .bind(req.dimension as i64)
    .bind(&indexed_head)
    .bind(graph_version)
    .bind(&fingerprint)
    .execute(&mut *tx)
    .await?;

    for chunk in &req.chunks {
        let norm = vector_norm(&chunk.vector, req.dimension)?;
        sqlx::query(
            "INSERT INTO semantic_chunks(\
                run_id, workspace_id, path, start_line, end_line, file_sha256, vector, vector_norm, created_at\
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch())",
        )
        .bind(&run_id)
        .bind(&req.workspace)
        .bind(&chunk.path)
        .bind(chunk.start_line as i64)
        .bind(chunk.end_line as i64)
        .bind(&chunk.file_sha256)
        .bind(encode_vector(&chunk.vector))
        .bind(norm)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    Ok(SemanticImportResult {
        run: load_run(state, &run_id).await?,
        imported_chunks: req.chunks.len(),
        replayed: false,
    })
}

fn cosine_score(query: &[f32], query_norm: f64, stored: &[f32], stored_norm: f64) -> f64 {
    let dot = query
        .iter()
        .zip(stored)
        .map(|(left, right)| f64::from(*left) * f64::from(*right))
        .sum::<f64>();
    (dot / (query_norm * stored_norm)).clamp(-1.0, 1.0)
}

pub(crate) async fn search_indexed(
    state: &AppState,
    workspace_id: &str,
    query_vector: &[f32],
    limit: usize,
) -> AppResult<SemanticSearchResult> {
    state.workspaces.get(workspace_id)?;
    let Some(run) = current_run(state, workspace_id).await? else {
        return Ok(SemanticSearchResult {
            run: None,
            hits: Vec::new(),
        });
    };
    let query_norm = vector_norm(query_vector, run.dimension)?;
    let rows: Vec<ChunkDbRow> = sqlx::query_as(
        "SELECT c.path, c.start_line, c.end_line, c.file_sha256, c.vector, c.vector_norm \
         FROM semantic_chunks c \
         JOIN files f ON f.workspace_id=c.workspace_id AND f.path=c.path AND f.content_hash=c.file_sha256 \
         WHERE c.workspace_id=?1 AND c.run_id=?2 \
         ORDER BY c.path, c.start_line, c.end_line",
    )
    .bind(workspace_id)
    .bind(&run.id)
    .fetch_all(&state.db)
    .await?;

    let mut hits = Vec::with_capacity(rows.len());
    for (path, start_line, end_line, file_sha256, bytes, stored_norm) in rows {
        let stored = decode_vector(&bytes, run.dimension)?;
        let score = cosine_score(query_vector, query_norm, &stored, stored_norm);
        hits.push(SemanticSearchHit {
            path,
            start_line: usize::try_from(start_line).unwrap_or(1),
            end_line: usize::try_from(end_line).unwrap_or(1),
            score,
            file_sha256,
            run_id: run.id.clone(),
            provider: run.provider.clone(),
            model: run.model.clone(),
        });
    }
    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.start_line.cmp(&right.start_line))
            .then_with(|| left.end_line.cmp(&right.end_line))
    });
    hits.truncate(limit.clamp(1, MAX_LIMIT));
    Ok(SemanticSearchResult {
        run: Some(run),
        hits,
    })
}

pub async fn search(
    state: &AppState,
    req: SemanticSearchRequest,
) -> AppResult<SemanticSearchResult> {
    let workspace = state.workspaces.get(&req.workspace)?;
    let head = git::head(&workspace.root).await?;
    if !git::status(&workspace.root).await?.is_empty() {
        return Err(AppError::InvalidRequest(
            "semantic search requires a clean working tree".into(),
        ));
    }
    let (indexed_head, _) = current_index_state(state, &req.workspace).await?;
    if head != indexed_head {
        return Err(AppError::InvalidRequest(format!(
            "semantic search requires repository intelligence at current HEAD: indexed {indexed_head}, current {head}"
        )));
    }
    search_indexed(state, &req.workspace, &req.query_vector, req.limit).await
}

#[cfg(test)]
mod tests {
    use super::{cosine_score, decode_vector, encode_vector, vector_norm};

    #[test]
    fn vector_codec_round_trips_exact_bits() {
        let values = vec![0.25_f32, -1.5, 3.0];
        let decoded = decode_vector(&encode_vector(&values), values.len()).expect("decode");
        assert_eq!(
            decoded.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            values.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn cosine_score_orders_direction() {
        let query = vec![1.0_f32, 0.0];
        let same = vec![1.0_f32, 0.0];
        let orthogonal = vec![0.0_f32, 1.0];
        let query_norm = vector_norm(&query, 2).expect("query norm");
        assert!(
            cosine_score(
                &query,
                query_norm,
                &same,
                vector_norm(&same, 2).expect("same norm")
            ) > cosine_score(
                &query,
                query_norm,
                &orthogonal,
                vector_norm(&orthogonal, 2).expect("orthogonal norm")
            )
        );
    }

    #[test]
    fn rejects_non_finite_and_zero_vectors() {
        assert!(vector_norm(&[0.0, 0.0], 2).is_err());
        assert!(vector_norm(&[f32::NAN, 1.0], 2).is_err());
    }
}
