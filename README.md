# SourceNerve

<p align="center">
  <strong>A guarded Harness shell for ChatGPT, native Codex, plugin skills, MCP extensions, and Git/provider workflows.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#desktop-application">Desktop</a> ·
  <a href="#harness-flow">Harness flow</a> ·
  <a href="#security-model">Security</a> ·
  <a href="#release-and-distribution">Release</a>
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.23-7c3aed?style=flat-square" />
  <img alt="Desktop" src="https://img.shields.io/badge/desktop-Electron%20%2B%20React-2563eb?style=flat-square" />
  <img alt="Daemon" src="https://img.shields.io/badge/daemon-Rust-f97316?style=flat-square" />
  <img alt="Policy" src="https://img.shields.io/badge/policy-fail--closed-16a34a?style=flat-square" />
</p>


> Current application/daemon version: **0.1.23**

SourceNerve is a self-hosted Rust service plus a cross-platform Electron Desktop app. It exposes explicitly configured Git workspaces to AI-assisted workflows while keeping repository access, command execution, file mutation, approvals, Git/provider operations, audit, recovery, and verification under SourceNerve policy.

The product is intentionally a **Harness shell**, not a duplicated repository-intelligence engine. SourceNerve owns the authority boundary; specialized semantic search, code graphs, architecture analysis, SCIP/LSP enrichment, and context-pack generation belong to installed plugin skills or MCP extensions.

## What you can do

<table>
  <tr>
    <td width="25%"><strong>🛡️ Guard workspaces</strong><br/>Expose only repositories you configure, with path, HEAD, and worktree guards.</td>
    <td width="25%"><strong>🤖 Run AI lanes</strong><br/>Use direct ChatGPT, native Codex, Goal, or Loop mode from one Harness chat surface.</td>
    <td width="25%"><strong>🔐 Gate mutations</strong><br/>Reads, edits, commands, Git/provider actions, approvals, and jobs go through explicit gates.</td>
    <td width="25%"><strong>🧾 Recover with audit</strong><br/>Runs, receipts, activity output, diffs, validation, and recovery checkpoints stay inspectable.</td>
  </tr>
</table>

<div align="center">

| Work safely with AI | Keep authority local | Ship with evidence |
| --- | --- | --- |
| ChatGPT, native Codex, Goal, and Loop lanes in one Harness chat. | Repository access, commands, mutations, Git/provider operations, approvals, and jobs stay behind SourceNerve policy. | Runs preserve activity, diffs, receipts, validations, recovery checkpoints, and audit trails. |

</div>

---

## Why SourceNerve exists

AI coding agents are powerful, but repository work needs a boundary that is smaller and stricter than the model. SourceNerve gives ChatGPT, Codex, plugins, and local workflows a governed control plane:

| Need | SourceNerve boundary |
| --- | --- |
| Workspace safety | Only configured workspaces are visible; repository path escapes are rejected. |
| Mutation control | Writes, commands, Git operations, approvals, jobs, and provider actions pass through Harness policy. |
| Verification | Native execution is checked through deterministic proofs and diff review before completion. |
| Recovery | Failed or stale runs fail closed; bounded recovery is explicit and auditable. |
| Desktop security | Renderer is sandboxed; tokens, process handles, local bearers, and secrets stay out of renderer/plugin payloads. |
| Extensibility | Plugin skills and MCP extensions add intelligence without taking over core authority. |

---

## At a glance

```text
┌─────────────────────────────────────────────────────────────────────┐
│ ChatGPT Web · Native Codex · Desktop UI · Plugin skills · MCP tools │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ guarded requests
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         SourceNerve Harness                         │
│ workspace registry · capability snapshots · allow/ask/deny gates    │
│ file/command/Git/provider/job/approval boundaries                   │
│ proof selection · verification · recovery · audit · diagnostics     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ exact-state operations
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│        Configured Git workspaces · provider CLIs · daemon state      │
└─────────────────────────────────────────────────────────────────────┘
```

### Main surfaces

| Surface | What it does |
| --- | --- |
| **Rust daemon** | Local/self-hosted service, MCP server, REST API, SQLite-backed operational state. |
| **Desktop app** | Electron Forge + React/Vite/TypeScript UI for workspaces, Harness conversations, plugins, MCP, PRs, diagnostics, and updates. |
| **Native Codex lane** | Official `codex app-server --stdio` integration with SourceNerve-owned cwd/sandbox/approval lifecycle. |
| **Direct ChatGPT lane** | ChatGPT Web uses the SourceNerve/Harness connector for the selected workspace and returns verified user-facing answers. |
| **Goal / Loop modes** | ChatGPT plans/reviews bounded iterations while native Codex executes and Harness verifies. |
| **Plugin/MCP layer** | Workspace-scoped skills, extension schemas, artifact verification, OAuth/Bearer-protected MCP/API surfaces. |
| **Git/provider lifecycle** | Exact HEAD/worktree guards, patch preview/apply, reviewed commit/push, issue/PR/merge workflows. |

### Choose a lane

| Lane | Best for | Execution owner | Verification owner |
| --- | --- | --- | --- |
| **Direct ChatGPT** | One-shot repository questions, reviews, and small guarded changes through ChatGPT Web. | ChatGPT via SourceNerve MCP/Harness tools | SourceNerve Harness |
| **Native Codex** | Local code edits where Codex app-server should own the thread. | Native Codex | SourceNerve Harness |
| **Goal** | A bounded target that may need multiple inspected implementation steps. | Native Codex, planned/reviewed by ChatGPT | SourceNerve Harness + ChatGPT review |
| **Loop** | Repeated improvement/check cycles inside one original brief. | Native Codex, iterated by ChatGPT | SourceNerve Harness + ChatGPT review |

---

## Feature matrix

### Harness core

- Workspace-scoped Harness runs with immutable capability snapshots.
- Built-in profiles for read-only analysis, interactive local work, guarded durable work, background jobs, and webhook automation.
- Allow/ask/deny capability policy for read, write, exec, Git, provider, job, plugin, and MCP-extension surfaces.
- Context routing that classifies work shape and scope without storing raw user prompts in Harness events.
- Closed-loop supervision for native Codex work: **Context → Execute → Verify → Recover → Learn**.
- Deterministic proof selection from repository manifests, scripts, tests, integration, E2E, recovery, and measurement surfaces.
- Durable jobs, callbacks, webhook ingress, restart-safe events, audit, idempotency, backups, and recovery checkpoints.
- Fail-closed behavior on unresolved approval, stale run, stale HEAD, scope drift, uncertain mutation, or incomplete proof.

### Native Codex + ChatGPT lane

- Production Desktop integration with the official `codex app-server --stdio` protocol.
- ChatGPT-authenticated native Codex account, status, and usage checks.
- One Harness run bound to one persisted native Codex thread.
- Native conversation listing, resume, clear, and history hydration from Codex as the source of truth.
- Mandatory npm Skills preflight before native Codex turns, plus optional plugin-skill activation when the prompt is repository-relevant.
- One-shot approval forwarding for supported Codex app-server requests: command execution, file change, and permission escalation.
- Direct ChatGPT mode uses ChatGPT Web through the full SourceNerve/Harness connector for the selected workspace, then SourceNerve performs Harness verification before surfacing the answer.
- Optional ChatGPT review connector mode at `/mcp?mode=review` with an explicit read-only MCP allowlist.
- `/agents`, `/model`, `/goal`, and `/loop` slash commands for agent/model selection and bounded workflow modes.
- Bundled `chatgpt-review-loop` skill for reusable reviewer-over-executor sessions.

### Desktop application

- Electron Forge + React/Vite/TypeScript with a narrow typed preload bridge.
- Renderer sandboxing, context isolation, no Node.js access, and no renderer access to provider tokens or product secrets.
- Managed daemon bootstrap and local runtime profile materialization.
- Backend-provided Auth0/Public MCP client config through `GET /v1/desktop/client-config`.
- Workspace management with local root validation, Git status, remote/default-branch metadata, and provider slug derivation.
- Navigation surfaces: Overview, Workspaces, MCP, Plugins, Harness, Pull Requests, Connections, Logs & Diagnostics, and Settings.
- Harness chat UI with run selection, native Codex resume, ChatGPT resume, agent selection, permission presets, approvals, jobs, diagnostics, and streamed activity output.
- Optional Chrome extension bridge for external ChatGPT tabs with durable queued/inserted/clicked/accepted/stable receipts.
- Explicit Desktop control bridge with per-capability gates for screen, clipboard, mouse, and keyboard.
- Multi-agent worker families created from a prime Harness run, each executing through a child Harness run and the verified native Codex lane.

### Plugin skills and MCP extensions

- Streamable HTTP MCP server implemented with the official `rmcp` Rust SDK.
- OAuth/Bearer-protected MCP and `/api/v1` surfaces.
- SourceNerve plugin package for ChatGPT/Codex distribution metadata and bundled skills.
- Workspace-scoped plugin catalog/read operations.
- MCP-extension catalog with live schemas and read-only/destructive/idempotent/open-world annotations.
- Registry-backed artifact verification using npm integrity metadata and optional publisher signature trust roots.
- Review-mode MCP excludes file writes, command/process execution, Git/provider mutations, approval responses, jobs, and conversation-management mutations.

### Git and provider lifecycle

- Exact Git HEAD and working-tree snapshots.
- Bounded source reads with whole-file SHA-256 concurrency tokens.
- Patch preview/apply with `git apply --check` and optimistic per-file expectations.
- Complete review diff from `HEAD`, including non-ignored untracked files.
- Durable task lifecycle bound to Git HEAD, worktree state, context intent, and Harness policy.
- Reviewed branch, commit, non-force push, default-branch sync, issue, pull request, and guarded merge workflows.
- GitHub/GitLab authentication owned by `gh`/`glab`; provider tokens are transient Main-process material and never cross into renderer/plugin/repository payloads.

---

## Quick start

### Requirements

| Requirement | Used by |
| --- | --- |
| Rust **1.88+** | Daemon and release builds |
| Git | Workspace state, diffs, commits, provider lifecycle |
| `ripgrep` | Guarded raw-source search where enabled |
| Node.js/npm | Desktop app, tests, packaging |
| GitHub CLI (`gh`) or GitLab CLI (`glab`) | Provider issue/PR/merge workflows |

### Run the Rust service

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
curl http://127.0.0.1:7331/readyz
```

MCP endpoint:

```text
http://127.0.0.1:7331/mcp
```

### Run Desktop

```bash
cd desktop
cp -n .env.example .env
npm install
node scripts/materialize-product-profile.mjs
npm run dev
```

Common validation commands:

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | TypeScript validation |
| `npm test` | Full Desktop unit/contract suite |
| `npm run test:integration` | Integration suite |
| `npm run security:check` | Desktop security baseline |
| `npm run release:contract` | Release contract checks |
| `npm run package` | Package without installers |
| `npm run make` | Build distributable artifacts |

Native Codex E2E is opt-in because it requires an installed Codex CLI and an existing ChatGPT-authenticated Codex environment:

```bash
npm run test:codex:e2e
```

Provider CLI setup:

```bash
gh auth login --hostname github.com
gh auth setup-git --hostname github.com
glab auth login --hostname gitlab.com
```

---

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

The configured workspace boundary is authoritative for file access, execution, task mutation, native Codex cwd, Git/provider operations, and plugin/MCP policy.

---

## Harness flow

### Recommended guarded change flow

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

### Core MCP / Harness surfaces

Exact exposed tools depend on the active Harness profile, workspace policy, installed plugins, and enabled MCP extensions. The built-in surface focuses on guarded authority:

- service readiness, state backup, and audit operations;
- workspace list/snapshot, bounded file reads, and complete Git diff review;
- patch preview/apply and guarded workspace execution;
- durable task begin/get/propose/apply/cancel;
- task branch/review/commit/push/default-sync/provider lifecycle;
- direct guarded Git/provider inspection and mutation where policy permits;
- Harness runs, events, approvals, jobs, context routing, and capability discovery;
- plugin skill catalog/read operations;
- enabled MCP-extension catalog/tool dispatch under SourceNerve policy.

---

## Concurrency contracts

| Contract | Meaning |
| --- | --- |
| **Task snapshot** | Durable tasks snapshot workspace ID, exact `HEAD`, working-tree state hash, optional intent, and Harness capability/policy state. Later HEAD or worktree drift marks pending mutation stale. |
| **File expectation** | Every changed path carries the SHA-256 returned by bounded file reads. New files use a null expectation. Expectations are rechecked before mutation. |
| **Reviewed commit** | `git_review` returns branch, HEAD, status, reviewable diff, and diff SHA-256. `git_commit` accepts only the reviewed HEAD + diff hash and rejects direct default-branch commits. |
| **Push/provider lifecycle** | Push is non-force and verifies remote branch SHA. PR merge requires exact provider head and remains subject to branch protection, required checks, reviews, and authorization. |

---

## Release and distribution

Desktop artifacts are produced by Electron Forge.

| Platform | Artifacts |
| --- | --- |
| Linux x64 | RPM, AppImage |
| Windows x64 | NSIS installer |
| macOS arm64/x64 | DMG, ZIP |

Stable Desktop releases are tag-triggered by `.github/workflows/desktop-release.yml` from immutable tags named `desktop-vX.Y.Z`. `desktop/package.json` and the Rust daemon version must match the release tag. Stable publishing runs behind the protected `desktop-release` GitHub environment and publishes draft-first before making the release public.

Current stable publishing scope is Linux x64. macOS and Windows signing scripts are retained for later stable rollout and keep signing material inside protected CI secrets only.

Useful workflows include:

- `.github/workflows/ci.yml`
- `.github/workflows/desktop-quality.yml`
- `.github/workflows/desktop-release.yml`
- `.github/workflows/backend-package.yml`
- smoke workflows for callbacks, coordination, provider lifecycle, jobs, observability, production, and task lifecycle.

---

## Security model

SourceNerve is a policy and mutation boundary, not a general remote shell.

- Workspace execution is bounded, sanitized, workspace-scoped, and governed by Harness policy/approval.
- File operations reject escapes from configured repositories.
- Git mutations use exact-state concurrency gates and never expose force push or arbitrary refspecs.
- Secrets remain outside renderer, plugin, MCP, repository, and diagnostic payloads.
- Desktop renderer has no Node.js access and no provider token access.
- Provider auth is owned by `gh`/`glab` or product OAuth flows and is handled only by trusted daemon/Main-process surfaces.

Run SourceNerve as an unprivileged OS user and place appropriate TLS/reverse-proxy authentication in front of deployments exposed outside a trusted local environment.

---

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

---

## Documentation map

| Topic | Document |
| --- | --- |
| ChatGPT review bridge | `docs/chatgpt-review-bridge.md` |
| Desktop architecture | `docs/desktop-architecture-adr.md` |
| Desktop IPC contract | `docs/desktop-ipc-contract.md` |
| Desktop managed runtime | `docs/desktop-managed-runtime.md` |
| Desktop release | `docs/desktop-release.md` |
| Desktop security review | `docs/desktop-security-review.md` |
| Task lifecycle | `docs/task-lifecycle.md` |
| Git provider lifecycle | `docs/git-provider-lifecycle.md` |
| Plugin packaging | `docs/plugin-packaging.md` |
| MCP artifact verification | `docs/mcp-artifact-verification.md` |
| Production operations | `docs/production-operations.md` |
| Release and recovery | `docs/release-and-recovery.md` |

---

## Status

`0.1.23` treats SourceNerve as a **Harness shell and Desktop runtime** for AI-assisted repository work: workspace security, native Codex/ChatGPT execution, supervised closed-loop verification, durable mutation guards, Git/provider workflows, plugin/MCP composition, approvals, audit, recovery, jobs, callbacks, diagnostics, and release/security operations are core.

Repository indexing and advanced code intelligence are delegated to plugin/MCP implementations under SourceNerve policy.
