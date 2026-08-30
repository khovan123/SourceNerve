import { useEffect, useMemo, useState } from "react";

import type {
  DesktopAgentEvaluationView,
  DesktopAgentMemoryPreview,
  DesktopAgentTurnView,
} from "../../shared/agent-api";
import { Panel } from "./Panel";
import { ActionButton } from "./atoms/ActionButton";

export function AgentOpsPanel({
  runId,
  runStatus,
  onChanged,
}: {
  runId: string;
  runStatus: string;
  onChanged?: () => void;
}) {
  const [turns, setTurns] = useState<DesktopAgentTurnView[]>([]);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [evaluations, setEvaluations] = useState<DesktopAgentEvaluationView[]>([]);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memory, setMemory] = useState<DesktopAgentMemoryPreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedTurn = useMemo(
    () => turns.find((turn) => turn.id === selectedTurnId) ?? null,
    [selectedTurnId, turns],
  );

  useEffect(() => {
    setMemory(null);
    setMemoryQuery("");
    void refreshTurns();
  }, [runId]);

  useEffect(() => {
    if (!selectedTurnId) {
      setEvaluations([]);
      return;
    }
    void refreshEvaluations(selectedTurnId, true);
  }, [selectedTurnId]);

  async function refreshTurns(silent = false): Promise<void> {
    if (!silent) setBusy("turns");
    setError(null);
    const result = await window.sourcenerveDesktop.listAgentTurns({ runId, limit: 50 });
    if (!result.ok) {
      setError(result.error.message);
      if (!silent) setBusy(null);
      return;
    }
    setTurns(result.value);
    setSelectedTurnId((current) => current && result.value.some((turn) => turn.id === current)
      ? current
      : result.value[0]?.id ?? null);
    if (!silent) setBusy(null);
  }

  async function refreshEvaluations(turnId: string, silent = false): Promise<void> {
    if (!silent) setBusy("evaluations");
    setError(null);
    const result = await window.sourcenerveDesktop.listAgentEvaluations({ turnId, limit: 20 });
    if (!result.ok) setError(result.error.message);
    else setEvaluations(result.value);
    if (!silent) setBusy(null);
  }

  async function evaluateTurn(): Promise<void> {
    if (!selectedTurn || selectedTurn.status === "running") return;
    setBusy("evaluate");
    setError(null);
    const result = await window.sourcenerveDesktop.evaluateAgentTurn({ turnId: selectedTurn.id });
    if (!result.ok) setError(result.error.message);
    else {
      await refreshEvaluations(selectedTurn.id, true);
      onChanged?.();
    }
    setBusy(null);
  }

  async function previewMemory(): Promise<void> {
    const query = memoryQuery.trim();
    if (!query || runStatus !== "running") return;
    setBusy("memory");
    setError(null);
    const result = await window.sourcenerveDesktop.previewAgentMemory({ runId, query });
    if (!result.ok) setError(result.error.message);
    else setMemory(result.value);
    setBusy(null);
  }

  const latestEvaluation = evaluations[0] ?? null;

  return (
    <Panel
      title="Agent ops"
      eyebrow="Turns · memory · deterministic eval"
      actions={(
        <ActionButton variant="secondary" size="sm" onClick={() => void refreshTurns()} disabled={busy !== null}>
          {busy === "turns" ? "Refreshing…" : "Refresh"}
        </ActionButton>
      )}
    >
      <div className="space-y-4">
        <div>
          <p className="text-sm text-foreground">Inspect durable agent turns and their bounded memory and evaluation projections.</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            This surface cannot select a model, execute a tool, override Harness policy, or record an LLM judge verdict.
          </p>
        </div>

        {error ? <p className="error-banner" role="alert">{error}</p> : null}

        {turns.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">No agent turns are bound to this Harness run yet.</p>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[minmax(260px,0.7fr)_minmax(0,1.3fr)]">
            <div className="max-h-72 space-y-2 overflow-auto pr-1">
              {turns.map((turn) => (
                <button
                  key={turn.id}
                  type="button"
                  onClick={() => setSelectedTurnId(turn.id)}
                  className={[
                    "w-full rounded-xl border px-3 py-3 text-left transition",
                    selectedTurnId === turn.id ? "border-primary/40 bg-primary/7" : "border-border hover:bg-muted/35",
                  ].join(" ")}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold text-foreground">{turn.providerId ?? "provider-neutral"} · {turn.modelId ?? "model-unset"}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">{turn.iterationCount}/{turn.maxIterations} iterations · {turn.inputTokens + turn.outputTokens} tokens</p>
                    </div>
                    <span className="status-pill">{turn.status}</span>
                  </div>
                  <code className="mt-2 block truncate text-[10px] text-muted-foreground">{turn.id}</code>
                </button>
              ))}
            </div>

            {selectedTurn ? (
              <div className="space-y-3">
                <div className="rounded-xl border border-border bg-muted/15 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold text-foreground">Selected turn</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">{selectedTurn.stopReason ? `Stopped: ${selectedTurn.stopReason}` : "Still active"}</p>
                    </div>
                    <ActionButton
                      variant="secondary"
                      size="sm"
                      onClick={() => void evaluateTurn()}
                      disabled={busy !== null || selectedTurn.status === "running"}
                    >
                      {busy === "evaluate" ? "Evaluating…" : "Run deterministic eval"}
                    </ActionButton>
                  </div>
                  {latestEvaluation ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      <MiniMetric label="Final verdict" value={latestEvaluation.finalVerdict} />
                      <MiniMetric label="Context / execute" value={`${latestEvaluation.metrics.contextReads} / ${latestEvaluation.metrics.executions}`} />
                      <MiniMetric label="Proofs / failures" value={`${latestEvaluation.metrics.satisfiedProofs} / ${latestEvaluation.metrics.failureCount}`} />
                    </div>
                  ) : <p className="mt-3 text-xs text-muted-foreground">No evaluation recorded for this turn.</p>}
                </div>

                {latestEvaluation ? (
                  <details className="rounded-xl border border-border px-3 py-2.5">
                    <summary className="cursor-pointer text-xs font-semibold text-foreground">Evaluation checks ({latestEvaluation.checks.filter((check) => check.passed).length}/{latestEvaluation.checks.length} passed)</summary>
                    <div className="mt-2 space-y-2">
                      {latestEvaluation.checks.map((check) => (
                        <div key={check.name} className="rounded-lg border border-border/70 px-2.5 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <code className="text-[10px] text-foreground">{check.name}</code>
                            <span className="status-pill">{check.passed ? "pass" : "fail"}</span>
                          </div>
                          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{check.detail}</p>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        <div className="rounded-xl border border-border p-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10"
              value={memoryQuery}
              maxLength={16 * 1024}
              placeholder="Preview bounded memory for this run"
              onChange={(event) => { setMemoryQuery(event.target.value); setMemory(null); }}
              onKeyDown={(event) => { if (event.key === "Enter") void previewMemory(); }}
              disabled={busy !== null || runStatus !== "running"}
            />
            <ActionButton variant="secondary" onClick={() => void previewMemory()} disabled={busy !== null || runStatus !== "running" || !memoryQuery.trim()}>
              {busy === "memory" ? "Loading…" : "Preview memory"}
            </ActionButton>
          </div>
          {runStatus !== "running" ? <p className="mt-2 text-xs text-muted-foreground">Memory projection is available only while the Harness run is current and running.</p> : null}
          {memory ? (
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              <MemoryBlock title="Semantic" lines={memory.semantic.map((item) => `${item.path}:${item.startLine}-${item.endLine} · score ${item.score}`)} />
              <MemoryBlock title="Episodic" lines={memory.episodic.map((item) => `#${item.seq} ${[item.eventType, item.tool, item.decision, item.route, item.resultCategory, item.errorCategory, item.proofType].filter(Boolean).join(" · ")}`)} />
              <MemoryBlock title="Procedural" lines={[
                `phase: ${memory.procedural.closedLoopPhase}`,
                `verification: ${memory.procedural.verificationStatus}`,
                `recovery: ${memory.procedural.recoveryStatus}`,
                ...memory.procedural.guidance.slice(0, 4),
                ...memory.procedural.learningHints.slice(0, 4).map((hint) => `${hint.tool}/${hint.errorCategory}: ${hint.state}`),
              ]} />
            </div>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-2.5 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-xs font-semibold text-foreground">{value}</p>
    </div>
  );
}

function MemoryBlock({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="rounded-lg border border-border bg-muted/15 p-3">
      <p className="text-[11px] font-semibold text-foreground">{title}</p>
      {lines.length === 0 ? <p className="mt-2 text-[11px] text-muted-foreground">No projected items.</p> : (
        <div className="mt-2 max-h-40 space-y-1 overflow-auto pr-1">
          {lines.map((line, index) => <p key={`${title}:${index}`} className="break-words text-[10px] leading-5 text-muted-foreground">{line}</p>)}
        </div>
      )}
    </div>
  );
}
