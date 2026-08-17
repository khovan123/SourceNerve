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

## Production CI smoke

CI keeps repository permissions read-only and runs two independent gates.

The Rust gate runs:

```text
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

The container gate:

1. builds the production Dockerfile;
2. creates a temporary Git repository and bare remote;
3. mounts the repository, configuration, and writable state directory into the production image;
4. boots SourceNerve as its unprivileged container user;
5. checks `/healthz`;
6. checks authenticated `/api/v1/readiness`;
7. checks authenticated `/api/v1/workspaces`;
8. asserts the readiness response reports the smoke workspace without exposing a root path.

The local Rust E2E fixture additionally verifies reviewed untracked-file hashing, stale-diff rejection, stale-HEAD rejection, commit, push to a bare remote, fast-forward default sync, reindex, audit success/rejection records, readiness, and provider-free idempotency replay/conflict behavior.

## Multi-instance boundary

The audit/idempotency schema is persistent, but mutation serialization is currently process-local. Do not run multiple SourceNerve writers against the same workspace and SQLite state directory as if they formed a distributed lock domain.

A future multi-instance deployment must add explicit distributed coordination before concurrent writers are supported.
