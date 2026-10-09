import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { resolveRpmInstallInvocation, runRpmInstallInvocation } from "./source-nerve-rpm-updater";

describe("SourceNerve RPM updater", () => {
  const installerPath = "/home/user/.cache/sourcenerve updater/pending/source nerve.rpm";

  it("uses PolicyKit with direct argv for Fedora dnf installs", () => {
    const available = new Set(["/usr/bin/dnf", "/usr/bin/pkexec"]);

    expect(
      resolveRpmInstallInvocation({
        installerPath,
        runningAsRoot: false,
        hasExecutable: (candidate) => available.has(candidate),
      }),
    ).toEqual({
      command: "/usr/bin/pkexec",
      args: [
        "/usr/bin/dnf",
        "install",
        "--nogpgcheck",
        "-y",
        installerPath,
      ],
      packageManager: "dnf",
      elevated: true,
    });
  });

  it("runs the package manager directly when SourceNerve already has root privileges", () => {
    const available = new Set(["/usr/bin/dnf"]);

    expect(
      resolveRpmInstallInvocation({
        installerPath,
        runningAsRoot: true,
        hasExecutable: (candidate) => available.has(candidate),
      }),
    ).toEqual({
      command: "/usr/bin/dnf",
      args: ["install", "--nogpgcheck", "-y", installerPath],
      packageManager: "dnf",
      elevated: false,
    });
  });

  it("falls back to rpm only when higher-level package managers are unavailable", () => {
    const available = new Set(["/usr/bin/rpm", "/usr/bin/pkexec"]);

    expect(
      resolveRpmInstallInvocation({
        installerPath,
        runningAsRoot: false,
        hasExecutable: (candidate) => available.has(candidate),
      }),
    ).toMatchObject({
      command: "/usr/bin/pkexec",
      args: [
        "/usr/bin/rpm",
        "-Uvh",
        "--replacepkgs",
        "--replacefiles",
        "--nodeps",
        installerPath,
      ],
      packageManager: "rpm",
    });
  });

  it("fails closed when GUI elevation is unavailable", () => {
    const available = new Set(["/usr/bin/dnf"]);

    expect(() =>
      resolveRpmInstallInvocation({
        installerPath,
        runningAsRoot: false,
        hasExecutable: (candidate) => available.has(candidate),
      }),
    ).toThrow(/PolicyKit authentication/);
  });

  it("rejects unsupported package-manager overrides", () => {
    const available = new Set(["/usr/bin/dnf", "/usr/bin/pkexec"]);

    expect(() =>
      resolveRpmInstallInvocation({
        installerPath,
        runningAsRoot: false,
        packageManagerOverride: "sh -c dnf",
        hasExecutable: (candidate) => available.has(candidate),
      }),
    ).toThrow(/override is unsupported/);
  });

  it("waits asynchronously for PolicyKit and the package manager to finish", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const promise = runRpmInstallInvocation({
      command: "/usr/bin/pkexec",
      args: ["/usr/bin/dnf", "install", "-y", installerPath],
      packageManager: "dnf",
      elevated: true,
    }, spawnProcess);

    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/pkexec",
      ["/usr/bin/dnf", "install", "-y", installerPath],
      expect.objectContaining({ shell: false, stdio: ["ignore", "ignore", "pipe"] }),
    );
    child.emit("close", 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it("maps a dismissed PolicyKit prompt to a retryable authorization message", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const promise = runRpmInstallInvocation({
      command: "/usr/bin/pkexec",
      args: ["/usr/bin/dnf", "install", "-y", installerPath],
      packageManager: "dnf",
      elevated: true,
    }, spawnProcess);

    child.emit("close", 126);
    await expect(promise).rejects.toThrow("System authorization was not completed");
  });
});
