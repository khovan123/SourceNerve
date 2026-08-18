PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS callback_runtime_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
    updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO callback_runtime_state(id, enabled, updated_at)
VALUES(1, 0, unixepoch());

CREATE TABLE IF NOT EXISTS callback_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
    event_key TEXT NOT NULL UNIQUE,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('task_event', 'job_event', 'github_observation')),
    source_id INTEGER NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivering', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_http_status INTEGER,
    last_error_code TEXT,
    delivered_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_callback_outbox_due
    ON callback_outbox(status, next_attempt_at, id);

CREATE INDEX IF NOT EXISTS idx_callback_outbox_task
    ON callback_outbox(task_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_callback_outbox_job
    ON callback_outbox(job_id, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_callback_task_event
AFTER INSERT ON task_events
WHEN (SELECT enabled FROM callback_runtime_state WHERE id=1) = 1
BEGIN
    INSERT OR IGNORE INTO callback_outbox(
        event_key, source_kind, source_id, workspace_id, task_id, job_id, created_at, updated_at
    )
    SELECT
        'task_event:' || NEW.id,
        'task_event',
        NEW.id,
        t.workspace_id,
        NEW.task_id,
        (
            SELECT j.id FROM jobs j
            WHERE j.task_id = NEW.task_id
            ORDER BY j.created_at, j.id
            LIMIT 1
        ),
        NEW.created_at,
        NEW.created_at
    FROM tasks t
    WHERE t.id = NEW.task_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_callback_job_event
AFTER INSERT ON job_events
WHEN (SELECT enabled FROM callback_runtime_state WHERE id=1) = 1
BEGIN
    INSERT OR IGNORE INTO callback_outbox(
        event_key, source_kind, source_id, workspace_id, task_id, job_id, created_at, updated_at
    )
    SELECT
        'job_event:' || NEW.id,
        'job_event',
        NEW.id,
        j.workspace_id,
        j.task_id,
        NEW.job_id,
        NEW.created_at,
        NEW.created_at
    FROM jobs j
    WHERE j.id = NEW.job_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_callback_github_observation
AFTER INSERT ON github_webhook_deliveries
WHEN (SELECT enabled FROM callback_runtime_state WHERE id=1) = 1
BEGIN
    INSERT OR IGNORE INTO callback_outbox(
        event_key, source_kind, source_id, workspace_id, task_id, job_id, created_at, updated_at
    )
    VALUES(
        'github_observation:' || NEW.id,
        'github_observation',
        NEW.id,
        NEW.workspace_id,
        NEW.task_id,
        (
            SELECT j.id FROM jobs j
            WHERE j.task_id = NEW.task_id
            ORDER BY j.created_at, j.id
            LIMIT 1
        ),
        NEW.created_at,
        NEW.created_at
    );
END;
