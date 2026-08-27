import { useEffect, useRef } from "react";

const HARNESS_JOB_POLL_MS = 10_000;
const MAX_MONITORED_RUNS = 50;
const MAX_MONITORED_JOBS = 50;

export function HarnessJobMonitor() {
  const activeRunIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    let disposed = false;
    let polling = false;

    async function poll(): Promise<void> {
      if (disposed || polling) return;
      polling = true;
      try {
        const runResult = await window.sourcenerveDesktop.listHarnessRuns({ limit: MAX_MONITORED_RUNS });
        if (!runResult.ok || disposed) return;

        const candidates = new Set<string>(activeRunIds.current);
        for (const run of runResult.value) {
          if (run.activeJobs > 0) candidates.add(run.id);
        }

        const nextActiveRunIds = new Set<string>();
        for (const runId of candidates) {
          if (disposed) return;
          const jobResult = await window.sourcenerveDesktop.listHarnessJobs({
            runId,
            limit: MAX_MONITORED_JOBS,
          });
          if (!jobResult.ok) {
            if (activeRunIds.current.has(runId)) nextActiveRunIds.add(runId);
            continue;
          }
          if (jobResult.value.some((job) => job.status === "active" || job.status === "pending")) {
            nextActiveRunIds.add(runId);
          }
        }

        if (!disposed) activeRunIds.current = nextActiveRunIds;
      } finally {
        polling = false;
      }
    }

    void poll();
    const timer = window.setInterval(() => void poll(), HARNESS_JOB_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
