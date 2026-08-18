CREATE TABLE semantic_ann_snapshots (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES semantic_runs(id) ON DELETE CASCADE,
    git_head TEXT NOT NULL,
    graph_version INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    dimension INTEGER NOT NULL CHECK(dimension > 0),
    chunk_count INTEGER NOT NULL CHECK(chunk_count > 0),
    index_hash TEXT NOT NULL,
    algorithm TEXT NOT NULL CHECK(algorithm IN ('hnsw-dot-normalized')),
    built_at INTEGER NOT NULL
);

CREATE INDEX idx_semantic_ann_run
    ON semantic_ann_snapshots(run_id);
