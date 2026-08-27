import { describe, expect, it } from "vitest";

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
