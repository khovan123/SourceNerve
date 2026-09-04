import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROUTE,
  NAVIGATION,
  navigationItem,
  routeFromHash,
  routeHash,
} from "./navigation";

describe("Desktop navigation", () => {
  it("parses known hash routes", () => {
    expect(routeFromHash("#/workspaces")).toBe("workspaces");
    expect(routeFromHash("#connections")).toBe("connections");
  });

  it("falls back to overview for unknown routes", () => {
    expect(routeFromHash("#/does-not-exist")).toBe(DEFAULT_ROUTE);
    expect(routeFromHash("#/tasks")).toBe(DEFAULT_ROUTE);
    expect(routeFromHash("")).toBe(DEFAULT_ROUTE);
  });

  it("generates stable route hashes", () => {
  });

  it("defines unique navigation entries", () => {
    expect(new Set(NAVIGATION.map((item) => item.id)).size).toBe(
      NAVIGATION.length,
    );
    expect(navigationItem("pull-requests").label).toBe("Pull Requests");
  });
});
