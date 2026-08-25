import path from "node:path";

import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerAppImage } from "@reforged/maker-appimage";

const desktopRoot = process.cwd();
const iconBase = path.join(desktopRoot, "assets", "generated", "icon");
const iconPng = `${iconBase}.png`;
const rpmRevision = resolveRpmRevision(process.env.SOURCENERVE_RPM_REVISION);
const rpmPostInstall = path.join(desktopRoot, "resources", "rpm", "post-install.sh");
const rpmPostUninstall = path.join(desktopRoot, "resources", "rpm", "post-uninstall.sh");

const rpmMakerConfig = {
  options: {
    name: "sourcenerve",
    genericName: "Repository intelligence desktop application",
    homepage: "https://github.com/khovan123/SourceNerve",
    license: "MIT",
    icon: iconPng,
    revision: rpmRevision,
    categories: ["Development"],
    mimeType: ["x-scheme-handler/sourcenerve"],
    // electron-installer-redhat supports RPM scriptlets, but Forge 7.11.2's
    // MakerRpmConfigOptions type omits that upstream option. Keep the adapter
    // localized here so the generated RPM refreshes the MIME handler database.
    scripts: {
      post: rpmPostInstall,
      postun: rpmPostUninstall,
    },
  },
} as unknown as ConstructorParameters<typeof MakerRpm>[0];

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
    extraResource: [
      "resources/bin",
      "resources/plugin-catalog",
      "assets/generated/icon.png",
      "bootstrap",
    ],
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
    new MakerRpm(rpmMakerConfig, ["linux"]),
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
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/preload-entry.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),
  ],
};

function resolveRpmRevision(value: string | undefined): string {
  const revision = value?.trim() || "1";
  if (!/^\d+(?:\.\d+)*$/.test(revision)) {
    throw new Error(
      `SOURCENERVE_RPM_REVISION must contain only numeric RPM release segments, received ${JSON.stringify(revision)}`,
    );
  }
  return revision;
}

export default config;
