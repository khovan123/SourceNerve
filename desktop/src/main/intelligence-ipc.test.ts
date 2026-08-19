import { describe, expect, it } from "vitest";

import {
  parseArchitectureMap,
  parseCodeSearch,
  parseContextPack,
  parseFilePreview,
  parseGraphStatus,
  parseMemorySearch,
  parseSemanticSearch,
  parseSemanticStatus,
  parseSymbolContext,
  parseSymbolSearch,
  parseTrace,
} from "./intelligence-ipc";

const SHA = "a".repeat(40);
const SHA256 = "b".repeat(64);

const symbol = {
  symbol_key: "src/http.rs::router",
  qualified_name: "router",
  name: "router",
  kind: "function",
  language: "rust",
  path: "src/http.rs",
  start_line: 10,
  end_line: 20,
  signature: "fn router() -> Router",
};

describe("repository intelligence response parsers", () => {
  it("maps graph, memory and raw-code response shapes", () => {
    expect(parseGraphStatus({
      workspace: "api",
      graph_version: 7,
      indexed_head: SHA,
      supported_files: 10,
      parsed_files: 8,
      partial_files: 1,
      failed_files: 1,
      symbols: 40,
      edges: 50,
      unresolved_references: 3,
      scip: { active: true, provider: "scip", documents: 7, mapped_symbols: 20 },
    }, "api")).toMatchObject({ graphVersion: 7, parsedFiles: 8, failedFiles: 1 });

    expect(parseMemorySearch({ hits: [{ path: "src/http.rs", snippet: "[router]", score: -1.25 }] }).hits).toHaveLength(1);
    expect(parseCodeSearch({ hits: [{ path: "src/http.rs", line: 10, text: "fn router" }], truncated: false }).hits[0]?.line).toBe(10);
  });

  it("maps symbol context and graph traces without exposing raw daemon fields", () => {
    expect(parseSymbolSearch({ symbols: [symbol] }).symbols[0]?.symbolKey).toBe("src/http.rs::router");
    expect(parseSymbolContext({
      symbol,
      outgoing: [{ edge_type: "CALLS", confidence: 0.9, source: "tree-sitter", symbol }],
      incoming: [],
      ignored: "not propagated",
    })).toMatchObject({ outgoing: [{ edgeType: "CALLS" }] });
    expect(parseTrace({
      root: symbol,
      nodes: [{ distance: 1, via: "CALLS", source: "tree-sitter", symbol }],
    }).nodes[0]?.distance).toBe(1);
  });

  it("maps architecture and context-pack budget explanations", () => {
    const cluster = {
      cluster_key: "src/http",
      display_name: "src/http",
      file_count: 2,
      symbol_count: 8,
      internal_edge_count: 6,
      external_edge_count: 4,
      centrality_score: 90,
      representative_files: ["src/http.rs"],
      representative_symbols: ["src/http.rs::router"],
      inbound: [{ cluster_key: "src/main", edge_count: 2, weight_score: 200, edge_types: ["CALLS"] }],
      outbound: [],
    };
    expect(parseArchitectureMap({
      snapshot: { id: "snapshot-1", workspace: "api", git_head: SHA, graph_version: 7, snapshot_hash: SHA256, created_at: 1 },
      clusters: [cluster],
    }).clusters[0]?.centralityScore).toBe(90);

    const pack = parseContextPack({
      workspace: "api",
      query: "auth flow",
      head: SHA,
      indexed_head: SHA,
      graph_version: 7,
      clean: true,
      consistency: "current",
      max_bytes: 65536,
      max_items: 20,
      used_bytes: 16,
      truncated: false,
      items: [{
        path: "src/http.rs",
        start_line: 10,
        end_line: 12,
        content: "fn router() {}",
        sha256: SHA256,
        symbol_keys: ["src/http.rs::router"],
        score: 700,
        reasons: [{ signal: "fts", score: 300, detail: "FTS rank 1" }],
        edge_sources: ["CALLS"],
      }],
    });
    expect(pack.items[0]?.reasons[0]?.signal).toBe("fts");
    expect(pack.usedBytes).toBe(16);
  });

  it("maps semantic status/search and enforces hashes", () => {
    const status = parseSemanticStatus({
      configured: true,
      default_provider: "openai",
      providers: [{ id: "openai", model: "text-embedding-3-small", kind: "openai", is_default: true }],
    }, {
      workspace: "api",
      mode: "hnsw",
      threshold: 128,
      eligible_chunks: 256,
      run_id: "run-1",
      index_hash: SHA256,
      snapshot_current: true,
      algorithm: "hnsw-dot-normalized",
    }, "api");
    expect(status.registry.defaultProvider).toBe("openai");

    expect(parseSemanticSearch({
      run: { id: "run-1", provider: "openai", model: "text-embedding-3-small", dimension: 1536, git_head: SHA, graph_version: 7 },
      hits: [{ path: "src/http.rs", start_line: 10, end_line: 20, score: 0.92, file_sha256: SHA256, run_id: "run-1", provider: "openai", model: "text-embedding-3-small" }],
    }).hits[0]?.score).toBe(0.92);
  });

  it("rejects unsafe daemon-provided paths before renderer delivery", () => {
    expect(() => parseFilePreview({ path: "../secret", sha256: SHA256, start_line: 1, end_line: 2, content: "secret" })).toThrow(/unsafe/);
    expect(() => parseMemorySearch({ hits: [{ path: "/etc/passwd", snippet: "x", score: 1 }] })).toThrow(/absolute/);
    expect(() => parseFilePreview({ path: "src/http.rs", sha256: "not-a-hash", start_line: 1, end_line: 2, content: "x" })).toThrow(/sha256/);
  });
});
