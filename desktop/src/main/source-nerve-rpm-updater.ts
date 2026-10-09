import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

import { RpmUpdater } from "electron-updater";

type RpmPackageManager = "dnf" | "yum" | "zypper" | "rpm";

interface RpmInstallOptions {
  readonly isSilent: boolean;
  readonly isForceRunAfter: boolean;
  readonly isAdminRightsRequired: boolean;
}

export interface RpmInstallInvocation {
  command: string;
  args: string[];
  packageManager: RpmPackageManager;
  elevated: boolean;
}

interface ResolveRpmInstallInvocationOptions {
  installerPath: string;
  runningAsRoot: boolean;
  hasExecutable?: (candidate: string) => boolean;
  packageManagerOverride?: string;
}

const PACKAGE_MANAGERS: ReadonlyArray<readonly [RpmPackageManager, string]> = [
  ["dnf", "/usr/bin/dnf"],
  ["yum", "/usr/bin/yum"],
  ["zypper", "/usr/bin/zypper"],
  ["rpm", "/usr/bin/rpm"],
];

const PKEXEC_PATH = "/usr/bin/pkexec";
const RPM_INSTALL_TIMEOUT_MS = 10 * 60_000;
const RPM_STDERR_LIMIT = 64 * 1024;

export class SourceNerveRpmUpdater extends RpmUpdater {
  async installDownloadedUpdateAndRestart(): Promise<void> {
    const installerPath = this.downloadedUpdateHelper?.file ?? null;
    if (!installerPath) {
      throw new Error("SourceNerve RPM update has no downloaded installer.");
    }

    const invocation = resolveRpmInstallInvocation({
      installerPath,
      runningAsRoot: this.isRunningAsRoot(),
      packageManagerOverride: process.env.ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER?.trim(),
    });
    this._logger.info(
      `Installing SourceNerve RPM asynchronously using ${invocation.elevated ? "PolicyKit + " : ""}${invocation.packageManager}`,
    );
    await runRpmInstallInvocation(invocation);
    this.app.relaunch();
    this.app.quit();
  }

  protected doInstall(options: RpmInstallOptions): boolean {
    const installerPath = this.downloadedUpdateHelper?.file ?? null;
    if (!installerPath) {
      this.dispatchError(new Error("SourceNerve RPM update has no downloaded installer."));
      return false;
    }

    try {
      const invocation = resolveRpmInstallInvocation({
        installerPath,
        runningAsRoot: this.isRunningAsRoot(),
        packageManagerOverride: process.env.ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER?.trim(),
      });
      this._logger.info(
        `Installing SourceNerve RPM using ${invocation.elevated ? "PolicyKit + " : ""}${invocation.packageManager}`,
      );
      const result = spawnSync(invocation.command, invocation.args, {
        encoding: "utf8",
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: RPM_INSTALL_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });

      if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code;
        throw new Error(
          code === "ETIMEDOUT"
            ? "SourceNerve RPM update installation timed out."
            : "SourceNerve RPM update installation failed.",
        );
      }
      if (result.status !== 0) {
        throw new Error(rpmInstallFailureMessage(result.status, result.stderr));
      }

      if (options.isForceRunAfter) this.app.relaunch();
      return true;
    } catch (error) {
      this.dispatchError(
        error instanceof Error
          ? error
          : new Error("SourceNerve RPM update installation failed."),
      );
      return false;
    }
  }
}

export async function runRpmInstallInvocation(
  invocation: RpmInstallInvocation,
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const child = spawnProcess(invocation.command, invocation.args, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("SourceNerve RPM update installation timed out."));
    }, RPM_INSTALL_TIMEOUT_MS);

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      if (stderr.length >= RPM_STDERR_LIMIT) return;
      stderr = `${stderr}${String(chunk)}`.slice(0, RPM_STDERR_LIMIT);
    });
    child.once("error", () => {
      finish(new Error("SourceNerve RPM update installation failed."));
    });
    child.once("close", (status) => {
      finish(status === 0 ? null : new Error(rpmInstallFailureMessage(status, stderr)));
    });

    function finish(error: Error | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    }
  });
}

export function resolveRpmInstallInvocation(
  options: ResolveRpmInstallInvocationOptions,
): RpmInstallInvocation {
  const hasExecutable = options.hasExecutable ?? existsSync;
  const [packageManager, packageManagerPath] = resolvePackageManager(
    options.packageManagerOverride,
    hasExecutable,
  );
  const packageArgs = rpmPackageManagerArgs(packageManager, options.installerPath);

  if (options.runningAsRoot) {
    return {
      command: packageManagerPath,
      args: packageArgs,
      packageManager,
      elevated: false,
    };
  }

  if (!hasExecutable(PKEXEC_PATH)) {
    throw new Error(
      "SourceNerve RPM update requires PolicyKit authentication (pkexec).",
    );
  }

  return {
    command: PKEXEC_PATH,
    args: [packageManagerPath, ...packageArgs],
    packageManager,
    elevated: true,
  };
}

function resolvePackageManager(
  override: string | undefined,
  hasExecutable: (candidate: string) => boolean,
): readonly [RpmPackageManager, string] {
  if (override) {
    const selected = PACKAGE_MANAGERS.find(([name]) => name === override);
    if (!selected) {
      throw new Error("SourceNerve RPM update package-manager override is unsupported.");
    }
    if (!hasExecutable(selected[1])) {
      throw new Error("SourceNerve RPM update package manager is unavailable.");
    }
    return selected;
  }

  const detected = PACKAGE_MANAGERS.find(([, candidate]) => hasExecutable(candidate));
  if (!detected) {
    throw new Error("SourceNerve RPM update package manager is unavailable.");
  }
  return detected;
}

function rpmPackageManagerArgs(
  packageManager: RpmPackageManager,
  installerPath: string,
): string[] {
  if (packageManager === "dnf" || packageManager === "yum") {
    return ["install", "--nogpgcheck", "-y", installerPath];
  }
  if (packageManager === "zypper") {
    return [
      "--non-interactive",
      "--no-refresh",
      "install",
      "--allow-unsigned-rpm",
      "-f",
      installerPath,
    ];
  }
  return ["-Uvh", "--replacepkgs", "--replacefiles", "--nodeps", installerPath];
}

function rpmInstallFailureMessage(
  status: number | null,
  stderr: string | Buffer | null | undefined,
): string {
  const detail = String(stderr ?? "").toLowerCase();
  if (/timed?\s*out|etimedout/.test(detail)) {
    return "SourceNerve RPM update installation timed out.";
  }
  if (
    status === 126
    || status === 127
    || /not authorized|authorization|authentication|cancelled|canceled|dismissed/.test(detail)
  ) {
    return "System authorization was not completed. Approve the Fedora authentication prompt, then retry.";
  }
  return "SourceNerve RPM update installation failed.";
}
