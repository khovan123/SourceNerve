PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS architecture_snapshots (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    git_head TEXT NOT NULL,
    graph_version INTEGER NOT NULL,
    snapshot_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'superseded')),
    created_at INTEGER NOT NULL,
    UNIQUE(workspace_id, git_head, graph_version, snapshot_hash)
);

CREATE INDEX IF NOT EXISTS idx_architecture_snapshots_current
    ON architecture_snapshots(workspace_id, status, graph_version, created_at DESC);

CREATE TABLE IF NOT EXISTS architecture_clusters (
    snapshot_id TEXT NOT NULL REFERENCES architecture_snapshots(id) ON DELETE CASCADE,
    cluster_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    file_count INTEGER NOT NULL CHECK(file_count >= 0),
    symbol_count INTEGER NOT NULL CHECK(symbol_count >= 0),
    internal_edge_count INTEGER NOT NULL CHECK(internal_edge_count >= 0),
    external_edge_count INTEGER NOT NULL CHECK(external_edge_count >= 0),
    centrality_score INTEGER NOT NULL CHECK(centrality_score >= 0),
    representative_files_json TEXT NOT NULL,
    representative_symbols_json TEXT NOT NULL,
    PRIMARY KEY(snapshot_id, cluster_key)
);

CREATE TABLE IF NOT EXISTS architecture_cluster_members (
    snapshot_id TEXT NOT NULL REFERENCES architecture_snapshots(id) ON DELETE CASCADE,
    cluster_key TEXT NOT NULL,
    path TEXT NOT NULL,
    symbol_count INTEGER NOT NULL CHECK(symbol_count >= 0),
    degree_score INTEGER NOT NULL CHECK(degree_score >= 0),
    PRIMARY KEY(snapshot_id, path),
    FOREIGN KEY(snapshot_id, cluster_key)
        REFERENCES architecture_clusters(snapshot_id, cluster_key)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_architecture_members_cluster
    ON architecture_cluster_members(snapshot_id, cluster_key, degree_score DESC, path);

CREATE TABLE IF NOT EXISTS architecture_cluster_edges (
    snapshot_id TEXT NOT NULL REFERENCES architecture_snapshots(id) ON DELETE CASCADE,
    source_cluster_key TEXT NOT NULL,
    target_cluster_key TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    edge_count INTEGER NOT NULL CHECK(edge_count > 0),
    weight_score INTEGER NOT NULL CHECK(weight_score >= 0),
    PRIMARY KEY(snapshot_id, source_cluster_key, target_cluster_key, edge_type),
    FOREIGN KEY(snapshot_id, source_cluster_key)
        REFERENCES architecture_clusters(snapshot_id, cluster_key)
        ON DELETE CASCADE,
    FOREIGN KEY(snapshot_id, target_cluster_key)
        REFERENCES architecture_clusters(snapshot_id, cluster_key)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_architecture_edges_source
    ON architecture_cluster_edges(snapshot_id, source_cluster_key, weight_score DESC);
CREATE INDEX IF NOT EXISTS idx_architecture_edges_target
    ON architecture_cluster_edges(snapshot_id, target_cluster_key, weight_score DESC);
