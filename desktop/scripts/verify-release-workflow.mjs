import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "..");
const workflowPath = path.join(repositoryDirectory, ".github", "workflows", "desktop-release.yml");
const workflow = await readFile(workflowPath, "utf8");

for (const [needle, label] of [
  ['- "desktop-v*.*.*"', "canonical stable Desktop tag trigger"],
  ['- "v*.*.*"', "compatible stable Desktop tag trigger"],
  ["environment: desktop-release", "protected desktop-release environment"],
  ["SOURCENERVE_RELEASE_ENVIRONMENT_PROTECTED", "environment protection sentinel"],
  ["Fedora x64 RPM + AppImage", "Linux x64 stable target"],
  ["artifact: desktop-fedora-x64", "Linux release artifact group"],
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
  if (!workflow.includes(needle)) throw new Error(`Desktop release workflow missing ${label}`);
}

for (const [needle, label] of [
  ["Windows x64 NSIS", "Windows stable target"],
  ["macOS arm64 DMG + ZIP", "macOS arm64 stable target"],
  ["macOS x64 DMG + ZIP", "macOS x64 stable target"],
  ["SOURCENERVE_WINDOWS_CERTIFICATE_BASE64", "Windows signing secret"],
  ["SOURCENERVE_MACOS_CERTIFICATE_BASE64", "macOS signing secret"],
  ["sign-windows-release.ps1", "Windows signing flow"],
  ["build-signed-macos-release.sh", "macOS signing flow"],
]) {
  if (workflow.includes(needle)) {
    throw new Error(`Desktop stable release is currently Linux-only and must not include ${label}`);
  }
}

if (/\bpull_request\s*:/.test(workflow)) {
  throw new Error("Desktop stable release workflow must never run automatically for pull requests or forks");
}
if (/\bworkflow_dispatch\s*:/.test(workflow)) {
  throw new Error("Desktop stable release publication is tag-driven only; manual branch dispatch is not allowed");
}

const globalPermissions = workflow.slice(0, workflow.indexOf("jobs:"));
if (/contents:\s*write/.test(globalPermissions)) {
  throw new Error("Desktop release workflow must not grant contents:write globally");
}

const buildStart = workflow.indexOf("\n  build:");
const publishStart = workflow.indexOf("\n  publish:");
if (buildStart < 0 || publishStart < 0 || publishStart <= buildStart) {
  throw new Error("Desktop release workflow must define build before publish");
}
const buildBlock = workflow.slice(buildStart, publishStart);
if (/contents:\s*write/.test(buildBlock)) {
  throw new Error("Desktop release build jobs must remain read-only to repository contents");
}
const artifactGroups = buildBlock.match(/^\s+artifact: desktop-/gm) ?? [];
if (artifactGroups.length !== 1) {
  throw new Error(`Desktop stable release must define exactly one Linux artifact group, found ${artifactGroups.length}`);
}

const linuxBuild = workflow.indexOf("Build Linux installer artifacts");
const manifestStep = workflow.indexOf("Generate updater manifest after final package bytes");
if (linuxBuild < 0 || manifestStep <= linuxBuild) {
  throw new Error("Linux updater manifest must be generated only after final package bytes exist");
}

console.log("Desktop Linux-only stable release workflow policy verified");
