use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
};

use sqlx::{Sqlite, SqlitePool, Transaction};
use tree_sitter::{Language, Node, Parser, Query, QueryCursor, StreamingIterator};

use crate::{
    error::{AppError, AppResult},
    graph,
    workspace::Workspace,
};

const JAVASCRIPT_QUERY: &str = r#"
(import_statement
  source: (string) @target) @relation.import

(class_declaration
  name: (identifier) @source
  (class_heritage
    (_) @target)) @relation.extends
"#;

const TYPESCRIPT_QUERY: &str = r#"
(import_statement
  source: (string) @target) @relation.import

(class_declaration
  name: (_) @source
  (class_heritage
    (extends_clause
      value: (_) @target))) @relation.extends

(abstract_class_declaration
  name: (_) @source
  (class_heritage
    (extends_clause
      value: (_) @target))) @relation.extends

(class_declaration
  name: (_) @source
  (class_heritage
    (implements_clause
      (_) @target))) @relation.implements

(abstract_class_declaration
  name: (_) @source
  (class_heritage
    (implements_clause
      (_) @target))) @relation.implements

(interface_declaration
  name: (type_identifier) @source
  (extends_type_clause
    type: (_) @target)) @relation.extends
"#;

const PYTHON_QUERY: &str = r#"
(import_statement
  (dotted_name) @target) @relation.import

(import_statement
  (aliased_import
    name: (dotted_name) @target)) @relation.import

(import_from_statement
  module_name: [(dotted_name) (relative_import)] @target) @relation.import

(class_definition
  name: (identifier) @source
  superclasses: (argument_list
    (identifier) @target)) @relation.extends

(class_definition
  name: (identifier) @source
  superclasses: (argument_list
    (attribute) @target)) @relation.extends
"#;

const RUST_QUERY: &str = r#"
(use_declaration
  argument: (_) @target) @relation.import

(extern_crate_declaration
  name: (identifier) @target) @relation.import

(mod_item
  name: (identifier) @target
  !body) @relation.import

(impl_item
  trait: (_) @target
  type: (_) @source) @relation.implements
"#;

#[derive(Debug, Clone)]
struct LanguageSpec {
    name: &'static str,
    language: Language,
    query: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ParsedReference {
    source_name: Option<String>,
    relation_type: String,
    target_name: Option<String>,
    import_path: Option<String>,
    line: i64,
}

#[derive(Debug, Clone)]
struct StoredReference {
    source_file_id: i64,
    source_symbol_key: String,
    relation_type: String,
    target_name: Option<String>,
    import_path: Option<String>,
    source_path: String,
    language: String,
}

#[derive(Debug, Clone, Copy)]
struct SymbolCandidate {
    id: i64,
    file_id: i64,
}

fn language_spec(path: &str) -> Option<LanguageSpec> {
    match graph::language_name_for_path(path)? {
        "javascript" => Some(LanguageSpec {
            name: "javascript",
            language: tree_sitter_javascript::LANGUAGE.into(),
            query: JAVASCRIPT_QUERY,
        }),
        "typescript" => Some(LanguageSpec {
            name: "typescript",
            language: tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            query: TYPESCRIPT_QUERY,
        }),
        "tsx" => Some(LanguageSpec {
            name: "tsx",
            language: tree_sitter_typescript::LANGUAGE_TSX.into(),
            query: TYPESCRIPT_QUERY,
        }),
        "python" => Some(LanguageSpec {
            name: "python",
            language: tree_sitter_python::LANGUAGE.into(),
            query: PYTHON_QUERY,
        }),
        "rust" => Some(LanguageSpec {
            name: "rust",
            language: tree_sitter_rust::LANGUAGE.into(),
            query: RUST_QUERY,
        }),
        _ => None,
    }
}

fn node_text<'a>(node: Node<'_>, source: &'a [u8]) -> AppResult<&'a str> {
    node.utf8_text(source)
        .map_err(|_| AppError::InvalidRequest("Tree-sitter returned invalid UTF-8 span".into()))
}

fn strip_quotes(value: &str) -> String {
    let value = value.trim();
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'')
            || (bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"'))
    {
        value[1..value.len() - 1].to_string()
    } else {
        value.to_string()
    }
}

fn terminal_symbol_name(value: &str) -> String {
    let value = value.trim();
    let value = value.split('<').next().unwrap_or(value).trim();
    let value = value
        .trim_start_matches('(')
        .trim_end_matches(')')
        .trim();
    value
        .rsplit(|character: char| matches!(character, '.' | ':' | '/' | '\\'))
        .find(|part| !part.trim().is_empty())
        .unwrap_or(value)
        .trim()
        .trim_matches(|character: char| {
            matches!(character, '(' | ')' | '[' | ']' | '{' | '}' | '&' | '*')
        })
        .to_string()
}

fn relation_name(capture_name: &str) -> Option<&'static str> {
    match capture_name {
        "relation.import" => Some("IMPORTS"),
        "relation.extends" => Some("EXTENDS"),
        "relation.implements" => Some("IMPLEMENTS"),
        _ => None,
    }
}

fn parse_references(path: &str, content: &str) -> AppResult<Vec<ParsedReference>> {
    let Some(spec) = language_spec(path) else {
        return Ok(Vec::new());
    };
    let mut parser = Parser::new();
    parser.set_language(&spec.language).map_err(|error| {
        AppError::InvalidRequest(format!("failed to load {} semantic parser: {error}", spec.name))
    })?;
    let tree = parser.parse(content, None).ok_or_else(|| {
        AppError::InvalidRequest(format!("{} semantic parser returned no tree", spec.name))
    })?;
    if tree.root_node().has_error() {
        return Err(AppError::InvalidRequest(format!(
            "{} semantic parse contains syntax errors",
            spec.name
        )));
    }

    let source = content.as_bytes();
    let query = Query::new(&spec.language, spec.query).map_err(|error| {
        AppError::InvalidRequest(format!("invalid {} structural query: {error}", spec.name))
    })?;
    let capture_names = query.capture_names();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, tree.root_node(), source);
    let mut references = HashSet::new();

    while let Some(query_match) = matches.next() {
        let mut source_node = None;
        let mut target_node = None;
        let mut relation_type = None;
        for capture in query_match.captures {
            let capture_name = capture_names[capture.index as usize];
            match capture_name {
                "source" => source_node = Some(capture.node),
                "target" => target_node = Some(capture.node),
                other => {
                    if let Some(value) = relation_name(other) {
                        relation_type = Some(value);
                    }
                }
            }
        }
        let (Some(target_node), Some(relation_type)) = (target_node, relation_type) else {
            continue;
        };
        let target_text = node_text(target_node, source)?.trim();
        if target_text.is_empty() {
            continue;
        }
        let source_name = source_node
            .map(|node| node_text(node, source))
            .transpose()?
            .map(terminal_symbol_name)
            .filter(|name| !name.is_empty());
        let (target_name, import_path) = if relation_type == "IMPORTS" {
            (None, Some(strip_quotes(target_text)))
        } else {
            let target_name = terminal_symbol_name(target_text);
            if target_name.is_empty() {
                continue;
            }
            (Some(target_name), None)
        };
        references.insert(ParsedReference {
            source_name,
            relation_type: relation_type.to_string(),
            target_name,
            import_path,
            line: target_node.start_position().row as i64 + 1,
        });
    }

    let mut references: Vec<_> = references.into_iter().collect();
    references.sort_by(|left, right| {
        left.line
            .cmp(&right.line)
            .then_with(|| left.relation_type.cmp(&right.relation_type))
            .then_with(|| left.target_name.cmp(&right.target_name))
            .then_with(|| left.import_path.cmp(&right.import_path))
    });
    Ok(references)
}

async fn replace_file_references(
    pool: &SqlitePool,
    workspace: &Workspace,
    file_id: i64,
    references: &[ParsedReference],
) -> AppResult<()> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT symbol_key, name, kind FROM symbols WHERE workspace_id=?1 AND file_id=?2",
    )
    .bind(&workspace.id)
    .bind(file_id)
    .fetch_all(pool)
    .await?;
    let file_key = rows
        .iter()
        .find(|(_, _, kind)| kind == "file")
        .map(|(key, _, _)| key.clone());
    let mut symbols_by_name: HashMap<String, Vec<String>> = HashMap::new();
    for (key, name, kind) in rows {
        if kind != "file" {
            symbols_by_name.entry(name).or_default().push(key);
        }
    }

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM structural_references WHERE workspace_id=?1 AND source_file_id=?2")
        .bind(&workspace.id)
        .bind(file_id)
        .execute(&mut *tx)
        .await?;

    for reference in references {
        let source_symbol_key = match &reference.source_name {
            None => file_key.clone(),
            Some(name) => symbols_by_name
                .get(name)
                .filter(|matches| matches.len() == 1)
                .and_then(|matches| matches.first().cloned()),
        };
        let Some(source_symbol_key) = source_symbol_key else {
            continue;
        };
        sqlx::query(
            "INSERT OR IGNORE INTO structural_references(\
               workspace_id, source_file_id, source_symbol_key, relation_type, target_name, import_path, line\
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(&workspace.id)
        .bind(file_id)
        .bind(source_symbol_key)
        .bind(&reference.relation_type)
        .bind(&reference.target_name)
        .bind(&reference.import_path)
        .bind(reference.line)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

fn normalize_repo_path(path: &Path) -> Option<String> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(normalized.to_string_lossy().replace('\\', "/"))
}

fn push_candidate(candidates: &mut Vec<String>, path: PathBuf) {
    if let Some(path) = normalize_repo_path(&path) {
        if !candidates.contains(&path) {
            candidates.push(path);
        }
    }
}

fn javascript_import_candidates(source_path: &str, import_path: &str) -> Vec<String> {
    if !import_path.starts_with('.') {
        return Vec::new();
    }
    let import_path = import_path
        .split(|character| character == '?' || character == '#')
        .next()
        .unwrap_or(import_path);
    let parent = Path::new(source_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let base = parent.join(import_path);
    let extensions = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"];
    let mut candidates = Vec::new();

    if base.extension().is_some() {
        push_candidate(&mut candidates, base.clone());
        if matches!(
            base.extension().and_then(|value| value.to_str()),
            Some("js" | "jsx" | "mjs" | "cjs")
        ) {
            for extension in ["ts", "tsx", "mts", "cts"] {
                let mut alternate = base.clone();
                alternate.set_extension(extension);
                push_candidate(&mut candidates, alternate);
            }
        }
    } else {
        for extension in extensions {
            let mut file = base.clone();
            file.set_extension(extension);
            push_candidate(&mut candidates, file);
            push_candidate(&mut candidates, base.join(format!("index.{extension}")));
        }
    }
    candidates
}

fn python_import_candidates(source_path: &str, import_path: &str) -> Vec<String> {
    let dots = import_path
        .chars()
        .take_while(|character| *character == '.')
        .count();
    let module = &import_path[dots..];
    let module_path = module.replace('.', "/");
    let mut root = if dots > 0 {
        Path::new(source_path)
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .to_path_buf()
    } else {
        PathBuf::new()
    };
    if dots > 0 {
        for _ in 1..dots {
            if !root.pop() {
                return Vec::new();
            }
        }
    }
    let base = if module_path.is_empty() {
        root
    } else {
        root.join(module_path)
    };
    let mut candidates = Vec::new();
    let mut module_file = base.clone();
    module_file.set_extension("py");
    push_candidate(&mut candidates, module_file);
    push_candidate(&mut candidates, base.join("__init__.py"));
    candidates
}

fn rust_source_root(source_path: &str) -> PathBuf {
    let parts: Vec<_> = source_path.split('/').collect();
    if let Some(index) = parts.iter().rposition(|part| *part == "src") {
        return parts[..=index].iter().collect();
    }
    PathBuf::new()
}

fn rust_import_candidates(source_path: &str, import_path: &str) -> Vec<String> {
    let mut import_path = import_path
        .split(" as ")
        .next()
        .unwrap_or(import_path)
        .trim();
    if let Some((prefix, _)) = import_path.split_once('{') {
        import_path = prefix.trim_end_matches(':').trim();
    }
    let parts: Vec<_> = import_path
        .split("::")
        .map(str::trim)
        .filter(|part| !part.is_empty() && *part != "*")
        .collect();
    if parts.is_empty() {
        return Vec::new();
    }

    let source_dir = Path::new(source_path)
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .to_path_buf();
    let source_root = rust_source_root(source_path);
    let mut roots = Vec::new();
    let mut offset = 0usize;
    match parts[0] {
        "crate" => {
            roots.push(source_root.clone());
            offset = 1;
        }
        "self" => {
            roots.push(source_dir.clone());
            offset = 1;
        }
        "super" => {
            let mut root = source_dir.clone();
            while offset < parts.len() && parts[offset] == "super" {
                root.pop();
                offset += 1;
            }
            roots.push(root);
        }
        _ => {
            roots.push(source_dir.clone());
            if source_root != source_dir {
                roots.push(source_root);
            }
        }
    }

    let remaining = &parts[offset..];
    let mut candidates = Vec::new();
    for root in roots {
        for length in (1..=remaining.len()).rev() {
            let mut base = root.clone();
            for part in &remaining[..length] {
                base.push(part);
            }
            let mut file = base.clone();
            file.set_extension("rs");
            push_candidate(&mut candidates, file);
            push_candidate(&mut candidates, base.join("mod.rs"));
        }
    }
    candidates
}

fn import_candidates(language: &str, source_path: &str, import_path: &str) -> Vec<String> {
    match language {
        "javascript" | "typescript" | "tsx" => {
            javascript_import_candidates(source_path, import_path)
        }
        "python" => python_import_candidates(source_path, import_path),
        "rust" => rust_import_candidates(source_path, import_path),
        _ => Vec::new(),
    }
}

fn resolve_import(
    file_symbols: &HashMap<String, (i64, i64)>,
    source_file_id: i64,
    source_path: &str,
    language: &str,
    import_path: &str,
) -> Option<(i64, i64, f64)> {
    let exact: Vec<_> = import_candidates(language, source_path, import_path)
        .iter()
        .filter_map(|path| file_symbols.get(path).copied())
        .filter(|(_, file_id)| *file_id != source_file_id)
        .collect();
    if exact.len() == 1 {
        return Some((exact[0].0, exact[0].1, 0.98));
    }

    if language == "python" && !import_path.starts_with('.') {
        let module = import_path.replace('.', "/");
        let direct_file = format!("{module}.py");
        let direct_package = format!("{module}/__init__.py");
        let suffix_file = format!("/{direct_file}");
        let suffix_package = format!("/{direct_package}");
        let inferred: Vec<_> = file_symbols
            .iter()
            .filter(|(path, (_, file_id))| {
                **file_id != source_file_id
                    && (*path == &direct_file
                        || *path == &direct_package
                        || path.ends_with(&suffix_file)
                        || path.ends_with(&suffix_package))
            })
            .map(|(_, value)| *value)
            .collect();
        if inferred.len() == 1 {
            return Some((inferred[0].0, inferred[0].1, 0.88));
        }
    }
    None
}

async fn insert_edge(
    tx: &mut Transaction<'_, Sqlite>,
    workspace_id: &str,
    source_id: i64,
    target_id: i64,
    edge_type: &str,
    confidence: f64,
) -> AppResult<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO edges(\
           workspace_id, source_symbol_id, target_symbol_id, edge_type, confidence, source\
         ) VALUES(?1, ?2, ?3, ?4, ?5, 'structural-resolver')",
    )
    .bind(workspace_id)
    .bind(source_id)
    .bind(target_id)
    .bind(edge_type)
    .bind(confidence)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn resolve_references(pool: &SqlitePool, workspace_id: &str) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM edges WHERE workspace_id=?1 AND source='structural-resolver'")
        .bind(workspace_id)
        .execute(&mut *tx)
        .await?;

    // The core parser models Rust impl references at file scope. Once owner-aware
    // impl edges are available, suppress those file-level resolver artifacts.
    sqlx::query(
        "DELETE FROM edges WHERE workspace_id=?1 AND source='resolver' AND edge_type='IMPLEMENTS' \
         AND source_symbol_id IN (SELECT id FROM symbols WHERE workspace_id=?1 AND kind='file')",
    )
    .bind(workspace_id)
    .execute(&mut *tx)
    .await?;

    let file_rows: Vec<(i64, i64, String)> = sqlx::query_as(
        "SELECT s.id, s.file_id, f.path FROM symbols s JOIN files f ON f.id=s.file_id \
         WHERE s.workspace_id=?1 AND s.kind='file'",
    )
    .bind(workspace_id)
    .fetch_all(&mut *tx)
    .await?;
    let file_symbols: HashMap<String, (i64, i64)> = file_rows
        .into_iter()
        .map(|(symbol_id, file_id, path)| (path, (symbol_id, file_id)))
        .collect();

    let symbol_rows: Vec<(i64, i64, String)> = sqlx::query_as(
        "SELECT id, file_id, name FROM symbols WHERE workspace_id=?1 AND kind!='file'",
    )
    .bind(workspace_id)
    .fetch_all(&mut *tx)
    .await?;
    let mut symbols_by_name: HashMap<String, Vec<SymbolCandidate>> = HashMap::new();
    for (id, file_id, name) in symbol_rows {
        symbols_by_name
            .entry(name)
            .or_default()
            .push(SymbolCandidate { id, file_id });
    }

    let rows: Vec<(i64, String, String, Option<String>, Option<String>, String, String)> =
        sqlx::query_as(
            "SELECT r.source_file_id, r.source_symbol_key, r.relation_type, r.target_name, \
                    r.import_path, f.path, COALESCE(f.language, '') \
             FROM structural_references r JOIN files f ON f.id=r.source_file_id \
             WHERE r.workspace_id=?1",
        )
        .bind(workspace_id)
        .fetch_all(&mut *tx)
        .await?;
    let references: Vec<StoredReference> = rows
        .into_iter()
        .map(
            |(
                source_file_id,
                source_symbol_key,
                relation_type,
                target_name,
                import_path,
                source_path,
                language,
            )| StoredReference {
                source_file_id,
                source_symbol_key,
                relation_type,
                target_name,
                import_path,
                source_path,
                language,
            },
        )
        .collect();

    let source_ids: HashMap<String, i64> = sqlx::query_as::<_, (String, i64)>(
        "SELECT symbol_key, id FROM symbols WHERE workspace_id=?1",
    )
    .bind(workspace_id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .collect();

    let files_with_imports: HashSet<i64> = references
        .iter()
        .filter(|reference| reference.relation_type == "IMPORTS")
        .map(|reference| reference.source_file_id)
        .collect();
    let mut imported_files: HashMap<i64, HashSet<i64>> = HashMap::new();

    for reference in references
        .iter()
        .filter(|reference| reference.relation_type == "IMPORTS")
    {
        let (Some(source_id), Some(import_path)) = (
            source_ids.get(&reference.source_symbol_key).copied(),
            reference.import_path.as_deref(),
        ) else {
            continue;
        };
        let Some((target_id, target_file_id, confidence)) = resolve_import(
            &file_symbols,
            reference.source_file_id,
            &reference.source_path,
            &reference.language,
            import_path,
        ) else {
            continue;
        };
        insert_edge(
            &mut tx,
            workspace_id,
            source_id,
            target_id,
            "IMPORTS",
            confidence,
        )
        .await?;
        imported_files
            .entry(reference.source_file_id)
            .or_default()
            .insert(target_file_id);
    }

    for reference in references
        .iter()
        .filter(|reference| reference.relation_type != "IMPORTS")
    {
        let (Some(source_id), Some(target_name)) = (
            source_ids.get(&reference.source_symbol_key).copied(),
            reference.target_name.as_deref(),
        ) else {
            continue;
        };
        let Some(candidates) = symbols_by_name.get(target_name) else {
            continue;
        };
        let same_file: Vec<_> = candidates
            .iter()
            .copied()
            .filter(|candidate| {
                candidate.file_id == reference.source_file_id && candidate.id != source_id
            })
            .collect();
        let imported: Vec<_> = imported_files
            .get(&reference.source_file_id)
            .into_iter()
            .flat_map(|file_ids| {
                candidates.iter().copied().filter(move |candidate| {
                    file_ids.contains(&candidate.file_id) && candidate.id != source_id
                })
            })
            .collect();

        let (target_id, confidence) = if same_file.len() == 1 {
            (same_file[0].id, 0.96)
        } else if imported.len() == 1 {
            (imported[0].id, 0.92)
        } else {
            let import_scoped = matches!(
                reference.language.as_str(),
                "javascript" | "typescript" | "tsx" | "python"
            ) && files_with_imports.contains(&reference.source_file_id);
            if import_scoped {
                continue;
            }
            let global: Vec<_> = candidates
                .iter()
                .copied()
                .filter(|candidate| candidate.id != source_id)
                .collect();
            if global.len() != 1 {
                continue;
            }
            (global[0].id, 0.74)
        };
        insert_edge(
            &mut tx,
            workspace_id,
            source_id,
            target_id,
            &reference.relation_type,
            confidence,
        )
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

pub async fn sync_paths(
    pool: &SqlitePool,
    workspace: &Workspace,
    paths: &[String],
) -> AppResult<()> {
    for path in paths {
        let Some(_spec) = language_spec(path) else {
            continue;
        };
        let row: Option<(i64, Option<String>)> = sqlx::query_as(
            "SELECT id, content FROM files WHERE workspace_id=?1 AND path=?2",
        )
        .bind(&workspace.id)
        .bind(path)
        .fetch_optional(pool)
        .await?;
        let Some((file_id, Some(content))) = row else {
            continue;
        };

        let parsed = match parse_references(path, &content) {
            Ok(parsed) => parsed,
            Err(error) => {
                tracing::warn!(
                    workspace = %workspace.id,
                    path,
                    error = %error,
                    "preserving prior structural references after semantic parse failure"
                );
                continue;
            }
        };
        replace_file_references(pool, workspace, file_id, &parsed).await?;
    }
    resolve_references(pool, &workspace.id).await
}

#[cfg(test)]
mod tests {
    use super::{
        javascript_import_candidates, parse_references, python_import_candidates,
        rust_import_candidates,
    };

    fn has_relation(
        references: &[super::ParsedReference],
        relation_type: &str,
        source: Option<&str>,
        target: Option<&str>,
        import_path: Option<&str>,
    ) -> bool {
        references.iter().any(|reference| {
            reference.relation_type == relation_type
                && reference.source_name.as_deref() == source
                && reference.target_name.as_deref() == target
                && reference.import_path.as_deref() == import_path
        })
    }

    #[test]
    fn extracts_javascript_import_and_extends() {
        let references = parse_references(
            "src/child.js",
            "import { Base } from './base.js'; class Child extends Base {}",
        )
        .expect("parse javascript references");
        assert!(has_relation(
            &references,
            "IMPORTS",
            None,
            None,
            Some("./base.js")
        ));
        assert!(has_relation(
            &references,
            "EXTENDS",
            Some("Child"),
            Some("Base"),
            None
        ));
    }

    #[test]
    fn extracts_typescript_implements_and_interface_extends() {
        let references = parse_references(
            "src/types.ts",
            "interface Parent {} interface Contract {} interface Child extends Parent {} class Service implements Contract {}",
        )
        .expect("parse typescript references");
        assert!(has_relation(
            &references,
            "EXTENDS",
            Some("Child"),
            Some("Parent"),
            None
        ));
        assert!(has_relation(
            &references,
            "IMPLEMENTS",
            Some("Service"),
            Some("Contract"),
            None
        ));
    }

    #[test]
    fn extracts_python_import_and_extends() {
        let references = parse_references(
            "pkg/child.py",
            "from .base import Base\nclass Child(Base):\n    pass\n",
        )
        .expect("parse python references");
        assert!(has_relation(
            &references,
            "IMPORTS",
            None,
            None,
            Some(".base")
        ));
        assert!(has_relation(
            &references,
            "EXTENDS",
            Some("Child"),
            Some("Base"),
            None
        ));
    }

    #[test]
    fn extracts_rust_import_and_owner_aware_impl() {
        let references = parse_references(
            "src/child.rs",
            "use crate::base::Base; trait Contract {} struct Child; impl Contract for Child {}",
        )
        .expect("parse rust references");
        assert!(has_relation(
            &references,
            "IMPORTS",
            None,
            None,
            Some("crate::base::Base")
        ));
        assert!(has_relation(
            &references,
            "IMPLEMENTS",
            Some("Child"),
            Some("Contract"),
            None
        ));
    }

    #[test]
    fn resolves_relative_language_paths_without_leaving_workspace() {
        assert!(
            javascript_import_candidates("src/a/child.ts", "./base")
                .contains(&"src/a/base.ts".to_string())
        );
        assert!(
            python_import_candidates("pkg/sub/child.py", "..base")
                .contains(&"pkg/base.py".to_string())
        );
        assert!(
            rust_import_candidates("src/sub/child.rs", "super::base::Base")
                .contains(&"src/base.rs".to_string())
        );
        assert!(javascript_import_candidates("src/child.ts", "../../../escape").is_empty());
    }
}
