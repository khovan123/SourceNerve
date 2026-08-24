CREATE TABLE mcp_extensions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    namespace TEXT NOT NULL UNIQUE,
    transport TEXT NOT NULL CHECK (transport IN ('stdio', 'streamable-http')),
    source TEXT NOT NULL,
    config_json TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'oauth')),
    secret_ref TEXT,
    status TEXT NOT NULL DEFAULT 'installed' CHECK (status IN ('installed', 'enabled', 'disabled', 'error', 'updating')),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
    update_channel TEXT NOT NULL DEFAULT 'stable',
    last_error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_mcp_extensions_enabled
    ON mcp_extensions(enabled, status);

CREATE TABLE mcp_extension_tools (
    extension_id TEXT NOT NULL REFERENCES mcp_extensions(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    public_name TEXT NOT NULL UNIQUE,
    description TEXT,
    input_schema_json TEXT NOT NULL,
    schema_hash TEXT NOT NULL,
    read_only INTEGER,
    destructive INTEGER,
    idempotent INTEGER,
    open_world INTEGER,
    approval_mode TEXT NOT NULL DEFAULT 'blocked' CHECK (approval_mode IN ('automatic', 'ask', 'blocked')),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (extension_id, original_name)
);

CREATE INDEX idx_mcp_extension_tools_extension
    ON mcp_extension_tools(extension_id, enabled);
