import { describe, expect, it } from "vitest";

import { resolveRpmInstallInvocation } from "./source-nerve-rpm-updater";

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
});
