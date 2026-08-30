import { describe, expect, it } from "vitest";

import { runAgentGraph } from "./agent-graph";

describe("agent graph", () => {
  it("runs deterministic parallel waves and routes from merged state", async () => {
    type State = { query: string; sourceA?: string; sourceB?: string; decision?: string };
    const events: string[] = [];
    const result = await runAgentGraph<State>({
      initialState: { query: "Harness" },
      definition: {
        start: ["read-a", "read-b"],
        nodes: [
          { id: "read-a", run: async () => ({ sourceA: "A" }) },
          { id: "read-b", run: async () => ({ sourceB: "B" }) },
          { id: "decide", run: async (state) => ({ decision: `${state.sourceA}${state.sourceB}` }) },
        ],
        routes: {
          "read-a": (state) => state.sourceA && state.sourceB ? ["decide"] : [],
          "read-b": (state) => state.sourceA && state.sourceB ? ["decide"] : [],
        },
      },
      onEvent: (event) => { events.push(event.type); },
    });
    expect(result.state.decision).toBe("AB");
    expect(result.steps).toBe(3);
    expect(result.visits).toEqual({ "read-a": 1, "read-b": 1, decide: 1 });
    expect(events[0]).toBe("graph/start");
    expect(events.at(-1)).toBe("graph/end");
  });

  it("rejects parallel nodes that write the same state key", async () => {
    await expect(runAgentGraph({
      initialState: {},
      definition: {
        start: ["a", "b"],
        nodes: [
          { id: "a", run: async () => ({ shared: "a" }) },
          { id: "b", run: async () => ({ shared: "b" }) },
        ],
      },
    })).rejects.toThrow(/parallel state collision/i);
  });

  it("enforces maxVisits and maxSteps instead of allowing unbounded cycles", async () => {
    await expect(runAgentGraph({
      initialState: { count: 0 },
      definition: {
        start: ["loop"],
        maxSteps: 4,
        nodes: [{ id: "loop", maxVisits: 2, run: async (state) => ({ count: Number(state.count) + 1 }) }],
        routes: { loop: () => ["loop"] },
      },
    })).rejects.toThrow(/maxVisits/i);
  });
});
