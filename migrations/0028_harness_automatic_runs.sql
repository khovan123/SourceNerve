ALTER TABLE harness_runs
    ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
    CHECK (origin IN ('manual', 'automatic'));

CREATE UNIQUE INDEX idx_harness_runs_one_automatic_active
    ON harness_runs(principal_id, workspace_id)
    WHERE origin='automatic' AND parent_run_id IS NULL AND status='running';
