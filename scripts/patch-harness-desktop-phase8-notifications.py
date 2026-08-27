from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:160]!r}")
    file.write_text(text.replace(old, new, 1))


# Vitest must own test registration; node:test subtests execute but Vitest reports zero suites.
Path("desktop/src/main/harness-parser.test.ts").write_text(r'''import { describe, expect, it } from "vitest";

import { parseHarnessEvents, parseHarnessRunSnapshot } from "./harness-parser";

describe("Harness renderer sanitization", () => {
  it("exposes only whitelisted safe event metadata", () => {
    const events = parseHarnessEvents({
      events: [{
        seq: 1,
        event_type: "tool/result",
        payload: { tool: "workspace_exec", result_category: "success", raw_arguments: "DO_NOT_EXPOSE", output: "SECRET" },
        created_at: 10,
      }],
    });
    expect(events[0]?.summary).toMatch(/workspace_exec/);
    expect(events[0]?.summary).not.toMatch(/DO_NOT_EXPOSE|SECRET/);
  });

  it("drops principal and capability snapshots from renderer run data", () => {
    const parsed = parseHarnessRunSnapshot({
      run: { id: "run-1", workspace: "repo", profile: "interactive-local", status: "running", started_at: 1, updated_at: 2, completed_at: null, principal_id: "oauth:secret", capability_snapshot: { secret: "hidden" } },
      freshness: { state: "current", reason: null },
      recovery: { state: "resumable", reason: "ready", pending_approvals: 0, active_jobs: 0, uncertain_mutations: 0, retryable_read_executions: 0, retryable_pre_dispatch_executions: 0, blocked_pre_dispatch_executions: 0, checkpoint: null },
    });
    expect(parsed.id).toBe("run-1");
    expect("principalId" in parsed).toBe(false);
    expect("capabilitySnapshot" in parsed).toBe(false);
  });
});
''')

Path("desktop/src/main/harness-policy.test.ts").write_text(r'''import { describe, expect, it } from "vitest";

import { HARNESS_IPC } from "../shared/harness-api";
import { validateHarnessIpcInvocation } from "./harness-policy";

describe("Harness Desktop IPC policy", () => {
  it("accepts bounded run and job operations", () => {
    expect(validateHarnessIpcInvocation(HARNESS_IPC.listRuns, [{ limit: 25 }])).toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.getRun, [{ runId: "run-1" }])).toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.listEvents, [{ runId: "run-1", afterSeq: -1, limit: 200 }])).toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.cancelJob, [{ runId: "run-1", jobId: "job-1" }])).toBeNull();
  });

  it("rejects unbounded and renderer-controlled extra fields", () => {
    expect(validateHarnessIpcInvocation(HARNESS_IPC.listRuns, [{ limit: 101 }])).not.toBeNull();
    expect(validateHarnessIpcInvocation(HARNESS_IPC.cancelJob, [{ runId: "run-1", jobId: "job-1", decision: "allow" }])).not.toBeNull();
  });
});
''')

# Reuse the existing Desktop runtime-event notification channel for Harness completion.
replace_once(
    "desktop/src/shared/desktop-api.ts",
    '''  | "workspace"
  | "task";''',
    '''  | "workspace"
  | "task"
  | "harness";''',
)
replace_once(
    "desktop/src/main/background-controller.ts",
    '''      } else if (event.component === "task" && state === "completed") {
        this.notifyOnce(
          `task:${event.state}:${event.message ?? ""}`,
          "SourceNerve task completed",
          event.message ?? "A SourceNerve task completed successfully.",
        );
      }
''',
    '''      } else if (event.component === "task" && state === "completed") {
        this.notifyOnce(
          `task:${event.state}:${event.message ?? ""}`,
          "SourceNerve task completed",
          event.message ?? "A SourceNerve task completed successfully.",
        );
      } else if (event.component === "harness" && state === "completed") {
        this.notifyOnce(
          `harness:${event.state}:${event.message ?? ""}`,
          "SourceNerve Harness job completed",
          event.message ?? "A SourceNerve Harness job completed successfully.",
        );
      }
''',
)

replace_once(
    "desktop/src/main/task-manager.ts",
    '''  private readonly beginKeys = new Map<string, string>();
  private readonly completionNotificationKeys = new Set<string>();
''',
    '''  private readonly beginKeys = new Map<string, string>();
  private readonly completionNotificationKeys = new Set<string>();
  private readonly harnessJobStatuses = new Map<string, string>();
''',
)
replace_once(
    "desktop/src/main/task-manager.ts",
    '''  async listHarnessJobs(input: DesktopHarnessJobListInput): Promise<DesktopHarnessJobView[]> {
    return parseHarnessJobList(await this.options.client.harnessRequest(
      "/api/v1/harness/jobs/list",
      { run_id: input.runId, limit: input.limit ?? 50 },
    ));
  }
''',
    '''  async listHarnessJobs(input: DesktopHarnessJobListInput): Promise<DesktopHarnessJobView[]> {
    const jobs = parseHarnessJobList(await this.options.client.harnessRequest(
      "/api/v1/harness/jobs/list",
      { run_id: input.runId, limit: input.limit ?? 50 },
    ));
    this.observeHarnessJobTransitions(jobs);
    return jobs;
  }
''',
)
replace_once(
    "desktop/src/main/task-manager.ts",
    '''  private async requireManagedWorkspace(
''',
    '''  private observeHarnessJobTransitions(jobs: readonly DesktopHarnessJobView[]): void {
    for (const job of jobs) {
      const previous = this.harnessJobStatuses.get(job.id);
      if (this.harnessJobStatuses.has(job.id)) this.harnessJobStatuses.delete(job.id);
      this.harnessJobStatuses.set(job.id, job.status);
      if (previous !== undefined && previous !== "completed" && job.status === "completed") {
        this.options.onEvent?.({
          type: "state",
          component: "harness",
          state: "completed",
          message: `Harness job ${job.id} (${job.kind}) completed`,
        });
      }
    }
    while (this.harnessJobStatuses.size > MAX_COMPLETION_NOTIFICATION_KEYS) {
      const oldest = this.harnessJobStatuses.keys().next().value;
      if (!oldest) break;
      this.harnessJobStatuses.delete(oldest);
    }
  }

  private async requireManagedWorkspace(
''',
)

# Poll only the selected run while the Harness surface is mounted. Initial terminal jobs establish
# a baseline without notifying; only an observed active/pending -> completed transition emits.
replace_once(
    "desktop/src/renderer/components/HarnessScreen.tsx",
    '''  useEffect(() => { void refreshRuns(); }, []);
''',
    '''  useEffect(() => { void refreshRuns(); }, []);

  useEffect(() => {
    if (!selectedRunId) return undefined;
    const timer = window.setInterval(() => { void refreshRun(selectedRunId, true); }, 5_000);
    return () => window.clearInterval(timer);
  }, [selectedRunId]);
''',
)
replace_once(
    "desktop/src/renderer/components/HarnessScreen.tsx",
    '''  async function refreshRun(runId: string): Promise<void> {
    setBusy(`run:${runId}`);
    setError(null);
''',
    '''  async function refreshRun(runId: string, silent = false): Promise<void> {
    if (!silent) setBusy(`run:${runId}`);
    setError(null);
''',
)
replace_once(
    "desktop/src/renderer/components/HarnessScreen.tsx",
    '''    setBusy(null);
  }

  async function selectRun(runId: string): Promise<void> {
''',
    '''    if (!silent) setBusy(null);
  }

  async function selectRun(runId: string): Promise<void> {
''',
)

Path("desktop/src/main/harness-notification.test.ts").write_text(r'''import { describe, expect, it, vi } from "vitest";

import type { DesktopRuntimeEvent } from "../shared/desktop-api";
import type { SourceNerveClient } from "./sourcenerve-client";
import { DesktopTaskManager } from "./task-manager";
import type { DesktopTaskRegistry } from "./task-registry";
import type { WorkspaceManager } from "./workspace-manager";

describe("Harness job completion observation", () => {
  it("baselines historical terminal jobs and emits once on an observed completion transition", async () => {
    let status = "active";
    let updatedAt = 1;
    const harnessRequest = vi.fn(async () => ({
      jobs: [{
        id: "job-1",
        run_id: "run-1",
        workspace: "repo",
        kind: "task",
        task_id: "task-1",
        status,
        created_at: 1,
        updated_at: updatedAt,
      }],
    }));
    const events: DesktopRuntimeEvent[] = [];
    const manager = new DesktopTaskManager({
      client: { harnessRequest } as unknown as SourceNerveClient,
      workspaceManager: {} as WorkspaceManager,
      registry: {} as DesktopTaskRegistry,
      onEvent: (event) => events.push(event),
    });

    await manager.listHarnessJobs({ runId: "run-1" });
    expect(events).toHaveLength(0);

    status = "completed";
    updatedAt = 2;
    await manager.listHarnessJobs({ runId: "run-1" });
    await manager.listHarnessJobs({ runId: "run-1" });

    const completionEvents = events.filter(
      (event) => event.type === "state" && event.component === "harness" && event.state === "completed",
    );
    expect(completionEvents).toHaveLength(1);
    expect(completionEvents[0]?.type === "state" ? completionEvents[0].message : "").toContain("job-1");
  });

  it("does not notify for a job first observed after it already completed", async () => {
    const managerEvents: DesktopRuntimeEvent[] = [];
    const manager = new DesktopTaskManager({
      client: {
        harnessRequest: vi.fn(async () => ({
          jobs: [{ id: "job-old", run_id: "run-1", workspace: "repo", kind: "task", task_id: null, status: "completed", created_at: 1, updated_at: 2 }],
        })),
      } as unknown as SourceNerveClient,
      workspaceManager: {} as WorkspaceManager,
      registry: {} as DesktopTaskRegistry,
      onEvent: (event) => managerEvents.push(event),
    });

    await manager.listHarnessJobs({ runId: "run-1" });
    expect(managerEvents).toHaveLength(0);
  });
});
''')
