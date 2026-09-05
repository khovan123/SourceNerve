# SourceNerve Codex Native Lane

Status: P1-P2 merged; P3 implemented and validated

## Authority boundary

The Codex native lane uses the official `codex app-server --stdio` protocol.

```text
Codex owns: model reasoning, native tools, thread/session state, compaction, auth, skill interpretation.
SourceNerve owns: workspace/run binding, Harness policy, skill activation, process lifecycle, recovery gates, verification gates, Git/provider mutation authority.
```

The Codex lane must not call `AgentModelAdapter`, `runAgentLoop`, or create a second reasoning loop. Automatic marketplace download and model-side skill routing are outside this lane.

## Phase status

| Phase | State | Scope |
| --- | --- | --- |
| P1 Native app-server foundation | Merged | JSON-RPC host, account/thread/turn lifecycle, crash recovery, persistent run-to-thread binding |
| P2 Native skill runtime | Merged | content-addressed skill cache, per-run projection, `skills/extraRoots/set`, `skills/list`, explicit native skill input, max 2 active skills |
| P3 Production Harness integration | Implemented | production Desktop runtime, durable one-shot Harness approval forwarding, lifecycle cleanup, renderer-safe IPC, real installed-Codex E2E |

## P3 — Production Harness integration

### P3.1 Production runtime and lifecycle — implemented

Implemented in:

- `desktop/src/main/codex-harness-runtime.ts`
- `desktop/src/main/codex-app-server-host.ts`
- `desktop/src/main/codex-runtime-pool.ts`
- `desktop/src/main/task-manager.ts`
- `desktop/src/main/task-ipc.ts`
- `desktop/src/main/harness-policy.ts`
- `desktop/src/shared/harness-api.ts`
- `desktop/src/preload.ts`
- `desktop/src/main.ts`

Behavior:

- `CodexThinRunner` is instantiated in the production Desktop main process rather than tests only;
- one Harness run remains bound to one persisted Codex thread;
- cwd is resolved from the managed workspace and cannot be supplied by the renderer;
- sandbox and approval policy are projected by SourceNerve and cannot be supplied by the renderer;
- P3 currently accepts only a current, running `workspace-write` Harness run with read/write/exec all allowed;
- stale, recovering, pending-approval, uncertain-mutation, read-only, and non-writable scopes fail closed before a Codex turn starts;
- account responses exposed to the renderer are bounded and omit the Codex account email;
- Harness cancellation force-terminates and reaps the corresponding Codex runtime, including an active turn;
- terminal runs discovered through Harness get/list are cleaned up;
- Desktop quit shuts down all native Codex runtimes, rejects pending turns, and flushes persistent thread bindings;
- Plugin Hub and the Codex runner share one in-memory/content-addressed skill cache instance so install/enable/reconcile changes are visible without Desktop restart;
- skill activation remains exact and bounded to at most two plugin skill keys;
- prompt and renderer-visible native response sizes are bounded before crossing IPC.

### P3.1 escalation boundary — superseded by durable forwarding

Native Codex uses `workspace-write` with `approvalPolicy=on-request`. P3.1 originally declined every app-server escalation. P3.2 replaces that temporary fail-closed behavior with a durable Harness approval bridge for supported native requests. Unsupported requests and protected Git/provider mutation still fail closed.

`guarded-durable` is intentionally not used as a native Codex execution profile because Codex can execute commands inside its sandbox without emitting an approval callback; SourceNerve therefore cannot claim every native command passed the `exec=ask` ledger. `interactive-local` remains the supported native execution profile while escalations are separately one-shot approved.

### P3.2 Durable Harness approval forwarding — implemented

Implemented behavior:

- daemon endpoint `/api/v1/harness/approvals/native/resolve` owns canonicalization and durable ledger state;
- supported callbacks are `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, and `item/permissions/requestApproval`;
- every native intent is bound to exact Harness run, workspace, current Git HEAD, capability, canonical payload SHA-256, and persisted app-server request id;
- request id is also part of the canonical argument digest, so a changed callback id cannot reuse an old approval;
- pending exact replays reuse one durable approval row across daemon reconstruction;
- Desktop holds the JSON-RPC callback while approval is pending and polls only the internal allowlisted daemon endpoint;
- an operator `Allow once` is consumed exactly once before Desktop returns `accept` to Codex;
- SourceNerve never returns `acceptForSession`; permission grants are turn-scoped with strict review;
- deny, expiration, timeout, resolver failure, Harness cancel, Desktop shutdown, scope drift, HEAD drift, and changed payload/request id all fail closed;
- native Git/provider command escalation remains blocked and must use SourceNerve's guarded Git/provider workflows;
- file-system permission expansion is restricted to canonical existing paths inside the managed workspace; glob/special/outside-workspace widening is rejected;
- native request id is exposed as bounded approval metadata in the Harness approval UI for audit.

Migration `0035_harness_native_approval_request_id.sql` adds the persistent native request-id field and advances `STATE_SCHEMA_VERSION` to 35.

### P3.3 Real installed Codex smoke/E2E — implemented

The opt-in test `desktop/src/integration/codex-native.integration.test.ts` uses the installed Codex CLI and the real `codex app-server --stdio` implementation rather than a fake child process. It verifies:

```text
CodexThinRunner
  -> app-server initialize
  -> account/read (ChatGPT account required)
  -> thread/start
  -> skills/extraRoots/set + skills/list
  -> explicit native skill input
  -> live turn/start + bounded response
  -> runner shutdown
  -> new runner + thread/resume
  -> second live turn on the exact persisted thread
```

Normal CI/integration runs skip the live model test. `npm run test:codex:e2e` opts in. The test uses a temporary isolated `CODEX_HOME`, copies only the existing Codex auth/config/installation files required by the CLI, never parses or prints credential contents/account email, and deletes the temporary state afterward.

Validated locally with `codex-cli 0.153.4`: the real ChatGPT-authenticated skill/turn/resume E2E passed.

## P3 completion criteria

P3 completion criteria are satisfied:

- production runtime and lifecycle tests pass;
- renderer cannot choose cwd/sandbox/approval policy or bypass workspace/run binding;
- native escalation requests cannot bypass Harness authority;
- one-shot durable Harness approval forwarding is implemented for supported native Ask actions;
- approval durability across daemon reconstruction, app restart/thread resume, and Harness cancel cleanup are verified;
- the opt-in real installed Codex app-server smoke/E2E passed;
- full Desktop tests, typecheck, normal integration suite, and production package pass;
- full Rust suite is 234/235 in the current execution environment, with the sole remaining failure being the pre-existing Linux `bwrap` uid-map environment limitation (`Read-only file system`), not a P3 regression.

## Deferred beyond P3

The following are not P3 requirements:

- `AgentModelAdapter` integration;
- `runAgentLoop` integration;
- a second reasoning loop;
- model-side automatic skill router;
- automatic marketplace package download from the Codex lane;
- more than two simultaneously active skills;
- Codex-specific autonomous workflow graph routing.
