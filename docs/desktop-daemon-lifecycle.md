# SourceNerve Desktop daemon lifecycle

Issue: #60

Depends on: #58, #59, #61, #81, #83

## Ownership

Electron Main owns the normal local SourceNerve process lifecycle. The renderer can request semantic Start/Stop/Restart/Attach operations but never receives a process handle, executable path, environment, bearer, provider token, shell command, or generic process IPC primitive.

## Bundling

Desktop packaging runs:

```text
cargo build --release
  -> desktop/scripts/stage-daemon.mjs
  -> desktop/resources/bin/<platform>-<arch>/sourcenerve[.exe]
  -> Electron Forge extraResource
  -> <process.resourcesPath>/bin/<platform>-<arch>/sourcenerve[.exe]
```

`postpackage` verifies that the packaged binary exists at the runtime layout, is non-empty, and is executable on Unix-like platforms. Generated staging and package output stay ignored by Git.

## Runtime states

```text
stopped
  -> starting
  -> ready
  -> stopping
  -> stopped

starting/ready
  -> crashed

probe existing endpoint
  -> external       # compatible and authenticated
  -> incompatible   # version mismatch or Desktop cannot authenticate owner of the endpoint
```

An external daemon is never killed automatically. An unknown process that answers the SourceNerve health contract but rejects the Desktop local bearer is treated as a conflict; Desktop does not spawn a second daemon into the same loopback port.

## Start contract

1. A managed launch plan must exist.
2. Probe the configured loopback endpoint before spawning.
3. Verify the staged/bundled executable exists and is executable.
4. Spawn only the fixed SourceNerve binary; there is no renderer-selected command or argument list.
5. Pass a narrow inherited environment plus the Desktop-managed runtime environment.
6. Poll `/healthz` and authenticated `/api/v1/readiness` with bounded retries.
7. Readiness succeeds only when the response contains `ready: true`; HTTP 200 alone is insufficient.
8. Read `/api/v1/status` and require the daemon version to equal the Desktop version for the current v0.1 compatibility contract.
9. Publish only sanitized state/log events to renderer.

## Stop contract

Desktop sends graceful termination first and waits up to five seconds. If the child does not close it sends a forced termination and waits a second bounded interval. Timer listeners are cleaned up as soon as the process closes so a successful fast shutdown does not leave a timeout keeping Electron alive.

Only a child started by the current Desktop process can be stopped or restarted. External/conflicting processes are never terminated.

## Managed runtime restore

`existingDaemonLaunchPlan()` restores a launch plan only when the Desktop-managed config file already exists. It reconstructs the child environment from the product profile plus OS-backed secure-store values. The config file remains non-secret; the local bearer and GitHub token are injected only through Electron Main.

On a fresh install, #63 workspace onboarding materializes the first managed runtime config. This still requires no user-edited TOML, exported environment variable, or copied bearer token. Once a managed config exists, subsequent Desktop launches automatically resume the daemon.

## Secret and log boundary

The child process inherits only an allowlist of required host environment values. Arbitrary parent variables are not copied. Runtime-owned secret variables are passed deliberately from secure storage.

Log sanitization:

- infers sensitive runtime values from names containing token/secret/credential/bearer/password/private-key;
- adds explicitly supplied secret values;
- redacts longer secrets before applying the 8 KiB line bound;
- redacts Authorization Bearer values;
- redacts common token/credential query parameters;
- strips NUL/CR control bytes before renderer events.

The renderer receives only bounded sanitized text.

## IPC surface

Desktop API v2 adds:

- `getDaemonState()`;
- `startDaemon()`;
- `stopDaemon()`;
- `restartDaemon()`;
- `attachExternalDaemon()`.

These are fixed semantic operations. No generic process, signal, shell, filesystem, URL, environment, or secret API is added.

## Recovery behavior

- missing launch plan -> `not_ready`;
- external compatible daemon -> `external`, user may attach;
- external daemon with different local credential -> `incompatible` conflict and no spawn;
- bundled version mismatch -> stop owned child, preserve `incompatible` state;
- startup/readiness timeout -> stop owned child and surface failure;
- unexpected exit -> `crashed` with bounded sanitized message and exit metadata;
- application quit -> graceful shutdown of managed child before Electron exits.
