import type { SourceNerveDesktopApi } from "../shared/desktop-api";
import type { SourceNerveUpdateApi } from "../shared/update-api";

declare global {
  interface Window {
    sourcenerveDesktop: SourceNerveDesktopApi;
    sourcenerveUpdate: SourceNerveUpdateApi;
  }
}

export {};
