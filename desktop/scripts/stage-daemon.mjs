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

try {
  const metadata = await stat(source);
  if (!metadata.isFile()) throw new Error("not a file");
} catch {
  throw new Error(
    `SourceNerve release daemon is missing at ${source}. Run cargo build --release first.`,
  );
}

await mkdir(targetDirectory, { recursive: true });
await copyFile(source, target);
if (process.platform !== "win32") await chmod(target, 0o755);
console.log(`staged SourceNerve daemon: ${target}`);
