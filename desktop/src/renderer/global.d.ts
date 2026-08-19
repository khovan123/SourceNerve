import type { SourceNerveDesktopApi } from "../shared/desktop-api";

declare global {
  interface Window {
    sourcenerveDesktop: SourceNerveDesktopApi;
  }
}

export {};
