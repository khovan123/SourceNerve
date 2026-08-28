import { describe, expect, it } from "vitest";

import { parseHarnessEvents, parseHarnessRunSnapshot } from "./harness-parser";

describe("Harness renderer sanitization", () => {
  it("exposes only whitelisted safe event metadata", () => {
    const events = parseHarnessEvents({
      events: [{
        seq: 1,
        event_type: "run/started",
        payload: { tool: "workspace_exec", parent_run_id: "parent-1", result_category: "success", raw_arguments: "DO_NOT_EXPOSE", output: "SECRET" },
        created_at: 10,
      }],
    });
    expect(events[0]?.summary).toMatch(/workspace_exec/);
    expect(events[0]?.summary).toMatch(/parent-1/);
    expect(events[0]?.summary).not.toMatch(/DO_NOT_EXPOSE|SECRET/);
  });

  it("drops principal and capability snapshots while exposing bounded parent-child metadata", () => {
    const parsed = parseHarnessRunSnapshot({
      run: {
        id: "run-1",
        workspace: "repo",
        profile: "interactive-local",
        status: "running",
        parent_run_id: "parent-1",
        started_at: 1,
        updated_at: 2,
        completed_at: null,
        principal_id: "oauth:secret",
        capability_snapshot: {
          profile: {
            name: "interactive-local",
            description: "Interactive local work",
            sandbox: "danger-full-access",
            policies: { read: "allow", write: "allow", exec: "allow", git: "ask", provider: "ask", job: "allow" },
          },
          secret: "hidden",
        },
      },
      freshness: { state: "current", reason: null },
      recovery: { state: "resumable", reason: "ready", pending_approvals: 0, active_jobs: 0, uncertain_mutations: 0, retryable_read_executions: 0, retryable_pre_dispatch_executions: 0, blocked_pre_dispatch_executions: 0, checkpoint: null },
      children: [{ id: "child-1", profile: "read-only-analysis", status: "completed", parent_run_id: "run-1", started_at: 3, updated_at: 4, completed_at: 5, principal_id: "must-not-cross" }],
      children_truncated: false,
    });
    expect(parsed.id).toBe("run-1");
    expect(parsed.parentRunId).toBe("parent-1");
    expect(parsed.sandbox).toBe("danger-full-access");
    expect(parsed.policies.git).toBe("ask");
    expect(parsed.policies.exec).toBe("ask");
    expect(parsed.children).toEqual([{ id: "child-1", profile: "read-only-analysis", status: "completed", parentRunId: "run-1", startedAt: 3, updatedAt: 4, completedAt: 5 }]);
    expect("principalId" in parsed).toBe(false);
    expect("capabilitySnapshot" in parsed).toBe(false);
    expect("principalId" in parsed.children[0]!).toBe(false);
  });
});
