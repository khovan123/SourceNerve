import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "..");
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
  ["build-signed-macos-release.sh", "repository-owned macOS signing/notarization flow"],
  ["verify-macos-signing.sh", "macOS production signature verification"],
  ["sign-windows-release.ps1", "repository-owned Windows Authenticode signer"],
  ["verify-windows-signing.ps1", "Windows production signature verification"],
  ["SOURCENERVE_MACOS_CERTIFICATE_BASE64", "protected macOS signing certificate"],
  ["SOURCENERVE_WINDOWS_CERTIFICATE_BASE64", "protected Windows signing certificate"],
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

const signingFiles = {
  "build-signed-macos-release.sh": await readFile(path.join(scriptDirectory, "build-signed-macos-release.sh"), "utf8"),
  "verify-macos-signing.sh": await readFile(path.join(scriptDirectory, "verify-macos-signing.sh"), "utf8"),
  "sign-windows-release.ps1": await readFile(path.join(scriptDirectory, "sign-windows-release.ps1"), "utf8"),
  "verify-windows-signing.ps1": await readFile(path.join(scriptDirectory, "verify-windows-signing.ps1"), "utf8"),
};

for (const shellScript of ["build-signed-macos-release.sh", "verify-macos-signing.sh"]) {
  await execFileAsync("bash", ["-n", path.join(scriptDirectory, shellScript)]);
}

for (const needle of [
  "security create-keychain",
  "security delete-keychain",
  "xcrun notarytool submit",
  "xcrun stapler staple",
  "SOURCENERVE_MACOS_CERTIFICATE_BASE64",
]) {
  if (!signingFiles["build-signed-macos-release.sh"].includes(needle)) {
    throw new Error(`macOS release signer missing required policy operation: ${needle}`);
  }
}
for (const needle of ["Developer ID Application", "flags=.*runtime", "stapler validate", "spctl --assess"]) {
  if (!signingFiles["verify-macos-signing.sh"].includes(needle)) {
    throw new Error(`macOS signing verifier missing required gate: ${needle}`);
  }
}
for (const needle of ["signtool sign", "/fd SHA256", "/tr http://timestamp.digicert.com", "SOURCENERVE_WINDOWS_CERTIFICATE_BASE64", "Remove-Item -Force $pfx"]) {
  if (!signingFiles["sign-windows-release.ps1"].includes(needle)) {
    throw new Error(`Windows release signer missing required policy operation: ${needle}`);
  }
}
for (const needle of ["Get-AuthenticodeSignature", "TimeStamperCertificate", "signtool verify", "Status -ne \"Valid\""]) {
  if (!signingFiles["verify-windows-signing.ps1"].includes(needle)) {
    throw new Error(`Windows signing verifier missing required gate: ${needle}`);
  }
}

const windowsPackage = workflow.indexOf("Package Windows application");
const windowsAppSign = workflow.indexOf("Sign Windows application executable");
const windowsNsis = workflow.indexOf("Build Windows NSIS installer from signed application");
const windowsInstallerSign = workflow.indexOf("Sign Windows NSIS installer");
if (!(windowsPackage < windowsAppSign && windowsAppSign < windowsNsis && windowsNsis < windowsInstallerSign)) {
  throw new Error("Windows stable release must sign the app executable before NSIS packaging and sign the installer afterward");
}

const manifestStep = workflow.indexOf("Generate updater manifest after final signed package bytes");
if (manifestStep < windowsInstallerSign || manifestStep < workflow.indexOf("Build, sign, notarize, and staple macOS release artifacts")) {
  throw new Error("Updater manifests must be generated only after signing/notarization finalizes package bytes");
}

console.log("Desktop stable release and production signing workflow policy verified");
