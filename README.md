# SourceNerve

**A guarded Harness shell for AI coding agents and native Codex workflows.**

SourceNerve is a self-hosted Rust service plus a cross-platform Desktop application. It exposes explicitly configured Git workspaces to ChatGPT, Codex, plugin skills, MCP extensions, and local Desktop workflows while keeping Git, workspace boundaries, approvals, audit, recovery, and mutation policy under SourceNerve control.

The core product is intentionally a **Harness shell**, not a duplicated repository-intelligence engine. SourceNerve owns the authority boundary: who can see a workspace, what can be executed, when a mutation is allowed, how Git/provider operations are reviewed, and how native agent execution is verified. Specialized repository intelligence such as semantic search, code graphs, architecture analysis, SCIP/LSP enrichment, and context-pack generation belongs to installed plugin skills or MCP extensions.

Current application/daemon version: **0.1.22**.

## Feature set

### Harness core

- Workspace-scoped Harness runs with immutable capability snapshots.
- Built-in profiles for read-only analysis, interactive local work, guarded durable work, background jobs, and webhook automation.
- Allow/ask/deny capability policy for read, write, exec, Git, provider, job, plugin, and MCP-extension surfaces.
- Context routing that classifies work shape and scope without storing raw user prompts in Harness events.
- Closed-loop supervision for native Codex work: **Context → Execute → Verify → Recover → Learn**.
- Deterministic proof selection from repository manifests, scripts, tests, integration, E2E, recovery, and measurement surfaces.
- Bounded recovery attempts after native execution or proof failure, with fail-closed behavior on unresolved approval, stale run, stale HEAD, or uncertain mutation.
- Durable jobs, callbacks, webhook ingress, and restart-safe Harness execution events.

### Native Codex + ChatGPT lane

- Production Desktop integration with the official `codex app-server --stdio` protocol.
- ChatGPT-authenticated native Codex account/status/usage checks.
- One Harness run bound to one persisted native Codex thread.
- Native conversation listing, resume, clear, and history hydration from Codex as the source of truth.
- SourceNerve-owned workspace/run binding; the renderer cannot choose cwd, sandbox, approval policy, or arbitrary native lifecycle state.
- Mandatory npm Skills preflight before native Codex turns, plus optional plugin-skill activation when the prompt is repository-relevant.
- At most two active native skill projections per run.
- Durable one-shot approval forwarding for supported Codex app-server requests: command execution, file change, and permission escalation.
- Explicit deny/timeout/Harness cancel/Desktop shutdown/HEAD drift/scope drift all fail closed.
- No second model loop: Codex owns reasoning and native tool use; Harness owns lifecycle, policy, proof, recovery, and completion gates.

### Desktop application

- Electron Forge + React/Vite/TypeScript Desktop app with a narrow typed preload bridge.
- Renderer sandboxing, context isolation, no Node.js access, and no renderer access to provider tokens, local bearers, or product secrets.
- Managed runtime bootstrap: Desktop materializes the local daemon profile and starts/stops/restarts/attaches to the daemon without exposing process handles to the renderer.
- Backend-provided Auth0/Public MCP client configuration via `GET /v1/desktop/client-config`; product OAuth values are not embedded in Desktop `.env`.
- Installation-scoped local bearer and Auth0/session/workspace state; no release-wide bearer.
- Workspace management with local root validation, Git status, remote/default-branch metadata, and provider slug derivation.
- Navigation surfaces: Overview, Workspaces, MCP, Plugins, Harness, Pull Requests, Connections, Logs & Diagnostics, and Settings.
- Harness conversation UI with run selection, native Codex resume, permission presets, approval handling, job visibility, and run diagnostics.
- Slash commands for first-class Desktop actions and explicit bang commands (`! ...`) for user-authored bounded shell execution outside the model-supervised native lane.
- Update manifest generation/verification, Desktop release contract checks, package quality checks, and security baseline validation.

### Plugin skills and MCP extensions

- Streamable HTTP MCP server implemented with the official `rmcp` Rust SDK.
- OAuth/Bearer-protected MCP and `/api/v1` surfaces.
- SourceNerve plugin package for ChatGPT/Codex distribution metadata and bundled skills.
- Workspace-scoped plugin skill catalog/read operations.
- MCP-extension catalog with live schemas and explicit read-only/destructive/idempotent/open-world annotations.
- Artifact verification for registry-backed MCP extension packages using npm integrity metadata and optional publisher signature trust roots.
- Secret isolation and policy checks around plugin/MCP execution.
- Core repository-intelligence primitives stay exact-source based; semantic/code-graph intelligence is delegated to plugin/MCP implementations.

### Git and provider lifecycle

- Exact Git HEAD and working-tree snapshots.
- Bounded source reads with whole-file SHA-256 concurrency tokens.
- Patch preview/apply with `git apply --check` and per-file optimistic concurrency.
- Complete review diff from `HEAD`, including non-ignored untracked files.
- Durable task lifecycle bound to Git HEAD, worktree state, context intent, and Harness policy.
- Reviewed branch, commit, non-force push, default-branch sync, issue, pull request, and guarded merge workflows.
- GitHub/GitLab provider authentication owned by `gh`/`glab`; provider tokens are transient Main-process material and never cross into renderer/plugin/repository payloads.
- Provider PR merge requires an exact current provider head and does not bypass branch protection, required checks, reviews, or external authorization.

### Security, recovery, and operations

- Explicit workspace registry; callers never supply arbitrary absolute repository roots.
- File and execution operations reject escapes from configured workspaces.
- Workspace execution is bounded, sanitized, and policy-controlled.
- Fenced SQLite mutation coordination, audit, idempotency, backups, recovery checkpoints, jobs, and callback state.
- Diagnostic/log surfaces are sanitized before renderer exposure.
- Rust daemon readiness reports dependency, database, workspace, coordination, and service identity status.
- Git repositories remain authoritative for source. SQLite stores operational state; losing SQLite does not mutate source, but operational history should be restored from a validated backup when needed.

## Product boundaries

SourceNerve core owns:

- workspace authorization and boundary enforcement;
- Harness runs, capability snapshots, closed-loop state, approvals, proofs, recovery, and learning events;
- exact-source file/Git primitives;
- durable task mutation lifecycle;
- guarded Git/provider operations;
- Desktop runtime/bootstrap/security boundaries;
- plugin/MCP composition policy and audit.

SourceNerve core does **not** own:

- model reasoning;
- a second autonomous agent loop for native Codex;
- built-in semantic search or code-vector memory;
- built-in repository graph/architecture/SCIP/LSP indexing as an active runtime contract;
- model-side automatic skill routing;
- arbitrary remote shell access;
- force push or arbitrary Git refspec mutation.

Legacy database columns/tables and dependencies from earlier repository-intelligence releases may remain for upgrade compatibility, but they are inert unless reintroduced through reviewed plugin/MCP contracts.

## Run the Rust service locally

Requirements:

- Rust 1.88+.
- Git.
- `ripgrep` for guarded raw-source search where enabled by the Harness/tooling layer.
- GitHub CLI (`gh`) or GitLab CLI (`glab`) when a corresponding provider workflow is used.

SourceNerve configuration is file-based:

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

Health check:

```bash
curl http://127.0.0.1:7331/healthz
```

MCP endpoint:

```text
http://127.0.0.1:7331/mcp
```

## Run Desktop locally

```bash
cd desktop
cp -n .env.example .env
npm install
node scripts/materialize-product-profile.mjs
npm run dev
```

Common Desktop validation commands:

```bash
npm run typecheck
npm test
npm run test:integration
npm run security:check
npm run release:contract
npm run package
npm run make
```

Native Codex E2E is opt-in because it requires an installed Codex CLI and an existing ChatGPT-authenticated Codex environment:

```bash
npm run test:codex:e2e
```

Desktop normally relies on external provider CLIs for repository-provider access:

```bash
gh auth login --hostname github.com
gh auth setup-git --hostname github.com
glab auth login --hostname gitlab.com
```

`gh` and `glab` own provider authentication and credential storage. Desktop requests provider material only transiently from Electron Main when the local daemon needs it.

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

The configured workspace boundary is authoritative for file access, execution, task mutation, native Codex cwd, and Git/provider operations.

## Core MCP / Harness surfaces

Exact exposed tools depend on the active Harness profile, workspace policy, installed plugins, and enabled MCP extensions. The built-in surface is focused on guarded authority and includes:

- service readiness, state backup, and audit operations;
- workspace list/snapshot, bounded file reads, and complete Git diff review;
- patch preview/apply and guarded workspace execution;
- durable task begin/get/propose/apply/cancel;
- task branch/review/commit/push/default-sync/provider lifecycle;
- direct guarded Git/provider inspection and mutation where policy permits;
- Harness runs, events, approvals, jobs, context routing, and capability discovery;
- plugin skill catalog/read operations;
- enabled MCP-extension catalog/tool dispatch under SourceNerve policy.

## Recommended guarded change flow

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
  -> task_provider_pull_merge      # only on explicit user request
  -> task_default_sync
```

A simpler direct patch/Git flow is available for small bounded edits where policy permits, but durable tasks are preferred for restart-safe guarded changes.

## Concurrency contracts

### Task snapshot

A durable task snapshots:

- workspace ID;
- exact Git `HEAD`;
- working-tree state hash;
- optional context/query intent;
- Harness capability/policy state where applicable.

Pre-existing dirty changes are allowed. Later worktree drift or Git HEAD movement marks the task stale and rejects pending guarded mutation.

### File expectations

Every changed path in a guarded patch carries the SHA-256 returned by the bounded file reader. New files use a null expectation. SourceNerve rechecks file expectations and Git/task state immediately before mutation.

### Reviewed commit

`git_review` returns the current branch, HEAD, status, complete reviewable diff, and a SHA-256 of that exact diff. `git_commit` accepts only the reviewed HEAD + diff hash and rejects direct default-branch commits.

### Push and provider lifecycle

Push is non-force and verifies the remote branch SHA. Provider pull-request merge requires an exact current PR head and remains subject to provider branch protection, required checks, reviews, and authorization.

## Release and distribution

Desktop artifacts are produced by Electron Forge. The current distribution targets are:

- Linux x64: RPM + AppImage.
- Windows x64: NSIS installer.
- macOS arm64/x64: DMG + ZIP.

Stable Desktop releases are tag-triggered by `.github/workflows/desktop-release.yml` from immutable tags named `desktop-vX.Y.Z`. `desktop/package.json` and the Rust daemon version must match the release tag. Stable publishing runs behind the protected `desktop-release` GitHub environment and publishes draft-first before making the release public.

Current stable publishing scope is Linux x64. macOS and Windows signing scripts are retained for later stable rollout and keep signing material inside protected CI secrets only.

## Security model

SourceNerve is a policy and mutation boundary, not a general remote shell. Workspace execution is bounded, sanitized, workspace-scoped, and governed by Harness policy/approval. File operations reject escapes from configured repositories. Git mutations use exact-state concurrency gates and never expose force push or arbitrary refspecs. Secrets remain outside renderer, plugin, MCP, repository, and diagnostic payloads.

Run SourceNerve as an unprivileged OS user and place appropriate TLS/reverse-proxy authentication in front of deployments exposed outside a trusted local environment.

## Status

`0.1.22` treats SourceNerve as a **Harness shell and Desktop runtime** for AI-assisted repository work: workspace security, native Codex/ChatGPT execution, supervised closed-loop verification, durable mutation guards, Git/provider workflows, plugin/MCP composition, approvals, audit, recovery, jobs, callbacks, and release/security operations are core. Repository indexing and advanced code intelligence are delegated to plugin/MCP implementations under SourceNerve policy.
