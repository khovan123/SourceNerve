import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "..");

const desktopPackage = JSON.parse(
  await readFile(path.join(desktopDirectory, "package.json"), "utf8"),
);
const cargoToml = await readFile(path.join(repositoryDirectory, "Cargo.toml"), "utf8");
const packageBlock = cargoToml.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1];
const daemonVersion = packageBlock?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
const desktopVersion = desktopPackage.version;

if (typeof desktopVersion !== "string" || !desktopVersion.trim()) {
  throw new Error("Desktop package version is missing");
}
if (!daemonVersion) {
  throw new Error("SourceNerve Cargo package version could not be resolved");
}
if (desktopVersion !== daemonVersion) {
  throw new Error(
    `Desktop version ${desktopVersion} does not match bundled SourceNerve daemon version ${daemonVersion}`,
  );
}

console.log(`verified Desktop/daemon version: ${desktopVersion}`);
