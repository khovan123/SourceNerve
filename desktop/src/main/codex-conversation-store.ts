import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  DesktopHarnessCodexConversationMessage,
  DesktopHarnessCodexConversationView,
} from "../shared/harness-api";

const SCHEMA_VERSION = 1 as const;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES_PER_CONVERSATION = 200;
const MAX_MESSAGE_BYTES = 128 * 1024;

interface StoredConversation extends DesktopHarnessCodexConversationView {
  createdAt: string;
  updatedAt: string;
}

interface ConversationRegistry {
  schemaVersion: typeof SCHEMA_VERSION;
  conversations: StoredConversation[];
}

/**
 * Persists only the renderer-facing transcript for one Harness run.
 * Native thread/model history remains owned by Codex and is resumed through
 * CodexThreadStore; this store exists so SourceNerve can restore its chat UI
 * without depending on Codex full-history hydration semantics.
 */
export class CodexConversationStore {
  private conversations = new Map<string, StoredConversation>();
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const registry = await readRegistry(this.filePath);
    this.conversations = new Map(registry.conversations.map((conversation) => [conversation.runId, conversation]));
    this.initialized = true;
  }

  get(runId: string, workspace: string): DesktopHarnessCodexConversationView {
    this.assertInitialized();
    validateIdentifier(runId, "Codex conversation run id");
    validateIdentifier(workspace, "Codex conversation workspace id");
    const conversation = this.conversations.get(runId);
    if (!conversation) return { runId, workspace, messages: [] };
    if (conversation.workspace !== workspace) throw new Error("Codex conversation belongs to a different workspace");
    return cloneView(conversation);
  }

  async appendUser(input: {
    runId: string;
    workspace: string;
    messageId: string;
    text: string;
  }): Promise<void> {
    await this.append(input.runId, input.workspace, {
      id: input.messageId,
      role: "user",
      text: validateMessageText(input.text),
      createdAt: this.now().toISOString(),
    });
  }

  async appendAssistant(input: {
    runId: string;
    workspace: string;
    threadId: string;
    turnId: string;
    text: string;
  }): Promise<void> {
    validateIdentifier(input.threadId, "Codex conversation thread id");
    validateIdentifier(input.turnId, "Codex conversation turn id");
    await this.append(input.runId, input.workspace, {
      id: `assistant:${input.turnId}`,
      role: "assistant",
      text: validateMessageText(input.text),
      createdAt: this.now().toISOString(),
      turnId: input.turnId,
    }, input.threadId);
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async append(
    runId: string,
    workspace: string,
    message: DesktopHarnessCodexConversationMessage,
    threadId?: string,
  ): Promise<void> {
    this.assertInitialized();
    validateIdentifier(runId, "Codex conversation run id");
    validateIdentifier(workspace, "Codex conversation workspace id");
    validateIdentifier(message.id, "Codex conversation message id");
    const existing = this.conversations.get(runId);
    if (existing && existing.workspace !== workspace) throw new Error("Codex conversation belongs to a different workspace");
    if (existing?.messages.some((item) => item.id === message.id)) return;
    if (existing?.threadId && threadId && existing.threadId !== threadId) {
      throw new Error("Codex conversation is already bound to a different thread");
    }
    const timestamp = this.now().toISOString();
    const conversation: StoredConversation = existing
      ? {
          ...existing,
          ...(threadId ? { threadId } : {}),
          messages: [...existing.messages, { ...message }].slice(-MAX_MESSAGES_PER_CONVERSATION),
          updatedAt: timestamp,
        }
      : {
          runId,
          workspace,
          ...(threadId ? { threadId } : {}),
          messages: [{ ...message }],
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    this.conversations.set(runId, conversation);
    await this.enqueueWrite();
  }

  private enqueueWrite(): Promise<void> {
    const conversations = pruneRegistry([...this.conversations.values()]);
    this.conversations = new Map(conversations.map((conversation) => [conversation.runId, conversation]));
    const snapshot: ConversationRegistry = { schemaVersion: SCHEMA_VERSION, conversations };
    const write = this.writeQueue.then(() => writeRegistry(this.filePath, snapshot));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("Codex conversation store is not initialized");
  }
}

function cloneView(conversation: StoredConversation): DesktopHarnessCodexConversationView {
  return {
    runId: conversation.runId,
    workspace: conversation.workspace,
    ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
    messages: conversation.messages.map((message) => ({ ...message })),
  };
}

function pruneRegistry(input: StoredConversation[]): StoredConversation[] {
  const conversations = input
    .map((conversation) => ({ ...conversation, messages: conversation.messages.slice(-MAX_MESSAGES_PER_CONVERSATION) }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_CONVERSATIONS);
  while (serializedBytes(conversations) > MAX_FILE_BYTES && conversations.length > 0) {
    const oldest = conversations[conversations.length - 1]!;
    if (oldest.messages.length > 1) oldest.messages.shift();
    else conversations.pop();
  }
  if (serializedBytes(conversations) > MAX_FILE_BYTES) throw new Error("Codex conversation registry exceeds 2 MiB");
  return conversations;
}

async function readRegistry(filePath: string): Promise<ConversationRegistry> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_FILE_BYTES) throw new Error("Codex conversation registry exceeds 2 MiB");
    const parsed = JSON.parse(raw) as Partial<ConversationRegistry>;
    if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.conversations) || parsed.conversations.length > MAX_CONVERSATIONS) {
      throw new Error("unsupported Codex conversation registry schema");
    }
    const seen = new Set<string>();
    const conversations = parsed.conversations.map(validateConversation);
    for (const conversation of conversations) {
      if (seen.has(conversation.runId)) throw new Error("duplicate Codex conversation run id");
      seen.add(conversation.runId);
    }
    return { schemaVersion: SCHEMA_VERSION, conversations };
  } catch (error) {
    if (isMissing(error)) return { schemaVersion: SCHEMA_VERSION, conversations: [] };
    throw error;
  }
}

async function writeRegistry(filePath: string, registry: ConversationRegistry): Promise<void> {
  const serialized = `${JSON.stringify(registry, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) throw new Error("Codex conversation registry exceeds 2 MiB");
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function validateConversation(value: unknown): StoredConversation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Codex conversation");
  const record = value as Partial<StoredConversation>;
  validateIdentifier(record.runId, "Codex conversation run id");
  validateIdentifier(record.workspace, "Codex conversation workspace id");
  if (record.threadId !== undefined) validateIdentifier(record.threadId, "Codex conversation thread id");
  if (!Array.isArray(record.messages) || record.messages.length > MAX_MESSAGES_PER_CONVERSATION) throw new Error("invalid Codex conversation messages");
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) throw new Error("invalid Codex conversation createdAt");
  if (typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error("invalid Codex conversation updatedAt");
  return {
    runId: record.runId,
    workspace: record.workspace,
    ...(record.threadId ? { threadId: record.threadId } : {}),
    messages: record.messages.map(validateMessage),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function validateMessage(value: unknown): DesktopHarnessCodexConversationMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Codex conversation message");
  const record = value as Partial<DesktopHarnessCodexConversationMessage>;
  validateIdentifier(record.id, "Codex conversation message id");
  if (record.role !== "user" && record.role !== "assistant") throw new Error("invalid Codex conversation message role");
  if (record.turnId !== undefined) validateIdentifier(record.turnId, "Codex conversation turn id");
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) throw new Error("invalid Codex conversation message createdAt");
  return {
    id: record.id,
    role: record.role,
    text: validateMessageText(record.text),
    createdAt: record.createdAt,
    ...(record.turnId ? { turnId: record.turnId } : {}),
  };
}

function validateMessageText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || /\0/.test(value) || Buffer.byteLength(value, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("Codex conversation message text is invalid");
  }
  return value;
}

function serializedBytes(conversations: StoredConversation[]): number {
  return Buffer.byteLength(JSON.stringify({ schemaVersion: SCHEMA_VERSION, conversations }), "utf8");
}

function validateIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || /[\r\n\0]/.test(value)) throw new Error(`${label} is invalid`);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
