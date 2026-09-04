# SourceNerve Desktop typed API and IPC contract

Issue: #81, extended by #60 and #63

Depends on: #58, #59, #61, #83

## Purpose

Renderer code must never build authenticated SourceNerve HTTP requests, retrieve stored credentials, spawn processes, or proxy arbitrary commands. Electron Main owns the trusted local API client and exposes only versioned semantic operations through preload.

## Layers

```text
React Renderer
    |
    | SourceNerveDesktopApi (typed semantic calls/events)
    v
Preload
    |
    | fixed allowlisted IPC channels
    v
Electron Main
    |
    | SourceNerveClient + DaemonManager + WorkspaceManager + secure-store bearer
    v
http://127.0.0.1:7331
    |
    v
SourceNerve Rust daemon
```

No layer exposes a generic `invoke(command, args)`, generic HTTP proxy, arbitrary filesystem API, generic process runner, or secret-read API.

## API version

`DESKTOP_API_VERSION = 3` is returned in `RuntimeInfo`.

Version 2 added the semantic daemon lifecycle surface from #60. Version 3 adds the managed workspace/repository surface from #63. Breaking renderer/main contract changes require a deliberate API version increment. The Desktop package ships main/preload/renderer as one release, but explicit versioning prevents silent assumptions as auto-update and daemon compatibility checks evolve.

## Semantic operations

Trusted-main read/status operations:

- `getRuntimeInfo()` — Desktop/platform/bootstrap metadata;
- `getDaemonHealth()` — `/healthz`;
- `getServiceStatus()` — `/api/v1/status`;
- `getReadiness()` — `/api/v1/readiness`;
- `listWorkspaces()` — daemon-configured `/api/v1/workspaces` view;
- `cancelOperation(operationId)` — cancellation registry for long-running Desktop operations;
- `subscribeRuntimeEvents(listener)` — safe state/log/progress events.

Daemon lifecycle operations added by #60:

- `getDaemonState()`;
- `startDaemon()`;
- `stopDaemon()`;
- `restartDaemon()`;
- `attachExternalDaemon()`.

Workspace lifecycle operations added by #63:

- `pickWorkspaceRepository()` — opens a trusted Electron native directory picker, validates the selected Git root, and returns a short-lived opaque selection ID plus safe repository metadata;
- `listManagedWorkspaces()` — returns Desktop-managed registration, validation, current HEAD/dirty state, and provider/runtime metadata;
- `saveWorkspace(input)` — adds/edits one managed registration from a trusted selection or existing managed root;
- `removeWorkspace(workspaceId)` — removes SourceNerve registration/state only; repository files are never deleted.

Feature issues extend the contract with explicit semantic operations rather than exposing transport/process primitives.

## Native repository selection boundary

#63 deliberately does **not** put a `root` field in `WorkspaceSaveInput`.

```text
User clicks Choose repository
        |
        v
Electron dialog.showOpenDialog(openDirectory)
        |
        v
Main canonicalizes + validates exact Git root
        |
        v
Main stores selectionId -> canonical root (10 minute TTL)
        |
        +--> Renderer receives path for display + safe Git metadata
        |
Renderer save sends selectionId, never a path
        |
        v
Main resolves selectionId and revalidates repository before mutation
```

A compromised renderer therefore cannot register `/etc`, a sibling repository, a symlink-swapped path, or any arbitrary local directory by constructing an IPC payload. Unknown fields such as `root` are rejected by the runtime IPC schema.

Existing managed roots are revalidated in Main when edited/listed. Moved/deleted/broken repositories become an individual `validation.state = invalid` item instead of crashing the entire workspace screen.

## Managed workspace source of truth

Desktop stores non-secret managed workspace metadata in:

```text
<userData>/managed/workspaces.json
```

The registry is schema-versioned, bounded to 1 MiB / 256 workspaces, validated on read/write, and atomically replaced. It contains no bearer/token/provider credential.

On Desktop startup, the registry rematerializes the managed `sourcenerve.toml` before daemon launch. This makes the registry authoritative and repairs a partially written/deleted generated config after crash/restart.

An existing unmanaged TOML with no managed registry is **not** overwritten. #73 owns explicit import/migration so legacy OAuth grants or operator configuration cannot be silently lost.

## Repository validation

Electron Main performs fixed non-interactive Git operations only. It validates:

- canonical selected path equals `git rev-parse --show-toplevel`;
- a real 40-hex `HEAD` exists;
- at least one configured remote exists;
- requested/default remote is currently configured;
- default branch passes `git check-ref-format --branch` and exists as a local or selected-remote ref;
- provider/repository slug is derived from the selected remote for supported GitHub/GitLab hosts;
- dirty/clean state is reduced to a boolean before crossing IPC;
- local filesystem writability before allowing `read-write` access;
- duplicate workspace IDs and duplicate canonical repository roots.

Raw remote URLs are not returned to renderer because they may contain embedded credentials.

## Trusted-main SourceNerve client

`desktop/src/main/sourcenerve-client.ts`:

- accepts only loopback HTTP origins (`127.0.0.1`, `localhost`, `::1`);
- canonicalizes `localhost` to `127.0.0.1` for deterministic managed-runtime origin behavior;
- uses fixed SourceNerve endpoint paths;
- gets the local bearer from an injected trusted-main callback;
- never returns the bearer to caller data;
- applies bounded request timeouts;
- rejects redirects;
- bounds request JSON and response size;
- parses and validates response shapes;
- maps HTTP status to safe errors without copying remote response bodies.

The trusted Main client exposes fixed snapshot/read/task/Harness/runtime calls only. It does not expose a generic URL/method/header API to preload/renderer. Repository intelligence is obtained through plugin/MCP integration surfaces, not dedicated Desktop index/graph endpoints.

The local bearer comes from #61 OS-backed secure storage.

## Daemon manager boundary

`desktop/src/main/daemon-manager.ts` owns only the fixed bundled SourceNerve binary. It accepts a trusted-main launch plan, checks for an already-running endpoint, enforces bounded readiness/version checks, sanitizes logs, and exposes only a `DaemonSnapshot` plus semantic lifecycle methods to IPC.

Renderer cannot select an executable, command argument, signal, environment variable, config path, process ID target, or secret.

Workspace mutations reconfigure only a Desktop-managed daemon. If a compatible external or conflicting daemon is running, workspace config mutation fails closed instead of claiming to update a runtime Desktop does not own.

## Workspace mutation transaction

Workspace add/edit/remove uses this order:

```text
validate repository + duplicates
        |
        v
write atomic managed registry
        |
        v
materialize generated SourceNerve config
        |
        v
configure + start/restart/stop managed daemon
        |
        v
publish semantic workspace state
```

If runtime materialization/reconfiguration fails, Desktop rolls the registry back and attempts to restore the previous managed runtime. Repository files are never a rollback target and are never mutated by workspace registration/removal.

On daemon startup, Rust reconciles the SQLite `workspaces` root table with the configured registry. Removed workspace rows are pruned inside one transaction and FK cascades remove workspace-scoped operational state without touching the repository filesystem.

## Error contract

Every preload method returns:

```ts
type DesktopResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DesktopError };
```

`DesktopError` contains only:

- stable error code;
- safe message;
- retryability;
- optional bounded field details.

Raw backend dumps, request headers, tokens, stderr bodies, remote URLs with credentials, Cloudflare responses and full exception objects do not cross into renderer.

## Event contract

`DesktopRuntimeEvent` supports:

- `state` — component state transitions;
- `log` — already-sanitized bounded log message;
- `progress` — operation stage/current/total.

The preload hides Electron's `IpcRendererEvent` and returns an unsubscribe function. Renderer receives domain events only.

Runtime progress events use bounded semantic operation IDs; no workspace-index operation is part of the Desktop contract.

## Cancellation

`OperationRegistry` maps a bounded semantic operation ID to `AbortController` state. Renderer can request cancellation only by operation ID; it cannot access controllers, processes or arbitrary signals.

The initial SourceNerve status calls use their own bounded HTTP timeout. Long-running task/runtime operations may register bounded cancellation IDs. Daemon lifecycle uses its own bounded readiness and shutdown timers rather than exposing process cancellation to renderer.

## Renderer-visible data

Allowed:

- Desktop/app/runtime versions;
- bootstrap ready/error state;
- secure-storage backend name;
- daemon state/health/readiness/version/owned PID metadata;
- managed workspace id/name/access, user-selected local root, remote **name**, derived provider/repository slug;
- current branch/HEAD, dirty boolean, local writable boolean;
- bounded workspace/runtime/plugin/MCP health;
- sanitized state/log/progress events.

Forbidden:

- local bearer;
- Auth0 access/refresh tokens;
- GitHub/GitLab token;
- raw Git remote URL that may contain credentials;
- Cloudflare tunnel token/account token;
- environment variables;
- daemon executable/config absolute paths;
- arbitrary filesystem paths supplied by renderer for workspace registration;
- arbitrary file content through this generic layer;
- arbitrary URLs/headers/methods;
- arbitrary processes/signals/commands.

## Extension rule

A new Desktop feature may add an IPC operation only when all of these are true:

1. the operation is named for the user/domain action, not the transport mechanism;
2. request fields have a concrete TypeScript schema/shape and bounded strings/arrays;
3. renderer does not choose arbitrary URL/method/header/process/path values;
4. returned errors are translated to `DesktopError`;
5. no secret leaves Main/secure-store/daemon boundary;
6. destructive/external actions preserve the SourceNerve server-side guards and #80 confirmation semantics;
7. the operation has unit/integration coverage appropriate to its risk.

## Relationship to upcoming issues

- #60 owns daemon lifecycle and bundled process state through this same semantic boundary.
- #63 owns workspace add/edit/remove/index operations and managed runtime materialization.
- #64/#65 add Git/Auth0 connection state without token getters.
- #66 adds public-MCP retry/repair/re-enroll actions without Cloudflare token getters.
- #68 adds bounded search/graph/context operations.
- #69/#70 add guarded task/provider lifecycle operations.
- #74 consumes sanitized logs and diagnostics.
- #75 hardens every IPC channel with runtime validation and security regression tests.

The renderer must not bypass this layer as later Desktop features are implemented.