import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const profilePath = path.resolve(scriptDirectory, "..", "bootstrap", "product-profile.template.json");
const placeholderPattern = /__([A-Z0-9_]+)__/g;
const raw = await readFile(profilePath, "utf8");
const required = [...raw.matchAll(placeholderPattern)].map((match) => match[1]);
const unique = [...new Set(required)];

if (unique.length === 0) {
  console.log("Desktop product profile is already materialized");
  process.exit(0);
}

let materialized = raw;
for (const name of unique) {
  const value = process.env[name];
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`missing or invalid public release profile value: ${name}`);
  }
  materialized = materialized.replaceAll(`__${name}__`, value);
}

if (placeholderPattern.test(materialized)) {
  throw new Error("Desktop product profile still contains unresolved release placeholders");
}

JSON.parse(materialized);
await writeFile(profilePath, materialized.endsWith("\n") ? materialized : `${materialized}\n`, "utf8");
console.log(`materialized ${unique.length} public Desktop product-profile value(s)`);
