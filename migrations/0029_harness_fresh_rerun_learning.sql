ALTER TABLE harness_learning_patterns
    ADD COLUMN confirmations INTEGER NOT NULL DEFAULT 0 CHECK (confirmations >= 0);

ALTER TABLE harness_learning_patterns
    ADD COLUMN last_confirmed_at INTEGER;

CREATE TABLE harness_run_learning_exposures (
    run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128),
    error_category TEXT NOT NULL CHECK (length(error_category) BETWEEN 1 AND 64),
    outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN (
        'pending',
        'exercised',
        'passed',
        'failed'
    )),
    exposed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    exercised_at INTEGER,
    completed_at INTEGER,
    PRIMARY KEY(run_id, tool_name, error_category)
);

CREATE INDEX idx_harness_learning_exposures_run_outcome
    ON harness_run_learning_exposures(run_id, outcome, tool_name);
