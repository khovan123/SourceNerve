import { describe, expect, it } from "vitest";

import { parseRemotePluginRegistry } from "./plugin-marketplace";

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
