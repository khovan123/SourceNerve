# SourceNerve

**Persistent repository intelligence and controlled mutation for AI coding agents.**

SourceNerve is a self-hosted Rust server that exposes whitelisted Git workspaces to MCP-capable assistants. It keeps repository intelligence in SQLite and treats Git as the source of truth. AI clients can index/search memory, traverse a structural code graph, inspect live source, apply reviewed patches, create feature branches, commit/push reviewed changes, open GitHub issues and pull requests, and perform guarded PR merges without receiving arbitrary shell access.

## Current production baseline

- Rust 2024 / Tokio / Axum.
- MCP Streamable HTTP using the official `rmcp` Rust SDK.
- Bearer-token protected `/mcp` and `/api/v1` surfaces.
- Explicit workspace registry; absolute paths are never accepted from clients.
- Full workspace bootstrap from tracked + non-ignored untracked files.
- Persistent SQLite/FTS5 file memory plus live `ripgrep` fallback.
- Tree-sitter structural graph for Rust, Python, JavaScript, TypeScript, and TSX.
- Persistent symbols, structural references, parse state, and resolved graph edges.
- UTF-8 file reads with line ranges and SHA-256 hashes of complete files.
- Complete review diff from `HEAD`, including staged, unstaged, deleted, renamed, and non-ignored untracked files.
- Patch preview with `git apply --check` and per-file optimistic concurrency.
- Incremental memory/graph refresh after patch application.
- Guarded feature-branch checkout, reviewed commit, non-force push, GitHub issue/PR creation, PR state lookup, and expected-head merge.
- Fast-forward-only return to the configured default branch followed by memory/graph rebuild.
- Serialized mutation; no generic shell-execution endpoint.

## Run locally

Requirements:

- Rust 1.88+.
- Git.
- ripgrep.
- a C compiler toolchain for Tree-sitter grammar crates.
- GitHub CLI (`gh`) when GitHub issue/PR/merge tools are enabled.

```bash
cp sourcenerve.example.toml sourcenerve.toml
# edit workspace root and set a strong API token
export SOURCENERVE_BEARER_TOKEN="$(openssl rand -hex 32)"

# optional: required only for SourceNerve GitHub API lifecycle tools
export SOURCENERVE_GITHUB_TOKEN="<github-token>"

cargo run --release
```

`SOURCENERVE_GITHUB_TOKEN` is used only by fixed `gh api` requests and is not returned to MCP/API clients. Git `push` authentication is separate: configure SSH keys or another non-interactive Git credential for the OS user running SourceNerve. Git commands use `GIT_TERMINAL_PROMPT=0`, so missing credentials fail instead of waiting for an interactive prompt.

Health check:

```bash
curl http://127.0.0.1:7331/healthz
```

MCP endpoint:

```text
http://127.0.0.1:7331/mcp
```

Send `Authorization: Bearer <token>` for MCP and `/api/v1/*` requests.

## Workspace configuration

A writable workspace can define its Git remote/default branch and optionally its GitHub repository explicitly:

```toml
[[workspace]]
id = "example"
name = "Example Repository"
root = "/absolute/path/to/repository"
access = "read-write"
remote = "origin"
default_branch = "main"
# Optional for standard github.com origin URLs.
# github_repository = "owner/repository"
```

When `github_repository` is omitted, SourceNerve accepts standard `github.com` SSH/HTTPS remote forms and infers `owner/repository`. Other Git hosts require an explicit future provider integration; they are not silently treated as GitHub.

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

Reviewed source mutation:

- `patch_preview`
- `patch_apply`

Git lifecycle:

- `git_review`
- `git_branch_checkout`
- `git_commit`
- `git_push`
- `git_default_sync`

GitHub lifecycle:

- `github_issue_create`
- `github_pull_create`
- `github_pull_get`
- `github_pull_merge`

The same lifecycle is available through authenticated `/api/v1/*` routes.

## Recommended production mutation flow

```text
git_default_sync
  -> git_branch_checkout(expected_head)
  -> workspace_index / graph analysis / search
  -> read_file
  -> patch_preview
  -> review
  -> patch_apply
  -> git_review
  -> git_commit(expected_head, expected_diff_sha256)
  -> git_push(expected_head)
  -> github_issue_create          # optional
  -> github_pull_create(expected_head)
  -> CI / human or agent review
  -> github_pull_get
  -> github_pull_merge(expected_head_sha)
  -> git_default_sync
  -> continue next task
```

### Branch checkout contract

`git_branch_checkout` requires:

- writable workspace;
- exact `expected_head` match;
- clean working tree;
- a valid Git branch name;
- branch name different from the configured default branch.

It uses `git switch -c`; it does not reset, force-checkout, or discard local changes.

### Reviewed commit contract

`git_review` returns:

- current branch;
- current `HEAD`;
- porcelain status;
- the complete reviewable delta from `HEAD`;
- SHA-256 of that exact delta.

`git_commit` succeeds only when both `expected_head` and `expected_diff_sha256` still match. This makes an edit made after review fail closed. Non-ignored untracked files are included in the review diff/hash, so they cannot be silently added by the subsequent `git add -A` commit step.

Direct SourceNerve commits on the configured default branch are rejected.

### Push contract

`git_push` requires a clean feature branch and exact `expected_head`. It performs a normal upstream push of the current branch only; force push and arbitrary refspecs are not exposed. After the push, SourceNerve verifies that the remote branch resolves to the same commit SHA.

### GitHub PR contract

`github_pull_create` requires the local feature branch to be clean, pushed, and byte-for-byte represented by the same remote commit SHA. `github_pull_get` returns the current PR head SHA used for merge concurrency.

`github_pull_merge` requires:

- an open PR;
- a non-draft PR;
- exact current PR head SHA matching `expected_head_sha`;
- merge method `merge`, `squash`, or `rebase`.

The merge request is still evaluated by GitHub. SourceNerve does **not** bypass repository branch protection, required status checks, required reviews, or GitHub authorization. If GitHub rejects the merge, SourceNerve returns the failure.

### Continue after merge

`git_default_sync` requires a clean tree, fetches the configured default branch, switches to it, and performs `git merge --ff-only <remote>/<default_branch>`. It then rebuilds persistent repository memory and graph state under the same mutation critical section. No reset/force operation is used.

## Structural graph model

Each supported file receives a synthetic `file` symbol. Tree-sitter definitions and structural references are persisted independently from transient symbol-row IDs so incremental symbol replacement can rebind dependencies.

Resolution is deliberately conservative. Same-file targets and path-resolved imported files are preferred; ambiguous targets remain unresolved instead of fabricating dependencies. Broken imports do not silently retarget inheritance to unrelated same-named symbols.

Current structural edge types include:

- `CONTAINS`
- `IMPORTS`
- `REFERENCES`
- `CALLS`
- `EXTENDS`
- `IMPLEMENTS`

`graph_status` reports parse coverage, partial/error files, graph version, symbol/edge counts, and unresolved reference count so clients can decide when to fall back to raw search.

### Incremental graph updates

A patch does not require a whole-repository graph rebuild:

```text
patch_apply
  -> update changed file-memory rows
  -> Tree-sitter parse changed paths
  -> replace graph state only for successfully parsed files
  -> preserve previous structural state on parser failure
  -> re-resolve persisted references and affected dependencies
  -> graph_version++
```

Deleted files cascade their file symbols and structural-reference state. Rename patches track both old and new paths, so stale graph/import/inheritance edges are removed before the new location is resolved.

## Patch concurrency contract

Every patched path must have exactly one `expected_files` entry:

```json
{
  "workspace": "example",
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

SourceNerve intentionally does **not** expose arbitrary shell execution, arbitrary Git commands, force push, raw refspecs, or raw absolute-path file access. Register only repositories an AI client is allowed to inspect or mutate. Read-only workspaces cannot use Git/GitHub mutation tools.

The file reader and indexer canonicalize paths and reject paths/symlinks resolving outside the configured workspace. Git mutations use exact-head/diff concurrency gates and one global mutation lock. GitHub credentials remain server-side. Run the service as an unprivileged OS user and place TLS/reverse-proxy authentication in front of it when exposed outside a trusted network.

## Status

`0.1.x` includes secure workspace IO, persistent file memory, Tree-sitter structural repository graph, graph traversal, reviewed patch mutation, guarded feature-branch/commit/push lifecycle, guarded GitHub issue/PR/merge lifecycle, incremental updates, and MCP transport.

Type-accurate SCIP/LSP resolution, semantic/vector retrieval, and graph-aware context ranking remain separate enrichment layers rather than being mixed into the deterministic structural/mutation core.
