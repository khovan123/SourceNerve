import { describe, expect, it } from "vitest";

import { userVisibleChatGptProgressText } from "./chatgpt-stream-progress";

describe("ChatGPT stream progress", () => {
  it("streams only the public ANSWER field and hides control/reasoning metadata", () => {
    const raw = [
      "[C2C]",
      "STATE: DONE",
      "TASK_ID: sn_123",
      "ITERATION: 0",
      "",
      "ANSWER:",
      "Found the CI failure in the lint workflow.",
      "The next step is to update the config and rerun tests.",
      "",
      "PROOF: internal-control-data",
    ].join("\n");

    const visible = userVisibleChatGptProgressText(raw);

    expect(visible).toContain("Found the CI failure");
    expect(visible).toContain("update the config");
    expect(visible).not.toContain("TASK_ID");
    expect(visible).not.toContain("PROOF:");
    expect(visible).not.toContain("[C2C]");
  });

  it("streams ordinary user-visible assistant prose between tool calls", () => {
    expect(userVisibleChatGptProgressText("I found the issue. I am updating the regression tests now.")).toBe(
      "I found the issue. I am updating the regression tests now.",
    );
  });

  it("does not fall back to raw C2C transport metadata", () => {
    expect(userVisibleChatGptProgressText("[C2C]\nSTATE: DONE\nTASK_ID: sn_123\nITERATION: 0")).toBe("");
  });

  it("streams public PLAN and BLOCKED sections without exposing control metadata", () => {
    const plan = userVisibleChatGptProgressText([
      "[C2C]",
      "STATE: PLAN",
      "TASK_ID: sn_123",
      "ITERATION: 1",
      "",
      "PLAN:",
      "Inspect the auth flow, then run focused tests.",
      "",
      "PROOF:",
      "internal-proof",
    ].join("\n"));
    const blocked = userVisibleChatGptProgressText([
      "[C2C]",
      "STATE: BLOCKED",
      "TASK_ID: sn_123",
      "ITERATION: 0",
      "",
      "REASON:",
      "Repository evidence is incomplete.",
      "",
      "NEEDS:",
      "A confirmed fixture.",
    ].join("\n"));

    expect(plan).toBe("Inspect the auth flow, then run focused tests.");
    expect(plan).not.toContain("TASK_ID");
    expect(plan).not.toContain("PROOF");
    expect(blocked).toBe("Repository evidence is incomplete.");
    expect(blocked).not.toContain("NEEDS:");
  });

  it("suppresses ChatGPT transport interruption banners", () => {
    expect(userVisibleChatGptProgressText("Connection interrupted. Waiting for the complete answer")).toBe("");
    expect(userVisibleChatGptProgressText("\nConnection interrupted. Waiting for complete answer.\n")).toBe("");
  });
});
