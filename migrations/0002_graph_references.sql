PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS idx_symbols_workspace_name
    ON symbols(workspace_id, name, kind);
CREATE INDEX IF NOT EXISTS idx_symbols_workspace_qname
    ON symbols(workspace_id, qualified_name);
CREATE INDEX IF NOT EXISTS idx_symbols_file
    ON symbols(file_id);

CREATE TABLE IF NOT EXISTS symbol_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    source_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    target_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
    reference_type TEXT NOT NULL,
    name TEXT NOT NULL,
    line INTEGER,
    confidence REAL NOT NULL DEFAULT 0.0,
    UNIQUE(workspace_id, source_symbol_id, reference_type, name, line)
);

CREATE INDEX IF NOT EXISTS idx_symbol_refs_source
    ON symbol_references(workspace_id, source_symbol_id, reference_type);
CREATE INDEX IF NOT EXISTS idx_symbol_refs_target
    ON symbol_references(workspace_id, target_symbol_id, reference_type);
CREATE INDEX IF NOT EXISTS idx_symbol_refs_name
    ON symbol_references(workspace_id, name, reference_type);

CREATE TABLE IF NOT EXISTS graph_file_state (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    language TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    parsed_at INTEGER NOT NULL,
    PRIMARY KEY(workspace_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_graph_file_state_status
    ON graph_file_state(workspace_id, status);
