import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const outDirectory = path.join(desktopDirectory, "out");
const resourcesDirectory = process.platform === "darwin" ? "Resources" : "resources";
const daemonExecutable = process.platform === "win32" ? "sourcenerve.exe" : "sourcenerve";
const cloudflaredExecutable = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
const daemonSuffix = path.join(resourcesDirectory, "bin", `${process.platform}-${process.arch}`, daemonExecutable);
const cloudflaredSuffix = path.join(resourcesDirectory, "bin", cloudflaredExecutable);
const forbiddenStateNames = new Set([
  "sourcenerve.toml",
  "secure-store.json",
  "desktop-tasks.json",
  "workspaces.json",
  "last-exit.json",
]);
const canaryVariables = [
  "SOURCENERVE_BEARER_TOKEN",
  "SOURCENERVE_GITHUB_TOKEN",
  "SOURCENERVE_GITLAB_TOKEN",
  "SOURCENERVE_OPENAI_APPS_CHALLENGE",
];
const canaries = canaryVariables
  .map((name) => ({ name, value: process.env[name] }))
  .filter((item) => typeof item.value === "string" && item.value.length >= 16)
  .map((item) => ({ name: item.name, bytes: Buffer.from(item.value, "utf8") }));
const unresolvedPlaceholder = Buffer.from(["__", "SOURCENERVE_"].join(""), "utf8");

if (canaries.length !== canaryVariables.length) {
  throw new Error(`packaged quality gate requires explicit secret canaries: ${canaryVariables.join(", ")}`);
}

const files = [];
await walk(outDirectory, files);
if (files.length === 0) throw new Error("Desktop packaged quality gate found no artifact files under out/");

const forbidden = files.filter((candidate) => forbiddenStateNames.has(path.basename(candidate).toLowerCase()));
if (forbidden.length > 0) {
  throw new Error(`packaged artifact contains user-state/config file(s): ${forbidden.map(relative).join(", ")}`);
}

const daemonPath = files.find((candidate) => candidate.endsWith(daemonSuffix));
const cloudflaredPath = files.find((candidate) => candidate.endsWith(cloudflaredSuffix));
if (!daemonPath) throw new Error(`packaged SourceNerve daemon missing: expected **/${daemonSuffix}`);
if (!cloudflaredPath) throw new Error(`packaged cloudflared missing: expected **/${cloudflaredSuffix}`);
if (!files.some((candidate) => path.basename(candidate).startsWith("app.asar") || candidate.includes(`${path.sep}${resourcesDirectory}${path.sep}app${path.sep}`))) {
  throw new Error("packaged Electron application payload is missing");
}

const nativeRuntimePaths = new Set([daemonPath, cloudflaredPath]);
for (const candidate of files) {
  const metadata = await stat(candidate);
  if (!metadata.isFile()) continue;

  // Release placeholders are meaningful only in the application payload/config. The Rust daemon
  // contains placeholder-shaped literals as part of validation logic, so scanning that compiled
  // executable would be a false positive. Secret canaries are still scanned across every file.
  if (!nativeRuntimePaths.has(candidate) && await containsBytes(candidate, unresolvedPlaceholder)) {
    throw new Error(`packaged artifact contains unresolved release placeholder in ${relative(candidate)}`);
  }
  for (const canary of canaries) {
    if (await containsBytes(candidate, canary.bytes)) {
      throw new Error(`packaged artifact leaked ${canary.name} canary into ${relative(candidate)}`);
    }
  }
}

await verifyExecutable(daemonPath, ["--version"], "SourceNerve daemon");
await verifyExecutable(cloudflaredPath, ["--version"], "cloudflared");

console.log(`verified ${files.length} packaged artifact files: materialized profile, runnable bundled binaries, no user state, no secret canaries`);

async function verifyExecutable(filePath, args, label) {
  try {
    const { stdout, stderr } = await execFileAsync(filePath, args, {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    if (!`${stdout}${stderr}`.trim()) throw new Error("version command returned no output");
  } catch (error) {
    throw new Error(`packaged ${label} failed disk smoke: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function containsBytes(filePath, needle) {
  if (needle.length === 0) return false;
  const stream = createReadStream(filePath, { highWaterMark: 128 * 1024 });
  let tail = Buffer.alloc(0);
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const candidate = tail.length > 0 ? Buffer.concat([tail, buffer]) : buffer;
    if (candidate.indexOf(needle) !== -1) return true;
    const overlap = Math.min(needle.length - 1, candidate.length);
    tail = overlap > 0 ? candidate.subarray(candidate.length - overlap) : Buffer.alloc(0);
  }
  return false;
}

async function walk(directory, output) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(candidate, output);
    else if (entry.isFile()) output.push(candidate);
  }
}

function relative(candidate) {
  return path.relative(desktopDirectory, candidate) || path.basename(candidate);
}
