import { describe, expect, it } from "vitest";

import type { RuntimeLogEntry } from "../shared/desktop-api";
import {
  deriveReadinessView,
  filterRuntimeLogs,
  mergeRuntimeLogEntries,
  nestedString,
} from "./overview";

function log(
  sequence: number,
  component: RuntimeLogEntry["component"],
  level: RuntimeLogEntry["level"],
  message: string,
): RuntimeLogEntry {
  return {
    sequence,
    component,
    level,
    message,
    timestamp: new Date(1_700_000_000_000 + sequence).toISOString(),
  };
}

describe("Overview helpers", () => {
  it("merges a snapshot with racing live events without duplicate sequences", () => {
    const merged = mergeRuntimeLogEntries(
      [log(3, "daemon", "info", "live-three"), log(4, "auth", "warn", "live-four")],
      [log(1, "desktop", "info", "one"), log(2, "daemon", "info", "two"), log(3, "daemon", "info", "snapshot-three")],
      100,
    );

    expect(merged.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
    expect(merged.find((entry) => entry.sequence === 3)?.message).toBe("snapshot-three");
  });

  it("keeps only the newest bounded entries", () => {
    const merged = mergeRuntimeLogEntries(
      [],
      Array.from({ length: 10 }, (_, index) => log(index + 1, "desktop", "debug", `line-${index + 1}`)),
      4,
    );
    expect(merged.map((entry) => entry.sequence)).toEqual([7, 8, 9, 10]);
  });

  it("filters by level, component, and case-insensitive search", () => {
    const entries = [
      log(1, "daemon", "error", "Readiness timeout"),
      log(2, "auth", "warn", "Session expired"),
      log(3, "daemon", "info", "Runtime ready"),
    ];

    expect(
      filterRuntimeLogs(entries, {
        level: "error",
        component: "daemon",
        query: "TIMEOUT",
      }).map((entry) => entry.sequence),
    ).toEqual([1]);
    expect(
      filterRuntimeLogs(entries, {
        level: "all",
        component: "all",
        query: "session",
      }).map((entry) => entry.sequence),
    ).toEqual([2]);
  });

  it("derives local readiness without pretending a stopped daemon is healthy", () => {
    expect(
      deriveReadinessView({ state: "stopped", managed: true }, { ready: true }),
    ).toEqual({
      ready: false,
      label: "Unavailable",
      reason: "Daemon is stopped",
    });

    expect(
      deriveReadinessView({ state: "ready", managed: true }, { ready: true }),
    ).toEqual({
      ready: true,
      label: "Ready",
      reason: "Local SourceNerve runtime is ready",
    });
  });

  it("uses bounded readiness reasons and safe nested identity lookup", () => {
    const blocked = deriveReadinessView(
      { state: "ready", managed: true },
      {
        ready: false,
        workspaces: [{ id: "api", ready: false, reason: "index stale" }],
      },
    );
    expect(blocked.reason).toBe("api: index stale");
    expect(nestedString({ identity: { build_commit: "abc123" } }, ["identity", "build_commit"])).toBe("abc123");
  });
});
