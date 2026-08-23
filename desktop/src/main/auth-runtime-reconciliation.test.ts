import { describe, expect, it, vi } from "vitest";

import { reconcileRuntimeWithoutBlockingAuth } from "./auth-runtime-reconciliation";

describe("reconcileRuntimeWithoutBlockingAuth", () => {
  it("returns true when local runtime reconciliation succeeds", async () => {
    const onDeferred = vi.fn();

    await expect(
      reconcileRuntimeWithoutBlockingAuth({
        operation: async () => undefined,
        onDeferred,
        label: "startup workspace reconciliation deferred",
      }),
    ).resolves.toBe(true);

    expect(onDeferred).not.toHaveBeenCalled();
  });

  it("keeps auth flow successful when daemon reconciliation fails", async () => {
    const onDeferred = vi.fn();

    await expect(
      reconcileRuntimeWithoutBlockingAuth({
        operation: async () => {
          throw new Error("SourceNerve readiness timeout: fetch failed");
        },
        onDeferred,
        label: "startup workspace reconciliation deferred",
      }),
    ).resolves.toBe(false);

    expect(onDeferred).toHaveBeenCalledWith(
      "startup workspace reconciliation deferred: SourceNerve readiness timeout: fetch failed",
    );
  });
});
