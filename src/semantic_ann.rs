use std::{collections::HashSet, env};

use hnsw_rs::prelude::{DistDot, Hnsw};
use schemars::JsonSchema;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    error::{AppError, AppResult},
    semantic::{self, SemanticRunView, SemanticSearchHit, SemanticSearchResult},
    service::AppState,
};

const DEFAULT_THRESHOLD: usize = 128;
const MIN_THRESHOLD: usize = 32;
const MAX_THRESHOLD: usize = 1024;
const MAX_LIMIT: usize = 100;
const MAX_CONNECTIONS: usize = 24;
const MAX_LAYERS: usize = 16;
const EF_CONSTRUCTION: usize = 200;
const MIN_CANDIDATES: usize = 64;
const CANDIDATE_MULTIPLIER: usize = 8;

type RunRow = (
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

type ChunkRow = (String, i64, i64, String, Vec<u8>, f64);

#[derive(Debug, Clone)]
struct AnnChunk {
    path: String,
    start_line: usize,
    end_line: usize,
    file_sha256: String,
    vector: Vec<f32>,
    norm: f64,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SemanticAnnStatus {
    pub workspace: String,
    pub mode: String,
    pub threshold: usize,
    pub eligible_chunks: usize,
    pub run_id: Option<String>,
    pub index_hash: Option<String>,
    pub snapshot_current: bool,
    pub algorithm: &'static str,
}

fn threshold() -> AppResult<usize> {
    let Ok(raw) = env::var("SOURCENERVE_SEMANTIC_ANN_THRESHOLD") else {
        return Ok(DEFAULT_THRESHOLD);
    };
    let value = raw.parse::<usize>().map_err(|_| {
        AppError::InvalidRequest(
            "SOURCENERVE_SEMANTIC_ANN_THRESHOLD must be an integer".into(),
        )
    })?;
    if !(MIN_THRESHOLD..=MAX_THRESHOLD).contains(&value) {
        return Err(AppError::InvalidRequest(format!(
            "SOURCENERVE_SEMANTIC_ANN_THRESHOLD must be between {MIN_THRESHOLD} and {MAX_THRESHOLD}"
        )));
    }
    Ok(value)
}

fn decode_vector(bytes: &[u8], dimension: usize) -> AppResult<Vec<f32>> {
    if bytes.len() != dimension * 4 {
        return Err(AppError::Internal(anyhow::anyhow!(
            "stored semantic vector has invalid byte length"
        )));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

fn vector_norm(vector: &[f32], dimension: usize) -> AppResult<f64> {
    if vector.len() != dimension {
        return Err(AppError::InvalidRequest(format!(
            "vector dimension mismatch: expected {dimension}, got {}",
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

fn normalize(vector: &[f32], norm: f64) -> Vec<f32> {
    let norm = norm as f32;
    vector.iter().map(|value| *value / norm).collect()
}

fn exact_score(query: &[f32], query_norm: f64, stored: &[f32], stored_norm: f64) -> f64 {
    let dot = query
        .iter()
        .zip(stored)
        .map(|(left, right)| f64::from(*left) * f64::from(*right))
        .sum::<f64>();
    (dot / (query_norm * stored_norm)).clamp(-1.0, 1.0)
}

fn run_from_row(row: RunRow) -> AppResult<SemanticRunView> {
    Ok(SemanticRunView {
        id: row.0,
        workspace: row.1,
        client_run_id: row.2,
        provider: row.3,
        model: row.4,
        dimension: usize::try_from(row.5)
            .map_err(|_| AppError::Internal(anyhow::anyhow!("invalid semantic run dimension")))?,
        git_head: row.6,
        graph_version: row.7,
        status: row.8,
        created_at: row.9,
        activated_at: row.10,
    })
}

async fn current_run(state: &AppState, workspace: &str) -> AppResult<Option<SemanticRunView>> {
    let row: Option<RunRow> = sqlx::query_as(
        "SELECT r.id, r.workspace_id, r.client_run_id, r.provider, r.model, r.dimension, \
                r.git_head, r.graph_version, r.status, r.created_at, r.activated_at \
         FROM semantic_runs r JOIN workspaces w ON w.id=r.workspace_id \
         WHERE r.workspace_id=?1 AND r.status='active' \
           AND w.indexed_head=r.git_head AND w.graph_version=r.graph_version \
         ORDER BY r.activated_at DESC, r.id DESC LIMIT 1",
    )
    .bind(workspace)
    .fetch_optional(&state.db)
    .await?;
    row.map(run_from_row).transpose()
}

async fn chunks_for_run(
    state: &AppState,
    run: &SemanticRunView,
) -> AppResult<Vec<AnnChunk>> {
    let rows: Vec<ChunkRow> = sqlx::query_as(
        "SELECT c.path, c.start_line, c.end_line, c.file_sha256, c.vector, c.vector_norm \
         FROM semantic_chunks c \
         JOIN files f ON f.workspace_id=c.workspace_id AND f.path=c.path AND f.content_hash=c.file_sha256 \
         WHERE c.workspace_id=?1 AND c.run_id=?2 \
         ORDER BY c.path, c.start_line, c.end_line",
    )
    .bind(&run.workspace)
    .bind(&run.id)
    .fetch_all(&state.db)
    .await?;

    rows.into_iter()
        .map(|(path, start_line, end_line, file_sha256, bytes, norm)| {
            Ok(AnnChunk {
                path,
                start_line: usize::try_from(start_line).map_err(|_| {
                    AppError::Internal(anyhow::anyhow!("invalid semantic chunk start line"))
                })?,
                end_line: usize::try_from(end_line).map_err(|_| {
                    AppError::Internal(anyhow::anyhow!("invalid semantic chunk end line"))
                })?,
                file_sha256,
                vector: decode_vector(&bytes, run.dimension)?,
                norm,
            })
        })
        .collect()
}

fn hash_field(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

fn index_hash(run: &SemanticRunView, chunks: &[AnnChunk]) -> String {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, run.id.as_bytes());
    hash_field(&mut hasher, run.git_head.as_bytes());
    hasher.update(run.graph_version.to_le_bytes());
    hash_field(&mut hasher, run.provider.as_bytes());
    hash_field(&mut hasher, run.model.as_bytes());
    hasher.update((run.dimension as u64).to_le_bytes());
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

async fn persist_snapshot(
    state: &AppState,
    run: &SemanticRunView,
    chunks: &[AnnChunk],
    hash: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO semantic_ann_snapshots(\
            workspace_id, run_id, git_head, graph_version, provider, model, dimension, chunk_count, index_hash, algorithm, built_at\
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'hnsw-dot-normalized',unixepoch()) \
         ON CONFLICT(workspace_id) DO UPDATE SET \
            run_id=excluded.run_id, git_head=excluded.git_head, graph_version=excluded.graph_version, \
            provider=excluded.provider, model=excluded.model, dimension=excluded.dimension, \
            chunk_count=excluded.chunk_count, index_hash=excluded.index_hash, \
            algorithm=excluded.algorithm, built_at=excluded.built_at",
    )
    .bind(&run.workspace)
    .bind(&run.id)
    .bind(&run.git_head)
    .bind(run.graph_version)
    .bind(&run.provider)
    .bind(&run.model)
    .bind(run.dimension as i64)
    .bind(chunks.len() as i64)
    .bind(hash)
    .execute(&state.db)
    .await?;
    Ok(())
}

pub async fn status(state: &AppState, workspace: &str) -> AppResult<SemanticAnnStatus> {
    state.workspaces.get(workspace)?;
    let threshold = threshold()?;
    let Some(run) = current_run(state, workspace).await? else {
        return Ok(SemanticAnnStatus {
            workspace: workspace.to_string(),
            mode: "none".into(),
            threshold,
            eligible_chunks: 0,
            run_id: None,
            index_hash: None,
            snapshot_current: false,
            algorithm: "hnsw-dot-normalized",
        });
    };
    let chunks = chunks_for_run(state, &run).await?;
    let hash = index_hash(&run, &chunks);
    let snapshot: Option<(String, String)> = sqlx::query_as(
        "SELECT run_id, index_hash FROM semantic_ann_snapshots WHERE workspace_id=?1",
    )
    .bind(workspace)
    .fetch_optional(&state.db)
    .await?;
    let snapshot_current = matches!(snapshot, Some((ref run_id, ref stored_hash)) if run_id == &run.id && stored_hash == &hash);
    let mode = if chunks.len() < threshold {
        "exact"
    } else if snapshot_current {
        "hnsw"
    } else {
        "hnsw-rebuild-required"
    };
    Ok(SemanticAnnStatus {
        workspace: workspace.to_string(),
        mode: mode.into(),
        threshold,
        eligible_chunks: chunks.len(),
        run_id: Some(run.id),
        index_hash: Some(hash),
        snapshot_current,
        algorithm: "hnsw-dot-normalized",
    })
}

pub async fn search_indexed(
    state: &AppState,
    workspace: &str,
    query_vector: &[f32],
    limit: usize,
) -> AppResult<SemanticSearchResult> {
    let threshold = threshold()?;
    let Some(run) = current_run(state, workspace).await? else {
        return Ok(SemanticSearchResult {
            run: None,
            hits: Vec::new(),
        });
    };
    let chunks = chunks_for_run(state, &run).await?;
    if chunks.len() < threshold {
        return semantic::search_indexed(state, workspace, query_vector, limit).await;
    }

    let query_norm = vector_norm(query_vector, run.dimension)?;
    let normalized_query = normalize(query_vector, query_norm);
    let index = Hnsw::<f32, DistDot>::new(
        MAX_CONNECTIONS,
        chunks.len(),
        MAX_LAYERS,
        EF_CONSTRUCTION,
        DistDot {},
    );
    let normalized = chunks
        .iter()
        .map(|chunk| normalize(&chunk.vector, chunk.norm))
        .collect::<Vec<_>>();
    for (id, vector) in normalized.iter().enumerate() {
        index.insert((vector.as_slice(), id));
    }

    let requested = limit.clamp(1, MAX_LIMIT);
    let candidate_count = chunks
        .len()
        .min(MIN_CANDIDATES.max(requested.saturating_mul(CANDIDATE_MULTIPLIER)));
    let ef_search = candidate_count.saturating_mul(2).max(MAX_CONNECTIONS + 1);
    let neighbours = index.search(&normalized_query, candidate_count, ef_search);
    let candidates = neighbours
        .into_iter()
        .map(|neighbour| neighbour.d_id)
        .filter(|id| *id < chunks.len())
        .collect::<HashSet<_>>();

    if candidates.len() < requested {
        return semantic::search_indexed(state, workspace, query_vector, limit).await;
    }

    let mut hits = candidates
        .into_iter()
        .map(|id| {
            let chunk = &chunks[id];
            SemanticSearchHit {
                path: chunk.path.clone(),
                start_line: chunk.start_line,
                end_line: chunk.end_line,
                score: exact_score(query_vector, query_norm, &chunk.vector, chunk.norm),
                file_sha256: chunk.file_sha256.clone(),
                run_id: run.id.clone(),
                provider: run.provider.clone(),
                model: run.model.clone(),
            }
        })
        .collect::<Vec<_>>();
    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.start_line.cmp(&right.start_line))
            .then_with(|| left.end_line.cmp(&right.end_line))
    });
    hits.truncate(requested);

    let hash = index_hash(&run, &chunks);
    persist_snapshot(state, &run, &chunks, &hash).await?;
    Ok(SemanticSearchResult {
        run: Some(run),
        hits,
    })
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_THRESHOLD, exact_score, normalize};

    #[test]
    fn normalization_has_unit_direction() {
        let normalized = normalize(&[3.0, 4.0], 5.0);
        assert!((normalized[0] - 0.6).abs() < 1e-6);
        assert!((normalized[1] - 0.8).abs() < 1e-6);
    }

    #[test]
    fn exact_rerank_preserves_cosine_order() {
        let query = [1.0, 0.0];
        assert!(exact_score(&query, 1.0, &[1.0, 0.0], 1.0) > exact_score(&query, 1.0, &[0.0, 1.0], 1.0));
        assert_eq!(DEFAULT_THRESHOLD, 128);
    }
}
