use std::collections::{BTreeMap, BTreeSet, HashMap};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    git,
    service::AppState,
};

const MAX_CLUSTERS: usize = 128;
const MAX_REPRESENTATIVE_FILES: usize = 6;
const MAX_REPRESENTATIVE_SYMBOLS: usize = 10;
const MAX_MAP_CLUSTERS: usize = 100;
const MAX_DEPENDENCIES: usize = 64;

#[derive(Debug, Default)]
struct DirNode {
    direct_files: usize,
    children: BTreeMap<String, DirNode>,
}

#[derive(Debug, Clone)]
struct FileStats {
    symbol_count: usize,
    degree_score: i64,
}

#[derive(Debug, Clone)]
struct SymbolInfo {
    key: String,
    path: String,
    kind: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
}

#[derive(Debug, Default, Clone)]
struct ClusterBuild {
    key: String,
    display_name: String,
    files: Vec<String>,
    symbol_count: usize,
    internal_edge_count: usize,
    external_edge_count: usize,
    centrality_score: i64,
    representative_files: Vec<String>,
    representative_symbols: Vec<String>,
}

#[derive(Debug, Default, Clone)]
struct EdgeBuild {
    source_cluster_key: String,
    target_cluster_key: String,
    edge_type: String,
    edge_count: usize,
    weight_score: i64,
}

#[derive(Debug, Serialize)]
struct SnapshotHashPayload<'a> {
    workspace: &'a str,
    git_head: &'a str,
    graph_version: i64,
    clusters: Vec<SnapshotHashCluster<'a>>,
    edges: Vec<SnapshotHashEdge<'a>>,
}

#[derive(Debug, Serialize)]
struct SnapshotHashCluster<'a> {
    key: &'a str,
    file_count: usize,
    symbol_count: usize,
    internal_edge_count: usize,
    external_edge_count: usize,
    centrality_score: i64,
    representative_files: &'a [String],
    representative_symbols: &'a [String],
}

#[derive(Debug, Serialize)]
struct SnapshotHashEdge<'a> {
    source_cluster_key: &'a str,
    target_cluster_key: &'a str,
    edge_type: &'a str,
    edge_count: usize,
    weight_score: i64,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ArchitectureSnapshotView {
    pub id: String,
    pub workspace: String,
    pub git_head: String,
    pub graph_version: i64,
    pub snapshot_hash: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ArchitectureDependency {
    pub cluster_key: String,
    pub edge_count: usize,
    pub weight_score: i64,
    pub edge_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ArchitectureClusterView {
    pub cluster_key: String,
    pub display_name: String,
    pub file_count: usize,
    pub symbol_count: usize,
    pub internal_edge_count: usize,
    pub external_edge_count: usize,
    pub centrality_score: i64,
    pub representative_files: Vec<String>,
    pub representative_symbols: Vec<String>,
    pub inbound: Vec<ArchitectureDependency>,
    pub outbound: Vec<ArchitectureDependency>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ArchitectureMapRequest {
    pub workspace: String,
    #[serde(default = "default_map_limit")]
    pub limit: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ArchitectureClusterRequest {
    pub workspace: String,
    pub cluster_key: String,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ArchitectureRebuildResult {
    pub snapshot: ArchitectureSnapshotView,
    pub cluster_count: usize,
    pub replayed: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ArchitectureMapResult {
    pub snapshot: Option<ArchitectureSnapshotView>,
    pub clusters: Vec<ArchitectureClusterView>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ArchitectureClusterResult {
    pub snapshot: Option<ArchitectureSnapshotView>,
    pub cluster: Option<ArchitectureClusterView>,
}

#[derive(Debug, Clone)]
pub(crate) struct ArchitectureSeedHit {
    pub cluster_key: String,
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub symbol_key: Option<String>,
    pub centrality_score: i64,
}

type SnapshotDbRow = (String, String, String, i64, String, i64);
type ClusterDbRow = (String, String, i64, i64, i64, i64, i64, String, String);
type EdgeDbRow = (String, String, String, i64, i64);
type SymbolDbRow = (i64, String, String, String, Option<i64>, Option<i64>);
type GraphEdgeDbRow = (i64, i64, String);

fn default_map_limit() -> usize {
    64
}

fn graph_weight(edge_type: &str) -> i64 {
    match edge_type {
        "CALLS" => 150,
        "REFERENCES" => 125,
        "IMPLEMENTS" | "EXTENDS" | "TYPE_DEFINITION" => 120,
        "IMPORTS" => 90,
        _ => 0,
    }
}

fn accepted_edge_type(edge_type: &str) -> bool {
    matches!(
        edge_type,
        "CALLS" | "REFERENCES" | "IMPLEMENTS" | "EXTENDS" | "TYPE_DEFINITION" | "IMPORTS"
    )
}

fn insert_path(tree: &mut DirNode, path: &str) {
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() <= 1 {
        tree.direct_files += 1;
        return;
    }
    let mut node = tree;
    for directory in &parts[..parts.len() - 1] {
        node = node.children.entry((*directory).to_string()).or_default();
    }
    node.direct_files += 1;
}

fn collapsed_prefix(name: &str, node: &DirNode) -> String {
    let mut key = name.to_string();
    let mut cursor = node;
    while cursor.direct_files == 0 && cursor.children.len() == 1 {
        let (child_name, child) = cursor.children.iter().next().expect("single child");
        key.push('/');
        key.push_str(child_name);
        cursor = child;
    }
    key
}

fn cluster_prefixes(paths: &[String]) -> Vec<String> {
    let mut tree = DirNode::default();
    for path in paths {
        insert_path(&mut tree, path);
    }

    let mut keys = Vec::new();
    if tree.direct_files > 0 {
        keys.push("__root__".to_string());
    }
    for (name, node) in &tree.children {
        keys.push(collapsed_prefix(name, node));
    }
    keys.sort();
    if keys.len() <= MAX_CLUSTERS {
        return keys;
    }

    let mut bounded = keys.into_iter().take(MAX_CLUSTERS - 1).collect::<Vec<_>>();
    bounded.push("__other__".to_string());
    bounded
}

fn cluster_for_path(path: &str, cluster_keys: &[String]) -> String {
    if !path.contains('/') && cluster_keys.iter().any(|key| key == "__root__") {
        return "__root__".to_string();
    }
    let mut best: Option<&str> = None;
    for key in cluster_keys {
        if key.starts_with("__") {
            continue;
        }
        if (path == key || path.starts_with(&format!("{key}/")))
            && best.is_none_or(|current| key.len() > current.len())
        {
            best = Some(key);
        }
    }
    if let Some(key) = best {
        key.to_string()
    } else if cluster_keys.iter().any(|key| key == "__other__") {
        "__other__".to_string()
    } else {
        "__root__".to_string()
    }
}

fn display_name(key: &str) -> String {
    match key {
        "__root__" => "Repository root".into(),
        "__other__" => "Other modules".into(),
        _ => key.to_string(),
    }
}

async fn current_index_state(state: &AppState, workspace: &str) -> AppResult<(String, i64)> {
    let row: (Option<String>, i64) =
        sqlx::query_as("SELECT indexed_head, graph_version FROM workspaces WHERE id=?1")
            .bind(workspace)
            .fetch_one(&state.db)
            .await?;
    let head = row
        .0
        .ok_or_else(|| AppError::InvalidRequest("workspace has not been indexed yet".into()))?;
    Ok((head, row.1))
}

async fn require_clean_indexed_state(
    state: &AppState,
    workspace: &str,
) -> AppResult<(String, i64)> {
    let ws = state.workspaces.get(workspace)?;
    let actual_head = git::head(&ws.root).await?;
    if !git::status(&ws.root).await?.is_empty() {
        return Err(AppError::InvalidRequest(
            "architecture intelligence requires a clean working tree".into(),
        ));
    }
    let (indexed_head, graph_version) = current_index_state(state, workspace).await?;
    if actual_head != indexed_head {
        return Err(AppError::InvalidRequest(format!(
            "architecture intelligence requires repository intelligence at current HEAD: indexed {indexed_head}, current {actual_head}"
        )));
    }
    Ok((indexed_head, graph_version))
}

fn snapshot_from_row(row: SnapshotDbRow) -> ArchitectureSnapshotView {
    ArchitectureSnapshotView {
        id: row.0,
        workspace: row.1,
        git_head: row.2,
        graph_version: row.3,
        snapshot_hash: row.4,
        created_at: row.5,
    }
}

async fn load_snapshot(state: &AppState, snapshot_id: &str) -> AppResult<ArchitectureSnapshotView> {
    let row: SnapshotDbRow = sqlx::query_as(
        "SELECT id, workspace_id, git_head, graph_version, snapshot_hash, created_at \
         FROM architecture_snapshots WHERE id=?1",
    )
    .bind(snapshot_id)
    .fetch_one(&state.db)
    .await?;
    Ok(snapshot_from_row(row))
}

async fn current_snapshot(
    state: &AppState,
    workspace: &str,
) -> AppResult<Option<ArchitectureSnapshotView>> {
    state.workspaces.get(workspace)?;
    let (head, graph_version) = current_index_state(state, workspace).await?;
    let row: Option<SnapshotDbRow> = sqlx::query_as(
        "SELECT id, workspace_id, git_head, graph_version, snapshot_hash, created_at \
         FROM architecture_snapshots \
         WHERE workspace_id=?1 AND status='active' AND git_head=?2 AND graph_version=?3 \
         ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(workspace)
    .bind(head)
    .bind(graph_version)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(snapshot_from_row))
}

fn snapshot_hash(
    workspace: &str,
    head: &str,
    graph_version: i64,
    clusters: &[ClusterBuild],
    edges: &[EdgeBuild],
) -> AppResult<String> {
    let payload = SnapshotHashPayload {
        workspace,
        git_head: head,
        graph_version,
        clusters: clusters
            .iter()
            .map(|cluster| SnapshotHashCluster {
                key: &cluster.key,
                file_count: cluster.files.len(),
                symbol_count: cluster.symbol_count,
                internal_edge_count: cluster.internal_edge_count,
                external_edge_count: cluster.external_edge_count,
                centrality_score: cluster.centrality_score,
                representative_files: &cluster.representative_files,
                representative_symbols: &cluster.representative_symbols,
            })
            .collect(),
        edges: edges
            .iter()
            .map(|edge| SnapshotHashEdge {
                source_cluster_key: &edge.source_cluster_key,
                target_cluster_key: &edge.target_cluster_key,
                edge_type: &edge.edge_type,
                edge_count: edge.edge_count,
                weight_score: edge.weight_score,
            })
            .collect(),
    };
    let encoded = serde_json::to_vec(&payload).map_err(anyhow::Error::from)?;
    Ok(hex::encode(Sha256::digest(encoded)))
}

pub async fn rebuild(state: &AppState, workspace: &str) -> AppResult<ArchitectureRebuildResult> {
    state.workspaces.get(workspace)?;
    let _guard = state.mutation_lock.lock().await;
    let (head, graph_version) = require_clean_indexed_state(state, workspace).await?;

    let file_paths: Vec<String> = sqlx::query_scalar(
        "SELECT path FROM files WHERE workspace_id=?1 AND content IS NOT NULL ORDER BY path",
    )
    .bind(workspace)
    .fetch_all(&state.db)
    .await?;
    if file_paths.is_empty() {
        return Err(AppError::InvalidRequest(
            "architecture rebuild requires at least one indexed text file".into(),
        ));
    }

    let cluster_keys = cluster_prefixes(&file_paths);
    let mut cluster_by_path = HashMap::new();
    let mut clusters: BTreeMap<String, ClusterBuild> = BTreeMap::new();
    let mut file_stats: BTreeMap<String, FileStats> = BTreeMap::new();
    for path in &file_paths {
        let key = cluster_for_path(path, &cluster_keys);
        cluster_by_path.insert(path.clone(), key.clone());
        clusters
            .entry(key.clone())
            .or_insert_with(|| ClusterBuild {
                key: key.clone(),
                display_name: display_name(&key),
                ..ClusterBuild::default()
            })
            .files
            .push(path.clone());
        file_stats.insert(
            path.clone(),
            FileStats {
                symbol_count: 0,
                degree_score: 0,
            },
        );
    }

    let symbol_rows: Vec<SymbolDbRow> = sqlx::query_as(
        "SELECT s.id, s.symbol_key, f.path, s.kind, s.start_line, s.end_line \
         FROM symbols s JOIN files f ON f.id=s.file_id \
         WHERE s.workspace_id=?1 ORDER BY s.symbol_key",
    )
    .bind(workspace)
    .fetch_all(&state.db)
    .await?;
    let mut symbols_by_id = HashMap::new();
    let mut symbol_degree: HashMap<i64, i64> = HashMap::new();
    for (id, key, path, kind, start_line, end_line) in symbol_rows {
        if let Some(stats) = file_stats.get_mut(&path) {
            stats.symbol_count += 1;
        }
        if let Some(cluster_key) = cluster_by_path.get(&path) {
            if let Some(cluster) = clusters.get_mut(cluster_key) {
                cluster.symbol_count += 1;
            }
        }
        symbols_by_id.insert(
            id,
            SymbolInfo {
                key,
                path,
                kind,
                start_line: start_line.and_then(|value| usize::try_from(value).ok()),
                end_line: end_line.and_then(|value| usize::try_from(value).ok()),
            },
        );
    }

    let graph_edges: Vec<GraphEdgeDbRow> = sqlx::query_as(
        "SELECT source_symbol_id, target_symbol_id, edge_type \
         FROM edges WHERE workspace_id=?1 ORDER BY source_symbol_id, target_symbol_id, edge_type, source",
    )
    .bind(workspace)
    .fetch_all(&state.db)
    .await?;
    let mut edge_builds: BTreeMap<(String, String, String), EdgeBuild> = BTreeMap::new();
    for (source_id, target_id, edge_type) in graph_edges {
        if !accepted_edge_type(&edge_type) {
            continue;
        }
        let Some(source) = symbols_by_id.get(&source_id) else {
            continue;
        };
        let Some(target) = symbols_by_id.get(&target_id) else {
            continue;
        };
        let Some(source_cluster) = cluster_by_path.get(&source.path) else {
            continue;
        };
        let Some(target_cluster) = cluster_by_path.get(&target.path) else {
            continue;
        };
        let weight = graph_weight(&edge_type);
        *symbol_degree.entry(source_id).or_default() += weight;
        *symbol_degree.entry(target_id).or_default() += weight;
        if let Some(stats) = file_stats.get_mut(&source.path) {
            stats.degree_score += weight;
        }
        if let Some(stats) = file_stats.get_mut(&target.path) {
            stats.degree_score += weight;
        }

        if source_cluster == target_cluster {
            if let Some(cluster) = clusters.get_mut(source_cluster) {
                cluster.internal_edge_count += 1;
                cluster.centrality_score += weight;
            }
            continue;
        }

        if let Some(cluster) = clusters.get_mut(source_cluster) {
            cluster.external_edge_count += 1;
            cluster.centrality_score += weight;
        }
        if let Some(cluster) = clusters.get_mut(target_cluster) {
            cluster.external_edge_count += 1;
            cluster.centrality_score += weight;
        }
        let key = (
            source_cluster.clone(),
            target_cluster.clone(),
            edge_type.clone(),
        );
        let edge = edge_builds.entry(key).or_insert_with(|| EdgeBuild {
            source_cluster_key: source_cluster.clone(),
            target_cluster_key: target_cluster.clone(),
            edge_type: edge_type.clone(),
            ..EdgeBuild::default()
        });
        edge.edge_count += 1;
        edge.weight_score += weight;
    }

    for cluster in clusters.values_mut() {
        cluster.files.sort();
        let mut ranked_files = cluster.files.clone();
        ranked_files.sort_by(|left, right| {
            let left_stats = file_stats.get(left).expect("file stats");
            let right_stats = file_stats.get(right).expect("file stats");
            right_stats
                .degree_score
                .cmp(&left_stats.degree_score)
                .then_with(|| right_stats.symbol_count.cmp(&left_stats.symbol_count))
                .then_with(|| left.cmp(right))
        });
        ranked_files.truncate(MAX_REPRESENTATIVE_FILES);
        cluster.representative_files = ranked_files;

        let mut ranked_symbols = symbols_by_id
            .iter()
            .filter(|(_, symbol)| {
                symbol.kind != "file"
                    && cluster_by_path.get(&symbol.path) == Some(&cluster.key)
                    && (symbol.start_line.is_some() || symbol.end_line.is_some())
            })
            .map(|(id, symbol)| {
                (
                    symbol_degree.get(id).copied().unwrap_or(0),
                    symbol.key.clone(),
                )
            })
            .collect::<Vec<_>>();
        ranked_symbols
            .sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
        ranked_symbols.truncate(MAX_REPRESENTATIVE_SYMBOLS);
        cluster.representative_symbols = ranked_symbols.into_iter().map(|(_, key)| key).collect();
    }

    let clusters = clusters.into_values().collect::<Vec<_>>();
    let edges = edge_builds.into_values().collect::<Vec<_>>();
    let hash = snapshot_hash(workspace, &head, graph_version, &clusters, &edges)?;

    let existing: Option<String> = sqlx::query_scalar(
        "SELECT id FROM architecture_snapshots \
         WHERE workspace_id=?1 AND git_head=?2 AND graph_version=?3 AND snapshot_hash=?4 \
         ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(workspace)
    .bind(&head)
    .bind(graph_version)
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    if let Some(snapshot_id) = existing {
        let mut tx = state.db.begin().await?;
        sqlx::query(
            "UPDATE architecture_snapshots SET status='superseded' \
             WHERE workspace_id=?1 AND status='active' AND id<>?2",
        )
        .bind(workspace)
        .bind(&snapshot_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE architecture_snapshots SET status='active' WHERE id=?1")
            .bind(&snapshot_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(ArchitectureRebuildResult {
            snapshot: load_snapshot(state, &snapshot_id).await?,
            cluster_count: clusters.len(),
            replayed: true,
        });
    }

    let snapshot_id = Uuid::new_v4().to_string();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE architecture_snapshots SET status='superseded' \
         WHERE workspace_id=?1 AND status='active'",
    )
    .bind(workspace)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO architecture_snapshots(\
            id, workspace_id, git_head, graph_version, snapshot_hash, status, created_at\
         ) VALUES(?1, ?2, ?3, ?4, ?5, 'active', unixepoch())",
    )
    .bind(&snapshot_id)
    .bind(workspace)
    .bind(&head)
    .bind(graph_version)
    .bind(&hash)
    .execute(&mut *tx)
    .await?;

    for cluster in &clusters {
        sqlx::query(
            "INSERT INTO architecture_clusters(\
                snapshot_id, cluster_key, display_name, file_count, symbol_count, internal_edge_count, external_edge_count, centrality_score, representative_files_json, representative_symbols_json\
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )
        .bind(&snapshot_id)
        .bind(&cluster.key)
        .bind(&cluster.display_name)
        .bind(cluster.files.len() as i64)
        .bind(cluster.symbol_count as i64)
        .bind(cluster.internal_edge_count as i64)
        .bind(cluster.external_edge_count as i64)
        .bind(cluster.centrality_score)
        .bind(serde_json::to_string(&cluster.representative_files).map_err(anyhow::Error::from)?)
        .bind(serde_json::to_string(&cluster.representative_symbols).map_err(anyhow::Error::from)?)
        .execute(&mut *tx)
        .await?;

        for path in &cluster.files {
            let stats = file_stats.get(path).expect("file stats");
            sqlx::query(
                "INSERT INTO architecture_cluster_members(\
                    snapshot_id, cluster_key, path, symbol_count, degree_score\
                 ) VALUES(?1, ?2, ?3, ?4, ?5)",
            )
            .bind(&snapshot_id)
            .bind(&cluster.key)
            .bind(path)
            .bind(stats.symbol_count as i64)
            .bind(stats.degree_score)
            .execute(&mut *tx)
            .await?;
        }
    }

    for edge in &edges {
        sqlx::query(
            "INSERT INTO architecture_cluster_edges(\
                snapshot_id, source_cluster_key, target_cluster_key, edge_type, edge_count, weight_score\
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(&snapshot_id)
        .bind(&edge.source_cluster_key)
        .bind(&edge.target_cluster_key)
        .bind(&edge.edge_type)
        .bind(edge.edge_count as i64)
        .bind(edge.weight_score)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    Ok(ArchitectureRebuildResult {
        snapshot: load_snapshot(state, &snapshot_id).await?,
        cluster_count: clusters.len(),
        replayed: false,
    })
}

fn dependency_views(rows: Vec<EdgeDbRow>, outbound: bool) -> Vec<ArchitectureDependency> {
    let mut grouped: BTreeMap<String, (usize, i64, BTreeSet<String>)> = BTreeMap::new();
    for (source, target, edge_type, edge_count, weight_score) in rows {
        let key = if outbound { target } else { source };
        let value = grouped.entry(key).or_default();
        value.0 += usize::try_from(edge_count).unwrap_or(0);
        value.1 += weight_score;
        value.2.insert(edge_type);
    }
    let mut values = grouped
        .into_iter()
        .map(
            |(cluster_key, (edge_count, weight_score, edge_types))| ArchitectureDependency {
                cluster_key,
                edge_count,
                weight_score,
                edge_types: edge_types.into_iter().collect(),
            },
        )
        .collect::<Vec<_>>();
    values.sort_by(|left, right| {
        right
            .weight_score
            .cmp(&left.weight_score)
            .then_with(|| right.edge_count.cmp(&left.edge_count))
            .then_with(|| left.cluster_key.cmp(&right.cluster_key))
    });
    values.truncate(MAX_DEPENDENCIES);
    values
}

async fn cluster_view(
    state: &AppState,
    snapshot_id: &str,
    cluster_key: &str,
) -> AppResult<Option<ArchitectureClusterView>> {
    let row: Option<ClusterDbRow> = sqlx::query_as(
        "SELECT cluster_key, display_name, file_count, symbol_count, internal_edge_count, external_edge_count, centrality_score, representative_files_json, representative_symbols_json \
         FROM architecture_clusters WHERE snapshot_id=?1 AND cluster_key=?2",
    )
    .bind(snapshot_id)
    .bind(cluster_key)
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let inbound_rows: Vec<EdgeDbRow> = sqlx::query_as(
        "SELECT source_cluster_key, target_cluster_key, edge_type, edge_count, weight_score \
         FROM architecture_cluster_edges WHERE snapshot_id=?1 AND target_cluster_key=?2 \
         ORDER BY weight_score DESC, source_cluster_key, edge_type",
    )
    .bind(snapshot_id)
    .bind(cluster_key)
    .fetch_all(&state.db)
    .await?;
    let outbound_rows: Vec<EdgeDbRow> = sqlx::query_as(
        "SELECT source_cluster_key, target_cluster_key, edge_type, edge_count, weight_score \
         FROM architecture_cluster_edges WHERE snapshot_id=?1 AND source_cluster_key=?2 \
         ORDER BY weight_score DESC, target_cluster_key, edge_type",
    )
    .bind(snapshot_id)
    .bind(cluster_key)
    .fetch_all(&state.db)
    .await?;
    Ok(Some(ArchitectureClusterView {
        cluster_key: row.0,
        display_name: row.1,
        file_count: usize::try_from(row.2).unwrap_or(0),
        symbol_count: usize::try_from(row.3).unwrap_or(0),
        internal_edge_count: usize::try_from(row.4).unwrap_or(0),
        external_edge_count: usize::try_from(row.5).unwrap_or(0),
        centrality_score: row.6,
        representative_files: serde_json::from_str(&row.7).map_err(anyhow::Error::from)?,
        representative_symbols: serde_json::from_str(&row.8).map_err(anyhow::Error::from)?,
        inbound: dependency_views(inbound_rows, false),
        outbound: dependency_views(outbound_rows, true),
    }))
}

pub async fn map(
    state: &AppState,
    request: ArchitectureMapRequest,
) -> AppResult<ArchitectureMapResult> {
    require_clean_indexed_state(state, &request.workspace).await?;
    let Some(snapshot) = current_snapshot(state, &request.workspace).await? else {
        return Ok(ArchitectureMapResult {
            snapshot: None,
            clusters: Vec::new(),
        });
    };
    let keys: Vec<String> = sqlx::query_scalar(
        "SELECT cluster_key FROM architecture_clusters WHERE snapshot_id=?1 \
         ORDER BY centrality_score DESC, cluster_key LIMIT ?2",
    )
    .bind(&snapshot.id)
    .bind(request.limit.clamp(1, MAX_MAP_CLUSTERS) as i64)
    .fetch_all(&state.db)
    .await?;
    let mut clusters = Vec::with_capacity(keys.len());
    for key in keys {
        if let Some(cluster) = cluster_view(state, &snapshot.id, &key).await? {
            clusters.push(cluster);
        }
    }
    Ok(ArchitectureMapResult {
        snapshot: Some(snapshot),
        clusters,
    })
}

pub async fn cluster(
    state: &AppState,
    request: ArchitectureClusterRequest,
) -> AppResult<ArchitectureClusterResult> {
    require_clean_indexed_state(state, &request.workspace).await?;
    let Some(snapshot) = current_snapshot(state, &request.workspace).await? else {
        return Ok(ArchitectureClusterResult {
            snapshot: None,
            cluster: None,
        });
    };
    let cluster = cluster_view(state, &snapshot.id, &request.cluster_key).await?;
    Ok(ArchitectureClusterResult {
        snapshot: Some(snapshot),
        cluster,
    })
}

pub(crate) async fn seed_hits(
    state: &AppState,
    workspace: &str,
    cluster_keys: &[String],
) -> AppResult<Vec<ArchitectureSeedHit>> {
    if cluster_keys.is_empty() {
        return Ok(Vec::new());
    }
    let Some(snapshot) = current_snapshot(state, workspace).await? else {
        return Ok(Vec::new());
    };
    let requested = cluster_keys.iter().cloned().collect::<BTreeSet<_>>();
    let mut hits = Vec::new();
    for cluster_key in requested.into_iter().take(12) {
        let row: Option<(i64, String, String)> = sqlx::query_as(
            "SELECT centrality_score, representative_files_json, representative_symbols_json \
             FROM architecture_clusters WHERE snapshot_id=?1 AND cluster_key=?2",
        )
        .bind(&snapshot.id)
        .bind(&cluster_key)
        .fetch_optional(&state.db)
        .await?;
        let Some((centrality_score, representative_files_json, representative_symbols_json)) = row
        else {
            continue;
        };
        let representative_symbols: Vec<String> =
            serde_json::from_str(&representative_symbols_json).map_err(anyhow::Error::from)?;
        let representative_files: Vec<String> =
            serde_json::from_str(&representative_files_json).map_err(anyhow::Error::from)?;
        let mut used_paths = BTreeSet::new();
        for symbol_key in representative_symbols.into_iter().take(6) {
            let symbol: Option<(String, Option<i64>, Option<i64>)> = sqlx::query_as(
                "SELECT f.path, s.start_line, s.end_line FROM symbols s \
                 JOIN files f ON f.id=s.file_id \
                 WHERE s.workspace_id=?1 AND s.symbol_key=?2",
            )
            .bind(workspace)
            .bind(&symbol_key)
            .fetch_optional(&state.db)
            .await?;
            let Some((path, start_line, end_line)) = symbol else {
                continue;
            };
            let start_line = start_line
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(1);
            let end_line = end_line
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(start_line)
                .max(start_line);
            used_paths.insert(path.clone());
            hits.push(ArchitectureSeedHit {
                cluster_key: cluster_key.clone(),
                path,
                start_line,
                end_line,
                symbol_key: Some(symbol_key),
                centrality_score,
            });
        }
        for path in representative_files.into_iter().take(4) {
            if used_paths.contains(&path) {
                continue;
            }
            hits.push(ArchitectureSeedHit {
                cluster_key: cluster_key.clone(),
                path,
                start_line: 1,
                end_line: 80,
                symbol_key: None,
                centrality_score,
            });
        }
    }
    hits.sort_by(|left, right| {
        right
            .centrality_score
            .cmp(&left.centrality_score)
            .then_with(|| left.cluster_key.cmp(&right.cluster_key))
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.start_line.cmp(&right.start_line))
    });
    hits.truncate(32);
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::{DirNode, cluster_prefixes, collapsed_prefix, insert_path};

    #[test]
    fn collapses_trivial_single_child_directory_chain() {
        let mut root = DirNode::default();
        insert_path(&mut root, "src/platform/http/router.rs");
        insert_path(&mut root, "src/platform/http/auth.rs");
        let src = root.children.get("src").expect("src node");
        assert_eq!(collapsed_prefix("src", src), "src/platform/http");
    }

    #[test]
    fn branching_directory_stops_collapse() {
        let paths = vec![
            "src/api/mod.rs".to_string(),
            "src/domain/model.rs".to_string(),
            "README.md".to_string(),
        ];
        assert_eq!(
            cluster_prefixes(&paths),
            vec!["__root__".to_string(), "src".to_string()]
        );
    }
}
