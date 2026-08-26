CREATE TABLE mcp_extension_invocation_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
    principal_kind TEXT NOT NULL CHECK (principal_kind IN ('operator', 'oauth')),
    principal_subject TEXT NOT NULL,
    workspace_id TEXT,
    extension_id TEXT NOT NULL,
    extension_version TEXT NOT NULL,
    public_tool TEXT NOT NULL,
    original_tool TEXT NOT NULL,
    schema_hash TEXT NOT NULL,
    policy_decision TEXT NOT NULL CHECK (
        policy_decision IN ('allow', 'blocked', 'ask', 'authorization-denied', 'configuration-error')
    ),
    approval_decision TEXT NOT NULL CHECK (
        approval_decision IN ('not-required', 'approved', 'missing', 'not-applicable')
    ),
    result_category TEXT NOT NULL CHECK (
        result_category IN ('success', 'denied', 'approval-required', 'configuration-error', 'downstream-error')
    ),
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    error_category TEXT,
    CHECK (length(principal_subject) BETWEEN 1 AND 512),
    CHECK (workspace_id IS NULL OR length(workspace_id) <= 128),
    CHECK (length(extension_id) BETWEEN 1 AND 64),
    CHECK (length(extension_version) BETWEEN 1 AND 64),
    CHECK (length(public_tool) BETWEEN 1 AND 120),
    CHECK (length(original_tool) BETWEEN 1 AND 128),
    CHECK (length(schema_hash) BETWEEN 1 AND 128),
    CHECK (error_category IS NULL OR length(error_category) <= 64)
);

CREATE INDEX idx_mcp_extension_invocation_audit_time
ON mcp_extension_invocation_audit(occurred_at DESC, id DESC);

CREATE INDEX idx_mcp_extension_invocation_audit_extension_time
ON mcp_extension_invocation_audit(extension_id, occurred_at DESC, id DESC);

CREATE INDEX idx_mcp_extension_invocation_audit_workspace_time
ON mcp_extension_invocation_audit(workspace_id, occurred_at DESC, id DESC);
