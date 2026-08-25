import { describe, expect, it } from "vitest";

import {
  parseCodexMarketplaceIndex,
  parseRemotePluginRegistry,
} from "./plugin-marketplace";

describe("SourceNerve public plugin registry", () => {
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
