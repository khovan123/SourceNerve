import path from "node:path";

import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerAppImage } from "@reforged/maker-appimage";

const desktopRoot = process.cwd();
const iconBase = path.join(desktopRoot, "assets", "generated", "icon");
const iconPng = `${iconBase}.png`;

const macSigningIdentity = process.env.SOURCENERVE_MACOS_SIGN_IDENTITY?.trim();
const appleId = process.env.SOURCENERVE_APPLE_ID?.trim();
const appleIdPassword = process.env.SOURCENERVE_APPLE_ID_PASSWORD?.trim();
const appleTeamId = process.env.SOURCENERVE_APPLE_TEAM_ID?.trim();
const macNotarizationReady = Boolean(appleId && appleIdPassword && appleTeamId);

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: "SourceNerve",
    executableName: "sourcenerve-desktop",
    appBundleId: "io.fogewise.sourcenerve.desktop",
    appCategoryType: "public.app-category.developer-tools",
    icon: iconBase,
    extraResource: ["resources/bin", "assets/generated/icon.png"],
    protocols: [
      {
        name: "SourceNerve authentication callback",
        schemes: ["sourcenerve"],
      },
    ],
    ...(process.platform === "darwin" && macSigningIdentity
      ? {
          osxSign: {
            identity: macSigningIdentity,
          },
        }
      : {}),
    ...(process.platform === "darwin" && macNotarizationReady
      ? {
          osxNotarize: {
            appleId: appleId as string,
            appleIdPassword: appleIdPassword as string,
            teamId: appleTeamId as string,
          },
        }
      : {}),
  },
  rebuildConfig: {},
  makers: [
    new MakerRpm(
      {
        options: {
          name: "sourcenerve",
          genericName: "Repository intelligence desktop application",
          homepage: "https://github.com/khovan123/SourceNerve",
          license: "MIT",
          icon: iconPng,
        },
      },
      ["linux"],
    ),
    new MakerAppImage(
      {
        options: {
          name: "sourcenerve",
          productName: "SourceNerve",
          bin: "sourcenerve-desktop",
          icon: iconPng,
          categories: ["Development"],
        },
      },
      ["linux"],
    ),
    new MakerZIP({}, ["darwin"]),
  ],
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
