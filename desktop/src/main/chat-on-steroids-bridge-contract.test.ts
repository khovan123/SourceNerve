import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const mainRoot = new URL("./", import.meta.url);
const repoRoot = path.resolve(process.cwd(), "..");

describe("Chat On Steroids bridge adaptation contract", () => {
  it("persists browser command states from queued to stable and keeps provider frontend identity separate", async () => {
    const stateSource = await readFile(new URL("./browser-command-state.ts", mainRoot), "utf8");
    const identitySource = await readFile(new URL("./provider-frontend-session.ts", mainRoot), "utf8");
    const driverSource = await readFile(new URL("./chatgpt-review-web-driver.ts", mainRoot), "utf8");

    for (const stage of ["queued", "inserted", "clicked", "accepted", "stable"]) {
      expect(stateSource).toContain(`\"${stage}\"`);
      expect(driverSource).toContain(`\"${stage}\"`);
    }
    expect(identitySource).toContain("ProviderFrontendIdentity");
    expect(identitySource).toContain("SourceNerveSessionIdentity");
    expect(identitySource).toContain("parseChatGptConversationId");
    expect(driverSource).toContain("providerIdentity");
    expect(driverSource).toContain("frontendDocumentId");
    expect(driverSource).toContain("turnEpoch");
    expect(driverSource).toContain("bindSourceNerveAppMention");
    expect(driverSource).toContain("binding the SourceNerve app mention");
    expect(driverSource).toContain("@${SOURCE_NERVE_APP_NAME}");
  });

  it("adds an opt-in desktop-control bridge without silently synthesizing unsafe global input", async () => {
    const source = await readFile(new URL("./desktop-control-bridge.ts", mainRoot), "utf8");
    expect(source).toContain("desktopCapturer.getSources");
    expect(source).toContain("Desktop control is explicit opt-in per capability");
    expect(source).toContain("runMouseAction");
    expect(source).toContain("runKeyboardAction");
  });

  it("packages a Chrome extension bridge that reports ChatGPT presence and executes queued composer commands", async () => {
    const manifest = JSON.parse(await readFile(path.join(repoRoot, "desktop", "extension", "source", "manifest.json"), "utf8")) as { permissions: string[]; host_permissions: string[] };
    const content = await readFile(path.join(repoRoot, "desktop", "extension", "source", "content.js"), "utf8");
    const bridge = await readFile(new URL("./chrome-extension-bridge.ts", mainRoot), "utf8");
    expect(manifest.host_permissions).toEqual(["https://chatgpt.com/*", "http://127.0.0.1:*/*"]);
    expect(manifest.permissions).not.toContain("nativeMessaging");
    expect(content).toContain("data-turn-id-container");
    expect(content).toContain("sourcenerve:presence");
    expect(content).toContain("sourcenerve:command-next");
    expect(content).toContain("sourcenerve:command-receipt");
    expect(content).toContain("sourcenerve:command-defer");
    expect(content).toContain("New project");
    expect(content).toContain("project-name");
    expect(content).toContain("responseCandidate");
    expect(content).toContain("observedGeneration");
    expect(content).toContain("bindSourceNerveMention");
    expect(content).toContain("sourcenerve_app_mention_unavailable");
    expect(content).toContain("EXTENSION_PROTOCOL_VERSION = 6");
    expect(bridge).toContain("/presence");
    expect(bridge).toContain("/command/next");
    expect(bridge).toContain("/command/receipt");
    expect(bridge).toContain("/command/defer");
    expect(bridge).toContain("workspaceProject");
    expect(bridge).toContain("sendCommand");
    expect(bridge).toContain("chrome-extension");
  });

  it("keeps worker ids scoped to their prime family/incarnation", async () => {
    const source = await readFile(new URL("./agent-worker-family.ts", mainRoot), "utf8");
    expect(source).toContain("primeRunId");
    expect(source).toContain("incarnation");
    expect(source).toContain("worker lease does not match this family/incarnation");
    expect(source).toContain("worker count must be 1-8");
  });
});
