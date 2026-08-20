import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const makeDirectory = path.join(desktopDirectory, "out", "make");
const target = process.env.SOURCENERVE_DISTRIBUTION_KIND ?? inferTarget();

const expected = {
  linux: [".rpm", ".AppImage"],
  windows: [".exe"],
  macos: [".dmg", ".zip"],
}[target];

if (!expected) {
  throw new Error(`unsupported SourceNerve distribution target: ${target}`);
}

const files = [];
await walk(makeDirectory, files);
if (files.length === 0) throw new Error("no Electron Forge distribution artifacts found under out/make");

for (const suffix of expected) {
  const matches = files.filter((candidate) => candidate.endsWith(suffix));
  if (matches.length === 0) {
    throw new Error(`missing required ${target} artifact ${suffix}; found: ${files.map(relative).join(", ")}`);
  }
  for (const match of matches) {
    const metadata = await stat(match);
    if (!metadata.isFile() || metadata.size < 64 * 1024) {
      throw new Error(`distribution artifact is unexpectedly small or invalid: ${relative(match)}`);
    }
  }
}

console.log(
  `verified ${target} distribution artifacts: ${expected.join(", ")} (${files.map(relative).join(", ")})`,
);

function inferTarget() {
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return process.platform;
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
