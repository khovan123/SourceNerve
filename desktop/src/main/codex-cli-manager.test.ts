import { describe, expect, it, vi } from "vitest";

import { CodexCliManager, codexSetupEnvironment } from "./codex-cli-manager";

describe("CodexCliManager", () => {
  it("strips SourceNerve/provider/API credentials from setup child processes", () => {
    const env = codexSetupEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/user",
      HTTP_PROXY: "http://proxy.example",
      SOURCENERVE_BEARER_TOKEN: "secret",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      GITLAB_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
      CODEX_ACCESS_TOKEN: "secret",
      NPM_TOKEN: "secret",
    });
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/user", HTTP_PROXY: "http://proxy.example" });
    expect(env.SOURCENERVE_BEARER_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GITLAB_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
  });

  it("reports a missing CLI and whether npm can install it", async () => {
    const manager = new CodexCliManager({
      resolveCodex: () => null,
      resolveNpm: () => "/usr/bin/npm",
      runCommand: vi.fn(),
    });
    await expect(manager.status()).resolves.toEqual({
      installed: false,
      authenticated: false,
      accountType: null,
      canInstall: true,
    });
  });

  it("reports ChatGPT authentication without exposing command output", async () => {
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "codex-cli 0.153.4\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "Logged in using ChatGPT\n" };
    });
    const manager = new CodexCliManager({
      resolveCodex: () => "/opt/codex",
      resolveNpm: () => "/opt/npm",
      runCommand,
    });

    await expect(manager.status()).resolves.toEqual({
      installed: true,
      version: "0.153.4",
      authenticated: true,
      accountType: "chatgpt",
      canInstall: true,
    });
  });

  it("uses one exact official npm package install command", async () => {
    let installed = false;
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[0] === "install") {
        installed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "prefix") return { exitCode: 0, stdout: "/opt/npm\n", stderr: "" };
      if (args[0] === "--version") return { exitCode: 0, stdout: "codex-cli 0.153.4\n", stderr: "" };
      if (args[0] === "login" && args[1] === "status") return { exitCode: 1, stdout: "", stderr: "Not logged in" };
      throw new Error(`unexpected args ${args.join(" ")}`);
    });
    const manager = new CodexCliManager({
      env: { PATH: "/usr/bin" },
      resolveCodex: () => installed ? "/opt/npm/bin/codex" : null,
      resolveNpm: () => "/usr/bin/npm",
      runCommand,
    });

    const status = await manager.install();
    expect(status.installed).toBe(true);
    expect(runCommand).toHaveBeenCalledWith(
      "/usr/bin/npm",
      ["install", "--global", "@openai/codex", "--no-audit", "--no-fund"],
      expect.any(Number),
      expect.any(Object),
    );
  });

  it("runs the fixed Codex browser login flow and requires ChatGPT", async () => {
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.length === 1 && args[0] === "login") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "--version") return { exitCode: 0, stdout: "codex-cli 0.153.4", stderr: "" };
      if (args[0] === "login" && args[1] === "status") return { exitCode: 0, stdout: "Logged in using ChatGPT", stderr: "" };
      throw new Error(`unexpected args ${args.join(" ")}`);
    });
    const manager = new CodexCliManager({
      resolveCodex: () => "/opt/codex",
      resolveNpm: () => "/opt/npm",
      runCommand,
    });

    await expect(manager.login()).resolves.toMatchObject({ authenticated: true, accountType: "chatgpt" });
    expect(runCommand).toHaveBeenCalledWith("/opt/codex", ["login"], expect.any(Number), expect.any(Object));
  });

  it("does not treat API-key auth as the ChatGPT subscription lane", async () => {
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "codex-cli 0.153.4", stderr: "" };
      return { exitCode: 0, stdout: "Logged in using an API key", stderr: "" };
    });
    const manager = new CodexCliManager({
      resolveCodex: () => "/opt/codex",
      resolveNpm: () => null,
      runCommand,
    });

    await expect(manager.status()).resolves.toMatchObject({ authenticated: false, accountType: "apiKey" });
  });
});
