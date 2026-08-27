PRAGMA foreign_keys = ON;

ALTER TABLE jobs ADD COLUMN harness_run_id TEXT REFERENCES harness_runs(id) ON DELETE CASCADE;
ALTER TABLE jobs ADD COLUMN principal_id TEXT;
ALTER TABLE jobs ADD COLUMN harness_request_id TEXT;
ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_harness_request
    ON jobs(harness_run_id, principal_id, harness_request_id)
    WHERE harness_run_id IS NOT NULL
      AND principal_id IS NOT NULL
      AND harness_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_harness_run_created
    ON jobs(harness_run_id, created_at DESC)
    WHERE harness_run_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_callback_job_event;

CREATE TABLE job_events_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK(event_type IN (
        'job_reserved',
        'task_linked',
        'job_started',
        'job_completed',
        'job_cancelled',
        'job_failed'
    )),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);

INSERT INTO job_events_v2(id, job_id, event_type, metadata_json, created_at)
SELECT id, job_id, event_type, metadata_json, created_at
FROM job_events
ORDER BY id;

DROP TABLE job_events;
ALTER TABLE job_events_v2 RENAME TO job_events;

CREATE INDEX IF NOT EXISTS idx_job_events_job
    ON job_events(job_id, id);

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
