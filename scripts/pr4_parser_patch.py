from pathlib import Path

p = Path('src/graph.rs')
s = p.read_text()
if 'PR4_STRUCTURAL_QUERIES' in s:
    raise SystemExit(0)

s = s.replace(
    'use std::collections::{HashMap, HashSet, VecDeque};',
    'use std::{\n    collections::{HashMap, HashSet, VecDeque},\n    path::{Component, Path, PathBuf},\n};',
    1,
)

queries = r'''
// PR4_STRUCTURAL_QUERIES
const JAVASCRIPT_STRUCTURE_QUERY: &str = r#"
(import_statement source: (string) @name) @reference.import
(class_heritage (identifier) @name) @reference.extends
(class_heritage
  (member_expression property: (property_identifier) @name)) @reference.extends
"#;

const TYPESCRIPT_STRUCTURE_QUERY: &str = r#"
(import_statement source: (string) @name) @reference.import
(extends_clause value: (_) @name) @reference.extends
(implements_clause (_) @name) @reference.implementation
(extends_type_clause type: (_) @name) @reference.extends
"#;

const PYTHON_STRUCTURE_QUERY: &str = r#"
(import_statement (dotted_name) @name) @reference.import
(import_statement
  (aliased_import name: (dotted_name) @name)) @reference.import
(import_from_statement
  module_name: [(dotted_name) (relative_import)] @name) @reference.import
(class_definition
  superclasses: (argument_list (identifier) @name)) @reference.extends
(class_definition
  superclasses: (argument_list
    (attribute attribute: (identifier) @name))) @reference.extends
"#;

const RUST_STRUCTURE_QUERY: &str = r#"
(use_declaration argument: (_) @name) @reference.import
(extern_crate_declaration name: (identifier) @name) @reference.import
(mod_item name: (identifier) @name !body) @reference.import
"#;
'''
anchor = '"#;\n\ntype SymbolRow = ('
if anchor not in s:
    raise SystemExit('query anchor not found')
s = s.replace(anchor, '"#;\n' + queries + '\ntype SymbolRow = (', 1)

aliases = '''type SymbolRow = (\n    String,\n    String,\n    String,\n    String,\n    Option<String>,\n    String,\n    Option<i64>,\n    Option<i64>,\n    Option<String>,\n);\n'''
if aliases not in s:
    raise SystemExit('alias anchor not found')
s = s.replace(
    aliases,
    aliases + '\ntype ResolverReferenceRow = (i64, i64, i64, String, String, String, String);\ntype FileSymbolRow = (i64, i64, String);\n',
    1,
)

priority = '''fn definition_priority(kind: &str) -> u8 {\n    match kind {\n        "method" => 8,\n        "function" => 7,\n        "class" => 6,\n        "interface" => 5,\n        "module" => 4,\n        "macro" => 3,\n        _ => 1,\n    }\n}\n'''
helpers = r'''

fn structure_query_for_language(language: &str) -> Option<&'static str> {
    match language {
        "javascript" => Some(JAVASCRIPT_STRUCTURE_QUERY),
        "typescript" | "tsx" => Some(TYPESCRIPT_STRUCTURE_QUERY),
        "python" => Some(PYTHON_STRUCTURE_QUERY),
        "rust" => Some(RUST_STRUCTURE_QUERY),
        _ => None,
    }
}

fn terminal_symbol_name(raw: &str) -> String {
    let raw = raw.split('<').next().unwrap_or(raw).trim();
    raw.rsplit(|c: char| matches!(c, '.' | ':' | '/' | '\\'))
        .find(|part| !part.trim().is_empty())
        .unwrap_or(raw)
        .trim()
        .trim_matches(|c: char| matches!(c, '(' | ')' | '[' | ']' | '{' | '}' | '&' | '*'))
        .to_string()
}

fn normalize_reference_capture(reference_type: &str, raw: &str) -> String {
    let raw = raw.trim();
    if reference_type == "import" {
        let bytes = raw.as_bytes();
        if bytes.len() >= 2
            && ((bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'')
                || (bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"'))
        {
            return raw[1..raw.len() - 1].to_string();
        }
        return raw.to_string();
    }
    if matches!(reference_type, "extends" | "implementation" | "class" | "type") {
        return terminal_symbol_name(raw);
    }
    raw.to_string()
}

fn extract_structural_references(
    spec: &LanguageSpec,
    source: &[u8],
    tree: &tree_sitter::Tree,
    references: &mut Vec<RawReference>,
) -> AppResult<()> {
    let Some(query_source) = structure_query_for_language(spec.name) else {
        return Ok(());
    };
    let query = Query::new(&spec.language, query_source).map_err(|error| {
        AppError::InvalidRequest(format!("invalid {} structural query: {error}", spec.name))
    })?;
    let capture_names = query.capture_names();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, tree.root_node(), source);
    while let Some(query_match) = matches.next() {
        let mut name_node = None;
        let mut reference = None;
        for capture in query_match.captures {
            let capture_name = capture_names[capture.index as usize];
            if capture_name == "name" {
                name_node = Some(capture.node);
            } else if let Some(reference_type) = capture_name.strip_prefix("reference.") {
                reference = Some((reference_type.to_string(), capture.node));
            }
        }
        let (Some(name_node), Some((reference_type, reference_node))) = (name_node, reference) else {
            continue;
        };
        let name = normalize_reference_capture(&reference_type, node_text(name_node, source)?);
        if name.is_empty() {
            continue;
        }
        references.push(RawReference {
            name,
            reference_type,
            start_byte: reference_node.start_byte(),
            end_byte: reference_node.end_byte(),
            line: name_node.start_position().row as i64 + 1,
        });
    }
    Ok(())
}
'''
if priority not in s:
    raise SystemExit('priority anchor not found')
s = s.replace(priority, priority + helpers, 1)

tail = '''    let mut definitions: Vec<_> = definitions.into_values().collect();\n    definitions.sort_by_key(|item| (item.start_byte, usize::MAX - item.end_byte));\n    Ok((definitions, references))\n'''
replacement = '''    extract_structural_references(spec, source, tree, &mut references)?;\n    let mut seen_references = HashSet::new();\n    references.retain(|reference| {\n        seen_references.insert((\n            reference.reference_type.clone(),\n            reference.name.clone(),\n            reference.start_byte,\n            reference.end_byte,\n        ))\n    });\n\n    let mut definitions: Vec<_> = definitions.into_values().collect();\n    definitions.sort_by_key(|item| (item.start_byte, usize::MAX - item.end_byte));\n    Ok((definitions, references))\n'''
if tail not in s:
    raise SystemExit('extract tail not found')
s = s.replace(tail, replacement, 1)
p.write_text(s)
