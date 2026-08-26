PRAGMA foreign_keys = ON;

CREATE TABLE harness_approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
    principal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    argument_sha256 TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    policy TEXT NOT NULL CHECK (policy = 'ask'),
    status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'consumed', 'expired')),
    requested_execution_id TEXT REFERENCES harness_tool_executions(id) ON DELETE SET NULL,
    resolved_by TEXT,
    requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL,
    resolved_at INTEGER,
    consumed_at INTEGER
);

CREATE INDEX idx_harness_approvals_run_status
    ON harness_approvals(run_id, status, requested_at DESC, id DESC);

CREATE INDEX idx_harness_approvals_principal_status
    ON harness_approvals(principal_id, status, requested_at DESC, id DESC);

CREATE INDEX idx_harness_approvals_intent
    ON harness_approvals(
        run_id,
        principal_id,
        workspace_id,
        tool_name,
        capability_id,
        argument_sha256,
        head_sha,
        status
    );

ALTER TABLE harness_tool_executions
    ADD COLUMN approval_id TEXT REFERENCES harness_approvals(id) ON DELETE SET NULL;
