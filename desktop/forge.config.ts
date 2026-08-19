import type { ForgeConfig } from "@electron-forge/shared-types";
import { VitePlugin } from "@electron-forge/plugin-vite";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: "SourceNerve",
    executableName: "sourcenerve-desktop",
    appBundleId: "io.fogewise.sourcenerve.desktop",
    appCategoryType: "public.app-category.developer-tools",
    protocols: [
      {
        name: "SourceNerve authentication callback",
        schemes: ["sourcenerve"],
      },
    ],
  },
  rebuildConfig: {},
  makers: [],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
  ],
};

export default config;
