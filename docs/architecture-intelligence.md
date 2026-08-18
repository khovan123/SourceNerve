# Architecture intelligence

SourceNerve schema v12 adds a deterministic architecture map derived from the current indexed repository and resolved structural graph.

Architecture intelligence is derived metadata. Git, indexed file hashes, Tree-sitter graph facts, SCIP provenance, semantic vectors, and the existing reviewed mutation lifecycle remain authoritative.

## Rebuild

`POST /api/v1/architecture/rebuild`

```json
{
  "workspace": "repo"
}
```

A rebuild requires:

- a configured workspace;
- a clean working tree;
- current Git HEAD equal to the workspace indexed HEAD;
- at least one indexed text file.

SourceNerve computes the full architecture snapshot before activating it. Snapshot persistence is transactional, so a failed rebuild cannot replace the previous valid snapshot.

The snapshot is bound to the exact indexed Git HEAD and graph version. Rebuilding identical state produces the same deterministic snapshot hash and replays the existing persisted snapshot rather than creating duplicate logical state.

## Clustering

The v12 clustering algorithm is intentionally deterministic and explainable:

- start from repository-relative indexed text paths;
- group root files under `__root__`;
- use repository directory roots as module candidates;
- collapse trivial directory chains that contain no direct files and only one child;
- cap the number of clusters and place overflow paths in `__other__`;
- never use an LLM to infer module membership.

Cluster metadata contains only repository-relative paths and stable symbol keys.

## Dependency aggregation

SourceNerve aggregates only resolved graph edges that already exist in repository intelligence. Architecture intelligence never fabricates a dependency.

The current weighted edge classes are:

| Graph edge | Weight |
|---|---:|
| `CALLS` | 150 |
| `REFERENCES` | 125 |
| `IMPLEMENTS` | 120 |
| `EXTENDS` | 120 |
| `TYPE_DEFINITION` | 120 |
| `IMPORTS` | 90 |

Edges inside one cluster contribute to internal centrality. Cross-cluster edges are persisted as bounded architecture dependencies and contribute to both clusters' centrality.

Representative files are ranked by deterministic file degree, symbol count, then relative path. Representative symbols are ranked by deterministic graph degree, then stable symbol key.

## Map and cluster queries

`POST /api/v1/architecture/map`

```json
{
  "workspace": "repo",
  "limit": 64
}
```

The response contains the current snapshot plus bounded clusters ordered by centrality and key. Each cluster includes counts, representative files/symbols, and bounded incoming/outgoing dependency summaries.

`POST /api/v1/architecture/cluster`

```json
{
  "workspace": "repo",
  "cluster_key": "src/platform"
}
```

Cluster keys are bounded and reject control characters. Architecture query responses never contain source bodies, credentials, or absolute host paths.

If the repository is reindexed at a different HEAD or graph version, the previous architecture snapshot becomes ineligible automatically. Queries return no current snapshot until a new rebuild succeeds.

## Context-pack integration

The existing context-pack request accepts optional architecture seeds:

```json
{
  "workspace": "repo",
  "query": "request authentication",
  "seed_symbol_keys": [],
  "seed_cluster_keys": ["src/platform"],
  "max_bytes": 65536,
  "max_items": 20,
  "require_clean": true
}
```

Without `seed_cluster_keys`, SourceNerve delegates to the pre-v12 semantic/context path unchanged.

With valid current architecture state, SourceNerve adds representatives from the requested clusters and a bounded one-hop set of clusters connected by persisted architecture dependencies. Existing context items can receive an additive `architecture-cluster` ranking reason; otherwise a bounded current indexed source range can be added within the remaining byte/item budget.

Architecture seeding does not override clean-tree checks, HEAD/graph consistency, file hashes, semantic ranking, or context byte/item limits.

At most 12 cluster seeds are accepted from a request and expansion is bounded to 24 clusters.

## MCP

The MCP server advertises:

- `architecture_rebuild`
- `architecture_map`
- `architecture_cluster`
- `context_pack` with optional `seed_cluster_keys`

REST and MCP share the same validation and persistence rules.

## Persistence

Schema v12 stores:

- `architecture_snapshots` — workspace, exact HEAD, graph version, snapshot hash and active/superseded state;
- `architecture_clusters` — deterministic cluster counts, scores and bounded representatives;
- `architecture_cluster_members` — repository-relative file membership and degree metadata;
- `architecture_cluster_edges` — aggregated resolved cross-cluster dependencies.

Architecture snapshots survive process restart and SQLite/AppState reconstruction.

## Scope boundary

Schema v12 intentionally does not add:

- LLM-generated architecture prose;
- remote model or embedding-provider calls;
- inferred dependencies that are absent from the graph;
- vector database or ANN infrastructure;
- autonomous planning, mutation, commit, or merge behavior;
- distributed multi-writer coordination.
