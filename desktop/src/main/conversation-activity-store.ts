import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DesktopRuntimeEvent } from "../shared/desktop-api";
import type { DesktopHarnessCodexActivityView, DesktopHarnessCodexConversationMessage, DesktopHarnessCodexConversationSummary } from "../shared/harness-api";

const STORE_VERSION = 2;
const LEGACY_ACTIVITY_STORE_VERSION = 1;
const MAX_EVENTS = 24_000;
const MAX_TEXT_CHARS = 160_000;
const FLUSH_DELAY_MS = 80;

type ProgressEvent = Extract<DesktopRuntimeEvent, { type: "chatgpt-progress" | "codex-progress" }>;

type ChatActivityEventType =
  | "assistant_text_delta"
  | "reasoning_delta"
  | "tool_call_started"
  | "tool_call_args"
  | "tool_call_output_delta"
  | "tool_call_finished"
  | "command_started"
  | "command_output_delta"
  | "command_finished"
  | "file_changed"
  | "file_diff"
  | "status";

export type ChatActivityEvent = {
  id: string;
  messageId: string;
  turnId: string;
  sequence: number;
  createdAt: string;
  parentId?: string;
  groupId?: string;
  activityId: string;
  source: "codex" | "chatgpt";
  runId: string;
  workspace: string;
  threadId?: string;
  itemId?: string;
  position: number;
  type: ChatActivityEventType;
  kind: DesktopHarnessCodexActivityView["kind"];
  stage: DesktopHarnessCodexActivityView["stage"];
  label: string;
  text?: string;
  toolName?: string;
  functionName?: string;
  parameters?: string;
  command?: string;
  cwd?: string;
  output?: string;
  result?: string;
  diff?: string;
  filePath?: string;
  additions?: number;
  deletions?: number;
  status?: string;
  exitCode?: number;
  durationMs?: number;
};

type PersistedState = {
  version: number;
  nextPosition: number;
  nextSequence: number;
  events: ChatActivityEvent[];
  messages?: PersistedConversationMessage[];
};

type PersistedConversationMessage = DesktopHarnessCodexConversationMessage & {
  runId: string;
  workspace: string;
  conversationId?: string;
};

type LegacyPersistedState = {
  version: number;
  nextPosition: number;
  activities: DesktopHarnessCodexActivityView[];
};

/**
 * Durable event-first ledger for the Claude-style execution timeline.
 *
 * The file on disk stores typed activity events, not a rendered transcript and
 * not a collapsed summary. UI rows are rebuilt by replaying the event log, so
 * reload/resume renders the same chronological execution timeline that streamed
 * live: output, tool call, result, file diff, command output, assistant output.
 */
export class ConversationActivityStore {
  private events: ChatActivityEvent[] = [];
  private activities: DesktopHarnessCodexActivityView[] = [];
  private messages: PersistedConversationMessage[] = [];
  private byId = new Map<string, number>();
  private nextPosition = 1;
  private nextSequence = 1;
  private flushTimer: NodeJS.Timeout | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState & LegacyPersistedState>;
      if (parsed.version === STORE_VERSION && Array.isArray(parsed.events)) {
        this.events = parsed.events.filter(isChatActivityEvent).slice(-MAX_EVENTS);
        this.messages = Array.isArray(parsed.messages) ? parsed.messages.filter(isPersistedConversationMessage).slice(-4_000) : [];
        this.nextSequence = Number.isSafeInteger(parsed.nextSequence)
          ? Math.max(Number(parsed.nextSequence), maxSequence(this.events) + 1)
          : maxSequence(this.events) + 1;
        this.nextPosition = Number.isSafeInteger(parsed.nextPosition)
          ? Math.max(Number(parsed.nextPosition), maxEventPosition(this.events) + 1)
          : maxEventPosition(this.events) + 1;
        this.replayEvents();
        return;
      }
      if (parsed.version === LEGACY_ACTIVITY_STORE_VERSION && Array.isArray(parsed.activities)) {
        this.activities = parsed.activities.filter(isActivity).slice(-MAX_EVENTS);
        this.nextPosition = Number.isSafeInteger(parsed.nextPosition)
          ? Math.max(Number(parsed.nextPosition), maxPosition(this.activities) + 1)
          : maxPosition(this.activities) + 1;
        this.events = this.activities.map((activity) => snapshotActivityEvent(activity, this.nextSequence++));
        this.reindex();
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  record(event: DesktopRuntimeEvent): DesktopRuntimeEvent[] {
    if (event.type !== "chatgpt-progress" && event.type !== "codex-progress") return [event];
    if (event.type === "chatgpt-progress" && event.kind === "reasoning") return [event];
    return normalizeProgressEvents(event).map((normalized) => this.recordProgress(normalized));
  }

  list(input: { workspace: string; runId: string; threadId?: string }): DesktopHarnessCodexActivityView[] {
    return this.activities
      .filter((activity) => activity.workspace === input.workspace && (
        activity.runId === input.runId || Boolean(input.threadId && activity.threadId === input.threadId)
      ))
      .sort((left, right) => left.position - right.position)
      .map(cloneActivity);
  }

  listConversationActivities(input: { workspace: string; conversationId: string; runId?: string }): DesktopHarnessCodexActivityView[] {
    const messages = this.messages.filter((message) =>
      message.workspace === input.workspace
      && message.conversationId === input.conversationId
    );
    const turnIds = new Set(messages.flatMap((message) => message.turnId ? [message.turnId] : []));
    const runIds = new Set(messages.map((message) => message.runId));
    return this.activities
      .filter((activity) => {
        if (activity.workspace !== input.workspace) return false;
        if (turnIds.has(activity.turnId)) return true;
        if (input.runId && activity.runId === input.runId) return true;
        return runIds.has(activity.runId) && activity.source === "chatgpt";
      })
      .sort((left, right) => left.position - right.position)
      .map(cloneActivity);
  }

  listEvents(input?: { workspace?: string; runId?: string; threadId?: string }): ChatActivityEvent[] {
    return this.events
      .filter((event) => input?.workspace === undefined || event.workspace === input.workspace)
      .filter((event) => input?.runId === undefined || event.runId === input.runId || Boolean(input.threadId && event.threadId === input.threadId))
      .filter((event) => input?.threadId === undefined || event.threadId === input.threadId)
      .sort((left, right) => left.sequence - right.sequence)
      .map(cloneEvent);
  }

  attachThread(runId: string, threadId: string): void {
    let changed = false;
    this.events = this.events.map((event) => {
      if (event.source !== "codex" || event.runId !== runId || event.threadId === threadId) return event;
      changed = true;
      return { ...event, threadId };
    });
    if (!changed) return;
    this.replayEvents();
    this.scheduleFlush();
  }

  recordMessage(message: PersistedConversationMessage): void {
    const index = this.messages.findIndex((entry) => entry.id === message.id);
    if (index >= 0) this.messages[index] = { ...message };
    else this.messages.push({ ...message });
    this.messages = this.messages.slice(-4_000);
    this.scheduleFlush();
  }

  conversationId(input: { workspace: string; runId: string }): string | undefined {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index]!;
      if (message.workspace === input.workspace && message.runId === input.runId && message.conversationId) {
        return message.conversationId;
      }
    }
    return undefined;
  }

  listConversationSummaries(workspace: string): DesktopHarnessCodexConversationSummary[] {
    const grouped = new Map<string, PersistedConversationMessage[]>();
    for (const message of this.messages) {
      if (message.workspace !== workspace || !message.conversationId) continue;
      const messages = grouped.get(message.conversationId) ?? [];
      messages.push(message);
      grouped.set(message.conversationId, messages);
    }
    return [...grouped.entries()].map(([conversationId, messages]) => {
      const sorted = [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const first = sorted[0]!;
      const latest = sorted[sorted.length - 1]!;
      const firstUser = sorted.find((message) => message.role === "user") ?? first;
      const latestAssistant = [...sorted].reverse().find((message) => message.role === "assistant");
      return {
        source: "chatgpt" as const,
        runId: latest.runId,
        conversationId,
        workspace,
        title: boundedConversationText(firstUser.text, "ChatGPT conversation"),
        preview: boundedConversationText(latestAssistant?.text ?? latest.text, "ChatGPT conversation"),
        createdAt: first.createdAt,
        updatedAt: latest.createdAt,
        model: "ChatGPT Web current model",
        status: "idle",
      };
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  listMessages(input: { workspace: string; runId: string; conversationId?: string }): DesktopHarnessCodexConversationMessage[] {
    const conversationId = input.conversationId ?? this.conversationId(input);
    return this.messages
      .filter((message) => {
        if (message.workspace !== input.workspace) return false;
        if (!conversationId) return message.runId === input.runId;
        if (message.conversationId === conversationId) return true;
        // Keep legacy messages from the selected run that predate logical
        // conversation ids, but never pull a different explicit conversation.
        return message.runId === input.runId && message.conversationId === undefined;
      })
      .map(({ runId: _runId, workspace: _workspace, conversationId: _conversationId, ...message }) => ({ ...message }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  clearWorkspace(workspace: string): void {
    const next = this.events.filter((event) => event.workspace !== workspace);
    const nextMessages = this.messages.filter((message) => message.workspace !== workspace);
    if (next.length === this.events.length && nextMessages.length === this.messages.length) return;
    this.events = next;
    this.messages = nextMessages;
    this.replayEvents();
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.enqueueWrite();
    }
    await this.writeQueue;
  }

  private recordProgress(event: ProgressEvent): DesktopRuntimeEvent {
    const now = event.createdAt ?? Date.now();
    const activityId = this.progressActivityId(event);
    const position = this.positionFor(activityId, event.position);
    const activity = this.activityFromEvent(event, now, activityId, position);
    const logEvents = this.logEventsFromProgress(event, activity, now);
    this.events.push(...logEvents);
    this.upsertActivity(activity, event);
    this.trimEvents();
    this.scheduleFlush();
    return {
      ...event,
      activityId: activity.id,
      position: activity.position,
      createdAt: Date.parse(activity.createdAt),
    } as DesktopRuntimeEvent;
  }


  private progressActivityId(event: ProgressEvent): string {
    if (event.activityId) return event.activityId;
    if (event.type === "chatgpt-progress" && event.kind === "tool") {
      const signature = chatGptToolSignature(event);
      const identity = chatGptToolIdentity(event);
      const parameters = (event.parameters || event.input || "").trim();
      const turnId = `chatgpt-review:${event.taskId}`;
      if (event.itemId) {
        const existingByItemId = [...this.activities].reverse().find((activity) =>
          activity.source === "chatgpt"
          && activity.runId === event.runId
          && activity.turnId === turnId
          && activity.kind === "tool"
          && activity.itemId === event.itemId
        );
        if (existingByItemId) return existingByItemId.id;
        const itemActivityId = progressActivityId(event);
        if (this.byId.has(itemActivityId)) return itemActivityId;
      }
      const candidates = [...this.activities].reverse().filter((activity) =>
        activity.source === "chatgpt"
        && activity.runId === event.runId
        && activity.turnId === turnId
        && activity.kind === "tool"
        && activity.stage !== "completed"
        && activity.stage !== "failed"
      );
      const exact = candidates.find((activity) => chatGptActivityToolSignature(activity) === signature);
      if (exact) return exact.id;
      const compatible = candidates.find((activity) =>
        chatGptActivityToolIdentity(activity) === identity
        && (!parameters || !activity.parameters?.trim() || activity.parameters.trim() === parameters)
      );
      if (compatible) return compatible.id;
      if (event.itemId) return progressActivityId(event);
      const suffix = createHash("sha1").update(signature).digest("hex").slice(0, 12);
      return `chatgpt:${event.runId}:${event.taskId}:tool:${suffix}:${this.nextPosition}`;
    }
    return progressActivityId(event);
  }

  private positionFor(activityId: string, incomingPosition: number | undefined): number {
    const existingIndex = this.byId.get(activityId);
    if (existingIndex !== undefined) return this.activities[existingIndex]!.position;
    if (incomingPosition !== undefined && Number.isFinite(incomingPosition)) {
      this.nextPosition = Math.max(this.nextPosition, Math.floor(incomingPosition) + 1);
      return Math.floor(incomingPosition);
    }
    return this.nextPosition++;
  }

  private activityFromEvent(
    event: ProgressEvent,
    now: number,
    activityId: string,
    position: number,
  ): DesktopHarnessCodexActivityView {
    const createdAt = new Date(now).toISOString();
    if (event.type === "codex-progress") {
      return compactActivity({
        id: activityId,
        source: "codex",
        runId: event.runId,
        workspace: event.workspace,
        ...(event.threadId ? { threadId: event.threadId } : {}),
        turnId: event.turnId,
        itemId: event.itemId,
        kind: event.kind,
        stage: event.stage,
        label: event.label,
        createdAt,
        updatedAt: createdAt,
        position,
        ...(event.text ? { text: event.text } : {}),
        ...(event.command ? { command: event.command } : {}),
        ...(event.cwd ? { cwd: event.cwd } : {}),
        ...(event.functionName ? { functionName: event.functionName } : {}),
        ...(event.parameters ? { parameters: event.parameters } : {}),
        ...(event.output ? { output: event.output } : {}),
        ...(event.diff ? { diff: event.diff } : {}),
        ...(event.filePath ? { filePath: event.filePath } : {}),
        ...(event.additions !== undefined ? { additions: event.additions } : {}),
        ...(event.deletions !== undefined ? { deletions: event.deletions } : {}),
        ...(event.status ? { status: event.status } : {}),
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      });
    }

    const label = chatGptLabel(event);
    return compactActivity({
      id: activityId,
      source: "chatgpt",
      runId: event.runId,
      workspace: event.workspace,
      turnId: `chatgpt-review:${event.taskId}`,
      ...(event.itemId ? { itemId: event.itemId } : {}),
      kind: event.kind === "diff" ? "file" : event.kind,
      stage: chatGptStage(event),
      label,
      createdAt,
      updatedAt: createdAt,
      position,
      ...(event.kind === "response" || event.kind === "reasoning" ? { text: event.text } : {}),
      ...(event.functionName ? { functionName: event.functionName } : {}),
      ...(event.parameters ?? event.input ? { parameters: event.parameters ?? event.input } : {}),
      ...(event.output ? { output: event.output } : {}),
      ...(event.kind === "diff" ? { diff: event.text } : {}),
      ...(event.filePath ? { filePath: event.filePath } : {}),
      ...(event.additions !== undefined ? { additions: event.additions } : {}),
      ...(event.deletions !== undefined ? { deletions: event.deletions } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.stage ? { status: event.stage } : {}),
    });
  }

  private logEventsFromProgress(
    event: ProgressEvent,
    activity: DesktopHarnessCodexActivityView,
    now: number,
  ): ChatActivityEvent[] {
    const createdAt = new Date(now).toISOString();
    const base = (): Omit<ChatActivityEvent, "id" | "sequence" | "type"> => ({
      messageId: activity.turnId,
      turnId: activity.turnId,
      createdAt,
      parentId: activity.id,
      groupId: `${activity.runId}:${activity.turnId}`,
      activityId: activity.id,
      source: activity.source,
      runId: activity.runId,
      workspace: activity.workspace,
      ...(activity.threadId ? { threadId: activity.threadId } : {}),
      ...(activity.itemId ? { itemId: activity.itemId } : {}),
      position: activity.position,
      kind: activity.kind,
      stage: activity.stage,
      label: activity.label,
      ...(activity.text ? { text: activity.text } : {}),
      ...(activity.functionName ? { functionName: activity.functionName, toolName: activity.functionName } : {}),
      ...(activity.parameters ? { parameters: activity.parameters } : {}),
      ...(activity.command ? { command: activity.command } : {}),
      ...(activity.cwd ? { cwd: activity.cwd } : {}),
      ...(activity.output ? { output: activity.output, result: activity.output } : {}),
      ...(activity.diff ? { diff: activity.diff } : {}),
      ...(activity.filePath ? { filePath: activity.filePath } : {}),
      ...(activity.additions !== undefined ? { additions: activity.additions } : {}),
      ...(activity.deletions !== undefined ? { deletions: activity.deletions } : {}),
      ...(activity.status ? { status: activity.status } : {}),
      ...(activity.exitCode !== undefined ? { exitCode: activity.exitCode } : {}),
      ...(activity.durationMs !== undefined ? { durationMs: activity.durationMs } : {}),
    });
    const push = (type: ChatActivityEventType, overrides: Partial<ChatActivityEvent> = {}): ChatActivityEvent => {
      const sequence = this.nextSequence++;
      const candidate = compactEvent({
        ...base(),
        ...overrides,
        type,
        sequence,
        id: `${type}:${activity.id}:${sequence}`,
      } as ChatActivityEvent);
      return candidate;
    };

    if (activity.kind === "response") return [push("assistant_text_delta")];
    if (activity.kind === "reasoning") return [push("reasoning_delta")];
    if (activity.kind === "command") {
      if (activity.stage === "started") return [push("command_started")];
      if (activity.stage === "streaming") return [push("command_output_delta")];
      return [push("command_finished")];
    }
    if (activity.kind === "file") {
      if (activity.diff) return [push("file_diff")];
      return [push("file_changed")];
    }
    if (activity.kind === "tool") {
      if (activity.stage === "started") {
        const events = [push("tool_call_started")];
        if (activity.parameters) events.push(push("tool_call_args"));
        return events;
      }
      if (activity.stage === "streaming") return [push("tool_call_output_delta")];
      const events: ChatActivityEvent[] = [];
      if (activity.parameters) events.push(push("tool_call_args"));
      events.push(push("tool_call_finished", { result: activity.output }));
      return events;
    }
    return [push("status", { status: event.type })];
  }

  private upsertActivity(activity: DesktopHarnessCodexActivityView, event: ProgressEvent): void {
    const existingIndex = this.byId.get(activity.id);
    if (existingIndex === undefined) {
      this.activities.push(activity);
      this.byId.set(activity.id, this.activities.length - 1);
      return;
    }
    const previous = this.activities[existingIndex]!;
    this.activities[existingIndex] = mergeActivity(previous, activity, event);
  }

  private trimEvents(): void {
    if (this.events.length <= MAX_EVENTS) return;
    this.events = this.events.slice(this.events.length - MAX_EVENTS);
    this.replayEvents();
    this.nextPosition = Math.max(this.nextPosition, maxPosition(this.activities) + 1);
    this.nextSequence = Math.max(this.nextSequence, maxSequence(this.events) + 1);
  }

  private replayEvents(): void {
    this.activities = [];
    this.reindex();
    for (const event of [...this.events].sort((left, right) => left.sequence - right.sequence)) {
      this.applyLogEvent(event);
    }
  }

  private applyLogEvent(event: ChatActivityEvent): void {
    const incoming = activityFromLogEvent(event);
    const existingIndex = this.byId.get(incoming.id);
    if (existingIndex === undefined) {
      this.activities.push(incoming);
      this.byId.set(incoming.id, this.activities.length - 1);
      return;
    }
    const previous = this.activities[existingIndex]!;
    this.activities[existingIndex] = mergeActivityFromLog(previous, incoming, event);
  }

  private reindex(): void {
    this.byId = new Map(this.activities.map((activity, index) => [activity.id, index]));
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.enqueueWrite();
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  private enqueueWrite(): void {
    const snapshot: PersistedState = {
      version: STORE_VERSION,
      nextPosition: this.nextPosition,
      nextSequence: this.nextSequence,
      events: this.events.map(cloneEvent),
      messages: this.messages.map((message) => ({ ...message })),
    };
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    }).catch(() => undefined);
  }
}


function isPersistedConversationMessage(value: unknown): value is PersistedConversationMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<PersistedConversationMessage>;
  return typeof message.id === "string"
    && (message.role === "user" || message.role === "assistant")
    && typeof message.text === "string"
    && typeof message.createdAt === "string"
    && typeof message.runId === "string"
    && typeof message.workspace === "string"
    && (message.conversationId === undefined || typeof message.conversationId === "string")
    && (message.turnId === undefined || typeof message.turnId === "string");
}

function mergeActivity(
  previous: DesktopHarnessCodexActivityView,
  incoming: DesktopHarnessCodexActivityView,
  event: ProgressEvent,
): DesktopHarnessCodexActivityView {
  const appendDelta = event.type === "codex-progress" && event.stage === "streaming";
  return compactActivity({
    ...previous,
    ...incoming,
    id: previous.id,
    position: previous.position,
    createdAt: previous.createdAt,
    updatedAt: incoming.updatedAt,
    stage: strongestActivityStage(previous.stage, incoming.stage),
    ...(incoming.threadId ?? previous.threadId ? { threadId: incoming.threadId ?? previous.threadId } : {}),
    ...(incoming.itemId ?? previous.itemId ? { itemId: incoming.itemId ?? previous.itemId } : {}),
    ...(incoming.text ? {
      text: appendDelta && (incoming.kind === "response" || incoming.kind === "reasoning")
        ? bounded(`${previous.text ?? ""}${incoming.text}`)
        : bounded(incoming.text),
    } : previous.text ? { text: previous.text } : {}),
    ...(incoming.output ? {
      output: appendDelta ? bounded(`${previous.output ?? ""}${incoming.output}`) : bounded(incoming.output),
    } : previous.output ? { output: previous.output } : {}),
    ...(incoming.diff ? { diff: bounded(incoming.diff) } : previous.diff ? { diff: previous.diff } : {}),
    ...(incoming.command ? { command: incoming.command } : previous.command ? { command: previous.command } : {}),
    ...(incoming.cwd ? { cwd: incoming.cwd } : previous.cwd ? { cwd: previous.cwd } : {}),
    ...(incoming.functionName ? { functionName: incoming.functionName } : previous.functionName ? { functionName: previous.functionName } : {}),
    ...(incoming.parameters ? { parameters: incoming.parameters } : previous.parameters ? { parameters: previous.parameters } : {}),
    ...(incoming.filePath ? { filePath: incoming.filePath } : previous.filePath ? { filePath: previous.filePath } : {}),
    ...(incoming.additions !== undefined ? { additions: incoming.additions } : previous.additions !== undefined ? { additions: previous.additions } : {}),
    ...(incoming.deletions !== undefined ? { deletions: incoming.deletions } : previous.deletions !== undefined ? { deletions: previous.deletions } : {}),
    ...(incoming.status ? { status: incoming.status } : previous.status ? { status: previous.status } : {}),
    ...(incoming.exitCode !== undefined ? { exitCode: incoming.exitCode } : previous.exitCode !== undefined ? { exitCode: previous.exitCode } : {}),
    ...(incoming.durationMs !== undefined ? { durationMs: incoming.durationMs } : previous.durationMs !== undefined ? { durationMs: previous.durationMs } : {}),
  });
}

function mergeActivityFromLog(
  previous: DesktopHarnessCodexActivityView,
  incoming: DesktopHarnessCodexActivityView,
  event: ChatActivityEvent,
): DesktopHarnessCodexActivityView {
  const appendText = (event.type === "assistant_text_delta" || event.type === "reasoning_delta") && event.stage === "streaming";
  const appendOutput = event.type === "command_output_delta" || event.type === "tool_call_output_delta";
  return compactActivity({
    ...previous,
    ...incoming,
    id: previous.id,
    position: previous.position,
    createdAt: previous.createdAt,
    updatedAt: incoming.updatedAt,
    stage: strongestActivityStage(previous.stage, incoming.stage),
    ...(incoming.threadId ?? previous.threadId ? { threadId: incoming.threadId ?? previous.threadId } : {}),
    ...(incoming.itemId ?? previous.itemId ? { itemId: incoming.itemId ?? previous.itemId } : {}),
    ...(incoming.text ? {
      text: appendText ? bounded(`${previous.text ?? ""}${incoming.text}`) : bounded(incoming.text),
    } : previous.text ? { text: previous.text } : {}),
    ...(incoming.output ? {
      output: appendOutput ? bounded(`${previous.output ?? ""}${incoming.output}`) : bounded(incoming.output),
    } : previous.output ? { output: previous.output } : {}),
    ...(incoming.diff ? { diff: bounded(incoming.diff) } : previous.diff ? { diff: previous.diff } : {}),
    ...(incoming.command ? { command: incoming.command } : previous.command ? { command: previous.command } : {}),
    ...(incoming.cwd ? { cwd: incoming.cwd } : previous.cwd ? { cwd: previous.cwd } : {}),
    ...(incoming.functionName ? { functionName: incoming.functionName } : previous.functionName ? { functionName: previous.functionName } : {}),
    ...(incoming.parameters ? { parameters: incoming.parameters } : previous.parameters ? { parameters: previous.parameters } : {}),
    ...(incoming.filePath ? { filePath: incoming.filePath } : previous.filePath ? { filePath: previous.filePath } : {}),
    ...(incoming.additions !== undefined ? { additions: incoming.additions } : previous.additions !== undefined ? { additions: previous.additions } : {}),
    ...(incoming.deletions !== undefined ? { deletions: incoming.deletions } : previous.deletions !== undefined ? { deletions: previous.deletions } : {}),
  });
}

function activityFromLogEvent(event: ChatActivityEvent): DesktopHarnessCodexActivityView {
  return compactActivity({
    id: event.activityId,
    source: event.source,
    runId: event.runId,
    workspace: event.workspace,
    ...(event.threadId ? { threadId: event.threadId } : {}),
    turnId: event.turnId,
    ...(event.itemId ? { itemId: event.itemId } : {}),
    kind: event.kind,
    stage: event.stage,
    label: event.label,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
    position: event.position,
    ...(event.text ? { text: event.text } : {}),
    ...(event.command ? { command: event.command } : {}),
    ...(event.cwd ? { cwd: event.cwd } : {}),
    ...(event.functionName ? { functionName: event.functionName } : {}),
    ...(event.parameters ? { parameters: event.parameters } : {}),
    ...(event.output ?? event.result ? { output: event.output ?? event.result } : {}),
    ...(event.diff ? { diff: event.diff } : {}),
    ...(event.filePath ? { filePath: event.filePath } : {}),
    ...(event.additions !== undefined ? { additions: event.additions } : {}),
    ...(event.deletions !== undefined ? { deletions: event.deletions } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
  });
}

function snapshotActivityEvent(activity: DesktopHarnessCodexActivityView, sequence: number): ChatActivityEvent {
  const type: ChatActivityEventType = activity.kind === "response"
    ? "assistant_text_delta"
    : activity.kind === "reasoning"
      ? "reasoning_delta"
      : activity.kind === "command"
        ? activity.stage === "completed" || activity.stage === "failed" ? "command_finished" : "command_started"
        : activity.kind === "file"
          ? activity.diff ? "file_diff" : "file_changed"
          : activity.stage === "completed" || activity.stage === "failed" ? "tool_call_finished" : "tool_call_started";
  return compactEvent({
    id: `${type}:${activity.id}:${sequence}`,
    messageId: activity.turnId,
    turnId: activity.turnId,
    sequence,
    createdAt: activity.createdAt,
    parentId: activity.id,
    groupId: `${activity.runId}:${activity.turnId}`,
    activityId: activity.id,
    source: activity.source,
    runId: activity.runId,
    workspace: activity.workspace,
    ...(activity.threadId ? { threadId: activity.threadId } : {}),
    ...(activity.itemId ? { itemId: activity.itemId } : {}),
    position: activity.position,
    type,
    kind: activity.kind,
    stage: activity.stage,
    label: activity.label,
    ...(activity.text ? { text: activity.text } : {}),
    ...(activity.functionName ? { functionName: activity.functionName, toolName: activity.functionName } : {}),
    ...(activity.parameters ? { parameters: activity.parameters } : {}),
    ...(activity.command ? { command: activity.command } : {}),
    ...(activity.cwd ? { cwd: activity.cwd } : {}),
    ...(activity.output ? { output: activity.output, result: activity.output } : {}),
    ...(activity.diff ? { diff: activity.diff } : {}),
    ...(activity.filePath ? { filePath: activity.filePath } : {}),
    ...(activity.additions !== undefined ? { additions: activity.additions } : {}),
    ...(activity.deletions !== undefined ? { deletions: activity.deletions } : {}),
    ...(activity.status ? { status: activity.status } : {}),
    ...(activity.exitCode !== undefined ? { exitCode: activity.exitCode } : {}),
    ...(activity.durationMs !== undefined ? { durationMs: activity.durationMs } : {}),
  });
}

function strongestActivityStage(
  left: DesktopHarnessCodexActivityView["stage"],
  right: DesktopHarnessCodexActivityView["stage"],
): DesktopHarnessCodexActivityView["stage"] {
  if (left === "failed" || right === "failed") return "failed";
  if (left === "completed" || right === "completed") return "completed";
  if (left === "streaming" || right === "streaming") return "streaming";
  return "started";
}

function chatGptToolSignature(event: Extract<ProgressEvent, { type: "chatgpt-progress" }>): string {
  const label = chatGptLabel(event);
  const tool = event.functionName || label;
  const parameters = event.parameters || event.input || "";
  return `${tool.trim()}\n${parameters.trim()}`;
}

function chatGptToolIdentity(event: Extract<ProgressEvent, { type: "chatgpt-progress" }>): string {
  return (event.functionName || chatGptLabel(event)).trim();
}

function chatGptActivityToolSignature(activity: DesktopHarnessCodexActivityView): string {
  const tool = activity.functionName || activity.label;
  const parameters = activity.parameters || "";
  return `${tool.trim()}\n${parameters.trim()}`;
}

function chatGptActivityToolIdentity(activity: DesktopHarnessCodexActivityView): string {
  return (activity.functionName || activity.label).trim();
}

function progressActivityId(event: ProgressEvent): string {
  if (event.activityId) return event.activityId;
  if (event.type === "codex-progress") return `codex:${event.threadId ?? event.runId}:${event.turnId}:${event.itemId}:${event.kind}`;
  const label = chatGptLabel(event);
  if (event.kind === "diff") {
    const subject = event.filePath || "working-tree";
    const suffix = createHash("sha1").update(subject).digest("hex").slice(0, 12);
    return `chatgpt:${event.runId}:${event.taskId}:diff:${suffix}`;
  }
  if (event.itemId) return `chatgpt:${event.runId}:${event.taskId}:${event.kind}:${event.itemId}`;
  if (event.kind === "response") return `chatgpt:${event.runId}:${event.taskId}:response`;
  const fingerprint = createHash("sha1").update(`${event.kind}:${event.stage ?? ""}:${label}:${event.text}`).digest("hex").slice(0, 12);
  return `chatgpt:${event.runId}:${event.taskId}:${event.kind}:${fingerprint}`;
}

function chatGptLabel(event: Extract<ProgressEvent, { type: "chatgpt-progress" }>): string {
  if (event.kind === "response") return "Response";
  if (event.kind === "reasoning") return event.text.trim().split("\n", 1)[0]?.slice(0, 180) || "Working";
  if (event.kind === "diff") return event.filePath ? `Edited ${basename(event.filePath)}` : "Changed files";
  return event.text.split(/\s+·\s+/, 1)[0]?.trim() || event.functionName || "Tool call";
}

function chatGptStage(event: Extract<ProgressEvent, { type: "chatgpt-progress" }>): DesktopHarnessCodexActivityView["stage"] {
  if (event.kind === "response") return event.generating === false ? "completed" : "streaming";
  if (/failed|blocked|error/i.test(event.stage ?? "")) return "failed";
  if (/result|completed|success/i.test(event.stage ?? "")) return "completed";
  if (/stream/i.test(event.stage ?? "")) return "streaming";
  if (event.kind === "diff" || event.kind === "reasoning") return "completed";
  return "started";
}

function compactActivity(activity: DesktopHarnessCodexActivityView): DesktopHarnessCodexActivityView {
  return {
    ...activity,
    ...(activity.text ? { text: bounded(activity.text) } : {}),
    ...(activity.command ? { command: bounded(activity.command) } : {}),
    ...(activity.parameters ? { parameters: bounded(activity.parameters) } : {}),
    ...(activity.output ? { output: bounded(activity.output) } : {}),
    ...(activity.diff ? { diff: bounded(activity.diff) } : {}),
  };
}

function compactEvent(event: ChatActivityEvent): ChatActivityEvent {
  return {
    ...event,
    ...(event.text ? { text: bounded(event.text) } : {}),
    ...(event.command ? { command: bounded(event.command) } : {}),
    ...(event.parameters ? { parameters: bounded(event.parameters) } : {}),
    ...(event.output ? { output: bounded(event.output) } : {}),
    ...(event.result ? { result: bounded(event.result) } : {}),
    ...(event.diff ? { diff: bounded(event.diff) } : {}),
  };
}

function normalizeProgressEvents(event: ProgressEvent): ProgressEvent[] {
  const diff = event.type === "codex-progress"
    ? event.kind === "file" ? event.diff : undefined
    : event.kind === "diff" ? event.text : undefined;
  if (!diff) return [event];
  const sections = splitUnifiedDiffByFile(diff);
  if (sections.length <= 1) {
    const only = sections[0];
    if (!only) return [event];
    const stats = diffStats(only.diff);
    if (event.type === "codex-progress") {
      return [{
        ...event,
        ...(only.path ? { filePath: only.path, label: `Edited ${basename(only.path)}` } : {}),
        additions: stats.additions,
        deletions: stats.deletions,
      }];
    }
    return [{
      ...event,
      ...(only.path ? { filePath: only.path } : {}),
      additions: stats.additions,
      deletions: stats.deletions,
    }];
  }

  return sections.map((section, index) => {
    const stats = diffStats(section.diff);
    const suffix = createHash("sha1").update(section.path || String(index)).digest("hex").slice(0, 10);
    if (event.type === "codex-progress") {
      return {
        ...event,
        itemId: `${event.itemId}:file:${suffix}`,
        label: section.path ? `Edited ${basename(section.path)}` : event.label,
        diff: section.diff,
        ...(section.path ? { filePath: section.path } : {}),
        additions: stats.additions,
        deletions: stats.deletions,
      };
    }
    return {
      ...event,
      itemId: `diff-file:${suffix}`,
      text: section.diff,
      ...(section.path ? { filePath: section.path } : {}),
      additions: stats.additions,
      deletions: stats.deletions,
    };
  });
}

function splitUnifiedDiffByFile(diff: string): Array<{ path: string; diff: string }> {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const sections: Array<{ path: string; diff: string }> = [];
  let current: string[] = [];
  let oldPath = "";
  let newPath = "";
  const flush = () => {
    if (current.length === 0) return;
    sections.push({ path: newPath || oldPath, diff: current.join("\n") });
    current = [];
    oldPath = "";
    newPath = "";
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) flush();
    if (line.startsWith("--- ")) oldPath = normalizeDiffPath(line.slice(4));
    if (line.startsWith("+++ ")) newPath = normalizeDiffPath(line.slice(4));
    current.push(line);
  }
  flush();
  if (sections.length === 0) return [{ path: "", diff }];
  return sections;
}

function normalizeDiffPath(value: string): string {
  const trimmed = value.trim().split("\t", 1)[0]?.trim() ?? "";
  if (!trimmed || trimmed === "/dev/null") return "";
  return trimmed.replace(/^[ab]\//, "");
}

function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function bounded(value: string): string {
  if (value.length <= MAX_TEXT_CHARS) return value;
  return `${value.slice(value.length - MAX_TEXT_CHARS + 1)}…`;
}

function cloneActivity(activity: DesktopHarnessCodexActivityView): DesktopHarnessCodexActivityView {
  return { ...activity };
}

function cloneEvent(event: ChatActivityEvent): ChatActivityEvent {
  return { ...event };
}

function maxPosition(activities: readonly DesktopHarnessCodexActivityView[]): number {
  return activities.reduce((maximum, activity) => Math.max(maximum, activity.position), 0);
}

function maxEventPosition(events: readonly ChatActivityEvent[]): number {
  return events.reduce((maximum, event) => Math.max(maximum, event.position), 0);
}

function maxSequence(events: readonly ChatActivityEvent[]): number {
  return events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0);
}

function isActivity(value: unknown): value is DesktopHarnessCodexActivityView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const activity = value as Partial<DesktopHarnessCodexActivityView>;
  return typeof activity.id === "string"
    && (activity.source === "codex" || activity.source === "chatgpt")
    && typeof activity.runId === "string"
    && typeof activity.workspace === "string"
    && typeof activity.turnId === "string"
    && typeof activity.position === "number"
    && typeof activity.createdAt === "string"
    && typeof activity.updatedAt === "string"
    && ["response", "reasoning", "command", "file", "tool"].includes(String(activity.kind))
    && ["started", "streaming", "completed", "failed"].includes(String(activity.stage));
}

function isChatActivityEvent(value: unknown): value is ChatActivityEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<ChatActivityEvent>;
  return typeof event.id === "string"
    && typeof event.messageId === "string"
    && typeof event.turnId === "string"
    && typeof event.sequence === "number"
    && typeof event.createdAt === "string"
    && typeof event.activityId === "string"
    && typeof event.runId === "string"
    && typeof event.workspace === "string"
    && typeof event.position === "number"
    && (event.source === "codex" || event.source === "chatgpt")
    && [
      "assistant_text_delta",
      "reasoning_delta",
      "tool_call_started",
      "tool_call_args",
      "tool_call_output_delta",
      "tool_call_finished",
      "command_started",
      "command_output_delta",
      "command_finished",
      "file_changed",
      "file_diff",
      "status",
    ].includes(String(event.type))
    && ["response", "reasoning", "command", "file", "tool"].includes(String(event.kind))
    && ["started", "streaming", "completed", "failed"].includes(String(event.stage));
}

function boundedConversationText(value: string, fallback: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return fallback;
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}…`;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
