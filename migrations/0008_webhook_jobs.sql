PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    ingress TEXT NOT NULL CHECK(ingress IN ('webhook')),
    client_request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_ingress_client_request
    ON jobs(ingress, client_request_id);

CREATE INDEX IF NOT EXISTS idx_jobs_workspace_created
    ON jobs(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK(event_type IN ('job_reserved', 'task_linked')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_events_job
    ON job_events(job_id, id);
