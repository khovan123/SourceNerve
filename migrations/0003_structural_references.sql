PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS structural_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    source_symbol_key TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    target_name TEXT,
    import_path TEXT,
    line INTEGER,
    UNIQUE(
        workspace_id,
        source_file_id,
        source_symbol_key,
        relation_type,
        target_name,
        import_path,
        line
    )
);

CREATE INDEX IF NOT EXISTS idx_structural_refs_file
    ON structural_references(workspace_id, source_file_id);
CREATE INDEX IF NOT EXISTS idx_structural_refs_source
    ON structural_references(workspace_id, source_symbol_key, relation_type);
CREATE INDEX IF NOT EXISTS idx_structural_refs_target
    ON structural_references(workspace_id, target_name, relation_type);
