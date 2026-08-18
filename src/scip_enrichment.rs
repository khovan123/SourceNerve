use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use protobuf::Message;
use schemars::JsonSchema;
use scip::types::{Index, Occurrence, SymbolRole};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    git,
    service::AppState,
    workspace::Workspace,
};

pub const MAX_SCIP_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_SCIP_ENCODED_BYTES: usize = (MAX_SCIP_BYTES * 4 / 3) + 16;

const PROVIDER: &str = "scip";
const DEFINITION_ROLE: i32 = SymbolRole::Definition as i32;

type ActiveRunRow = (
    String,
    String,
    i64,
    Option<String>,
    Option<String>,
    String,
    i64,
    i64,
    i64,
    i64,
);

type DbSymbolRow = (String, Option<i64>, Option<i64>, String);

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ScipImportRequest {
    pub workspace: String,
    pub expected_head: String,
    pub expected_graph_version: i64,
    /// Base64-encoded official SCIP protobuf Index payload.
    pub index_base64: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ScipStatus {
    pub workspace: String,
    pub provider: String,
    pub active: bool,
    pub run_id: Option<String>,
    pub git_head: Option<String>,
    pub graph_version: Option<i64>,
    pub provider_tool: Option<String>,
    pub provider_version: Option<String>,
    pub index_sha256: Option<String>,
    pub documents: u64,
    pub mapped_symbols: u64,
    pub materialized_edges: u64,
    pub unresolved_facts: u64,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ScipImportResult {
    pub run: ScipStatus,
}

#[derive(Debug, Clone)]
struct DbSymbol {
    key: String,
    start_line: i64,
    end_line: i64,
    kind: String,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct EdgeFact {
    source_key: String,
    target_key: String,
    edge_type: String,
}

#[derive(Debug, Clone)]
struct UnresolvedFact {
    document_path: Option<String>,
    line: Option<i64>,
    source_scip_symbol: Option<String>,
    target_scip_symbol: Option<String>,
    fact_type: String,
    reason: String,
}

fn sha256(input: &[u8]) -> String {
    hex::encode(Sha256::digest(input))
}

fn normalize_relative_path(raw: &str) -> AppResult<String> {
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
        return Err(AppError::PathOutsideWorkspace);
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
        return Err(AppError::PathOutsideWorkspace);
    }
    Ok(normalized)
}

fn occurrence_line(occurrence: &Occurrence) -> Option<i64> {
    if occurrence.has_single_line_range() {
        let line = occurrence.single_line_range().line;
        return (line >= 0).then_some(line as i64 + 1);
    }
    if occurrence.has_multi_line_range() {
        let line = occurrence.multi_line_range().start_line;
        return (line >= 0).then_some(line as i64 + 1);
    }
    occurrence
        .range
        .first()
        .copied()
        .filter(|line| *line >= 0)
        .map(|line| line as i64 + 1)
}

fn is_definition(occurrence: &Occurrence) -> bool {
    occurrence.symbol_roles & DEFINITION_ROLE != 0
}

fn select_symbol(symbols: &[DbSymbol], line: i64) -> Option<String> {
    let mut candidates: Vec<&DbSymbol> = symbols
        .iter()
        .filter(|symbol| symbol.start_line <= line && symbol.end_line >= line)
        .collect();
    if candidates.is_empty() {
        return None;
    }

    let has_non_file = candidates.iter().any(|symbol| symbol.kind != "file");
    if has_non_file {
        candidates.retain(|symbol| symbol.kind != "file");
    }
    candidates.sort_by_key(|symbol| {
        (
            symbol.end_line.saturating_sub(symbol.start_line),
            symbol.start_line,
            &symbol.key,
        )
    });

    let first = candidates.first()?;
    if let Some(second) = candidates.get(1) {
        let first_span = first.end_line.saturating_sub(first.start_line);
        let second_span = second.end_line.saturating_sub(second.start_line);
        if first_span == second_span && first.start_line == second.start_line {
            return None;
        }
    }
    Some(first.key.clone())
}

async fn symbols_for_path(
    pool: &SqlitePool,
    workspace_id: &str,
    path: &str,
) -> AppResult<Vec<DbSymbol>> {
    let rows: Vec<DbSymbolRow> = sqlx::query_as(
        "SELECT s.symbol_key, s.start_line, s.end_line, s.kind \
         FROM symbols s JOIN files f ON f.id=s.file_id \
         WHERE s.workspace_id=?1 AND f.path=?2",
    )
    .bind(workspace_id)
    .bind(path)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .filter_map(|(key, start, end, kind)| {
            Some(DbSymbol {
                key,
                start_line: start?,
                end_line: end?,
                kind,
            })
        })
        .collect())
}

async fn mark_active_stale_tx(
    tx: &mut Transaction<'_, Sqlite>,
    workspace_id: &str,
) -> AppResult<()> {
    let active_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM enrichment_runs WHERE workspace_id=?1 AND provider=?2 AND status='active'",
    )
    .bind(workspace_id)
    .bind(PROVIDER)
    .fetch_all(&mut **tx)
    .await?;

    for run_id in &active_ids {
        let source = format!("scip:{run_id}");
        sqlx::query("DELETE FROM edges WHERE workspace_id=?1 AND source=?2")
            .bind(workspace_id)
            .bind(source)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query(
        "UPDATE enrichment_runs SET status='stale', stale_at=unixepoch() \
         WHERE workspace_id=?1 AND provider=?2 AND status='active'",
    )
    .bind(workspace_id)
    .bind(PROVIDER)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn invalidate_for_graph_change(pool: &SqlitePool, workspace_id: &str) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    mark_active_stale_tx(&mut tx, workspace_id).await?;
    tx.commit().await?;
    Ok(())
}

async fn active_status(pool: &SqlitePool, workspace_id: &str) -> AppResult<ScipStatus> {
    let row: Option<ActiveRunRow> = sqlx::query_as(
        "SELECT id, git_head, graph_version, provider_tool, provider_version, index_sha256, \
                documents, mapped_symbols, materialized_edges, unresolved_facts \
         FROM enrichment_runs \
         WHERE workspace_id=?1 AND provider=?2 AND status='active' \
         ORDER BY imported_at DESC LIMIT 1",
    )
    .bind(workspace_id)
    .bind(PROVIDER)
    .fetch_optional(pool)
    .await?;

    Ok(match row {
        Some(row) => ScipStatus {
            workspace: workspace_id.to_string(),
            provider: PROVIDER.into(),
            active: true,
            run_id: Some(row.0),
            git_head: Some(row.1),
            graph_version: Some(row.2),
            provider_tool: row.3,
            provider_version: row.4,
            index_sha256: Some(row.5),
            documents: row.6.max(0) as u64,
            mapped_symbols: row.7.max(0) as u64,
            materialized_edges: row.8.max(0) as u64,
            unresolved_facts: row.9.max(0) as u64,
        },
        None => ScipStatus {
            workspace: workspace_id.to_string(),
            provider: PROVIDER.into(),
            active: false,
            run_id: None,
            git_head: None,
            graph_version: None,
            provider_tool: None,
            provider_version: None,
            index_sha256: None,
            documents: 0,
            mapped_symbols: 0,
            materialized_edges: 0,
            unresolved_facts: 0,
        },
    })
}

async fn ensure_current_locked(state: &AppState, workspace: &Workspace) -> AppResult<ScipStatus> {
    let current = active_status(&state.db, &workspace.id).await?;
    if !current.active {
        return Ok(current);
    }

    let current_head = git::head(&workspace.root).await?;
    let dirty = !git::status(&workspace.root).await?.is_empty();
    let graph_version: i64 =
        sqlx::query_scalar("SELECT graph_version FROM workspaces WHERE id=?1")
            .bind(&workspace.id)
            .fetch_one(&state.db)
            .await?;

    if dirty
        || current.git_head.as_deref() != Some(current_head.as_str())
        || current.graph_version != Some(graph_version)
    {
        invalidate_for_graph_change(&state.db, &workspace.id).await?;
        return active_status(&state.db, &workspace.id).await;
    }
    Ok(current)
}

pub async fn ensure_current(state: &AppState, workspace_id: &str) -> AppResult<ScipStatus> {
    let _guard = state.mutation_lock.lock().await;
    let workspace = state.workspaces.get(workspace_id)?;
    ensure_current_locked(state, &workspace).await
}

pub async fn status(state: &AppState, workspace_id: &str) -> AppResult<ScipStatus> {
    ensure_current(state, workspace_id).await
}

fn provider_metadata(index: &Index) -> (Option<String>, Option<String>) {
    let Some(metadata) = index.metadata.as_ref() else {
        return (None, None);
    };
    let Some(tool) = metadata.tool_info.as_ref() else {
        return (None, None);
    };
    let name = (!tool.name.trim().is_empty()).then(|| tool.name.clone());
    let version = (!tool.version.trim().is_empty()).then(|| tool.version.clone());
    (name, version)
}

fn push_unresolved(
    unresolved: &mut Vec<UnresolvedFact>,
    path: Option<&str>,
    line: Option<i64>,
    source: Option<&str>,
    target: Option<&str>,
    fact_type: &str,
    reason: &str,
) {
    unresolved.push(UnresolvedFact {
        document_path: path.map(ToOwned::to_owned),
        line,
        source_scip_symbol: source.map(ToOwned::to_owned),
        target_scip_symbol: target.map(ToOwned::to_owned),
        fact_type: fact_type.to_string(),
        reason: reason.to_string(),
    });
}

async fn stage_index(
    pool: &SqlitePool,
    workspace_id: &str,
    index: &Index,
) -> AppResult<(HashMap<String, String>, HashSet<EdgeFact>, Vec<UnresolvedFact>)> {
    let mut by_path: HashMap<String, Vec<DbSymbol>> = HashMap::new();
    let mut normalized_paths = Vec::with_capacity(index.documents.len());
    for document in &index.documents {
        let path = normalize_relative_path(&document.relative_path)?;
        let symbols = symbols_for_path(pool, workspace_id, &path).await?;
        by_path.insert(path.clone(), symbols);
        normalized_paths.push(path);
    }

    let mut symbol_map = HashMap::new();
    let mut unresolved = Vec::new();

    for (document, path) in index.documents.iter().zip(&normalized_paths) {
        let symbols = by_path.get(path).map(Vec::as_slice).unwrap_or_default();
        for occurrence in &document.occurrences {
            if occurrence.symbol.is_empty() || !is_definition(occurrence) {
                continue;
            }
            let Some(line) = occurrence_line(occurrence) else {
                push_unresolved(
                    &mut unresolved,
                    Some(path),
                    None,
                    Some(&occurrence.symbol),
                    None,
                    "definition",
                    "missing_source_range",
                );
                continue;
            };
            let Some(key) = select_symbol(symbols, line) else {
                push_unresolved(
                    &mut unresolved,
                    Some(path),
                    Some(line),
                    Some(&occurrence.symbol),
                    None,
                    "definition",
                    "ambiguous_or_missing_local_symbol",
                );
                continue;
            };
            match symbol_map.get(&occurrence.symbol) {
                Some(existing) if existing != &key => {
                    symbol_map.remove(&occurrence.symbol);
                    push_unresolved(
                        &mut unresolved,
                        Some(path),
                        Some(line),
                        Some(&occurrence.symbol),
                        None,
                        "definition",
                        "scip_symbol_maps_to_multiple_local_symbols",
                    );
                }
                None => {
                    symbol_map.insert(occurrence.symbol.clone(), key);
                }
                _ => {}
            }
        }
    }

    let mut edges = HashSet::new();
    for (document, path) in index.documents.iter().zip(&normalized_paths) {
        let symbols = by_path.get(path).map(Vec::as_slice).unwrap_or_default();

        for occurrence in &document.occurrences {
            if occurrence.symbol.is_empty() || is_definition(occurrence) {
                continue;
            }
            let Some(line) = occurrence_line(occurrence) else {
                continue;
            };
            let Some(source_key) = select_symbol(symbols, line) else {
                push_unresolved(
                    &mut unresolved,
                    Some(path),
                    Some(line),
                    None,
                    Some(&occurrence.symbol),
                    "REFERENCES",
                    "missing_local_source_symbol",
                );
                continue;
            };
            let Some(target_key) = symbol_map.get(&occurrence.symbol) else {
                push_unresolved(
                    &mut unresolved,
                    Some(path),
                    Some(line),
                    None,
                    Some(&occurrence.symbol),
                    "REFERENCES",
                    "unmapped_target_symbol",
                );
                continue;
            };
            if source_key != *target_key {
                edges.insert(EdgeFact {
                    source_key,
                    target_key: target_key.clone(),
                    edge_type: "REFERENCES".into(),
                });
            }
        }

        for information in &document.symbols {
            let Some(source_key) = symbol_map.get(&information.symbol) else {
                continue;
            };
            for relationship in &information.relationships {
                let mut fact_types = Vec::new();
                if relationship.is_reference {
                    fact_types.push("REFERENCES");
                }
                if relationship.is_implementation {
                    fact_types.push("IMPLEMENTS");
                }
                if relationship.is_type_definition {
                    fact_types.push("TYPE_DEFINITION");
                }
                if fact_types.is_empty() {
                    continue;
                }

                let Some(target_key) = symbol_map.get(&relationship.symbol) else {
                    for fact_type in fact_types {
                        push_unresolved(
                            &mut unresolved,
                            Some(path),
                            None,
                            Some(&information.symbol),
                            Some(&relationship.symbol),
                            fact_type,
                            "unmapped_relationship_target",
                        );
                    }
                    continue;
                };
                for fact_type in fact_types {
                    if source_key != target_key {
                        edges.insert(EdgeFact {
                            source_key: source_key.clone(),
                            target_key: target_key.clone(),
                            edge_type: fact_type.into(),
                        });
                    }
                }
            }
        }
    }

    Ok((symbol_map, edges, unresolved))
}

pub async fn import(state: &AppState, req: ScipImportRequest) -> AppResult<ScipImportResult> {
    if req.index_base64.len() > MAX_SCIP_ENCODED_BYTES {
        return Err(AppError::InvalidRequest(
            "SCIP payload exceeds the 32 MiB decoded limit".into(),
        ));
    }
    let bytes = STANDARD
        .decode(req.index_base64.as_bytes())
        .map_err(|_| AppError::InvalidRequest("invalid base64 SCIP payload".into()))?;
    if bytes.len() > MAX_SCIP_BYTES {
        return Err(AppError::InvalidRequest(
            "SCIP payload exceeds the 32 MiB decoded limit".into(),
        ));
    }
    let index = Index::parse_from_bytes(&bytes)
        .map_err(|_| AppError::InvalidRequest("invalid SCIP protobuf payload".into()))?;

    let _guard = state.mutation_lock.lock().await;
    let workspace = state.workspaces.get(&req.workspace)?;
    let current_head = git::head(&workspace.root).await?;
    if current_head != req.expected_head {
        return Err(AppError::WorkspaceChanged {
            expected: req.expected_head,
            actual: current_head,
        });
    }
    if !git::status(&workspace.root).await?.is_empty() {
        return Err(AppError::InvalidRequest(
            "SCIP import requires a clean working tree".into(),
        ));
    }

    let (graph_version, indexed_head): (i64, Option<String>) = sqlx::query_as(
        "SELECT graph_version, indexed_head FROM workspaces WHERE id=?1",
    )
    .bind(&workspace.id)
    .fetch_one(&state.db)
    .await?;
    if graph_version != req.expected_graph_version {
        return Err(AppError::InvalidRequest(format!(
            "graph changed: expected version {}, current version {graph_version}",
            req.expected_graph_version
        )));
    }
    if indexed_head.as_deref() != Some(current_head.as_str()) {
        return Err(AppError::InvalidRequest(
            "deterministic graph is not indexed at the current Git HEAD".into(),
        ));
    }

    let (symbol_map, edges, unresolved) = stage_index(&state.db, &workspace.id, &index).await?;
    let (provider_tool, provider_version) = provider_metadata(&index);
    let run_id = Uuid::new_v4().to_string();
    let index_hash = sha256(&bytes);

    let head_before_commit = git::head(&workspace.root).await?;
    let graph_before_commit: i64 =
        sqlx::query_scalar("SELECT graph_version FROM workspaces WHERE id=?1")
            .bind(&workspace.id)
            .fetch_one(&state.db)
            .await?;
    if head_before_commit != current_head || graph_before_commit != graph_version {
        return Err(AppError::InvalidRequest(
            "repository or graph changed while staging SCIP import".into(),
        ));
    }

    let mut tx = state.db.begin().await?;
    mark_active_stale_tx(&mut tx, &workspace.id).await?;
    sqlx::query(
        "INSERT INTO enrichment_runs(\
            id, workspace_id, provider, git_head, graph_version, provider_tool, provider_version, index_sha256, status, \
            documents, mapped_symbols, materialized_edges, unresolved_facts, imported_at\
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?10, ?11, ?12, unixepoch())",
    )
    .bind(&run_id)
    .bind(&workspace.id)
    .bind(PROVIDER)
    .bind(&current_head)
    .bind(graph_version)
    .bind(&provider_tool)
    .bind(&provider_version)
    .bind(&index_hash)
    .bind(index.documents.len() as i64)
    .bind(symbol_map.len() as i64)
    .bind(edges.len() as i64)
    .bind(unresolved.len() as i64)
    .execute(&mut *tx)
    .await?;

    for (scip_symbol, symbol_key) in &symbol_map {
        sqlx::query(
            "INSERT INTO enrichment_symbol_map(run_id, scip_symbol, symbol_key) VALUES(?1, ?2, ?3)",
        )
        .bind(&run_id)
        .bind(scip_symbol)
        .bind(symbol_key)
        .execute(&mut *tx)
        .await?;
    }

    let edge_source = format!("scip:{run_id}");
    for edge in &edges {
        sqlx::query(
            "INSERT OR IGNORE INTO edges(workspace_id, source_symbol_id, target_symbol_id, edge_type, confidence, source) \
             SELECT ?1, source.id, target.id, ?4, 1.0, ?5 \
             FROM symbols source, symbols target \
             WHERE source.workspace_id=?1 AND source.symbol_key=?2 \
               AND target.workspace_id=?1 AND target.symbol_key=?3",
        )
        .bind(&workspace.id)
        .bind(&edge.source_key)
        .bind(&edge.target_key)
        .bind(&edge.edge_type)
        .bind(&edge_source)
        .execute(&mut *tx)
        .await?;
    }

    for fact in &unresolved {
        sqlx::query(
            "INSERT INTO enrichment_unresolved(\
                run_id, document_path, line, source_scip_symbol, target_scip_symbol, fact_type, reason\
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(&run_id)
        .bind(&fact.document_path)
        .bind(fact.line)
        .bind(&fact.source_scip_symbol)
        .bind(&fact.target_scip_symbol)
        .bind(&fact.fact_type)
        .bind(&fact.reason)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let head_after = git::head(&workspace.root).await?;
    let graph_after: i64 = sqlx::query_scalar("SELECT graph_version FROM workspaces WHERE id=?1")
        .bind(&workspace.id)
        .fetch_one(&state.db)
        .await?;
    if head_after != current_head || graph_after != graph_version || !git::status(&workspace.root).await?.is_empty() {
        invalidate_for_graph_change(&state.db, &workspace.id).await?;
        return Err(AppError::InvalidRequest(
            "repository changed while activating SCIP enrichment; imported run was marked stale".into(),
        ));
    }

    Ok(ScipImportResult {
        run: active_status(&state.db, &workspace.id).await?,
    })
}

#[cfg(test)]
mod tests {
    use super::{normalize_relative_path, occurrence_line};
    use scip::types::{Occurrence, SingleLineRange};

    #[test]
    fn rejects_path_traversal() {
        assert!(normalize_relative_path("../outside.rs").is_err());
        assert!(normalize_relative_path("/absolute.rs").is_err());
        assert_eq!(
            normalize_relative_path("./src/lib.rs").unwrap(),
            "src/lib.rs"
        );
    }

    #[test]
    fn reads_typed_occurrence_line() {
        let mut occurrence = Occurrence::new();
        let mut range = SingleLineRange::new();
        range.line = 4;
        range.start_character = 1;
        range.end_character = 2;
        occurrence.set_single_line_range(range);
        assert_eq!(occurrence_line(&occurrence), Some(5));
    }
}
