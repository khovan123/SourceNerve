import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "..");
const executable = process.platform === "win32" ? "sourcenerve.exe" : "sourcenerve";
const source = path.join(repositoryDirectory, "target", "release", executable);
const targetDirectory = path.join(
  desktopDirectory,
  "resources",
  "bin",
  `${process.platform}-${process.arch}`,
);
const target = path.join(targetDirectory, executable);

let metadata;
try {
  metadata = await stat(source);
} catch {
  throw new Error(
    `SourceNerve release daemon is missing at ${source}. Run cargo build --release first.`,
  );
}
if (!metadata.isFile() || metadata.size === 0) {
  throw new Error(`SourceNerve release daemon is invalid at ${source}.`);
}

await mkdir(targetDirectory, { recursive: true });
await copyFile(source, target);
if (process.platform !== "win32") await chmod(target, 0o755);

const staged = await stat(target);
if (!staged.isFile() || staged.size !== metadata.size) {
  throw new Error("staged SourceNerve daemon failed integrity size check");
}

console.log(`staged SourceNerve daemon: ${target}`);
