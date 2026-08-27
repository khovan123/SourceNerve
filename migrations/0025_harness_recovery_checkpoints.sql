PRAGMA foreign_keys = ON;

CREATE TABLE harness_checkpoints (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
    event_seq INTEGER NOT NULL CHECK (event_seq >= 0),
    state TEXT NOT NULL CHECK (state IN ('resumable', 'stale', 'requires-review', 'terminal')),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 64),
    facts_json TEXT NOT NULL CHECK (json_valid(facts_json)),
    facts_sha256 TEXT NOT NULL CHECK (length(facts_sha256) = 64),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(run_id, facts_sha256),
    UNIQUE(run_id, event_seq)
);

CREATE INDEX idx_harness_checkpoints_run_created
    ON harness_checkpoints(run_id, created_at DESC, event_seq DESC);
