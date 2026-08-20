import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const profilePath = path.join(desktopDirectory, "bootstrap", "product-profile.template.json");
const envPath = path.join(desktopDirectory, ".env");
const placeholderPattern = /__([A-Z0-9_]+)__/g;
const raw = await readFile(profilePath, "utf8");
const required = [...raw.matchAll(placeholderPattern)].map((match) => match[1]);
const unique = [...new Set(required)];

if (unique.length === 0) {
  console.log("Desktop product profile is already materialized");
  process.exit(0);
}

let envRaw;
try {
  envRaw = await readFile(envPath, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error(`missing Desktop .env file: ${envPath}`);
  }
  throw error;
}
if (/^\s*export\s+/m.test(envRaw)) {
  throw new Error("Desktop .env must use KEY=VALUE syntax; shell export syntax is not allowed");
}
const values = parseEnv(envRaw);

let materialized = raw;
for (const name of unique) {
  const value = values[name];
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`missing or invalid Desktop .env value: ${name}`);
  }
  materialized = materialized.replaceAll(`__${name}__`, value);
}

if (placeholderPattern.test(materialized)) {
  throw new Error("Desktop product profile still contains unresolved release placeholders");
}

JSON.parse(materialized);
await writeFile(profilePath, materialized.endsWith("\n") ? materialized : `${materialized}\n`, "utf8");
console.log(`materialized ${unique.length} public Desktop product-profile value(s) from desktop/.env`);
