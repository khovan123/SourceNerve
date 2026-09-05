export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type CodexSkillScope = "user" | "repo" | "system" | "admin";

export interface CodexInitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export type CodexAccount =
  | { type: "apiKey" }
  | { type: "chatgpt"; email: string | null; planType: string }
  | { type: "amazonBedrock"; usesCodexManagedCredentials: boolean };

export interface CodexAccountReadResponse {
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
}

export interface CodexThreadSummary {
  id: string;
  sessionId: string;
  cwd: string;
  modelProvider: string;
  model: string | null;
  ephemeral: boolean;
}

export interface CodexThreadStartResponse {
  thread: CodexThreadSummary;
  model: string;
  modelProvider: string;
  cwd: string;
}

export interface CodexTurnError {
  message: string;
  additionalDetails: string | null;
}

export interface CodexTurn {
  id: string;
  status: CodexTurnStatus;
  error: CodexTurnError | null;
  items: unknown[];
}

export interface CodexTurnStartResponse {
  turn: CodexTurn;
}

export interface CodexTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexThreadTokenUsage {
  total: CodexTokenUsageBreakdown;
  last: CodexTokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface CodexSkillMetadata {
  name: string;
  description: string;
  path: string;
  scope: CodexSkillScope;
  enabled: boolean;
  pluginId: string | null;
}

export interface CodexSkillsListEntry {
  cwd: string;
  skills: CodexSkillMetadata[];
  errors: unknown[];
}

export interface CodexSkillsListResponse {
  data: CodexSkillsListEntry[];
}

export interface CodexSkillInvocation {
  name: string;
  path: string;
}

export type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "skill"; name: string; path: string };

export type CodexServerEvent =
  | {
      type: "agent-message-delta";
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "agent-message-completed";
      threadId: string;
      turnId: string;
      itemId: string;
      text: string;
    }
  | {
      type: "token-usage";
      threadId: string;
      turnId: string;
      tokenUsage: CodexThreadTokenUsage;
    }
  | {
      type: "turn-completed";
      threadId: string;
      turn: CodexTurn;
    }
  | {
      type: "notification";
      method: string;
      params: unknown;
    };

export function codexTextInput(text: string): CodexUserInput {
  if (text.length === 0) throw new Error("Codex turn input must not be empty");
  return { type: "text", text, text_elements: [] };
}

export function codexSkillInput(skill: CodexSkillInvocation): CodexUserInput {
  const name = string(skill.name, "Codex skill name");
  const skillPath = string(skill.path, "Codex skill path");
  return { type: "skill", name, path: skillPath };
}

export function parseCodexInitializeResponse(value: unknown): CodexInitializeResponse {
  const record = object(value, "Codex initialize response");
  return {
    userAgent: string(record.userAgent, "Codex initialize userAgent"),
    codexHome: string(record.codexHome, "Codex initialize codexHome"),
    platformFamily: string(record.platformFamily, "Codex initialize platformFamily"),
    platformOs: string(record.platformOs, "Codex initialize platformOs"),
  };
}

export function parseCodexAccountReadResponse(value: unknown): CodexAccountReadResponse {
  const record = object(value, "Codex account response");
  if (typeof record.requiresOpenaiAuth !== "boolean") throw new Error("Codex account response requiresOpenaiAuth is invalid");
  return {
    account: record.account === null ? null : parseAccount(record.account),
    requiresOpenaiAuth: record.requiresOpenaiAuth,
  };
}

export function parseCodexThreadStartResponse(value: unknown): CodexThreadStartResponse {
  const record = object(value, "Codex thread response");
  return {
    thread: parseThread(record.thread),
    model: string(record.model, "Codex thread model"),
    modelProvider: string(record.modelProvider, "Codex thread modelProvider"),
    cwd: string(record.cwd, "Codex thread cwd"),
  };
}

export function parseCodexTurnStartResponse(value: unknown): CodexTurnStartResponse {
  const record = object(value, "Codex turn/start response");
  return { turn: parseTurn(record.turn) };
}

export function parseCodexSkillsListResponse(value: unknown): CodexSkillsListResponse {
  const record = object(value, "Codex skills/list response");
  if (!Array.isArray(record.data)) throw new Error("Codex skills/list data is invalid");
  return {
    data: record.data.map((entry) => {
      const item = object(entry, "Codex skills/list entry");
      if (!Array.isArray(item.skills) || !Array.isArray(item.errors)) {
        throw new Error("Codex skills/list entry is invalid");
      }
      return {
        cwd: string(item.cwd, "Codex skills/list cwd"),
        skills: item.skills.map(parseSkillMetadata),
        errors: [...item.errors],
      };
    }),
  };
}

export function parseCodexServerEvent(method: string, params: unknown): CodexServerEvent {
  if (method === "item/agentMessage/delta") {
    const record = object(params, "Codex agent-message delta");
    return {
      type: "agent-message-delta",
      threadId: string(record.threadId, "Codex delta threadId"),
      turnId: string(record.turnId, "Codex delta turnId"),
      itemId: string(record.itemId, "Codex delta itemId"),
      delta: string(record.delta, "Codex delta text"),
    };
  }
  if (method === "item/completed") {
    const record = object(params, "Codex item/completed notification");
    const item = object(record.item, "Codex completed item");
    if (item.type === "agentMessage") {
      return {
        type: "agent-message-completed",
        threadId: string(record.threadId, "Codex completed item threadId"),
        turnId: string(record.turnId, "Codex completed item turnId"),
        itemId: string(item.id, "Codex completed item id"),
        text: string(item.text, "Codex completed agent message text"),
      };
    }
  }
  if (method === "thread/tokenUsage/updated") {
    const record = object(params, "Codex token usage notification");
    return {
      type: "token-usage",
      threadId: string(record.threadId, "Codex usage threadId"),
      turnId: string(record.turnId, "Codex usage turnId"),
      tokenUsage: parseTokenUsage(record.tokenUsage),
    };
  }
  if (method === "turn/completed") {
    const record = object(params, "Codex turn/completed notification");
    return {
      type: "turn-completed",
      threadId: string(record.threadId, "Codex completed turn threadId"),
      turn: parseTurn(record.turn),
    };
  }
  return { type: "notification", method, params };
}

export function finalAgentMessage(turn: CodexTurn): string | undefined {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.type === "agentMessage" && typeof record.text === "string") return record.text;
  }
  return undefined;
}

function parseAccount(value: unknown): CodexAccount {
  const record = object(value, "Codex account");
  if (record.type === "apiKey") return { type: "apiKey" };
  if (record.type === "chatgpt") {
    return {
      type: "chatgpt",
      email: nullableString(record.email, "Codex account email"),
      planType: string(record.planType, "Codex account planType"),
    };
  }
  if (record.type === "amazonBedrock") {
    if (typeof record.usesCodexManagedCredentials !== "boolean") throw new Error("Codex Bedrock account credentials flag is invalid");
    return { type: "amazonBedrock", usesCodexManagedCredentials: record.usesCodexManagedCredentials };
  }
  throw new Error("Codex account type is unsupported");
}

function parseThread(value: unknown): CodexThreadSummary {
  const record = object(value, "Codex thread");
  if (typeof record.ephemeral !== "boolean") throw new Error("Codex thread ephemeral flag is invalid");
  return {
    id: string(record.id, "Codex thread id"),
    sessionId: string(record.sessionId, "Codex thread sessionId"),
    cwd: string(record.cwd, "Codex thread cwd"),
    modelProvider: string(record.modelProvider, "Codex thread modelProvider"),
    model: nullableString(record.model, "Codex thread model"),
    ephemeral: record.ephemeral,
  };
}

function parseTurn(value: unknown): CodexTurn {
  const record = object(value, "Codex turn");
  const status = record.status;
  if (status !== "completed" && status !== "interrupted" && status !== "failed" && status !== "inProgress") {
    throw new Error("Codex turn status is invalid");
  }
  if (!Array.isArray(record.items)) throw new Error("Codex turn items are invalid");
  return {
    id: string(record.id, "Codex turn id"),
    status,
    error: record.error === null ? null : parseTurnError(record.error),
    items: record.items,
  };
}

function parseTurnError(value: unknown): CodexTurnError {
  const record = object(value, "Codex turn error");
  return {
    message: string(record.message, "Codex turn error message"),
    additionalDetails: nullableString(record.additionalDetails, "Codex turn additional details"),
  };
}

function parseSkillMetadata(value: unknown): CodexSkillMetadata {
  const record = object(value, "Codex skill metadata");
  const scope = record.scope;
  if (scope !== "user" && scope !== "repo" && scope !== "system" && scope !== "admin") {
    throw new Error("Codex skill scope is invalid");
  }
  if (typeof record.enabled !== "boolean") throw new Error("Codex skill enabled flag is invalid");
  return {
    name: string(record.name, "Codex skill name"),
    description: typeof record.description === "string" ? record.description : "",
    path: string(record.path, "Codex skill path"),
    scope,
    enabled: record.enabled,
    pluginId: record.pluginId === null ? null : string(record.pluginId, "Codex skill pluginId"),
  };
}

function parseTokenUsage(value: unknown): CodexThreadTokenUsage {
  const record = object(value, "Codex token usage");
  const context = record.modelContextWindow;
  if (context !== null && (!Number.isSafeInteger(context) || Number(context) < 0)) throw new Error("Codex context window is invalid");
  return {
    total: parseTokenBreakdown(record.total, "Codex total token usage"),
    last: parseTokenBreakdown(record.last, "Codex last token usage"),
    modelContextWindow: context === null ? null : Number(context),
  };
}

function parseTokenBreakdown(value: unknown, label: string): CodexTokenUsageBreakdown {
  const record = object(value, label);
  return {
    totalTokens: nonNegativeInteger(record.totalTokens, `${label} totalTokens`),
    inputTokens: nonNegativeInteger(record.inputTokens, `${label} inputTokens`),
    cachedInputTokens: nonNegativeInteger(record.cachedInputTokens, `${label} cachedInputTokens`),
    cacheWriteInputTokens: nonNegativeInteger(record.cacheWriteInputTokens, `${label} cacheWriteInputTokens`),
    outputTokens: nonNegativeInteger(record.outputTokens, `${label} outputTokens`),
    reasoningOutputTokens: nonNegativeInteger(record.reasoningOutputTokens, `${label} reasoningOutputTokens`),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid`);
  return Number(value);
}
