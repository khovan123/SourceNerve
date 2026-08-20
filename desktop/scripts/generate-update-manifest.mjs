import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
const extensions = {
  linux: [".AppImage", ".rpm"],
  windows: [".exe"],
  macos: [".zip"],
}[kind];

if (!extensions) throw new Error(`unsupported update manifest target: ${kind}`);
if (!/^[a-z0-9_-]{2,32}$/i.test(arch)) throw new Error(`invalid update manifest architecture: ${arch}`);
if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
  throw new Error(`stable Desktop update manifest requires SemVer x.y.z, received ${packageJson.version}`);
}
if (!Number.isSafeInteger(productProfile.schemaVersion) || productProfile.schemaVersion < 1) {
  throw new Error("Desktop product profile schemaVersion is invalid");
}

const files = [];
await walk(makeDirectory, files);
const artifacts = files
  .filter((candidate) => extensions.some((extension) => candidate.endsWith(extension)))
  .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
if (artifacts.length === 0) {
  throw new Error(`no ${kind} updater artifacts found under out/make`);
}

const records = [];
for (const artifact of artifacts) {
  const metadata = await stat(artifact);
  if (!metadata.isFile() || metadata.size < 64 * 1024) {
    throw new Error(`updater artifact is unexpectedly small: ${relative(artifact)}`);
  }
  records.push({
    url: path.basename(artifact),
    sha512: await sha512(artifact),
    size: metadata.size,
  });
}

const preferred = preferredRecord(kind, records);
const manifestName = channelFileName(kind, arch);
const manifestPath = path.join(makeDirectory, manifestName);
await mkdir(makeDirectory, { recursive: true });
await writeFile(
  manifestPath,
  renderYaml({
    version: packageJson.version,
    records,
    preferred,
    daemonVersion: packageJson.version,
    profileSchemaVersion: productProfile.schemaVersion,
  }),
  "utf8",
);

console.log(`generated Desktop update manifest: ${relative(manifestPath)}`);

function renderYaml({ version, records, preferred, daemonVersion, profileSchemaVersion }) {
  const lines = [
    `version: ${quote(version)}`,
    "files:",
  ];
  for (const record of records) {
    lines.push(
      `  - url: ${quote(record.url)}`,
      `    sha512: ${quote(record.sha512)}`,
      `    size: ${record.size}`,
    );
  }
  lines.push(
    `path: ${quote(preferred.url)}`,
    `sha512: ${quote(preferred.sha512)}`,
    "sourcenerve:",
    `  daemonVersion: ${quote(daemonVersion)}`,
    `  profileSchemaVersion: ${profileSchemaVersion}`,
    "",
  );
  return lines.join("\n");
}

function preferredRecord(target, records) {
  if (target === "linux") {
    return records.find((record) => record.url.endsWith(".AppImage")) ?? records[0];
  }
  if (target === "macos") {
    return records.find((record) => record.url.endsWith(".zip")) ?? records[0];
  }
  return records.find((record) => record.url.endsWith(".exe")) ?? records[0];
}

function channelFileName(target, targetArch) {
  if (target === "windows") return `latest-${targetArch}.yml`;
  if (target === "macos") return `latest-${targetArch}-mac.yml`;
  const linuxArchSuffix = targetArch === "x64" ? "" : `-${targetArch}`;
  return `latest-${targetArch}-linux${linuxArchSuffix}.yml`;
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

function relative(candidate) {
  return path.relative(desktopDirectory, candidate) || path.basename(candidate);
}
