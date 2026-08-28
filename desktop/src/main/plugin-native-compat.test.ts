import { describe, expect, it } from "vitest";

import type { PluginPackageReview } from "../shared/plugin-hub-api";
import { DEFAULT_PLUGIN_REGISTRY_URL } from "./plugin-marketplace";
import {
  adaptMarketplacePluginReview,
  hasSourceNerveCompatibleComponents,
} from "./plugin-native-compat";

function review(overrides: Partial<PluginPackageReview> = {}): PluginPackageReview {
  return {
    id: "github",
    name: "GitHub",
    version: "0.1.6",
    description: "GitHub plugin",
    source: { kind: "https", label: DEFAULT_PLUGIN_REGISTRY_URL },
    manifestHash: "a".repeat(64),
    mcpServers: [],
    skills: [],
    warnings: [],
    ...overrides,
  };
}

describe("official marketplace native provider compatibility", () => {
  it("accepts the official GitHub app-only package through the native provider", () => {
    const compatibility = adaptMarketplacePluginReview(
      DEFAULT_PLUGIN_REGISTRY_URL,
      "github",
      review(),
    );

    expect(compatibility.nativeProvider).toBe("github");
    expect(hasSourceNerveCompatibleComponents(compatibility)).toBe(true);
    expect(compatibility.review.warnings.join(" ")).toContain("native GitHub provider");
  });

  it("keeps GitHub skills but drops the duplicate hosted MCP credential lane", () => {
    const compatibility = adaptMarketplacePluginReview(
      DEFAULT_PLUGIN_REGISTRY_URL,
      "github",
      review({
        mcpServers: [{
          id: "github",
          name: "github",
          transport: { kind: "streamable-http", url: "https://api.githubcopilot.com/mcp/" },
          auth: "bearer-env",
          definitionHash: "b".repeat(64),
        }],
        skills: [{
          id: "github",
          name: "GitHub",
          relativePath: "skills/github/SKILL.md",
          contentHash: "c".repeat(64),
          bytes: 100,
        }],
      }),
    );

    expect(compatibility.nativeProvider).toBe("github");
    expect(compatibility.review.mcpServers).toEqual([]);
    expect(compatibility.review.skills.map((skill) => skill.id)).toEqual(["github"]);
    expect(compatibility.review.warnings.join(" ")).toContain("GITHUB_PAT_TOKEN");
  });

  it("does not grant native compatibility to a custom registry plugin named github", () => {
    const compatibility = adaptMarketplacePluginReview(
      "https://plugins.example.com/marketplace.json",
      "github",
      review(),
    );

    expect(compatibility.nativeProvider).toBeUndefined();
    expect(hasSourceNerveCompatibleComponents(compatibility)).toBe(false);
    expect(compatibility.review.warnings).toEqual([]);
  });
});
