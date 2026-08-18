PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mutation_audit (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    operation TEXT NOT NULL,
    request_id TEXT,
    target_json TEXT NOT NULL DEFAULT '{}',
    outcome TEXT NOT NULL CHECK(outcome IN ('success', 'rejected', 'failed')),
    result_sha TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mutation_audit_workspace_created
    ON mutation_audit(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mutation_audit_request
    ON mutation_audit(workspace_id, request_id)
    WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS idempotency_records (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(workspace_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created
    ON idempotency_records(workspace_id, created_at DESC);
