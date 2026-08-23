import type { SourceNerveDesktopApi } from "../shared/desktop-api";
import type { McpExtensionApi } from "../shared/mcp-extension-api";
import type { SourceNerveUpdateApi } from "../shared/update-api";

declare global {
  interface Window {
    sourcenerveDesktop: SourceNerveDesktopApi;
    sourcenerveMcpExtensions: McpExtensionApi;
    sourcenerveUpdate: SourceNerveUpdateApi;
  }
}

export {};
