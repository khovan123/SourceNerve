import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const outDirectory = path.join(desktopDirectory, "out");
const resourcesDirectory = process.platform === "darwin" ? "Resources" : "resources";
const catalogRootSuffix = path.join(resourcesDirectory, "plugin-catalog");

const roots = await findCatalogRoots(outDirectory);
if (roots.length === 0) {
  throw new Error(`packaged plugin catalog not found under out/**/${catalogRootSuffix}`);
}

for (const catalogRoot of roots) {
  const marketplacePath = path.join(catalogRoot, ".agents", "plugins", "marketplace.json");
  const raw = await readFile(marketplacePath, "utf8");
  const marketplace = JSON.parse(raw);
  if (!marketplace || typeof marketplace !== "object" || !Array.isArray(marketplace.plugins)) {
    throw new Error(`packaged plugin marketplace is invalid: ${marketplacePath}`);
  }

  let localPackages = 0;
  for (const candidate of marketplace.plugins) {
    if (!candidate || typeof candidate !== "object" || !candidate.source || typeof candidate.source !== "object") {
      continue;
    }
    if (candidate.source.source !== "local") continue;
    if (typeof candidate.source.path !== "string") {
      throw new Error(`packaged local plugin entry is missing source.path: ${marketplacePath}`);
    }
    const packageRoot = inside(catalogRoot, candidate.source.path);
    await access(path.join(packageRoot, ".codex-plugin", "plugin.json"));
    localPackages += 1;
  }

  if (localPackages === 0) {
    throw new Error(`packaged plugin marketplace contains no local Explore packages: ${marketplacePath}`);
  }
}

console.log(`verified ${roots.length} packaged Plugin Explore catalog resource(s)`);

async function findCatalogRoots(directory) {
  const output = [];
  async function walk(current) {
    let entries;
    try {
      entries = await import("node:fs/promises").then(({ readdir }) => readdir(current, { withFileTypes: true }));
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(current, entry.name);
      if (candidate.endsWith(catalogRootSuffix)) {
        try {
          await access(path.join(candidate, ".agents", "plugins", "marketplace.json"));
          output.push(candidate);
        } catch {
          // Keep walking; this directory is not a complete staged catalog.
        }
      }
      await walk(candidate);
    }
  }
  await walk(directory);
  return output;
}

function inside(root, value) {
  if (!value || value.length > 1024 || /[\0\r\n]/.test(value)) {
    throw new Error("packaged plugin catalog path is invalid");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, value);
  const relation = path.relative(resolvedRoot, resolved);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`packaged plugin catalog path escapes root: ${value}`);
  }
  return resolved;
}
