# SourceNerve

**Persistent repository intelligence and controlled mutation for AI coding agents.**

SourceNerve is a self-hosted Rust server that exposes whitelisted Git workspaces to MCP-capable assistants. It keeps repository intelligence in SQLite and treats Git as the source of truth. AI clients can index/search memory, traverse a structural code graph, inspect live source, read files, preview unified patches, and apply reviewed partial changes without receiving arbitrary shell access.

## Current production baseline

- Rust 2024 / Tokio / Axum.
- MCP Streamable HTTP using the official `rmcp` Rust SDK.
- Bearer-token protected `/mcp` and `/api/v1` surfaces.
- Explicit workspace registry; absolute paths are never accepted from clients.
- Full workspace bootstrap from tracked + non-ignored untracked files.
- Persistent SQLite/FTS5 file memory plus live `ripgrep` fallback.
- Tree-sitter structural graph for Rust, Python, JavaScript, TypeScript, and TSX.
- Grammar-provided tag queries for definitions and syntactic references.
- Persistent symbols, unresolved references, graph parse state, and resolved edges.
- UTF-8 file reads with line ranges and SHA-256 hashes of the complete file.
- Git HEAD/status/diff inspection.
- Patch preview with `git apply --check`.
- Optimistic concurrency using both `expected_head` and per-file SHA-256 expectations.
- Create/modify/delete/rename path tracking for incremental memory and graph refresh.
- Serialized patch mutation; no generic shell-execution endpoint.

## Run locally

Requirements: Rust 1.88+, Git, ripgrep, and a C compiler toolchain for Tree-sitter grammar crates.

```bash
cp sourcenerve.example.toml sourcenerve.toml
# edit workspace root and set a strong token
export SOURCENERVE_BEARER_TOKEN="$(openssl rand -hex 32)"
cargo run --release
```

Health check:

```bash
curl http://127.0.0.1:7331/healthz
```

MCP endpoint:

```text
http://127.0.0.1:7331/mcp
```

Send `Authorization: Bearer <token>` for MCP and `/api/v1/*` requests.

## MCP tools

Repository and memory:

- `workspace_list`
- `workspace_index`
- `memory_search`
- `repo_snapshot`
- `search_code`
- `read_file`
- `git_diff`

Graph:

- `graph_status`
- `symbol_search`
- `symbol_context`
- `trace_callers`
- `trace_callees`
- `references`
- `impact_analysis`

Mutation:

- `patch_preview`
- `patch_apply`

Recommended analysis flow:

```text
workspace_index
  -> graph_status
  -> symbol_search
  -> symbol_context / trace_callers / trace_callees / impact_analysis
  -> memory_search / search_code when raw text is needed
  -> read_file
```

Recommended mutation flow:

```text
repo_snapshot
  -> symbol_search / memory_search / search_code
  -> read_file
  -> patch_preview
  -> human review
  -> patch_apply
  -> incremental file memory + graph refresh
  -> git_diff
```

## Structural graph model

Each supported file receives a synthetic `file` symbol. Tree-sitter grammar `TAGS_QUERY` captures are persisted as definition symbols and reference records. Nested definitions receive `CONTAINS` edges from the nearest containing definition, or from the file symbol for top-level definitions.

Reference resolution is deliberately conservative. SourceNerve first attempts one unambiguous same-file target by symbol name, then one unambiguous workspace-wide target. Only then does it create a resolved edge. Ambiguous names remain in `symbol_references` with no fabricated target.

Current resolved edge types are:

- `CONTAINS`
- `CALLS`
- `IMPLEMENTS`
- `REFERENCES`

`graph_status` reports parse coverage, partial/error files, graph version, symbol/edge counts, and unresolved reference count so clients can decide when to fall back to raw search.

### Incremental graph updates

A patch does not rebuild the repository graph:

```text
patch_apply
  -> update changed file-memory rows
  -> Tree-sitter parse changed paths only
  -> replace graph state only for successfully parsed files
  -> preserve previous graph for parser failures
  -> re-resolve persisted references
  -> graph_version++
```

Deleted files cascade their file symbols and outgoing graph state. Rename patches track both old and new paths, so the old graph is removed and the new file is parsed.

## Patch concurrency contract

Every patched path must have exactly one `expected_files` entry:

```json
{
  "workspace": "lcsp",
  "expected_head": "<git-head>",
  "expected_files": [
    { "path": "src/service.rs", "sha256": "<hash returned by read_file>" },
    { "path": "src/new.rs", "sha256": null }
  ],
  "patch": "diff --git ..."
}
```

Use `sha256: null` only when that path is expected not to exist before the patch. SourceNerve validates HEAD, every file expectation, workspace boundaries, and `git apply --check` again inside the mutation lock before touching source.

## Memory model

`workspace_index` discovers files with Git (`tracked + non-ignored untracked`), stores eligible text files and hashes in SQLite, populates FTS5, and builds the structural graph for supported languages. Binary, oversized, removed, or stale files are purged from file memory. `patch_apply` refreshes only impacted paths instead of rebuilding the whole repository memory.

Git remains the source of truth. SQLite is rebuildable repository-intelligence state, not the authoritative source tree.

## Security model

SourceNerve intentionally does **not** expose arbitrary shell execution or raw absolute-path file access. Register only repositories an AI client is allowed to inspect. The file reader and indexer canonicalize paths and reject paths/symlinks resolving outside the configured workspace. Run the service as an unprivileged OS user and place TLS/reverse-proxy authentication in front of it when exposed outside a trusted network.

## Status

`0.1.x` now includes secure workspace IO, persistent file memory, Tree-sitter structural repository graph, graph traversal, mutation transactions, incremental memory/graph updates, and MCP transport.

The next enrichment layers are type-accurate cross-file resolution through SCIP/LSP, semantic/vector retrieval, and graph-aware context ranking. Those are intentionally separate from the structural graph core.
