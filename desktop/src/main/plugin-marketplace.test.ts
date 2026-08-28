import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
}));

import {
  DEFAULT_PLUGIN_REGISTRY_URL,
  parseCodexMarketplaceIndex,
  parseRemotePluginRegistry,
  stageRemotePluginPackage,
} from "./plugin-marketplace";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SourceNerve public plugin registry", () => {
  it("stages both bundled SourceNerve skills for ChatGPT/Codex", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-plugin-default-skills-"));
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/.codex-plugin/plugin.json")) return new Response("{}", { status: 200 });
      if (url.endsWith("/.mcp.json")) return new Response("{}", { status: 200 });
      if (url.endsWith("/skills/karpathy-guidelines/SKILL.md")) return new Response("# Karpathy Guidelines\n", { status: 200 });
      if (url.endsWith("/skills/repository-change-workflow/SKILL.md")) return new Response("# Repository change workflow\n", { status: 200 });
      return new Response("not found", { status: 404 });
    }));

    try {
      const staged = await stageRemotePluginPackage(DEFAULT_PLUGIN_REGISTRY_URL, cacheRoot, "sourcenerve");
      expect(await readFile(path.join(staged.sourcePath, "skills", "karpathy-guidelines", "SKILL.md"), "utf8")).toContain("Karpathy Guidelines");
      expect(await readFile(path.join(staged.sourcePath, "skills", "repository-change-workflow", "SKILL.md"), "utf8")).toContain("Repository change workflow");
      expect(requested.some((url) => url.endsWith("/skills/karpathy-guidelines/SKILL.md"))).toBe(true);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
  it("parses bounded HTTPS package entries", () => {
    const entries = parseRemotePluginRegistry(JSON.stringify({
      schemaVersion: 1,
      plugins: [
        {
          name: "fixture",
          category: "Developer Tools",
          source: {
            source: "https",
            baseUrl: "https://example.com/plugins/fixture/",
            files: [
              ".codex-plugin/plugin.json",
              ".mcp.json",
              "skills/review/SKILL.md",
            ],
          },
        },
      ],
    }));

    expect(entries).toEqual([
      {
        catalogId: "fixture",
        category: "Developer Tools",
        baseUrl: "https://example.com/plugins/fixture/",
        files: [
          ".codex-plugin/plugin.json",
          ".mcp.json",
          "skills/review/SKILL.md",
        ],
      },
    ]);
  });

  it("accepts the current Codex marketplace scale without staging packages", () => {
    const plugins = Array.from({ length: 220 }, (_, index) => ({
      name: `plugin-${index}`,
      category: index % 2 === 0 ? "Developer Tools" : "Productivity",
      source: {
        source: "local",
        path: `./plugins/plugin-${index}`,
      },
      policy: { installation: "AVAILABLE" },
    }));

    const entries = parseCodexMarketplaceIndex({ plugins });
    expect(entries).toHaveLength(220);
    expect(entries[42]).toEqual({
      catalogId: "plugin-42",
      category: "Developer Tools",
      packagePath: "plugins/plugin-42",
    });
  });

  it("filters unavailable Codex marketplace entries at index time", () => {
    const entries = parseCodexMarketplaceIndex({
      plugins: [
        {
          name: "available",
          source: { source: "local", path: "./plugins/available" },
          policy: { installation: "AVAILABLE" },
        },
        {
          name: "hidden",
          source: { source: "local", path: "./plugins/hidden" },
          policy: { installation: "DISABLED" },
        },
      ],
    });

    expect(entries.map((entry) => entry.catalogId)).toEqual(["available"]);
  });

  it("stages app-backed Codex plugins instead of rejecting their .app.json dependency", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-plugin-marketplace-"));
    const marketplace = JSON.stringify({
      plugins: [
        {
          name: "atlassian-rovo",
          category: "Productivity",
          source: { source: "local", path: "./plugins/atlassian-rovo" },
          policy: { installation: "AVAILABLE" },
        },
      ],
    });
    const manifest = JSON.stringify({
      name: "atlassian-rovo",
      version: "1.0.3",
      description: "Manage Jira and Confluence fast",
      apps: "./.app.json",
    });
    const appManifest = JSON.stringify({
      apps: {
        "atlassian-rovo": {
          id: "connector_692de805e3ec8191834719067174a384",
        },
      },
    });

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === DEFAULT_PLUGIN_REGISTRY_URL) return new Response(marketplace, { status: 200 });
      if (url.endsWith("/plugins/atlassian-rovo/.codex-plugin/plugin.json")) {
        return new Response(manifest, { status: 200 });
      }
      if (url.endsWith("/plugins/atlassian-rovo/.app.json")) {
        return new Response(appManifest, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    try {
      const staged = await stageRemotePluginPackage(
        DEFAULT_PLUGIN_REGISTRY_URL,
        cacheRoot,
        "atlassian-rovo",
      );
      expect(staged.catalogId).toBe("atlassian-rovo");
      expect(JSON.parse(await readFile(path.join(staged.sourcePath, ".app.json"), "utf8"))).toEqual({
        apps: {
          "atlassian-rovo": {
            id: "connector_692de805e3ec8191834719067174a384",
          },
        },
      });
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("rejects package file traversal", () => {
    expect(() => parseRemotePluginRegistry(JSON.stringify({
      schemaVersion: 1,
      plugins: [
        {
          name: "fixture",
          source: {
            source: "https",
            baseUrl: "https://example.com/plugins/fixture/",
            files: [
              ".codex-plugin/plugin.json",
              "../outside.txt",
            ],
          },
        },
      ],
    }))).toThrow(/escapes the package root/i);
  });

  it("requires the declarative plugin manifest", () => {
    expect(() => parseRemotePluginRegistry(JSON.stringify({
      schemaVersion: 1,
      plugins: [
        {
          name: "fixture",
          source: {
            source: "https",
            baseUrl: "https://example.com/plugins/fixture/",
            files: ["skills/review/SKILL.md"],
          },
        },
      ],
    }))).toThrow(/must include \.codex-plugin\/plugin\.json/i);
  });
});
