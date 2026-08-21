import { defineConfig } from "vite";

export default defineConfig({
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        // Keep the established preload artifact name stable even when the source
        // entry is a composition wrapper (preload-entry.ts). Production Forge
        // packaging and the packaged E2E harness both consume preload.js.
        entryFileNames: "preload.js",
      },
    },
  },
});
