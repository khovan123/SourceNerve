import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2026.7.3";
const RELEASE_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}`;
const MAX_ASSET_BYTES = 100 * 1024 * 1024;

const ASSETS = {
  "linux-x64": {
    name: "cloudflared-linux-amd64",
    sha256: "93100d02a20e574515656c465308165a2f6c7d89fe0ac73ec260e8a1a48005f4",
    archive: false,
  },
  "linux-arm64": {
    name: "cloudflared-linux-arm64",
    sha256: "5697c8682ce725ee7fb8f7932ef891258666cfe525f7131503035b6146c382cd",
    archive: false,
  },
  "win32-x64": {
    name: "cloudflared-windows-amd64.exe",
    sha256: "05a050ec27b4e6980d63ffb92469b9c24d6391cd3e02e1f505c9dfd8b5b79f42",
    archive: false,
  },
  "darwin-x64": {
    name: "cloudflared-darwin-amd64.tgz",
    sha256: "70d1cd13e279d5980b21995ed971d8ef0dc548f2a01c2cd389f5bdb41f6d2535",
    archive: true,
  },
  "darwin-arm64": {
    name: "cloudflared-darwin-arm64.tgz",
    sha256: "7cb7a854bc1877887004e6c3b9ec36676f07370786d733faf1c85860f8654871",
    archive: true,
  },
};

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const destinationDirectory = path.join(desktopDirectory, "resources", "bin");
const destination = path.join(
  destinationDirectory,
  process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
);
const key = `${process.platform}-${process.arch}`;
const asset = ASSETS[key];
if (!asset) throw new Error(`Unsupported cloudflared Desktop target: ${key}`);

const override = process.env.SOURCENERVE_CLOUDFLARED_BINARY;
if (override) {
  const expected = normalizedSha(process.env.SOURCENERVE_CLOUDFLARED_SHA256);
  if (!expected) {
    throw new Error(
      "SOURCENERVE_CLOUDFLARED_SHA256 is required when using SOURCENERVE_CLOUDFLARED_BINARY",
    );
  }
  const bytes = await readFile(path.resolve(override));
  assertAssetSize(bytes);
  verifyDigest(bytes, expected, "local cloudflared override");
  await install(bytes);
  console.log("[desktop] staged checksum-verified cloudflared local override");
  process.exit(0);
}

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-cloudflared-"));
try {
  const assetPath = path.join(temporaryDirectory, asset.name);
  const response = await fetch(`${RELEASE_BASE}/${asset.name}`, { redirect: "follow" });
  if (!response.ok) throw new Error(`cloudflared download failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
    throw new Error("cloudflared release asset exceeds 100 MiB limit");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  assertAssetSize(bytes);
  verifyDigest(bytes, asset.sha256, asset.name);
  await writeFile(assetPath, bytes, { mode: 0o600 });

  if (asset.archive) {
    const extractDirectory = path.join(temporaryDirectory, "extract");
    await mkdir(extractDirectory, { recursive: true });
    const result = spawnSync("tar", ["-xzf", assetPath, "-C", extractDirectory], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error("failed to extract pinned cloudflared macOS archive");
    const binary = await readFile(path.join(extractDirectory, "cloudflared"));
    assertAssetSize(binary);
    await install(binary);
  } else {
    await install(bytes);
  }
  console.log(`[desktop] staged pinned cloudflared ${VERSION} for ${key}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function normalizedSha(value) {
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) return null;
  return value.toLowerCase();
}

function assertAssetSize(bytes) {
  if (bytes.length < 1024 * 1024 || bytes.length > MAX_ASSET_BYTES) {
    throw new Error("cloudflared release asset has unexpected size");
  }
}

function verifyDigest(bytes, expected, label) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected.toLowerCase()) {
    throw new Error(`cloudflared SHA-256 mismatch for ${label}: expected ${expected}, got ${digest}`);
  }
}

async function install(bytes) {
  await mkdir(destinationDirectory, { recursive: true, mode: 0o755 });
  const temporary = `${destination}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { mode: process.platform === "win32" ? 0o644 : 0o755 });
  await rename(temporary, destination);
  if (process.platform !== "win32") await chmod(destination, 0o755);
}
