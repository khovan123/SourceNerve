import { describe, expect, it } from "vitest";

import { INTELLIGENCE_IPC } from "../shared/intelligence-api";
import { validateDesktopIpcInvocation } from "./ipc-policy";

const query = { workspace: "api", query: "workspace graph", limit: 20 };

describe("repository intelligence IPC policy", () => {
  it("accepts bounded semantic search operations and rejects payload smuggling", () => {
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.memorySearch, [query])).toBeNull();
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.codeSearch, [query])).toBeNull();
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.memorySearch, [{ ...query, url: "https://evil.example" }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.codeSearch, [{ ...query, command: "arbitrary-command" }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.memorySearch, [{ ...query, query: "x".repeat(4_097) }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.memorySearch, [{ ...query, limit: 101 }])).toMatch(/invalid/);
  });

  it("bounds graph trace depth and never accepts a renderer-controlled endpoint", () => {
    const valid = { workspace: "api", symbolKey: "src/lib.rs::handler", kind: "callers", depth: 2 };
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.trace, [valid])).toBeNull();
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.trace, [{ ...valid, depth: 5 }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.trace, [{ ...valid, kind: "shell" }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.trace, [{ ...valid, endpoint: "/api/v1/diff" }])).toMatch(/invalid/);
  });

  it("allows only bounded repository-relative file previews", () => {
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.readFile, [{
      workspace: "api",
      path: "src/http.rs",
      startLine: 10,
      endLine: 80,
    }])).toBeNull();
    for (const path of ["../secret", "/etc/passwd", "C:/Windows/System32/config", "src/../secret"] ) {
      expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.readFile, [{ workspace: "api", path, startLine: 1, endLine: 20 }])).toMatch(/invalid/);
    }
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.readFile, [{ workspace: "api", path: "src/http.rs", startLine: 1, endLine: 401 }])).toMatch(/invalid/);
  });

  it("bounds architecture and context-pack controls", () => {
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.architectureMap, [{ workspace: "api", limit: 64 }])).toBeNull();
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.architectureCluster, [{ workspace: "api", clusterKey: "src/main" }])).toBeNull();
    const context = {
      workspace: "api",
      query: "auth flow",
      seedSymbolKeys: ["src/auth.rs::login"],
      seedClusterKeys: ["src/auth"],
      maxBytes: 65_536,
      maxItems: 20,
      requireClean: true,
      providerSemantic: false,
    };
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.contextPack, [context])).toBeNull();
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.contextPack, [{ ...context, maxBytes: 512 * 1024 }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.contextPack, [{ ...context, seedClusterKeys: Array.from({ length: 13 }, (_, index) => `cluster-${index}`) }])).toMatch(/invalid/);
  });

  it("keeps semantic provider selection bounded", () => {
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.semanticStatus, ["api"])).toBeNull();
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.semanticSearch, [{ ...query, providerId: "openai" }])).toBeNull();
    expect(validateDesktopIpcInvocation(INTELLIGENCE_IPC.semanticSearch, [{ ...query, providerId: "https://evil.example" }])).toMatch(/invalid/);
  });
});
