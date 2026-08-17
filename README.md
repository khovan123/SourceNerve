# SourceNerve

**Persistent repository intelligence and controlled mutation for AI coding agents.**

SourceNerve is a self-hosted Rust server that exposes whitelisted Git workspaces to MCP-capable assistants. It keeps repository intelligence in SQLite and treats Git as the source of truth. AI clients can search and read source, inspect repository state, preview unified patches, and apply reviewed patches without receiving arbitrary shell access.

## Current production baseline

- Rust 2024 / Tokio / Axum.
- MCP Streamable HTTP using the official `rmcp` Rust SDK.
- Bearer-token protected `/mcp` and `/api/v1` surfaces.
- Explicit workspace registry; absolute paths are never accepted from clients.
- `ripgrep` code search with bounded results.
- UTF-8 file reads with line ranges and SHA-256 content hashes.
- Git HEAD/status/diff inspection.
- Patch preview with `git apply --check` and `expected_head` optimistic concurrency control.
- Serialized patch mutation; no generic shell-execution endpoint.
- SQLite WAL state with file memory, FTS5, symbol/edge graph schema, memories, and changesets.
- Incremental file-memory refresh only for paths touched by an applied patch.

The next graph milestone is Tree-sitter symbol extraction, dependency/call edges, reverse-impact invalidation, and optional SCIP enrichment. The schema is intentionally present now so those changes do not require redesigning the mutation pipeline.

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
- `repo_snapshot`
- `search_code`
- `read_file`
- `git_diff`
- `patch_preview`
- `patch_apply`

A recommended mutation flow is:

```text
repo_snapshot -> search_code -> read_file -> patch_preview -> human review -> patch_apply -> git_diff
```

`patch_apply` requires the same `expected_head` that the assistant observed before generating the patch. SourceNerve validates the patch again inside a mutation lock before applying it and updates SQLite only for changed paths.

## Security model

SourceNerve intentionally does **not** expose arbitrary shell execution or raw absolute-path file access. Register only repositories an AI client is allowed to inspect. Run the service as an unprivileged OS user and place TLS/reverse-proxy authentication in front of it when exposed outside a trusted network.

## Status

`0.1.x` is the production foundation: secure workspace IO, mutation transactions, persistent storage, and MCP transport. Code-graph extraction and semantic retrieval are the next implementation layer.
