import type {
  IntelligenceArchitectureClusterInput,
  IntelligenceArchitectureMapInput,
  IntelligenceContextPackInput,
  IntelligenceQueryInput,
  IntelligenceReadFileInput,
  IntelligenceSemanticSearchInput,
  IntelligenceSymbolKeyInput,
  IntelligenceSymbolSearchInput,
  IntelligenceTraceInput,
} from "../shared/intelligence-api";
import { INTELLIGENCE_IPC } from "../shared/intelligence-api";

const MAX_QUERY_CHARS = 4_096;
const MAX_SYMBOL_KEY_CHARS = 2_048;
const MAX_PATH_CHARS = 1_024;
const MAX_CLUSTER_KEY_CHARS = 512;
const MAX_PREVIEW_LINES = 400;

export const INTELLIGENCE_INBOUND_IPC_CHANNELS = Object.freeze(Object.values(INTELLIGENCE_IPC));

export function validateIntelligenceIpcInvocation(
  channel: string,
  args: readonly unknown[],
): string | null {
  if (channel === INTELLIGENCE_IPC.graphStatus || channel === INTELLIGENCE_IPC.architectureRebuild) {
    return args.length === 1 && isWorkspaceId(args[0])
      ? null
      : "workspace must be a bounded SourceNerve workspace identifier";
  }
  if (channel === INTELLIGENCE_IPC.memorySearch || channel === INTELLIGENCE_IPC.codeSearch) {
    return args.length === 1 && isQueryInput(args[0]) ? null : "intelligence search input is invalid";
  }
  if (channel === INTELLIGENCE_IPC.symbolSearch) {
    return args.length === 1 && isSymbolSearchInput(args[0]) ? null : "symbol search input is invalid";
  }
  if (channel === INTELLIGENCE_IPC.symbolContext) {
    return args.length === 1 && isSymbolKeyInput(args[0]) ? null : "symbol context input is invalid";
  }
  if (channel === INTELLIGENCE_IPC.trace) {
    return args.length === 1 && isTraceInput(args[0]) ? null : "graph trace input is invalid";
  }
  if (channel === INTELLIGENCE_IPC.architectureMap) {
    return args.length === 1 && isArchitectureMapInput(args[0]) ? null : "architecture map input is invalid";
  }
  if (channel === INTELLIGENCE_IPC.architectureCluster) {
    return args.length === 1 && isArchitectureClusterInput(args[0]) ? null : "architecture cluster input is invalid";
  }
  if (channel === INTELLIGENCE_IPC.contextPack) {
    return args.length === 1 && isContextPackInput(args[0]) ? null : "context pack input is invalid";
  }
  if (channel === INTELLIGENCE_IPC.semanticStatus) {
    return args.length === 1 && isWorkspaceId(args[0])
      ? null
      : "workspace must be a bounded SourceNerve workspace identifier";
  }
  if (channel === INTELLIGENCE_IPC.semanticSearch) {
    return args.length === 1 && isSemanticSearchInput(args[0]) ? null : "semantic search input is invalid";
  }
  if (channel === INTELLIGENCE_IPC.readFile) {
    return args.length === 1 && isReadFileInput(args[0]) ? null : "file preview input is invalid";
  }
  return "intelligence IPC channel is not allowlisted";
}

export function isQueryInput(value: unknown): value is IntelligenceQueryInput {
  if (!isRecord(value) || !exactKeys(value, ["workspace", "query", "limit"])) return false;
  return isWorkspaceId(value.workspace) && isQuery(value.query) && isLimit(value.limit);
}

export function isSymbolSearchInput(value: unknown): value is IntelligenceSymbolSearchInput {
  if (!isRecord(value) || !exactKeys(value, ["workspace", "query", "limit", "kind"])) return false;
  return isWorkspaceId(value.workspace) &&
    isQuery(value.query) &&
    isLimit(value.limit) &&
    (value.kind === undefined || boundedText(value.kind, 1, 64));
}

export function isSymbolKeyInput(value: unknown): value is IntelligenceSymbolKeyInput {
  if (!isRecord(value) || !exactKeys(value, ["workspace", "symbolKey"])) return false;
  return isWorkspaceId(value.workspace) && isSymbolKey(value.symbolKey);
}

export function isTraceInput(value: unknown): value is IntelligenceTraceInput {
  if (!isRecord(value) || !exactKeys(value, ["workspace", "symbolKey", "kind", "depth"])) return false;
  return isWorkspaceId(value.workspace) &&
    isSymbolKey(value.symbolKey) &&
    (value.kind === "callers" || value.kind === "callees" || value.kind === "references" || value.kind === "impact") &&
    Number.isSafeInteger(value.depth) &&
    Number(value.depth) >= 1 &&
    Number(value.depth) <= 4;
}

export function isArchitectureMapInput(value: unknown): value is IntelligenceArchitectureMapInput {
  if (!isRecord(value) || !exactKeys(value, ["workspace", "limit"])) return false;
  return isWorkspaceId(value.workspace) && isLimit(value.limit);
}

export function isArchitectureClusterInput(value: unknown): value is IntelligenceArchitectureClusterInput {
  if (!isRecord(value) || !exactKeys(value, ["workspace", "clusterKey"])) return false;
  return isWorkspaceId(value.workspace) && boundedText(value.clusterKey, 1, MAX_CLUSTER_KEY_CHARS);
}

export function isContextPackInput(value: unknown): value is IntelligenceContextPackInput {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "workspace",
      "query",
      "seedSymbolKeys",
      "seedClusterKeys",
      "maxBytes",
      "maxItems",
      "requireClean",
      "providerSemantic",
    ])
  ) return false;
  if (!isWorkspaceId(value.workspace) || !isQuery(value.query)) return false;
  if (!Array.isArray(value.seedSymbolKeys) || value.seedSymbolKeys.length > 12 || !value.seedSymbolKeys.every(isSymbolKey)) return false;
  if (!Array.isArray(value.seedClusterKeys) || value.seedClusterKeys.length > 12 || !value.seedClusterKeys.every((item) => boundedText(item, 1, MAX_CLUSTER_KEY_CHARS))) return false;
  if (!Number.isSafeInteger(value.maxBytes) || Number(value.maxBytes) < 256 || Number(value.maxBytes) > 128 * 1024) return false;
  if (!Number.isSafeInteger(value.maxItems) || Number(value.maxItems) < 1 || Number(value.maxItems) > 50) return false;
  return typeof value.requireClean === "boolean" && typeof value.providerSemantic === "boolean";
}

export function isSemanticSearchInput(value: unknown): value is IntelligenceSemanticSearchInput {
  if (!isRecord(value) || !exactKeys(value, ["workspace", "query", "limit", "providerId"])) return false;
  return isWorkspaceId(value.workspace) &&
    isQuery(value.query) &&
    isLimit(value.limit) &&
    (value.providerId === undefined || isProviderId(value.providerId));
}

export function isReadFileInput(value: unknown): value is IntelligenceReadFileInput {
  if (!isRecord(value) || !exactKeys(value, ["workspace", "path", "startLine", "endLine"])) return false;
  if (!isWorkspaceId(value.workspace) || !isRelativeRepositoryPath(value.path)) return false;
  if (value.startLine !== undefined && !isLine(value.startLine)) return false;
  if (value.endLine !== undefined && !isLine(value.endLine)) return false;
  const start = typeof value.startLine === "number" ? value.startLine : 1;
  const end = typeof value.endLine === "number" ? value.endLine : start + 239;
  return end >= start && end - start + 1 <= MAX_PREVIEW_LINES;
}

export function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value);
}

function isQuery(value: unknown): value is string {
  return boundedText(value, 1, MAX_QUERY_CHARS);
}

function isLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 100;
}

function isSymbolKey(value: unknown): value is string {
  return boundedText(value, 1, MAX_SYMBOL_KEY_CHARS);
}

function isProviderId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && /^[A-Za-z0-9._-]+$/.test(value);
}

function isLine(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 10_000_000;
}

function isRelativeRepositoryPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_PATH_CHARS || value.startsWith("/") || value.startsWith("\\")) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized)) return false;
  const segments = normalized.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function boundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function exactKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
