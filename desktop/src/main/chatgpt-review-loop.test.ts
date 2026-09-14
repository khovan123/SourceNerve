import { describe, expect, it } from "vitest";

import { ChatGptReviewLoop, parseChatGptReviewControlMessage, type ChatGptReviewDriver } from "./chatgpt-review-loop";

function turn(iteration: number) {
  return {
    runId: "run-1",
    workspace: "workspace-a",
    threadId: "thread-1",
    turnId: `turn-${iteration}`,
    status: "completed" as const,
    response: `executed ${iteration}`,
    resumed: iteration > 1,
    recoveredBeforeTurn: false,
    activeSkills: [],
  };
}

describe("ChatGptReviewLoop", () => {
  it("runs PLAN -> verified Codex execution -> DONE", async () => {
    const executions: string[] = [];
    const driver: ChatGptReviewDriver = {
      begin: async ({ taskId }) => `[C2C]\nSTATE: PLAN\nTASK_ID: ${taskId}\nITERATION: 1\n\nPLAN:\nChange the bounded target and run tests.`,
      review: async ({ taskId, iteration }) => `[C2C]\nSTATE: DONE\nTASK_ID: ${taskId}\nITERATION: ${iteration}\n\nREVIEW:\nThe diff and Harness proof satisfy the goal.`,
    };
    const loop = new ChatGptReviewLoop({
      driver,
      execute: async ({ prompt }) => {
        executions.push(prompt);
        return { turn: turn(executions.length), verification: { success: true, proofType: "focused-test" } };
      },
    });

    const result = await loop.run({ runId: "run-1", workspace: "workspace-a", prompt: "Fix the bug" });

    expect(result.state).toBe("done");
    expect(result.iterations).toBe(1);
    expect(result.turn?.turnId).toBe("turn-1");
    expect(executions).toHaveLength(1);
    expect(executions[0]).toContain("USER GOAL:\nFix the bug");
    expect(executions[0]).toContain("STATE: PLAN");
  });

  it("accepts a corrective PLAN for the next iteration and reuses the same Codex thread run", async () => {
    let reviews = 0;
    const driver: ChatGptReviewDriver = {
      begin: async ({ taskId }) => `[C2C]\nSTATE: PLAN\nTASK_ID: ${taskId}\nITERATION: 1\n\nPLAN:\nFirst pass.`,
      review: async ({ taskId, iteration }) => {
        reviews += 1;
        return reviews === 1
          ? `[C2C]\nSTATE: PLAN\nTASK_ID: ${taskId}\nITERATION: ${iteration + 1}\n\nPLAN:\nCorrect the remaining issue.`
          : `[C2C]\nSTATE: DONE\nTASK_ID: ${taskId}\nITERATION: ${iteration}\n\nREVIEW:\nComplete.`;
      },
    };
    const executedRunIds: string[] = [];
    const loop = new ChatGptReviewLoop({
      driver,
      execute: async ({ runId }) => {
        executedRunIds.push(runId);
        return { turn: turn(executedRunIds.length), verification: { success: true } };
      },
    });

    const result = await loop.run({ runId: "run-1", workspace: "workspace-a", prompt: "Implement it", maxIterations: 4 });

    expect(result.state).toBe("done");
    expect(result.iterations).toBe(2);
    expect(executedRunIds).toEqual(["run-1", "run-1"]);
  });

  it("fails closed when Harness verification is not successful", async () => {
    const driver: ChatGptReviewDriver = {
      begin: async ({ taskId }) => `[C2C]\nSTATE: PLAN\nTASK_ID: ${taskId}\nITERATION: 1\n\nPLAN:\nExecute.`,
      review: async () => { throw new Error("review must not run"); },
    };
    const loop = new ChatGptReviewLoop({
      driver,
      execute: async () => ({ turn: turn(1), verification: { success: false } }),
    });

    await expect(loop.run({ runId: "run-1", workspace: "workspace-a", prompt: "Implement it" }))
      .rejects.toThrow("unverified Codex execution");
  });

  it("binds control messages to exact task and iteration", () => {
    expect(() => parseChatGptReviewControlMessage(
      "[C2C]\nSTATE: PLAN\nTASK_ID: other\nITERATION: 2\nPLAN: nope",
      { taskId: "sn_0123456789abcdef", iterations: { PLAN: 2 } },
    )).toThrow("task id");

    expect(() => parseChatGptReviewControlMessage(
      "[C2C]\nSTATE: PLAN\nTASK_ID: sn_0123456789abcdef\nITERATION: 1\nPLAN: stale",
      { taskId: "sn_0123456789abcdef", iterations: { PLAN: 2 } },
    )).toThrow("iteration");
  });
});
