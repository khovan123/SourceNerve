import { describe, expect, it } from "vitest";

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
