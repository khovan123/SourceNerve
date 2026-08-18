PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS enrichment_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    git_head TEXT NOT NULL,
    graph_version INTEGER NOT NULL,
    provider_version TEXT,
    status TEXT NOT NULL CHECK(status IN ('active', 'stale')),
    documents INTEGER NOT NULL DEFAULT 0,
    mapped_symbols INTEGER NOT NULL DEFAULT 0,
    materialized_edges INTEGER NOT NULL DEFAULT 0,
    unresolved_facts INTEGER NOT NULL DEFAULT 0,
    imported_at INTEGER NOT NULL,
    stale_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_enrichment_active_provider
    ON enrichment_runs(workspace_id, provider)
    WHERE status='active';

CREATE INDEX IF NOT EXISTS idx_enrichment_runs_workspace
    ON enrichment_runs(workspace_id, imported_at DESC);

CREATE TABLE IF NOT EXISTS enrichment_symbol_map (
    run_id TEXT NOT NULL REFERENCES enrichment_runs(id) ON DELETE CASCADE,
    scip_symbol TEXT NOT NULL,
    symbol_key TEXT NOT NULL,
    PRIMARY KEY(run_id, scip_symbol)
);

CREATE TABLE IF NOT EXISTS enrichment_unresolved (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES enrichment_runs(id) ON DELETE CASCADE,
    document_path TEXT,
    line INTEGER,
    source_scip_symbol TEXT,
    target_scip_symbol TEXT,
    fact_type TEXT NOT NULL,
    reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_enrichment_unresolved_run
    ON enrichment_unresolved(run_id);
