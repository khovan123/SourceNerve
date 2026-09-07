import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROUTE,
  MAIN_NAVIGATION,
  NAVIGATION,
  isMainRoute,
  navigationItem,
  routeFromHash,
  routeHash,
  settingsSectionForRoute,
} from "./navigation";

describe("Desktop navigation", () => {
  it("parses known hash routes", () => {
    expect(routeFromHash("#/workspaces")).toBe("harness");
    expect(routeFromHash("#connections")).toBe("connections");
  });

  it("falls back to Harness for unknown and removed routes", () => {
    expect(routeFromHash("#/does-not-exist")).toBe(DEFAULT_ROUTE);
    expect(routeFromHash("#/tasks")).toBe(DEFAULT_ROUTE);
    expect(routeFromHash("#/overview")).toBe("harness");
    expect(routeFromHash("#/diagnostics")).toBe(DEFAULT_ROUTE);
    expect(routeFromHash("")).toBe(DEFAULT_ROUTE);
  });

  it("generates stable route hashes", () => {
    expect(routeHash("harness")).toBe("#/harness");
    expect(routeHash("settings")).toBe("#/settings");
  });

  it("keeps the primary sidebar focused on work surfaces", () => {
    expect(MAIN_NAVIGATION.map((item) => item.id)).toEqual([
      "harness",
      "pull-requests",
    ]);
    expect(isMainRoute("harness")).toBe(true);
    expect(isMainRoute("connections")).toBe(false);
  });

  it("maps configuration deep links into settings sections", () => {
    expect(settingsSectionForRoute("settings")).toBe("general");
    expect(settingsSectionForRoute("connections")).toBe("connections");
    expect(settingsSectionForRoute("mcp")).toBe("mcp");
    expect(settingsSectionForRoute("plugins")).toBe("plugins");
    expect(settingsSectionForRoute("harness")).toBeNull();
  });

  it("defines unique navigation entries", () => {
    expect(new Set(NAVIGATION.map((item) => item.id)).size).toBe(
      NAVIGATION.length,
    );
    expect(navigationItem("pull-requests").label).toBe("Pull Requests");
  });
});
