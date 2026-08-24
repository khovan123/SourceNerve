import { access } from "node:fs/promises";
import path from "node:path";
import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";

import type { DesktopError, DesktopResult } from "../shared/desktop-api";
import { PLUGIN_HUB_IPC } from "../shared/plugin-hub-api";
import type { McpExtensionManager } from "./mcp-extension-manager";
import { PluginManager } from "./plugin-manager";
import { createPluginRuntimeMaterializer } from "./plugin-hub-runtime";
import { sanitizeRuntimeText } from "./runtime-log-store";

export interface PluginHubIpcContext {
  manager(): McpExtensionManager | null;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
}

let activeManager: McpExtensionManager | null = null;
let pluginManager: PluginManager | null = null;
let initializing: Promise<PluginManager> | null = null;

export function installPluginHubIpcHandlers(context: PluginHubIpcContext): void {
  for (const channel of Object.values(PLUGIN_HUB_IPC)) ipcMain.removeHandler(channel);

  secureHandle(context, PLUGIN_HUB_IPC.list, async () =>
    invoke(context, (manager) => manager.list()),
  );
  secureHandle(context, PLUGIN_HUB_IPC.explore, async () =>
    invoke(context, (manager) => manager.explore()),
  );
  secureHandle(context, PLUGIN_HUB_IPC.inspectLocal, async (args) =>
    invoke(context, (manager) => manager.inspectLocal(requirePath(args[0]))),
  );
  secureHandle(context, PLUGIN_HUB_IPC.pickLocal, async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: "Choose SourceNerve plugin package",
        properties: ["openDirectory"],
      });
      if (result.canceled || result.filePaths.length !== 1) {
        return ok({ selected: false as const });
      }
      const root = requirePath(result.filePaths[0]);
      const manager = await requirePluginManager(context);
      const review = await manager.inspectLocal(root);
      return ok({ selected: true as const, path: root, review });
    } catch (error) {
      return fail(toDesktopError(error));
    }
  });
  secureHandle(context, PLUGIN_HUB_IPC.installLocal, async (args) =>
    invoke(context, (manager) => manager.installLocal(requirePath(args[0]))),
  );
  secureHandle(context, PLUGIN_HUB_IPC.enable, async (args) =>
    invoke(context, (manager) => manager.enable(requireId(args[0]))),
  );
  secureHandle(context, PLUGIN_HUB_IPC.disable, async (args) =>
    invoke(context, (manager) => manager.disable(requireId(args[0]))),
  );
  secureHandle(context, PLUGIN_HUB_IPC.remove, async (args) =>
    invoke(context, (manager) => manager.remove(requireId(args[0]))),
  );
}

async function invoke<T>(
  context: PluginHubIpcContext,
  operation: (manager: PluginManager) => Promise<T>,
): Promise<DesktopResult<T>> {
  try {
    const manager = await requirePluginManager(context);
    return ok(await operation(manager));
  } catch (error) {
    return fail(toDesktopError(error));
  }
}

async function requirePluginManager(context: PluginHubIpcContext): Promise<PluginManager> {
  const mcp = context.manager();
  if (!mcp) throw new Error("MCP extension manager is not initialized");
  if (pluginManager && activeManager === mcp) return pluginManager;
  if (initializing && activeManager === mcp) return initializing;

  activeManager = mcp;
  initializing = (async () => {
    const userData = app.getPath("userData");
    const repositoryRoot = await findRepositoryRoot();
    const manager = new PluginManager({
      mcp,
      registryPath: path.join(userData, "managed", "plugin-hub.json"),
      skillStoreRoot: path.join(userData, "managed", "plugin-skills"),
      ...(repositoryRoot ? { repositoryRoot } : {}),
      runtime: createPluginRuntimeMaterializer(mcp),
    });
    await manager.initialize();
    pluginManager = manager;
    return manager;
  })();
  try {
    return await initializing;
  } finally {
    initializing = null;
  }
}

async function findRepositoryRoot(): Promise<string | undefined> {
  const candidates = [
    path.resolve(process.cwd(), ".."),
    path.resolve(app.getAppPath(), ".."),
    path.resolve(app.getAppPath()),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(path.join(candidate, ".agents", "plugins", "marketplace.json"));
      return candidate;
    } catch {
      // Try the next bounded local candidate.
    }
  }
  return undefined;
}

function secureHandle(
  context: PluginHubIpcContext,
  channel: string,
  handler: (args: readonly unknown[]) => Promise<DesktopResult<unknown>>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!context.isTrustedSender(event)) {
      return fail({ code: "forbidden", message: "Desktop IPC sender is not trusted", retryable: false });
    }
    const validation = validateInvocation(channel, args);
    if (validation) {
      return fail({ code: "invalid_request", message: validation, retryable: false });
    }
    return handler(args);
  });
}

function validateInvocation(channel: string, args: readonly unknown[]): string | null {
  const noArgs = new Set([PLUGIN_HUB_IPC.list, PLUGIN_HUB_IPC.explore, PLUGIN_HUB_IPC.pickLocal]);
  if (noArgs.has(channel)) return args.length === 0 ? null : "Plugin Hub action does not accept arguments";
  if (args.length !== 1) return "Plugin Hub action requires exactly one argument";
  if (channel === PLUGIN_HUB_IPC.inspectLocal || channel === PLUGIN_HUB_IPC.installLocal) {
    try {
      requirePath(args[0]);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Plugin package path is invalid";
    }
  }
  if (channel === PLUGIN_HUB_IPC.enable || channel === PLUGIN_HUB_IPC.disable || channel === PLUGIN_HUB_IPC.remove) {
    try {
      requireId(args[0]);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Plugin id is invalid";
    }
  }
  return "Plugin Hub IPC channel is not recognized";
}

function requirePath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw new Error("Plugin package path is invalid");
  }
  if (!path.isAbsolute(value)) throw new Error("Plugin package path must be absolute");
  return value;
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error("Plugin id is invalid");
  }
  return value;
}

function toDesktopError(error: unknown): DesktopError {
  const message = sanitizeRuntimeText(
    error instanceof Error ? error.message : "Plugin Hub operation failed",
    process.env.HOME,
  );
  if (/not initialized|unavailable|timeout|timed out/i.test(message)) {
    return { code: "not_ready", message, retryable: true };
  }
  if (/not installed|not found|no longer installed/i.test(message)) {
    return { code: "not_found", message, retryable: false };
  }
  if (/already installed|conflict|incompatible|duplicate/i.test(message)) {
    return { code: "conflict", message, retryable: false };
  }
  if (/invalid|must|requires|refuses|escape|unsupported|exceeds|symlink|integrity/i.test(message)) {
    return { code: "invalid_request", message, retryable: false };
  }
  return { code: "service_error", message, retryable: true };
}

function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function fail<T>(error: DesktopError): DesktopResult<T> {
  return { ok: false, error };
}
