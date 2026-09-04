import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const packageJson = JSON.parse(await readFile(path.join(desktopDirectory, "package.json"), "utf8"));
const arch = process.argv[2] ?? process.arch;
const HDIUTIL_CREATE_ATTEMPTS = 3;
const HDIUTIL_RETRY_DELAY_MS = 2_000;

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

  for (let attempt = 1; attempt <= HDIUTIL_CREATE_ATTEMPTS; attempt += 1) {
    try {
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
      break;
    } catch (error) {
      const diagnostic = `${error instanceof Error ? error.message : ""} ${
        typeof error === "object" && error !== null && "stderr" in error
          ? String(error.stderr ?? "")
          : ""
      }`;
      const transient = /resource busy|device busy|temporarily unavailable/i.test(diagnostic);
      if (!transient || attempt >= HDIUTIL_CREATE_ATTEMPTS) throw error;
      console.warn(
        `[desktop] hdiutil create hit a transient busy error; retrying (${attempt}/${HDIUTIL_CREATE_ATTEMPTS})`,
      );
      await rm(outputPath, { force: true });
      await sleep(HDIUTIL_RETRY_DELAY_MS * attempt);
    }
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}

await access(outputPath);
console.log(`created SourceNerve DMG: ${path.relative(desktopDirectory, outputPath)}`);
