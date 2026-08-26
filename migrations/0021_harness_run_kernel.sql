CREATE TABLE harness_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    principal_id TEXT NOT NULL,
    client_request_id TEXT,
    request_fingerprint TEXT,
    profile TEXT NOT NULL CHECK (profile IN (
        'read-only-analysis',
        'interactive-local',
        'guarded-durable',
        'background-job',
        'webhook-automation'
    )),
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN (
        'running',
        'stale',
        'completed',
        'cancelled',
        'failed'
    )),
    base_head TEXT NOT NULL,
    graph_version INTEGER NOT NULL,
    indexed_head TEXT,
    capability_snapshot_json TEXT NOT NULL CHECK (json_valid(capability_snapshot_json)),
    capability_snapshot_sha256 TEXT NOT NULL,
    parent_run_id TEXT REFERENCES harness_runs(id) ON DELETE SET NULL,
    stale_reason TEXT,
    next_event_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_event_seq >= 0),
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER,
    UNIQUE(principal_id, client_request_id)
);

CREATE INDEX idx_harness_runs_workspace_status
    ON harness_runs(workspace_id, status, updated_at DESC);

CREATE INDEX idx_harness_runs_parent
    ON harness_runs(parent_run_id, started_at);

CREATE TABLE harness_events (
    run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL CHECK (seq >= 0),
    event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY(run_id, seq)
);

CREATE INDEX idx_harness_events_run_created
    ON harness_events(run_id, created_at, seq);
