PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    client_request_id TEXT,
    request_fingerprint TEXT NOT NULL,
    base_head TEXT NOT NULL,
    graph_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'stale', 'applied', 'cancelled')),
    context_query TEXT,
    context_sha256 TEXT,
    stale_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_request
    ON tasks(workspace_id, client_request_id)
    WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_created
    ON tasks(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_task
    ON task_events(task_id, id);

CREATE TABLE IF NOT EXISTS task_proposals (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idempotency_key TEXT,
    request_fingerprint TEXT NOT NULL,
    expected_head TEXT NOT NULL,
    patch_sha256 TEXT NOT NULL,
    patch TEXT NOT NULL,
    expected_files_json TEXT NOT NULL,
    changed_paths_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('proposed', 'applied', 'rejected')),
    changeset_id TEXT,
    created_at INTEGER NOT NULL,
    applied_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_proposals_idempotency
    ON task_proposals(task_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_proposals_task_created
    ON task_proposals(task_id, created_at DESC);
