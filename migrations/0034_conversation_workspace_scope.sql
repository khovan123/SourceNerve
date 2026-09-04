CREATE TABLE conversation_contexts (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    client_request_id TEXT,
    request_fingerprint TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(principal_id, client_request_id)
);

CREATE TABLE conversation_workspaces (
    conversation_id TEXT NOT NULL REFERENCES conversation_contexts(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    attached_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY(conversation_id, workspace_id)
);

CREATE INDEX idx_conversation_workspaces_workspace
    ON conversation_workspaces(workspace_id, conversation_id);

ALTER TABLE harness_runs
ADD COLUMN conversation_id TEXT REFERENCES conversation_contexts(id) ON DELETE SET NULL;

DROP INDEX idx_harness_runs_one_automatic_active;

CREATE UNIQUE INDEX idx_harness_runs_one_automatic_active_legacy
    ON harness_runs(principal_id, workspace_id)
    WHERE origin='automatic'
      AND conversation_id IS NULL
      AND parent_run_id IS NULL
      AND status='running';

CREATE UNIQUE INDEX idx_harness_runs_one_automatic_active_conversation
    ON harness_runs(principal_id, conversation_id, workspace_id)
    WHERE origin='automatic'
      AND conversation_id IS NOT NULL
      AND parent_run_id IS NULL
      AND status='running';
