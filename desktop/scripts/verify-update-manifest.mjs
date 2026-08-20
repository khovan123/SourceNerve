import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const makeDirectory = path.join(desktopDirectory, "out", "make");
const packageJson = JSON.parse(await readFile(path.join(desktopDirectory, "package.json"), "utf8"));
const productProfile = JSON.parse(
  await readFile(path.join(desktopDirectory, "bootstrap", "product-profile.template.json"), "utf8"),
);
const arch = process.argv[2] ?? process.arch;
const kind = process.env.SOURCENERVE_DISTRIBUTION_KIND ?? inferKind();
const manifestPath = path.join(makeDirectory, channelFileName(kind, arch));
const manifest = await readFile(manifestPath, "utf8");

expectLine(`version: ${quote(packageJson.version)}`);
expectLine(`  daemonVersion: ${quote(packageJson.version)}`);
expectLine(`  profileSchemaVersion: ${productProfile.schemaVersion}`);

const files = [];
await walk(makeDirectory, files);
const expectedArtifacts = files
  .filter((candidate) => updateExtensions(kind).some((extension) => candidate.endsWith(extension)))
  .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
if (expectedArtifacts.length === 0) throw new Error(`no ${kind} update artifacts found`);

for (const artifact of expectedArtifacts) {
  const metadata = await stat(artifact);
  const digest = await sha512(artifact);
  expectLine(`  - url: ${quote(path.basename(artifact))}`);
  expectLine(`    sha512: ${quote(digest)}`);
  expectLine(`    size: ${metadata.size}`);
}

for (const forbidden of [
  process.env.SOURCENERVE_BEARER_TOKEN,
  process.env.SOURCENERVE_GITHUB_TOKEN,
  process.env.SOURCENERVE_GITLAB_TOKEN,
  process.env.SOURCENERVE_OPENAI_APPS_CHALLENGE,
]) {
  if (forbidden && manifest.includes(forbidden)) {
    throw new Error("update manifest contains forbidden credential material");
  }
}
if (/__[A-Z0-9_]+__/.test(manifest)) {
  throw new Error("update manifest contains unresolved release placeholders");
}

console.log(
  `verified Desktop update manifest ${path.relative(desktopDirectory, manifestPath)} for ${expectedArtifacts.length} artifact(s)`,
);

function expectLine(line) {
  if (!manifest.split(/\r?\n/).includes(line)) {
    throw new Error(`update manifest missing expected line: ${line}`);
  }
}

function updateExtensions(target) {
  if (target === "linux") return [".AppImage", ".rpm"];
  if (target === "windows") return [".exe"];
  if (target === "macos") return [".zip"];
  throw new Error(`unsupported update manifest target: ${target}`);
}

function channelFileName(target, targetArch) {
  if (target === "windows") return `latest-${targetArch}.yml`;
  if (target === "macos") return `latest-${targetArch}-mac.yml`;
  if (target === "linux") {
    const linuxArchSuffix = targetArch === "x64" ? "" : `-${targetArch}`;
    return `latest-${targetArch}-linux${linuxArchSuffix}.yml`;
  }
  throw new Error(`unsupported update manifest target: ${target}`);
}

function inferKind() {
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return process.platform;
}

async function sha512(filePath) {
  const hash = createHash("sha512");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("base64");
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

function quote(value) {
  return JSON.stringify(String(value));
}
