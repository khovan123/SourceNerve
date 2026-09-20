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

  it("keeps the live Thinking indicator below ChatGPT output with three staggered bouncing dots", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
    expect(source).not.toContain('aria-label="Thinking"');
    expect(source).toContain('<span>Thinking</span>');
    expect(source.match(/<span>Thinking<\/span>/g)).toHaveLength(1);
    expect(source.match(/animate-bounce/g)).toHaveLength(3);
    expect(source).toContain('[animation-delay:-0.30s]');
    expect(source).toContain('[animation-delay:-0.15s]');
    expect(source).toContain('aria-label="Live ChatGPT progress"');
    expect(source).toContain('aria-label="Live activity rows"');
    expect(source).toContain('aria-label="Changed files group"');
    expect(source).toContain('<ChatGptLiveProgressRow');
    expect(source).toContain('aria-label="Streaming assistant response"');
    expect(source).toContain("const activeChatGptResponseText = useMemo");
    expect(source).toContain("!activeChatGptResponseText");
    expect(source).not.toContain("Harness is working with native Codex…");
  });


  it("exposes Codex/ChatGPT/Goal/Loop selection through slash commands without widening Harness authority", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain('type HarnessAgentId = "codex" | "chat-gpt" | "goal" | "loop";');
    expect(source).toContain('const HARNESS_AGENT_OPTIONS: Array<{ id: HarnessAgentBaseId; label: string; description: string }>');
    expect(source).toContain('label: "Codex"');
    expect(source).toContain('label: "ChatGPT"');
    expect(source).not.toContain('aria-label="Agent selector"');
    expect(source).toContain('command: "/agents"');
    expect(source).not.toContain('command: "/agents codex"');
    expect(source).not.toContain('command: "/agents chat-gpt"');
    expect(source).toContain('aria-label="Agents"');
    expect(source).toContain('chooseHarnessAgentFromPicker');
    expect(source).toContain('setAgentPickerOpen(true)');
    expect(source).toContain('command: "/model"');
    expect(source).toContain('command: "/model auto"');
    expect(source).toContain('command: "/model web"');
    expect(source).toContain('command: "/goal"');
    expect(source).toContain('command: "/loop"');
    expect(source).not.toContain('command: "/agent goal"');
    expect(source).not.toContain('command: "/agent loop"');
    expect(source).toContain('const chatGptDirectAgentActive = selectedAgent === "chat-gpt";');
    expect(source).toContain('const chatGptAgentActive = chatGptDirectAgentActive || selectedAgent === "goal" || selectedAgent === "loop";');
    expect(source).toContain('const nativeCodexRequiredForSelectedAgent = !chatGptDirectAgentActive;');
    expect(source).toContain('const chatGptLoopMode = selectedAgent === "goal" ? "goal" : selectedAgent === "loop" ? "loop" : "review";');
    expect(source).toContain('parseInlineChatGptModeCommand(text)');
    expect(source).toContain('const effectiveAgent = promptAgentOverride ?? selectedAgent;');
    expect(source).toContain('if (effectiveChatGptAgentActive)');
    expect(source).toContain('window.sourcenerveDesktop.runHarnessCodexReviewLoop');
    expect(source).toContain('window.sourcenerveDesktop.runHarnessCodexTurn');
    expect(source).toContain('mode: effectiveChatGptLoopMode');
    expect(source).toContain('ChatGPT Web → Harness verify');
    expect(source).toContain('Native Codex will not run');
  });

  it("renders ChatGPT review results as transcript assistant turns instead of command notice cards", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("formatChatGptReviewLoopResult");
    expect(source).toContain("formatChatGptReviewTranscriptMessage");
    expect(source).toContain("stripChatGptControlBlock");
    expect(source).toContain("extractChatGptUserAnswer");
    expect(source).toContain("fallbackNoCodeChatGptAnswer");
    expect(source).not.toContain("Working in ChatGPT Web through Harness tools…");
    expect(source).toContain("formatChatGptDirectFailureTranscriptMessage");
    expect(source).toContain("isChatGptDirectTransportFailure");
    expect(source).toContain("directTransportFailure");
    expect(source).toContain("setError(promptWasCancelled ? null : directTransportFailure ? failureText");
    expect(source).toContain("if (directTransportFailure)");
    expect(source).toContain("setPrompt(text);");
    expect(source).toContain("message.id !== optimistic.id && message.id !== chatGptPendingMessage?.id");
    expect(source).toContain("if (chatGptPendingMessage && !directTransportFailure)");
    expect(source).toContain("if (!directTransportFailure) await hydrateConversation(run, false);");
    expect(source).toContain("A blocked direct ChatGPT control state can still carry a complete user-facing ANSWER");
    expect(source).toContain("const userAnswer = extractChatGptUserAnswer(result.review);");
    expect(source).toContain("if (userAnswer) return userAnswer;");
    expect(source).not.toContain("`ChatGPT Web could not complete this turn: ${answer}`");
    expect(source).toContain('return cleaned || "ChatGPT Web could not complete this turn.";');
    expect(source).toContain("harness run not found");
    expect(source).toContain("userVisibleChatGptBlockedText");
    expect(source).toContain("looksLikeInternalReviewProse(stripped)");
    expect(source).toContain("ChatGPT Web could not verify the Desktop Harness run. I reset that turn; start a new Harness prompt so SourceNerve can bind a fresh run.");
    expect(source).toContain("id: chatGptPendingMessage?.id ?? `assistant:${reviewed.value.taskId}`");
    expect(source).toContain('turnId: `chatgpt-review:${reviewed.value.taskId}`');
    expect(source).toContain("setMessages((current) => [...current, optimistic]);");
    expect(source).toContain("effectiveChatGptDirectAgentActive ? [optimistic, chatGptReviewMessage] : [chatGptReviewMessage]");
    expect(source).toContain("Hi! What would you like me to work on?");
    expect(source).toContain("promptLooksLikeRepositoryAnalysis");
    expect(source).toContain("did not return a usable analysis");
    expect(source).toContain("I analyzed (?:the )?(?:current )?(?:source|source code|repository|repo|codebase).*HEAD");
    expect(source).not.toContain("setReviewLoopResult");
    expect(source).not.toContain("reviewLoopResult ?");
    expect(source).not.toContain('reviewLoopResult.iterations} iteration');
    expect(source).not.toContain("agent did not run Codex because no repository execution was needed");
  });

  it("streams direct ChatGPT response, tool calls, and unverified diffs while keeping reasoning status transient", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain('event.type === "chatgpt-progress"');
    expect(source).toContain('event.kind === "response"');
    expect(source).toContain('event.kind === "reasoning"');
    expect(source).toContain('if (event.kind !== "reasoning")');
    expect(source).toContain('if (activity.source !== "chatgpt") return true;');
    expect(source).toContain('if (activity.kind === "reasoning") return false;');
    expect(source).toContain('const assistantMessageTurnIds = useMemo(() => new Set(messages');
    expect(source).toContain('assistantMessageTurnIds.has(activity.turnId)');
    expect(source).toContain('&& activity.turnId !== activeChatGptTurnId');
    expect(source).not.toContain('if (activity.kind === "tool") return activity.turnId === activeChatGptTurnId;');
    expect(source).not.toContain("chatGptLiveReasoning");
    expect(source).toContain('event.kind === "tool"');
    expect(source).toContain('event.kind === "diff"');
    expect(source).toContain('aria-label="Live ChatGPT progress"');
    expect(source).toContain('aria-label="Live activity rows"');
    expect(source).toContain('aria-label="Changed files group"');
    expect(source).toContain('aria-label="Streaming assistant response"');
    expect(source).toContain("stripTransientChatGptStatusText");
    expect(source).toContain("normalizeConversationTextForDedupe");
    expect(source).toContain('const visibleTraceItems = mergedTraceItems;');
    expect(source).toContain('const activeChatGptTurnId = activeChatGptTaskId ? `chatgpt-review:${activeChatGptTaskId}` : null;');
    expect(source).toContain('parseChatGptAgentStateRuntimeEvent(event)');
    expect(source).toContain('if (payload && activePromptRunIdRef.current === payload.runId)');
    expect(source).toContain('setReviewLoopPhase(event.state.slice("chatgpt-review-".length));');
    expect(source).toContain('if (payload.taskId)');
    expect(source).toContain('function isStaleChatGptNativeExecutionFailure');
    expect(source).toContain('Harness native execution requires a current running run');
    expect(source).toContain('entry.createdAt >= activePromptStartedAt');
    expect(source).not.toContain('entry.source === "chatgpt" && entry.runId === activePromptRunId');
    expect(source).not.toContain('!timelineActivities.some((activity) => activity.runId === activePromptRunId)');
    expect(source).toContain('chatGptLiveToolStableId');
    expect(source).toContain('stableTraceKey');
    expect(source).toContain('mergeChatGptLiveDiff');
    expect(source).toContain('strongestChatGptLiveToolStage');
    expect(source).toContain('compactCodexTraceDisplayEntries');
    expect(source).toContain('codexTraceDisplayKey');
    expect(source).toContain('function strongestTraceStage');
    expect(source).toContain('if (left === "completed" || right === "completed") return "completed";');
    expect(source).toContain('<details className="group w-full" aria-label="Codex activity group">');
    expect(source).not.toContain('<details className="group w-full" aria-label="Codex activity group" open>');
    expect(source).toContain("ClaudeCodexTraceGroup");
    expect(source).toContain('hideSummary={Boolean(activeChatGptTurnId');
    expect(source).toContain('`Used ${tools} tool${tools === 1 ? "" : "s"}`');
    expect(source).toContain('<ClaudeOutputBlock text={entry.parameters} copyLabel="Copy input" />');
    expect(source).toContain('<ClaudeOutputBlock text={entry.output} copyLabel="Copy output" />');
    expect(source).toContain('<ClaudeFileDiffList diff={diff} />');
    expect(source).toContain('aria-label="Changed files"');
    expect(source).toContain('className="group/file border-t border-border/45 first:border-t-0"');
    expect(source).toContain('<ClaudeDiffBlock diff={section.diff} />');
    expect(source).toContain('>Input</p>');
    expect(source).toContain('>Output</p>');
    expect(source).toContain("streaming");
  });

  it("preserves renderer-owned direct ChatGPT prompts when run hydration changes native thread identity", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("const rendererOwned = sanitizeConversationMessages(current).filter(isRendererOwnedConversationMessage);");
    expect(source).toContain("rendererOwned.length > 0 ? mergeConversationMessages(sanitizedHydrated, rendererOwned) : sanitizedHydrated");
    expect(source).toContain('message.role === "user" && message.id.startsWith("user:")');
    expect(source).toContain('message.turnId?.startsWith("chatgpt-review:")');
  });

  it("renders native Codex activity as Claude-style grouped commands and expandable file diffs", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("ClaudeCodexTraceGroup");
    expect(source).toContain("ClaudeTraceGroupSummary");
    expect(source).toContain("ClaudeCodexActivityRow");
    expect(source).toContain("ClaudeFileDiffOutput");
    expect(source).toContain("ClaudeFileDiffList");
    expect(source).toContain("codexTraceGroupStats");
    expect(source).toContain("Edited ${files} file");
    expect(source).toContain("ran ${commands} command");
    expect(source).toContain('className="text-success"');
    expect(source).toContain('className="text-danger"');
    expect(source).toContain('aria-label="Copy command"');
    expect(source).toContain("extractUnifiedDiffPaths");
    expect(source).toContain("unifiedDiffStats");
  });

  it("hydrates native Codex messages while a prompt is still running", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("CODEX_STREAM_HYDRATION_MS");
    expect(source).toContain("startStreamingConversationHydration(run, optimistic)");
    expect(source).toContain("const storedConversationId = readChatGptConversationId(run.workspace);");
    expect(source).toContain("window.sourcenerveDesktop.getHarnessCodexConversation({");
    expect(source).toContain("...(storedConversationId ? { conversationId: storedConversationId } : {})");
    expect(source).toContain("mergeStreamingConversationMessages");
    expect(source).toContain("window.setInterval");
    expect(source).toContain("window.clearInterval(interval)");
    expect(source).toContain("mergeConversationMessages(base, streamed)");
    expect(source).toContain("result.value.response?.trim()");
    expect(source).toContain('id: `assistant:${result.value.turnId}`');
    expect(source).toContain("mergeConversationMessages(current, [completedMessage])");
    expect(source).toContain('id: `assistant:${result.value.turnId}`');
    expect(source).not.toContain("backendHasOptimisticPrompt");
  });

  it("carries the logical ChatGPT conversation id through native resume", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("const storedConversationId = readChatGptConversationId(workspaceId);");
    expect(source).toContain("window.sourcenerveDesktop.resumeHarnessCodexConversation({");
    expect(source).toContain("...(storedConversationId ? { conversationId: storedConversationId } : {})");
    expect(source).toContain("persistChatGptConversationId(workspaceId, resumed.value.conversationId)");
    expect(source).toContain("persistChatGptConversationId(workspaceId, result.value.conversationId)");
  });

  it("lets the operator cancel a running prompt from the Thinking row", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("activePromptRunId");
    expect(source).toContain("promptCancelling");
    expect(source).toContain("cancelActivePrompt");
    expect(source).toContain("window.sourcenerveDesktop.cancelHarnessRun({ runId })");
    expect(source).toContain('aria-label="Cancel running prompt"');
    expect(source).toContain('{cancelling ? "Cancelling…" : "Cancel"}');
    expect(source).toContain("cancelledPromptRunsRef.current.add(runId)");
    expect(source).toContain("Prompt cancelled.");
    expect(source).toContain("Skill selection stopped because the prompt was cancelled.");
  });

  it("does not show previous-turn busy warnings for the prompt that currently owns the native writer", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("const activePromptRunIdRef = useRef<string | null>(null);");
    expect(source).toContain("activePromptRunIdRef.current = run.id;");
    expect(source).toContain("const busyBelongsToCurrentPrompt = activePromptRunIdRef.current === runId;");
    expect(source).toContain("if (chatGptDirectAgentActive || busyBelongsToCurrentPrompt || !nativeBusy)");
    expect(source).toContain("[selectedWorkspaceRun?.id, selectedWorkspaceRun?.workspace, chatGptDirectAgentActive]");
    expect(source).toContain("includeNative: !chatGptDirectAgentActive");
    expect(source).toContain("{nativeHydrationBlocking ? <p className=\"text-center text-xs text-muted-foreground\">Restoring conversation…</p> : null}");
    expect(source).not.toContain("if (busyBelongsToCurrentPrompt || !nativeBusy)");
    expect(source).toContain("syncConversationBusyNotice(run.id, result.value.busy === true, result.value.busyReason);");
    expect(source).toContain("current && isNativeThreadBusyNotice(current) ? null : current");
    expect(source).toContain("Codex conversation is still finishing a previous turn. New prompts will wait until the native thread is writable.");
    expect(source).toContain("activePromptRunIdRef.current = null;");
  });

  it("keeps the conversation viewport scrolled to the newest item", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("messageViewportRef");
    expect(source).toContain("messageTailRef");
    expect(source).toContain("messageAutoScrollKey");
    expect(source).toContain('ref={messageViewportRef}');
    expect(source).toContain('viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" })');
    expect(source).toContain('messageTailRef.current?.scrollIntoView({ block: "end" })');
    expect(source).toContain('ref={messageTailRef}');
  });

  it("renders one Harness header for assistant chunks in the same native turn", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("feedItems.map((item, index)");
    expect(source).toContain("continuation={assistantStreamContinuation(feedItems, index)}");
    expect(source).toContain("function assistantStreamContinuation(feedItems: ConversationFeedItem[], index: number)");
    expect(source).toContain('current.message.turnId === previous.message.turnId');
    expect(source).toContain('current.message.createdAt === previous.message.createdAt');
    expect(source).toContain('assistantStreamContinuation(feedItems, index)');
    expect(source).toContain('className={`w-full ${continuation ? "!mt-1" : ""}`}');
    expect(source).toContain('<HarnessMarkdown text={message.text} />');
  });

  it("renders Harness assistant output as safe GitHub-flavored Markdown", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain('import ReactMarkdown from "react-markdown";');
    expect(source).toContain('import remarkGfm from "remark-gfm";');
    expect(source).toContain('<HarnessMarkdown text={message.text} />');
    expect(source).toContain('function HarnessMarkdown({ text }: { text: string })');
    expect(source).toContain('remarkPlugins={[remarkGfm]}');
    expect(source).toContain('skipHtml');
    expect(source).toContain('target="_blank"');
    expect(source).toContain('rel="noreferrer"');
    expect(source).toContain('[&_pre_code]:bg-transparent');
    expect(source).toContain('[&_ul]:list-disc');
    expect(source).toContain('[&_ol]:list-decimal');
    expect(source).not.toContain('<p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{item.message.text}</p>');
  });

  it("collapses long user prompts to five rows without collapsing assistant output", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("USER_PROMPT_PREVIEW_LINES = 5");
    expect(source).toContain("USER_PROMPT_PREVIEW_MAX_HEIGHT_REM");
    expect(source).toContain("function CollapsibleUserPrompt({ text }: { text: string })");
    expect(source).toContain("function userPromptShouldCollapse(text: string)");
    expect(source).toContain("<CollapsibleUserPrompt text={message.text} />");
    expect(source).toContain('aria-label="Collapsible user prompt"');
    expect(source).toContain('expanded ? "Show less" : "Show more"');
    expect(source).toContain("lines.length > USER_PROMPT_PREVIEW_LINES");
    expect(source).toContain("normalized.length > 520");
    expect(source).toContain("<HarnessMarkdown text={message.text} />");
    expect(source).not.toContain("CollapsibleAssistantMarkdown");
    expect(source).not.toContain("ASSISTANT_COLLAPSE_PREVIEW_LINES");
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

  it("continues the restored native Codex thread instead of silently creating a new conversation", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");
    const ensureStart = source.indexOf("async function ensureRun");
    const ensureEnd = source.indexOf("async function resumeNativeConversation", ensureStart);
    const ensureSource = source.slice(ensureStart, ensureEnd);

    expect(source).toContain("const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);");
    expect(source).toContain("setCurrentThreadId(result.value.threadId ?? null);");
    expect(source).toContain("setCurrentThreadId(result.value.threadId ?? threadId ?? null);");
    expect(source).toContain("setCurrentThreadId(resumed.value.threadId ?? threadId);");
    expect(ensureSource).toContain("async function ensureRun(options: { requiresNativeThread: boolean })");
    expect(ensureSource).toContain("if (compatibleRun) return compatibleRun;");
    expect(ensureSource).toContain("if (!options.requiresNativeThread)");
    expect(ensureSource).toContain("must never resume or wait on a native Codex thread");
    expect(ensureSource).toContain("runRequiresOperatorResolution(conversationRun)");
    expect(ensureSource).toContain("if (currentThreadId) return resumeSelectedThreadForPrompt(currentThreadId);");
    expect(ensureSource).toContain("Wait for the selected conversation to finish restoring before sending a prompt.");
    expect(ensureSource).toContain("Only /new creates a new native Codex conversation when a restored thread");
    expect(ensureSource).toContain("return createConversation(false, false, false);");
    expect(ensureSource).toContain("async function resumeSelectedThreadForPrompt(threadId: string)");
    expect(source).toContain("async function createConversation(showBusy = true, selectCreatedRun = true, resetTranscript = true)");
    expect(source).toContain("if (resetTranscript) {");
    expect(source).toContain("setMessages((current) => mergeConversationMessages(current, resumed.value.messages));");
    expect(ensureSource).toContain("resumeHarnessCodexConversation({");
    expect(ensureSource).toContain("getHarnessRun({ runId: resumed.value.runId })");
    expect(ensureSource).not.toContain("return createConversation(false);\n");
    expect(source).toContain('const desiredPermission = workspacePermissionDefaults[workspaceId] ?? runPermission ?? "workspace-write";');
    expect(source).toContain("const desiredPermissionPreset = PERMISSION_PRESETS.find((preset) => preset.id === desiredPermission) ?? PERMISSION_PRESETS[1];");
    expect(source).toContain("const compatibleRun = conversationRun && isCodexCompatibleRun(conversationRun) && runPermission === desiredPermission ? conversationRun : null;");
    expect(source).toContain("profile: desiredPermissionPreset.profile");
    expect(source).toContain("sandbox: desiredPermissionPreset.sandbox");
    expect(source).toContain("const run = await ensureRun({ requiresNativeThread: effectiveNativeCodexRequiredForSelectedAgent });");
    expect(source).toContain('conversationRun?.status === "running"');
    expect(source).not.toContain('conversationRun?.status === "running" && currentThreadId');
    expect(source).toContain("window.sourcenerveDesktop.getHarnessCodexConversation");
    expect(source).toContain("runId: conversationRun.id,\n        includeNative: false,");
    expect(source).toContain("Native Codex is still actively writing this conversation.");
    expect(source).toContain("Direct ChatGPT is paused to avoid concurrent workspace writes.");
    expect(source).toContain("if (effectiveNativeCodexRequiredForSelectedAgent) {");
    expect(source).toContain("const shouldSelectPromptRun = run.id !== selectedRunId;");
    expect(source).toContain("if (shouldSelectPromptRun) await onRunSelected(run.id);");
    expect(source).toContain("const nativeHydrationBlocking = nativeCodexRequiredForSelectedAgent && hydrating;");
    expect(source).toContain("const composerDisabled = busy !== null || nativeHydrationBlocking || operatorGateActive;");
    expect(source).toContain('placeholder={operatorGateActive ? "Harness is waiting for approval, recovery, or cancellation…" : nativeHydrationBlocking ? "Restoring conversation…"');
    expect(source).not.toContain("const inheritedPermission = conversationRun ? permissionForRun(conversationRun) : null;");
    expect(source).toContain("conversationRun && runRequiresOperatorResolution(conversationRun) && !promptIsSlashCommand");
  });

  it("keeps restored conversation history visible when native hydration errors", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");
    const effectStart = source.indexOf("useEffect(() => {\n    const run = selectedWorkspaceRun;");
    expect(effectStart).toBeGreaterThanOrEqual(0);
    const effectEnd = source.indexOf("async function loadPendingApprovals", effectStart);
    expect(effectEnd).toBeGreaterThan(effectStart);
    const hydrationSource = source.slice(effectStart, effectEnd);

    expect(hydrationSource).toContain("A missing selected run can be transient after a native execution");
    expect(hydrationSource).toContain("only workspace");
    expect(hydrationSource).toContain("Hydration/native errors are inline status, not conversation resets.");
    expect(hydrationSource).toContain("setError(result.error.message);");
    expect(hydrationSource).toContain("setHydrating(false);");
    expect(hydrationSource).toContain("return;");
    expect(hydrationSource).toContain("mergeHydratedConversationMessages");
    expect(source).toContain("sanitizedHydrated.length === 0");
    expect(source).toContain("currentThreadId && nextThreadId && currentThreadId !== nextThreadId");
    expect(source).toContain("if (current.length === 0) return sanitizedHydrated;");
    expect(source).toContain("promotesOptimisticMessage");
    expect(source).toContain("sameTurn");
    expect(source).toContain('normalizedMessage = { ...message, createdAt: existing.createdAt }');
    expect(hydrationSource).toContain("setCurrentThreadId(nextThreadId);");
    expect(hydrationSource).not.toContain("setMessages([]);");
    expect(hydrationSource).not.toContain("setSkillMessages([]);");
    expect(hydrationSource).not.toContain("setCurrentThreadId(null);");
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
    expect(conversationSource).toContain('command: "/model"');
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
    expect(source).toContain('aria-label="Saved conversations"');
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

  it("maps Harness approval and recovery gate blocks to an actionable waiting panel", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("HARNESS_OPERATOR_GATE_ERROR");
    expect(source).toContain("isHarnessOperatorGateError");
    expect(source).toContain("const visibleError = operatorGateFromError ? null : rawVisibleError;");
    expect(source).toContain("<HarnessOperatorGateInlinePanel");
    expect(source).toContain("Harness is waiting");
    expect(source).toContain("Refresh state");
    expect(source).toContain("Cancel run");
    expect(source).toContain("approvalPanelRef.current?.scrollIntoView");
    expect(source).toContain('id="pending-harness-approvals"');
    expect(source).toContain("const nativeHydrationBlocking = nativeCodexRequiredForSelectedAgent && hydrating;");
    expect(source).toContain("const composerDisabled = busy !== null || nativeHydrationBlocking || operatorGateActive;");
    expect(source).toContain('placeholder={operatorGateActive ? "Harness is waiting for approval, recovery, or cancellation…" : nativeHydrationBlocking ? "Restoring conversation…"');
    expect(source).toContain("if (operatorGateActive)");
    expect(source).toContain("Skill selection stopped because Harness is waiting for operator resolution.");
    expect(source).toContain("workspaceNoticeTitle(workspaceNotice)");
    expect(source).toContain("Waiting for previous turn");
    expect(source).toContain("workspaceNoticeTone(workspaceNotice)");
    expect(source).toContain("tone === \"warning\"");
    expect(source).toContain("if (!isActiveRun(run)) return false;");
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
    expect(conversationSource).toContain('PERMISSION_STORAGE_KEY');
    expect(conversationSource).toContain('loadWorkspacePermissionDefaults');
    expect(conversationSource).toContain('saveWorkspacePermissionDefaults');
    expect(conversationSource).toContain('desiredPermissionPreset.profile');
    expect(conversationSource).toContain('desiredPermissionPreset.sandbox');
    expect(conversationSource).toContain('runPermission === desiredPermission');
    expect(conversationSource).toContain('beginHarnessRun');
    expect(harnessSource).not.toContain('["policy", "Policy"');
    expect(harnessSource).not.toContain('inspectorTab === "policy"');
    expect(harnessSource).not.toContain('SelectedWorkspacePolicy');
  });

  it("shows turn-scoped selected skills before the assistant stream when a prompt picks skills", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("const [skillTurns, setSkillTurns]");
    expect(source).toContain("subscribeRuntimeEvents");
    expect(source).toContain('event.state !== "skills-selected"');
    expect(source).toContain("beginSkillTurn(skillTurnId, run.id, run.workspace, promptCreatedAt + 1)");
    expect(source).toContain("prepareHarnessCodexTurn");
    expect(source).toContain("selectPreparedSkillTurn(skillTurnId, prepared.value.skillActivity)");
    expect(source).toContain("await waitForRendererPaint()");
    expect(source).toContain("preparationId: prepared.value.preparationId");
    expect(source).toContain("completeSkillTurn(skillTurnId, result.value.skillActivity, result.value.turnId)");
    expect(source).toContain('item.kind === "skill"');
    expect(source).toContain("<SkillTurnRow");
    expect(source).toContain('"Selecting skills…"');
    expect(source).toContain('"Selected skills"');
    expect(source).toContain("selected.map((skill)");
    expect(source).toContain("const keep = payload.activity.selectedSkillKeys.length > 0;");
    expect(source).toContain("const keep = activity.selectedSkillKeys.length > 0;");
    expect(source).not.toContain('"Skills prepared"');
    expect(source).toContain("buildConversationFeed(messages, activityItems, bangCommands, skillTurns, visibleTraceItems)");
    expect(source).toContain("mergeHydratedConversationMessages");
    expect(source).toContain("mergeConversationMessages");
    expect(source).toContain("sanitizedHydrated.length === 0");
    expect(source).toContain('busy === "send" && activePromptRunId');
    const prepareIndex = source.indexOf("prepareHarnessCodexTurn");
    const selectIndex = source.indexOf("selectPreparedSkillTurn(skillTurnId, prepared.value.skillActivity)");
    const paintIndex = source.indexOf("await waitForRendererPaint()");
    const runIndex = source.indexOf("runHarnessCodexTurn({", paintIndex);
    expect(prepareIndex).toBeGreaterThan(-1);
    expect(selectIndex).toBeGreaterThan(prepareIndex);
    expect(paintIndex).toBeGreaterThan(selectIndex);
    expect(runIndex).toBeGreaterThan(paintIndex);
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
    expect(source).toContain('failed ? "text-danger" : "text-muted-foreground hover:text-foreground"');
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
    expect(source).toContain("runHarnessCommand");
    expect(directShellSource).not.toContain('sandbox: "workspace-write"');
    expect(source).not.toContain("pendingBangCommand");
    expect(source).toContain("await dispatchBangCommand(request)");
    expect(directShellSource).not.toContain("ensureRun");
    expect(directShellSource).toContain("workspace: selectedReadyWorkspace.id");
    expect(source).not.toContain('status: "approval-required"');
    expect(source).toContain('!selectedReadyWorkspace || (!promptIsBangCommand && nativeCodexRequiredForSelectedAgent && !setupReady)');
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
    expect(agentSource).toContain("A model can act only through Harness-guarded tools");
  });
});
