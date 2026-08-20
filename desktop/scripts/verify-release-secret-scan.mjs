import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "..");

const builtInSecretNames = [
  "SOURCENERVE_APPLE_ID_PASSWORD",
  "SOURCENERVE_WINDOWS_CERT_PASSWORD",
  "SOURCENERVE_NOTARY_API_KEY",
];
const additionalSecretNames = String(process.env.SOURCENERVE_RELEASE_SECRET_NAMES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const secretNames = [...new Set([...builtInSecretNames, ...additionalSecretNames])];
const secrets = secretNames
  .map((name) => ({ name, value: process.env[name] }))
  .filter((entry) => typeof entry.value === "string" && entry.value.length >= 8)
  .map((entry) => ({ name: entry.name, bytes: Buffer.from(entry.value, "utf8") }));

const tracked = await trackedFiles();
const generated = [];
for (const relative of ["desktop/.vite/build", "desktop/.vite/renderer"]) {
  await walk(path.join(repositoryDirectory, relative), generated);
}
const candidates = [...new Set([...tracked, ...generated])];

for (const candidate of candidates) {
  const metadata = await stat(candidate);
  if (!metadata.isFile()) continue;
  for (const secret of secrets) {
    if (await containsBytes(candidate, secret.bytes)) {
      throw new Error(`release secret ${secret.name} leaked into ${path.relative(repositoryDirectory, candidate)}`);
    }
  }
}

console.log(
  secrets.length > 0
    ? `verified ${candidates.length} tracked/renderer files against ${secrets.length} protected release secret value(s)`
    : `verified release secret scan surface (${candidates.length} files); no protected secret values were supplied to this job`,
);

async function trackedFiles() {
  const { stdout } = await execFileAsync("git", ["-C", repositoryDirectory, "ls-files", "-z"], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((relative) => path.join(repositoryDirectory, relative));
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
