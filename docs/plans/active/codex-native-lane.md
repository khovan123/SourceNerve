# SourceNerve Codex Native Lane

Status: P1-P2 merged; P3 implemented and validated; P4 supervised closed loop implemented and validated

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
| P4 Harness-supervised closed loop | Implemented | Context → Execute → Verify → Recover → Learn supervision around native Codex turns, deterministic repository proofs, bounded recovery, fail-closed lifecycle state |

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
- full Rust suite is 234/235 in the P3 execution environment, with the sole remaining failure being the pre-existing Linux `bwrap` uid-map environment limitation (`Read-only file system`), not a P3 regression.

## P4 — Harness-supervised closed loop

P4 changes the normal native-Codex path from “Harness policy around one Codex turn” into a Harness-owned work lifecycle. Codex remains the only model reasoning engine; Harness deterministically supervises the phases around it.

```text
User prompt
  -> Context
     -> classify work shape + infer work scope + select proof
  -> Execute
     -> native Codex turn
  -> Verify
     -> Harness runs selected repository proof
        -> pass -> Learn
        -> fail -> Recover -> native Codex recovery turn -> Verify again
```

Implemented in:

- `src/harness.rs`
- `src/harness_context_gate.rs`
- `src/harness_http.rs`
- `src/harness_repository_context.rs`
- `src/harness_tool_pipeline.rs`
- `desktop/src/main/task-manager.ts`
- `desktop/src/main/codex-harness-runtime.ts`
- `desktop/src/main/codex-harness-supervision.ts`
- `desktop/src/main/codex-app-server-host.ts`
- `desktop/src/main/sourcenerve-client.ts`
- `desktop/src/shared/harness-api.ts`

### P4.1 Cycle ownership and context classification

- every normal prompt starts a fresh closed-loop cycle on the current Harness run through `start_cycle`;
- a new cycle is rejected while verification or recovery from the prior cycle is unresolved;
- Harness classifies work into `read-only`, `bounded`, `durable`, `operate-application`, or `invariant`;
- Harness infers a bounded work scope from the prompt and repository validation owners so Desktop/UI work can prefer Desktop-owned proof surfaces instead of unrelated root proofs;
- cycle state resets prior proof observations but keeps workspace-level learning patterns;
- context routing persists only bounded metadata and hashes, not the raw user query.

### P4.2 Native execution supervision

Desktop calls exact allowlisted daemon endpoints around every native Codex execution:

- `/api/v1/harness/native/execution/start`
- `/api/v1/harness/native/execution/finish`
- `/api/v1/harness/native/verification/run`

The renderer cannot invoke arbitrary `/harness/native/*` routes or choose lifecycle state directly. Native execution is recorded as the Harness `Execute` phase, including failures that require recovery.

Recoverable native runtime failures such as crash/tool error/timeout may receive at most two internal recovery attempts. Explicit operator denial is not retried automatically.

### P4.3 Deterministic repository verification

- repository manifests and declared test/integration/E2E/recovery/measurement surfaces form the proof catalog;
- proof selection is based on work shape and inferred work scope;
- root Rust focused proof is executable (`cargo test`) rather than a non-runnable `<focused-target>` placeholder;
- a broad `cargo test` proof may match focused Rust invocations without swallowing a more specific `cargo test --test ...` integration proof;
- Verify runs through workspace-confined execution and records proof type/source/status in the Harness run;
- the Desktop transport allows the bounded verification timeout rather than aborting at the ordinary 10-second request timeout;
- before retrying verification, Harness rediscovers repository proof candidates so a recovery turn can add a new valid test/script and have it selected immediately;
- if verification is required but no concrete proof exists, Harness records `proof-unavailable` and transitions to Recover instead of leaving the run stuck in `verification=pending`.

### P4.4 Recovery and Learn

- deterministic proof failure transitions the Harness run into `Recover` with bounded failure evidence;
- recovery prompts are internal SourceNerve supervision messages and are hidden from reconstructed user conversation history;
- recovery stays on the same managed workspace and native Codex thread;
- after a recovery turn, Harness reruns deterministic verification;
- verification recovery is bounded to two attempts, then fails closed;
- successful recovery records recovered/learned state and feeds the existing workspace learning patterns;
- read-only cycles do not require a mutation proof but still terminate cleanly in `Learn` rather than remaining in `Execute`.

### P4.5 Authority remains centralized

P4 does not add another autonomous agent or model loop. Native Codex still owns reasoning and native tool use. Harness owns the lifecycle state machine, deterministic proof execution, bounded recovery policy, one-shot approvals, and completion gates.

Bang commands remain a separate explicit-user shell lane and are not converted into model-supervised closed-loop turns.

## P4 validation

Current P4 validation on the working tree:

- full Rust suite: 241/242 pass; the only failure is the pre-existing nested Linux `bwrap` uid-map limitation (`bwrap: setting up uid map: Read-only file system`);
- full Desktop suite: 84 test files / 384 tests pass;
- Desktop security baseline: pass;
- staged release daemon `0.1.16` isolated data-plane smoke passes `/healthz`, Harness run begin, read-only Context cycle, native Execute start/finish, skipped-success Verify, and final `Learn` state with verification cleared;
- an isolated Electron Desktop main process also launches successfully against the active Wayland session. The smoke launcher uses `--no-sandbox` only because the outer SourceNerve Harness environment cannot nest Chromium namespaces/SUID sandbox; production BrowserWindow sandbox policy is validated separately by `security:check`;
- focused native supervision tests cover Context → Execute → Verify → Recover → Learn, bounded execution crash recovery, proof failure recovery, deny-without-retry, hidden internal recovery history, exact endpoint allowlisting, and proof classification.

## Deferred beyond P4

The following remain intentionally outside the Codex native lane:

- `AgentModelAdapter` integration;
- `runAgentLoop` integration;
- a second reasoning loop;
- model-side automatic skill router;
- more than two simultaneously active skills;
- Codex-specific autonomous workflow graph routing.
