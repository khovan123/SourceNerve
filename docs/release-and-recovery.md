# Release, startup preflight, and state recovery

This document defines the production release and recovery contract for SourceNerve.

## Build identity

The production binary exposes a small non-secret identity through `/healthz`, authenticated `/api/v1/status`, authenticated readiness, and MCP `service_status`.

Identity contains:

- service name;
- Cargo package version;
- build commit when supplied at build time;
- SourceNerve state schema version;
- a coarse capability list.

The production Docker build accepts:

```bash
docker build \
  --build-arg SOURCENERVE_BUILD_COMMIT="$(git rev-parse HEAD)" \
  -t sourcenerve:<version> .
```

Build identity must not contain workspace roots, Git remote URLs, bearer tokens, GitHub tokens, SSH credentials, or process environment.

## Startup preflight

SourceNerve performs preflight after loading configuration and before binding the HTTP socket.

Startup fails when any required condition is false:

- `git` is unavailable;
- `rg` is unavailable;
- `gh` is unavailable while GitHub lifecycle credentials are configured;
- the configured state directory cannot be created/written;
- a workspace root is not a readable Git worktree;
- a workspace remote cannot be resolved;
- the configured default branch cannot be resolved to a commit;
- an explicitly configured `github_repository` is not in `owner/repository` form.

This is intentionally stricter than `/healthz`: the process should not advertise itself as a running production service when its core repository dependencies are invalid at boot.

Authenticated readiness remains available after startup to detect runtime drift such as a removed remote or unavailable executable.

## SQLite state is recoverable state, not source truth

Git workspaces remain authoritative. SQLite stores rebuildable repository intelligence, graph state, mutation audit, and provider idempotency records.

Losing SQLite does not alter source code in Git, but it can lose audit/idempotency history and requires reindexing repository intelligence. Preserve state backups when those operational records matter.

## Create a consistent backup

Use authenticated HTTP:

```http
POST /api/v1/state/backup
Authorization: Bearer <token>
Content-Type: application/json

{"retain":5}
```

or MCP `state_backup_create`.

The operation:

1. serializes with other SourceNerve mutations;
2. creates a consistent SQLite snapshot with SQLite `VACUUM INTO`;
3. stores it below the configured state directory in `backups/`;
4. returns only a generated relative backup name;
5. prunes older SourceNerve-generated backups according to bounded retention.

The API does not accept an arbitrary output path.

## Validate a backup

Use authenticated HTTP:

```http
POST /api/v1/state/backup/validate
Authorization: Bearer <token>
Content-Type: application/json

{"backup":"backups/sourcenerve-<generated>.sqlite3"}
```

or MCP `state_backup_validate`.

Validation opens the snapshot read-only and checks:

- SQLite `integrity_check`;
- SQLx migration history exists;
- the core `workspaces` table exists.

Validation does not replace or mutate the live database.

## Offline restore procedure

SourceNerve intentionally has no live restore endpoint. Replacing the database while requests are being served would invalidate in-process assumptions and mutation ordering.

To restore a validated snapshot:

1. stop SourceNerve;
2. keep a copy of the current state database and its WAL/SHM files if present;
3. validate the selected generated backup before replacement;
4. replace the configured SQLite database file while the service is offline;
5. remove stale WAL/SHM files belonging to the replaced database only after confirming the service is stopped;
6. start SourceNerve;
7. confirm `/healthz`, authenticated readiness, and `/api/v1/status`;
8. run `workspace_index` for configured workspaces if Git has advanced beyond the restored indexed state.

If no trustworthy state backup exists, start with a fresh state directory and rebuild repository intelligence from Git using `workspace_index`. Audit/idempotency history from the lost database cannot be reconstructed from Git alone.

## Production transport smoke

The release smoke workflow builds the real production image with the current commit SHA, boots it as the unprivileged container user against a mounted temporary Git repository, and verifies:

- build identity matches the workflow commit SHA;
- `/healthz` responds;
- authenticated `/api/v1/status` responds;
- authenticated readiness is green and does not expose workspace roots;
- SQLite backup creation succeeds;
- the generated backup validates successfully;
- MCP Streamable HTTP completes `initialize` and `tools/list`;
- lifecycle and recovery tools are advertised through MCP.

The smoke uses no real GitHub provider mutation and the workflow retains `contents: read` permissions.

## VPS deployment checklist

For a systemd or container deployment, ensure:

- SourceNerve runs as an unprivileged OS user;
- configured workspace roots are mounted/readable and writable only where intended;
- the state directory is writable and persisted across restarts;
- Git SSH/credential configuration is non-interactive for writable workspace push/fetch operations;
- `SOURCENERVE_BEARER_TOKEN` is injected as a secret and is not committed to configuration;
- `SOURCENERVE_GITHUB_TOKEN` is injected only when GitHub issue/PR/merge operations are required;
- TLS and external authentication are provided by a trusted reverse proxy when the service is exposed outside a trusted private network;
- only one writer instance controls a given workspace/state directory until distributed locking is implemented.
