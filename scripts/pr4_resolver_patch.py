from pathlib import Path

p = Path('src/graph.rs')
s = p.read_text()
if 'fn javascript_import_candidates(' in s:
    raise SystemExit(0)

start = s.index("fn edge_type_for_reference(reference_type: &str) -> &'static str {")
end = s.index('\npub async fn sync_paths(', start)
block = r'''fn normalize_repo_path(path: &Path) -> Option<String> {
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

fn push_path_candidate(candidates: &mut Vec<String>, path: PathBuf) {
    if let Some(path) = normalize_repo_path(&path) {
        if !candidates.contains(&path) {
            candidates.push(path);
        }
    }
}

fn javascript_import_candidates(source_path: &str, import_name: &str) -> Vec<String> {
    if !import_name.starts_with('.') {
        return Vec::new();
    }
    let import_name = import_name
        .split(|c| c == '?' || c == '#')
        .next()
        .unwrap_or(import_name);
    let parent = Path::new(source_path).parent().unwrap_or_else(|| Path::new(""));
    let base = parent.join(import_name);
    let extensions = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"];
    let mut candidates = Vec::new();
    if base.extension().is_some() {
        push_path_candidate(&mut candidates, base.clone());
        if matches!(
            base.extension().and_then(|value| value.to_str()),
            Some("js" | "jsx" | "mjs" | "cjs")
        ) {
            for extension in ["ts", "tsx", "mts", "cts"] {
                let mut alternate = base.clone();
                alternate.set_extension(extension);
                push_path_candidate(&mut candidates, alternate);
            }
        }
    } else {
        for extension in extensions {
            let mut file = base.clone();
            file.set_extension(extension);
            push_path_candidate(&mut candidates, file);
            push_path_candidate(&mut candidates, base.join(format!("index.{extension}")));
        }
    }
    candidates
}

fn python_import_candidates(source_path: &str, import_name: &str) -> Vec<String> {
    let dots = import_name.chars().take_while(|c| *c == '.').count();
    let module = &import_name[dots..];
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
    let mut file = base.clone();
    file.set_extension("py");
    push_path_candidate(&mut candidates, file);
    push_path_candidate(&mut candidates, base.join("__init__.py"));
    candidates
}

fn rust_src_root(source_path: &str) -> PathBuf {
    let parts: Vec<_> = source_path.split('/').collect();
    if let Some(index) = parts.iter().rposition(|part| *part == "src") {
        return parts[..=index].iter().collect();
    }
    PathBuf::new()
}

fn rust_import_candidates(source_path: &str, import_name: &str) -> Vec<String> {
    let mut import_name = import_name.split(" as ").next().unwrap_or(import_name).trim();
    if let Some((prefix, _)) = import_name.split_once('{') {
        import_name = prefix.trim_end_matches(':').trim();
    }
    let parts: Vec<_> = import_name
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
    let src_root = rust_src_root(source_path);
    let mut roots = Vec::new();
    let mut offset = 0usize;
    match parts[0] {
        "crate" => {
            roots.push(src_root.clone());
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
            if src_root != source_dir {
                roots.push(src_root);
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
            push_path_candidate(&mut candidates, file);
            push_path_candidate(&mut candidates, base.join("mod.rs"));
        }
    }
    candidates
}

fn import_candidates(language: &str, source_path: &str, import_name: &str) -> Vec<String> {
    match language {
        "javascript" | "typescript" | "tsx" => javascript_import_candidates(source_path, import_name),
        "python" => python_import_candidates(source_path, import_name),
        "rust" => rust_import_candidates(source_path, import_name),
        _ => Vec::new(),
    }
}

fn resolve_import_reference(
    file_symbols: &HashMap<String, (i64, i64)>,
    source_file_id: i64,
    source_path: &str,
    language: &str,
    import_name: &str,
) -> Option<(i64, i64, f64)> {
    let exact: Vec<_> = import_candidates(language, source_path, import_name)
        .iter()
        .filter_map(|path| file_symbols.get(path).copied())
        .filter(|(_, file_id)| *file_id != source_file_id)
        .collect();
    if exact.len() == 1 {
        return Some((exact[0].0, exact[0].1, 0.98));
    }
    if language == "python" && !import_name.starts_with('.') {
        let module = import_name.replace('.', "/");
        let direct_file = format!("{module}.py");
        let direct_package = format!("{module}/__init__.py");
        let suffix_file = format!("/{direct_file}");
        let suffix_package = format!("/{direct_package}");
        let inferred: Vec<_> = file_symbols
            .iter()
            .filter(|(path, (_, file_id))| {
                *file_id != &source_file_id
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

fn edge_type_for_reference(reference_type: &str) -> &'static str {
    match reference_type {
        "call" => "CALLS",
        "import" => "IMPORTS",
        "extends" => "EXTENDS",
        "implementation" => "IMPLEMENTS",
        _ => "REFERENCES",
    }
}

async fn persist_resolved_reference(
    tx: &mut Transaction<'_, Sqlite>,
    workspace_id: &str,
    reference_id: i64,
    source_id: i64,
    target_id: i64,
    reference_type: &str,
    confidence: f64,
) -> AppResult<()> {
    sqlx::query("UPDATE symbol_references SET target_symbol_id=?1, confidence=?2 WHERE id=?3")
        .bind(target_id)
        .bind(confidence)
        .bind(reference_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "INSERT OR IGNORE INTO edges(workspace_id, source_symbol_id, target_symbol_id, edge_type, confidence, source) \
         VALUES(?1, ?2, ?3, ?4, ?5, 'resolver')",
    )
    .bind(workspace_id)
    .bind(source_id)
    .bind(target_id)
    .bind(edge_type_for_reference(reference_type))
    .bind(confidence)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn resolve_references(pool: &SqlitePool, workspace_id: &str) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM edges WHERE workspace_id=?1 AND source='resolver'")
        .bind(workspace_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE symbol_references SET target_symbol_id=NULL, confidence=0.0 WHERE workspace_id=?1")
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

    let file_rows: Vec<FileSymbolRow> = sqlx::query_as(
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

    let references: Vec<ResolverReferenceRow> = sqlx::query_as(
        "SELECT r.id, r.source_symbol_id, s.file_id, r.reference_type, r.name, \
                COALESCE(s.language, ''), f.path \
         FROM symbol_references r JOIN symbols s ON s.id=r.source_symbol_id \
         JOIN files f ON f.id=s.file_id WHERE r.workspace_id=?1",
    )
    .bind(workspace_id)
    .fetch_all(&mut *tx)
    .await?;
    let files_with_imports: HashSet<i64> = references
        .iter()
        .filter(|row| row.3 == "import")
        .map(|row| row.2)
        .collect();
    let mut imported_files: HashMap<i64, HashSet<i64>> = HashMap::new();

    for row in references.iter().filter(|row| row.3 == "import") {
        let Some((target_id, target_file_id, confidence)) = resolve_import_reference(
            &file_symbols, row.2, &row.6, &row.5, &row.4,
        ) else {
            continue;
        };
        persist_resolved_reference(&mut tx, workspace_id, row.0, row.1, target_id, &row.3, confidence).await?;
        imported_files.entry(row.2).or_default().insert(target_file_id);
    }

    for row in references.iter().filter(|row| row.3 != "import") {
        let lookup_name = terminal_symbol_name(&row.4);
        let Some(candidates) = by_name.get(&lookup_name) else {
            continue;
        };
        let same_file: Vec<_> = candidates
            .iter().copied()
            .filter(|(id, file_id)| *file_id == row.2 && *id != row.1)
            .collect();
        let imported: Vec<_> = imported_files
            .get(&row.2)
            .into_iter()
            .flat_map(|file_ids| candidates.iter().copied().filter(move |(id, file_id)| {
                file_ids.contains(file_id) && *id != row.1
            }))
            .collect();
        let (target_id, confidence) = if same_file.len() == 1 {
            (same_file[0].0, 0.95)
        } else if imported.len() == 1 {
            (imported[0].0, 0.9)
        } else {
            let import_scoped = matches!(row.5.as_str(), "javascript" | "typescript" | "tsx" | "python")
                && matches!(row.3.as_str(), "extends" | "implementation" | "class" | "type")
                && files_with_imports.contains(&row.2);
            if import_scoped {
                continue;
            }
            let global: Vec<_> = candidates
                .iter().copied()
                .filter(|(id, _)| *id != row.1)
                .collect();
            if global.len() != 1 {
                continue;
            }
            (global[0].0, 0.72)
        };
        persist_resolved_reference(&mut tx, workspace_id, row.0, row.1, target_id, &row.3, confidence).await?;
    }
    tx.commit().await?;
    Ok(())
}
'''
s = s[:start] + block + s[end:]
p.write_text(s)
