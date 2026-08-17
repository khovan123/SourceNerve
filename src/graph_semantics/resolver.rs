use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
};

use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::error::AppResult;

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

pub(super) fn javascript_import_candidates(source_path: &str, import_path: &str) -> Vec<String> {
    if !import_path.starts_with('.') {
        return Vec::new();
    }
    let import_path = import_path.split(['?', '#']).next().unwrap_or(import_path);
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

pub(super) fn python_import_candidates(source_path: &str, import_path: &str) -> Vec<String> {
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

pub(super) fn rust_import_candidates(source_path: &str, import_path: &str) -> Vec<String> {
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
                *file_id != source_file_id
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

pub(super) async fn resolve_references(pool: &SqlitePool, workspace_id: &str) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM edges WHERE workspace_id=?1 AND source='structural-resolver'")
        .bind(workspace_id)
        .execute(&mut *tx)
        .await?;

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

    type StoredReferenceRow = (
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    );
    let rows: Vec<StoredReferenceRow> = sqlx::query_as(
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
