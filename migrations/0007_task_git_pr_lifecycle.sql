PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS task_lifecycle (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK(phase IN (
        'snapshot', 'branched', 'patched', 'reviewed', 'committed', 'pushed', 'pr_open', 'merged', 'completed'
    )),
    branch TEXT,
    reviewed_diff_sha256 TEXT,
    commit_sha TEXT,
    push_sha TEXT,
    issue_number INTEGER,
    pull_number INTEGER,
    pull_head_sha TEXT,
    merge_sha TEXT,
    default_synced_head TEXT,
    updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO task_lifecycle(task_id, phase, updated_at)
SELECT id, CASE WHEN status='applied' THEN 'patched' ELSE 'snapshot' END, unixepoch()
FROM tasks;

CREATE TRIGGER IF NOT EXISTS trg_tasks_create_lifecycle
AFTER INSERT ON tasks
BEGIN
    INSERT OR IGNORE INTO task_lifecycle(task_id, phase, updated_at)
    VALUES(NEW.id, 'snapshot', unixepoch());
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_applied_lifecycle
AFTER UPDATE OF status ON tasks
WHEN NEW.status='applied'
BEGIN
    UPDATE task_lifecycle
    SET phase=CASE
        WHEN phase IN ('snapshot', 'branched') THEN 'patched'
        ELSE phase
    END,
    updated_at=unixepoch()
    WHERE task_id=NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_task_lifecycle_phase
    ON task_lifecycle(phase, updated_at DESC);
