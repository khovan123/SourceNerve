import type { DesktopResult } from "./desktop-api";

export const INTELLIGENCE_IPC = {
  graphStatus: "desktop:intelligence-graph-status",
  memorySearch: "desktop:intelligence-memory-search",
  codeSearch: "desktop:intelligence-code-search",
  symbolSearch: "desktop:intelligence-symbol-search",
  symbolContext: "desktop:intelligence-symbol-context",
  trace: "desktop:intelligence-trace",
  architectureMap: "desktop:intelligence-architecture-map",
  architectureCluster: "desktop:intelligence-architecture-cluster",
  architectureRebuild: "desktop:intelligence-architecture-rebuild",
  contextPack: "desktop:intelligence-context-pack",
  semanticStatus: "desktop:intelligence-semantic-status",
  semanticSearch: "desktop:intelligence-semantic-search",
  readFile: "desktop:intelligence-read-file",
} as const;

export interface IntelligenceQueryInput {
  workspace: string;
  query: string;
  limit: number;
}

export interface IntelligenceMemoryHit {
  path: string;
  snippet: string;
  score: number;
}

export interface IntelligenceMemorySearchResult {
  hits: IntelligenceMemoryHit[];
}

export interface IntelligenceCodeHit {
  path: string;
  line: number;
  text: string;
}

export interface IntelligenceCodeSearchResult {
  hits: IntelligenceCodeHit[];
  truncated: boolean;
}

export interface IntelligenceGraphStatus {
  workspace: string;
  graphVersion: number;
  indexedHead?: string;
  supportedFiles: number;
  parsedFiles: number;
  partialFiles: number;
  failedFiles: number;
  symbols: number;
  edges: number;
  unresolvedReferences: number;
  scip: Record<string, unknown>;
}

export interface IntelligenceSymbolView {
  symbolKey: string;
  qualifiedName: string;
  name: string;
  kind: string;
  language?: string;
  path: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
}

export interface IntelligenceSymbolSearchInput extends IntelligenceQueryInput {
  kind?: string;
}

export interface IntelligenceSymbolSearchResult {
  symbols: IntelligenceSymbolView[];
}

export interface IntelligenceSymbolKeyInput {
  workspace: string;
  symbolKey: string;
}

export interface IntelligenceNeighborView {
  edgeType: string;
  confidence: number;
  source: string;
  symbol: IntelligenceSymbolView;
}

export interface IntelligenceSymbolContext {
  symbol: IntelligenceSymbolView;
  outgoing: IntelligenceNeighborView[];
  incoming: IntelligenceNeighborView[];
}

export type IntelligenceTraceKind = "callers" | "callees" | "references" | "impact";

export interface IntelligenceTraceInput extends IntelligenceSymbolKeyInput {
  kind: IntelligenceTraceKind;
  depth: number;
}

export interface IntelligenceTraceNode {
  distance: number;
  via: string;
  source: string;
  symbol: IntelligenceSymbolView;
}

export interface IntelligenceTraceResult {
  root: IntelligenceSymbolView;
  nodes: IntelligenceTraceNode[];
}

export interface IntelligenceArchitectureSnapshot {
  id: string;
  workspace: string;
  gitHead: string;
  graphVersion: number;
  snapshotHash: string;
  createdAt: number;
}

export interface IntelligenceArchitectureDependency {
  clusterKey: string;
  edgeCount: number;
  weightScore: number;
  edgeTypes: string[];
}

export interface IntelligenceArchitectureCluster {
  clusterKey: string;
  displayName: string;
  fileCount: number;
  symbolCount: number;
  internalEdgeCount: number;
  externalEdgeCount: number;
  centralityScore: number;
  representativeFiles: string[];
  representativeSymbols: string[];
  inbound: IntelligenceArchitectureDependency[];
  outbound: IntelligenceArchitectureDependency[];
}

export interface IntelligenceArchitectureMapInput {
  workspace: string;
  limit: number;
}

export interface IntelligenceArchitectureMapResult {
  snapshot?: IntelligenceArchitectureSnapshot;
  clusters: IntelligenceArchitectureCluster[];
}

export interface IntelligenceArchitectureClusterInput {
  workspace: string;
  clusterKey: string;
}

export interface IntelligenceArchitectureClusterResult {
  snapshot?: IntelligenceArchitectureSnapshot;
  cluster?: IntelligenceArchitectureCluster;
}

export interface IntelligenceArchitectureRebuildResult {
  snapshot: IntelligenceArchitectureSnapshot;
  clusterCount: number;
  replayed: boolean;
}

export interface IntelligenceContextPackInput {
  workspace: string;
  query: string;
  seedSymbolKeys: string[];
  seedClusterKeys: string[];
  maxBytes: number;
  maxItems: number;
  requireClean: boolean;
  providerSemantic: boolean;
}

export interface IntelligenceContextReason {
  signal: string;
  score: number;
  detail: string;
}

export interface IntelligenceContextItem {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  sha256: string;
  symbolKeys: string[];
  score: number;
  reasons: IntelligenceContextReason[];
  edgeSources: string[];
}

export interface IntelligenceContextPack {
  workspace: string;
  query: string;
  head: string;
  indexedHead: string;
  graphVersion: number;
  clean: boolean;
  consistency: string;
  maxBytes: number;
  maxItems: number;
  usedBytes: number;
  truncated: boolean;
  items: IntelligenceContextItem[];
}

export interface IntelligenceSemanticProvider {
  id: string;
  model: string;
  kind: string;
  isDefault: boolean;
}

export interface IntelligenceSemanticStatus {
  registry: {
    configured: boolean;
    defaultProvider?: string;
    providers: IntelligenceSemanticProvider[];
  };
  ann: {
    workspace: string;
    mode: string;
    threshold: number;
    eligibleChunks: number;
    runId?: string;
    indexHash?: string;
    snapshotCurrent: boolean;
    algorithm: string;
  };
}

export interface IntelligenceSemanticSearchInput extends IntelligenceQueryInput {
  providerId?: string;
}

export interface IntelligenceSemanticRun {
  id: string;
  provider: string;
  model: string;
  dimension: number;
  gitHead: string;
  graphVersion: number;
}

export interface IntelligenceSemanticHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  fileSha256: string;
  runId: string;
  provider: string;
  model: string;
}

export interface IntelligenceSemanticSearchResult {
  run?: IntelligenceSemanticRun;
  hits: IntelligenceSemanticHit[];
}

export interface IntelligenceReadFileInput {
  workspace: string;
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface IntelligenceFilePreview {
  path: string;
  sha256: string;
  startLine: number;
  endLine: number;
  content: string;
}

declare module "./desktop-api" {
  interface SourceNerveDesktopApi {
    getIntelligenceGraphStatus(workspace: string): Promise<DesktopResult<IntelligenceGraphStatus>>;
    searchIntelligenceMemory(input: IntelligenceQueryInput): Promise<DesktopResult<IntelligenceMemorySearchResult>>;
    searchIntelligenceCode(input: IntelligenceQueryInput): Promise<DesktopResult<IntelligenceCodeSearchResult>>;
    searchIntelligenceSymbols(input: IntelligenceSymbolSearchInput): Promise<DesktopResult<IntelligenceSymbolSearchResult>>;
    getIntelligenceSymbolContext(input: IntelligenceSymbolKeyInput): Promise<DesktopResult<IntelligenceSymbolContext>>;
    traceIntelligence(input: IntelligenceTraceInput): Promise<DesktopResult<IntelligenceTraceResult>>;
    getIntelligenceArchitectureMap(input: IntelligenceArchitectureMapInput): Promise<DesktopResult<IntelligenceArchitectureMapResult>>;
    getIntelligenceArchitectureCluster(input: IntelligenceArchitectureClusterInput): Promise<DesktopResult<IntelligenceArchitectureClusterResult>>;
    rebuildIntelligenceArchitecture(workspace: string): Promise<DesktopResult<IntelligenceArchitectureRebuildResult>>;
    buildIntelligenceContextPack(input: IntelligenceContextPackInput): Promise<DesktopResult<IntelligenceContextPack>>;
    getIntelligenceSemanticStatus(workspace: string): Promise<DesktopResult<IntelligenceSemanticStatus>>;
    searchIntelligenceSemantic(input: IntelligenceSemanticSearchInput): Promise<DesktopResult<IntelligenceSemanticSearchResult>>;
    readIntelligenceFile(input: IntelligenceReadFileInput): Promise<DesktopResult<IntelligenceFilePreview>>;
  }
}
