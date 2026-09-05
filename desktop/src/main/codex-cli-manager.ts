import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DesktopHarnessCodexSetupView } from "../shared/harness-api";

const STATUS_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CAPTURE_BYTES = 16 * 1024;
const CODEX_PACKAGE = "@openai/codex";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
) => Promise<CommandResult>;

export interface CodexCliManagerOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  resolveCodex?: () => string | null;
  resolveNpm?: () => string | null;
  runCommand?: CommandRunner;
}

/**
 * Exact, renderer-parameter-free setup surface for the official Codex CLI.
 * Renderer code cannot choose a package, binary, command, arguments, or env.
 */
export class CodexCliManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: CommandRunner;
  private loginPromise: Promise<DesktopHarnessCodexSetupView> | null = null;
  private installPromise: Promise<DesktopHarnessCodexSetupView> | null = null;

  constructor(private readonly options: CodexCliManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.homeDir = options.homeDir ?? os.homedir();
    this.platform = options.platform ?? process.platform;
    this.runCommand = options.runCommand ?? runBoundedCommand;
  }

  command(): string | null {
    return this.options.resolveCodex ? this.options.resolveCodex() : resolveCodexExecutable(this.env, this.homeDir, this.platform);
  }

  async status(): Promise<DesktopHarnessCodexSetupView> {
    const command = this.command();
    const npm = this.options.resolveNpm ? this.options.resolveNpm() : resolveNpmExecutable(this.env, this.homeDir, this.platform);
    if (!command) {
      return {
        installed: false,
        authenticated: false,
        accountType: null,
        canInstall: npm !== null,
      };
    }

    const versionResult = await this.runCommand(command, ["--version"], STATUS_TIMEOUT_MS, this.env)
      .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    const version = parseCodexVersion(`${versionResult.stdout}\n${versionResult.stderr}`);

    const loginResult = await this.runCommand(command, ["login", "status"], STATUS_TIMEOUT_MS, this.env)
      .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    const accountType = parseAccountType(`${loginResult.stdout}\n${loginResult.stderr}`);

    return {
      installed: versionResult.exitCode === 0 || version !== undefined,
      ...(version ? { version } : {}),
      authenticated: loginResult.exitCode === 0 && accountType === "chatgpt",
      accountType,
      canInstall: npm !== null,
    };
  }

  async install(): Promise<DesktopHarnessCodexSetupView> {
    if (this.installPromise) return this.installPromise;
    this.installPromise = this.installOnce().finally(() => { this.installPromise = null; });
    return this.installPromise;
  }

  async login(): Promise<DesktopHarnessCodexSetupView> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.loginOnce().finally(() => { this.loginPromise = null; });
    return this.loginPromise;
  }

  private async installOnce(): Promise<DesktopHarnessCodexSetupView> {
    const npm = this.options.resolveNpm ? this.options.resolveNpm() : resolveNpmExecutable(this.env, this.homeDir, this.platform);
    if (!npm) throw new Error("npm is required to install the official Codex CLI");

    const result = await this.runCommand(
      npm,
      ["install", "--global", CODEX_PACKAGE, "--no-audit", "--no-fund"],
      INSTALL_TIMEOUT_MS,
      this.env,
    );
    if (result.exitCode !== 0) throw new Error("Codex CLI installation failed");

    await this.refreshNpmGlobalPath(npm);
    const status = await this.status();
    if (!status.installed) {
      throw new Error("Codex CLI was installed but SourceNerve cannot resolve the codex executable yet");
    }
    return status;
  }

  private async loginOnce(): Promise<DesktopHarnessCodexSetupView> {
    const command = this.command();
    if (!command) throw new Error("Install Codex CLI before signing in with ChatGPT");

    const result = await this.runCommand(command, ["login"], LOGIN_TIMEOUT_MS, this.env);
    if (result.exitCode !== 0) throw new Error("Codex ChatGPT login did not complete successfully");

    const status = await this.status();
    if (status.accountType === "apiKey") {
      throw new Error("Codex is signed in with an API key. Sign in with ChatGPT to use the SourceNerve native chat lane.");
    }
    if (!status.authenticated) throw new Error("Codex is not signed in with ChatGPT");
    return status;
  }

  private async refreshNpmGlobalPath(npm: string): Promise<void> {
    try {
      const result = await this.runCommand(npm, ["prefix", "--global"], STATUS_TIMEOUT_MS, this.env);
      if (result.exitCode !== 0) return;
      const prefix = result.stdout.trim();
      if (!path.isAbsolute(prefix)) return;
      const bin = this.platform === "win32" ? prefix : path.join(prefix, "bin");
      const current = pathValue(this.env);
      if (current.split(path.delimiter).includes(bin)) return;
      this.env.PATH = current ? `${bin}${path.delimiter}${current}` : bin;
      if (this.platform === "win32" && "Path" in this.env) this.env.Path = this.env.PATH;
    } catch {
      // Installation can still be usable through a known absolute path resolver.
    }
  }
}

export function resolveCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  return resolveExecutable("codex", env, homeDir, platform);
}

export function resolveNpmExecutable(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  return resolveExecutable("npm", env, homeDir, platform);
}

function resolveExecutable(
  name: "codex" | "npm",
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform,
): string | null {
  const directories = new Set<string>();
  for (const item of pathValue(env).split(path.delimiter)) if (item) directories.add(item);

  if (homeDir) {
    directories.add(path.join(homeDir, ".local", "bin"));
    directories.add(path.join(homeDir, ".volta", "bin"));
    directories.add(path.join(homeDir, ".local", "share", "pnpm"));
    directories.add(path.join(homeDir, ".npm-global", "bin"));
    addNvmDirectories(directories, homeDir);
  }

  if (platform === "win32") {
    if (env.APPDATA) directories.add(path.join(env.APPDATA, "npm"));
    if (env.ProgramFiles) directories.add(path.join(env.ProgramFiles, "nodejs"));
  } else {
    directories.add("/opt/homebrew/bin");
    directories.add("/usr/local/bin");
    directories.add("/usr/bin");
  }

  for (const directory of directories) {
    for (const candidateName of executableNames(name, platform)) {
      const candidate = path.join(directory, candidateName);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

function addNvmDirectories(directories: Set<string>, homeDir: string): void {
  const root = path.join(homeDir, ".nvm", "versions", "node");
  try {
    const versions = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) directories.add(path.join(root, version, "bin"));
  } catch {
    // NVM is optional.
  }
}

function executableNames(name: string, platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
}

function isExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function pathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? "";
}

function parseCodexVersion(value: string): string | undefined {
  const match = value.match(/codex(?:-cli)?\s+([^\s]+)/i);
  return match?.[1];
}

function parseAccountType(value: string): "chatgpt" | "apiKey" | null {
  if (/logged in using chatgpt/i.test(value)) return "chatgpt";
  if (/logged in using (?:an )?api key/i.test(value)) return "apiKey";
  return null;
}


export function codexSetupEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(sanitized)) {
    const normalized = key.toUpperCase();
    if (normalized.startsWith("SOURCENERVE_")
      || normalized === "GH_TOKEN"
      || normalized === "GITHUB_TOKEN"
      || normalized === "GITLAB_TOKEN"
      || normalized === "OPENAI_API_KEY"
      || normalized === "CODEX_ACCESS_TOKEN"
      || normalized === "NPM_TOKEN") {
      delete sanitized[key];
    }
  }
  return sanitized;
}

async function runBoundedCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: codexSetupEnvironment(env),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const append = (current: string, chunk: Buffer | string): string => {
      const next = current + chunk.toString();
      return Buffer.byteLength(next, "utf8") <= MAX_CAPTURE_BYTES
        ? next
        : Buffer.from(next, "utf8").subarray(0, MAX_CAPTURE_BYTES).toString("utf8");
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Codex setup command timed out"));
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
