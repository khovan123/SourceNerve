import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "..");

const packageJson = JSON.parse(await readFile(path.join(desktopDirectory, "package.json"), "utf8"));
const cargoToml = await readFile(path.join(repositoryDirectory, "Cargo.toml"), "utf8");
const productProfile = JSON.parse(
  await readFile(path.join(desktopDirectory, "bootstrap", "product-profile.template.json"), "utf8"),
);

const desktopVersion = String(packageJson.version ?? "").trim();
if (!/^\d+\.\d+\.\d+$/.test(desktopVersion)) {
  throw new Error(`stable Desktop release version must be SemVer x.y.z, received ${desktopVersion || "<empty>"}`);
}

const packageSection = cargoToml.match(/^\[package\]\s*$([\s\S]*?)(?=^\[|\z)/m)?.[1] ?? "";
const cargoVersion = packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
if (!cargoVersion) throw new Error("unable to read SourceNerve daemon version from Cargo.toml [package]");
if (cargoVersion !== desktopVersion) {
  throw new Error(`Desktop/daemon release version mismatch: desktop=${desktopVersion}, daemon=${cargoVersion}`);
}

if (!Number.isSafeInteger(productProfile.schemaVersion) || productProfile.schemaVersion < 1) {
  throw new Error("Desktop product profile schemaVersion must be a positive integer");
}
if (productProfile.product?.channel !== "stable") {
  throw new Error(`stable Desktop release requires product channel=stable, received ${String(productProfile.product?.channel)}`);
}

const releaseTag = String(
  process.env.SOURCENERVE_RELEASE_TAG
    ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "")
    ?? "",
).trim();
if (releaseTag) {
  const expectedTags = [`desktop-v${desktopVersion}`, `v${desktopVersion}`];
  if (!expectedTags.includes(releaseTag)) {
    throw new Error(`Desktop stable release tag mismatch: expected ${expectedTags.join(" or ")}, received ${releaseTag}`);
  }
}

console.log(
  `verified Desktop release contract: desktop/daemon ${desktopVersion}, profile schema v${productProfile.schemaVersion}${releaseTag ? `, tag ${releaseTag}` : ""}`,
);
