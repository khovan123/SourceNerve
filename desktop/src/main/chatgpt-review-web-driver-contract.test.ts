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
  });

  it("binds browser replies to logical ChatGPT turn identity when available", async () => {
    const source = await readFile(sourceUrl, "utf8");

    expect(source).toContain("data-turn-id-container");
    expect(source).toContain("data-turn-id");
    expect(source).toContain("latestTurnId");
    expect(source).toContain("!before.turnIds.includes(snapshot.latestTurnId)");
  });
});
