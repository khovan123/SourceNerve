import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DaemonManager,
  buildChildEnvironment,
  readinessIsReady,
  resolveDaemonBinaryPath,
  sanitizeLogLine,
  type DaemonClient,
} from "./daemon-manager";

function launchPlan() {
  const configPath = path.resolve("/tmp/sourcenerve-test.toml");
  return {
    configPath,
    environment: {
      SOURCENERVE_CONFIG: configPath,
      SOURCENERVE_BEARER_TOKEN: "B".repeat(32),
    },
  };
}

describe("DaemonManager", () => {
  it("fails closed when a health endpoint exists but Desktop cannot authenticate it", async () => {
    const client: DaemonClient = {
      health: async () => ({ status: "ok" }),
      readiness: async () => ({ ready: true }),
      serviceStatus: async () => {
        throw new Error("unauthorized");
      },
    };
    const manager = new DaemonManager({
      binaryPath: path.resolve("/definitely/missing/sourcenerve"),
      expectedVersion: "0.1.0",
      client,
    });
    manager.configure(launchPlan());

    await expect(manager.start()).resolves.toMatchObject({
      state: "incompatible",
      managed: false,
    });
  });

  it("recognizes a compatible external daemon without spawning a second process", async () => {
    const client: DaemonClient = {
      health: async () => ({ status: "ok" }),
      readiness: async () => ({ ready: true }),
      serviceStatus: async () => ({ identity: { version: "0.1.0" } }),
    };
    const manager = new DaemonManager({
      binaryPath: path.resolve("/definitely/missing/sourcenerve"),
      expectedVersion: "0.1.0",
      client,
    });
    manager.configure(launchPlan());

    await expect(manager.start()).resolves.toMatchObject({
      state: "external",
      managed: false,
      version: "0.1.0",
    });
  });
});

describe("daemon lifecycle helpers", () => {
  it("requires the explicit readiness boolean instead of treating HTTP 200 as ready", () => {
    expect(readinessIsReady({ ready: true })).toBe(true);
    expect(readinessIsReady({ ready: false })).toBe(false);
    expect(readinessIsReady({ status: "ok" })).toBe(false);
  });

  it("resolves staged binaries consistently in dev and packaged layouts", () => {
    expect(
      resolveDaemonBinaryPath({
        packaged: false,
        appPath: "/app",
        resourcesPath: "/packaged-resources",
        platform: "linux",
        arch: "x64",
      }),
    ).toBe(path.join("/app", "resources", "bin", "linux-x64", "sourcenerve"));

    expect(
      resolveDaemonBinaryPath({
        packaged: true,
        appPath: "/app",
        resourcesPath: "/packaged-resources",
        platform: "win32",
        arch: "x64",
      }),
    ).toBe(path.join("/packaged-resources", "bin", "win32-x64", "sourcenerve.exe"));
  });

  it("does not inherit unrelated parent secrets into the daemon", () => {
    const environment = buildChildEnvironment(
      { SOURCENERVE_CONFIG: "/tmp/config", SOURCENERVE_BEARER_TOKEN: "managed-secret" },
      {
        PATH: "/usr/bin",
        SSH_AUTH_SOCK: "/tmp/ssh.sock",
        SHOULD_NOT_LEAK_TOKEN: "parent-secret",
      },
    );

    expect(environment.PATH).toBe("/usr/bin");
    expect(environment.SSH_AUTH_SOCK).toBe("/tmp/ssh.sock");
    expect(environment.SHOULD_NOT_LEAK_TOKEN).toBeUndefined();
    expect(environment.SOURCENERVE_BEARER_TOKEN).toBe("managed-secret");
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("redacts known secrets before bounding daemon log lines", () => {
    const secret = "super-secret-token-value";
    const line = `${"x".repeat(8190)}${secret}?token=${secret} Authorization: Bearer ${secret}`;
    const sanitized = sanitizeLogLine(line, [secret]);

    expect(sanitized).not.toContain(secret);
    expect(sanitized.length).toBeLessThanOrEqual(8192);
  });
});
