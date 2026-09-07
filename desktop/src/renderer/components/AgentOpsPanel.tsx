import { useEffect, useMemo, useState } from "react";

import type {
  DesktopAgentEvaluationView,
  DesktopAgentMemoryPreview,
  DesktopAgentTurnView,
} from "../../shared/agent-api";
import { ActionButton } from "./atoms/ActionButton";

const AGENT_MECHANISM_STEPS = [
  { title: "Decide", detail: "Model proposes a reply or tool" },
  { title: "Guard", detail: "Harness policy and approvals" },
  { title: "Execute", detail: "Governed tool executor runs it" },
  { title: "Verify", detail: "Evidence verifies or triggers recovery" },
  { title: "Learn", detail: "Memory feeds the next turn" },
] as const;

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
    <section className="space-y-4">
      <div className="rounded-[12px] border border-border/70 bg-muted/20 p-3" aria-label="Harness Agent mechanism">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-foreground">How Harness Agent works</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">The model proposes; Harness remains the execution authority.</p>
          </div>
          <span className="status-pill shrink-0">Governed</span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-5">
          {AGENT_MECHANISM_STEPS.map((step, index) => (
            <div key={step.title} className="rounded-[9px] bg-background/70 px-2.5 py-2">
              <div className="flex items-center gap-1.5">
                <span className="grid size-4 shrink-0 place-items-center rounded-full bg-muted text-[8px] font-semibold text-muted-foreground">{index + 1}</span>
                <span className="text-[10px] font-semibold text-foreground">{step.title}</span>
              </div>
              <p className="mt-1 text-[9px] leading-4 text-muted-foreground">{step.detail}</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[9px] leading-4 text-muted-foreground">A model cannot execute tools directly, bypass permissions, or mark its own work verified. Harness owns policy, approvals, execution, verification, recovery, and learning.</p>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        <p className="text-[11px] font-semibold text-foreground">Activity</p>
        <ActionButton variant="ghost" size="sm" onClick={() => void refreshTurns()} disabled={busy !== null}>
          {busy === "turns" ? "Refreshing…" : "Refresh"}
        </ActionButton>
      </div>

      {error ? <p className="error-banner" role="alert">{error}</p> : null}

      {turns.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">No agent activity</p>
      ) : (
        <div className="space-y-2">
          <div className="max-h-44 space-y-1 overflow-auto">
            {turns.map((turn) => (
              <button
                key={turn.id}
                type="button"
                onClick={() => setSelectedTurnId(turn.id)}
                className={[
                  "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left",
                  selectedTurnId === turn.id ? "bg-muted text-foreground" : "hover:bg-muted/55",
                ].join(" ")}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[11px] font-medium text-foreground">{turn.providerId ?? "Agent"}{turn.modelId ? ` · ${turn.modelId}` : ""}</span>
                  <span className="mt-0.5 block text-[9px] text-muted-foreground">{turn.iterationCount}/{turn.maxIterations} iterations · {turn.inputTokens + turn.outputTokens} tokens</span>
                </span>
                <span className="status-pill">{turn.status}</span>
              </button>
            ))}
          </div>

          {selectedTurn ? (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">{selectedTurn.stopReason ?? selectedTurn.status}</span>
                <ActionButton
                  variant="secondary"
                  size="sm"
                  onClick={() => void evaluateTurn()}
                  disabled={busy !== null || selectedTurn.status === "running"}
                >
                  {busy === "evaluate" ? "Evaluating…" : "Evaluate"}
                </ActionButton>
              </div>
              {latestEvaluation ? (
                <div className="grid grid-cols-3 gap-1.5">
                  <MiniMetric label="Verdict" value={latestEvaluation.finalVerdict} />
                  <MiniMetric label="Context" value={String(latestEvaluation.metrics.contextReads)} />
                  <MiniMetric label="Failures" value={String(latestEvaluation.metrics.failureCount)} />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex gap-2">
          <input
            className="h-9 min-w-0 flex-1 rounded-[9px] border border-border bg-background px-3 text-xs text-foreground outline-none focus:border-primary/45"
            value={memoryQuery}
            maxLength={16 * 1024}
            placeholder="Preview memory"
            onChange={(event) => { setMemoryQuery(event.target.value); setMemory(null); }}
            onKeyDown={(event) => { if (event.key === "Enter") void previewMemory(); }}
            disabled={busy !== null || runStatus !== "running"}
          />
          <ActionButton variant="secondary" size="sm" onClick={() => void previewMemory()} disabled={busy !== null || runStatus !== "running" || !memoryQuery.trim()}>
            {busy === "memory" ? "Loading…" : "Preview"}
          </ActionButton>
        </div>

        {memory ? (
          <div className="space-y-2">
            <MemoryBlock title="Semantic" lines={memory.semantic.map((item) => `${item.path}:${item.startLine}-${item.endLine}`)} />
            <MemoryBlock title="Episodic" lines={memory.episodic.slice(0, 8).map((item) => [item.eventType, item.tool, item.decision, item.route, item.resultCategory].filter(Boolean).join(" · "))} />
            <MemoryBlock title="Procedural" lines={[
              `phase: ${memory.procedural.closedLoopPhase}`,
              `verification: ${memory.procedural.verificationStatus}`,
              `recovery: ${memory.procedural.recoveryStatus}`,
            ]} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/45 px-2 py-2">
      <p className="text-[9px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-[10px] font-semibold text-foreground">{value}</p>
    </div>
  );
}

function MemoryBlock({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="rounded-lg bg-muted/35 px-2.5 py-2">
      <p className="text-[10px] font-semibold text-foreground">{title}</p>
      {lines.length === 0 ? <p className="mt-1 text-[10px] text-muted-foreground">Empty</p> : (
        <div className="mt-1 max-h-28 space-y-1 overflow-auto">
          {lines.map((line, index) => <p key={`${title}:${index}`} className="break-words text-[9px] leading-4 text-muted-foreground">{line}</p>)}
        </div>
      )}
    </div>
  );
}
