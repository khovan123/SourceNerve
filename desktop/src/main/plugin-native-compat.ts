import type { PluginMcpComponentView, PluginPackageReview } from "../shared/plugin-hub-api";
import { DEFAULT_PLUGIN_REGISTRY_URL } from "./plugin-marketplace";

export type NativeMarketplaceProvider = "github";

export interface MarketplacePluginCompatibility {
  review: PluginPackageReview;
  nativeProvider?: NativeMarketplaceProvider;
}

export function adaptMarketplacePluginReview(
  registryUrl: string,
  catalogId: string,
  review: PluginPackageReview,
): MarketplacePluginCompatibility {
  if (
    registryUrl !== DEFAULT_PLUGIN_REGISTRY_URL
    || catalogId !== "github"
    || review.id !== "github"
  ) {
    return { review };
  }

  const skippedGitHubMcp = review.mcpServers.filter(isGitHubMcpComponent);
  const mcpServers = review.mcpServers.filter((component) => !isGitHubMcpComponent(component));
  const warnings = [...review.warnings];

  addWarning(
    warnings,
    "GitHub is backed by SourceNerve's native GitHub provider and the authenticated gh CLI session. The marketplace app binding does not require a separate SourceNerve OAuth client.",
  );
  if (skippedGitHubMcp.length > 0) {
    addWarning(
      warnings,
      "The marketplace GitHub MCP declaration is not installed separately. SourceNerve does not copy or persist GITHUB_PAT_TOKEN; GitHub provider credentials remain owned by gh CLI.",
    );
  }

  return {
    nativeProvider: "github",
    review: {
      ...review,
      mcpServers,
      warnings,
    },
  };
}

export function hasSourceNerveCompatibleComponents(
  compatibility: MarketplacePluginCompatibility,
): boolean {
  return Boolean(
    compatibility.nativeProvider
    || compatibility.review.mcpServers.length > 0
    || compatibility.review.skills.length > 0
    || compatibility.review.harness,
  );
}

function isGitHubMcpComponent(component: PluginMcpComponentView): boolean {
  if (component.id.toLowerCase() === "github") return true;
  if (component.transport.kind !== "streamable-http") return false;
  try {
    return new URL(component.transport.url).hostname.toLowerCase() === "api.githubcopilot.com";
  } catch {
    return false;
  }
}

function addWarning(warnings: string[], value: string): void {
  if (!warnings.includes(value)) warnings.push(value);
}
