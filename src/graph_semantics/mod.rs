mod resolver;

use std::collections::{HashMap, HashSet};

use sqlx::SqlitePool;
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
    let value = value.trim_start_matches('(').trim_end_matches(')').trim();
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
        AppError::InvalidRequest(format!(
            "failed to load {} semantic parser: {error}",
            spec.name
        ))
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

pub async fn sync_paths(
    pool: &SqlitePool,
    workspace: &Workspace,
    paths: &[String],
) -> AppResult<()> {
    for path in paths {
        if language_spec(path).is_none() {
            continue;
        }
        let row: Option<(i64, Option<String>)> =
            sqlx::query_as("SELECT id, content FROM files WHERE workspace_id=?1 AND path=?2")
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
    resolver::resolve_references(pool, &workspace.id).await
}

#[cfg(test)]
mod tests {
    use super::{parse_references, resolver};

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
            resolver::javascript_import_candidates("src/a/child.ts", "./base")
                .contains(&"src/a/base.ts".to_string())
        );
        assert!(
            resolver::python_import_candidates("pkg/sub/child.py", "..base")
                .contains(&"pkg/base.py".to_string())
        );
        assert!(
            resolver::rust_import_candidates("src/sub/child.rs", "super::base::Base")
                .contains(&"src/base.rs".to_string())
        );
        assert!(
            resolver::javascript_import_candidates("src/child.ts", "../../../escape").is_empty()
        );
    }
}
