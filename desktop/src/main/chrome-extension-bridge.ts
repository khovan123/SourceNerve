import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import { BrowserCommandStateStore, browserCommandStatePath, type BrowserCommandStage } from "./browser-command-state";
import { bindProviderFrontend, frontendDocumentId, parseChatGptConversationId, safeProviderTurnId, type ProviderFrontendBinding, type ProviderFrontendIdentity } from "./provider-frontend-session";

export const CHROME_EXTENSION_PROTOCOL_VERSION = 2 as const;

export interface ChromeExtensionBridgeState {
  enabled: boolean;
  origin: string;
  tokenPrefix: string;
  connected: boolean;
  lastSeenAt?: number;
  frontend?: ProviderFrontendIdentity;
  pendingCommands: number;
  completedCommands: number;
}

export interface ChromeExtensionPresencePayload {
  url: string;
  title?: string;
  turnId?: string;
  epoch?: number;
  extensionProtocolVersion?: number;
}

export interface ChromeExtensionCommandInput {
  taskId: string;
  runId: string;
  workspace: string;
  sourceSessionId: string;
  message: string;
  timeoutMs?: number;
}

interface QueuedCommand {
  commandId: string;
  taskId: string;
  runId: string;
  workspace: string;
  sourceSessionId: string;
  message: string;
  stage: BrowserCommandStage;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  completedAt?: number;
  text?: string;
  error?: string;
}

interface PersistedBridgeState {
  schemaVersion: 1;
  port: number;
  token: string;
  lastSeenAt?: number;
  frontend?: ProviderFrontendIdentity;
}

interface CommandResolver {
  resolve(value: string): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const MAX_COMMANDS = 128;
const COMMAND_REDELIVER_AFTER_MS = 15_000;

export class ChromeExtensionBridge {
  private server: Server | null = null;
  private persisted: PersistedBridgeState | null = null;
  private readonly statePath: string;
  private readonly commandState: Pick<BrowserCommandStateStore, "record">;
  private readonly commands = new Map<string, QueuedCommand>();
  private readonly resolvers = new Map<string, CommandResolver>();

  constructor(options: { statePath: string; commandState?: Pick<BrowserCommandStateStore, "record">; userDataPath?: string }) {
    this.statePath = options.statePath;
    this.commandState = options.commandState ?? new BrowserCommandStateStore(browserCommandStatePath(options.userDataPath ?? path.dirname(path.dirname(options.statePath))));
  }

  async start(): Promise<ChromeExtensionBridgeState> {
    if (this.server) return this.state();
    this.persisted = await this.loadOrCreate();
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.persisted!.port, "127.0.0.1", () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    return this.state();
  }

  async stop(): Promise<void> {
    for (const [commandId, resolver] of this.resolvers) {
      clearTimeout(resolver.timer);
      resolver.reject(new Error("Chrome extension bridge stopped"));
      this.resolvers.delete(commandId);
    }
    const current = this.server;
    this.server = null;
    if (!current) return;
    await new Promise<void>((resolve) => current.close(() => resolve()));
  }


  cancelTask(taskId: string): void {
    for (const command of this.commands.values()) {
      if (command.taskId !== taskId) continue;
      if (command.stage === "stable" || command.stage === "failed" || command.stage === "cancelled") continue;
      void this.complete(command.commandId, "cancelled", undefined, "Chrome extension command was cancelled").catch(() => undefined);
    }
  }

  async rotateToken(): Promise<ChromeExtensionBridgeState> {
    const current = this.persisted ?? await this.loadOrCreate();
    this.persisted = { ...current, token: randomBytes(32).toString("hex") };
    await this.save(this.persisted);
    return this.state();
  }

  state(): ChromeExtensionBridgeState {
    const current = this.persisted;
    const commands = [...this.commands.values()];
    return {
      enabled: Boolean(this.server && current),
      origin: current ? `http://127.0.0.1:${current.port}` : "",
      tokenPrefix: current ? current.token.slice(0, 8) : "",
      connected: Boolean(current?.lastSeenAt && Date.now() - current.lastSeenAt < 30_000),
      ...(current?.lastSeenAt ? { lastSeenAt: current.lastSeenAt } : {}),
      ...(current?.frontend ? { frontend: current.frontend } : {}),
      pendingCommands: commands.filter((command) => command.stage !== "stable" && command.stage !== "failed" && command.stage !== "cancelled").length,
      completedCommands: commands.filter((command) => command.stage === "stable").length,
    };
  }

  async sendCommand(input: ChromeExtensionCommandInput): Promise<string> {
    if (!this.server || !this.persisted) throw new Error("Chrome extension bridge is not running");
    const command: QueuedCommand = {
      commandId: `chrome_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      taskId: bounded(input.taskId, "task id"),
      runId: bounded(input.runId, "run id"),
      workspace: bounded(input.workspace, "workspace"),
      sourceSessionId: bounded(input.sourceSessionId, "source session id"),
      message: boundText(input.message, 48 * 1024),
      stage: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.pruneCommands();
    this.commands.set(command.commandId, command);
    await this.record(command, "queued");
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resolvers.delete(command.commandId);
        this.complete(command.commandId, "failed", undefined, "Chrome extension command timed out").catch(() => undefined);
        reject(new Error("Chrome extension command timed out"));
      }, input.timeoutMs ?? 10 * 60_000);
      this.resolvers.set(command.commandId, { resolve, reject, timer });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method === "OPTIONS") return send(res, 204, {});
      if (!this.persisted) throw new Error("bridge is not initialized");
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.persisted.port}`);
      if (url.searchParams.get("token") !== this.persisted.token) return send(res, 403, { error: "forbidden" });
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/state") return send(res, 200, { ok: true, state: this.state() });
      if (req.method === "POST" && url.pathname === "/presence") {
        const body = await readJson(req, 32 * 1024);
        const frontend = parsePresence(body);
        this.persisted = { ...this.persisted, lastSeenAt: Date.now(), frontend };
        await this.save(this.persisted);
        return send(res, 200, { ok: true, frontend });
      }
      if (req.method === "GET" && url.pathname === "/command/next") {
        const command = this.nextCommand();
        return send(res, 200, { ok: true, command: command ? commandView(command) : null });
      }
      if (req.method === "POST" && url.pathname === "/command/receipt") {
        const receipt = parseReceipt(await readJson(req, 128 * 1024));
        const text = await this.complete(receipt.commandId, receipt.stage, receipt.text, receipt.error, receipt.frontend);
        return send(res, 200, { ok: true, text });
      }
      return send(res, 404, { error: "not_found" });
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : "invalid_request" });
    }
  }

  private nextCommand(): QueuedCommand | null {
    const now = Date.now();
    for (const command of this.commands.values()) {
      if (command.stage !== "queued") continue;
      if (command.deliveredAt && now - command.deliveredAt < COMMAND_REDELIVER_AFTER_MS) continue;
      command.deliveredAt = now;
      command.updatedAt = now;
      return command;
    }
    return null;
  }

  private async complete(commandId: string, stage: BrowserCommandStage, text?: string, error?: string, frontend?: ProviderFrontendIdentity): Promise<string | undefined> {
    const command = this.commands.get(commandId);
    if (!command) throw new Error("Chrome extension command is not found");
    command.stage = stage;
    command.updatedAt = Date.now();
    if (text !== undefined) command.text = boundText(text, 64 * 1024);
    if (error !== undefined) command.error = boundText(error, 1024);
    if (stage === "stable" || stage === "failed" || stage === "cancelled") command.completedAt = Date.now();
    await this.record(command, stage, frontend, command.error);
    const resolver = this.resolvers.get(commandId);
    if (resolver && stage === "stable") {
      clearTimeout(resolver.timer);
      this.resolvers.delete(commandId);
      resolver.resolve(command.text ?? "");
    } else if (resolver && (stage === "failed" || stage === "cancelled")) {
      clearTimeout(resolver.timer);
      this.resolvers.delete(commandId);
      resolver.reject(new Error(command.error ?? `Chrome extension command ${stage}`));
    }
    return command.text;
  }

  private async record(command: QueuedCommand, stage: BrowserCommandStage, frontend?: ProviderFrontendIdentity, error?: string): Promise<void> {
    const front = frontend ?? this.persisted?.frontend ?? fallbackFrontend();
    const binding: ProviderFrontendBinding = bindProviderFrontend({
      sourceSessionId: command.sourceSessionId,
      runId: command.runId,
      workspace: command.workspace,
      frontend: front,
      now: Date.now(),
    });
    await this.commandState.record({ commandId: command.commandId, taskId: command.taskId, binding, stage, error, now: Date.now() });
  }

  private pruneCommands(): void {
    while (this.commands.size >= MAX_COMMANDS) {
      const oldest = this.commands.keys().next().value as string | undefined;
      if (!oldest) return;
      this.commands.delete(oldest);
    }
  }

  private async loadOrCreate(): Promise<PersistedBridgeState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
      if (isPersisted(parsed)) return parsed;
    } catch {}
    const created: PersistedBridgeState = {
      schemaVersion: 1,
      port: 40173 + Math.floor(Math.random() * 1000),
      token: randomBytes(32).toString("hex"),
    };
    await this.save(created);
    return created;
  }

  private async save(value: PersistedBridgeState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}

export function chromeExtensionBridgeStatePath(userDataPath: string): string {
  return path.join(userDataPath, "state", "chrome-extension-bridge.json");
}

function commandView(command: QueuedCommand): object {
  return {
    commandId: command.commandId,
    taskId: command.taskId,
    runId: command.runId,
    workspace: command.workspace,
    message: command.message,
    createdAt: command.createdAt,
  };
}

function parsePresence(value: unknown): ProviderFrontendIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("presence payload must be an object");
  const payload = value as Partial<ChromeExtensionPresencePayload>;
  if (typeof payload.url !== "string" || !payload.url.startsWith("https://chatgpt.com/")) throw new Error("presence url must be a ChatGPT document");
  return {
    provider: "chrome-extension",
    documentId: frontendDocumentId({ url: payload.url, title: typeof payload.title === "string" ? payload.title : undefined }),
    ...(parseChatGptConversationId(payload.url) ? { conversationId: parseChatGptConversationId(payload.url) } : {}),
    ...(safeProviderTurnId(payload.turnId) ? { turnId: safeProviderTurnId(payload.turnId) } : {}),
    epoch: Number.isSafeInteger(payload.epoch) && Number(payload.epoch) >= 0 ? Number(payload.epoch) : 0,
    ...(Number.isSafeInteger(payload.extensionProtocolVersion) ? { extensionProtocolVersion: Number(payload.extensionProtocolVersion) } : {}),
  };
}

function parseReceipt(value: unknown): { commandId: string; stage: BrowserCommandStage; text?: string; error?: string; frontend?: ProviderFrontendIdentity } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("receipt payload must be an object");
  const payload = value as Record<string, unknown>;
  const stage = payload.stage;
  if (!isStage(stage)) throw new Error("receipt stage is invalid");
  const frontend = payload.frontend === undefined ? undefined : parsePresence(payload.frontend);
  return {
    commandId: bounded(payload.commandId, "command id"),
    stage,
    ...(typeof payload.text === "string" ? { text: payload.text } : {}),
    ...(typeof payload.error === "string" ? { error: payload.error } : {}),
    ...(frontend ? { frontend } : {}),
  };
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function send(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(status === 204 ? "" : JSON.stringify(body));
}

function isPersisted(value: unknown): value is PersistedBridgeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === 1
    && Number.isSafeInteger(item.port)
    && Number(item.port) >= 1024
    && Number(item.port) <= 65535
    && typeof item.token === "string"
    && /^[a-f0-9]{64}$/.test(item.token);
}

function isStage(value: unknown): value is BrowserCommandStage {
  return value === "queued" || value === "inserted" || value === "clicked" || value === "accepted" || value === "stable" || value === "failed" || value === "cancelled";
}

function fallbackFrontend(): ProviderFrontendIdentity {
  return { provider: "chrome-extension", documentId: "unbound", epoch: 0 };
}

function bounded(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
  return result;
}
