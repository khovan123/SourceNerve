# Production operations

This document describes the production contract for SourceNerve as a guarded Harness shell. Repository indexing, structural/semantic analysis, architecture mapping, and SCIP/LSP enrichment are delegated to installed plugin skills or MCP extensions.

## Health versus readiness

`GET /healthz` is intentionally cheap and unauthenticated. It answers only whether the SourceNerve process is alive.

Authenticated readiness checks the dependencies required by the Harness shell:

- SQLite is available;
- required local executables such as `git` and `rg` are available;
- configured workspaces expose readable Git HEAD/status and the configured remote;
- runtime coordination is available;
- provider CLIs are available when the corresponding provider workflow is configured.

The report is sanitized: workspace IDs and coarse state may be returned, but absolute roots, remote URLs, credentials, environment values, and raw command arguments are not.

## Mutation audit

SourceNerve records bounded audit metadata for guarded mutation paths, including task, patch, Git, provider, and selected Harness operations. Audit records may contain workspace ID, operation, bounded target metadata, outcome, resulting SHA, and timestamp. They never persist secrets, patch bodies, complete diffs, provider issue/PR bodies, or process environment.

Use the authenticated audit API or `mutation_audit` with an authorized workspace and bounded limit.

## Harness and repository context

The built-in core provides exact-source primitives such as workspace listing, Git/worktree snapshots, bounded file reads, diff/review, and guarded execution. Higher-level repository intelligence is not maintained by SourceNerve itself.

When a request needs symbol, semantic, architecture, code-search, or impact analysis, the Harness context router delegates discovery to:

- workspace-visible plugin skills; and/or
- enabled MCP extensions.

Exact file/Git evidence should still be verified through SourceNerve primitives before guarded mutation.

## Durable task contract

`task_begin` snapshots the exact Git HEAD and current working-tree state. It may persist a bounded query/context intent, but it does not build or persist a repository context pack.

A task remains current only while its snapshotted Git HEAD and working-tree state remain unchanged. Pre-existing dirty state is permitted. Later drift marks the task stale and prevents pending guarded mutation.

The durable flow is:

```text
task_begin
  -> task_propose_patch
  -> task_apply_patch
  -> task_git_review
  -> task_git_commit
  -> task_git_push
  -> provider issue / pull request operations as explicitly requested
```

SourceNerve rechecks task state, file SHA expectations, reviewed diff state, and provider concurrency tokens at the relevant mutation boundaries.

## Distributed mutation coordination

SQLite-backed renewable fenced leases protect durable source mutation across cooperating SourceNerve processes sharing the same supported state/storage domain. Git HEAD, worktree state, per-file SHA expectations, reviewed-diff hashes, and provider expected-head checks remain authoritative in addition to the lease.

A live competing lease fails closed. Expired leases may be taken over with an incremented fencing token. Internal lease IDs and owner instance IDs are not exposed through normal client surfaces.

## Credential boundary

Provider/Git credentials remain outside client-controlled repository payloads. Desktop normally obtains provider access from authenticated `gh` / `glab` sessions and passes credentials transiently to the daemon. Git operations are non-interactive and fail rather than prompting when credentials are unavailable.

Renderer code, plugin skill text, MCP extension arguments, audit records, and support bundles must not receive provider secrets.

## Production CI smoke

Production smoke validates the real container without repository indexing:

1. build the production image with the tested commit identity;
2. create a temporary Git repository and state directory;
3. boot SourceNerve as an unprivileged user;
4. verify health, authenticated status, and readiness;
5. verify exact workspace snapshot and bounded raw file read;
6. begin/get a durable task without any index prerequisite;
7. create and validate a SQLite state backup;
8. complete a real MCP Streamable HTTP initialize/tools-list exchange;
9. assert core Harness/task/file/Git lifecycle tools are present;
10. assert removed built-in intelligence tools/capabilities are absent.

Dedicated callback, webhook, coordination, and observability smoke workflows exercise their respective Harness-shell responsibilities without creating repository intelligence state.

## Observability

Low-cardinality metrics/traces classify operations around stable shell responsibilities such as readiness, workspace reads, patches, task lifecycle, callbacks, jobs, and MCP. Query text, workspace IDs where disabled by policy, file paths, credentials, extension payloads, and arbitrary error bodies must not become metric labels or OTLP attributes.

## Recovery

Git repositories remain the source of truth for source code. SQLite contains operational state such as tasks, Harness runs, audit/idempotency data, plugin/MCP registry state, jobs, callbacks, and backups. Restore a validated backup when that operational history matters.

There is no post-restore repository re-index step. After restart, verify health/readiness and let plugin/MCP intelligence providers manage their own state independently.
