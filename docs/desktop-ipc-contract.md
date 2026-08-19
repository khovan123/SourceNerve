# SourceNerve Desktop typed API and IPC contract

Issue: #81, extended by #60

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
    | SourceNerveClient + DaemonManager + secure-store bearer
    v
http://127.0.0.1:7331
    |
    v
SourceNerve Rust daemon
```

No layer exposes a generic `invoke(command, args)`, generic HTTP proxy, arbitrary filesystem API, generic process runner, or secret-read API.

## API version

`DESKTOP_API_VERSION = 2` is returned in `RuntimeInfo`.

Version 2 adds the semantic daemon lifecycle surface from #60. Breaking renderer/main contract changes require a deliberate API version increment. The Desktop package ships main/preload/renderer as one release, but explicit versioning prevents silent assumptions as auto-update and daemon compatibility checks evolve.

## Semantic operations

Trusted-main read/status operations:

- `getRuntimeInfo()` — Desktop/platform/bootstrap metadata;
- `getDaemonHealth()` — `/healthz`;
- `getServiceStatus()` — `/api/v1/status`;
- `getReadiness()` — `/api/v1/readiness`;
- `listWorkspaces()` — `/api/v1/workspaces`;
- `cancelOperation(operationId)` — cancellation registry for long-running Desktop operations;
- `subscribeRuntimeEvents(listener)` — safe state/log/progress events.

Daemon lifecycle operations added by #60:

- `getDaemonState()`;
- `startDaemon()`;
- `stopDaemon()`;
- `restartDaemon()`;
- `attachExternalDaemon()`.

Feature issues extend the contract with explicit semantic operations rather than exposing transport/process primitives.

## Trusted-main SourceNerve client

`desktop/src/main/sourcenerve-client.ts`:

- accepts only loopback HTTP origins (`127.0.0.1`, `localhost`, `::1`);
- canonicalizes `localhost` to `127.0.0.1` for deterministic managed-runtime origin behavior;
- uses fixed SourceNerve endpoint paths;
- gets the local bearer from an injected trusted-main callback;
- never returns the bearer to caller data;
- applies bounded request timeouts;
- rejects redirects;
- bounds response size to 2 MiB;
- parses JSON and validates workspace list shape;
- maps HTTP status to safe errors without copying remote response bodies.

The local bearer comes from #61 OS-backed secure storage.

## Daemon manager boundary

`desktop/src/main/daemon-manager.ts` owns only the fixed bundled SourceNerve binary. It accepts a trusted-main launch plan, checks for an already-running endpoint, enforces bounded readiness/version checks, sanitizes logs, and exposes only a `DaemonSnapshot` plus semantic lifecycle methods to IPC.

Renderer cannot select an executable, command argument, signal, environment variable, config path, process ID target, or secret.

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

Raw backend dumps, request headers, tokens, stderr bodies, Cloudflare responses and full exception objects do not cross into renderer.

## Event contract

`DesktopRuntimeEvent` supports:

- `state` — component state transitions;
- `log` — already-sanitized bounded log message;
- `progress` — operation stage/current/total.

The preload hides Electron's `IpcRendererEvent` and returns an unsubscribe function. Renderer receives domain events only.

## Cancellation

`OperationRegistry` maps a bounded semantic operation ID to `AbortController` state. Future indexing/search/task operations may register their cancellation signal in Electron Main. Renderer can request cancellation only by operation ID; it cannot access controllers, processes or arbitrary signals.

The initial SourceNerve status calls use their own bounded HTTP timeout. #63/#68/#69 extend the registry when they add long-running operations. Daemon lifecycle uses its own bounded readiness and shutdown timers rather than exposing process cancellation to renderer.

## Renderer-visible data

Allowed:

- Desktop/app/runtime versions;
- bootstrap ready/error state;
- secure-storage backend name;
- daemon state/health/readiness/version/owned PID metadata;
- safe workspace id/name/writable metadata;
- sanitized state/log/progress events.

Forbidden:

- local bearer;
- Auth0 access/refresh tokens;
- GitHub/GitLab token;
- Cloudflare tunnel token/account token;
- environment variables;
- daemon executable/config absolute paths;
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
- #63 adds workspace add/edit/remove/index operations and materializes the first managed runtime config.
- #64/#65 add Git/Auth0 connection state without token getters.
- #66 adds public-MCP retry/repair/re-enroll actions without Cloudflare token getters.
- #68 adds bounded search/graph/context operations.
- #69/#70 add guarded task/provider lifecycle operations.
- #74 consumes sanitized logs and diagnostics.
- #75 hardens every IPC channel with runtime validation and security regression tests.

The renderer must not bypass this layer as later Desktop features are implemented.
