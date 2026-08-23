import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const profilePath = path.join(
  desktopDirectory,
  "bootstrap",
  "product-profile.template.json",
);

const profile = JSON.parse(await readFile(profilePath, "utf8"));
const baseUrl = profile?.bootstrapBroker?.baseUrl;

if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
  throw new Error("installable Desktop bootstrap profile is missing bootstrapBroker.baseUrl");
}
if (/^__[A-Z0-9_]+__$/.test(baseUrl)) {
  throw new Error("installable Desktop bootstrap profile contains an unresolved broker placeholder");
}

let parsed;
try {
  parsed = new URL(baseUrl);
} catch {
  throw new Error("installable Desktop bootstrap broker URL is invalid");
}

if (parsed.protocol !== "https:") {
  throw new Error("installable Desktop bootstrap broker must use HTTPS");
}
if (
  parsed.hostname === "example.invalid" ||
  parsed.hostname.endsWith(".example.invalid") ||
  parsed.hostname === "invalid" ||
  parsed.hostname.endsWith(".invalid")
) {
  throw new Error(`installable Desktop bootstrap broker must not use a reserved invalid host: ${parsed.hostname}`);
}
if (parsed.username || parsed.password || parsed.search || parsed.hash) {
  throw new Error("installable Desktop bootstrap broker URL must not contain credentials, query, or fragment");
}

console.log(`verified installable Desktop bootstrap broker: ${baseUrl}`);
