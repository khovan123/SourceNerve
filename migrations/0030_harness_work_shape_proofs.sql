ALTER TABLE harness_run_loops
    ADD COLUMN work_shape TEXT NOT NULL DEFAULT 'read-only' CHECK (work_shape IN (
        'read-only',
        'bounded',
        'durable',
        'operate-application',
        'invariant'
    ));

ALTER TABLE harness_run_loops
    ADD COLUMN work_scope TEXT CHECK (work_scope IS NULL OR length(work_scope) BETWEEN 1 AND 512);

ALTER TABLE harness_run_loops
    ADD COLUMN selected_proof_type TEXT CHECK (selected_proof_type IS NULL OR selected_proof_type IN (
        'focused-test',
        'integration',
        'e2e',
        'recovery-rehearsal',
        'measurement'
    ));

ALTER TABLE harness_run_loops
    ADD COLUMN selected_proof_source TEXT CHECK (selected_proof_source IS NULL OR length(selected_proof_source) BETWEEN 1 AND 512);

ALTER TABLE harness_run_loops
    ADD COLUMN selected_proof_command TEXT CHECK (selected_proof_command IS NULL OR length(selected_proof_command) BETWEEN 1 AND 1024);

CREATE TABLE harness_run_proofs (
    run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
    proof_type TEXT NOT NULL CHECK (proof_type IN (
        'focused-test',
        'integration',
        'e2e',
        'recovery-rehearsal',
        'measurement'
    )),
    proof_source TEXT CHECK (proof_source IS NULL OR length(proof_source) BETWEEN 1 AND 512),
    status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
    tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY(run_id, proof_type)
);

CREATE INDEX idx_harness_run_proofs_run_status
    ON harness_run_proofs(run_id, status, proof_type);
