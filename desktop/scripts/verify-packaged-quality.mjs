import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const outDirectory = path.join(desktopDirectory, "out");
const daemonExecutable = process.platform === "win32" ? "sourcenerve.exe" : "sourcenerve";
const cloudflaredExecutable = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
const daemonSuffix = path.join("resources", "bin", `${process.platform}-${process.arch}`, daemonExecutable);
const cloudflaredSuffix = path.join("resources", "bin", cloudflaredExecutable);
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

if (!files.some((candidate) => candidate.endsWith(daemonSuffix))) {
  throw new Error(`packaged SourceNerve daemon missing: expected **/${daemonSuffix}`);
}
if (!files.some((candidate) => candidate.endsWith(cloudflaredSuffix))) {
  throw new Error(`packaged cloudflared missing: expected **/${cloudflaredSuffix}`);
}
if (!files.some((candidate) => path.basename(candidate).startsWith("app.asar") || candidate.includes(`${path.sep}resources${path.sep}app${path.sep}`))) {
  throw new Error("packaged Electron application payload is missing");
}

for (const candidate of files) {
  const metadata = await stat(candidate);
  if (!metadata.isFile()) continue;
  for (const canary of canaries) {
    if (await containsBytes(candidate, canary.bytes)) {
      throw new Error(`packaged artifact leaked ${canary.name} canary into ${relative(candidate)}`);
    }
  }
}

console.log(`verified ${files.length} packaged artifact files: required binaries present, no user state, no secret canaries`);

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
