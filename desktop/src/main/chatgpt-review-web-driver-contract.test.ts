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
    const ownershipSource = await readFile(new URL("./chatgpt-review-response-ownership.ts", import.meta.url), "utf8");

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
    expect(source).toContain("snapshotOwnsSubmittedUserTurn");
    expect(source).toContain("acceptedOwnedUserTurn");
    expect(source).toContain("ownedAssistantResponseCandidate");
    expect(ownershipSource).toContain("snapshot.assistantAfterLatestUser");
    expect(ownershipSource).toContain("return newAssistantTurn");
    expect(ownershipSource).toContain("Never reuse changed text from the previous assistant");
    expect(source).toContain("stripChatGptAssistantChromeText(rawText)");
    expect(source).toContain("Thought for\\s+");
    expect(source).toContain("CHATGPT_CONNECTION_INTERRUPTED_GRACE_MS = 12_000");
    expect(source).toContain("isChatGptConnectionInterruptedText(rawText)");
    expect(source).toContain("ChatGPT Web connection was interrupted while waiting for the complete answer");
    expect(source).toContain("timed out after 10 minutes without conversation progress");
    expect(source).toContain("reached the 30 minute hard limit");
    expect(source).toContain("CHATGPT_PAGE_SCRIPT_READY_TIMEOUT_MS = 60_000");
    expect(source).toContain("CHATGPT_PAGE_SCRIPT_NAVIGATION_RETRIES");
    expect(source).toContain("executeChatGptPageScript");
    expect(source).toContain("contents.isLoadingMainFrame()");
    expect(source).toContain("wrapChatGptPageScript");
    expect(source).toContain("CHATGPT_PAGE_SCRIPT_WORLD_ID");
    expect(source).toContain("executeWrappedChatGptPageScript");
    expect(source).toContain("executeJavaScriptInIsolatedWorld");
    expect(source).toContain("all ChatGPT page script execution paths failed");
    expect(source).toContain("encodedChatGptPageScriptRunner");
    expect(source).toContain("Buffer.from(script, \"utf8\").toString(\"base64\")");
    expect(source).toContain("executeChatGptPageScriptWithDebugger");
    expect(source).toContain("Runtime.evaluate");
    expect(source).toContain("CDP Runtime.evaluate exception");
    expect(source).toContain("chatGptPageScriptProbe");
    expect(source).toContain("isPotentiallyTransientScriptExecutionError");
    expect(source).toContain("page script probe succeeded");
    expect(source).toContain("script failed to execute");
    expect(source).toContain("ChatGPT page script failed while");
    expect(source).toContain("ChatGPT page did not become script-ready within");
    expect(source).toContain("while ${action}");
    expect(source).toContain("clearChatGptComposer(contents)");
    expect(source).toContain("insertChatGptControlMessage(contents, payload, input.message)");
    expect(source).toContain("ChatGPT composer did not accept the SourceNerve control message");
    expect(source).toContain('[contenteditable="true"][role="textbox"]');
    expect(source).toContain('[contenteditable="true"][data-lexical-editor="true"]');
    expect(source).toContain('.ProseMirror[contenteditable="true"]');
    expect(source).toContain('textarea[placeholder*="message" i]');
    expect(source).toContain("chatGptComposerContains");
    expect(source).toContain("form.requestSubmit()");
    expect(source).toContain('contents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" })');
    expect(source).toContain("const value = await executeChatGptPageScript<string>");
    expect(source).toContain("return executeChatGptPageScript<boolean>(contents");
    expect(source).toContain("ensureProjectNavigationReady");
    expect(source).toContain("open sidebar|show sidebar|sidebar");
    expect(source).toContain("new project|create project|new-project|create-project");
    expect(source).toContain("[data-testid*=\"new-project\"]");
    expect(source).toContain("[data-testid*=\"create-project\"]");
    expect(source).toContain('input[placeholder*="project" i]');
    expect(source).toContain('input[aria-label*="project" i]');
    expect(source).toContain('input[data-testid*="project" i]');
    expect(source).toContain('[contenteditable="true"]');
    expect(source).toContain('[role="textbox"]');
    expect(source).toContain("element.type === 'search'");
    expect(source).toContain("project[ _-]*name");
    expect(source).toContain("create (?:a )?project|create-project|create_project");
    expect(source).toContain("ChatGPT Project name input did not accept the project name");
  });

  it("binds browser replies to logical ChatGPT turn identity when available", async () => {
    const source = await readFile(sourceUrl, "utf8");
    const ownershipSource = await readFile(new URL("./chatgpt-review-response-ownership.ts", import.meta.url), "utf8");

    expect(source).toContain("data-turn-id-container");
    expect(source).toContain("data-turn-id");
    expect(source).toContain("latestTurnId");
    expect(source).toContain("latestUserTurnId");
    expect(source).toContain("assistantAfterLatestUser");
    expect(ownershipSource).toContain("!input.before.turnIds.includes(input.snapshot.latestTurnId)");
  });
});
