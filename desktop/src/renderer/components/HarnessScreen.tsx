import { useEffect, useState } from "react";

import type { DesktopHarnessEventView, DesktopHarnessJobView, DesktopHarnessRunView } from "../../shared/harness-api";
import { HarnessApprovalPanel } from "./HarnessApprovalPanel";
import { Panel } from "./Panel";
import { ActionButton } from "./atoms/ActionButton";

export function HarnessScreen() {
  const [runs, setRuns] = useState<DesktopHarnessRunView[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selected, setSelected] = useState<DesktopHarnessRunView | null>(null);
  const [events, setEvents] = useState<DesktopHarnessEventView[]>([]);
  const [jobs, setJobs] = useState<DesktopHarnessJobView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refreshRuns(); }, []);

  useEffect(() => {
    if (!selectedRunId) return undefined;
    const timer = window.setInterval(() => { void refreshRun(selectedRunId, true); }, 5_000);
    return () => window.clearInterval(timer);
  }, [selectedRunId]);

  async function refreshRuns(): Promise<void> {
    setBusy("runs");
    setError(null);
    const result = await window.sourcenerveDesktop.listHarnessRuns({ limit: 50 });
    if (!result.ok) {
      setError(result.error.message);
      setBusy(null);
      return;
    }
    setRuns(result.value);
    const next = selectedRunId && result.value.some((run) => run.id === selectedRunId)
      ? selectedRunId
      : result.value[0]?.id ?? null;
    setSelectedRunId(next);
    if (next) await refreshRun(next);
    else {
      setSelected(null);
      setEvents([]);
      setJobs([]);
    }
    setBusy(null);
  }

  async function refreshRun(runId: string, silent = false): Promise<void> {
    if (!silent) setBusy(`run:${runId}`);
    setError(null);
    const [runResult, eventResult, jobResult] = await Promise.all([
      window.sourcenerveDesktop.getHarnessRun({ runId }),
      window.sourcenerveDesktop.listHarnessEvents({ runId, afterSeq: -1, limit: 200 }),
      window.sourcenerveDesktop.listHarnessJobs({ runId, limit: 50 }),
    ]);
    if (!runResult.ok) setError(runResult.error.message);
    else setSelected(runResult.value);
    if (!eventResult.ok) setError((current) => current ?? eventResult.error.message);
    else setEvents(eventResult.value);
    if (!jobResult.ok) setError((current) => current ?? jobResult.error.message);
    else setJobs(jobResult.value);
    if (!silent) setBusy(null);
  }

  async function selectRun(runId: string): Promise<void> {
    setSelectedRunId(runId);
    await refreshRun(runId);
  }

  async function cancelRun(): Promise<void> {
    if (!selected || selected.status !== "running") return;
    if (!window.confirm(`Cancel Harness run ${selected.id}?\n\nThis does not automatically undo already completed side effects.`)) return;
    setBusy("cancel-run");
    const result = await window.sourcenerveDesktop.cancelHarnessRun({ runId: selected.id });
    if (!result.ok) setError(result.error.message);
    else await refreshRuns();
    setBusy(null);
  }

  async function cancelJob(job: DesktopHarnessJobView): Promise<void> {
    if (job.status !== "active" && job.status !== "pending") return;
    if (!window.confirm(`Cancel Harness job ${job.id}?`)) return;
    setBusy(`job:${job.id}`);
    const result = await window.sourcenerveDesktop.cancelHarnessJob({ runId: job.runId, jobId: job.id });
    if (!result.ok) setError(result.error.message);
    else await refreshRun(job.runId);
    setBusy(null);
  }

  return (
    <div className="space-y-4">
      {error ? <p className="error-banner" role="alert">{error}</p> : null}
      <Panel title="Runs" eyebrow="Durable Harness">
        <div className="split-row">
          <p className="muted">Recent durable runs are loaded from SourceNerve state, not renderer session memory.</p>
          <ActionButton onClick={() => void refreshRuns()} disabled={busy !== null}>{busy === "runs" ? "Refreshing…" : "Refresh"}</ActionButton>
        </div>
        {runs.length === 0 ? <p className="muted">No Harness runs yet.</p> : (
          <div className="space-y-3">
            {runs.map((run) => (
              <article className="panel nested-panel" key={run.id}>
                <div className="split-row">
                  <div>
                    <strong>{run.workspace}</strong>
                    <p className="muted"><code>{run.id}</code> · {run.profile}</p>
                    {run.parentRunId ? <p className="muted">Child of <code>{run.parentRunId}</code></p> : run.children.length > 0 ? <p className="muted">{run.children.length}{run.childrenTruncated ? "+" : ""} child run{run.children.length === 1 && !run.childrenTruncated ? "" : "s"}</p> : null}
                  </div>
                  <div className="button-row"><span className="status-pill">{run.status}</span><span className="status-pill">{run.recoveryState}</span><ActionButton onClick={() => void selectRun(run.id)} disabled={busy !== null}>{selectedRunId === run.id ? "Selected" : "Open"}</ActionButton></div>
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>

      {selected ? (
        <>
          <Panel title="Run overview" eyebrow="Recovery state">
            <div className="split-row">
              <div><strong>{selected.workspace}</strong><p className="muted">{selected.profile} · updated {new Date(selected.updatedAt * 1000).toLocaleString()}</p></div>
              <div className="button-row"><span className="status-pill">{selected.status}</span><span className="status-pill">{selected.freshnessState}</span><span className="status-pill">{selected.recoveryState}</span><ActionButton onClick={() => void refreshRun(selected.id)} disabled={busy !== null}>Refresh run</ActionButton>{selected.status === "running" ? <ActionButton onClick={() => void cancelRun()} disabled={busy !== null}>Cancel run</ActionButton> : null}</div>
            </div>
            <dl className="detail-grid">
              <div><dt>Recovery</dt><dd>{selected.recoveryReason}</dd></div>
              <div><dt>Pending approvals</dt><dd>{selected.pendingApprovals}</dd></div>
              <div><dt>Active jobs</dt><dd>{selected.activeJobs}</dd></div>
              <div><dt>Uncertain mutations</dt><dd>{selected.uncertainMutations}</dd></div>
              <div><dt>Safe read retries</dt><dd>{selected.retryableReadExecutions}</dd></div>
              <div><dt>Blocked pre-dispatch</dt><dd>{selected.blockedPreDispatchExecutions}</dd></div>
            </dl>
            {selected.parentRunId ? <div className="split-row"><p className="muted">Parent run: <code>{selected.parentRunId}</code></p><ActionButton onClick={() => void selectRun(selected.parentRunId!)} disabled={busy !== null}>Open parent</ActionButton></div> : null}
            {selected.children.length > 0 ? (
              <div className="space-y-3">
                <p className="muted">Child runs{selected.childrenTruncated ? " · showing first 100" : ""}</p>
                {selected.children.map((child) => (
                  <article className="panel nested-panel" key={child.id}>
                    <div className="split-row">
                      <div><strong>{child.profile}</strong><p className="muted"><code>{child.id}</code> · updated {new Date(child.updatedAt * 1000).toLocaleString()}</p></div>
                      <div className="button-row"><span className="status-pill">{child.status}</span><ActionButton onClick={() => void selectRun(child.id)} disabled={busy !== null}>Open child</ActionButton></div>
                    </div>
                  </article>
                ))}
              </div>
            ) : null}
            {selected.checkpoint ? <p className="muted">Checkpoint {selected.checkpoint.eventSeq}: {selected.checkpoint.state} / {selected.checkpoint.reason}</p> : null}
          </Panel>

          <Panel title="Timeline" eyebrow="Ordered safe events">
            {events.length === 0 ? <p className="muted">No events recorded.</p> : <ol className="feature-list">{events.map((event) => <li key={event.seq}><code>#{event.seq}</code> {event.summary} <span className="muted">· {new Date(event.createdAt * 1000).toLocaleTimeString()}</span></li>)}</ol>}
          </Panel>

          <Panel title="Jobs" eyebrow="Durable work">
            {jobs.length === 0 ? <p className="muted">No Harness jobs for this run.</p> : <div className="space-y-3">{jobs.map((job) => <article className="panel nested-panel" key={job.id}><div className="split-row"><div><strong>{job.kind}</strong><p className="muted"><code>{job.id}</code>{job.taskId ? ` · task ${job.taskId}` : ""}</p></div><div className="button-row"><span className="status-pill">{job.status}</span>{job.status === "active" || job.status === "pending" ? <ActionButton onClick={() => void cancelJob(job)} disabled={busy !== null}>Cancel job</ActionButton> : null}</div></div></article>)}</div>}
          </Panel>

          <HarnessApprovalPanel runId={selected.id} />
        </>
      ) : null}
    </div>
  );
}
