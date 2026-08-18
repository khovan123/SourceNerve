CREATE TABLE scip_analyzer_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    analyzer_id TEXT NOT NULL,
    project_root TEXT NOT NULL,
    git_head TEXT NOT NULL,
    graph_version INTEGER NOT NULL,
    executable_sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed')),
    failure_code TEXT,
    scip_run_id TEXT,
    provider_tool TEXT,
    provider_version TEXT,
    index_sha256 TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
);

CREATE INDEX idx_scip_analyzer_runs_workspace_analyzer
    ON scip_analyzer_runs(workspace_id, analyzer_id, started_at DESC);
