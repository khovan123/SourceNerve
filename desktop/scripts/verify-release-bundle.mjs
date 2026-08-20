import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "..");
const releaseRoot = path.resolve(repositoryDirectory, process.argv[2] ?? "release-artifacts");
const packageJson = JSON.parse(await readFile(path.join(desktopDirectory, "package.json"), "utf8"));
const productProfile = JSON.parse(
  await readFile(path.join(desktopDirectory, "bootstrap", "product-profile.template.json"), "utf8"),
);

const targets = [
  {
    group: "desktop-fedora-x64",
    manifest: "latest-x64-linux.yml",
    requiredExtensions: [".AppImage", ".rpm"],
  },
  {
    group: "desktop-windows-x64",
    manifest: "latest-x64.yml",
    requiredExtensions: [".exe"],
  },
  {
    group: "desktop-macos-arm64",
    manifest: "latest-arm64-mac.yml",
    requiredExtensions: [".zip", ".dmg"],
  },
  {
    group: "desktop-macos-x64",
    manifest: "latest-x64-mac.yml",
    requiredExtensions: [".zip", ".dmg"],
  },
];

const publishNames = new Map();
for (const target of targets) {
  const groupDirectory = path.join(releaseRoot, target.group);
  const files = [];
  await walk(groupDirectory, files);
  if (files.length === 0) throw new Error(`release artifact group is empty: ${target.group}`);

  for (const extension of target.requiredExtensions) {
    if (!files.some((candidate) => candidate.endsWith(extension))) {
      throw new Error(`${target.group} is missing required ${extension} release artifact`);
    }
  }

  const manifestPath = files.find((candidate) => path.basename(candidate) === target.manifest);
  if (!manifestPath) throw new Error(`${target.group} is missing updater manifest ${target.manifest}`);
  const manifest = await readFile(manifestPath, "utf8");
  requireManifestLine(manifest, `version: ${quote(packageJson.version)}`, target.manifest);
  requireManifestLine(manifest, `  daemonVersion: ${quote(packageJson.version)}`, target.manifest);
  requireManifestLine(manifest, `  profileSchemaVersion: ${productProfile.schemaVersion}`, target.manifest);

  const records = parseManifestRecords(manifest, target.manifest);
  if (records.length === 0) throw new Error(`${target.manifest} contains no updater artifact records`);
  for (const record of records) {
    const artifact = files.find((candidate) => path.basename(candidate) === record.url);
    if (!artifact) throw new Error(`${target.manifest} references missing release file ${record.url}`);
    const metadata = await stat(artifact);
    if (metadata.size !== record.size) {
      throw new Error(`${target.manifest} size mismatch for ${record.url}`);
    }
    const digest = await sha512(artifact);
    if (digest !== record.sha512) {
      throw new Error(`${target.manifest} SHA-512 mismatch for ${record.url}`);
    }
  }

  for (const candidate of files) {
    const base = path.basename(candidate);
    if (!isPublishable(base)) continue;
    const previous = publishNames.get(base);
    if (previous) {
      throw new Error(`GitHub Release filename collision: ${base} appears in ${previous} and ${target.group}`);
    }
    publishNames.set(base, target.group);
  }
}

console.log(
  `verified Desktop release bundle ${packageJson.version}: ${targets.length} native target groups, ${publishNames.size} publishable files`,
);

function parseManifestRecords(manifest, manifestName) {
  const lines = manifest.split(/\r?\n/);
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const urlMatch = lines[index].match(/^  - url: (.+)$/);
    if (!urlMatch) continue;
    const shaMatch = lines[index + 1]?.match(/^    sha512: (.+)$/);
    const sizeMatch = lines[index + 2]?.match(/^    size: (\d+)$/);
    if (!shaMatch || !sizeMatch) throw new Error(`${manifestName} contains malformed updater record`);
    records.push({
      url: parseQuoted(urlMatch[1], `${manifestName} url`),
      sha512: parseQuoted(shaMatch[1], `${manifestName} sha512`),
      size: Number(sizeMatch[1]),
    });
  }
  return records;
}

function parseQuoted(raw, label) {
  try {
    const value = JSON.parse(raw);
    if (typeof value !== "string" || !value) throw new Error("not a string");
    return value;
  } catch {
    throw new Error(`invalid ${label}`);
  }
}

function requireManifestLine(manifest, expected, manifestName) {
  if (!manifest.split(/\r?\n/).includes(expected)) {
    throw new Error(`${manifestName} is missing expected line: ${expected}`);
  }
}

function isPublishable(name) {
  return /\.(?:AppImage|rpm|exe|zip|dmg|yml)$/i.test(name);
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
