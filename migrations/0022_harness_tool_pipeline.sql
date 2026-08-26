PRAGMA foreign_keys = ON;

CREATE TABLE harness_tool_executions (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES harness_runs(id) ON DELETE SET NULL,
    principal_id TEXT NOT NULL,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    tool_name TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    argument_sha256 TEXT NOT NULL,
    read_only INTEGER NOT NULL CHECK (read_only IN (0, 1)),
    destructive INTEGER NOT NULL CHECK (destructive IN (0, 1)),
    idempotent INTEGER NOT NULL CHECK (idempotent IN (0, 1)),
    open_world INTEGER NOT NULL CHECK (open_world IN (0, 1)),
    policy_decision TEXT NOT NULL CHECK (policy_decision IN ('allow', 'ask', 'deny')),
    result_category TEXT NOT NULL CHECK (result_category IN ('started', 'success', 'denied', 'approval-required', 'error')),
    error_category TEXT,
    dispatched INTEGER NOT NULL DEFAULT 0 CHECK (dispatched IN (0, 1)),
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER,
    duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0)
);

CREATE INDEX idx_harness_tool_executions_run
    ON harness_tool_executions(run_id, started_at, id);

CREATE INDEX idx_harness_tool_executions_workspace
    ON harness_tool_executions(workspace_id, started_at DESC, id DESC);

CREATE INDEX idx_harness_tool_executions_principal
    ON harness_tool_executions(principal_id, started_at DESC, id DESC);
