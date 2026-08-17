use std::collections::{HashMap, HashSet, VecDeque};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, SqlitePool, Transaction};
use tree_sitter::{Language, Node, Parser, Query, QueryCursor, StreamingIterator};

use crate::{
    error::{AppError, AppResult},
    service::AppState,
    workspace::Workspace,
};

const MAX_GRAPH_QUERY_RESULTS: usize = 200;
const MAX_TRACE_DEPTH: usize = 4;

const TYPESCRIPT_TAGS_QUERY: &str = r#"
(class_declaration
  name: (_) @name) @definition.class

(class
  name: (_) @name) @definition.class

(method_definition
  name: (property_identifier) @name) @definition.method

(function_declaration
  name: (identifier) @name) @definition.function

(function_signature
  name: (identifier) @name) @definition.function

(method_signature
  name: (property_identifier) @name) @definition.method

(abstract_method_signature
  name: (property_identifier) @name) @definition.method

(abstract_class_declaration
  name: (type_identifier) @name) @definition.class

(interface_declaration
  name: (type_identifier) @name) @definition.interface

(module
  name: (identifier) @name) @definition.module

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)]) @definition.function)

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)]) @definition.function)

(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name)) @reference.call

(new_expression
  constructor: (_) @name) @reference.class

(type_annotation
  (type_identifier) @name) @reference.type
"#;

type SymbolRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    Option<i64>,
    Option<i64>,
    Option<String>,
);

#[derive(Debug, Clone)]
struct LanguageSpec {
    name: &'static str,
    language: Language,
    tags_query: &'static str,
}

#[derive(Debug, Clone)]
struct RawDefinition {
    name: String,
    kind: String,
    start_byte: usize,
    end_byte: usize,
    start_line: i64,
    end_line: i64,
    signature: String,
    content_hash: String,
    ast_hash: String,
}

#[derive(Debug, Clone)]
struct RawReference {
    name: String,
    reference_type: String,
    start_byte: usize,
    end_byte: usize,
    line: i64,
}

#[derive(Debug, Clone)]
struct ParsedSymbol {
    symbol_key: String,
    qualified_name: String,
    name: String,
    kind: String,
    start_line: i64,
    end_line: i64,
    signature: String,
    content_hash: String,
    ast_hash: String,
    parent_key: Option<String>,
}

#[derive(Debug, Clone)]
struct ParsedReference {
    source_key: String,
    reference_type: String,
    name: String,
    line: i64,
}

#[derive(Debug, Clone)]
struct ParsedFileGraph {
    language: String,
    status: String,
    error: Option<String>,
    symbols: Vec<ParsedSymbol>,
    references: Vec<ParsedReference>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct GraphSyncSummary {
    pub parsed_files: u64,
    pub partial_files: u64,
    pub failed_files: u64,
    pub symbols: u64,
    pub edges: u64,
    pub unresolved_references: u64,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct GraphStatus {
    pub workspace: String,
    pub graph_version: i64,
    pub indexed_head: Option<String>,
    pub supported_files: u64,
    pub parsed_files: u64,
    pub partial_files: u64,
    pub failed_files: u64,
    pub symbols: u64,
    pub edges: u64,
    pub unresolved_references: u64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SymbolSearchRequest {
    pub workspace: String,
    pub query: String,
    pub kind: Option<String>,
    #[serde(default = "default_symbol_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SymbolView {
    pub symbol_key: String,
    pub qualified_name: String,
    pub name: String,
    pub kind: String,
    pub language: Option<String>,
    pub path: String,
    pub start_line: Option<i64>,
    pub end_line: Option<i64>,
    pub signature: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct SymbolSearchResult {
    pub symbols: Vec<SymbolView>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SymbolKeyRequest {
    pub workspace: String,
    pub symbol_key: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TraceRequest {
    pub workspace: String,
    pub symbol_key: String,
    #[serde(default = "default_trace_depth")]
    pub depth: usize,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct NeighborView {
    pub edge_type: String,
    pub confidence: f64,
    pub symbol: SymbolView,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct SymbolContext {
    pub symbol: SymbolView,
    pub outgoing: Vec<NeighborView>,
    pub incoming: Vec<NeighborView>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TraceNode {
    pub distance: usize,
    pub via: String,
    pub symbol: SymbolView,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TraceResult {
    pub root: SymbolView,
    pub nodes: Vec<TraceNode>,
}

fn default_symbol_limit() -> usize {
    50
}

fn default_trace_depth() -> usize {
    2
}

pub fn language_name_for_path(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".tsx") {
        Some("tsx")
    } else if lower.ends_with(".ts") || lower.ends_with(".mts") || lower.ends_with(".cts") {
        Some("typescript")
    } else if lower.ends_with(".js")
        || lower.ends_with(".jsx")
        || lower.ends_with(".mjs")
        || lower.ends_with(".cjs")
    {
        Some("javascript")
    } else if lower.ends_with(".py") || lower.ends_with(".pyi") {
        Some("python")
    } else if lower.ends_with(".rs") {
        Some("rust")
    } else {
        None
    }
}

fn language_spec(path: &str) -> Option<LanguageSpec> {
    match language_name_for_path(path)? {
        "rust" => Some(LanguageSpec {
            name: "rust",
            language: tree_sitter_rust::LANGUAGE.into(),
            tags_query: tree_sitter_rust::TAGS_QUERY,
        }),
        "python" => Some(LanguageSpec {
            name: "python",
            language: tree_sitter_python::LANGUAGE.into(),
            tags_query: tree_sitter_python::TAGS_QUERY,
        }),
        "javascript" => Some(LanguageSpec {
            name: "javascript",
            language: tree_sitter_javascript::LANGUAGE.into(),
            tags_query: tree_sitter_javascript::TAGS_QUERY,
        }),
        "typescript" => Some(LanguageSpec {
            name: "typescript",
            language: tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            tags_query: TYPESCRIPT_TAGS_QUERY,
        }),
        "tsx" => Some(LanguageSpec {
            name: "tsx",
            language: tree_sitter_typescript::LANGUAGE_TSX.into(),
            tags_query: TYPESCRIPT_TAGS_QUERY,
        }),
        _ => None,
    }
}

fn node_text<'a>(node: Node<'_>, source: &'a [u8]) -> AppResult<&'a str> {
    node.utf8_text(source)
        .map_err(|_| AppError::InvalidRequest("Tree-sitter returned invalid UTF-8 span".into()))
}

fn clipped_signature(text: &str) -> String {
    let first = text.lines().next().unwrap_or("").trim();
    if first.chars().count() <= 300 {
        first.to_string()
    } else {
        first.chars().take(300).collect()
    }
}

fn sha256(input: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(input.as_ref()))
}

fn normalize_ast_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn definition_priority(kind: &str) -> u8 {
    match kind {
        "method" => 8,
        "function" => 7,
        "class" => 6,
        "interface" => 5,
        "module" => 4,
        "macro" => 3,
        _ => 1,
    }
}

fn extract_raw(
    spec: &LanguageSpec,
    source: &[u8],
    tree: &tree_sitter::Tree,
) -> AppResult<(Vec<RawDefinition>, Vec<RawReference>)> {
    let query = Query::new(&spec.language, spec.tags_query)
        .map_err(|e| AppError::InvalidRequest(format!("invalid {} tags query: {e}", spec.name)))?;
    let capture_names = query.capture_names();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, tree.root_node(), source);
    let mut definitions: HashMap<(usize, usize, String), RawDefinition> = HashMap::new();
    let mut references = Vec::new();

    while let Some(query_match) = matches.next() {
        let mut name_node = None;
        let mut definition = None;
        let mut reference = None;

        for capture in query_match.captures {
            let capture_name = capture_names[capture.index as usize];
            if capture_name == "name" {
                name_node = Some(capture.node);
            } else if let Some(kind) = capture_name.strip_prefix("definition.") {
                definition = Some((kind.to_string(), capture.node));
            } else if let Some(reference_type) = capture_name.strip_prefix("reference.") {
                reference = Some((reference_type.to_string(), capture.node));
            }
        }

        let Some(name_node) = name_node else {
            continue;
        };
        let name = node_text(name_node, source)?.trim().to_string();
        if name.is_empty() {
            continue;
        }

        if let Some((kind, node)) = definition {
            let text = node_text(node, source)?;
            let key = (node.start_byte(), node.end_byte(), name.clone());
            let candidate = RawDefinition {
                name,
                kind: kind.clone(),
                start_byte: node.start_byte(),
                end_byte: node.end_byte(),
                start_line: node.start_position().row as i64 + 1,
                end_line: node.end_position().row as i64 + 1,
                signature: clipped_signature(text),
                content_hash: sha256(text),
                ast_hash: sha256(normalize_ast_text(text)),
            };
            match definitions.get(&key) {
                Some(existing)
                    if definition_priority(&existing.kind) >= definition_priority(&kind) => {}
                _ => {
                    definitions.insert(key, candidate);
                }
            }
        } else if let Some((reference_type, node)) = reference {
            references.push(RawReference {
                name,
                reference_type,
                start_byte: node.start_byte(),
                end_byte: node.end_byte(),
                line: name_node.start_position().row as i64 + 1,
            });
        }
    }

    let mut definitions: Vec<_> = definitions.into_values().collect();
    definitions.sort_by_key(|item| (item.start_byte, usize::MAX - item.end_byte));
    Ok((definitions, references))
}

fn parent_indices(definitions: &[RawDefinition]) -> Vec<Option<usize>> {
    let mut parents = vec![None; definitions.len()];
    for (child_index, child) in definitions.iter().enumerate() {
        let mut best: Option<(usize, usize)> = None;
        for (candidate_index, candidate) in definitions.iter().enumerate() {
            if child_index == candidate_index {
                continue;
            }
            if candidate.start_byte <= child.start_byte && candidate.end_byte >= child.end_byte {
                let candidate_span = candidate.end_byte.saturating_sub(candidate.start_byte);
                let child_span = child.end_byte.saturating_sub(child.start_byte);
                if candidate_span <= child_span {
                    continue;
                }
                if best.is_none_or(|(_, span)| candidate_span < span) {
                    best = Some((candidate_index, candidate_span));
                }
            }
        }
        parents[child_index] = best.map(|(index, _)| index);
    }
    parents
}

fn qualified_name_for(
    index: usize,
    path: &str,
    definitions: &[RawDefinition],
    parents: &[Option<usize>],
    cache: &mut [Option<String>],
) -> String {
    if let Some(value) = &cache[index] {
        return value.clone();
    }
    let prefix = match parents[index] {
        Some(parent) => qualified_name_for(parent, path, definitions, parents, cache),
        None => path.to_string(),
    };
    let value = format!("{prefix}::{}", definitions[index].name);
    cache[index] = Some(value.clone());
    value
}

fn symbol_key(
    language: &str,
    path: &str,
    kind: &str,
    qualified_name: &str,
    ordinal: usize,
) -> String {
    let suffix = if ordinal == 0 {
        String::new()
    } else {
        format!("#{ordinal}")
    };
    format!(
        "sym:{}",
        sha256(format!("{language}|{path}|{kind}|{qualified_name}{suffix}"))
    )
}

fn assemble_file_graph(
    path: &str,
    content: &str,
    spec: LanguageSpec,
) -> AppResult<ParsedFileGraph> {
    let mut parser = Parser::new();
    parser.set_language(&spec.language).map_err(|e| {
        AppError::InvalidRequest(format!("failed to load {} parser: {e}", spec.name))
    })?;
    let tree = parser.parse(content, None).ok_or_else(|| {
        AppError::InvalidRequest(format!("{} parser returned no tree", spec.name))
    })?;
    let source = content.as_bytes();
    let (definitions, raw_references) = extract_raw(&spec, source, &tree)?;
    let parents = parent_indices(&definitions);
    let mut qualified_cache = vec![None; definitions.len()];
    let mut duplicate_ordinals: HashMap<(String, String), usize> = HashMap::new();
    let file_key = format!("file:{}", sha256(format!("{}|{path}", spec.name)));
    let file_lines = content.lines().count().max(1) as i64;
    let mut symbols = Vec::with_capacity(definitions.len() + 1);
    symbols.push(ParsedSymbol {
        symbol_key: file_key.clone(),
        qualified_name: path.to_string(),
        name: path.rsplit('/').next().unwrap_or(path).to_string(),
        kind: "file".into(),
        start_line: 1,
        end_line: file_lines,
        signature: path.to_string(),
        content_hash: sha256(content),
        ast_hash: sha256(normalize_ast_text(content)),
        parent_key: None,
    });

    let mut definition_keys = Vec::with_capacity(definitions.len());
    for index in 0..definitions.len() {
        let qualified_name =
            qualified_name_for(index, path, &definitions, &parents, &mut qualified_cache);
        let duplicate_key = (definitions[index].kind.clone(), qualified_name.clone());
        let ordinal = duplicate_ordinals.entry(duplicate_key).or_insert(0);
        let key = symbol_key(
            spec.name,
            path,
            &definitions[index].kind,
            &qualified_name,
            *ordinal,
        );
        *ordinal += 1;
        definition_keys.push(key.clone());
        symbols.push(ParsedSymbol {
            symbol_key: key,
            qualified_name,
            name: definitions[index].name.clone(),
            kind: definitions[index].kind.clone(),
            start_line: definitions[index].start_line,
            end_line: definitions[index].end_line,
            signature: definitions[index].signature.clone(),
            content_hash: definitions[index].content_hash.clone(),
            ast_hash: definitions[index].ast_hash.clone(),
            parent_key: None,
        });
    }

    for (index, parent) in parents.iter().enumerate() {
        symbols[index + 1].parent_key = Some(match parent {
            Some(parent_index) => definition_keys[*parent_index].clone(),
            None => file_key.clone(),
        });
    }

    let references = raw_references
        .into_iter()
        .map(|reference| {
            let source_key = definitions
                .iter()
                .enumerate()
                .filter(|(_, definition)| {
                    definition.start_byte <= reference.start_byte
                        && definition.end_byte >= reference.end_byte
                })
                .min_by_key(|(_, definition)| definition.end_byte - definition.start_byte)
                .map(|(index, _)| definition_keys[index].clone())
                .unwrap_or_else(|| file_key.clone());
            ParsedReference {
                source_key,
                reference_type: reference.reference_type,
                name: reference.name,
                line: reference.line,
            }
        })
        .collect();

    let has_error = tree.root_node().has_error();
    Ok(ParsedFileGraph {
        language: spec.name.to_string(),
        status: if has_error { "partial" } else { "ok" }.into(),
        error: has_error.then(|| "syntax tree contains error nodes".into()),
        symbols,
        references,
    })
}

async fn set_graph_file_error(
    pool: &SqlitePool,
    workspace_id: &str,
    file_id: i64,
    language: &str,
    content_hash: &str,
    error: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO graph_file_state(workspace_id, file_id, language, content_hash, status, error, parsed_at) \
         VALUES(?1, ?2, ?3, ?4, 'error', ?5, unixepoch()) \
         ON CONFLICT(workspace_id, file_id) DO UPDATE SET language=excluded.language, content_hash=excluded.content_hash, status='error', error=excluded.error, parsed_at=unixepoch()",
    )
    .bind(workspace_id)
    .bind(file_id)
    .bind(language)
    .bind(content_hash)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(())
}

async fn insert_parsed_file(
    tx: &mut Transaction<'_, Sqlite>,
    workspace: &Workspace,
    file_id: i64,
    content_hash: &str,
    parsed: &ParsedFileGraph,
) -> AppResult<()> {
    sqlx::query("DELETE FROM symbols WHERE workspace_id=?1 AND file_id=?2")
        .bind(&workspace.id)
        .bind(file_id)
        .execute(&mut **tx)
        .await?;

    let mut ids = HashMap::new();
    for symbol in &parsed.symbols {
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO symbols(workspace_id, file_id, symbol_key, qualified_name, name, kind, language, start_line, end_line, signature, content_hash, ast_hash) \
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) RETURNING id",
        )
        .bind(&workspace.id)
        .bind(file_id)
        .bind(&symbol.symbol_key)
        .bind(&symbol.qualified_name)
        .bind(&symbol.name)
        .bind(&symbol.kind)
        .bind(&parsed.language)
        .bind(symbol.start_line)
        .bind(symbol.end_line)
        .bind(&symbol.signature)
        .bind(&symbol.content_hash)
        .bind(&symbol.ast_hash)
        .fetch_one(&mut **tx)
        .await?;
        ids.insert(symbol.symbol_key.clone(), id);
    }

    for symbol in &parsed.symbols {
        let Some(parent_key) = &symbol.parent_key else {
            continue;
        };
        let Some(source_id) = ids.get(parent_key) else {
            continue;
        };
        let Some(target_id) = ids.get(&symbol.symbol_key) else {
            continue;
        };
        sqlx::query(
            "INSERT OR IGNORE INTO edges(workspace_id, source_symbol_id, target_symbol_id, edge_type, confidence, source) \
             VALUES(?1, ?2, ?3, 'CONTAINS', 1.0, 'parser')",
        )
        .bind(&workspace.id)
        .bind(source_id)
        .bind(target_id)
        .execute(&mut **tx)
        .await?;
    }

    for reference in &parsed.references {
        let Some(source_id) = ids.get(&reference.source_key) else {
            continue;
        };
        sqlx::query(
            "INSERT OR IGNORE INTO symbol_references(workspace_id, source_symbol_id, reference_type, name, line, confidence) \
             VALUES(?1, ?2, ?3, ?4, ?5, 0.0)",
        )
        .bind(&workspace.id)
        .bind(source_id)
        .bind(&reference.reference_type)
        .bind(&reference.name)
        .bind(reference.line)
        .execute(&mut **tx)
        .await?;
    }

    sqlx::query(
        "INSERT INTO graph_file_state(workspace_id, file_id, language, content_hash, status, error, parsed_at) \
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, unixepoch()) \
         ON CONFLICT(workspace_id, file_id) DO UPDATE SET language=excluded.language, content_hash=excluded.content_hash, status=excluded.status, error=excluded.error, parsed_at=unixepoch()",
    )
    .bind(&workspace.id)
    .bind(file_id)
    .bind(&parsed.language)
    .bind(content_hash)
    .bind(&parsed.status)
    .bind(&parsed.error)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn edge_type_for_reference(reference_type: &str) -> &'static str {
    match reference_type {
        "call" => "CALLS",
        "implementation" => "IMPLEMENTS",
        _ => "REFERENCES",
    }
}

async fn resolve_references(pool: &SqlitePool, workspace_id: &str) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM edges WHERE workspace_id=?1 AND source='resolver'")
        .bind(workspace_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE symbol_references SET target_symbol_id=NULL, confidence=0.0 WHERE workspace_id=?1",
    )
    .bind(workspace_id)
    .execute(&mut *tx)
    .await?;

    let symbols: Vec<(i64, i64, String)> = sqlx::query_as(
        "SELECT id, file_id, name FROM symbols WHERE workspace_id=?1 AND kind!='file'",
    )
    .bind(workspace_id)
    .fetch_all(&mut *tx)
    .await?;
    let mut by_name: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
    for (id, file_id, name) in symbols {
        by_name.entry(name).or_default().push((id, file_id));
    }

    let references: Vec<(i64, i64, i64, String, String)> = sqlx::query_as(
        "SELECT r.id, r.source_symbol_id, s.file_id, r.reference_type, r.name \
         FROM symbol_references r JOIN symbols s ON s.id=r.source_symbol_id \
         WHERE r.workspace_id=?1",
    )
    .bind(workspace_id)
    .fetch_all(&mut *tx)
    .await?;

    for (reference_id, source_id, source_file_id, reference_type, name) in references {
        let Some(candidates) = by_name.get(&name) else {
            continue;
        };
        let same_file: Vec<_> = candidates
            .iter()
            .copied()
            .filter(|(id, file_id)| *file_id == source_file_id && *id != source_id)
            .collect();
        let (target_id, confidence) = if same_file.len() == 1 {
            (same_file[0].0, 0.9)
        } else {
            let global: Vec<_> = candidates
                .iter()
                .copied()
                .filter(|(id, _)| *id != source_id)
                .collect();
            if global.len() == 1 {
                (global[0].0, 0.75)
            } else {
                continue;
            }
        };
        sqlx::query("UPDATE symbol_references SET target_symbol_id=?1, confidence=?2 WHERE id=?3")
            .bind(target_id)
            .bind(confidence)
            .bind(reference_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT OR IGNORE INTO edges(workspace_id, source_symbol_id, target_symbol_id, edge_type, confidence, source) \
             VALUES(?1, ?2, ?3, ?4, ?5, 'resolver')",
        )
        .bind(workspace_id)
        .bind(source_id)
        .bind(target_id)
        .bind(edge_type_for_reference(&reference_type))
        .bind(confidence)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn sync_paths(
    pool: &SqlitePool,
    workspace: &Workspace,
    paths: &[String],
) -> AppResult<GraphSyncSummary> {
    let mut parsed_files = 0u64;
    let mut partial_files = 0u64;
    let mut failed_files = 0u64;

    for path in paths {
        let Some(spec) = language_spec(path) else {
            continue;
        };
        let row: Option<(i64, Option<String>, String)> = sqlx::query_as(
            "SELECT id, content, content_hash FROM files WHERE workspace_id=?1 AND path=?2",
        )
        .bind(&workspace.id)
        .bind(path)
        .fetch_optional(pool)
        .await?;
        let Some((file_id, content, content_hash)) = row else {
            continue;
        };
        let Some(content) = content else {
            continue;
        };

        match assemble_file_graph(path, &content, spec.clone()) {
            Ok(parsed) => {
                let mut tx = pool.begin().await?;
                sqlx::query("UPDATE files SET language=?1 WHERE id=?2")
                    .bind(&parsed.language)
                    .bind(file_id)
                    .execute(&mut *tx)
                    .await?;
                insert_parsed_file(&mut tx, workspace, file_id, &content_hash, &parsed).await?;
                tx.commit().await?;
                parsed_files += 1;
                if parsed.status == "partial" {
                    partial_files += 1;
                }
            }
            Err(error) => {
                failed_files += 1;
                set_graph_file_error(
                    pool,
                    &workspace.id,
                    file_id,
                    spec.name,
                    &content_hash,
                    &error.to_string(),
                )
                .await?;
            }
        }
    }

    resolve_references(pool, &workspace.id).await?;
    sqlx::query(
        "UPDATE workspaces SET graph_version=graph_version+1, updated_at=unixepoch() WHERE id=?1",
    )
    .bind(&workspace.id)
    .execute(pool)
    .await?;

    let symbols: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM symbols WHERE workspace_id=?1")
        .bind(&workspace.id)
        .fetch_one(pool)
        .await?;
    let edges: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM edges WHERE workspace_id=?1")
        .bind(&workspace.id)
        .fetch_one(pool)
        .await?;
    let unresolved: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM symbol_references WHERE workspace_id=?1 AND target_symbol_id IS NULL",
    )
    .bind(&workspace.id)
    .fetch_one(pool)
    .await?;

    Ok(GraphSyncSummary {
        parsed_files,
        partial_files,
        failed_files,
        symbols: symbols.max(0) as u64,
        edges: edges.max(0) as u64,
        unresolved_references: unresolved.max(0) as u64,
    })
}

async fn symbol_by_key(pool: &SqlitePool, workspace_id: &str, key: &str) -> AppResult<SymbolView> {
    let row: Option<SymbolRow> = sqlx::query_as(
        "SELECT s.symbol_key, s.qualified_name, s.name, s.kind, s.language, f.path, s.start_line, s.end_line, s.signature \
         FROM symbols s JOIN files f ON f.id=s.file_id \
         WHERE s.workspace_id=?1 AND s.symbol_key=?2",
    )
    .bind(workspace_id)
    .bind(key)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Err(AppError::InvalidRequest(format!("symbol not found: {key}")));
    };
    Ok(SymbolView {
        symbol_key: row.0,
        qualified_name: row.1,
        name: row.2,
        kind: row.3,
        language: row.4,
        path: row.5,
        start_line: row.6,
        end_line: row.7,
        signature: row.8,
    })
}

pub async fn status(state: &AppState, workspace_id: &str) -> AppResult<GraphStatus> {
    state.workspaces.get(workspace_id)?;
    let workspace_row: (i64, Option<String>) =
        sqlx::query_as("SELECT graph_version, indexed_head FROM workspaces WHERE id=?1")
            .bind(workspace_id)
            .fetch_one(&state.db)
            .await?;
    let supported_files: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM files WHERE workspace_id=?1 AND language IS NOT NULL",
    )
    .bind(workspace_id)
    .fetch_one(&state.db)
    .await?;
    let parsed_files: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM graph_file_state WHERE workspace_id=?1 AND status='ok'",
    )
    .bind(workspace_id)
    .fetch_one(&state.db)
    .await?;
    let partial_files: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM graph_file_state WHERE workspace_id=?1 AND status='partial'",
    )
    .bind(workspace_id)
    .fetch_one(&state.db)
    .await?;
    let failed_files: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM graph_file_state WHERE workspace_id=?1 AND status='error'",
    )
    .bind(workspace_id)
    .fetch_one(&state.db)
    .await?;
    let symbols: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM symbols WHERE workspace_id=?1")
        .bind(workspace_id)
        .fetch_one(&state.db)
        .await?;
    let edges: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM edges WHERE workspace_id=?1")
        .bind(workspace_id)
        .fetch_one(&state.db)
        .await?;
    let unresolved_references: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM symbol_references WHERE workspace_id=?1 AND target_symbol_id IS NULL",
    )
    .bind(workspace_id)
    .fetch_one(&state.db)
    .await?;

    Ok(GraphStatus {
        workspace: workspace_id.to_string(),
        graph_version: workspace_row.0,
        indexed_head: workspace_row.1,
        supported_files: supported_files.max(0) as u64,
        parsed_files: parsed_files.max(0) as u64,
        partial_files: partial_files.max(0) as u64,
        failed_files: failed_files.max(0) as u64,
        symbols: symbols.max(0) as u64,
        edges: edges.max(0) as u64,
        unresolved_references: unresolved_references.max(0) as u64,
    })
}

pub async fn search_symbols(
    state: &AppState,
    req: SymbolSearchRequest,
) -> AppResult<SymbolSearchResult> {
    state.workspaces.get(&req.workspace)?;
    if req.query.trim().is_empty() {
        return Err(AppError::InvalidRequest("query must not be empty".into()));
    }
    let limit = req.limit.clamp(1, MAX_GRAPH_QUERY_RESULTS) as i64;
    let like = format!("%{}%", req.query.trim());
    let rows: Vec<SymbolRow> = if let Some(kind) = req.kind {
        sqlx::query_as(
            "SELECT s.symbol_key, s.qualified_name, s.name, s.kind, s.language, f.path, s.start_line, s.end_line, s.signature \
             FROM symbols s JOIN files f ON f.id=s.file_id \
             WHERE s.workspace_id=?1 AND s.kind=?2 AND (s.name LIKE ?3 OR s.qualified_name LIKE ?3) \
             ORDER BY CASE WHEN s.name=?4 THEN 0 ELSE 1 END, length(s.qualified_name), s.qualified_name LIMIT ?5",
        )
        .bind(&req.workspace)
        .bind(kind)
        .bind(&like)
        .bind(req.query.trim())
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as(
            "SELECT s.symbol_key, s.qualified_name, s.name, s.kind, s.language, f.path, s.start_line, s.end_line, s.signature \
             FROM symbols s JOIN files f ON f.id=s.file_id \
             WHERE s.workspace_id=?1 AND (s.name LIKE ?2 OR s.qualified_name LIKE ?2) \
             ORDER BY CASE WHEN s.name=?3 THEN 0 ELSE 1 END, length(s.qualified_name), s.qualified_name LIMIT ?4",
        )
        .bind(&req.workspace)
        .bind(&like)
        .bind(req.query.trim())
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    };
    Ok(SymbolSearchResult {
        symbols: rows
            .into_iter()
            .map(|row| SymbolView {
                symbol_key: row.0,
                qualified_name: row.1,
                name: row.2,
                kind: row.3,
                language: row.4,
                path: row.5,
                start_line: row.6,
                end_line: row.7,
                signature: row.8,
            })
            .collect(),
    })
}

async fn neighbors(
    pool: &SqlitePool,
    workspace_id: &str,
    symbol_key: &str,
    outgoing: bool,
    edge_filter: Option<&str>,
) -> AppResult<Vec<NeighborView>> {
    let id: i64 =
        sqlx::query_scalar("SELECT id FROM symbols WHERE workspace_id=?1 AND symbol_key=?2")
            .bind(workspace_id)
            .bind(symbol_key)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::InvalidRequest(format!("symbol not found: {symbol_key}")))?;

    let rows: Vec<(String, f64, String)> = match (outgoing, edge_filter) {
        (true, Some(edge_type)) => sqlx::query_as(
            "SELECT e.edge_type, e.confidence, target.symbol_key FROM edges e JOIN symbols target ON target.id=e.target_symbol_id \
             WHERE e.workspace_id=?1 AND e.source_symbol_id=?2 AND e.edge_type=?3 ORDER BY target.qualified_name LIMIT 200",
        )
        .bind(workspace_id)
        .bind(id)
        .bind(edge_type)
        .fetch_all(pool)
        .await?,
        (true, None) => sqlx::query_as(
            "SELECT e.edge_type, e.confidence, target.symbol_key FROM edges e JOIN symbols target ON target.id=e.target_symbol_id \
             WHERE e.workspace_id=?1 AND e.source_symbol_id=?2 ORDER BY e.edge_type, target.qualified_name LIMIT 200",
        )
        .bind(workspace_id)
        .bind(id)
        .fetch_all(pool)
        .await?,
        (false, Some(edge_type)) => sqlx::query_as(
            "SELECT e.edge_type, e.confidence, source.symbol_key FROM edges e JOIN symbols source ON source.id=e.source_symbol_id \
             WHERE e.workspace_id=?1 AND e.target_symbol_id=?2 AND e.edge_type=?3 ORDER BY source.qualified_name LIMIT 200",
        )
        .bind(workspace_id)
        .bind(id)
        .bind(edge_type)
        .fetch_all(pool)
        .await?,
        (false, None) => sqlx::query_as(
            "SELECT e.edge_type, e.confidence, source.symbol_key FROM edges e JOIN symbols source ON source.id=e.source_symbol_id \
             WHERE e.workspace_id=?1 AND e.target_symbol_id=?2 ORDER BY e.edge_type, source.qualified_name LIMIT 200",
        )
        .bind(workspace_id)
        .bind(id)
        .fetch_all(pool)
        .await?,
    };

    let mut result = Vec::with_capacity(rows.len());
    for (edge_type, confidence, key) in rows {
        result.push(NeighborView {
            edge_type,
            confidence,
            symbol: symbol_by_key(pool, workspace_id, &key).await?,
        });
    }
    Ok(result)
}

pub async fn symbol_context(state: &AppState, req: SymbolKeyRequest) -> AppResult<SymbolContext> {
    state.workspaces.get(&req.workspace)?;
    let symbol = symbol_by_key(&state.db, &req.workspace, &req.symbol_key).await?;
    let outgoing = neighbors(&state.db, &req.workspace, &req.symbol_key, true, None).await?;
    let incoming = neighbors(&state.db, &req.workspace, &req.symbol_key, false, None).await?;
    Ok(SymbolContext {
        symbol,
        outgoing,
        incoming,
    })
}

async fn trace_direction(
    state: &AppState,
    req: TraceRequest,
    outgoing: bool,
    edge_filter: Option<&str>,
) -> AppResult<TraceResult> {
    state.workspaces.get(&req.workspace)?;
    let depth = req.depth.clamp(1, MAX_TRACE_DEPTH);
    let root = symbol_by_key(&state.db, &req.workspace, &req.symbol_key).await?;
    let mut visited: HashSet<String> = HashSet::from([req.symbol_key.clone()]);
    let mut queue = VecDeque::from([(req.symbol_key.clone(), 0usize)]);
    let mut nodes = Vec::new();

    while let Some((key, distance)) = queue.pop_front() {
        if distance >= depth || nodes.len() >= MAX_GRAPH_QUERY_RESULTS {
            continue;
        }
        for neighbor in neighbors(&state.db, &req.workspace, &key, outgoing, edge_filter).await? {
            if !visited.insert(neighbor.symbol.symbol_key.clone()) {
                continue;
            }
            let next_distance = distance + 1;
            queue.push_back((neighbor.symbol.symbol_key.clone(), next_distance));
            nodes.push(TraceNode {
                distance: next_distance,
                via: neighbor.edge_type,
                symbol: neighbor.symbol,
            });
            if nodes.len() >= MAX_GRAPH_QUERY_RESULTS {
                break;
            }
        }
    }
    Ok(TraceResult { root, nodes })
}

pub async fn trace_callers(state: &AppState, req: TraceRequest) -> AppResult<TraceResult> {
    trace_direction(state, req, false, Some("CALLS")).await
}

pub async fn trace_callees(state: &AppState, req: TraceRequest) -> AppResult<TraceResult> {
    trace_direction(state, req, true, Some("CALLS")).await
}

pub async fn references(state: &AppState, req: TraceRequest) -> AppResult<TraceResult> {
    trace_direction(state, req, false, None).await
}

pub async fn impact_analysis(state: &AppState, req: TraceRequest) -> AppResult<TraceResult> {
    trace_direction(state, req, false, None).await
}

#[cfg(test)]
mod tests {
    use super::{assemble_file_graph, language_name_for_path, language_spec};

    #[test]
    fn detects_supported_languages() {
        assert_eq!(language_name_for_path("src/a.rs"), Some("rust"));
        assert_eq!(language_name_for_path("src/a.tsx"), Some("tsx"));
        assert_eq!(language_name_for_path("src/a.ts"), Some("typescript"));
        assert_eq!(language_name_for_path("src/a.py"), Some("python"));
        assert_eq!(language_name_for_path("src/a.js"), Some("javascript"));
        assert_eq!(language_name_for_path("README.md"), None);
    }

    #[test]
    fn extracts_rust_definitions_and_calls() {
        let source = "fn helper() {}\nfn run() { helper(); }\n";
        let graph = assemble_file_graph("src/lib.rs", source, language_spec("src/lib.rs").unwrap())
            .expect("parse rust graph");
        assert!(graph.symbols.iter().any(|symbol| symbol.name == "helper"));
        assert!(graph.symbols.iter().any(|symbol| symbol.name == "run"));
        assert!(
            graph
                .references
                .iter()
                .any(|reference| reference.name == "helper")
        );
    }

    #[test]
    fn extracts_typescript_class_and_method() {
        let source = "class UserService { find(id: string) { return id; } }";
        let graph =
            assemble_file_graph("src/user.ts", source, language_spec("src/user.ts").unwrap())
                .expect("parse typescript graph");
        assert!(
            graph
                .symbols
                .iter()
                .any(|symbol| symbol.name == "UserService")
        );
        assert!(graph.symbols.iter().any(|symbol| symbol.name == "find"));
    }
}
