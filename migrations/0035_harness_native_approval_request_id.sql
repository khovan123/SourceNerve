PRAGMA foreign_keys = ON;

ALTER TABLE harness_approvals
    ADD COLUMN external_request_id TEXT;

CREATE INDEX idx_harness_approvals_external_request
    ON harness_approvals(run_id, external_request_id, requested_at DESC, id DESC);
