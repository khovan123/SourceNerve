import { useState } from "react";

import { McpScreen as McpMarketplaceScreen } from "./McpMarketplaceScreen";
import { PluginHubScreen } from "./PluginHubScreen";
import { Panel } from "./Panel";

type ExtensionSurface = "mcp" | "plugins";

export function McpScreen() {
  const [surface, setSurface] = useState<ExtensionSurface>("mcp");

  return (
    <section className="space-y-4" aria-label="SourceNerve extensions">
      <Panel title="Extensions" eyebrow="MCP · Plugins">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSurface("mcp")}
            className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
              surface === "mcp"
                ? "bg-foreground text-background"
                : "bg-muted/55 text-muted-foreground hover:text-foreground"
            }`}
          >
            MCP
          </button>
          <button
            type="button"
            onClick={() => setSurface("plugins")}
            className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
              surface === "plugins"
                ? "bg-foreground text-background"
                : "bg-muted/55 text-muted-foreground hover:text-foreground"
            }`}
          >
            Plugins
          </button>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          MCP is the capability primitive. Plugins are higher-level distribution packages that can bundle MCP components, skills and metadata while reusing the same SourceNerve policy boundary.
        </p>
      </Panel>
      {surface === "mcp" ? <McpMarketplaceScreen /> : <PluginHubScreen />}
    </section>
  );
}
