import { describe, expect, it } from "vitest";

import { parseHarnessContextRoute, parseHarnessEvents, parseHarnessRunSnapshot } from "./harness-parser";

describe("Harness renderer sanitization", () => {
  it("parses deterministic context routes and rejects unknown retrieval surfaces", () => {
    const routed = parseHarnessContextRoute({
      workspace: "repo",
      retrieve: true,
      route: "symbol-graph",
      search_query: "find callers of begin",
      reason: "query asks about code symbols or relationships",
      surfaces: ["symbol_search", "symbol_context", "references"],
    });
    expect(routed.route).toBe("symbol-graph");
    expect(routed.surfaces).toEqual(["symbol_search", "symbol_context", "references"]);
    expect(() => parseHarnessContextRoute({
      workspace: "repo", retrieve: true, route: "mixed", search_query: "x", reason: "bounded", surfaces: ["shell_anything"],
    })).toThrow(/context surface/i);
  });

  it("exposes only whitelisted safe event metadata", () => {
    const events = parseHarnessEvents({
      events: [{
        seq: 1,
        event_type: "context/gate",
        payload: { tool: "workspace_exec", parent_run_id: "parent-1", result_category: "success", route: "symbol-graph", retrieve: true, query_bytes: 21, query_sha256: "DO_NOT_EXPOSE_HASH", raw_arguments: "DO_NOT_EXPOSE", output: "SECRET" },
        created_at: 10,
      }],
    });
    expect(events[0]?.summary).toMatch(/workspace_exec/);
    expect(events[0]?.summary).toMatch(/parent-1/);
    expect(events[0]?.summary).not.toMatch(/DO_NOT_EXPOSE|SECRET/);
    expect(events[0]?.summary).toMatch(/symbol-graph/);
    expect(events[0]?.summary).toMatch(/retrieve=true/);
    expect(events[0]?.summary).toMatch(/query_bytes=21/);
  });

  it("drops principal and capability snapshots while exposing bounded parent-child metadata", () => {
    const parsed = parseHarnessRunSnapshot({
      run: {
        id: "run-1",
        workspace: "repo",
        profile: "interactive-local",
        origin: "automatic",
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
      closed_loop: { phase: "recover", work_shape: "invariant", work_scope: "src/harness_tool_pipeline.rs", context_reads: 4, executions: 2, verification_required: true, verification_status: "failed", recovery_status: "needed", selected_proof_type: "integration", selected_proof_source: "src/harness_integration_tests.rs", selected_proof_command: "cargo test harness_integration_tests", satisfied_proofs: ["focused-test"], failure_count: 1, learning_count: 0, last_failure_tool: "workspace_exec", last_failure_category: "tool-error", learning_hints: [{ tool: "workspace_exec", error_category: "tool-error", failures: 2, recoveries: 1, confirmations: 2, state: "fresh-run-validated", suggestion: "Inspect the failed result, adjust workspace state or inputs, then verify again." }] },
      repository_context: { entrypoints: ["AGENTS.md", "README.md"], guidance: ["docs/WORKFLOW.md"], active_plans: ["docs/plans/active/harness.md"], validation_owners: ["Cargo.toml", ".github/workflows/ci.yml"], proof_candidates: [{ proof_type: "integration", source: "src/harness_integration_tests.rs", cwd: null, command: "cargo test harness_integration_tests", reason: "Integration test module is owned by the repository" }, { proof_type: "e2e", source: "desktop/package.json", cwd: "desktop", command: "npm run test:e2e", reason: "Desktop E2E script" }], truncated: false },
      children: [{ id: "child-1", profile: "read-only-analysis", status: "completed", parent_run_id: "run-1", started_at: 3, updated_at: 4, completed_at: 5, principal_id: "must-not-cross" }],
      children_truncated: false,
    });
    expect(parsed.id).toBe("run-1");
    expect(parsed.actor).toBe("external-agent");
    expect(parsed.parentRunId).toBe("parent-1");
    expect(parsed.origin).toBe("automatic");
    expect(parsed.sandbox).toBe("danger-full-access");
    expect(parsed.policies.git).toBe("ask");
    expect(parsed.policies.exec).toBe("ask");
    expect(parsed.closedLoop.phase).toBe("recover");
    expect(parsed.closedLoop.workShape).toBe("invariant");
    expect(parsed.closedLoop.workScope).toBe("src/harness_tool_pipeline.rs");
    expect(parsed.closedLoop.selectedProofType).toBe("integration");
    expect(parsed.closedLoop.selectedProofSource).toBe("src/harness_integration_tests.rs");
    expect(parsed.closedLoop.satisfiedProofs).toEqual(["focused-test"]);
    expect(parsed.closedLoop.verificationRequired).toBe(true);
    expect(parsed.closedLoop.learningHints[0]?.recoveries).toBe(1);
    expect(parsed.closedLoop.learningHints[0]?.confirmations).toBe(2);
    expect(parsed.closedLoop.learningHints[0]?.state).toBe("fresh-run-validated");
    expect(parsed.repositoryContext.entrypoints).toEqual(["AGENTS.md", "README.md"]);
    expect(parsed.repositoryContext.validationOwners).toContain("Cargo.toml");
    expect(parsed.repositoryContext.proofCandidates[0]).toMatchObject({ proofType: "integration", source: "src/harness_integration_tests.rs", command: "cargo test harness_integration_tests" });
    expect(parsed.children).toEqual([{ id: "child-1", profile: "read-only-analysis", status: "completed", parentRunId: "run-1", startedAt: 3, updatedAt: 4, completedAt: 5 }]);
    expect("principalId" in parsed).toBe(false);
    expect("capabilitySnapshot" in parsed).toBe(false);
    expect("principalId" in parsed.children[0]!).toBe(false);
  });
});
