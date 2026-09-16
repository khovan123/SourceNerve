import type { DesktopRuntimeEvent } from "../shared/desktop-api";
import type { CodexRuntimeRequestContext } from "./codex-runtime-pool";
import type { CodexServerEvent } from "./codex-protocol";

const MAX_FIELD_BYTES = 64 * 1024;

type CodexProgressEvent = Extract<DesktopRuntimeEvent, { type: "codex-progress" }>;

export function codexServerEventToRuntimeProgress(
  context: CodexRuntimeRequestContext,
  event: CodexServerEvent,
): CodexProgressEvent | null {
  if (event.type === "agent-message-delta") {
    if (!event.delta) return null;
    return {
      type: "codex-progress",
      runId: context.runId,
      workspace: context.workspaceId,
      ...(context.threadId ? { threadId: bounded(context.threadId) } : {}),
      turnId: bounded(event.turnId),
      itemId: bounded(event.itemId),
      kind: "response",
      stage: "streaming",
      label: "Response",
      text: bounded(event.delta),
    };
  }
  if (event.type === "agent-message-completed") {
    if (!event.text) return null;
    return {
      type: "codex-progress",
      runId: context.runId,
      workspace: context.workspaceId,
      ...(context.threadId ? { threadId: bounded(context.threadId) } : {}),
      turnId: bounded(event.turnId),
      itemId: bounded(event.itemId),
      kind: "response",
      stage: "completed",
      label: "Response",
      text: bounded(event.text),
    };
  }
  if (event.type !== "notification") return null;
  const params = record(event.params);
  if (!params) return null;

  if (event.method === "item/reasoning/summaryTextDelta") {
    const scope = itemScope(context, params);
    const delta = text(params.delta);
    if (!scope || !delta) return null;
    return { ...scope, type: "codex-progress", kind: "reasoning", stage: "streaming", label: "Reasoning", text: bounded(delta) };
  }

  if (event.method === "item/plan/delta") {
    const scope = itemScope(context, params);
    const delta = text(params.delta);
    if (!scope || !delta) return null;
    return { ...scope, type: "codex-progress", kind: "reasoning", stage: "streaming", label: "Planning", text: bounded(delta) };
  }

  if (event.method === "turn/plan/updated") {
    const turnId = text(params.turnId);
    if (!turnId) return null;
    const plan = array(params.plan).map((value) => record(value)).filter(Boolean);
    const steps = plan.map((step) => {
      const value = text(step!.step);
      const status = text(step!.status);
      return value ? `${status === "completed" ? "✓ " : status === "inProgress" ? "→ " : ""}${value}` : "";
    }).filter(Boolean);
    const explanation = text(params.explanation);
    const body = [explanation, ...steps].filter(Boolean).join("\n");
    if (!body) return null;
    return {
      type: "codex-progress",
      runId: context.runId,
      workspace: context.workspaceId,
      ...(context.threadId ? { threadId: bounded(context.threadId) } : {}),
      turnId: bounded(turnId),
      itemId: "turn-plan",
      kind: "reasoning",
      stage: "completed",
      label: "Planning",
      text: bounded(body),
    };
  }

  if (event.method === "item/commandExecution/outputDelta") {
    const scope = itemScope(context, params);
    const delta = text(params.delta);
    if (!scope || !delta) return null;
    return { ...scope, type: "codex-progress", kind: "command", stage: "streaming", label: "Ran command", output: bounded(delta) };
  }

  if (event.method === "item/fileChange/outputDelta") {
    const scope = itemScope(context, params);
    const delta = text(params.delta);
    if (!scope || !delta) return null;
    return { ...scope, type: "codex-progress", kind: "file", stage: "streaming", label: "Edited file", output: bounded(delta) };
  }

  if (event.method === "item/fileChange/patchUpdated") {
    const scope = itemScope(context, params);
    if (!scope) return null;
    const changes = array(params.changes);
    const diff = fileChangesDiff(changes);
    return {
      ...scope,
      type: "codex-progress",
      kind: "file",
      stage: "streaming",
      label: fileChangeLabel(changes),
      ...(diff ? { diff } : {}),
    };
  }

  if (event.method !== "item/started" && event.method !== "item/completed") return null;
  const item = record(params.item);
  const scope = itemScope(context, params, item);
  if (!scope || !item) return null;
  const completed = event.method === "item/completed";

  if (item.type === "reasoning") {
    const summary = stringArray(item.summary).join("\n").trim();
    if (!summary) return null;
    return {
      ...scope,
      type: "codex-progress",
      kind: "reasoning",
      stage: completed ? "completed" : "started",
      label: "Reasoning",
      text: bounded(summary),
    };
  }

  if (item.type === "plan") {
    const planText = text(item.text);
    if (!planText) return null;
    return {
      ...scope,
      type: "codex-progress",
      kind: "reasoning",
      stage: completed ? "completed" : "started",
      label: "Planning",
      text: bounded(planText),
    };
  }

  if (item.type === "commandExecution") {
    const status = text(item.status) ?? (completed ? "completed" : "inProgress");
    const failed = status === "failed" || status === "declined";
    const output = text(item.aggregatedOutput);
    const exitCode = integer(item.exitCode);
    const durationMs = nonNegativeInteger(item.durationMs);
    return {
      ...scope,
      type: "codex-progress",
      kind: "command",
      stage: completed ? (failed ? "failed" : "completed") : "started",
      label: commandExecutionLabel(item),
      ...(text(item.command) ? { command: bounded(text(item.command)!) } : {}),
      ...(text(item.cwd) ? { cwd: bounded(text(item.cwd)!) } : {}),
      ...(output ? { output: bounded(output) } : {}),
      ...(status ? { status: bounded(status) } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  if (item.type === "fileChange") {
    const changes = array(item.changes);
    const status = text(item.status) ?? (completed ? "completed" : "inProgress");
    const failed = /fail|declin|reject/i.test(status);
    const diff = fileChangesDiff(changes);
    return {
      ...scope,
      type: "codex-progress",
      kind: "file",
      stage: completed ? (failed ? "failed" : "completed") : "started",
      label: fileChangeLabel(changes),
      ...(diff ? { diff } : {}),
      ...(status ? { status: bounded(status) } : {}),
    };
  }

  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const tool = text(item.tool) ?? "Tool call";
    const server = text(item.server);
    const namespace = text(item.namespace);
    const functionName = [server ?? namespace, tool].filter(Boolean).join(".");
    const parameters = safeToolParameters(item.arguments);
    const status = text(item.status) ?? (completed ? "completed" : "inProgress");
    const error = record(item.error);
    const errorText = error ? text(error.message) : null;
    const resultText = item.type === "mcpToolCall" ? mcpResultText(item.result) : dynamicResultText(item.contentItems);
    const failed = Boolean(errorText) || /fail|error|declin|reject/i.test(status);
    const durationMs = nonNegativeInteger(item.durationMs);
    return {
      ...scope,
      type: "codex-progress",
      kind: "tool",
      stage: completed ? (failed ? "failed" : "completed") : "started",
      label: toolLabel(tool, server),
      ...(functionName ? { functionName: bounded(functionName) } : {}),
      ...(parameters ? { parameters: bounded(parameters) } : {}),
      ...(resultText || errorText ? { output: bounded(errorText ?? resultText ?? "") } : {}),
      ...(status ? { status: bounded(status) } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  return null;
}

function itemScope(
  context: CodexRuntimeRequestContext,
  params: Record<string, unknown>,
  item?: Record<string, unknown> | null,
): Pick<CodexProgressEvent, "runId" | "workspace" | "threadId" | "turnId" | "itemId"> | null {
  const turnId = text(params.turnId);
  const itemId = text(params.itemId) ?? (item ? text(item.id) : null);
  if (!turnId || !itemId) return null;
  return {
    runId: context.runId,
    workspace: context.workspaceId,
    ...(context.threadId ? { threadId: bounded(context.threadId) } : {}),
    turnId: bounded(turnId),
    itemId: bounded(itemId),
  };
}

function fileChangeLabel(changes: unknown[]): string {
  const paths = changes.map((entry) => record(entry)).filter(Boolean).map((entry) => text(entry!.path)).filter((value): value is string => Boolean(value));
  if (paths.length === 0) return "Edited file";
  if (paths.length === 1) return `Edited ${basename(paths[0]!)}`;
  return `Edited ${paths.length} files`;
}

function fileChangesDiff(changes: unknown[]): string {
  const parts: string[] = [];
  for (const value of changes) {
    const change = record(value);
    if (!change) continue;
    const path = text(change.path);
    const diff = text(change.diff);
    if (!diff) continue;
    parts.push(path ? ensureDiffFileHeaders(path, diff) : diff);
  }
  return bounded(parts.join("\n\n"));
}

function commandExecutionLabel(item: Record<string, unknown>): string {
  const actions = array(item.commandActions).map((value) => record(value)).filter(Boolean);
  for (const action of actions) {
    const type = text(action!.type);
    if (type === "read") {
      const path = text(action!.path) ?? text(action!.name);
      return path ? `Read ${basename(path)}` : "Read file";
    }
    if (type === "search") {
      const query = text(action!.query);
      return query ? `Searched ${truncateLabel(query)}` : "Searched workspace";
    }
    if (type === "listFiles") {
      const path = text(action!.path);
      return path ? `Listed ${basename(path)}` : "Listed files";
    }
  }

  const command = text(item.command)?.replace(/\s+/g, " ").trim() ?? "";
  const lowered = command.toLowerCase();
  if (/\b(?:pytest|jest|vitest|cargo\s+test|go\s+test|pnpm\s+test|npm\s+test|yarn\s+test)\b/.test(lowered)) return "Ran tests";
  if (/\b(?:tsc|typecheck)\b/.test(lowered)) return "Ran typecheck";
  if (/\b(?:eslint|ruff|clippy|lint)\b/.test(lowered)) return "Ran lint";
  if (/\bgit\s+(?:diff|status)\b/.test(lowered)) return "Checked git changes";
  return "Ran command";
}

function truncateLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 58 ? normalized : `${normalized.slice(0, 55)}…`;
}

function ensureDiffFileHeaders(path: string, diff: string): string {
  if (/^diff --git\s+/m.test(diff)) return diff;
  const normalized = path.replace(/^\.\//, "").replace(/^\/+/, "");
  const body = /^(?:---|\+\+\+)\s+/m.test(diff) ? diff : `--- ${path}\n+++ ${path}\n${diff}`;
  return `diff --git a/${normalized} b/${normalized}\n${body}`;
}

function mcpResultText(value: unknown): string | null {
  const result = record(value);
  if (!result) return null;
  const content = array(result.content);
  const parts: string[] = [];
  for (const raw of content) {
    const item = record(raw);
    if (item && item.type === "text" && text(item.text)) parts.push(text(item.text)!);
  }
  if (parts.length > 0) return parts.join("\n");
  if (result.structuredContent !== null && result.structuredContent !== undefined) return safeJson(result.structuredContent);
  return null;
}

function dynamicResultText(value: unknown): string | null {
  const items = array(value);
  if (items.length === 0) return null;
  const parts: string[] = [];
  for (const raw of items) {
    const item = record(raw);
    if (!item) continue;
    const candidate = text(item.text) ?? text(item.output) ?? text(item.content);
    if (candidate) parts.push(candidate);
  }
  return parts.length > 0 ? parts.join("\n") : safeJson(items);
}

function toolLabel(tool: string, server: string | null): string {
  const lowered = tool.toLowerCase();
  if (lowered.includes("read_file") || lowered.includes("file_fetch")) return "Read file";
  if (lowered.includes("write") || lowered.includes("patch") || lowered.includes("file_put")) return "Edited file";
  if (lowered.includes("workspace_exec") || lowered.includes("command")) return "Ran command";
  if (lowered.includes("git_diff") || lowered.includes("git_review")) return "Reviewed changes";
  const name = tool.replaceAll("_", " ").replaceAll("-", " ").trim();
  const label = name ? name.charAt(0).toUpperCase() + name.slice(1) : "Tool call";
  return server ? `${label} · ${server}` : label;
}

function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function safeToolParameters(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return safeJson(redactSensitiveToolValue(value));
}

function redactSensitiveToolValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveToolValue);
  const source = record(value);
  if (!source) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    redacted[key] = isSensitiveParameterKey(key) ? "[REDACTED]" : redactSensitiveToolValue(child);
  }
  return redacted;
}

function isSensitiveParameterKey(value: string): boolean {
  const key = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return key === "authorization"
    || key === "password"
    || key === "secret"
    || key.endsWith("token")
    || key.endsWith("apikey")
    || key.endsWith("secret");
}

function bounded(value: string): string {
  const normalized = value.replaceAll("\u0000", "");
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.length <= MAX_FIELD_BYTES) return normalized;
  return `${bytes.subarray(0, MAX_FIELD_BYTES - 3).toString("utf8").replace(/�+$/g, "")}…`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? Number(value) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = integer(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}
