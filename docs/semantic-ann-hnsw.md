# Semantic ANN / HNSW acceleration

SourceNerve can accelerate large semantic runs with a local HNSW candidate index while keeping SQLite semantic runs/chunks authoritative.

## Search contract

`POST /api/v1/semantic/search` keeps its existing request and response shape. For the current clean indexed repository state:

- fewer than the configured threshold of eligible chunks: existing exact cosine scan;
- threshold or more eligible chunks: build an HNSW index over L2-normalized vectors, retrieve a bounded candidate set, then recompute exact cosine scores from the authoritative SQLite vectors;
- if ANN returns fewer candidates than required, SourceNerve falls back to the exact scan.

The final ordering is exact cosine descending, then repository-relative path, start line and end line. HNSW distances are never returned as semantic scores.

## Configuration

`SOURCENERVE_SEMANTIC_ANN_THRESHOLD` controls when ANN is used.

- default: `128`
- minimum: `32`
- maximum: `1024`

The current semantic import limit is 1024 chunks, so the ANN index is bounded by the same durable semantic contract.

## Index provenance

Schema v14 adds `semantic_ann_snapshots`. It stores only derived metadata:

- workspace and semantic run ID;
- exact Git HEAD and graph version;
- provider/model/dimension;
- eligible chunk count;
- deterministic input hash;
- algorithm name and build timestamp.

No duplicate vectors are stored in ANN metadata. `semantic_runs`, `semantic_chunks`, current indexed file hashes and Git remain authoritative.

`POST /api/v1/semantic/ann/status` reports `none`, `exact`, `hnsw-rebuild-required` or `hnsw` plus bounded provenance. A stale/superseded semantic run cannot make an old ANN snapshot current because active-run, indexed-HEAD, graph-version and current file hashes are revalidated before status/search.

## Restart behavior

The HNSW graph itself is intentionally rebuildable rather than authoritative. After restart, SourceNerve reconstructs it from current eligible SQLite vectors when a large semantic search occurs and refreshes the snapshot metadata. This avoids a second vector source of truth and lets corrupted/missing ANN cache state degrade to rebuild rather than corrupt semantic retrieval.

## Safety boundary

- no external vector database;
- no provider credential in ANN state;
- no absolute host paths in ANN status;
- no stale file SHA can enter the candidate index;
- exact semantic search remains the fallback for small runs and insufficient ANN candidates.
