use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    git, scip_enrichment,
    service::AppState,
};

const MAX_FTS_CANDIDATES: i64 = 50;
const MAX_SYMBOL_CANDIDATES: i64 = 80;
const MAX_GRAPH_SEEDS: usize = 12;
const MAX_RANGE_LINES: i64 = 80;
const DEFAULT_MAX_BYTES: usize = 64 * 1024;
const DEFAULT_MAX_ITEMS: usize = 20;
const MIN_MAX_BYTES: usize = 256;
const MAX_MAX_BYTES: usize = 512 * 1024;
const MAX_ITEMS: usize = 100;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ContextPackRequest {
    pub workspace: String,
    pub query: String,
    #[serde(default)]
    pub seed_symbol_keys: Vec<String>,
    #[serde(default = "default_max_bytes")]
    pub max_bytes: usize,
    #[serde(default = "default_max_items")]
    pub max_items: usize,
    #[serde(default = "default_require_clean")]
    pub require_clean: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ContextScoreReason {
    pub signal: String,
    pub score: i64,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ContextItem {
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub content: String,
    pub sha256: String,
    pub symbol_keys: Vec<String>,
    pub score: i64,
    pub reasons: Vec<ContextScoreReason>,
    pub edge_sources: Vec<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ContextPack {
    pub workspace: String,
    pub query: String,
    pub head: String,
    pub indexed_head: String,
    pub graph_version: i64,
    pub clean: bool,
    pub consistency: String,
    pub scip: scip_enrichment::ScipStatus,
    pub max_bytes: usize,
    pub max_items: usize,
    pub used_bytes: usize,
    pub truncated: bool,
    pub items: Vec<ContextItem>,
}

#[derive(Debug, Clone)]
struct RangeCandidate {
    start: i64,
    end: i64,
    score: i64,
    symbol_keys: BTreeSet<String>,
    reasons: Vec<ContextScoreReason>,
    edge_sources: BTreeSet<String>,
}

#[derive(Debug, Default, Clone)]
struct FileCandidate {
    score: i64,
    ranges: Vec<RangeCandidate>,
    reasons: Vec<ContextScoreReason>,
    symbol_keys: BTreeSet<String>,
    edge_sources: BTreeSet<String>,
}

#[derive(Debug, Clone)]
struct SymbolCandidate {
    key: String,
    path: String,
    start: i64,
    end: i64,
    score: i64,
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

fn query_tokens(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    query
        .split(|ch: char| !(ch.is_alphanumeric() || ch == '_' || ch == '-'))
        .map(str::trim)
        .filter(|token| token.len() >= 2)
        .map(str::to_ascii_lowercase)
        .filter(|token| seen.insert(token.clone()))
        .take(12)
        .collect()
}

fn fts_query(tokens: &[String]) -> String {
    tokens
        .iter()
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn graph_weight(edge_type: &str) -> i64 {
    match edge_type {
        "CALLS" => 150,
        "REFERENCES" => 125,
        "IMPLEMENTS" | "EXTENDS" | "TYPE_DEFINITION" => 120,
        "IMPORTS" => 90,
        "CONTAINS" => 50,
        _ => 60,
    }
}

fn add_reason(candidate: &mut FileCandidate, signal: &str, score: i64, detail: String) {
    candidate.score += score;
    candidate.reasons.push(ContextScoreReason {
        signal: signal.to_string(),
        score,
        detail,
    });
}

fn add_range(
    candidate: &mut FileCandidate,
    start: i64,
    end: i64,
    score: i64,
    symbol_key: Option<&str>,
    reason: ContextScoreReason,
    edge_source: Option<&str>,
) {
    let start = start.max(1);
    let end = end.max(start).min(start + MAX_RANGE_LINES - 1);
    let mut symbol_keys = BTreeSet::new();
    if let Some(key) = symbol_key {
        symbol_keys.insert(key.to_string());
        candidate.symbol_keys.insert(key.to_string());
    }
    let mut edge_sources = BTreeSet::new();
    if let Some(source) = edge_source {
        edge_sources.insert(source.to_string());
        candidate.edge_sources.insert(source.to_string());
    }
    candidate.ranges.push(RangeCandidate {
        start,
        end,
        score,
        symbol_keys,
        reasons: vec![reason],
        edge_sources,
    });
}

fn query_match_line(content: &str, tokens: &[String]) -> usize {
    if tokens.is_empty() {
        return 1;
    }
    for (index, line) in content.lines().enumerate() {
        let lower = line.to_ascii_lowercase();
        if tokens.iter().any(|token| lower.contains(token)) {
            return index + 1;
        }
    }
    1
}

fn merge_ranges(mut ranges: Vec<RangeCandidate>) -> Vec<RangeCandidate> {
    ranges.sort_by_key(|range| (range.start, range.end));
    let mut merged: Vec<RangeCandidate> = Vec::new();
    for range in ranges {
        if let Some(last) = merged.last_mut() {
            if range.start <= last.end + 1 {
                last.end = last.end.max(range.end);
                last.score = last.score.max(range.score);
                last.symbol_keys.extend(range.symbol_keys);
                last.reasons.extend(range.reasons);
                last.edge_sources.extend(range.edge_sources);
                continue;
            }
        }
        merged.push(range);
    }
    merged
}

fn line_slice(content: &str, start: usize, end: usize) -> (String, usize) {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return (String::new(), 0);
    }
    let start = start.clamp(1, lines.len());
    let end = end.clamp(start, lines.len());
    let value = lines[start - 1..end].join("\n");
    (value.clone(), value.len())
}

fn fit_lines(content: &str, start: usize, end: usize, budget: usize) -> Option<(String, usize)> {
    if budget == 0 {
        return None;
    }
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() || start > lines.len() {
        return None;
    }
    let mut selected = Vec::new();
    let mut bytes = 0usize;
    let final_end = end.min(lines.len());
    for line in &lines[start - 1..final_end] {
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
    Some((selected.join("\n"), start + selected.len() - 1))
}

async fn graph_state(state: &AppState, workspace_id: &str) -> AppResult<(i64, String)> {
    let row: (i64, Option<String>) = sqlx::query_as(
        "SELECT graph_version, indexed_head FROM workspaces WHERE id=?1",
    )
    .bind(workspace_id)
    .fetch_one(&state.db)
    .await?;
    let indexed_head = row
        .1
        .ok_or_else(|| AppError::InvalidRequest("workspace has not been indexed yet".into()))?;
    Ok((row.0, indexed_head))
}

async fn add_fts_candidates(
    state: &AppState,
    workspace_id: &str,
    tokens: &[String],
    candidates: &mut BTreeMap<String, FileCandidate>,
) -> AppResult<()> {
    let fts = fts_query(tokens);
    if fts.is_empty() {
        return Ok(());
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT f.path, coalesce(f.content, '') \
         FROM code_fts JOIN files f ON f.id=code_fts.rowid \
         WHERE code_fts MATCH ?1 AND f.workspace_id=?2 \
         ORDER BY bm25(code_fts), f.path LIMIT ?3",
    )
    .bind(fts)
    .bind(workspace_id)
    .bind(MAX_FTS_CANDIDATES)
    .fetch_all(&state.db)
    .await?;

    for (rank, (path, content)) in rows.into_iter().enumerate() {
        let score = 300_i64.saturating_sub((rank as i64) * 5).max(60);
        let line = query_match_line(&content, tokens) as i64;
        let start = (line - 5).max(1);
        let end = line + 8;
        let candidate = candidates.entry(path).or_default();
        add_reason(
            candidate,
            "fts",
            score,
            format!("FTS rank {} for query tokens", rank + 1),
        );
        add_range(
            candidate,
            start,
            end,
            score,
            None,
            ContextScoreReason {
                signal: "fts-window".into(),
                score,
                detail: format!("query match near line {line}"),
            },
            None,
        );
    }
    Ok(())
}

async fn add_symbol_candidates(
    state: &AppState,
    workspace_id: &str,
    tokens: &[String],
    seed_symbol_keys: &[String],
    candidates: &mut BTreeMap<String, FileCandidate>,
) -> AppResult<Vec<SymbolCandidate>> {
    let mut symbols: HashMap<String, SymbolCandidate> = HashMap::new();

    for token in tokens {
        let pattern = format!("%{token}%");
        let rows: Vec<(String, String, String, String, Option<i64>, Option<i64>)> = sqlx::query_as(
            "SELECT s.symbol_key, f.path, s.name, s.qualified_name, s.start_line, s.end_line \
             FROM symbols s JOIN files f ON f.id=s.file_id \
             WHERE s.workspace_id=?1 AND (lower(s.name)=?2 OR lower(s.name) LIKE ?3 OR lower(s.qualified_name) LIKE ?3) \
             ORDER BY CASE WHEN lower(s.name)=?2 THEN 0 ELSE 1 END, s.qualified_name LIMIT ?4",
        )
        .bind(workspace_id)
        .bind(token)
        .bind(&pattern)
        .bind(MAX_SYMBOL_CANDIDATES)
        .fetch_all(&state.db)
        .await?;
        for (key, path, name, qualified, start, end) in rows {
            let exact = name.eq_ignore_ascii_case(token);
            let score = if exact { 520 } else { 260 };
            let symbol = SymbolCandidate {
                key: key.clone(),
                path: path.clone(),
                start: start.unwrap_or(1),
                end: end.unwrap_or(start.unwrap_or(1)),
                score,
            };
            let existing = symbols.entry(key.clone()).or_insert(symbol);
            existing.score = existing.score.max(score);
            let candidate = candidates.entry(path).or_default();
            add_reason(
                candidate,
                if exact { "symbol-exact" } else { "symbol-match" },
                score,
                if exact {
                    format!("exact symbol match `{name}`")
                } else {
                    format!("symbol match `{qualified}`")
                },
            );
            add_range(
                candidate,
                start.unwrap_or(1),
                end.unwrap_or(start.unwrap_or(1)),
                score,
                Some(&key),
                ContextScoreReason {
                    signal: if exact { "symbol-exact" } else { "symbol-match" }.into(),
                    score,
                    detail: qualified,
                },
                None,
            );
        }
    }

    for key in seed_symbol_keys.iter().take(MAX_GRAPH_SEEDS) {
        let row: Option<(String, Option<i64>, Option<i64>)> = sqlx::query_as(
            "SELECT f.path, s.start_line, s.end_line FROM symbols s JOIN files f ON f.id=s.file_id \
             WHERE s.workspace_id=?1 AND s.symbol_key=?2",
        )
        .bind(workspace_id)
        .bind(key)
        .fetch_optional(&state.db)
        .await?;
        let Some((path, start, end)) = row else {
            return Err(AppError::InvalidRequest(format!("seed symbol not found: {key}")));
        };
        let score = 900;
        symbols.insert(
            key.clone(),
            SymbolCandidate {
                key: key.clone(),
                path: path.clone(),
                start: start.unwrap_or(1),
                end: end.unwrap_or(start.unwrap_or(1)),
                score,
            },
        );
        let candidate = candidates.entry(path).or_default();
        add_reason(candidate, "seed-symbol", score, format!("explicit seed `{key}`"));
        add_range(
            candidate,
            start.unwrap_or(1),
            end.unwrap_or(start.unwrap_or(1)),
            score,
            Some(key),
            ContextScoreReason {
                signal: "seed-symbol".into(),
                score,
                detail: key.clone(),
            },
            None,
        );
    }

    let mut values: Vec<_> = symbols.into_values().collect();
    values.sort_by(|left, right| right.score.cmp(&left.score).then_with(|| left.key.cmp(&right.key)));
    values.truncate(MAX_GRAPH_SEEDS);
    Ok(values)
}

async fn add_graph_candidates(
    state: &AppState,
    workspace_id: &str,
    seeds: &[SymbolCandidate],
    candidates: &mut BTreeMap<String, FileCandidate>,
) -> AppResult<()> {
    for seed in seeds {
        let degree: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM edges e JOIN symbols s ON s.id=e.source_symbol_id OR s.id=e.target_symbol_id \
             WHERE e.workspace_id=?1 AND s.workspace_id=?1 AND s.symbol_key=?2",
        )
        .bind(workspace_id)
        .bind(&seed.key)
        .fetch_one(&state.db)
        .await?;
        if let Some(candidate) = candidates.get_mut(&seed.path) {
            let centrality = degree.clamp(0, 25) * 3;
            if centrality > 0 {
                add_reason(
                    candidate,
                    "graph-degree",
                    centrality,
                    format!("{} resolved graph edges", degree.max(0)),
                );
            }
        }

        let rows: Vec<(String, String, String, Option<i64>, Option<i64>, String)> = sqlx::query_as(
            "SELECT neighbor.symbol_key, f.path, e.edge_type, neighbor.start_line, neighbor.end_line, e.source \
             FROM edges e \
             JOIN symbols seed ON (seed.id=e.source_symbol_id OR seed.id=e.target_symbol_id) \
             JOIN symbols neighbor ON neighbor.id=CASE WHEN e.source_symbol_id=seed.id THEN e.target_symbol_id ELSE e.source_symbol_id END \
             JOIN files f ON f.id=neighbor.file_id \
             WHERE e.workspace_id=?1 AND seed.workspace_id=?1 AND seed.symbol_key=?2 \
             ORDER BY e.edge_type, neighbor.qualified_name, e.source LIMIT 50",
        )
        .bind(workspace_id)
        .bind(&seed.key)
        .fetch_all(&state.db)
        .await?;
        for (neighbor_key, path, edge_type, start, end, source) in rows {
            let score = graph_weight(&edge_type) + (seed.score / 10);
            let candidate = candidates.entry(path).or_default();
            add_reason(
                candidate,
                "graph-neighbor",
                score,
                format!("{edge_type} from seed {} via {source}", seed.key),
            );
            candidate.edge_sources.insert(source.clone());
            add_range(
                candidate,
                start.unwrap_or(1),
                end.unwrap_or(start.unwrap_or(1)),
                score,
                Some(&neighbor_key),
                ContextScoreReason {
                    signal: "graph-neighbor".into(),
                    score,
                    detail: format!("{edge_type} via {source}"),
                },
                Some(&source),
            );
        }
    }
    Ok(())
}

pub async fn pack(state: &AppState, req: ContextPackRequest) -> AppResult<ContextPack> {
    if req.query.trim().is_empty() && req.seed_symbol_keys.is_empty() {
        return Err(AppError::InvalidRequest(
            "context query or at least one seed symbol is required".into(),
        ));
    }
    let workspace = state.workspaces.get(&req.workspace)?;
    let head = git::head(&workspace.root).await?;
    let status = git::status(&workspace.root).await?;
    let clean = status.is_empty();
    if req.require_clean && !clean {
        return Err(AppError::InvalidRequest(
            "context pack requires a clean working tree; set require_clean=false to accept the indexed snapshot explicitly".into(),
        ));
    }
    let (graph_version, indexed_head) = graph_state(state, &req.workspace).await?;
    if indexed_head != head {
        return Err(AppError::InvalidRequest(format!(
            "repository intelligence is stale: indexed HEAD {indexed_head}, current HEAD {head}"
        )));
    }
    let scip = scip_enrichment::ensure_current(state, &req.workspace).await?;
    let tokens = query_tokens(&req.query);
    let mut candidates = BTreeMap::new();
    add_fts_candidates(state, &req.workspace, &tokens, &mut candidates).await?;
    let symbol_seeds = add_symbol_candidates(
        state,
        &req.workspace,
        &tokens,
        &req.seed_symbol_keys,
        &mut candidates,
    )
    .await?;
    add_graph_candidates(state, &req.workspace, &symbol_seeds, &mut candidates).await?;

    let max_bytes = req.max_bytes.clamp(MIN_MAX_BYTES, MAX_MAX_BYTES);
    let max_items = req.max_items.clamp(1, MAX_ITEMS);
    let mut ranked: Vec<_> = candidates.into_iter().collect();
    ranked.sort_by(|(left_path, left), (right_path, right)| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left_path.cmp(right_path))
    });

    let mut items = Vec::new();
    let mut used_bytes = 0usize;
    let mut truncated = false;
    for (path, candidate) in ranked {
        if items.len() >= max_items || used_bytes >= max_bytes {
            truncated = true;
            break;
        }
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT content_hash, content FROM files WHERE workspace_id=?1 AND path=?2",
        )
        .bind(&req.workspace)
        .bind(&path)
        .fetch_optional(&state.db)
        .await?;
        let Some((hash, Some(content))) = row else {
            continue;
        };
        let ranges = merge_ranges(candidate.ranges);
        for range in ranges {
            if items.len() >= max_items || used_bytes >= max_bytes {
                truncated = true;
                break;
            }
            let remaining = max_bytes - used_bytes;
            let start = range.start.max(1) as usize;
            let end = range.end.max(range.start) as usize;
            let (full, full_bytes) = line_slice(&content, start, end);
            let (snippet, actual_end) = if full_bytes <= remaining {
                (full, end)
            } else if let Some(fit) = fit_lines(&content, start, end, remaining) {
                truncated = true;
                fit
            } else {
                truncated = true;
                continue;
            };
            used_bytes += snippet.len();
            let mut reasons = candidate.reasons.clone();
            reasons.extend(range.reasons);
            reasons.sort_by(|left, right| {
                right
                    .score
                    .cmp(&left.score)
                    .then_with(|| left.signal.cmp(&right.signal))
                    .then_with(|| left.detail.cmp(&right.detail))
            });
            reasons.dedup_by(|left, right| {
                left.signal == right.signal && left.score == right.score && left.detail == right.detail
            });
            let mut symbol_keys = candidate.symbol_keys.clone();
            symbol_keys.extend(range.symbol_keys);
            let mut edge_sources = candidate.edge_sources.clone();
            edge_sources.extend(range.edge_sources);
            items.push(ContextItem {
                path: path.clone(),
                start_line: start,
                end_line: actual_end,
                content: snippet,
                sha256: hash.clone(),
                symbol_keys: symbol_keys.into_iter().collect(),
                score: candidate.score.max(range.score),
                reasons,
                edge_sources: edge_sources.into_iter().collect(),
            });
        }
    }

    Ok(ContextPack {
        workspace: req.workspace,
        query: req.query,
        head,
        indexed_head,
        graph_version,
        clean,
        consistency: if clean {
            "clean-head-index".into()
        } else {
            "explicit-indexed-snapshot".into()
        },
        scip,
        max_bytes,
        max_items,
        used_bytes,
        truncated,
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::{fit_lines, merge_ranges, query_tokens, ContextScoreReason, RangeCandidate};
    use std::collections::BTreeSet;

    fn range(start: i64, end: i64) -> RangeCandidate {
        RangeCandidate {
            start,
            end,
            score: 10,
            symbol_keys: BTreeSet::new(),
            reasons: vec![ContextScoreReason {
                signal: "test".into(),
                score: 10,
                detail: "test".into(),
            }],
            edge_sources: BTreeSet::new(),
        }
    }

    #[test]
    fn tokenizes_deterministically() {
        assert_eq!(query_tokens("Search search_evidence API"), vec!["search", "search_evidence", "api"]);
    }

    #[test]
    fn merges_overlapping_and_adjacent_ranges() {
        let merged = merge_ranges(vec![range(10, 20), range(21, 25), range(40, 41)]);
        assert_eq!(merged.len(), 2);
        assert_eq!((merged[0].start, merged[0].end), (10, 25));
    }

    #[test]
    fn line_fit_never_exceeds_budget() {
        let content = "alpha\nbeta\ngamma\n";
        let (snippet, end) = fit_lines(content, 1, 3, 10).unwrap();
        assert!(snippet.len() <= 10);
        assert_eq!(end, 1);
    }
}
