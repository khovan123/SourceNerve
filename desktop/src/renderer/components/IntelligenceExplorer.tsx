import { useEffect, useMemo, useState } from "react";

import type { ManagedWorkspaceView } from "../../shared/desktop-api";
import type {
  IntelligenceArchitectureCluster,
  IntelligenceArchitectureClusterResult,
  IntelligenceArchitectureMapResult,
  IntelligenceCodeSearchResult,
  IntelligenceContextPack,
  IntelligenceFilePreview,
  IntelligenceGraphStatus,
  IntelligenceMemorySearchResult,
  IntelligenceSemanticSearchResult,
  IntelligenceSemanticStatus,
  IntelligenceSymbolContext,
  IntelligenceSymbolSearchResult,
  IntelligenceSymbolView,
  IntelligenceTraceKind,
  IntelligenceTraceResult,
} from "../../shared/intelligence-api";
import type { IntelligenceTab } from "../intelligence-view-model";
import { SurfaceCard } from "./molecules/SurfaceCard";
import { IntelligenceArchitectureTab } from "./organisms/IntelligenceArchitectureTab";
import { IntelligenceContextTab } from "./organisms/IntelligenceContextTab";
import { IntelligenceFilePreviewCard } from "./organisms/IntelligenceFilePreviewCard";
import { IntelligenceGraphTab } from "./organisms/IntelligenceGraphTab";
import { IntelligenceSearchTab } from "./organisms/IntelligenceSearchTab";
import { IntelligenceSemanticTab } from "./organisms/IntelligenceSemanticTab";
import { IntelligenceWorkspaceHeader } from "./organisms/IntelligenceWorkspaceHeader";

export function IntelligenceExplorer() {
  const [workspaces, setWorkspaces] = useState<ManagedWorkspaceView[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [tab, setTab] = useState<IntelligenceTab>("search");
  const [graphStatus, setGraphStatus] = useState<IntelligenceGraphStatus | null>(null);
  const [semanticStatus, setSemanticStatus] = useState<IntelligenceSemanticStatus | null>(null);
  const [architectureMap, setArchitectureMap] = useState<IntelligenceArchitectureMapResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<IntelligenceFilePreview | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchLimit, setSearchLimit] = useState(20);
  const [memorySearch, setMemorySearch] = useState<IntelligenceMemorySearchResult | null>(null);
  const [codeSearch, setCodeSearch] = useState<IntelligenceCodeSearchResult | null>(null);

  const [symbolQuery, setSymbolQuery] = useState("");
  const [symbolKind, setSymbolKind] = useState("");
  const [symbolSearch, setSymbolSearch] = useState<IntelligenceSymbolSearchResult | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<IntelligenceSymbolView | null>(null);
  const [symbolContext, setSymbolContext] = useState<IntelligenceSymbolContext | null>(null);
  const [traceKind, setTraceKind] = useState<IntelligenceTraceKind>("callers");
  const [traceDepth, setTraceDepth] = useState(2);
  const [trace, setTrace] = useState<IntelligenceTraceResult | null>(null);

  const [selectedCluster, setSelectedCluster] = useState<IntelligenceArchitectureCluster | null>(null);
  const [clusterDetail, setClusterDetail] = useState<IntelligenceArchitectureClusterResult | null>(null);

  const [contextQuery, setContextQuery] = useState("");
  const [contextMaxBytes, setContextMaxBytes] = useState(64 * 1024);
  const [contextMaxItems, setContextMaxItems] = useState(20);
  const [requireClean, setRequireClean] = useState(true);
  const [useSemanticContext, setUseSemanticContext] = useState(false);
  const [contextPack, setContextPack] = useState<IntelligenceContextPack | null>(null);

  const [semanticQuery, setSemanticQuery] = useState("");
  const [semanticProviderId, setSemanticProviderId] = useState("");
  const [semanticSearch, setSemanticSearch] = useState<IntelligenceSemanticSearchResult | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
    [workspaceId, workspaces],
  );

  useEffect(() => {
    void loadWorkspaces();
  }, []);

  useEffect(() => {
    clearWorkspaceResults();
    if (workspaceId) void loadWorkspaceMetadata(workspaceId);
  }, [workspaceId]);

  async function loadWorkspaces(preferredId?: string): Promise<void> {
    setError(null);
    const result = await window.sourcenerveDesktop.listManagedWorkspaces();
    if (!result.ok) {
      setWorkspaces([]);
      setWorkspaceId("");
      setError(result.error.message);
      return;
    }
    const ready = result.value.filter((workspace) => workspace.validation.state === "ready");
    setWorkspaces(ready);
    const target = preferredId && ready.some((workspace) => workspace.id === preferredId)
      ? preferredId
      : ready.some((workspace) => workspace.id === workspaceId)
        ? workspaceId
        : ready[0]?.id ?? "";
    setWorkspaceId(target);
  }

  async function loadWorkspaceMetadata(id: string): Promise<void> {
    setBusy("metadata");
    setError(null);
    const [graph, semantic, architecture] = await Promise.all([
      window.sourcenerveDesktop.getIntelligenceGraphStatus(id),
      window.sourcenerveDesktop.getIntelligenceSemanticStatus(id),
      window.sourcenerveDesktop.getIntelligenceArchitectureMap({ workspace: id, limit: 64 }),
    ]);
    setGraphStatus(graph.ok ? graph.value : null);
    setSemanticStatus(semantic.ok ? semantic.value : null);
    setArchitectureMap(architecture.ok ? architecture.value : null);
    if (!graph.ok) setError(graph.error.message);
    else if (!architecture.ok && architecture.error.code !== "not_found") setError(architecture.error.message);
    setBusy(null);
  }

  async function reindexWorkspace(): Promise<void> {
    if (!workspaceId) return;
    setBusy("index");
    setError(null);
    const result = await window.sourcenerveDesktop.indexWorkspace(workspaceId);
    if (!result.ok) {
      setError(result.error.message);
      setBusy(null);
      return;
    }
    await loadWorkspaces(workspaceId);
    await loadWorkspaceMetadata(workspaceId);
    setBusy(null);
  }

  async function runSearch(): Promise<void> {
    const query = searchQuery.trim();
    if (!workspaceId || !query) return;
    setBusy("search");
    setError(null);
    setMemorySearch(null);
    setCodeSearch(null);
    const input = { workspace: workspaceId, query, limit: searchLimit };
    const [memory, code] = await Promise.all([
      window.sourcenerveDesktop.searchIntelligenceMemory(input),
      window.sourcenerveDesktop.searchIntelligenceCode(input),
    ]);
    if (memory.ok) setMemorySearch(memory.value);
    else setError(memory.error.message);
    if (code.ok) setCodeSearch(code.value);
    else setError((current) => current ?? code.error.message);
    setBusy(null);
  }

  async function runSymbolSearch(): Promise<void> {
    const query = symbolQuery.trim();
    if (!workspaceId || !query) return;
    setBusy("symbols");
    setError(null);
    setSymbolSearch(null);
    setSelectedSymbol(null);
    setSymbolContext(null);
    setTrace(null);
    const result = await window.sourcenerveDesktop.searchIntelligenceSymbols({
      workspace: workspaceId,
      query,
      limit: 50,
      ...(symbolKind.trim() ? { kind: symbolKind.trim() } : {}),
    });
    if (result.ok) setSymbolSearch(result.value);
    else setError(result.error.message);
    setBusy(null);
  }

  async function selectSymbol(symbol: IntelligenceSymbolView): Promise<void> {
    setSelectedSymbol(symbol);
    setSymbolContext(null);
    setTrace(null);
    setBusy("symbol-context");
    setError(null);
    const result = await window.sourcenerveDesktop.getIntelligenceSymbolContext({ workspace: workspaceId, symbolKey: symbol.symbolKey });
    if (result.ok) setSymbolContext(result.value);
    else setError(result.error.message);
    setBusy(null);
  }

  async function runTrace(): Promise<void> {
    if (!workspaceId || !selectedSymbol) return;
    setBusy("trace");
    setError(null);
    const result = await window.sourcenerveDesktop.traceIntelligence({
      workspace: workspaceId,
      symbolKey: selectedSymbol.symbolKey,
      kind: traceKind,
      depth: traceDepth,
    });
    if (result.ok) setTrace(result.value);
    else setError(result.error.message);
    setBusy(null);
  }

  async function rebuildArchitecture(): Promise<void> {
    if (!workspaceId) return;
    setBusy("architecture-rebuild");
    setError(null);
    const rebuilt = await window.sourcenerveDesktop.rebuildIntelligenceArchitecture(workspaceId);
    if (!rebuilt.ok) {
      setError(rebuilt.error.message);
      setBusy(null);
      return;
    }
    const map = await window.sourcenerveDesktop.getIntelligenceArchitectureMap({ workspace: workspaceId, limit: 64 });
    if (map.ok) setArchitectureMap(map.value);
    else setError(map.error.message);
    setSelectedCluster(null);
    setClusterDetail(null);
    setBusy(null);
  }

  async function selectArchitectureCluster(cluster: IntelligenceArchitectureCluster): Promise<void> {
    setSelectedCluster(cluster);
    setClusterDetail(null);
    setBusy("architecture-cluster");
    setError(null);
    const result = await window.sourcenerveDesktop.getIntelligenceArchitectureCluster({ workspace: workspaceId, clusterKey: cluster.clusterKey });
    if (result.ok) setClusterDetail(result.value);
    else setError(result.error.message);
    setBusy(null);
  }

  async function buildContextPack(): Promise<void> {
    const query = contextQuery.trim();
    if (!workspaceId || !query) return;
    setBusy("context");
    setError(null);
    setContextPack(null);
    const result = await window.sourcenerveDesktop.buildIntelligenceContextPack({
      workspace: workspaceId,
      query,
      seedSymbolKeys: selectedSymbol ? [selectedSymbol.symbolKey] : [],
      seedClusterKeys: selectedCluster ? [selectedCluster.clusterKey] : [],
      maxBytes: contextMaxBytes,
      maxItems: contextMaxItems,
      requireClean,
      providerSemantic: useSemanticContext && semanticStatus?.registry.configured === true,
    });
    if (result.ok) setContextPack(result.value);
    else setError(result.error.message);
    setBusy(null);
  }

  async function runSemanticSearch(): Promise<void> {
    const query = semanticQuery.trim();
    if (!workspaceId || !query) return;
    setBusy("semantic");
    setError(null);
    setSemanticSearch(null);
    const result = await window.sourcenerveDesktop.searchIntelligenceSemantic({
      workspace: workspaceId,
      query,
      limit: 20,
      ...(semanticProviderId ? { providerId: semanticProviderId } : {}),
    });
    if (result.ok) setSemanticSearch(result.value);
    else setError(result.error.message);
    setBusy(null);
  }

  async function previewFile(path: string, startLine = 1, endLine = 200): Promise<void> {
    if (!workspaceId) return;
    const start = Math.max(1, startLine);
    const end = Math.max(start, Math.min(start + 399, endLine));
    setBusy("preview");
    setError(null);
    const result = await window.sourcenerveDesktop.readIntelligenceFile({ workspace: workspaceId, path, startLine: start, endLine: end });
    if (result.ok) setPreview(result.value);
    else setError(result.error.message);
    setBusy(null);
  }

  function clearWorkspaceResults(): void {
    setGraphStatus(null);
    setSemanticStatus(null);
    setArchitectureMap(null);
    setMemorySearch(null);
    setCodeSearch(null);
    setSymbolSearch(null);
    setSelectedSymbol(null);
    setSymbolContext(null);
    setTrace(null);
    setSelectedCluster(null);
    setClusterDetail(null);
    setContextPack(null);
    setSemanticSearch(null);
    setPreview(null);
  }

  if (workspaces.length === 0 && !busy) {
    return (
      <SurfaceCard title="Repository intelligence" eyebrow="Read-only exploration">
        <p className="text-sm leading-6 text-muted-foreground">Add and validate a workspace first. Intelligence never browses arbitrary filesystem paths.</p>
        {error ? <p className="mt-3 rounded-xl border border-danger/20 bg-danger/5 px-3 py-2 text-xs text-danger" role="alert">{error}</p> : null}
      </SurfaceCard>
    );
  }

  return (
    <section className="space-y-4" aria-label="Repository intelligence">
      <IntelligenceWorkspaceHeader
        workspaces={workspaces}
        workspaceId={workspaceId}
        selectedWorkspace={selectedWorkspace}
        graphStatus={graphStatus}
        tab={tab}
        busy={busy}
        error={error}
        onWorkspace={setWorkspaceId}
        onTab={setTab}
        onReindex={() => void reindexWorkspace()}
      />

      {tab === "search" ? <IntelligenceSearchTab query={searchQuery} limit={searchLimit} memory={memorySearch} code={codeSearch} busy={busy === "search"} onQuery={setSearchQuery} onLimit={setSearchLimit} onRun={() => void runSearch()} onPreview={(path, start, end) => void previewFile(path, start, end)} /> : null}
      {tab === "graph" ? <IntelligenceGraphTab graphStatus={graphStatus} query={symbolQuery} kind={symbolKind} search={symbolSearch} selectedSymbol={selectedSymbol} context={symbolContext} traceKind={traceKind} traceDepth={traceDepth} trace={trace} busy={busy} onQuery={setSymbolQuery} onKind={setSymbolKind} onSearch={() => void runSymbolSearch()} onSelectSymbol={(symbol) => void selectSymbol(symbol)} onTraceKind={setTraceKind} onTraceDepth={setTraceDepth} onTrace={() => void runTrace()} onPreview={(path, start, end) => void previewFile(path, start, end)} /> : null}
      {tab === "architecture" ? <IntelligenceArchitectureTab map={architectureMap} selectedCluster={selectedCluster} detail={clusterDetail} busy={busy} onRebuild={() => void rebuildArchitecture()} onSelect={(cluster) => void selectArchitectureCluster(cluster)} onPreview={(path) => void previewFile(path, 1, 200)} /> : null}
      {tab === "context" ? <IntelligenceContextTab query={contextQuery} maxBytes={contextMaxBytes} maxItems={contextMaxItems} requireClean={requireClean} providerSemantic={useSemanticContext} semanticAvailable={semanticStatus?.registry.configured === true} selectedSymbol={selectedSymbol} selectedCluster={selectedCluster} pack={contextPack} busy={busy === "context"} onQuery={setContextQuery} onMaxBytes={setContextMaxBytes} onMaxItems={setContextMaxItems} onRequireClean={setRequireClean} onProviderSemantic={setUseSemanticContext} onBuild={() => void buildContextPack()} onPreview={(path, start, end) => void previewFile(path, start, end)} /> : null}
      {tab === "semantic" ? <IntelligenceSemanticTab status={semanticStatus} query={semanticQuery} providerId={semanticProviderId} search={semanticSearch} busy={busy === "semantic"} onQuery={setSemanticQuery} onProvider={setSemanticProviderId} onSearch={() => void runSemanticSearch()} onPreview={(path, start, end) => void previewFile(path, start, end)} /> : null}
      {preview ? <IntelligenceFilePreviewCard preview={preview} onClose={() => setPreview(null)} /> : null}
    </section>
  );
}
