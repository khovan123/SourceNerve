import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => {
    vi.useRealTimers();
  });

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



  it("times out stalled ChatGPT planning and cancels the active review task", async () => {
    vi.useFakeTimers();
    const cancelled: string[] = [];
    const driver: ChatGptReviewDriver = {
      begin: async () => new Promise<string>(() => undefined),
      review: async () => { throw new Error("review must not run"); },
      cancel: (taskId) => { cancelled.push(taskId); },
    };
    const loop = new ChatGptReviewLoop({
      driver,
      execute: async () => { throw new Error("execute must not run"); },
    });

    const result = loop.run({ runId: "run-1", workspace: "workspace-a", prompt: "Plan should not hang forever" });
    const expectedRejection = expect(result).rejects.toThrow("ChatGPT planning timed out after 3 minutes");
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    await expectedRejection;
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatch(/^sn_[a-f0-9]{16}$/);
  });

  it("ignores stale quoted C2C blocks and accepts the active task control block", () => {
    const current = parseChatGptReviewControlMessage(
      [
        "ChatGPT repeated an older block before the real answer:",
        "[C2C]",
        "STATE: PLAN",
        "TASK_ID: sn_deadbeefdeadbeef",
        "ITERATION: 1",
        "",
        "PLAN:",
        "old task",
        "",
        "Actual control block:",
        "[C2C]",
        "STATE: PLAN",
        "TASK_ID: sn_0123456789abcdef",
        "ITERATION: 1",
        "",
        "PLAN:",
        "current task",
      ].join("\n"),
      { taskId: "sn_0123456789abcdef", iterations: { PLAN: 1 } },
    );

    expect(current.taskId).toBe("sn_0123456789abcdef");
    expect(current.text).toContain("current task");
    expect(current.text).not.toContain("old task");
  });

  it("reports stale ChatGPT task replies as ignored instead of accepting them", () => {
    expect(() => parseChatGptReviewControlMessage(
      "[C2C]\nSTATE: PLAN\nTASK_ID: sn_deadbeefdeadbeef\nITERATION: 1\n\nPLAN:\nstale",
      { taskId: "sn_0123456789abcdef", iterations: { PLAN: 1 } },
    )).toThrow("stale or different task response was ignored");
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
