CREATE TABLE harness_agent_evaluations (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL REFERENCES harness_agent_turns(id) ON DELETE CASCADE,
    evaluator_version INTEGER NOT NULL CHECK (evaluator_version >= 1),
    deterministic_verdict TEXT NOT NULL CHECK (deterministic_verdict IN ('pass', 'fail')),
    checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
    metrics_json TEXT NOT NULL CHECK (json_valid(metrics_json)),
    judge_verdict TEXT CHECK (judge_verdict IS NULL OR judge_verdict IN ('pass', 'fail')),
    judge_provider_id TEXT CHECK (judge_provider_id IS NULL OR length(judge_provider_id) BETWEEN 1 AND 128),
    judge_model_id TEXT CHECK (judge_model_id IS NULL OR length(judge_model_id) BETWEEN 1 AND 128),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_harness_agent_evaluations_turn_created
    ON harness_agent_evaluations(turn_id, created_at DESC);
