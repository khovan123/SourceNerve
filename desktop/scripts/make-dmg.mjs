import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const packageJson = JSON.parse(await readFile(path.join(desktopDirectory, "package.json"), "utf8"));
const arch = process.argv[2] ?? process.arch;

if (process.platform !== "darwin") {
  throw new Error("SourceNerve DMG must be built on macOS");
}
if (arch !== "arm64" && arch !== "x64") {
  throw new Error(`SourceNerve DMG supports arm64/x64 only, received ${arch}`);
}

const packagedApp = path.join(
  desktopDirectory,
  "out",
  `SourceNerve-darwin-${arch}`,
  "SourceNerve.app",
);
await access(packagedApp);

const makeDirectory = path.join(desktopDirectory, "out", "make", "dmg", arch);
await mkdir(makeDirectory, { recursive: true });
const outputPath = path.join(makeDirectory, `SourceNerve-${packageJson.version}-${arch}.dmg`);
const staging = await mkdtemp(path.join(tmpdir(), `sourcenerve-dmg-${arch}-`));

try {
  await cp(packagedApp, path.join(staging, "SourceNerve.app"), {
    recursive: true,
    preserveTimestamps: true,
  });
  await symlink("/Applications", path.join(staging, "Applications"));
  await rm(outputPath, { force: true });

  const { stdout, stderr } = await execFileAsync(
    "hdiutil",
    [
      "create",
      "-volname",
      "SourceNerve",
      "-srcfolder",
      staging,
      "-ov",
      "-format",
      "UDZO",
      outputPath,
    ],
    { cwd: desktopDirectory, maxBuffer: 8 * 1024 * 1024 },
  );
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
} finally {
  await rm(staging, { recursive: true, force: true });
}

await access(outputPath);
console.log(`created SourceNerve DMG: ${path.relative(desktopDirectory, outputPath)}`);
