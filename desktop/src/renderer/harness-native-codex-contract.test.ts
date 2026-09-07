import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const rendererRoot = path.dirname(fileURLToPath(import.meta.url));

describe("Harness native Codex product contract", () => {
  it("keeps native Codex behind a minimal Harness conversation surface", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain('export function HarnessConversationPanel');
    expect(source).toContain('aria-label="Harness conversation"');
    expect(source).toContain("What would you like Harness to work on?");
    expect(source).not.toContain('{selectedWorkspace?.name ?? "Workspace required"}');
    expect(source).not.toContain('bg-card px-3 py-2 pl-12');
    expect(source).not.toContain('>Workspace</p>');
    expect(source).not.toContain("conversationStatus");
    expect(source).not.toContain("Run ${shortId");
    expect(source).not.toContain("Native thread");
    expect(source).not.toContain("Conversation / run");
  });

  it("keeps the active composer as one neutral surface with the send action on the right", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("flex items-end gap-2 rounded-[16px]");
    expect(source).toContain('className={`flex min-w-0 flex-1 ${promptIsBangCommand ? "items-center gap-2" : "items-end"}`}');
    expect(source).toContain("COMPOSER_MAX_ROWS = 9");
    expect(source).toContain("textarea.style.overflowY = contentHeight > maxHeight ? \"auto\" : \"hidden\";");
    expect(source).toContain('aria-label={composerExpanded ? "Collapse composer" : "Expand composer"}');
    expect(source).toContain("focus-within:border-foreground/35");
    expect(source).toContain('style={{ outline: "none" }}');
    expect(source).toContain('className="mb-0.5 shrink-0"');
    expect(source).toContain('<section className="flex h-full min-h-0 flex-col bg-background"');
    expect(source).toContain('<footer className="shrink-0 px-5 py-3 lg:px-8">');
    expect(source).toContain('border border-border bg-card px-3 py-2');
    expect(source).not.toContain('<footer className="shrink-0 border-t border-border bg-card');
    expect(source).not.toContain("border-t border-border/70 pt-2");
    expect(source).not.toContain("focus-within:border-primary/40");
  });

  it("supports keyboard navigation and selection in the slash command menu", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("slashSelectionIndex");
    expect(source).toContain("setSlashSelectionIndex(0)");
    expect(source).toContain('event.key === "ArrowDown"');
    expect(source).toContain('event.key === "ArrowUp"');
    expect(source).toContain('slashMenuVisible && event.key === "Tab"');
    expect(source).toContain('setPrompt(item.requiresArgument ? `${item.command} ` : item.command)');
    expect(source).toContain('slashMenuVisible && event.key === "Enter" && !event.shiftKey');
    expect(source).toContain('void executeSlashCommand(item.command)');
    expect(source).toContain('event.key === "Enter" && !event.shiftKey');
    expect(source).toContain("void send()");
    expect(source).not.toContain('slashMenuVisible && (event.key === "Tab" || (event.key === "Enter"');
    expect(source).toContain("chooseSlashSuggestion");
    expect(source).toContain('role="listbox"');
    expect(source).toContain('role="option"');
    expect(source).toContain("aria-selected={selected}");
    expect(source).toContain('selected ? "bg-[var(--sn-sidebar-active)] text-foreground shadow-[inset_0_0_0_1px_var(--border)]"');
    expect(source).toContain('aria-activedescendant={`slash-command-option-${activeSlashSelectionIndex}`}');
    expect(source).toContain('setSlashSelectionIndex(0);');
    expect(source).toContain('selected ? "text-primary" : "text-muted-foreground"');
    expect(source).toContain('max-h-[204px] overflow-y-auto');
    expect(source).toContain('[scrollbar-width:none]');
    expect(source).toContain('[&::-webkit-scrollbar]:hidden');
    expect(source).toContain('min-h-[48px]');
    expect(source).toContain('slashMenuRef.current?.querySelector<HTMLElement>');
  });

  it("routes slash commands only for slash-prefixed input and does not reject permission presets as non-Codex runs", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");
    const compatibleStart = source.indexOf("function isCodexCompatibleRun");
    const compatibleEnd = source.indexOf("\n}", compatibleStart) + 2;
    const compatibleSource = source.slice(compatibleStart, compatibleEnd);

    expect(source).toContain('if (!text.trimStart().startsWith("/")) return false;');
    expect(compatibleSource).toContain('run.status === "running"');
    expect(compatibleSource).toContain('run.freshnessState === "current"');
    expect(compatibleSource).not.toContain('run.sandbox === "workspace-write"');
    expect(compatibleSource).not.toContain('run.policies.read === "allow"');
    expect(compatibleSource).not.toContain('run.policies.write === "allow"');
    expect(compatibleSource).not.toContain('run.policies.exec === "allow"');
  });

  it("starts a fresh conversation automatically for a normal prompt when the selected run cannot be resumed", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");
    const ensureStart = source.indexOf("async function ensureRun");
    const ensureEnd = source.indexOf("async function resumeNativeConversation", ensureStart);
    const ensureSource = source.slice(ensureStart, ensureEnd);

    expect(ensureSource).toContain("if (compatibleRun) return compatibleRun;");
    expect(ensureSource).toContain("runRequiresOperatorResolution(conversationRun)");
    expect(ensureSource).toContain("return createConversation(false);");
    expect(ensureSource).not.toContain("Use /new or /resume");
    expect(source).toContain("const inheritedPermission = conversationRun ? permissionForRun(conversationRun) : null;");
    expect(source).toContain('profile: inheritedPreset?.profile ?? "interactive-local"');
    expect(source).toContain('sandbox: inheritedPreset?.sandbox ?? "workspace-write"');
    expect(source).toContain("conversationRun && runRequiresOperatorResolution(conversationRun) && !promptIsSlashCommand");
  });

  it("uses native Codex threads and history instead of mirroring the Codex TUI", async () => {
    const conversationSource = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");
    const hostSource = await readFile(path.join(rendererRoot, "..", "main", "codex-app-server-host.ts"), "utf8");
    const managerSource = await readFile(path.join(rendererRoot, "..", "main", "task-manager.ts"), "utf8");

    expect(conversationSource).toContain("getHarnessCodexConversation");
    expect(conversationSource).toContain("resumeHarnessCodexConversation");
    expect(conversationSource).toContain('command: "/new"');
    expect(conversationSource).toContain('command: "/resume"');
    expect(conversationSource).toContain('command: "/status"');
    expect(conversationSource).toContain('command: "/usage"');
    expect(conversationSource).toContain("getHarnessCodexStatus");
    expect(conversationSource).toContain("getHarnessCodexUsage");
    expect(conversationSource).toContain('aria-label="Native Codex status"');
    expect(conversationSource).toContain('aria-label="Native Codex usage"');
    expect(conversationSource).toContain('command: "/permission"');
    expect(conversationSource).toContain("Restoring conversation…");
    expect(conversationSource).toContain("resumeNativeConversation");
    expect(conversationSource).not.toContain("CODEX_SLASH_COMMANDS");
    expect(conversationSource).not.toContain('command: "/model"');
    expect(conversationSource).not.toContain("executeHarnessCodexCommand");
    expect(conversationSource).not.toContain("CodexCommandInlinePanel");
    expect(conversationSource).toContain("Codex TUI slash commands are not mirrored");
    expect(conversationSource).not.toContain('aria-label="Workspace selector"');

    expect(hostSource).toContain('request("thread/list"');
    expect(hostSource).toContain('request("thread/resume"');
    expect(hostSource).toContain('request("thread/turns/list"');
    expect(hostSource).toContain('request("thread/delete"');
    expect(hostSource).toContain('request("account/rateLimits/read"');
    expect(hostSource).toContain('request("account/usage/read"');
    expect(hostSource).not.toContain("executeSlashCommand(commandLine");

    expect(managerSource).toContain("resumeHarnessCodexConversation");
    expect(managerSource).toContain("beginHarnessRun");
    expect(managerSource).toContain("resumeConversation");
    expect(managerSource).toContain("startCycle: true");
    expect(managerSource).toContain("await this.routeHarnessContext({");
  });

  it("gives /resume an active option and keyboard navigation", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("resumeSelectionIndex");
    expect(source).toContain("activeResumeSelectionIndex");
    expect(source).toContain('aria-label="Saved native Codex conversations"');
    expect(source).toContain('aria-activedescendant={`resume-conversation-option-${activeResumeSelectionIndex}`}');
    expect(source).toContain('id={`resume-conversation-option-${index}`}');
    expect(source).toContain('resumeOpen && event.key === "ArrowDown"');
    expect(source).toContain('resumeOpen && event.key === "ArrowUp"');
    expect(source).toContain('resumeOpen && event.key === "Home"');
    expect(source).toContain('resumeOpen && event.key === "End"');
    expect(source).toContain('resumeOpen && event.key === "Enter" && !event.shiftKey');
    expect(source).toContain("setResumeSelectionIndex((current) => (current + 1) % resumeItems.length)");
    expect(source).toContain("resumeMenuRef.current?.querySelector<HTMLElement>");
    expect(source).toContain('onMouseEnter={() => setResumeSelectionIndex(index)}');
    expect(source).toContain('selected ? "bg-[var(--sn-sidebar-active)] text-foreground shadow-[inset_0_0_0_1px_var(--border)]"');
  });

  it("renders native Codex conversation metadata and supports workspace-scoped /clear all", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain('command: "/clear all"');
    expect(source).toContain("listHarnessCodexConversations");
    expect(source).toContain("clearHarnessCodexConversations");
    expect(source).toContain("summary.threadId");
    expect(source).toContain("summary.title");
    expect(source).toContain("summary.preview");
    expect(source).toContain("summary.model");
    expect(source).toContain("Native Codex");
    expect(source).toContain("permanently deletes the native Codex conversations");
    expect(source).not.toContain("summary.messageCount");
    expect(source).not.toContain("local chat history and Codex thread bindings");
    expect(source).not.toContain('>Conversation</span>');
  });

  it("keeps the workspace list in the core sidebar and moves workspace management to slash commands", async () => {
    const conversationSource = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");
    const harnessSource = await readFile(path.join(rendererRoot, "components", "HarnessScreen.tsx"), "utf8");
    const sidebarSource = await readFile(path.join(rendererRoot, "components", "organisms", "AppSidebar.tsx"), "utf8");

    expect(sidebarSource).toContain('aria-label="Managed workspaces"');
    expect(sidebarSource).toContain("onWorkspaceSelect");
    expect(sidebarSource).toContain("/workspace add");
    expect(harnessSource).not.toContain("<WorkspaceRail");
    expect(harnessSource).not.toContain('aria-label="Harness workspaces"');
    expect(harnessSource).not.toContain('grid-cols-[minmax(0,1fr)_340px]');
    expect(conversationSource).toContain('command: "/workspace add"');
    expect(conversationSource).toContain('command: "/workspace edit"');
    expect(conversationSource).toContain('command: "/workspace remove"');
    expect(conversationSource).toContain('command: "/workspace check"');
    expect(conversationSource).toContain("pickWorkspaceRepository");
    expect(conversationSource).toContain("saveWorkspace");
    expect(conversationSource).toContain("removeWorkspace");
    expect(conversationSource).toContain("validateGitTransport");
    expect(conversationSource).not.toContain("onOpenWorkspaces");
  });

  it("defaults workspace edit/check to the current workspace and keeps command output in one inline surface", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain('{ command: "/workspace edit", label: "Edit the current workspace", requiresArgument: false }');
    expect(source).toContain('{ command: "/workspace check", label: "Check the current workspace", requiresArgument: false }');
    expect(source).toContain("positionals[0] ?? selectedWorkspaceId");
    expect(source).toContain("beginWorkspaceEdit(workspace)");
    expect(source).toContain("setWorkspaceCheck({ workspace, result: checked.value })");
    expect(source).toContain('aria-label="Command output"');
    expect(source).toContain("<WorkspaceEditInlinePanel");
    expect(source).toContain("<WorkspaceCheckInlinePanel");
    expect(source).toContain("<WorkspaceListInlinePanel");
    expect(source).toContain("<WorkspaceHelpInlinePanel");
    expect(source).toContain("<CodexStatusInlinePanel");
    expect(source).toContain("<CodexUsageInlinePanel");
    expect(source).not.toContain('{visibleError ? <p className="error-banner"');
    expect(source).not.toContain('{workspaceNotice ? <p className="success-banner"');
  });

  it("keeps exact one-shot approvals inline without exposing diagnostic identifiers", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("listHarnessApprovals");
    expect(source).toContain("respondHarnessApproval");
    expect(source).toContain("Approval required");
    expect(source).toContain("Allow once");
    expect(source).toContain("Deny");
    expect(source).not.toContain("externalRequestId");
    expect(source).not.toContain("argumentSha256");
    expect(source).not.toContain("headSha.slice");
  });

  it("streams tool calls and jobs into the conversation instead of a separate activity timeline", async () => {
    const conversationSource = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");
    const harnessSource = await readFile(path.join(rendererRoot, "components", "HarnessScreen.tsx"), "utf8");

    expect(conversationSource).toContain("buildActivityItems");
    expect(conversationSource).toContain("buildConversationFeed");
    expect(conversationSource).toContain("ToolActivityRow");
    expect(conversationSource).toContain("JobActivityRow");
    expect(harnessSource).toContain("events={events}");
    expect(harnessSource).toContain("jobs={jobs}");
    expect(harnessSource).toContain("onCancelJob={cancelJob}");
    expect(harnessSource).not.toContain('["activity", "Activity"');
    expect(harnessSource).not.toContain('inspectorTab === "activity"');
  });


  it("changes Harness permission through /permission instead of an inspector policy surface", async () => {
    const conversationSource = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");
    const harnessSource = await readFile(path.join(rendererRoot, "components", "HarnessScreen.tsx"), "utf8");

    expect(conversationSource).toContain('command: "/permission"');
    expect(conversationSource).toContain('id: "read-only"');
    expect(conversationSource).toContain('id: "workspace-write"');
    expect(conversationSource).toContain('id: "guarded"');
    expect(conversationSource).toContain('id: "full-access"');
    expect(conversationSource).toContain('setPermissionOpen(true)');
    expect(conversationSource).toContain('permissionSelectionIndex');
    expect(conversationSource).toContain('aria-label="Harness permissions"');
    expect(conversationSource).toContain('aria-activedescendant={`permission-option-${permissionSelectionIndex}`}');
    expect(conversationSource).toContain('permissionOpen && event.key === "ArrowDown"');
    expect(conversationSource).toContain('permissionOpen && event.key === "ArrowUp"');
    expect(conversationSource).toContain('permissionOpen && event.key === "Enter" && !event.shiftKey');
    expect(conversationSource).toContain('setPermissionSelectionIndex((current) => (current + 1) % PERMISSION_PRESETS.length)');
    expect(conversationSource).toContain('selected ? "text-primary" : "text-muted-foreground"');
    expect(conversationSource).toContain('Switch this workspace to the full sandbox?');
    expect(conversationSource).toContain('beginHarnessRun');
    expect(harnessSource).not.toContain('["policy", "Policy"');
    expect(harnessSource).not.toContain('inspectorTab === "policy"');
    expect(harnessSource).not.toContain('SelectedWorkspacePolicy');
  });

  it("runs bang commands as direct user shell actions with inline output and no Harness approval coupling", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");
    const bangBranch = source.indexOf("if (promptIsBangCommand)");
    const setupBranch = source.indexOf("const currentSetup = setup ?? await refreshSetup(false)");
    const directShellStart = source.indexOf("async function executeBangCommand");
    const directShellEnd = source.indexOf("async function respondToApproval", directShellStart);
    const directShellSource = source.slice(directShellStart, directShellEnd);

    expect(source).toContain("extractBangCommand");
    expect(source).toContain("runHarnessCommand");
    expect(source).toContain('aria-label="Shell command mode"');
    expect(source).toContain('aria-label="Shell command output"');
    expect(source).toContain('result.success === false ? "text-danger" : "text-foreground"');
    expect(source).toContain("const composerValue = promptIsBangCommand ? bangComposerValue(prompt) : prompt;");
    expect(source).toContain('value={composerValue}');
    expect(source).toContain('className={`flex min-w-0 flex-1 ${promptIsBangCommand ? "items-center gap-2" : "items-end"}`}');
    expect(source).toContain("COMPOSER_MAX_ROWS = 9");
    expect(source).toContain('ref={composerTextareaRef}');
    expect(source).toContain('rows={promptIsBangCommand ? 1 : 2}');
    expect(source).toContain('aria-label={composerExpanded ? "Collapse composer" : "Expand composer"}');
    expect(source).toContain('const nextPrompt = promptIsBangCommand ? `!${event.target.value}` : event.target.value;');
    expect(source).toContain('promptIsBangCommand && event.key === "Backspace" && composerValue.length === 0');
    expect(source).toContain('requestId: `bang:${window.crypto.randomUUID()}`');
    expect(source).not.toContain("pendingBangCommand");
    expect(source).toContain("await dispatchBangCommand(request)");
    expect(directShellSource).not.toContain("ensureRun");
    expect(directShellSource).toContain("workspace: selectedReadyWorkspace.id");
    expect(source).not.toContain('status: "approval-required"');
    expect(source).toContain('!selectedReadyWorkspace || (!promptIsBangCommand && !setupReady)');
    expect(bangBranch).toBeGreaterThan(-1);
    expect(setupBranch).toBeGreaterThan(bangBranch);
    expect(source).not.toContain(["child", "process"].join("_"));
  });

  it("removes the right inspector, auto-routes context, and keeps inspection inside run tools", async () => {
    const harnessSource = await readFile(path.join(rendererRoot, "components", "HarnessScreen.tsx"), "utf8");
    const conversationSource = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(harnessSource).toContain('import { HarnessConversationPanel } from "./CodexChatPanel";');
    expect(harnessSource).toContain("<HarnessConversationPanel");
    expect(harnessSource).not.toContain('aria-label="Harness inspector"');
    expect(harnessSource).not.toContain("PanelRightClose");
    expect(harnessSource).not.toContain("PanelRightOpen");
    expect(harnessSource).not.toContain("AgentOpsPanel");
    expect(harnessSource).not.toContain("HarnessContextGatePanel");
    expect(conversationSource).toContain('command: "/run"');
    expect(conversationSource).toContain('command: "/run refresh"');
    expect(conversationSource).toContain('command: "/run cancel"');
    expect(conversationSource).toContain('command: "/harness agent"');
    expect(conversationSource).not.toContain('["/agent", "Open Codex agent/subagent controls"]');
    expect(conversationSource).not.toContain('command: "/context"');
    expect(conversationSource).toContain("<RunInlinePanel");
    expect(conversationSource).toContain("<AgentOpsPanel");
    expect(conversationSource).toContain("Context routing");
    expect(conversationSource).toContain("automatic");
    expect(conversationSource).toContain('item.eventType === "context/gate"');
    expect(conversationSource).not.toContain("<HarnessContextGatePanel");
    expect(conversationSource).toContain('aria-label="Current Harness run"');
    expect(conversationSource).toContain("Full sandbox removes Codex confinement");
    expect(conversationSource).toContain("native approval callback Codex raises");
    expect(conversationSource).toContain("onCancelRun");

    const agentSource = await readFile(path.join(rendererRoot, "components", "AgentOpsPanel.tsx"), "utf8");
    expect(agentSource).toContain('aria-label="Harness Agent mechanism"');
    expect(agentSource).toContain("How Harness Agent works");
    expect(agentSource).toContain('title: "Decide"');
    expect(agentSource).toContain('title: "Guard"');
    expect(agentSource).toContain('title: "Execute"');
    expect(agentSource).toContain('title: "Verify"');
    expect(agentSource).toContain('title: "Learn"');
    expect(agentSource).toContain("A model cannot execute tools directly");
  });
});