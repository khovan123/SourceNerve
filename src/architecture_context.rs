use schemars::JsonSchema;
use serde::Deserialize;

use crate::{
    architecture,
    context::{ContextItem, ContextPack, ContextScoreReason},
    error::AppResult,
    semantic_context::{self, SemanticContextPackRequest},
    service::AppState,
};

const DEFAULT_MAX_BYTES: usize = 64 * 1024;
const DEFAULT_MAX_ITEMS: usize = 20;
const MIN_MAX_BYTES: usize = 256;
const MAX_MAX_BYTES: usize = 512 * 1024;
const MAX_ITEMS: usize = 100;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ArchitectureContextPackRequest {
    pub workspace: String,
    pub query: String,
    #[serde(default)]
    pub seed_symbol_keys: Vec<String>,
    #[serde(default)]
    pub seed_cluster_keys: Vec<String>,
    #[serde(default = "default_max_bytes")]
    pub max_bytes: usize,
    #[serde(default = "default_max_items")]
    pub max_items: usize,
    #[serde(default = "default_require_clean")]
    pub require_clean: bool,
    #[serde(default)]
    pub query_vector: Option<Vec<f32>>,
    #[serde(default)]
    pub provider_semantic: bool,
}

fn default_max_bytes() -> usize {
    DEFAULT_MAX_BYTES
}

fn default_max_items() -> usize {
    DEFAULT_MAX_ITEMS
}

fn default_require_clean() -> bool {
    true
}

fn semantic_request(
    request: &ArchitectureContextPackRequest,
    max_bytes: usize,
    max_items: usize,
) -> SemanticContextPackRequest {
    SemanticContextPackRequest {
        workspace: request.workspace.clone(),
        query: request.query.clone(),
        seed_symbol_keys: request.seed_symbol_keys.clone(),
        max_bytes,
        max_items,
        require_clean: request.require_clean,
        query_vector: request.query_vector.clone(),
        provider_semantic: request.provider_semantic,
    }
}

fn ranges_overlap(
    left_start: usize,
    left_end: usize,
    right_start: usize,
    right_end: usize,
) -> bool {
    left_start <= right_end && right_start <= left_end
}

fn architecture_score(centrality: i64) -> i64 {
    450 + (centrality / 10).clamp(0, 300)
}

fn slice_with_budget(
    content: &str,
    start_line: usize,
    end_line: usize,
    budget: usize,
) -> Option<(String, usize)> {
    if budget == 0 {
        return None;
    }
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() || start_line == 0 || start_line > lines.len() {
        return None;
    }
    let final_end = end_line.max(start_line).min(lines.len());
    let mut selected = Vec::new();
    let mut bytes = 0usize;
    for line in &lines[start_line - 1..final_end] {
        let extra = line.len() + usize::from(!selected.is_empty());
        if bytes + extra > budget {
            break;
        }
        selected.push(*line);
        bytes += extra;
    }
    if selected.is_empty() {
        return None;
    }
    Some((selected.join("\n"), start_line + selected.len() - 1))
}

pub async fn pack(
    state: &AppState,
    request: ArchitectureContextPackRequest,
) -> AppResult<ContextPack> {
    if request.seed_cluster_keys.is_empty() {
        return semantic_context::pack(
            state,
            semantic_request(&request, request.max_bytes, request.max_items),
        )
        .await;
    }

    let hits =
        architecture::seed_hits(state, &request.workspace, &request.seed_cluster_keys).await?;
    if hits.is_empty() {
        return semantic_context::pack(
            state,
            semantic_request(&request, request.max_bytes, request.max_items),
        )
        .await;
    }

    let max_bytes = request.max_bytes.clamp(MIN_MAX_BYTES, MAX_MAX_BYTES);
    let max_items = request.max_items.clamp(1, MAX_ITEMS);
    let baseline_bytes = (max_bytes * 3 / 4).max(MIN_MAX_BYTES).min(max_bytes);
    let baseline_items = (max_items * 3 / 4).max(1);
    let mut packed = semantic_context::pack(
        state,
        semantic_request(&request, baseline_bytes, baseline_items),
    )
    .await?;
    packed.max_bytes = max_bytes;
    packed.max_items = max_items;

    for hit in hits {
        let score = architecture_score(hit.centrality_score);
        let detail = format!(
            "representative of architecture cluster {} (centrality={})",
            hit.cluster_key, hit.centrality_score
        );
        if let Some(existing) = packed.items.iter_mut().find(|item| {
            item.path == hit.path
                && ranges_overlap(item.start_line, item.end_line, hit.start_line, hit.end_line)
        }) {
            existing.score += score;
            if let Some(symbol_key) = hit.symbol_key.as_ref() {
                if !existing.symbol_keys.contains(symbol_key) {
                    existing.symbol_keys.push(symbol_key.clone());
                    existing.symbol_keys.sort();
                }
            }
            existing.reasons.push(ContextScoreReason {
                signal: "architecture-cluster".into(),
                score,
                detail,
            });
            continue;
        }

        if packed.items.len() >= max_items || packed.used_bytes >= max_bytes {
            packed.truncated = true;
            break;
        }
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT content_hash, content FROM files WHERE workspace_id=?1 AND path=?2",
        )
        .bind(&request.workspace)
        .bind(&hit.path)
        .fetch_optional(&state.db)
        .await?;
        let Some((hash, Some(content))) = row else {
            continue;
        };
        let remaining = max_bytes - packed.used_bytes;
        let Some((snippet, actual_end)) =
            slice_with_budget(&content, hit.start_line, hit.end_line, remaining)
        else {
            packed.truncated = true;
            continue;
        };
        packed.used_bytes += snippet.len();
        packed.items.push(ContextItem {
            path: hit.path,
            start_line: hit.start_line,
            end_line: actual_end,
            content: snippet,
            sha256: hash,
            symbol_keys: hit.symbol_key.into_iter().collect(),
            score,
            reasons: vec![ContextScoreReason {
                signal: "architecture-cluster".into(),
                score,
                detail,
            }],
            edge_sources: Vec::new(),
        });
    }

    packed.items.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.start_line.cmp(&right.start_line))
            .then_with(|| left.end_line.cmp(&right.end_line))
    });
    Ok(packed)
}

#[cfg(test)]
mod tests {
    use super::{architecture_score, slice_with_budget};

    #[test]
    fn architecture_score_is_bounded_and_monotonic() {
        assert_eq!(architecture_score(0), 450);
        assert!(architecture_score(100) > architecture_score(0));
        assert_eq!(architecture_score(1_000_000), 750);
    }

    #[test]
    fn architecture_slice_respects_budget() {
        let (value, end) = slice_with_budget("alpha\nbeta\ngamma", 1, 3, 10).expect("slice");
        assert_eq!(value, "alpha\nbeta");
        assert_eq!(end, 2);
        assert!(value.len() <= 10);
    }
}
