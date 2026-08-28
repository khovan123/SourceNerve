CREATE TABLE harness_run_loops (
    run_id TEXT PRIMARY KEY REFERENCES harness_runs(id) ON DELETE CASCADE,
    phase TEXT NOT NULL DEFAULT 'context' CHECK (phase IN (
        'context',
        'execute',
        'verify',
        'recover',
        'learn'
    )),
    context_reads INTEGER NOT NULL DEFAULT 0 CHECK (context_reads >= 0),
    executions INTEGER NOT NULL DEFAULT 0 CHECK (executions >= 0),
    verification_required INTEGER NOT NULL DEFAULT 0 CHECK (verification_required IN (0, 1)),
    verification_status TEXT NOT NULL DEFAULT 'idle' CHECK (verification_status IN (
        'idle',
        'pending',
        'passed',
        'failed'
    )),
    recovery_status TEXT NOT NULL DEFAULT 'idle' CHECK (recovery_status IN (
        'idle',
        'needed',
        'in-progress',
        'recovered'
    )),
    failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    learning_count INTEGER NOT NULL DEFAULT 0 CHECK (learning_count >= 0),
    last_failure_tool TEXT CHECK (last_failure_tool IS NULL OR length(last_failure_tool) BETWEEN 1 AND 128),
    last_failure_category TEXT CHECK (last_failure_category IS NULL OR length(last_failure_category) BETWEEN 1 AND 64),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO harness_run_loops(run_id)
SELECT id FROM harness_runs;

CREATE TRIGGER harness_runs_initialize_closed_loop
AFTER INSERT ON harness_runs
BEGIN
    INSERT INTO harness_run_loops(run_id) VALUES(NEW.id);
END;

CREATE TABLE harness_learning_patterns (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128),
    error_category TEXT NOT NULL CHECK (length(error_category) BETWEEN 1 AND 64),
    failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
    recoveries INTEGER NOT NULL DEFAULT 0 CHECK (recoveries >= 0),
    last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_recovered_at INTEGER,
    PRIMARY KEY(workspace_id, tool_name, error_category)
);

CREATE INDEX idx_harness_learning_patterns_workspace
    ON harness_learning_patterns(workspace_id, failures DESC, last_seen_at DESC);
