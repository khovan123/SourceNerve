# Production operations

This document describes the operational contract around the guarded Git/GitHub lifecycle.

## Health versus readiness

`GET /healthz` is intentionally cheap and unauthenticated. It answers only whether the SourceNerve process is alive.

`GET /api/v1/readiness` is authenticated and checks the dependencies required to do useful work:

- SQLite can answer a query.
- `git` is installed.
- `rg` is installed.
- `gh` is installed when `SOURCENERVE_GITHUB_TOKEN` enables GitHub lifecycle operations.
- every configured workspace has a readable Git HEAD and status.
- every configured workspace has its configured Git remote.

The readiness payload is deliberately sanitized. It may report workspace ID, HEAD, clean/dirty state, dependency state, and a coarse failure reason. It does not return absolute workspace roots, remote URLs, bearer tokens, GitHub tokens, or process environment.

MCP clients can retrieve the same report through the `readiness` tool.

## Mutation audit

SourceNerve persists sanitized audit events for the mutation boundary:

- `git_branch_checkout`
- `git_default_sync`
- `git_commit`
- `git_push`
- `github_issue_create`
- `github_pull_create`
- `github_pull_merge`

Each event records:

- workspace ID;
- operation;
- optional request/idempotency identifier;
- a small sanitized target object such as branch, PR number, or resulting remote SHA;
- outcome: `success`, `rejected`, or `failed`;
- resulting Git/PR SHA when applicable;
- timestamp.

Audit records never persist API bearer tokens, GitHub tokens, complete diffs, patch bodies, GitHub issue/PR bodies, or process environment.

Use authenticated `POST /api/v1/audit` or MCP `mutation_audit` with a workspace and bounded limit. Retrieval is always workspace-scoped and clamps the requested limit to 200 events.

Example request:

```json
{
  "workspace": "example",
  "limit": 50
}
```

## Request IDs for local Git mutations

The following requests accept an optional `request_id`:

- branch checkout;
- reviewed commit;
- feature branch push;
- default branch sync.

A request ID is intended for correlation in the audit trail. It is not an idempotency mechanism for local Git commands. Existing exact-HEAD, clean-tree, review-diff SHA, branch, and fast-forward guards remain authoritative.

Request/idempotency identifiers must be 1–128 ASCII bytes and may contain letters, digits, `-`, `_`, `.`, and `:`.

## Idempotent GitHub mutations

GitHub operations that can cause externally duplicated state accept an optional `idempotency_key`:

- `github_issue_create`;
- `github_pull_create`;
- `github_pull_merge`.

For a keyed request SourceNerve computes a SHA-256 fingerprint of the request that determines the provider side effect. On the first successful provider call it persists the response together with the fingerprint.

A later request using the same workspace, operation, and key behaves as follows:

- same fingerprint: return the previously persisted successful response without another provider mutation;
- different fingerprint: reject the request before provider access.

GitHub issue/PR body text participates in the request fingerprint so a changed body conflicts with the previous key, but the body itself is not written into the mutation audit record.

The existing global mutation lock serializes these provider mutations inside one SourceNerve process. This is intentionally not presented as distributed multi-instance locking.

## Credential boundary

Two independent credentials can be involved:

1. Git push/fetch authentication belongs to the OS user running SourceNerve, typically an SSH key or another non-interactive Git credential.
2. GitHub API operations use `SOURCENERVE_GITHUB_TOKEN`, passed only to fixed `gh api` subprocesses through `GH_TOKEN`.

SourceNerve does not return either credential through HTTP or MCP. Git commands use non-interactive behavior and fail instead of prompting when credentials are unavailable.

## SCIP enrichment operational contract

SCIP is an additive type-accurate enrichment layer. It never replaces SourceNerve's deterministic Tree-sitter graph, and Git plus the deterministic index remain the rebuildable baseline.

An import through authenticated `POST /api/v1/graph/scip/import` or MCP `scip_import` must provide:

- a configured workspace ID;
- the exact expected Git HEAD;
- the exact deterministic `graph_version`;
- an official SCIP protobuf `Index`, base64 encoded for transport.

The decoded index is limited to 32 MiB. SourceNerve accepts repository-relative document paths only; absolute paths and parent traversal are rejected. The server does not accept an analyzer command or arbitrary host filesystem path from an HTTP/MCP client.

Activation is fail-closed:

- the working tree must be clean;
- the deterministic graph must be indexed at the current HEAD;
- ambiguous local symbol mappings remain unresolved rather than falling back to global same-name guesses;
- failed decoding, parsing, path validation, or staging preserves the previously active successful run;
- the active run records provider/tool metadata, the imported index SHA-256, Git HEAD, graph version, mapping counts, edge counts, and unresolved counts;
- materialized edges carry `source = scip:<run-id>` so graph responses expose their provenance separately from deterministic edges.

Before current graph edge queries are returned, SourceNerve verifies the active SCIP run against Git HEAD, working-tree cleanliness, and deterministic graph version. A mismatch marks the run stale and removes only its materialized SCIP edges. Incremental graph refresh and full workspace reindex perform the same invalidation explicitly.

Use authenticated `POST /api/v1/graph/scip/status` or MCP `scip_status` to inspect whether a current run is active. `graph_status` also reports the current SCIP status alongside deterministic parse coverage.

SCIP currently enriches safe mapped reference/type relationship facts (`REFERENCES`, `IMPLEMENTS`, and `TYPE_DEFINITION`). Deterministic `CALLS` resolution remains authoritative; SourceNerve does not fabricate call edges from SCIP relationships that do not explicitly encode call semantics.

## Graph-ranked context packs

SourceNerve can build a prompt-oriented repository context pack through authenticated `POST /api/v1/context/pack` or MCP `context_pack`. This is a deterministic retrieval layer; it does not call an LLM and does not require an embedding/vector service.

Ranking combines bounded signals from the current repository intelligence state:

- SQLite FTS relevance;
- exact and partial symbol/qualified-name matches;
- explicit seed symbols supplied by the caller;
- one-hop resolved graph neighbors;
- bounded graph-degree contribution;
- graph edge type and provenance, including `scip:<run-id>` when current SCIP enrichment participates.

Each selected item contains only a repository-relative path, merged source line range, UTF-8 content, related symbol keys, deterministic score/reasons, graph edge sources, and the SHA-256 of the complete indexed file. The full-file hash intentionally matches the patch concurrency model used by `read_file` and reviewed mutation operations.

Context consistency is fail-closed by default:

- `require_clean` defaults to `true` and rejects a dirty working tree;
- current Git HEAD must equal the workspace `indexed_head`;
- stale SCIP enrichment is invalidated before graph ranking;
- no absolute host path is returned;
- overlapping or adjacent source ranges are merged before packing;
- `max_bytes` is clamped to 256 bytes–512 KiB and applies to returned source content bytes;
- `max_items` is clamped to 1–100 items;
- stable score/path ordering is used for the same query and repository state.

A caller may explicitly set `require_clean=false`. In that case SourceNerve still requires `indexed_head == current HEAD`, uses the indexed repository snapshot rather than unindexed working-tree edits, reports `clean=false`, and returns `consistency="explicit-indexed-snapshot"`. Because a dirty tree invalidates current SCIP enrichment, stale type facts cannot silently affect that ranking.

The context engine is intentionally not a semantic-confidence layer. Score components are returned as explicit ranking reasons so clients can inspect why a file/range was selected.

## Production CI smoke

CI keeps repository permissions read-only and runs independent Rust and production-container gates.

The Rust gate runs:

```text
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

The production container gate:

1. builds the production Dockerfile with the tested commit as build identity;
2. creates a temporary Git repository and bare remote;
3. mounts the repository, configuration, and writable state directory into the production image;
4. boots SourceNerve as its unprivileged container user;
5. checks `/healthz` and authenticated service identity/readiness;
6. builds deterministic repository intelligence for the smoke workspace;
7. retrieves a real authenticated graph-ranked context pack and checks indexed HEAD, source hash, budget, and relative path behavior;
8. creates and validates an online SQLite backup;
9. checks authenticated SCIP status for the smoke workspace;
10. performs a real MCP Streamable HTTP initialize/initialized/tools-list exchange;
11. asserts the MCP surface advertises lifecycle, recovery, SCIP, and `context_pack` tools.

The local Rust E2E fixtures additionally verify reviewed untracked-file hashing, stale-diff rejection, stale-HEAD rejection, commit, push to a bare remote, fast-forward default sync, reindex, audit success/rejection records, readiness, provider-free idempotency replay/conflict behavior, official SCIP protobuf ingestion, provenance edge materialization, failed-import preservation, traversal rejection, deterministic refresh invalidation, external-HEAD invalidation, context target ranking, graph-neighbor expansion, full-file SHA propagation, strict context byte budgets, clean-tree rejection, explicit indexed-snapshot mode, and stable context ordering.

## Multi-instance boundary

The audit/idempotency schema is persistent, but mutation serialization is currently process-local. Do not run multiple SourceNerve writers against the same workspace and SQLite state directory as if they formed a distributed lock domain.

A future multi-instance deployment must add explicit distributed coordination before concurrent writers are supported.
