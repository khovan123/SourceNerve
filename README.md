# SourceNerve

**Persistent repository intelligence and controlled mutation for AI coding agents.**

SourceNerve is a self-hosted Rust server that exposes whitelisted Git workspaces to MCP-capable assistants. It keeps repository intelligence in SQLite and treats Git as the source of truth. AI clients can index/search memory, inspect live source, read files, preview unified patches, and apply reviewed partial changes without receiving arbitrary shell access.

## Current production baseline

- Rust 2024 / Tokio / Axum.
- MCP Streamable HTTP using the official `rmcp` Rust SDK.
- Bearer-token protected `/mcp` and `/api/v1` surfaces.
- Explicit workspace registry; absolute paths are never accepted from clients.
- Full workspace bootstrap from tracked + non-ignored untracked files.
- Persistent SQLite/FTS5 file memory plus live `ripgrep` fallback.
- UTF-8 file reads with line ranges and SHA-256 hashes of the complete file.
- Git HEAD/status/diff inspection.
- Patch preview with `git apply --check`.
- Optimistic concurrency using both `expected_head` and per-file SHA-256 expectations.
- Create/modify/delete/rename path tracking for incremental memory refresh.
- Serialized patch mutation; no generic shell-execution endpoint.
- SQLite WAL state with file memory, FTS5, symbol/edge graph schema, memories, and changesets.
- Incremental memory refresh only for paths touched by an applied patch.

The next graph milestone is Tree-sitter symbol extraction, dependency/call/reference edges, reverse-impact invalidation, and optional SCIP enrichment. The graph schema is present now, but this PR does not claim that symbol/edge extraction is implemented yet.

## Run locally

Requirements: Rust 1.88+, Git, and ripgrep.

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

- `workspace_list`
- `workspace_index`
- `memory_search`
- `repo_snapshot`
- `search_code`
- `read_file`
- `git_diff`
- `patch_preview`
- `patch_apply`

Recommended analysis flow:

```text
workspace_index -> memory_search -> search_code (when live fallback is needed) -> read_file
```

Recommended mutation flow:

```text
repo_snapshot -> memory_search/search_code -> read_file -> patch_preview -> human review -> patch_apply -> git_diff
```

### Patch concurrency contract

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

`workspace_index` discovers files with Git (`tracked + non-ignored untracked`), stores eligible text files and hashes in SQLite, and populates FTS5. Binary, oversized, removed, or stale files are purged from file memory. `patch_apply` refreshes only impacted paths instead of rebuilding the whole repository memory.

Git remains the source of truth. SQLite is a rebuildable repository-intelligence state, not the authoritative source tree.

## Security model

SourceNerve intentionally does **not** expose arbitrary shell execution or raw absolute-path file access. Register only repositories an AI client is allowed to inspect. The file reader and indexer canonicalize paths and reject paths/symlinks resolving outside the configured workspace. Run the service as an unprivileged OS user and place TLS/reverse-proxy authentication in front of it when exposed outside a trusted network.

## Status

`0.1.x` is the production foundation: secure workspace IO, persistent file memory, live retrieval, mutation transactions, incremental memory updates, and MCP transport. Tree-sitter code-graph extraction is the next implementation layer.
