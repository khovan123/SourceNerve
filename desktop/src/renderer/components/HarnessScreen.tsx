import { useEffect, useState } from "react";

import type { ManagedWorkspaceView } from "../../shared/desktop-api";
import type {
  DesktopHarnessEventView,
  DesktopHarnessJobView,
  DesktopHarnessRunView,
} from "../../shared/harness-api";
import { HarnessConversationPanel } from "./CodexChatPanel";

export function HarnessScreen({
  workspaces,
  selectedWorkspaceId,
  onWorkspaceSelected,
  onWorkspacesChanged,
}: {
  workspaces: ManagedWorkspaceView[];
  selectedWorkspaceId: string | null;
  onWorkspaceSelected(workspaceId: string): void;
  onWorkspacesChanged(): Promise<void>;
}) {
  const [runs, setRuns] = useState<DesktopHarnessRunView[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selected, setSelected] = useState<DesktopHarnessRunView | null>(null);
  const [events, setEvents] = useState<DesktopHarnessEventView[]>([]);
  const [jobs, setJobs] = useState<DesktopHarnessJobView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refreshAll(); }, []);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setSelectedRunId(null);
      setSelected(null);
      setEvents([]);
      setJobs([]);
      return;
    }
    const selectedRunWorkspace = runs.find((run) => run.id === selectedRunId)?.workspace ?? null;
    if (selectedRunWorkspace === selectedWorkspaceId) return;
    const nextRun = autoSelectableWorkspaceRun(runs, selectedWorkspaceId);
    if (nextRun) {
      void selectRun(nextRun.id);
      return;
    }
    setSelectedRunId(null);
    setSelected(null);
    setEvents([]);
    setJobs([]);
  }, [runs, selectedRunId, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedRunId) return undefined;
    const timer = window.setInterval(() => { void refreshRun(selectedRunId, true); }, 1_500);
    return () => window.clearInterval(timer);
  }, [selectedRunId]);

  async function refreshAll(): Promise<void> {
    setError(null);
    await refreshRuns(undefined, true);
  }

  async function refreshRuns(preferredRunId?: string, silent = false): Promise<void> {
    setError(null);
    const result = await window.sourcenerveDesktop.listHarnessRuns({ limit: 100 });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setRuns(result.value);
    const preferred = preferredRunId ?? selectedRunId;
    const preferredRun = preferred ? result.value.find((run) => run.id === preferred) ?? null : null;
    const next = preferredRun && (!selectedWorkspaceId || preferredRun.workspace === selectedWorkspaceId)
      ? preferredRun.id
      : selectedWorkspaceId
        ? autoSelectableWorkspaceRun(result.value, selectedWorkspaceId)?.id ?? null
        : null;
    setSelectedRunId(next);
    if (next) await refreshRun(next, silent);
    else {
      setSelected(null);
      setEvents([]);
      setJobs([]);
    }
  }

  async function refreshRun(runId: string, _silent = false): Promise<void> {
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
  }

  async function selectRun(runId: string): Promise<void> {
    setSelectedRunId(runId);
    await refreshRun(runId);
  }

  async function cancelRun(): Promise<void> {
    if (!selected || selected.status !== "running") return;
    if (!window.confirm("Cancel this Harness run?")) return;
    const result = await window.sourcenerveDesktop.cancelHarnessRun({ runId: selected.id });
    if (!result.ok) setError(result.error.message);
    else await refreshRuns(selected.id, true);
  }

  async function cancelJob(job: DesktopHarnessJobView): Promise<void> {
    if (job.status !== "active" && job.status !== "pending") return;
    const result = await window.sourcenerveDesktop.cancelHarnessJob({ runId: job.runId, jobId: job.id });
    if (!result.ok) setError(result.error.message);
    else await refreshRun(job.runId, true);
  }

  return (
    <div className="h-full min-h-0 bg-background">
      <HarnessConversationPanel
        workspaces={workspaces}
        runs={runs}
        selectedRunId={selectedRunId}
        selectedRun={selected}
        selectedWorkspaceId={selectedWorkspaceId}
        events={events}
        jobs={jobs}
        externalError={error}
        onRunSelected={selectRun}
        onCancelRun={cancelRun}
        onCancelJob={cancelJob}
        onRefreshRun={async () => {
          if (selected) await refreshRun(selected.id, true);
          else await refreshAll();
        }}
        onChanged={async () => { await refreshRuns(selectedRunId ?? undefined, true); }}
        onWorkspaceSelected={onWorkspaceSelected}
        onWorkspacesChanged={onWorkspacesChanged}
      />
    </div>
  );
}

function autoSelectableWorkspaceRun(
  runs: DesktopHarnessRunView[],
  workspaceId: string,
): DesktopHarnessRunView | null {
  return runs.find((run) => run.workspace === workspaceId
    && run.status === "running"
    && run.freshnessState === "current"
    && run.pendingApprovals === 0
    && run.uncertainMutations === 0
    && run.closedLoop.recoveryStatus !== "needed"
    && run.closedLoop.recoveryStatus !== "in-progress") ?? null;
}
