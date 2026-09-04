import { describe, expect, it } from "vitest";

import { activityErrorPresentation } from "./McpExtensionActivityPanel";

describe("MCP activity error presentation", () => {
  it("explains fail-closed activity and preserves the previous failure", () => {
    expect(activityErrorPresentation("runtime-fail-closed:connection")).toEqual({
      category: "runtime-fail-closed",
      previousFailure: "connection",
      guidance: "Extension stopped after repeated failures. Restart or re-enable it before retrying.",
    });
  });

  it("explains auto-recovering circuit-open activity", () => {
    expect(activityErrorPresentation("runtime-circuit-open:connection")).toEqual({
      category: "runtime-circuit-open",
      previousFailure: "connection",
      guidance:
        "Transport circuit is cooling down. SourceNerve will automatically run one recovery probe on the next call after the cooldown.",
    });
  });

  it("keeps ordinary downstream categories unchanged", () => {
    expect(activityErrorPresentation("downstream-tool-error")).toEqual({
      category: "downstream-tool-error",
    });
  });

  it("hides the error block when the call succeeded", () => {
    expect(activityErrorPresentation()).toBeNull();
  });
});
