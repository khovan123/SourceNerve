import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { DesktopError, DesktopResult } from "../shared/desktop-api";
import {
  INTELLIGENCE_IPC,
  type IntelligenceArchitectureCluster,
  type IntelligenceArchitectureClusterInput,
  type IntelligenceArchitectureClusterResult,
  type IntelligenceArchitectureDependency,
  type IntelligenceArchitectureMapInput,
  type IntelligenceArchitectureMapResult,
  type IntelligenceArchitectureRebuildResult,
  type IntelligenceArchitectureSnapshot,
  type IntelligenceCodeSearchResult,
  type IntelligenceContextItem,
  type IntelligenceContextPack,
  type IntelligenceContextPackInput,
  type IntelligenceContextReason,
  type IntelligenceFilePreview,
  type IntelligenceGraphStatus,
  type IntelligenceMemorySearchResult,
  type IntelligenceNeighborView,
  type IntelligenceQueryInput,
  type IntelligenceReadFileInput,
  type IntelligenceSemanticHit,
  type IntelligenceSemanticProvider,
  type IntelligenceSemanticSearchInput,
  type IntelligenceSemanticSearchResult,
  type IntelligenceSemanticRun,
  type IntelligenceSemanticStatus,
  type IntelligenceSymbolContext,
  type IntelligenceSymbolKeyInput,
  type IntelligenceSymbolSearchInput,
  type IntelligenceSymbolSearchResult,
  type IntelligenceSymbolView,
  type IntelligenceTraceInput,
  type IntelligenceTraceNode,
  type IntelligenceTraceResult,
} from "../shared/intelligence-api";
import { validateDesktopIpcInvocation } from "./ipc-policy";
import { SourceNerveHttpError, type SourceNerveClient } from "./sourcenerve-client";

export interface IntelligenceIpcContext {
  client(): SourceNerveClient | null;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
}

export function installIntelligenceIpcHandlers(context: IntelligenceIpcContext): void {
  for (const channel of Object.values(INTELLIGENCE_IPC)) ipcMain.removeHandler(channel);

  secureHandle(context, INTELLIGENCE_IPC.graphStatus, async (args) => {
    const workspace = args[0] as string;
    return invoke(context, async (client) => parseGraphStatus(
      await client.intelligenceRequest("/api/v1/graph/status", { workspace }),
      workspace,
    ));
  });

  secureHandle(context, INTELLIGENCE_IPC.memorySearch, async (args) => {
    const input = args[0] as IntelligenceQueryInput;
    return invoke(context, async (client) => parseMemorySearch(
      await client.intelligenceRequest("/api/v1/memory/search", input),
    ));
  });

  secureHandle(context, INTELLIGENCE_IPC.codeSearch, async (args) => {
    const input = args[0] as IntelligenceQueryInput;
    return invoke(context, async (client) => parseCodeSearch(
      await client.intelligenceRequest("/api/v1/search", input),
    ));
  });

  secureHandle(context, INTELLIGENCE_IPC.symbolSearch, async (args) => {
    const input = args[0] as IntelligenceSymbolSearchInput;
    return invoke(context, async (client) => parseSymbolSearch(
      await client.intelligenceRequest("/api/v1/graph/symbols/search", {
        workspace: input.workspace,
        query: input.query,
        ...(input.kind ? { kind: input.kind } : { kind: null }),
        limit: input.limit,
      }),
    ));
  });

  secureHandle(context, INTELLIGENCE_IPC.symbolContext, async (args) => {
    const input = args[0] as IntelligenceSymbolKeyInput;
    return invoke(context, async (client) => parseSymbolContext(
      await client.intelligenceRequest("/api/v1/graph/symbols/context", {
        workspace: input.workspace,
        symbol_key: input.symbolKey,
      }),
    ));
  });

  secureHandle(context, INTELLIGENCE_IPC.trace, async (args) => {
    const input = args[0] as IntelligenceTraceInput;
    const endpoint = {
      callers: "/api/v1/graph/trace/callers",
      callees: "/api/v1/graph/trace/callees",
      references: "/api/v1/graph/references",
      impact: "/api/v1/graph/impact",
    }[input.kind];
    return invoke(context, async (client) => parseTrace(
      await client.intelligenceRequest(endpoint, {
        workspace: input.workspace,
        symbol_key: input.symbolKey,
        depth: input.depth,
      }),
    ));
  });

  secureHandle(context, INTELLIGENCE_IPC.architectureMap, async (args) => {
    const input = args[0] as IntelligenceArchitectureMapInput;
    return invoke(context, async (client) => parseArchitectureMap(
      await client.intelligenceRequest("/api/v1/architecture/map", input),
    ));
  });

  secureHandle(context, INTELLIGENCE_IPC.architectureCluster, async (args) => {
    const input = args[0] as IntelligenceArchitectureClusterInput;
    return invoke(context, async (client) => parseArchitectureClusterResult(
      await client.intelligenceRequest("/api/v1/architecture/cluster", {
        workspace: input.workspace,
        cluster_key: input.clusterKey,
      }),
    ));
  });

  secureHandle(context, INTELLIGENCE_IPC.architectureRebuild, async (args) => {
    const workspace = args[0] as string;
    return invoke(context, async (client) => parseArchitectureRebuild(
      await client.intelligenceRequest("/api/v1/architecture/rebuild", { workspace }),
    ));
  });

  secureHandle(context, INTELLIGENCE_IPC.contextPack, async (args) => {
    const input = args[0] as IntelligenceContextPackInput;
    return invoke(context, async (client) => parseContextPack(
      await client.intelligenceRequest("/api/v1/context/pack", {
        workspace: input.workspace,
        query: input.query,
        seed_symbol_keys: input.seedSymbolKeys,
        seed_cluster_keys: input.seedClusterKeys,
        max_bytes: input.maxBytes,
        max_items: input.maxItems,
        require_clean: input.requireClean,
        provider_semantic: input.providerSemantic,
      }),
    ));
  });

  secureHandle(context, INTELLIGENCE_IPC.semanticStatus, async (args) => {
    const workspace = args[0] as string;
    return invoke(context, async (client) => {
      const [registry, ann] = await Promise.all([
        client.intelligenceRequest("/api/v1/semantic/providers/status"),
        client.intelligenceRequest("/api/v1/semantic/ann/status", { workspace }),
      ]);
      return parseSemanticStatus(registry, ann, workspace);
    });
  });

  secureHandle(context, INTELLIGENCE_IPC.semanticSearch, async (args) => {
    const input = args[0] as IntelligenceSemanticSearchInput;
    return invoke(context, async (client) => parseSemanticSearch(
      await client.intelligenceRequest("/api/v1/semantic/search-text", {
        workspace: input.workspace,
        query: input.query,
        limit: input.limit,
        ...(input.providerId ? { provider_id: input.providerId } : {}),
      }),
    ));
  });

  secureHandle(context, INTELLIGENCE_IPC.readFile, async (args) => {
    const input = args[0] as IntelligenceReadFileInput;
    const startLine = input.startLine ?? 1;
    const endLine = input.endLine ?? startLine + 239;
    return invoke(context, async (client) => parseFilePreview(
      await client.intelligenceRequest("/api/v1/read", {
        workspace: input.workspace,
        path: input.path,
        start_line: startLine,
        end_line: endLine,
      }),
    ));
  });
}

function secureHandle(
  context: IntelligenceIpcContext,
  channel: string,
  handler: (args: readonly unknown[]) => Promise<DesktopResult<unknown>>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!context.isTrustedSender(event)) {
      return fail({ code: "forbidden", message: "Desktop IPC sender is not trusted", retryable: false });
    }
    const validation = validateDesktopIpcInvocation(channel, args);
    if (validation) {
      return fail({ code: "invalid_request", message: validation, retryable: false });
    }
    return handler(args);
  });
}

async function invoke<T>(
  context: IntelligenceIpcContext,
  operation: (client: SourceNerveClient) => Promise<T>,
): Promise<DesktopResult<T>> {
  const client = context.client();
  if (!client) {
    return fail({
      code: "not_ready",
      message: "SourceNerve local client is not initialized",
      retryable: true,
    });
  }
  try {
    return ok(await operation(client));
  } catch (error) {
    return fail(toDesktopError(error));
  }
}

export function parseGraphStatus(value: unknown, workspace: string): IntelligenceGraphStatus {
  const item = requireRecord(value, "graph status");
  if (item.workspace !== workspace) throw invalid("graph status workspace mismatch");
  return {
    workspace,
    graphVersion: requireNonNegativeInteger(item.graph_version, "graph_version"),
    ...(optionalCommitSha(item.indexed_head) ? { indexedHead: item.indexed_head as string } : {}),
    supportedFiles: requireNonNegativeInteger(item.supported_files, "supported_files"),
    parsedFiles: requireNonNegativeInteger(item.parsed_files, "parsed_files"),
    partialFiles: requireNonNegativeInteger(item.partial_files, "partial_files"),
    failedFiles: requireNonNegativeInteger(item.failed_files, "failed_files"),
    symbols: requireNonNegativeInteger(item.symbols, "symbols"),
    edges: requireNonNegativeInteger(item.edges, "edges"),
    unresolvedReferences: requireNonNegativeInteger(item.unresolved_references, "unresolved_references"),
    scip: parseScip(item.scip),
  };
}

export function parseMemorySearch(value: unknown): IntelligenceMemorySearchResult {
  const item = requireRecord(value, "memory search");
  const hits = requireArray(item.hits, 100, "memory hits").map((raw) => {
    const hit = requireRecord(raw, "memory hit");
    return {
      path: requirePath(hit.path),
      snippet: requireText(hit.snippet, 64 * 1024, "memory snippet"),
      score: requireFiniteNumber(hit.score, "memory score"),
    };
  });
  return { hits };
}

export function parseCodeSearch(value: unknown): IntelligenceCodeSearchResult {
  const item = requireRecord(value, "code search");
  const hits = requireArray(item.hits, 100, "code hits").map((raw) => {
    const hit = requireRecord(raw, "code hit");
    return {
      path: requirePath(hit.path),
      line: requirePositiveInteger(hit.line, "code line"),
      text: requireText(hit.text, 64 * 1024, "code hit text"),
    };
  });
  if (typeof item.truncated !== "boolean") throw invalid("code search truncated flag is invalid");
  return { hits, truncated: item.truncated };
}

export function parseSymbolSearch(value: unknown): IntelligenceSymbolSearchResult {
  const item = requireRecord(value, "symbol search");
  return {
    symbols: requireArray(item.symbols, 100, "symbols").map(parseSymbol),
  };
}

export function parseSymbolContext(value: unknown): IntelligenceSymbolContext {
  const item = requireRecord(value, "symbol context");
  return {
    symbol: parseSymbol(item.symbol),
    outgoing: requireArray(item.outgoing, 200, "outgoing graph edges").map(parseNeighbor),
    incoming: requireArray(item.incoming, 200, "incoming graph edges").map(parseNeighbor),
  };
}

export function parseTrace(value: unknown): IntelligenceTraceResult {
  const item = requireRecord(value, "graph trace");
  return {
    root: parseSymbol(item.root),
    nodes: requireArray(item.nodes, 200, "graph trace nodes").map(parseTraceNode),
  };
}

export function parseArchitectureMap(value: unknown): IntelligenceArchitectureMapResult {
  const item = requireRecord(value, "architecture map");
  return {
    ...(item.snapshot === null || item.snapshot === undefined ? {} : { snapshot: parseArchitectureSnapshot(item.snapshot) }),
    clusters: requireArray(item.clusters, 100, "architecture clusters").map(parseArchitectureCluster),
  };
}

export function parseArchitectureClusterResult(value: unknown): IntelligenceArchitectureClusterResult {
  const item = requireRecord(value, "architecture cluster result");
  return {
    ...(item.snapshot === null || item.snapshot === undefined ? {} : { snapshot: parseArchitectureSnapshot(item.snapshot) }),
    ...(item.cluster === null || item.cluster === undefined ? {} : { cluster: parseArchitectureCluster(item.cluster) }),
  };
}

export function parseArchitectureRebuild(value: unknown): IntelligenceArchitectureRebuildResult {
  const item = requireRecord(value, "architecture rebuild");
  if (typeof item.replayed !== "boolean") throw invalid("architecture replay flag is invalid");
  return {
    snapshot: parseArchitectureSnapshot(item.snapshot),
    clusterCount: requireNonNegativeInteger(item.cluster_count, "cluster_count"),
    replayed: item.replayed,
  };
}

export function parseContextPack(value: unknown): IntelligenceContextPack {
  const item = requireRecord(value, "context pack");
  if (typeof item.clean !== "boolean" || typeof item.truncated !== "boolean") {
    throw invalid("context pack state flags are invalid");
  }
  return {
    workspace: requireText(item.workspace, 128, "context workspace"),
    query: requireText(item.query, 4_096, "context query"),
    head: requireCommitSha(item.head, "context head"),
    indexedHead: requireCommitSha(item.indexed_head, "context indexed head"),
    graphVersion: requireNonNegativeInteger(item.graph_version, "context graph version"),
    clean: item.clean,
    consistency: requireText(item.consistency, 128, "context consistency"),
    maxBytes: requireNonNegativeInteger(item.max_bytes, "context max bytes"),
    maxItems: requireNonNegativeInteger(item.max_items, "context max items"),
    usedBytes: requireNonNegativeInteger(item.used_bytes, "context used bytes"),
    truncated: item.truncated,
    items: requireArray(item.items, 50, "context items").map(parseContextItem),
  };
}

export function parseSemanticStatus(
  registryValue: unknown,
  annValue: unknown,
  workspace: string,
): IntelligenceSemanticStatus {
  const registry = requireRecord(registryValue, "semantic provider registry");
  const ann = requireRecord(annValue, "semantic ANN status");
  if (typeof registry.configured !== "boolean") throw invalid("semantic provider configured flag is invalid");
  if (ann.workspace !== workspace || typeof ann.snapshot_current !== "boolean") {
    throw invalid("semantic ANN status is invalid");
  }
  return {
    registry: {
      configured: registry.configured,
      ...(registry.default_provider === null || registry.default_provider === undefined
        ? {}
        : { defaultProvider: requireIdentifier(registry.default_provider, 64, "default provider") }),
      providers: requireArray(registry.providers, 8, "semantic providers").map(parseSemanticProvider),
    },
    ann: {
      workspace,
      mode: requireText(ann.mode, 64, "semantic ANN mode"),
      threshold: requireNonNegativeInteger(ann.threshold, "semantic ANN threshold"),
      eligibleChunks: requireNonNegativeInteger(ann.eligible_chunks, "semantic eligible chunks"),
      ...(ann.run_id === null || ann.run_id === undefined ? {} : { runId: requireText(ann.run_id, 128, "semantic run id") }),
      ...(ann.index_hash === null || ann.index_hash === undefined ? {} : { indexHash: requireSha256(ann.index_hash, "semantic index hash") }),
      snapshotCurrent: ann.snapshot_current,
      algorithm: requireText(ann.algorithm, 128, "semantic ANN algorithm"),
    },
  };
}

export function parseSemanticSearch(value: unknown): IntelligenceSemanticSearchResult {
  const item = requireRecord(value, "semantic search");
  return {
    ...(item.run === null || item.run === undefined ? {} : { run: parseSemanticRun(item.run) }),
    hits: requireArray(item.hits, 100, "semantic hits").map(parseSemanticHit),
  };
}

export function parseFilePreview(value: unknown): IntelligenceFilePreview {
  const item = requireRecord(value, "file preview");
  return {
    path: requirePath(item.path),
    sha256: requireSha256(item.sha256, "file sha256"),
    startLine: requirePositiveInteger(item.start_line, "file start line"),
    endLine: requireNonNegativeInteger(item.end_line, "file end line"),
    content: requireTextAllowEmpty(item.content, 1_000_000, "file content"),
  };
}

function parseSymbol(value: unknown): IntelligenceSymbolView {
  const item = requireRecord(value, "symbol");
  const startLine = optionalPositiveInteger(item.start_line, "symbol start line");
  const endLine = optionalPositiveInteger(item.end_line, "symbol end line");
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    throw invalid("symbol line range is invalid");
  }
  return {
    symbolKey: requireText(item.symbol_key, 2_048, "symbol key"),
    qualifiedName: requireText(item.qualified_name, 2_048, "qualified symbol name"),
    name: requireText(item.name, 512, "symbol name"),
    kind: requireText(item.kind, 64, "symbol kind"),
    ...(item.language === null || item.language === undefined ? {} : { language: requireText(item.language, 64, "symbol language") }),
    path: requirePath(item.path),
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(item.signature === null || item.signature === undefined ? {} : { signature: requireText(item.signature, 4_096, "symbol signature") }),
  };
}

function parseNeighbor(value: unknown): IntelligenceNeighborView {
  const item = requireRecord(value, "graph neighbor");
  return {
    edgeType: requireText(item.edge_type, 128, "edge type"),
    confidence: requireFiniteNumber(item.confidence, "edge confidence"),
    source: requireText(item.source, 128, "edge source"),
    symbol: parseSymbol(item.symbol),
  };
}

function parseTraceNode(value: unknown): IntelligenceTraceNode {
  const item = requireRecord(value, "trace node");
  return {
    distance: requireNonNegativeInteger(item.distance, "trace distance"),
    via: requireText(item.via, 128, "trace via"),
    source: requireText(item.source, 128, "trace source"),
    symbol: parseSymbol(item.symbol),
  };
}

function parseArchitectureSnapshot(value: unknown): IntelligenceArchitectureSnapshot {
  const item = requireRecord(value, "architecture snapshot");
  return {
    id: requireText(item.id, 128, "architecture snapshot id"),
    workspace: requireText(item.workspace, 128, "architecture workspace"),
    gitHead: requireCommitSha(item.git_head, "architecture git head"),
    graphVersion: requireNonNegativeInteger(item.graph_version, "architecture graph version"),
    snapshotHash: requireSha256(item.snapshot_hash, "architecture snapshot hash"),
    createdAt: requireNonNegativeInteger(item.created_at, "architecture created_at"),
  };
}

function parseArchitectureDependency(value: unknown): IntelligenceArchitectureDependency {
  const item = requireRecord(value, "architecture dependency");
  return {
    clusterKey: requireText(item.cluster_key, 512, "dependency cluster key"),
    edgeCount: requireNonNegativeInteger(item.edge_count, "dependency edge count"),
    weightScore: requireInteger(item.weight_score, "dependency weight score"),
    edgeTypes: requireArray(item.edge_types, 16, "dependency edge types").map((entry) => requireText(entry, 128, "edge type")),
  };
}

function parseArchitectureCluster(value: unknown): IntelligenceArchitectureCluster {
  const item = requireRecord(value, "architecture cluster");
  return {
    clusterKey: requireText(item.cluster_key, 512, "cluster key"),
    displayName: requireText(item.display_name, 512, "cluster display name"),
    fileCount: requireNonNegativeInteger(item.file_count, "cluster file count"),
    symbolCount: requireNonNegativeInteger(item.symbol_count, "cluster symbol count"),
    internalEdgeCount: requireNonNegativeInteger(item.internal_edge_count, "cluster internal edges"),
    externalEdgeCount: requireNonNegativeInteger(item.external_edge_count, "cluster external edges"),
    centralityScore: requireInteger(item.centrality_score, "cluster centrality"),
    representativeFiles: requireArray(item.representative_files, 12, "representative files").map(requirePath),
    representativeSymbols: requireArray(item.representative_symbols, 20, "representative symbols").map((entry) => requireText(entry, 2_048, "representative symbol")),
    inbound: requireArray(item.inbound, 64, "inbound dependencies").map(parseArchitectureDependency),
    outbound: requireArray(item.outbound, 64, "outbound dependencies").map(parseArchitectureDependency),
  };
}

function parseContextItem(value: unknown): IntelligenceContextItem {
  const item = requireRecord(value, "context item");
  const startLine = requirePositiveInteger(item.start_line, "context item start line");
  const endLine = requirePositiveInteger(item.end_line, "context item end line");
  if (endLine < startLine) throw invalid("context item range is invalid");
  return {
    path: requirePath(item.path),
    startLine,
    endLine,
    content: requireTextAllowEmpty(item.content, 128 * 1024, "context content"),
    sha256: requireSha256(item.sha256, "context sha256"),
    symbolKeys: requireArray(item.symbol_keys, 32, "context symbol keys").map((entry) => requireText(entry, 2_048, "context symbol key")),
    score: requireInteger(item.score, "context score"),
    reasons: requireArray(item.reasons, 32, "context reasons").map(parseContextReason),
    edgeSources: requireArray(item.edge_sources, 32, "context edge sources").map((entry) => requireText(entry, 256, "context edge source")),
  };
}

function parseContextReason(value: unknown): IntelligenceContextReason {
  const item = requireRecord(value, "context reason");
  return {
    signal: requireText(item.signal, 128, "context signal"),
    score: requireInteger(item.score, "context reason score"),
    detail: requireText(item.detail, 4_096, "context reason detail"),
  };
}

function parseSemanticProvider(value: unknown): IntelligenceSemanticProvider {
  const item = requireRecord(value, "semantic provider");
  if (typeof item.is_default !== "boolean") throw invalid("semantic provider default flag is invalid");
  return {
    id: requireIdentifier(item.id, 64, "semantic provider id"),
    model: requireText(item.model, 192, "semantic model"),
    kind: requireText(item.kind, 64, "semantic provider kind"),
    isDefault: item.is_default,
  };
}

function parseSemanticRun(value: unknown): IntelligenceSemanticRun {
  const item = requireRecord(value, "semantic run");
  return {
    id: requireText(item.id, 128, "semantic run id"),
    provider: requireText(item.provider, 128, "semantic run provider"),
    model: requireText(item.model, 192, "semantic run model"),
    dimension: requirePositiveInteger(item.dimension, "semantic dimension"),
    gitHead: requireCommitSha(item.git_head, "semantic run git head"),
    graphVersion: requireNonNegativeInteger(item.graph_version, "semantic graph version"),
  };
}

function parseSemanticHit(value: unknown): IntelligenceSemanticHit {
  const item = requireRecord(value, "semantic hit");
  const startLine = requirePositiveInteger(item.start_line, "semantic start line");
  const endLine = requirePositiveInteger(item.end_line, "semantic end line");
  if (endLine < startLine) throw invalid("semantic hit range is invalid");
  return {
    path: requirePath(item.path),
    startLine,
    endLine,
    score: requireFiniteNumber(item.score, "semantic score"),
    fileSha256: requireSha256(item.file_sha256, "semantic file sha256"),
    runId: requireText(item.run_id, 128, "semantic run id"),
    provider: requireText(item.provider, 128, "semantic provider"),
    model: requireText(item.model, 192, "semantic model"),
  };
}

function parseScip(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  if (typeof value.active === "boolean") result.active = value.active;
  for (const [source, target] of [
    ["provider", "provider"],
    ["provider_tool", "providerTool"],
    ["provider_version", "providerVersion"],
  ] as const) {
    if (typeof value[source] === "string" && value[source].length <= 128) result[target] = value[source];
  }
  for (const [source, target] of [
    ["documents", "documents"],
    ["mapped_symbols", "mappedSymbols"],
    ["materialized_edges", "materializedEdges"],
    ["unresolved_facts", "unresolvedFacts"],
  ] as const) {
    if (typeof value[source] === "number" && Number.isSafeInteger(value[source]) && value[source] >= 0) result[target] = value[source];
  }
  return result;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`${label} response is not an object`);
  return value;
}

function requireArray(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalid(`${label} response is invalid`);
  return value;
}

function requireText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw invalid(`${label} is invalid`);
  }
  return value;
}

function requireTextAllowEmpty(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length > max || /[\u0000]/.test(value)) throw invalid(`${label} is invalid`);
  return value;
}

function requireIdentifier(value: unknown, max: number, label: string): string {
  const text = requireText(value, max, label);
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw invalid(`${label} is invalid`);
  return text;
}

function requirePath(value: unknown): string {
  const text = requireText(value, 1_024, "repository path");
  const normalized = text.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) throw invalid("repository path is absolute");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw invalid("repository path is unsafe");
  return normalized;
}

function requireCommitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) throw invalid(`${label} is invalid`);
  return value;
}

function optionalCommitSha(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && /^[0-9a-f]{40}$/i.test(value));
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) throw invalid(`${label} is invalid`);
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(`${label} is invalid`);
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalid(`${label} is invalid`);
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const number = requireInteger(value, label);
  if (number < 0) throw invalid(`${label} is invalid`);
  return number;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const number = requireInteger(value, label);
  if (number < 1) throw invalid(`${label} is invalid`);
  return number;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  return requirePositiveInteger(value, label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): Error {
  return new Error(`SourceNerve intelligence response invalid: ${message}`);
}

function toDesktopError(error: unknown): DesktopError {
  if (error instanceof SourceNerveHttpError) {
    if (error.status === 401) return { code: "unauthorized", message: error.message, retryable: false };
    if (error.status === 403) return { code: "forbidden", message: error.message, retryable: false };
    if (error.status === 404) return { code: "not_found", message: error.message, retryable: false };
    if (error.status >= 500) return { code: "service_error", message: error.message, retryable: true };
    return { code: "service_error", message: error.message, retryable: false };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "timeout", message: "SourceNerve intelligence request timed out", retryable: true };
  }
  return {
    code: "service_error",
    message: error instanceof Error ? error.message : "SourceNerve intelligence request failed",
    retryable: true,
  };
}

function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function fail<T>(error: DesktopError): DesktopResult<T> {
  return { ok: false, error };
}
