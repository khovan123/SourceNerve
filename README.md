# SourceNerve

**A guarded Harness shell for AI coding agents.**

SourceNerve is a self-hosted Rust service and Desktop application that exposes explicitly configured Git workspaces to AI agents through MCP, plugin skills, and guarded local workflows. Git and the working tree are authoritative. SourceNerve owns workspace boundaries, approvals, mutation concurrency, durable tasks, Git/provider lifecycle, audit, recovery, and execution policy.

Repository intelligence is intentionally **not** implemented by the SourceNerve core. Code search, semantic retrieval, symbol graphs, architecture analysis, SCIP/LSP enrichment, and similar capabilities belong to installed plugin skills or MCP extensions. This keeps the core small and makes the Harness responsible for policy and execution rather than duplicating specialized intelligence engines.

## Current production baseline

- Rust 2024 / Tokio / Axum.
- MCP Streamable HTTP using the official `rmcp` Rust SDK.
- Bearer/OAuth-protected MCP and `/api/v1` surfaces.
- Explicit workspace registry; clients never supply arbitrary absolute repository roots.
- Bounded workspace file reads with whole-file SHA-256 concurrency tokens.
- Exact Git HEAD and working-tree snapshots.
- Complete review diff from `HEAD`, including non-ignored untracked files.
- Patch preview with `git apply --check` and per-file optimistic concurrency.
- Durable task lifecycle bound to Git HEAD + working-tree state.
- Reviewed feature-branch, commit, non-force push, issue/PR, and merge workflows.
- Harness runs with workspace-scoped capability snapshots and allow/ask/deny policy.
- Plugin skill and MCP-extension registries for external repository intelligence/tools.
- Fenced SQLite mutation coordination, audit, backups, recovery, jobs, and callbacks.
- Desktop workspace/runtime/plugin/Harness/task/provider management.

Legacy database columns/tables from earlier repository-intelligence releases may remain for upgrade compatibility, but they are inert and are not part of the active runtime contract.

## Run locally

Requirements:

- Rust 1.88+.
- Git.
- `ripgrep` for guarded raw-source search where enabled by the Harness/tooling layer.
- GitHub CLI (`gh`) or GitLab CLI (`glab`) when the corresponding provider workflow is used.

SourceNerve configuration is file-based. For a standalone/local data-plane development run:

```bash
cp sourcenerve.example.toml sourcenerve.toml
nano sourcenerve.toml
nano .env
cargo run --release
```

Example local `.env`:

```dotenv
SOURCENERVE_CONFIG=sourcenerve.toml
SOURCENERVE_BEARER_TOKEN=replace-with-a-strong-random-local-token
```

When `.env` exists, SourceNerve loads it before runtime initialization and rejects shell-style `export KEY=VALUE` entries.

Desktop normally relies on authenticated `gh` / `glab` sessions for repository-provider access. Provider credentials are passed transiently by Electron Main and are never exposed to renderer code, plugins, MCP callers, or repository files.

Health check:

```bash
curl http://127.0.0.1:7331/healthz
```

MCP endpoint:

```text
http://127.0.0.1:7331/mcp
```

## Workspace configuration

```toml
[[workspace]]
id = "example"
name = "Example Repository"
root = "/absolute/path/to/repository"
access = "read-write"
remote = "origin"
default_branch = "main"
```

The configured workspace boundary is authoritative for file access, execution, task mutation, and Git/provider operations.

## Core MCP / Harness surfaces

The built-in surface is deliberately focused on Harness responsibilities. Depending on profile and policy, the core exposes capabilities such as:

- service/readiness/state-backup/audit operations;
- `workspace_list`, `repo_snapshot`, bounded `read_file`, and `git_diff`;
- durable `task_begin`, `task_get`, proposal/apply/cancel operations;
- task branch/review/commit/push/default-sync/provider lifecycle;
- guarded Git and patch workflows;
- Harness runs, approvals, jobs, context routing, and capability discovery;
- plugin skill catalog/read operations;
- enabled MCP-extension catalog/tools.

Exact exposed tools depend on the active Harness profile, workspace policy, installed plugins, and enabled MCP extensions.

### Repository intelligence

SourceNerve core does **not** build or maintain a repository index, FTS memory, structural graph, semantic vectors, architecture clusters, or SCIP state. When a request needs repository intelligence, Harness context routing points the agent toward installed plugin skills and MCP extensions. Raw file/Git primitives remain available for exact-source verification.

## Recommended guarded task flow

```text
repo_snapshot
  -> discover/select plugin or MCP intelligence when needed
  -> read exact source / Git evidence
  -> task_begin                    # snapshots HEAD + working tree
  -> task_propose_patch            # stores reviewed proposal metadata
  -> task_apply_patch              # rechecks task + file expectations
  -> task_git_review               # hashes the exact current diff
  -> task_git_commit
  -> task_git_push
  -> task_provider_pull_create     # optional
  -> CI / human or agent review
  -> task_provider_pull_get
  -> task_provider_pull_merge
  -> task_default_sync
```

A simpler direct patch/Git flow is also available where policy permits, but durable tasks are preferred for restart-safe guarded changes.

## Concurrency contracts

### Task snapshot

A new durable task snapshots:

- workspace ID;
- exact Git `HEAD`;
- working-tree state hash;
- optional context/query intent;
- Harness capability/policy state where applicable.

Pre-existing dirty changes are allowed. Any later worktree drift or Git HEAD change marks the task stale and rejects pending guarded mutation.

### File expectations

Every changed path in a guarded patch carries the SHA-256 returned by the bounded file reader. New files use a null expectation. SourceNerve rechecks file expectations and Git/task state immediately before applying mutation.

### Reviewed commit

`git_review` returns the current branch, HEAD, status, complete reviewable diff, and a SHA-256 of that exact diff. `git_commit` accepts only the reviewed HEAD + diff hash and rejects direct default-branch commits.

### Push and provider lifecycle

Push is non-force and verifies the remote branch SHA. Provider pull-request merge requires an exact current PR head and does not bypass provider branch protection, required checks, reviews, or authorization.

## Plugin and MCP ownership

Plugins and MCP extensions are the extension points for specialized intelligence and integrations. SourceNerve owns the guardrails around them:

- workspace-scoped visibility;
- automatic/manual skill discovery/use policy;
- allow/ask/deny capability policy;
- bounded inputs and secret isolation;
- audit metadata;
- one-shot approvals for guarded operations;
- immutable Harness run capability snapshots.

The core does not duplicate a plugin/MCP feature merely to provide a second implementation of the same analysis.

## Recovery and state

Git repositories remain authoritative for source. SQLite contains operational state such as task lifecycle, Harness runs, approvals, jobs, audit/idempotency data, plugin/MCP registry state, callbacks, and backups. Losing SQLite does not change source code, but operational history may be lost; restore a validated backup when that history matters.

No repository re-index step is required after restore or Git movement. Runtime readiness depends on configured workspace access, database/runtime health, and the relevant Harness/provider/plugin state.

## Security model

SourceNerve is a policy and mutation boundary, not a general remote shell. Workspace execution is bounded, sanitized, workspace-scoped, and governed by Harness policy/approval. File operations reject escapes from configured repositories. Git mutations use exact-state concurrency gates and never expose force push or arbitrary refspecs. Secrets remain outside renderer/plugin/repository payloads.

Run SourceNerve as an unprivileged OS user and place appropriate TLS/reverse-proxy authentication in front of deployments exposed outside a trusted local environment.

## Status

`0.1.x` now treats SourceNerve as a **Harness shell**: workspace security, durable execution, mutation guards, Git/provider workflows, plugins/MCP composition, approvals, audit, recovery, and Desktop operations are core. Repository indexing, semantic search, structural graphs, architecture analysis, and SCIP/LSP enrichment are delegated to plugin/MCP implementations.
