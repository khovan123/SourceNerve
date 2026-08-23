import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { DesktopError, DesktopResult } from "../shared/desktop-api";
import {
  MCP_EXTENSION_IPC,
  type McpExtensionCredentialInput,
  type McpExtensionInstallInput,
  type McpExtensionToolPolicyInput,
  type McpMarketplaceSearchInput,
} from "../shared/mcp-extension-api";
import type { McpExtensionManager } from "./mcp-extension-manager";
import { planMcpMarketplaceInstall, searchMcpMarketplace } from "./mcp-marketplace";
import { validateMcpExtensionIpcInvocation } from "./mcp-extension-policy";
import { sanitizeRuntimeText } from "./runtime-log-store";

export interface McpExtensionIpcContext {
  manager(): McpExtensionManager | null;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
}

export function installMcpExtensionIpcHandlers(
  context: McpExtensionIpcContext,
): void {
  for (const channel of Object.values(MCP_EXTENSION_IPC)) {
    ipcMain.removeHandler(channel);
  }

  secureHandle(context, MCP_EXTENSION_IPC.list, async () =>
    invoke(context, (manager) => manager.list()),
  );
  secureHandle(context, MCP_EXTENSION_IPC.install, async (args) =>
    invoke(context, (manager) =>
      manager.install(args[0] as McpExtensionInstallInput),
    ),
  );
  secureHandle(context, MCP_EXTENSION_IPC.enable, async (args) =>
    invoke(context, (manager) => manager.enable(args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.disable, async (args) =>
    invoke(context, (manager) => manager.disable(args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.restart, async (args) =>
    invoke(context, (manager) => manager.restart(args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.remove, async (args) =>
    invoke(context, (manager) => manager.remove(args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.tools, async (args) =>
    invoke(context, (manager) => manager.listTools(args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.toolPolicy, async (args) =>
    invoke(context, (manager) =>
      manager.updateToolPolicy(args[0] as McpExtensionToolPolicyInput),
    ),
  );
  secureHandle(context, MCP_EXTENSION_IPC.credentialSet, async (args) =>
    invoke(context, (manager) =>
      manager.setCredential(args[0] as McpExtensionCredentialInput),
    ),
  );
  secureHandle(context, MCP_EXTENSION_IPC.credentialClear, async (args) =>
    invoke(context, (manager) => manager.clearCredential(args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.approveNext, async (args) =>
    invoke(context, (manager) => manager.approveNext(args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.oauthConnect, async (args) =>
    invoke(context, (manager) => manager.connectOAuth(args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.oauthRefresh, async (args) =>
    invoke(context, (manager) => manager.refreshOAuth(args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.oauthRevoke, async (args) =>
    invoke(context, (manager) => manager.revokeOAuth(args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.marketplaceSearch, async (args) =>
    invokeStandalone(() => searchMcpMarketplace(args[0] as McpMarketplaceSearchInput)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.marketplacePlan, async (args) =>
    invokeStandalone(() => planMcpMarketplaceInstall(args[0] as string)),
  );
}

function secureHandle(
  context: McpExtensionIpcContext,
  channel: string,
  handler: (args: readonly unknown[]) => Promise<DesktopResult<unknown>>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!context.isTrustedSender(event)) {
      return fail({
        code: "forbidden",
        message: "Desktop IPC sender is not trusted",
        retryable: false,
      });
    }
    const validation = validateMcpExtensionIpcInvocation(channel, args);
    if (validation) {
      return fail({
        code: "invalid_request",
        message: validation,
        retryable: false,
      });
    }
    return handler(args);
  });
}

async function invoke<T>(
  context: McpExtensionIpcContext,
  operation: (manager: McpExtensionManager) => Promise<T>,
): Promise<DesktopResult<T>> {
  const manager = context.manager();
  if (!manager) {
    return fail({
      code: "not_ready",
      message: "MCP extension manager is not initialized",
      retryable: true,
    });
  }
  return invokeStandalone(() => operation(manager));
}

async function invokeStandalone<T>(operation: () => Promise<T>): Promise<DesktopResult<T>> {
  try {
    return ok(await operation());
  } catch (error) {
    return fail(toDesktopError(error));
  }
}

function toDesktopError(error: unknown): DesktopError {
  const message = sanitizeRuntimeText(
    error instanceof Error ? error.message : "MCP extension operation failed",
    process.env.HOME,
  );
  if (/401|unauthorized/i.test(message)) {
    return { code: "unauthorized", message, retryable: false };
  }
  if (/403|forbidden|denied/i.test(message)) {
    return { code: "forbidden", message, retryable: false };
  }
  if (/404|not registered|not discovered|not found/i.test(message)) {
    return { code: "not_found", message, retryable: false };
  }
  if (/409|duplicate|already registered|already exists/i.test(message)) {
    return { code: "conflict", message, retryable: false };
  }
  if (/invalid|must|requires|reserved|does not|cannot|blocked/i.test(message)) {
    return { code: "invalid_request", message, retryable: false };
  }
  if (/not initialized|unavailable|timed out|timeout/i.test(message)) {
    return { code: "not_ready", message, retryable: true };
  }
  return { code: "service_error", message, retryable: true };
}

function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function fail<T>(error: DesktopError): DesktopResult<T> {
  return { ok: false, error };
}
