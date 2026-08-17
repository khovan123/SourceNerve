PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    writable INTEGER NOT NULL DEFAULT 1,
    git_head TEXT,
    indexed_head TEXT,
    graph_version INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    language TEXT,
    content_hash TEXT NOT NULL,
    content TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    indexed_at INTEGER NOT NULL,
    UNIQUE(workspace_id, path)
);

CREATE INDEX IF NOT EXISTS idx_files_workspace ON files(workspace_id);
CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(path, content, content='files', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
  INSERT INTO code_fts(rowid, path, content) VALUES (new.id, new.path, coalesce(new.content, ''));
END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
  INSERT INTO code_fts(code_fts, rowid, path, content) VALUES('delete', old.id, old.path, coalesce(old.content, ''));
END;
CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
  INSERT INTO code_fts(code_fts, rowid, path, content) VALUES('delete', old.id, old.path, coalesce(old.content, ''));
  INSERT INTO code_fts(rowid, path, content) VALUES (new.id, new.path, coalesce(new.content, ''));
END;

CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    symbol_key TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    language TEXT,
    start_line INTEGER,
    end_line INTEGER,
    signature TEXT,
    content_hash TEXT,
    ast_hash TEXT,
    UNIQUE(workspace_id, symbol_key)
);

CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    source_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    target_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    edge_type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    source TEXT NOT NULL DEFAULT 'parser',
    UNIQUE(workspace_id, source_symbol_id, target_symbol_id, edge_type, source)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(workspace_id, source_symbol_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(workspace_id, target_symbol_id, edge_type);

CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    memory_type TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    confidence REAL,
    created_at INTEGER NOT NULL,
    invalidated_at INTEGER
);

CREATE TABLE IF NOT EXISTS changesets (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    base_head TEXT NOT NULL,
    patch_sha256 TEXT NOT NULL,
    paths_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
