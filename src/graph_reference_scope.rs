use std::collections::{HashMap, HashSet};

use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::error::AppResult;

#[derive(Debug, Clone, Copy)]
struct SymbolCandidate {
    id: i64,
    file_id: i64,
}

fn edge_type(reference_type: &str) -> &'static str {
    match reference_type {
        "call" => "CALLS",
        "implementation" => "IMPLEMENTS",
        _ => "REFERENCES",
    }
}

fn requires_import_scope(language: &str, has_imports: bool) -> bool {
    has_imports
        && matches!(
            language,
            "javascript" | "typescript" | "tsx" | "python" | "rust"
        )
}

async fn insert_edge(
    tx: &mut Transaction<'_, Sqlite>,
    workspace_id: &str,
    source_id: i64,
    target_id: i64,
    reference_type: &str,
    confidence: f64,
) -> AppResult<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO edges(\
           workspace_id, source_symbol_id, target_symbol_id, edge_type, confidence, source\
         ) VALUES(?1, ?2, ?3, ?4, ?5, 'resolver')",
    )
    .bind(workspace_id)
    .bind(source_id)
    .bind(target_id)
    .bind(edge_type(reference_type))
    .bind(confidence)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Re-resolve parser references after structural imports are known.
///
/// The core parser intentionally has no module-resolution context. This pass runs
/// after `graph_semantics` has materialized deterministic `IMPORTS` edges and
/// uses those edges to keep same-named symbols in other modules from being
/// guessed as call/reference targets.
pub async fn resolve(pool: &SqlitePool, workspace_id: &str) -> AppResult<()> {
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

    let imported_rows: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT source.file_id, target.file_id \
         FROM edges e \
         JOIN symbols source ON source.id=e.source_symbol_id \
         JOIN symbols target ON target.id=e.target_symbol_id \
         WHERE e.workspace_id=?1 AND e.edge_type='IMPORTS' AND e.source='structural-resolver'",
    )
    .bind(workspace_id)
    .fetch_all(&mut *tx)
    .await?;
    let mut imported_files: HashMap<i64, HashSet<i64>> = HashMap::new();
    for (source_file_id, target_file_id) in imported_rows {
        imported_files
            .entry(source_file_id)
            .or_default()
            .insert(target_file_id);
    }

    let files_with_imports: HashSet<i64> = sqlx::query_scalar(
        "SELECT DISTINCT source_file_id FROM structural_references \
         WHERE workspace_id=?1 AND relation_type='IMPORTS'",
    )
    .bind(workspace_id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .collect();

    type ReferenceRow = (i64, i64, i64, String, String, String);
    let references: Vec<ReferenceRow> = sqlx::query_as(
        "SELECT r.id, r.source_symbol_id, source.file_id, r.reference_type, r.name, COALESCE(f.language, '') \
         FROM symbol_references r \
         JOIN symbols source ON source.id=r.source_symbol_id \
         JOIN files f ON f.id=source.file_id \
         WHERE r.workspace_id=?1",
    )
    .bind(workspace_id)
    .fetch_all(&mut *tx)
    .await?;

    for (reference_id, source_id, source_file_id, reference_type, name, language) in references {
        let Some(candidates) = symbols_by_name.get(&name) else {
            continue;
        };

        let same_file: Vec<_> = candidates
            .iter()
            .copied()
            .filter(|candidate| candidate.file_id == source_file_id && candidate.id != source_id)
            .collect();
        let imported: Vec<_> = imported_files
            .get(&source_file_id)
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
        } else if requires_import_scope(
            &language,
            files_with_imports.contains(&source_file_id),
        ) {
            continue;
        } else {
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

        sqlx::query(
            "UPDATE symbol_references SET target_symbol_id=?1, confidence=?2 WHERE id=?3",
        )
        .bind(target_id)
        .bind(confidence)
        .bind(reference_id)
        .execute(&mut *tx)
        .await?;
        insert_edge(
            &mut tx,
            workspace_id,
            source_id,
            target_id,
            &reference_type,
            confidence,
        )
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::requires_import_scope;

    #[test]
    fn supported_languages_fail_closed_when_imports_exist() {
        for language in ["javascript", "typescript", "tsx", "python", "rust"] {
            assert!(requires_import_scope(language, true));
            assert!(!requires_import_scope(language, false));
        }
        assert!(!requires_import_scope("unknown", true));
    }
}
