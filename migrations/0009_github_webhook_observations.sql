PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id TEXT NOT NULL UNIQUE,
    event_name TEXT NOT NULL,
    payload_fingerprint TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    repository TEXT NOT NULL,
    pull_number INTEGER NOT NULL,
    pull_head_sha TEXT NOT NULL,
    action TEXT,
    pull_state TEXT,
    pull_merged INTEGER CHECK(pull_merged IN (0, 1) OR pull_merged IS NULL),
    check_status TEXT,
    check_conclusion TEXT,
    review_state TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_github_webhook_task_created
    ON github_webhook_deliveries(task_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_github_webhook_workspace_pull
    ON github_webhook_deliveries(workspace_id, pull_number, id DESC);
