import { copyFile, cp, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const marketplaceSource = path.join(repositoryRoot, ".agents", "plugins", "marketplace.json");
const stageRoot = path.join(desktopRoot, "resources", "plugin-catalog");
const marketplaceDestination = path.join(stageRoot, ".agents", "plugins", "marketplace.json");

const raw = await readFile(marketplaceSource, "utf8");
const marketplace = JSON.parse(raw);
if (!marketplace || typeof marketplace !== "object" || !Array.isArray(marketplace.plugins)) {
  throw new Error("Plugin marketplace has invalid schema");
}
if (marketplace.plugins.length > 128) {
  throw new Error("Plugin marketplace exceeds the Desktop plugin limit");
}

await rm(stageRoot, { recursive: true, force: true });
await mkdir(path.dirname(marketplaceDestination), { recursive: true });
await copyFile(marketplaceSource, marketplaceDestination);

let staged = 0;
for (const candidate of marketplace.plugins) {
  if (!candidate || typeof candidate !== "object" || !candidate.source || typeof candidate.source !== "object") {
    continue;
  }
  if (candidate.source.source !== "local") continue;
  if (typeof candidate.source.path !== "string" || candidate.source.path.length === 0) {
    throw new Error("Local plugin marketplace entry is missing source.path");
  }

  const relative = normalizeRelative(candidate.source.path);
  const source = inside(repositoryRoot, relative);
  const destination = inside(stageRoot, relative);
  await assertNoSymlinks(source);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true, errorOnExist: false });
  staged += 1;
}

console.log(`Staged plugin catalog with ${staged} local package(s) at ${stageRoot}`);

function normalizeRelative(value) {
  if (value.length > 1024 || /[\0\r\n]/.test(value)) {
    throw new Error("Plugin catalog path is invalid");
  }
  const normalized = path.normalize(value.replace(/^\.\//, ""));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    path.isAbsolute(normalized)
  ) {
    throw new Error(`Plugin catalog path escapes repository root: ${value}`);
  }
  return normalized;
}

function inside(root, relative) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const relation = path.relative(resolvedRoot, resolved);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Plugin catalog path escapes staging root: ${relative}`);
  }
  return resolved;
}

async function assertNoSymlinks(root) {
  const stat = await lstat(root);
  if (stat.isSymbolicLink()) {
    throw new Error(`Plugin catalog package must not contain symlink root: ${root}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Plugin catalog local source must be a directory: ${root}`);
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const entryStat = await lstat(entryPath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Plugin catalog package contains unsupported symlink: ${entryPath}`);
    }
    if (entryStat.isDirectory()) await assertNoSymlinks(entryPath);
  }
}
