import { McpExtensionActivityPanel } from "./McpExtensionActivityPanel";
import { McpScreen as McpMarketplaceScreen } from "./McpMarketplaceScreen";

export function McpScreen() {
  return (
    <div className="space-y-4">
      <McpMarketplaceScreen />
      <McpExtensionActivityPanel />
    </div>
  );
}
