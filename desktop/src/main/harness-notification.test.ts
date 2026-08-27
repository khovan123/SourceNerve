import { describe, expect, it, vi } from "vitest";

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
