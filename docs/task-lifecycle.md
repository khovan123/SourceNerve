# Durable task Git and pull-request lifecycle

SourceNerve schema version 7 extends snapshot-bound task transactions through the guarded Git and GitHub lifecycle. It does not add an LLM, background planner, arbitrary shell access, force-push, reset, or raw Git refspecs.

## State model

The existing `tasks.status` field keeps the schema-v6 mutation meaning:

- `active`: the task snapshot is current and may still propose/apply a patch;
- `stale`: repository or graph state drifted from the task snapshot;
- `applied`: the stored task patch was successfully applied to the working tree;
- `cancelled`: the task was explicitly cancelled before application.

Schema v7 adds a separate `task_lifecycle.phase` for repository-delivery progress:

```text
snapshot
  -> branched
  -> patched
  -> reviewed
  -> committed
  -> pushed
  -> pr_open
  -> merged
  -> completed
```

Keeping the two dimensions separate preserves the established patch contract: an `applied` task can still be only `patched`, `reviewed`, `committed`, or later in the delivery lifecycle.

`task_get` keeps the existing `task`, `proposals`, and sanitized ordered `events` fields and adds a root `lifecycle` object.

## Persisted lifecycle metadata

The lifecycle row stores only bounded identifiers and concurrency tokens needed to resume safely:

- feature branch name;
- reviewed diff SHA-256;
- local commit SHA;
- verified pushed SHA;
- optional GitHub issue number;
- pull-request number and observed head SHA;
- merge SHA;
- final default-branch synced HEAD.

It does not store Git credentials, GitHub tokens, API bearer tokens, full review diffs, patch bodies, prompt text, absolute workspace paths, or provider request bodies.

## Task-scoped operations

Authenticated REST routes are under `/api/v1/tasks/lifecycle/*`; equivalent MCP tools are exposed for agent clients.

```text
task_branch_checkout
  -> task_git_review
  -> task_git_commit
  -> task_git_push
  -> task_github_issue_create        # optional
  -> task_github_pull_create
  -> task_github_pull_get            # explicit CI/review polling by the client
  -> task_github_pull_merge
  -> task_default_sync
```

The client may continue using `task_propose_patch` and `task_apply_patch` between branch checkout and review. SourceNerve does not poll CI or merge a pull request in the background.

## Recovery rules

Lifecycle retries are fail-closed but designed to recover deterministic side effects after a process restart.

### Branch checkout

A branch operation may be recovered only when the current branch equals the persisted task branch, the current HEAD still equals the task base HEAD, and the working tree is clean. Otherwise the lifecycle and repository disagree and the request is rejected.

### Reviewed commit

`task_git_review` returns the complete current review delta but persists only its SHA-256. `task_git_commit` requires that exact hash to remain current.

If Git committed successfully but SourceNerve stopped before persisting lifecycle state, a retry can recover the commit only when all of these are true:

- the current branch is the task branch;
- the working tree is clean;
- current HEAD has exactly the task base HEAD as its first parent.

A later or unrelated commit is not adopted automatically.

### Push

A push retry first verifies the current clean branch and persisted task commit. If the configured remote branch already resolves to that exact commit SHA, SourceNerve records the push as recovered instead of pushing again. Force push is never exposed.

### GitHub issue and pull creation

Task-scoped issue and pull creation derive stable provider idempotency keys from the task ID. They reuse the existing persistent provider fingerprint store:

- same key and same request fingerprint replays the saved provider result;
- same key and a different title/body/base/draft or other side-effect input fails before provider mutation.

Persisted lifecycle issue/PR numbers must agree with the provider-idempotency replay result.

### Pull-request merge

Before merge, SourceNerve reads the current pull request and requires its head SHA to equal the exact task-pushed SHA. The existing GitHub merge guard then applies the same expected-head check again. Branch protection, required checks, required reviews, and provider authorization remain authoritative.

### Default sync and completion

After a persisted successful merge, `task_default_sync` reuses the existing guarded default sync:

```text
fetch configured remote
  -> switch configured default branch
  -> fast-forward only
  -> rebuild repository memory + deterministic graph
  -> persist default_synced_head
  -> lifecycle phase = completed
```

There is no reset or force checkout. A completed sync is replayable from the persisted final HEAD.

## Concurrency and deployment boundary

Lifecycle persistence survives process restart, but mutation serialization remains process-local. Do not run multiple SourceNerve writer processes against the same workspaces/state directory until a distributed lock domain is implemented.

The runtime identity advertises `task-git-pr-lifecycle` and `state_schema_version = 7` so clients and operational checks can reject an incompatible deployment.

## Verification

Rust integration tests use real temporary Git repositories and bare remotes to verify:

- branch/task state persistence;
- review SHA persistence without diff-body persistence;
- changed-after-review rejection;
- crash recovery after local commit;
- crash recovery after remote push;
- fast-forward default sync and repository reindex;
- sanitized ordered lifecycle events.

The dedicated production task-lifecycle smoke builds the real production image and exercises an authenticated task through branch checkout, proposal/application, review, commit, push, durable `task_get`, remote-SHA verification, and MCP lifecycle-tool discovery.
