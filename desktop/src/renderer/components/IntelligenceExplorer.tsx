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
import { Panel } from "./Panel";
import { StatusBadge } from "./StatusBadge";

type IntelligenceTab = "search" | "graph" | "architecture" | "context" | "semantic";

const TABS: Array<{ id: IntelligenceTab; label: string }> = [
  { id: "search", label: "Search" },
  { id: "graph", label: "Symbols & Graph" },
  { id: "architecture", label: "Architecture" },
  { id: "context", label: "Context Pack" },
  { id: "semantic", label: "Semantic" },
];

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
    const result = await window.sourcenerveDesktop.getIntelligenceSymbolContext({
      workspace: workspaceId,
      symbolKey: symbol.symbolKey,
    });
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
    const result = await window.sourcenerveDesktop.getIntelligenceArchitectureCluster({
      workspace: workspaceId,
      clusterKey: cluster.clusterKey,
    });
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
    const result = await window.sourcenerveDesktop.readIntelligenceFile({
      workspace: workspaceId,
      path,
      startLine: start,
      endLine: end,
    });
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
      <Panel title="Repository intelligence" eyebrow="Read-only exploration">
        <p className="muted">Add and validate a workspace first. Intelligence never browses arbitrary filesystem paths.</p>
        {error ? <p className="intelligence-error" role="alert">{error}</p> : null}
      </Panel>
    );
  }

  return (
    <div className="intelligence-shell">
      <Panel
        title="Repository intelligence"
        eyebrow="Search, graph, architecture and context"
        actions={(
          <button className="button button--quiet" type="button" disabled={!workspaceId || busy === "index"} onClick={() => void reindexWorkspace()}>
            {busy === "index" ? "Indexing…" : "Index / Re-index"}
          </button>
        )}
      >
        <div className="intelligence-toolbar">
          <label className="field intelligence-workspace-field">
            <span>Workspace</span>
            <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>{workspace.name} ({workspace.id})</option>
              ))}
            </select>
          </label>
          <div className="intelligence-statuses">
            <StatusBadge label={selectedWorkspace?.access === "read-only" ? "Read-only workspace" : "Read-write workspace"} tone={selectedWorkspace?.access === "read-only" ? "neutral" : "ready"} />
            <StatusBadge label={`Index: ${selectedWorkspace?.index.state ?? "unknown"}`} tone={selectedWorkspace?.index.state === "current" ? "ready" : "warning"} />
            <StatusBadge label={graphStatus ? `Graph v${graphStatus.graphVersion}` : "Graph unavailable"} tone={graphStatus ? "ready" : "warning"} />
          </div>
        </div>
        {error ? <p className="intelligence-error" role="alert">{error}</p> : null}
      </Panel>

      <div className="intelligence-tabs" role="tablist" aria-label="Repository intelligence views">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`intelligence-tab ${tab === item.id ? "intelligence-tab--active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "search" ? (
        <SearchTab
          query={searchQuery}
          limit={searchLimit}
          memory={memorySearch}
          code={codeSearch}
          busy={busy === "search"}
          onQueryChange={setSearchQuery}
          onLimitChange={setSearchLimit}
          onRun={() => void runSearch()}
          onPreview={(path, start, end) => void previewFile(path, start, end)}
        />
      ) : null}

      {tab === "graph" ? (
        <GraphTab
          graphStatus={graphStatus}
          query={symbolQuery}
          kind={symbolKind}
          search={symbolSearch}
          selectedSymbol={selectedSymbol}
          context={symbolContext}
          traceKind={traceKind}
          traceDepth={traceDepth}
          trace={trace}
          busy={busy}
          onQueryChange={setSymbolQuery}
          onKindChange={setSymbolKind}
          onSearch={() => void runSymbolSearch()}
          onSelectSymbol={(symbol) => void selectSymbol(symbol)}
          onTraceKindChange={setTraceKind}
          onTraceDepthChange={setTraceDepth}
          onTrace={() => void runTrace()}
          onPreview={(path, start, end) => void previewFile(path, start, end)}
        />
      ) : null}

      {tab === "architecture" ? (
        <ArchitectureTab
          map={architectureMap}
          selectedCluster={selectedCluster}
          detail={clusterDetail}
          busy={busy}
          onRebuild={() => void rebuildArchitecture()}
          onSelect={(cluster) => void selectArchitectureCluster(cluster)}
          onPreview={(path) => void previewFile(path, 1, 200)}
        />
      ) : null}

      {tab === "context" ? (
        <ContextTab
          query={contextQuery}
          maxBytes={contextMaxBytes}
          maxItems={contextMaxItems}
          requireClean={requireClean}
          providerSemantic={useSemanticContext}
          semanticAvailable={semanticStatus?.registry.configured === true}
          selectedSymbol={selectedSymbol}
          selectedCluster={selectedCluster}
          pack={contextPack}
          busy={busy === "context"}
          onQueryChange={setContextQuery}
          onMaxBytesChange={setContextMaxBytes}
          onMaxItemsChange={setContextMaxItems}
          onRequireCleanChange={setRequireClean}
          onProviderSemanticChange={setUseSemanticContext}
          onBuild={() => void buildContextPack()}
          onPreview={(path, start, end) => void previewFile(path, start, end)}
        />
      ) : null}

      {tab === "semantic" ? (
        <SemanticTab
          status={semanticStatus}
          query={semanticQuery}
          providerId={semanticProviderId}
          search={semanticSearch}
          busy={busy === "semantic"}
          onQueryChange={setSemanticQuery}
          onProviderChange={setSemanticProviderId}
          onSearch={() => void runSemanticSearch()}
          onPreview={(path, start, end) => void previewFile(path, start, end)}
        />
      ) : null}

      {preview ? (
        <Panel
          title={preview.path}
          eyebrow={`Explicit file preview · lines ${preview.startLine}-${preview.endLine}`}
          actions={<button className="button button--quiet" type="button" onClick={() => setPreview(null)}>Close preview</button>}
        >
          <p className="intelligence-sha">SHA-256 {preview.sha256}</p>
          <pre className="intelligence-code-preview"><code>{preview.content || "(empty file/range)"}</code></pre>
        </Panel>
      ) : null}
    </div>
  );
}

function SearchTab(props: {
  query: string;
  limit: number;
  memory: IntelligenceMemorySearchResult | null;
  code: IntelligenceCodeSearchResult | null;
  busy: boolean;
  onQueryChange(value: string): void;
  onLimitChange(value: number): void;
  onRun(): void;
  onPreview(path: string, start: number, end: number): void;
}) {
  return (
    <Panel title="Search" eyebrow="FTS memory + bounded raw code search">
      <div className="intelligence-query-row">
        <label className="field intelligence-query"><span>Query</span><input value={props.query} maxLength={4096} onChange={(event) => props.onQueryChange(event.target.value)} placeholder="Search repository intelligence" /></label>
        <label className="field intelligence-limit"><span>Limit</span><select value={props.limit} onChange={(event) => props.onLimitChange(Number(event.target.value))}><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select></label>
        <button className="button" type="button" disabled={props.busy || !props.query.trim()} onClick={props.onRun}>{props.busy ? "Searching…" : "Search"}</button>
      </div>
      <div className="intelligence-columns">
        <section>
          <h3>Indexed memory / FTS</h3>
          <ResultCount count={props.memory?.hits.length} />
          <div className="intelligence-result-list">
            {props.memory?.hits.map((hit, index) => (
              <article className="intelligence-result" key={`${hit.path}-${index}`}>
                <strong>{hit.path}</strong><span className="muted">score {formatScore(hit.score)}</span>
                <p>{hit.snippet}</p>
                <button className="button button--quiet" type="button" onClick={() => props.onPreview(hit.path, 1, 200)}>Preview file</button>
              </article>
            ))}
          </div>
        </section>
        <section>
          <h3>Raw code search</h3>
          <ResultCount count={props.code?.hits.length} suffix={props.code?.truncated ? " · truncated" : ""} />
          <div className="intelligence-result-list">
            {props.code?.hits.map((hit, index) => (
              <article className="intelligence-result" key={`${hit.path}-${hit.line}-${index}`}>
                <strong>{hit.path}:{hit.line}</strong><pre>{hit.text}</pre>
                <button className="button button--quiet" type="button" onClick={() => props.onPreview(hit.path, Math.max(1, hit.line - 20), hit.line + 40)}>Preview around match</button>
              </article>
            ))}
          </div>
        </section>
      </div>
    </Panel>
  );
}

function GraphTab(props: {
  graphStatus: IntelligenceGraphStatus | null;
  query: string;
  kind: string;
  search: IntelligenceSymbolSearchResult | null;
  selectedSymbol: IntelligenceSymbolView | null;
  context: IntelligenceSymbolContext | null;
  traceKind: IntelligenceTraceKind;
  traceDepth: number;
  trace: IntelligenceTraceResult | null;
  busy: string | null;
  onQueryChange(value: string): void;
  onKindChange(value: string): void;
  onSearch(): void;
  onSelectSymbol(symbol: IntelligenceSymbolView): void;
  onTraceKindChange(kind: IntelligenceTraceKind): void;
  onTraceDepthChange(depth: number): void;
  onTrace(): void;
  onPreview(path: string, start: number, end: number): void;
}) {
  return (
    <div className="intelligence-stack">
      <Panel title="Graph health" eyebrow="Indexed parse and edge coverage">
        {props.graphStatus ? (
          <div className="intelligence-metrics">
            <Metric label="Supported files" value={props.graphStatus.supportedFiles} />
            <Metric label="Parsed" value={props.graphStatus.parsedFiles} />
            <Metric label="Partial" value={props.graphStatus.partialFiles} />
            <Metric label="Failed" value={props.graphStatus.failedFiles} />
            <Metric label="Symbols" value={props.graphStatus.symbols} />
            <Metric label="Edges" value={props.graphStatus.edges} />
            <Metric label="Unresolved refs" value={props.graphStatus.unresolvedReferences} />
          </div>
        ) : <p className="muted">Graph status is unavailable until the workspace is indexed.</p>}
      </Panel>
      <Panel title="Symbol explorer" eyebrow="Definitions, edges and impact">
        <div className="intelligence-query-row">
          <label className="field intelligence-query"><span>Symbol query</span><input value={props.query} maxLength={4096} onChange={(event) => props.onQueryChange(event.target.value)} placeholder="router, WorkspaceManager, index_workspace…" /></label>
          <label className="field"><span>Kind (optional)</span><input value={props.kind} maxLength={64} onChange={(event) => props.onKindChange(event.target.value)} placeholder="function" /></label>
          <button className="button" type="button" disabled={!props.query.trim() || props.busy === "symbols"} onClick={props.onSearch}>{props.busy === "symbols" ? "Searching…" : "Find symbols"}</button>
        </div>
        <div className="intelligence-columns intelligence-columns--graph">
          <div className="intelligence-result-list">
            {props.search?.symbols.map((symbol) => (
              <button key={symbol.symbolKey} className={`intelligence-symbol ${props.selectedSymbol?.symbolKey === symbol.symbolKey ? "intelligence-symbol--selected" : ""}`} type="button" onClick={() => props.onSelectSymbol(symbol)}>
                <strong>{symbol.qualifiedName}</strong><span>{symbol.kind} · {symbol.path}{symbol.startLine ? `:${symbol.startLine}` : ""}</span>
              </button>
            ))}
          </div>
          <div>
            {props.selectedSymbol ? (
              <>
                <h3>{props.selectedSymbol.qualifiedName}</h3>
                <p className="muted">{props.selectedSymbol.signature ?? `${props.selectedSymbol.kind} · ${props.selectedSymbol.path}`}</p>
                {props.selectedSymbol.startLine ? <button className="button button--quiet" type="button" onClick={() => props.onPreview(props.selectedSymbol!.path, Math.max(1, props.selectedSymbol!.startLine! - 10), (props.selectedSymbol!.endLine ?? props.selectedSymbol!.startLine!) + 20)}>Preview symbol source</button> : null}
                <div className="intelligence-edge-grid">
                  <EdgeList title="Incoming" edges={props.context?.incoming ?? []} onSelect={props.onSelectSymbol} />
                  <EdgeList title="Outgoing" edges={props.context?.outgoing ?? []} onSelect={props.onSelectSymbol} />
                </div>
                <div className="intelligence-query-row intelligence-trace-controls">
                  <label className="field"><span>Trace</span><select value={props.traceKind} onChange={(event) => props.onTraceKindChange(event.target.value as IntelligenceTraceKind)}><option value="callers">Callers</option><option value="callees">Callees</option><option value="references">References</option><option value="impact">Impact</option></select></label>
                  <label className="field intelligence-limit"><span>Depth</span><select value={props.traceDepth} onChange={(event) => props.onTraceDepthChange(Number(event.target.value))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option><option value={4}>4</option></select></label>
                  <button className="button" type="button" disabled={props.busy === "trace"} onClick={props.onTrace}>{props.busy === "trace" ? "Tracing…" : "Run trace"}</button>
                </div>
                {props.trace ? <div className="intelligence-result-list">{props.trace.nodes.map((node, index) => <article className="intelligence-result" key={`${node.symbol.symbolKey}-${node.distance}-${index}`}><strong>{node.symbol.qualifiedName}</strong><span className="muted">distance {node.distance} · {node.via} · {node.source}</span><p>{node.symbol.path}{node.symbol.startLine ? `:${node.symbol.startLine}` : ""}</p><button className="button button--quiet" type="button" onClick={() => props.onSelectSymbol(node.symbol)}>Inspect symbol</button></article>)}</div> : null}
              </>
            ) : <p className="muted">Select a symbol to inspect incoming/outgoing edges and traces.</p>}
          </div>
        </div>
      </Panel>
    </div>
  );
}

function ArchitectureTab(props: {
  map: IntelligenceArchitectureMapResult | null;
  selectedCluster: IntelligenceArchitectureCluster | null;
  detail: IntelligenceArchitectureClusterResult | null;
  busy: string | null;
  onRebuild(): void;
  onSelect(cluster: IntelligenceArchitectureCluster): void;
  onPreview(path: string): void;
}) {
  const cluster = props.detail?.cluster ?? props.selectedCluster;
  return (
    <Panel title="Architecture map" eyebrow="Server-derived repository clusters" actions={<button className="button button--quiet" type="button" disabled={props.busy === "architecture-rebuild"} onClick={props.onRebuild}>{props.busy === "architecture-rebuild" ? "Building…" : "Build / Rebuild map"}</button>}>
      {props.map?.snapshot ? <p className="muted">Snapshot {shortHash(props.map.snapshot.snapshotHash)} · graph v{props.map.snapshot.graphVersion} · {props.map.clusters.length} clusters</p> : <p className="muted">No current architecture snapshot. Build one after indexing a clean workspace.</p>}
      <div className="intelligence-columns intelligence-columns--architecture">
        <div className="intelligence-cluster-grid">
          {props.map?.clusters.map((item) => (
            <button type="button" className={`intelligence-cluster ${props.selectedCluster?.clusterKey === item.clusterKey ? "intelligence-cluster--selected" : ""}`} key={item.clusterKey} onClick={() => props.onSelect(item)}>
              <strong>{item.displayName}</strong><span>{item.fileCount} files · {item.symbolCount} symbols</span><span>centrality {item.centralityScore} · {item.externalEdgeCount} external edges</span>
            </button>
          ))}
        </div>
        <div>
          {cluster ? (
            <>
              <h3>{cluster.displayName}</h3>
              <div className="intelligence-metrics"><Metric label="Files" value={cluster.fileCount} /><Metric label="Symbols" value={cluster.symbolCount} /><Metric label="Internal edges" value={cluster.internalEdgeCount} /><Metric label="External edges" value={cluster.externalEdgeCount} /></div>
              <h4>Representative files</h4>
              <div className="intelligence-chip-list">{cluster.representativeFiles.map((path) => <button className="intelligence-chip" type="button" key={path} onClick={() => props.onPreview(path)}>{path}</button>)}</div>
              <h4>Dependencies</h4>
              <DependencyList title="Inbound" dependencies={cluster.inbound} />
              <DependencyList title="Outbound" dependencies={cluster.outbound} />
            </>
          ) : <p className="muted">Select a cluster to inspect representative files and dependencies.</p>}
        </div>
      </div>
    </Panel>
  );
}

function ContextTab(props: {
  query: string;
  maxBytes: number;
  maxItems: number;
  requireClean: boolean;
  providerSemantic: boolean;
  semanticAvailable: boolean;
  selectedSymbol: IntelligenceSymbolView | null;
  selectedCluster: IntelligenceArchitectureCluster | null;
  pack: IntelligenceContextPack | null;
  busy: boolean;
  onQueryChange(value: string): void;
  onMaxBytesChange(value: number): void;
  onMaxItemsChange(value: number): void;
  onRequireCleanChange(value: boolean): void;
  onProviderSemanticChange(value: boolean): void;
  onBuild(): void;
  onPreview(path: string, start: number, end: number): void;
}) {
  return (
    <Panel title="Context pack" eyebrow="Explainable, budgeted context selection">
      <div className="intelligence-query-row">
        <label className="field intelligence-query"><span>Context question</span><input value={props.query} maxLength={4096} onChange={(event) => props.onQueryChange(event.target.value)} placeholder="How does OAuth callback handling reach workspace grants?" /></label>
        <label className="field"><span>Budget</span><select value={props.maxBytes} onChange={(event) => props.onMaxBytesChange(Number(event.target.value))}><option value={16 * 1024}>16 KiB</option><option value={32 * 1024}>32 KiB</option><option value={64 * 1024}>64 KiB</option><option value={128 * 1024}>128 KiB</option></select></label>
        <label className="field"><span>Items</span><select value={props.maxItems} onChange={(event) => props.onMaxItemsChange(Number(event.target.value))}><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option></select></label>
        <button className="button" type="button" disabled={props.busy || !props.query.trim()} onClick={props.onBuild}>{props.busy ? "Building…" : "Build context pack"}</button>
      </div>
      <div className="intelligence-checkboxes">
        <label><input type="checkbox" checked={props.requireClean} onChange={(event) => props.onRequireCleanChange(event.target.checked)} /> Require clean/current index</label>
        <label title={props.semanticAvailable ? "Use configured semantic provider" : "No semantic provider is configured"}><input type="checkbox" disabled={!props.semanticAvailable} checked={props.providerSemantic && props.semanticAvailable} onChange={(event) => props.onProviderSemanticChange(event.target.checked)} /> Provider semantic ranking</label>
      </div>
      <p className="muted">Seeds: {props.selectedSymbol ? `symbol ${props.selectedSymbol.qualifiedName}` : "no symbol"} · {props.selectedCluster ? `cluster ${props.selectedCluster.displayName}` : "no cluster"}</p>
      {props.pack ? (
        <>
          <div className="intelligence-metrics"><Metric label="Used bytes" value={props.pack.usedBytes} /><Metric label="Max bytes" value={props.pack.maxBytes} /><Metric label="Items" value={props.pack.items.length} /><Metric label="Graph version" value={props.pack.graphVersion} /></div>
          <p className="muted">Consistency: {props.pack.consistency} · clean {String(props.pack.clean)}{props.pack.truncated ? " · truncated by budget" : ""}</p>
          <div className="intelligence-result-list">{props.pack.items.map((item, index) => <article className="intelligence-result intelligence-context-item" key={`${item.path}-${item.startLine}-${index}`}><div className="intelligence-result-heading"><strong>{item.path}:{item.startLine}-{item.endLine}</strong><span>score {item.score}</span></div><pre>{clipText(item.content, 5000)}</pre><ul className="intelligence-reasons">{item.reasons.map((reason, reasonIndex) => <li key={`${reason.signal}-${reasonIndex}`}><strong>{reason.signal}</strong> +{reason.score}: {reason.detail}</li>)}</ul><button className="button button--quiet" type="button" onClick={() => props.onPreview(item.path, item.startLine, item.endLine)}>Open exact range</button></article>)}</div>
        </>
      ) : null}
    </Panel>
  );
}

function SemanticTab(props: {
  status: IntelligenceSemanticStatus | null;
  query: string;
  providerId: string;
  search: IntelligenceSemanticSearchResult | null;
  busy: boolean;
  onQueryChange(value: string): void;
  onProviderChange(value: string): void;
  onSearch(): void;
  onPreview(path: string, start: number, end: number): void;
}) {
  const providers = props.status?.registry.providers ?? [];
  return (
    <Panel title="Semantic intelligence" eyebrow="Configured provider + ANN status">
      {props.status ? (
        <div className="intelligence-statuses">
          <StatusBadge label={props.status.registry.configured ? "Provider configured" : "Provider not configured"} tone={props.status.registry.configured ? "ready" : "neutral"} />
          <StatusBadge label={`ANN: ${props.status.ann.mode}`} tone={props.status.ann.snapshotCurrent ? "ready" : "warning"} />
          <span className="muted">{props.status.ann.eligibleChunks} eligible chunks · {props.status.ann.algorithm}</span>
        </div>
      ) : <p className="muted">Semantic status unavailable.</p>}
      <div className="intelligence-query-row">
        <label className="field intelligence-query"><span>Semantic query</span><input value={props.query} maxLength={4096} onChange={(event) => props.onQueryChange(event.target.value)} placeholder="Find code related to workspace grant reconciliation" /></label>
        <label className="field"><span>Provider</span><select value={props.providerId} disabled={!props.status?.registry.configured} onChange={(event) => props.onProviderChange(event.target.value)}><option value="">Default</option>{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.id} · {provider.model}</option>)}</select></label>
        <button className="button" type="button" disabled={props.busy || !props.query.trim() || !props.status?.registry.configured} onClick={props.onSearch}>{props.busy ? "Searching…" : "Semantic search"}</button>
      </div>
      {props.search?.run ? <p className="muted">Run {props.search.run.id} · {props.search.run.provider}/{props.search.run.model} · graph v{props.search.run.graphVersion}</p> : null}
      <div className="intelligence-result-list">{props.search?.hits.map((hit, index) => <article className="intelligence-result" key={`${hit.path}-${hit.startLine}-${index}`}><strong>{hit.path}:{hit.startLine}-{hit.endLine}</strong><span className="muted">score {formatScore(hit.score)} · {hit.provider}/{hit.model}</span><button className="button button--quiet" type="button" onClick={() => props.onPreview(hit.path, hit.startLine, hit.endLine)}>Preview hit</button></article>)}</div>
    </Panel>
  );
}

function EdgeList(props: { title: string; edges: IntelligenceSymbolContext["incoming"]; onSelect(symbol: IntelligenceSymbolView): void }) {
  return <section><h4>{props.title} ({props.edges.length})</h4><div className="intelligence-edge-list">{props.edges.slice(0, 50).map((edge, index) => <button type="button" key={`${edge.symbol.symbolKey}-${edge.edgeType}-${index}`} onClick={() => props.onSelect(edge.symbol)}><strong>{edge.symbol.qualifiedName}</strong><span>{edge.edgeType} · {formatScore(edge.confidence)} · {edge.source}</span></button>)}</div></section>;
}

function DependencyList(props: { title: string; dependencies: IntelligenceArchitectureCluster["inbound"] }) {
  return <section className="intelligence-dependencies"><strong>{props.title}</strong>{props.dependencies.length === 0 ? <span className="muted"> none</span> : <ul>{props.dependencies.slice(0, 32).map((dependency) => <li key={`${props.title}-${dependency.clusterKey}`}>{dependency.clusterKey}: {dependency.edgeCount} edges ({dependency.edgeTypes.join(", ")})</li>)}</ul>}</section>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="intelligence-metric"><span>{label}</span><strong>{value.toLocaleString()}</strong></div>;
}

function ResultCount({ count, suffix = "" }: { count?: number; suffix?: string }) {
  return <p className="muted">{count === undefined ? "Run a search to load results." : `${count} result${count === 1 ? "" : "s"}${suffix}`}</p>;
}

function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

function shortHash(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function clipText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… preview clipped in UI …`;
}
