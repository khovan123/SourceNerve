# Semantic vector enrichment

SourceNerve schema v11 adds an optional semantic retrieval layer on top of the deterministic repository memory, Tree-sitter graph, SCIP enrichment, and graph-ranked context pack.

The semantic layer is additive. Git, indexed file hashes, graph version, and deterministic structural facts remain authoritative.

## External embedding boundary

This milestone does not call an embedding provider from SourceNerve. A trusted client generates vectors outside the server and imports them through the authenticated API or MCP tool.

SourceNerve does not persist embedding-provider API credentials, prompts, or arbitrary provider request metadata.

## Import

`POST /api/v1/semantic/import`

```json
{
  "workspace": "repo",
  "client_run_id": "embed:2026-08-18:v1",
  "provider": "example-provider",
  "model": "example-model",
  "dimension": 3,
  "chunks": [
    {
      "path": "src/lib.rs",
      "start_line": 1,
      "end_line": 20,
      "file_sha256": "<64-hex-current-indexed-file-sha>",
      "vector": [0.8, 0.1, -0.2]
    }
  ]
}
```

Import requires:

- a configured workspace;
- a clean working tree;
- repository Git HEAD equal to the current indexed HEAD;
- a bounded dimension and bounded chunk count;
- finite, non-zero vectors whose length equals `dimension`;
- workspace-contained relative paths;
- valid indexed line ranges;
- exact current indexed file SHA-256 for every chunk.

Chunks are normalized into deterministic path/range order before the request fingerprint is calculated. Reusing the same `client_run_id` with the identical import is replay-safe. Reusing it with changed provider/model/dimension/HEAD/graph/chunk/vector data fails closed.

Activating a new run supersedes the previous active semantic run for the workspace transactionally. A rejected import does not damage the previous valid run.

## Persistence and provenance

`semantic_runs` stores:

- workspace;
- caller-supplied stable run key;
- provider and model names;
- vector dimension;
- exact Git HEAD;
- exact graph version;
- deterministic request fingerprint;
- active/superseded state.

`semantic_chunks` stores:

- run and workspace IDs;
- relative path and line range;
- indexed file SHA-256;
- encoded finite `f32` vector;
- vector norm.

No absolute host path is stored in semantic metadata or returned by semantic APIs.

## Search

`POST /api/v1/semantic/search`

```json
{
  "workspace": "repo",
  "query_vector": [0.9, 0.0, -0.1],
  "limit": 20
}
```

Search uses exact cosine similarity in-process. Results use deterministic tie-breaking by relative path and line range.

A semantic run is eligible only when its Git HEAD and graph version still equal the workspace's current indexed state. Chunk rows are additionally joined against the current indexed file SHA. Stale semantic state therefore cannot silently rank changed source.

Search returns relative path, line range, score, file SHA, run ID, provider, and model. It does not return source bodies; use the existing read/context surfaces when source is required.

If no current semantic run exists, search returns an empty result rather than weakening deterministic repository state.

## Context-pack integration

The existing context-pack request accepts an optional `query_vector`:

```json
{
  "workspace": "repo",
  "query": "pricing calculation",
  "seed_symbol_keys": [],
  "max_bytes": 65536,
  "max_items": 20,
  "require_clean": true,
  "query_vector": [0.9, 0.0, -0.1]
}
```

Without `query_vector`, SourceNerve calls the pre-v11 deterministic context-pack path unchanged.

With a vector and a current semantic run, SourceNerve keeps FTS/symbol/graph ranking as the baseline and adds semantic hits as an additional bounded signal. Overlapping existing items receive a `semantic-vector` score reason; otherwise a current indexed source range can be added within the remaining byte/item budget.

Semantic ranking does not override byte limits, item limits, clean-tree checks, HEAD consistency, or file-hash checks.

## MCP

The MCP server advertises:

- `semantic_import`
- `semantic_search`
- `context_pack` with optional `query_vector`

The same validation and persistence rules apply to REST and MCP.

## Scope boundary

Schema v11 intentionally does not add:

- built-in OpenAI or other remote embedding-provider calls;
- provider credentials in SQLite;
- ANN/HNSW or a vector database dependency;
- arbitrary model or shell execution supplied by a client;
- autonomous repository mutation or merge behavior;
- distributed multi-writer coordination.
