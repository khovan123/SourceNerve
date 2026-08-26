CREATE TABLE mcp_extension_runtime_health (
    extension_id TEXT PRIMARY KEY REFERENCES mcp_extensions(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'stopped' CHECK (
        state IN ('starting', 'ready', 'degraded', 'retrying', 'error', 'stopped')
    ),
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    last_error_category TEXT CHECK (
        last_error_category IS NULL OR last_error_category IN (
            'timeout',
            'connection',
            'protocol',
            'overloaded',
            'cancelled',
            'interrupted',
            'downstream',
            'configuration',
            'unknown'
        )
    ),
    last_transition_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_healthy_at INTEGER
);

INSERT INTO mcp_extension_runtime_health(
    extension_id,
    state,
    consecutive_failures,
    last_error_category,
    last_transition_at,
    last_healthy_at
)
SELECT
    id,
    CASE WHEN enabled = 1 THEN 'starting' ELSE 'stopped' END,
    0,
    NULL,
    unixepoch(),
    NULL
FROM mcp_extensions;

CREATE TRIGGER mcp_extension_runtime_health_after_insert
AFTER INSERT ON mcp_extensions
BEGIN
    INSERT INTO mcp_extension_runtime_health(
        extension_id,
        state,
        consecutive_failures,
        last_error_category,
        last_transition_at,
        last_healthy_at
    ) VALUES(
        NEW.id,
        CASE WHEN NEW.enabled = 1 THEN 'starting' ELSE 'stopped' END,
        0,
        NULL,
        unixepoch(),
        NULL
    );
END;
