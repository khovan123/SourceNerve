import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProviderFrontendBinding } from "./provider-frontend-session";

export type BrowserCommandStage = "queued" | "inserted" | "clicked" | "accepted" | "stable" | "failed" | "cancelled";

export interface BrowserCommandSnapshot {
  commandId: string;
  taskId: string;
  runId: string;
  workspace: string;
  stage: BrowserCommandStage;
  epoch: number;
  providerFrontendId: string;
  providerConversationId?: string;
  providerTurnId?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface BrowserCommandJournal {
  schemaVersion: 1;
  commands: BrowserCommandSnapshot[];
}

const MAX_COMMANDS = 128;

export class BrowserCommandStateStore {
  constructor(private readonly filePath: string) {}

  async record(input: {
    commandId: string;
    taskId: string;
    binding: ProviderFrontendBinding;
    stage: BrowserCommandStage;
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
      ...(input.binding.frontend.turnId ? { providerTurnId: input.binding.frontend.turnId } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(input.error ? { error: boundText(input.error, 1024) } : {}),
    };
    const kept = journal.commands.filter((item) => item.commandId !== input.commandId);
    kept.push(next);
    journal.commands = kept.slice(-MAX_COMMANDS);
    await this.save(journal);
    return next;
  }

  async snapshot(): Promise<BrowserCommandJournal> {
    return this.load();
  }

  private async load(): Promise<BrowserCommandJournal> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyJournal();
      const value = parsed as { schemaVersion?: unknown; commands?: unknown };
      if (value.schemaVersion !== 1 || !Array.isArray(value.commands)) return emptyJournal();
      return {
        schemaVersion: 1,
        commands: value.commands.filter(isSnapshot).slice(-MAX_COMMANDS),
      };
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
  return { schemaVersion: 1, commands: [] };
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
    && Number.isSafeInteger(item.createdAt)
    && Number.isSafeInteger(item.updatedAt);
}

function isStage(value: unknown): value is BrowserCommandStage {
  return value === "queued" || value === "inserted" || value === "clicked" || value === "accepted" || value === "stable" || value === "failed" || value === "cancelled";
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
