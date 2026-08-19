import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");

const main = await text("src/main.ts");
const preload = await text("src/preload.ts");
const index = await text("index.html");
const forge = await text("forge.config.ts");
const rendererConfig = await text("vite.renderer.config.ts");
const mainConfig = await text("vite.main.config.ts");
const preloadConfig = await text("vite.preload.config.ts");
const renderer = await readTree(path.join(desktopDirectory, "src", "renderer"));

for (const required of [
  "contextIsolation: true",
  "nodeIntegration: false",
  "sandbox: true",
  "webSecurity: true",
  "allowRunningInsecureContent: false",
  "webviewTag: false",
  "setPermissionRequestHandler",
  "setPermissionCheckHandler",
  'setWindowOpenHandler(() => ({ action: "deny" }))',
  'on("will-attach-webview"',
]) {
  requireContains(main, required, `main process control ${required}`);
}

for (const forbidden of [
  "nodeIntegration: true",
  "contextIsolation: false",
  "sandbox: false",
  "webSecurity: false",
  "allowRunningInsecureContent: true",
  "webviewTag: true",
]) {
  requireAbsent(main, forbidden, `unsafe BrowserWindow setting ${forbidden}`);
}

requireContains(forge, "asar: true", "ASAR packaging");
for (const config of [rendererConfig, mainConfig, preloadConfig]) {
  requireContains(config, "sourcemap: false", "source map disablement");
}

for (const directive of [
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "script-src 'self'",
]) {
  requireContains(index, directive, `CSP ${directive}`);
}
if (/\sws:(?!\/\/)/.test(index)) {
  throw new Error("Desktop CSP must not allow the broad ws: scheme");
}
if (index.includes("'unsafe-eval'")) {
  throw new Error("Desktop CSP must not allow unsafe-eval");
}

for (const [label, content] of [
  ["preload", preload],
  ["renderer", renderer],
]) {
  for (const forbidden of [
    "SOURCENERVE_BEARER_TOKEN",
    "SOURCENERVE_GITHUB_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "AUTH0_CLIENT_SECRET",
    "process.env",
    "child_process",
    "shell.openPath",
    "shell.openExternal",
  ]) {
    requireAbsent(content, forbidden, `${label} secret/process primitive ${forbidden}`);
  }
}
for (const forbidden of ["ipcRenderer", 'from "electron"', "require(\"electron\")"]) {
  requireAbsent(renderer, forbidden, `renderer Electron primitive ${forbidden}`);
}

console.log("Desktop security baseline verified");

async function text(relativePath) {
  return readFile(path.join(desktopDirectory, relativePath), "utf8");
}

async function readTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      chunks.push(await readTree(candidate));
    } else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) {
      chunks.push(await readFile(candidate, "utf8"));
    }
  }
  return chunks.join("\n");
}

function requireContains(content, needle, label) {
  if (!content.includes(needle)) throw new Error(`missing Desktop security baseline: ${label}`);
}

function requireAbsent(content, needle, label) {
  if (content.includes(needle)) throw new Error(`forbidden Desktop security baseline pattern: ${label}`);
}
