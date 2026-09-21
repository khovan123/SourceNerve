import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "..");
const releaseWorkflowPath = path.join(
  repositoryDirectory,
  ".github",
  "workflows",
  "desktop-release.yml",
);
const distributionWorkflowPath = path.join(
  repositoryDirectory,
  ".github",
  "workflows",
  "desktop-distribution-smoke.yml",
);
const releaseWorkflow = await readFile(releaseWorkflowPath, "utf8");
const distributionWorkflow = await readFile(distributionWorkflowPath, "utf8");

const nativeTargets = [
  {
    name: "Fedora x64 RPM + AppImage",
    os: "ubuntu-latest",
    arch: "x64",
    kind: "linux",
    artifact: "desktop-fedora-x64",
  },
  {
    name: "Windows x64 NSIS",
    os: "windows-latest",
    arch: "x64",
    kind: "windows",
    artifact: "desktop-windows-x64",
  },
  {
    name: "macOS arm64 DMG + ZIP",
    os: "macos-latest",
    arch: "arm64",
    kind: "macos",
    artifact: "desktop-macos-arm64",
  },
  {
    name: "macOS x64 DMG + ZIP",
    os: "macos-15-intel",
    arch: "x64",
    kind: "macos",
    artifact: "desktop-macos-x64",
  },
];

for (const target of nativeTargets) {
  const targetBlock = [
    `          - name: ${target.name}`,
    `            os: ${target.os}`,
    `            arch: ${target.arch}`,
    `            kind: ${target.kind}`,
    `            artifact: ${target.artifact}`,
  ].join("\n");

  for (const [workflow, label] of [
    [releaseWorkflow, "stable release"],
    [distributionWorkflow, "distribution CI"],
  ]) {
    if (!workflow.includes(targetBlock)) {
      throw new Error(
        `Desktop ${label} workflow is missing native target ${target.name} (${target.artifact})`,
      );
    }
  }
}

for (const [needle, label] of [
  ['- "desktop-v*.*.*"', "canonical stable Desktop tag trigger"],
  ['- "v*.*.*"', "compatible stable Desktop tag trigger"],
  ["environment: desktop-release", "protected desktop-release environment"],
  ["SOURCENERVE_RELEASE_ENVIRONMENT_PROTECTED", "environment protection sentinel"],
  ["npm run make:dmg", "unsigned macOS DMG build"],
  ["npm run make:nsis", "unsigned Windows NSIS build"],
  ["npm run release:contract", "release version contract"],
  ["npm run release:secret-scan", "release secret value scan"],
  ["npm run test:packaged", "packaged artifact smoke gate"],
  ["npm run test:distribution", "distribution artifact gate"],
  ["npm run update:manifest", "updater manifest generation"],
  ["npm run test:update-manifest", "updater manifest verification"],
  ["retention-days: 14", "failed-release artifact retention"],
  ["actions/download-artifact@v4", "release artifact aggregation"],
  ["verify-release-bundle.mjs", "aggregate release bundle verification"],
  ["permissions:\n      contents: write", "publish-only contents write permission"],
  ["gh release create", "GitHub Release creation"],
  ["--draft", "draft-before-publish release behavior"],
  ["recovering published release $tag because it has zero assets", "empty published release recovery"],
  ["refusing to mutate immutable release assets", "published release immutability guard"],
  ["remote release asset set does not match", "remote asset verification before publish"],
  ["published release $tag lost or changed assets", "post-publish asset verification"],
]) {
  if (!releaseWorkflow.includes(needle)) {
    throw new Error(`Desktop release workflow missing ${label}`);
  }
}

for (const [needle, label] of [
  ["SOURCENERVE_WINDOWS_CERTIFICATE_BASE64", "Windows signing secret"],
  ["SOURCENERVE_MACOS_CERTIFICATE_BASE64", "macOS signing secret"],
  ["sign-windows-release.ps1", "Windows signing flow"],
  ["build-signed-macos-release.sh", "macOS signing flow"],
]) {
  if (releaseWorkflow.includes(needle)) {
    throw new Error(`Desktop stable release must stay unsigned and must not require ${label}`);
  }
}

if (/\bpull_request\s*:/.test(releaseWorkflow)) {
  throw new Error("Desktop stable release workflow must never run automatically for pull requests or forks");
}
if (/\bworkflow_dispatch\s*:/.test(releaseWorkflow)) {
  throw new Error("Desktop stable release publication is tag-driven only; manual branch dispatch is not allowed");
}

for (const [needle, label] of [
  ["pull_request:", "pull-request distribution validation"],
  ["push:", "default-branch distribution validation"],
  ["workflow_dispatch:", "manual distribution validation"],
  ["Build Forge installer artifacts", "Forge Linux/macOS packaging step"],
  ["Build macOS DMG", "macOS DMG packaging step"],
  ["Package Windows application", "Windows package step"],
  ["Build Windows NSIS installer", "Windows NSIS packaging step"],
  ["bootstrap broker probe attempt $attempt/4", "bounded bootstrap broker retry"],
  ["did not become healthy and ready after 4 attempts", "bootstrap broker retry exhaustion guard"],
  ["npm run test:distribution", "distribution artifact verification"],
  ["npm run update:manifest", "distribution updater manifest generation"],
  ["npm run test:update-manifest", "distribution updater manifest verification"],
  ["actions/upload-artifact@v4", "distribution artifact upload"],
]) {
  if (!distributionWorkflow.includes(needle)) {
    throw new Error(`Desktop distribution workflow missing ${label}`);
  }
}

const globalPermissions = releaseWorkflow.slice(0, releaseWorkflow.indexOf("jobs:"));
if (/contents:\s*write/.test(globalPermissions)) {
  throw new Error("Desktop release workflow must not grant contents:write globally");
}

const buildStart = releaseWorkflow.indexOf("\n  build:");
const publishStart = releaseWorkflow.indexOf("\n  publish:");
if (buildStart < 0 || publishStart < 0 || publishStart <= buildStart) {
  throw new Error("Desktop release workflow must define build before publish");
}
const buildBlock = releaseWorkflow.slice(buildStart, publishStart);
if (/contents:\s*write/.test(buildBlock)) {
  throw new Error("Desktop release build jobs must remain read-only to repository contents");
}

const releaseArtifactGroups = buildBlock.match(/^\s+artifact: desktop-/gm) ?? [];
if (releaseArtifactGroups.length !== nativeTargets.length) {
  throw new Error(
    `Desktop stable release must define exactly ${nativeTargets.length} native artifact groups, found ${releaseArtifactGroups.length}`,
  );
}

const distributionStart = distributionWorkflow.indexOf("\n  distribution:");
const publishEdgeStart = distributionWorkflow.indexOf("\n  publish-edge:");
if (distributionStart < 0 || publishEdgeStart < 0 || publishEdgeStart <= distributionStart) {
  throw new Error("Desktop distribution workflow must define distribution before edge publication");
}
const distributionBlock = distributionWorkflow.slice(distributionStart, publishEdgeStart);
const distributionArtifactGroups = distributionBlock.match(/^\s+artifact: desktop-/gm) ?? [];
if (distributionArtifactGroups.length !== nativeTargets.length) {
  throw new Error(
    `Desktop distribution CI must define exactly ${nativeTargets.length} native artifact groups, found ${distributionArtifactGroups.length}`,
  );
}

const forgeBuild = releaseWorkflow.indexOf("Build Forge installer artifacts");
const macBuild = releaseWorkflow.indexOf("Build macOS DMG");
const windowsBuild = releaseWorkflow.indexOf("Build Windows NSIS installer");
const manifestStep = releaseWorkflow.indexOf("Generate updater manifest after final package bytes");
if (
  forgeBuild < 0 ||
  macBuild < 0 ||
  windowsBuild < 0 ||
  manifestStep <= forgeBuild ||
  manifestStep <= macBuild ||
  manifestStep <= windowsBuild
) {
  throw new Error("Updater manifests must be generated only after final native package bytes exist");
}

if (!releaseWorkflow.includes("needs: [validate, build]")) {
  throw new Error("Stable publish job must depend on validation and the complete native build matrix");
}

console.log(
  "Desktop cross-platform release policy verified: Fedora/Linux x64, Windows x64, macOS arm64, macOS x64",
);
