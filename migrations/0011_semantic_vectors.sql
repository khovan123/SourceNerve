PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS semantic_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    client_run_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    dimension INTEGER NOT NULL CHECK(dimension > 0),
    git_head TEXT NOT NULL,
    graph_version INTEGER NOT NULL,
    request_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'superseded')),
    created_at INTEGER NOT NULL,
    activated_at INTEGER NOT NULL,
    UNIQUE(workspace_id, client_run_id)
);

CREATE INDEX IF NOT EXISTS idx_semantic_runs_current
    ON semantic_runs(workspace_id, status, activated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS semantic_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES semantic_runs(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    start_line INTEGER NOT NULL CHECK(start_line > 0),
    end_line INTEGER NOT NULL CHECK(end_line >= start_line),
    file_sha256 TEXT NOT NULL,
    vector BLOB NOT NULL,
    vector_norm REAL NOT NULL CHECK(vector_norm > 0),
    created_at INTEGER NOT NULL,
    UNIQUE(run_id, path, start_line, end_line)
);

CREATE INDEX IF NOT EXISTS idx_semantic_chunks_workspace_path
    ON semantic_chunks(workspace_id, path, run_id);
