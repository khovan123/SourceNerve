import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const sourceUrl = new URL("./chatgpt-review-web-driver.ts", import.meta.url);

describe("ChatGPT review web driver security contract", () => {
  it("keeps remote ChatGPT content outside the privileged Desktop preload boundary", async () => {
    const source = await readFile(sourceUrl, "utf8");

    expect(source).toContain('const REVIEW_PARTITION = "persist:sourcenerve-chatgpt-review"');
    expect(source).toContain("nodeIntegration: false");
    expect(source).toContain("contextIsolation: true");
    expect(source).toContain("sandbox: true");
    expect(source).toContain("webSecurity: true");
    expect(source).toContain("setPermissionRequestHandler");
    expect(source).toContain("setPermissionCheckHandler");
    expect(source).not.toMatch(/\bpreload\s*:/);
  });

  it("requires MCP-grounded planning and independent diff review", async () => {
    const source = await readFile(sourceUrl, "utf8");

    expect(source).toContain("workspace_list and repo_snapshot");
    expect(source).toContain("git_diff (or git_review)");
    expect(source).toContain("harness_run_get / harness_run_events");
    expect(source).toContain("Do not accept the EXECUTED message itself as proof");
    expect(source).toContain("include an ANSWER: field with the normal user-facing assistant reply");
    expect(source).toContain("Do not put connector, workspace-verification, harness-run, or no-implementation-cycle prose in ANSWER");
    expect(source).toContain("HARNESS_RUN_ID is a Desktop correlation id only in direct ChatGPT mode");
    expect(source).toContain("do not call harness_run_get as a startup precondition");
    expect(source).toContain("do not block solely because that run id is unavailable or not found");
    expect(source).toContain("First call workspace_list and repo_snapshot for the workspace");
    expect(source).toContain("ANSWER must contain the actual analysis");
    expect(source).toContain("Do not answer with only an acknowledgement");
    expect(source).toContain("concrete findings/components/evidence");
    expect(source).toContain("RESPONSE_IDLE_TIMEOUT_MS = 10 * 60_000");
    expect(source).toContain("RESPONSE_HARD_TIMEOUT_MS = 30 * 60_000");
    expect(source).toContain("snapshot.generating || activitySignature !== lastActivitySignature");
    expect(source).toContain("timed out after 10 minutes without conversation progress");
    expect(source).toContain("reached the 30 minute hard limit");
  });

  it("binds browser replies to logical ChatGPT turn identity when available", async () => {
    const source = await readFile(sourceUrl, "utf8");

    expect(source).toContain("data-turn-id-container");
    expect(source).toContain("data-turn-id");
    expect(source).toContain("latestTurnId");
    expect(source).toContain("!before.turnIds.includes(snapshot.latestTurnId)");
  });
});
