import { describe, expect, it } from "vitest";

import {
  ownedAssistantResponseCandidate,
  snapshotOwnsSubmittedUserTurn,
  type ChatGptConversationSnapshot,
} from "./chatgpt-review-response-ownership";

function snapshot(overrides: Partial<ChatGptConversationSnapshot> = {}): ChatGptConversationSnapshot {
  return {
    count: 1,
    text: "[C2C]\nSTATE: DONE\nTASK_ID: sn_oldoldoldoldold1\nITERATION: 0",
    generating: false,
    turnIds: ["assistant-old"],
    latestTurnId: "assistant-old",
    userCount: 1,
    userTurnIds: ["user-old"],
    latestUserTurnId: "user-old",
    latestUserText: "[C2C]\nSTATE: INIT\nTASK_ID: sn_oldoldoldoldold1\nITERATION: 0",
    assistantAfterLatestUser: true,
    interrupted: false,
    ...overrides,
  };
}

describe("ChatGPT review response ownership", () => {
  const taskId = "sn_0123456789abcdef";
  const submitted = [
    "[C2C]",
    "STATE: EXECUTED",
    `TASK_ID: ${taskId}`,
    "ITERATION: 2",
    "",
    "HARNESS_VERIFICATION:",
    "passed",
  ].join("\n");

  it("binds ownership to the newly submitted task/state/iteration user turn", () => {
    const before = snapshot();
    const current = snapshot({
      userCount: 2,
      userTurnIds: ["user-old", "user-current"],
      latestUserTurnId: "user-current",
      latestUserText: submitted,
      assistantAfterLatestUser: false,
    });

    expect(snapshotOwnsSubmittedUserTurn(before, current, submitted, taskId)).toBe(true);
  });

  it("does not bind an older task or older iteration as the submitted user turn", () => {
    const before = snapshot();
    const otherTask = snapshot({
      userCount: 2,
      userTurnIds: ["user-old", "user-current"],
      latestUserTurnId: "user-current",
      latestUserText: submitted.replace(taskId, "sn_deadbeefdeadbeef"),
    });
    const oldIteration = snapshot({
      userCount: 2,
      userTurnIds: ["user-old", "user-current"],
      latestUserTurnId: "user-current",
      latestUserText: submitted.replace("ITERATION: 2", "ITERATION: 1"),
    });

    expect(snapshotOwnsSubmittedUserTurn(before, otherTask, submitted, taskId)).toBe(false);
    expect(snapshotOwnsSubmittedUserTurn(before, oldIteration, submitted, taskId)).toBe(false);
  });

  it("rejects changed stale assistant text until the submitted user turn owns the timeline", () => {
    const before = snapshot();
    const staleMutation = snapshot({
      text: "[C2C]\nSTATE: DONE\nTASK_ID: sn_deadbeefdeadbeef\nITERATION: 0\n\nold response changed",
    });

    expect(ownedAssistantResponseCandidate({
      before,
      snapshot: staleMutation,
      accepted: true,
      acceptedOwnedUserTurn: false,
    })).toBe(false);
  });

  it("accepts a reused assistant node only when it is after the owned submitted user turn", () => {
    const before = snapshot();
    const current = snapshot({
      text: `[C2C]\nSTATE: DONE\nTASK_ID: ${taskId}\nITERATION: 2`,
      userCount: 2,
      userTurnIds: ["user-old", "user-current"],
      latestUserTurnId: "user-current",
      latestUserText: submitted,
      assistantAfterLatestUser: true,
    });

    expect(ownedAssistantResponseCandidate({
      before,
      snapshot: current,
      accepted: true,
      acceptedOwnedUserTurn: true,
    })).toBe(true);
  });

  it("falls back only to a strong new assistant identity when user-turn metadata is unavailable", () => {
    const before = snapshot();
    const newAssistant = snapshot({
      count: 2,
      turnIds: ["assistant-old", "assistant-new"],
      latestTurnId: "assistant-new",
      text: `[C2C]\nSTATE: DONE\nTASK_ID: ${taskId}\nITERATION: 2`,
      userCount: 0,
      userTurnIds: [],
      latestUserTurnId: "",
      latestUserText: "",
      assistantAfterLatestUser: false,
    });

    expect(ownedAssistantResponseCandidate({
      before,
      snapshot: newAssistant,
      accepted: true,
      acceptedOwnedUserTurn: false,
    })).toBe(true);
  });

  it("never accepts an interrupted response", () => {
    const before = snapshot();
    const interrupted = snapshot({
      count: 2,
      turnIds: ["assistant-old", "assistant-new"],
      latestTurnId: "assistant-new",
      interrupted: true,
    });

    expect(ownedAssistantResponseCandidate({
      before,
      snapshot: interrupted,
      accepted: true,
      acceptedOwnedUserTurn: false,
    })).toBe(false);
  });
});
