import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, "..", "..");
const workflowPath = path.join(repositoryDirectory, ".github", "workflows", "desktop-release.yml");
const workflow = await readFile(workflowPath, "utf8");

for (const [needle, label] of [
  ['- "desktop-v*.*.*"', "stable Desktop tag trigger"],
  ["environment: desktop-release", "protected desktop-release environment"],
  ["SOURCENERVE_RELEASE_ENVIRONMENT_PROTECTED", "environment protection sentinel"],
  ["npm run release:contract", "release version contract"],
  ["npm run release:secret-scan", "protected secret value scan"],
  ["npm run test:packaged", "packaged artifact smoke gate"],
  ["npm run test:distribution", "distribution artifact gate"],
  ["npm run update:manifest", "updater manifest generation"],
  ["npm run test:update-manifest", "updater manifest verification"],
  ["retention-days: 14", "failed-release artifact retention"],
  ["codesign --verify --deep --strict", "macOS signature gate"],
  ["spctl --assess --type execute", "macOS notarization/Gatekeeper gate"],
  ["Get-AuthenticodeSignature", "Windows Authenticode gate"],
  ["actions/download-artifact@v4", "release artifact aggregation"],
  ["verify-release-bundle.mjs", "aggregate release bundle verification"],
  ["permissions:\n      contents: write", "publish-only contents write permission"],
  ["gh release create", "GitHub Release creation"],
  ["--draft", "draft-before-publish release behavior"],
  ["refusing to mutate immutable release assets", "published release immutability guard"],
]) {
  if (!workflow.includes(needle)) throw new Error(`Desktop release workflow missing ${label}`);
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

console.log("Desktop stable release workflow policy verified");
