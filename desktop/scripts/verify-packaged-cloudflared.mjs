import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const outDirectory = path.join(desktopDirectory, "out");
const executable = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
const resourcesDirectory = process.platform === "darwin" ? "Resources" : "resources";
const expectedSuffix = path.join(resourcesDirectory, "bin", executable);

const matches = [];
await walk(outDirectory, matches);
const packaged = matches.filter((candidate) => candidate.endsWith(expectedSuffix));
if (packaged.length === 0) {
  throw new Error(`packaged cloudflared not found under out/**/${expectedSuffix}`);
}
for (const candidate of packaged) {
  const metadata = await stat(candidate);
  if (!metadata.isFile() || metadata.size < 1024 * 1024) {
    throw new Error(`packaged cloudflared is invalid: ${candidate}`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o111) === 0) {
    throw new Error(`packaged cloudflared is not executable: ${candidate}`);
  }
}
console.log(`verified ${packaged.length} packaged cloudflared resource(s)`);

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
    else if (entry.isFile() && entry.name === executable) output.push(candidate);
  }
}
