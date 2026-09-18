import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProviderFrontendBinding } from "./provider-frontend-session";

export type BrowserCommandStage = "queued" | "inserted" | "clicked" | "accepted" | "streaming" | "stable" | "failed" | "cancelled";

export interface BrowserCommandSnapshot {
  commandId: string;
  taskId: string;
  runId: string;
  workspace: string;
  stage: BrowserCommandStage;
  epoch: number;
  providerFrontendId: string;
  providerConversationId?: string;
  logicalConversationId?: string;
  providerTurnId?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface ChatGptWorkspaceProjectBinding {
  workspace: string;
  projectName: string;
  projectId: string;
  projectUrl: string;
  updatedAt: number;
}

export interface ChatGptConversationBinding {
  workspace: string;
  projectId: string;
  logicalConversationId: string;
  providerConversationId: string;
  updatedAt: number;
}

export interface BrowserCommandJournal {
  schemaVersion: 4;
  commands: BrowserCommandSnapshot[];
  projects: ChatGptWorkspaceProjectBinding[];
  conversations: ChatGptConversationBinding[];
}

const MAX_COMMANDS = 128;

export class BrowserCommandStateStore {
  constructor(private readonly filePath: string) {}

  async record(input: {
    commandId: string;
    taskId: string;
    binding: ProviderFrontendBinding;
    stage: BrowserCommandStage;
    logicalConversationId?: string;
    error?: string;
    now?: number;
  }): Promise<BrowserCommandSnapshot> {
    const now = input.now ?? Date.now();
    const journal = await this.load();
    const existing = journal.commands.find((item) => item.commandId === input.commandId);
    const next: BrowserCommandSnapshot = {
      commandId: bounded(input.commandId, "browser command id"),
      taskId: bounded(input.taskId, "browser command task id"),
      runId: input.binding.source.runId,
      workspace: input.binding.source.workspace,
      stage: input.stage,
      epoch: input.binding.frontend.epoch,
      providerFrontendId: input.binding.frontend.documentId,
      ...(input.binding.frontend.conversationId ? { providerConversationId: input.binding.frontend.conversationId } : {}),
      ...(input.logicalConversationId ? { logicalConversationId: input.logicalConversationId } : existing?.logicalConversationId ? { logicalConversationId: existing.logicalConversationId } : {}),
      ...(input.binding.frontend.turnId ? { providerTurnId: input.binding.frontend.turnId } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(input.error ? { error: boundText(input.error, 1024) } : {}),
    };
    const kept = journal.commands.filter((item) => item.commandId !== input.commandId);
    kept.push(next);
    journal.commands = kept.slice(-MAX_COMMANDS);
    if (next.logicalConversationId && next.providerConversationId) {
      const project = journal.projects.find((item) => item.workspace === next.workspace);
      if (project) {
        const binding: ChatGptConversationBinding = {
          workspace: next.workspace,
          projectId: project.projectId,
          logicalConversationId: next.logicalConversationId,
          providerConversationId: next.providerConversationId,
          updatedAt: now,
        };
        journal.conversations = [
          ...journal.conversations.filter((item) => !(item.workspace === binding.workspace && item.logicalConversationId === binding.logicalConversationId)),
          binding,
        ];
      }
    }
    await this.save(journal);
    return next;
  }

  async latestProviderConversationId(input: { workspace: string; logicalConversationId: string }): Promise<string | undefined> {
    const journal = await this.load();
    const project = journal.projects.find((item) => item.workspace === input.workspace);
    if (!project) return undefined;
    return journal.conversations.find((item) => item.workspace === input.workspace
      && item.projectId === project.projectId
      && item.logicalConversationId === input.logicalConversationId)?.providerConversationId;
  }

  async clearProviderConversation(input: { workspace: string; logicalConversationId: string }): Promise<void> {
    const journal = await this.load();
    const next = journal.conversations.filter((item) => !(item.workspace === input.workspace && item.logicalConversationId === input.logicalConversationId));
    if (next.length === journal.conversations.length) return;
    journal.conversations = next;
    await this.save(journal);
  }

  async workspaceProject(workspace: string): Promise<ChatGptWorkspaceProjectBinding | undefined> {
    const journal = await this.load();
    return journal.projects.find((item) => item.workspace === workspace);
  }

  async recordWorkspaceProject(input: { workspace: string; projectName: string; projectUrl: string; now?: number }): Promise<ChatGptWorkspaceProjectBinding> {
    const projectUrl = normalizeChatGptProjectUrl(input.projectUrl);
    const binding: ChatGptWorkspaceProjectBinding = {
      workspace: bounded(input.workspace, "workspace"),
      projectName: boundedProjectName(input.projectName),
      projectId: chatGptProjectId(projectUrl),
      projectUrl,
      updatedAt: input.now ?? Date.now(),
    };
    const journal = await this.load();
    const previous = journal.projects.find((item) => item.workspace === binding.workspace);
    journal.projects = [...journal.projects.filter((item) => item.workspace !== binding.workspace), binding];
    if (previous && previous.projectId !== binding.projectId) {
      journal.conversations = journal.conversations.filter((item) => item.workspace !== binding.workspace || item.projectId === binding.projectId);
    }
    await this.save(journal);
    return binding;
  }

  async clearWorkspaceProject(workspace: string): Promise<void> {
    const journal = await this.load();
    const next = journal.projects.filter((item) => item.workspace !== workspace);
    if (next.length === journal.projects.length) return;
    journal.projects = next;
    await this.save(journal);
  }

  async snapshot(): Promise<BrowserCommandJournal> {
    return this.load();
  }

  private async load(): Promise<BrowserCommandJournal> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyJournal();
      const value = parsed as { schemaVersion?: unknown; commands?: unknown; projects?: unknown; conversations?: unknown };
      if ((value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3 && value.schemaVersion !== 4) || !Array.isArray(value.commands)) return emptyJournal();
      const commands = value.commands.filter(isSnapshot).slice(-MAX_COMMANDS);
      const projects = Array.isArray(value.projects)
        ? value.projects.map(normalizeWorkspaceProjectBinding).filter((item): item is ChatGptWorkspaceProjectBinding => Boolean(item))
        : [];
      const conversations = value.schemaVersion >= 3 && Array.isArray(value.conversations)
        ? value.conversations.map((item) => normalizeConversationBinding(item, projects)).filter((item): item is ChatGptConversationBinding => Boolean(item))
        : deriveConversationBindings(commands, projects);
      return { schemaVersion: 4, commands, projects, conversations };
    } catch {
      return emptyJournal();
    }
  }

  private async save(journal: BrowserCommandJournal): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  }
}

export function browserCommandStatePath(userDataPath: string): string {
  return path.join(userDataPath, "state", "chatgpt-browser-commands.json");
}

function emptyJournal(): BrowserCommandJournal {
  return { schemaVersion: 4, commands: [], projects: [], conversations: [] };
}

function isSnapshot(value: unknown): value is BrowserCommandSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.commandId === "string"
    && typeof item.taskId === "string"
    && typeof item.runId === "string"
    && typeof item.workspace === "string"
    && isStage(item.stage)
    && Number.isSafeInteger(item.epoch)
    && typeof item.providerFrontendId === "string"
    && (item.logicalConversationId === undefined || typeof item.logicalConversationId === "string")
    && Number.isSafeInteger(item.createdAt)
    && Number.isSafeInteger(item.updatedAt);
}

function isStage(value: unknown): value is BrowserCommandStage {
  return value === "queued" || value === "inserted" || value === "clicked" || value === "accepted" || value === "streaming" || value === "stable" || value === "failed" || value === "cancelled";
}

function bounded(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
  return result;
}

function normalizeConversationBinding(value: unknown, projects: ChatGptWorkspaceProjectBinding[]): ChatGptConversationBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.workspace !== "string"
    || typeof item.logicalConversationId !== "string"
    || typeof item.providerConversationId !== "string"
    || !Number.isSafeInteger(item.updatedAt)) return undefined;
  const project = projects.find((candidate) => candidate.workspace === item.workspace);
  const projectId = typeof item.projectId === "string" && item.projectId ? item.projectId : project?.projectId;
  if (!projectId) return undefined;
  return {
    workspace: item.workspace,
    projectId,
    logicalConversationId: item.logicalConversationId,
    providerConversationId: item.providerConversationId,
    updatedAt: Number(item.updatedAt),
  };
}

function deriveConversationBindings(commands: BrowserCommandSnapshot[], projects: ChatGptWorkspaceProjectBinding[]): ChatGptConversationBinding[] {
  const bindings = new Map<string, ChatGptConversationBinding>();
  for (const command of commands) {
    if (!command.logicalConversationId || !command.providerConversationId) continue;
    const project = projects.find((item) => item.workspace === command.workspace);
    if (!project) continue;
    const key = `${command.workspace}\u0000${command.logicalConversationId}`;
    const existing = bindings.get(key);
    if (!existing || command.updatedAt >= existing.updatedAt) {
      bindings.set(key, {
        workspace: command.workspace,
        projectId: project.projectId,
        logicalConversationId: command.logicalConversationId,
        providerConversationId: command.providerConversationId,
        updatedAt: command.updatedAt,
      });
    }
  }
  return [...bindings.values()];
}

function normalizeWorkspaceProjectBinding(value: unknown): ChatGptWorkspaceProjectBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.workspace !== "string"
    || typeof item.projectName !== "string"
    || typeof item.projectUrl !== "string"
    || !isChatGptProjectUrl(item.projectUrl)
    || !Number.isSafeInteger(item.updatedAt)) return undefined;
  const projectUrl = normalizeChatGptProjectUrl(item.projectUrl);
  return {
    workspace: item.workspace,
    projectName: item.projectName,
    projectId: typeof item.projectId === "string" && item.projectId ? item.projectId : chatGptProjectId(projectUrl),
    projectUrl,
    updatedAt: Number(item.updatedAt),
  };
}

function chatGptProjectId(value: string): string {
  const url = new URL(value);
  const projectId = url.pathname.split("/").find((segment) => /^g-p-[A-Za-z0-9_-]+$/.test(segment));
  if (!projectId) throw new Error("ChatGPT project URL does not contain a project id");
  return projectId;
}

function boundedProjectName(value: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 128 || /[\u0000-\u001f\u007f]/.test(clean)) throw new Error("ChatGPT project name is invalid");
  return clean;
}

function normalizeChatGptProjectUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || !isChatGptProjectUrl(url.toString())) {
    throw new Error("ChatGPT project URL is invalid");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function isChatGptProjectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "chatgpt.com"
      && !/^\/c\//.test(url.pathname)
      && /(?:project|g-p-)/i.test(url.pathname);
  } catch {
    return false;
  }
}
