# SourceNerve Agent Orchestration — Implemented Foundation

Status: implemented for P1-P5 foundation

Reference architecture: selected ideas from `tini-coder/tini-agent`, adapted to SourceNerve's governed Harness and plugin/MCP extension model rather than copied as a separate agent runtime.

## Authority boundary

The implemented boundary is:

```text
Agent proposes the next action.
Harness decides whether it is allowed and how it executes.
Repository evidence decides whether the result is verified.
Memory projects bounded, attributable outcomes back into later turns.
```

The Rust core remains deterministic and provider-neutral. No LLM/provider code is allowed to become an authority for RBAC, capabilities, approvals, sandbox policy, verification, recovery, or publish gates.

## Implementation summary

| Phase | Implemented state |
| --- | --- |
| P1 Context Gate | Deterministic context classifier, safe Harness event metadata, HTTP/MCP/Desktop diagnostic surface |
| P2 Agent Turn Loop | Durable Rust turn state plus provider-neutral Desktop Agent Host loop with hard iteration limit and governed tool-executor boundary |
| P3 Memory | Read-only semantic, episodic, and procedural projections from existing SourceNerve state; no duplicate memory store |
| P4 Eval / Ops | Deterministic evaluation history, optional downstream judge record, read-only Desktop Agent Ops inspection surface |
| P5 Graph | Non-durable deterministic Agent Host graph runtime with code-owned routers, parallel-wave collision detection, `maxVisits`, and `maxSteps` |

## P1 — Deterministic Context Gate

Implemented in:

- `src/harness_context_gate.rs`
- `src/harness.rs`
- `src/harness_http.rs`
- `src/harness_tool_pipeline.rs`
- `src/mcp_process_plugin.rs`
- `desktop/src/shared/harness-api.ts`
- `desktop/src/main/harness-policy.ts`
- `desktop/src/main/harness-parser.ts`
- `desktop/src/main/task-manager.ts`
- `desktop/src/main/task-ipc.ts`
- `desktop/src/preload.ts`
- `desktop/src/renderer/components/HarnessContextGatePanel.tsx`
- `desktop/src/renderer/components/HarnessScreen.tsx`

Behavior:

- classifies requests without calling an LLM;
- routes to existing SourceNerve retrieval surfaces such as exact source, impact, architecture, symbols, Git state, semantic search, text search, or mixed context;
- fails open to bounded repository context for repository-bound requests rather than silently answering without evidence;
- when bound to a Harness run, persists only route metadata, query byte length, and SHA-256 in `context/gate`;
- raw query text is not persisted in Harness events;
- routing itself is read-only and does not count as repository evidence having been read.

Migration: none. P1 uses the existing `harness_events` ledger.

## P2 — Agent Turn Loop

### Durable core

Implemented in:

- `src/harness_agent.rs`
- `migrations/0031_harness_agent_turns.sql`
- `src/harness_http.rs`

The durable turn record contains:

- Harness run binding;
- idempotent `client_request_id` / request fingerprint;
- running/terminal status;
- hard `max_iterations` and iteration count;
- bounded provider/model identifiers;
- bounded stop reason;
- token counters and timestamps.

Detailed turn activity continues to use `harness_events`, including:

- `agent/turn_started`
- `agent/iteration`
- `agent/decision`
- `agent/turn_completed`

Hidden reasoning / chain-of-thought is neither part of the API contract nor persisted.

### Desktop Agent Host

Implemented in:

- `desktop/src/main/agent-model-adapter.ts`
- `desktop/src/main/agent-session.ts`
- `desktop/src/main/agent-loop.ts`
- `desktop/src/main/agent-orchestrator.ts`
- `desktop/src/main/agent-parser.ts`

The loop is intentionally small:

```text
model decision
    |
    +-- reply/stop -> terminal turn
    |
    +-- tool proposal
            |
            v
GovernedAgentToolExecutor
            |
            v
Harness-governed result
            |
            v
working-session observation -> next iteration
```

Important constraints:

- model adapters can propose a tool but cannot execute one directly;
- the only execution boundary exposed to the loop is `GovernedAgentToolExecutor`;
- the loop has a natural stop and a hard `1..64` iteration limit;
- working context is bounded and in-memory, not a second long-term-memory store;
- a replayed durable running turn that already has iterations is not falsely resumed from an unrecoverable in-memory model session. The caller must reload/recover explicitly instead.

## P3 — Semantic / Episodic / Procedural Memory

Implemented in:

- `src/harness_memory.rs`
- `desktop/src/main/agent-memory.ts`
- `desktop/src/main/agent-manager.ts`

No migration was added for P3.

### Repository context

Higher-level repository context is delegated to workspace-visible plugin skills/MCP extensions. SourceNerve memory itself projects only bounded Harness/run evidence and exact repository state; it does not build semantic repository memory.

### Episodic run memory

Projects bounded, allowlisted metadata from the existing Harness event ledger. Raw arguments and raw tool output are not copied into the episodic projection.

### Procedural memory

Projects existing repository/Harness state:

- repository entrypoints and guidance;
- active plans;
- validation owners;
- closed-loop phase;
- verification and recovery state;
- selected proof type;
- Harness learning hints.

There is no Tini-style `MEMORY.md` mirror and no duplicate repository source of truth.

For the renderer, `DesktopAgentManager.previewMemory()` removes semantic source bodies and timestamps before returning the preview. The Agent Host can use full bounded semantic content internally; the UI receives only the inspection metadata it needs.

## P4 — Agent Eval / Ops

Implemented in:

- `src/harness_eval.rs`
- `migrations/0032_harness_agent_evaluations.sql`
- `desktop/src/main/agent-eval.ts`
- `desktop/src/shared/agent-api.ts`
- `desktop/src/main/agent-manager.ts`
- `desktop/src/main/agent-policy.ts`
- `desktop/src/main/agent-ipc.ts`
- `desktop/src/main.ts`
- `desktop/src/main/ipc-policy.ts`
- `desktop/src/main/sourcenerve-client.ts`
- `desktop/src/preload.ts`
- `desktop/src/renderer/components/AgentOpsPanel.tsx`
- `desktop/src/renderer/components/HarnessScreen.tsx`

### Deterministic evaluator

Evaluator version 1 currently checks:

1. turn is terminal;
2. iteration count does not exceed the configured hard limit;
3. Harness run is not stale/cancelled/failed;
4. repository freshness is current;
5. recovery is not needed/in progress;
6. required verification has passed;
7. selected repository proof, when present, is satisfied.

Persisted metrics include:

- iterations / max iterations;
- context reads;
- executions;
- failure count;
- learning count;
- satisfied proof count;
- input/output token counts.

### Optional judge rule

Judge records are downstream of deterministic evaluation. Final verdict is computed so that a judge can downgrade a deterministic pass but can never upgrade a deterministic failure:

```text
deterministic FAIL + judge PASS -> final FAIL
deterministic PASS + judge FAIL -> final FAIL
```

The judge update and `agent/judge_recorded` Harness event are committed atomically.

### Desktop Agent Ops surface

Renderer IPC exposes exactly four bounded operations:

- `listAgentTurns`
- `previewAgentMemory`
- `evaluateAgentTurn`
- `listAgentEvaluations`

`AgentOpsPanel` displays durable turn metadata, sanitized memory projections, deterministic checks, and bounded metrics. It cannot:

- select a provider/model;
- execute a tool;
- override Harness policy;
- approve a tool;
- record a judge verdict;
- start an autonomous agent run.

Memory preview is disabled in the UI when the Harness run is no longer running/current, matching the Rust memory contract. Deterministic evaluation is exposed only for terminal turns in the UI.

## P5 — Deterministic Graph Runtime

Implemented in:

- `desktop/src/main/agent-graph.ts`
- `desktop/src/main/agent-graph.test.ts`

The graph runtime is intentionally in the Agent Host, not the trusted Rust authority layer.

Implemented behavior:

- explicit nodes and code-owned routers;
- deterministic shared-state merge;
- parallel-ready waves;
- parallel nodes must write disjoint state keys;
- duplicate writes fail with an explicit parallel-state-collision error;
- per-node `maxVisits`;
- global `maxSteps`;
- bounded node/state identifiers;
- graph lifecycle events for start, node start/end, route, and graph end.

The model does not own graph routing. Any future mutation/tool node must still delegate to the Harness-governed execution boundary.

Migration: none. Graph execution is intentionally non-durable in this foundation. Durable graph checkpointing should only be added if restart-safe workflow recovery becomes a concrete requirement; it must not duplicate Harness event history.

## Current event model

New agent/context events introduced by this implementation include:

```text
context/gate
agent/turn_started
agent/iteration
agent/decision
agent/turn_completed
agent/evaluated
agent/judge_recorded
```

They coexist with the existing Harness policy, approval, execution, verification, recovery, proof, and learning events. `harness_events` remains the single durable event ledger.

## Intentionally not activated yet

The following are intentionally not exposed as production autonomous behavior in this implementation:

- a concrete general-purpose chat/model provider adapter;
- a concrete generic `GovernedAgentToolExecutor` wired to all SourceNerve tools;
- a renderer `Run agent` / autonomous-run button;
- model-controlled graph routing;
- durable graph checkpoint tables.

This is an authority-boundary decision, not a placeholder fake implementation. The orchestration contracts are ready for a real configured model adapter and a real Harness-governed dispatch adapter without weakening current RBAC/capability/approval/sandbox/proof controls.

## Verification — 2026-08-30

All requested verification completed successfully after the final Desktop Agent Ops wiring.

### Rust formatting

```text
cargo fmt --all
PASS
```

### Full Harness integration suite

```text
cargo test harness_integration_tests -- --nocapture
17 passed; 0 failed; 0 ignored
```

The suite includes context-gate redaction, durable/restart-safe agent turns, three-layer memory, deterministic eval/judge downgrade-only behavior, approval exactness, closed-loop context/execute/verify/recover/learn behavior, recovery, stale-head handling, and Harness auto-attachment.

### Desktop typecheck

```text
cd desktop
npm run typecheck
PASS
```

### Full Desktop test suite

```text
cd desktop
npm test
67 test files passed
264 tests passed
```

The full suite includes the new Agent policy, Agent loop, Agent graph, Harness context parser/policy tests, plus the existing Desktop security, provider, MCP, task, update, workspace, runtime, and renderer tests.

## Resulting product boundary

The implemented SourceNerve foundation can now be summarized as:

```text
Plugin/MCP Repository Intelligence
        +
Harness Context / Memory Projection
        +
Provider-neutral Agent Loop
        +
Governed Harness Authority
        +
Deterministic Verification / Eval
        +
Deterministic Graph Orchestration
```

The operative rule remains:

> Agent proposes. Harness governs. Repository proves. Memory learns.
