import { describe, expect, it } from "vitest";

import { allowedStateStrategies } from "./migration-manager";

describe("legacy state migration strategy", () => {
  it("allows copy, move, reference and fresh only for compatible state", () => {
    expect(allowedStateStrategies("compatible")).toEqual([
      "copy",
      "move",
      "reference",
      "fresh",
    ]);
  });

  it("prevents copy and move when legacy state is already the Desktop state directory", () => {
    expect(allowedStateStrategies("compatible", true)).toEqual([
      "reference",
      "fresh",
    ]);
  });

  it("forces fresh state for future, unknown, invalid or missing state", () => {
    for (const status of ["future", "unknown", "invalid", "missing"] as const) {
      expect(allowedStateStrategies(status)).toEqual(["fresh"]);
    }
  });
});
