CREATE TABLE harness_agent_turns (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
    client_request_id TEXT,
    request_fingerprint TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN (
        'running',
        'completed',
        'failed',
        'cancelled',
        'iteration-limit'
    )),
    max_iterations INTEGER NOT NULL CHECK (max_iterations BETWEEN 1 AND 64),
    iteration_count INTEGER NOT NULL DEFAULT 0 CHECK (iteration_count >= 0),
    provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) BETWEEN 1 AND 128),
    model_id TEXT CHECK (model_id IS NULL OR length(model_id) BETWEEN 1 AND 128),
    stop_reason TEXT CHECK (stop_reason IS NULL OR length(stop_reason) BETWEEN 1 AND 256),
    input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER,
    UNIQUE(run_id, client_request_id)
);

CREATE INDEX idx_harness_agent_turns_run_updated
    ON harness_agent_turns(run_id, updated_at DESC, started_at DESC);
