import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { DesktopError, DesktopResult } from "../shared/desktop-api";
import {
  MCP_EXTENSION_IPC,
  type McpExtensionActivityQuery,
  type McpExtensionCredentialInput,
  type McpExtensionInstallInput,
  type McpExtensionToolPolicyInput,
  type McpExtensionView,
  type McpMarketplaceInstallRequest,
  type McpMarketplaceSearchInput,
  type McpMarketplaceUpdateResult,
} from "../shared/mcp-extension-api";
import {
  attachArtifactEvidence,
  clearArtifactEvidence,
  readArtifactEvidence,
  rollbackMarketplaceWithArtifactEvidence,
  writeArtifactEvidence,
} from "./mcp-artifact-evidence-store";
import {
  planGovernedMcpMarketplaceInstall,
  searchGovernedMcpMarketplace,
} from "./mcp-enterprise-marketplace";
import type { CodexSkillCache } from "./codex-skill-cache";
import type { McpExtensionManager } from "./mcp-extension-manager";
import { validateMcpExtensionIpcInvocation } from "./mcp-extension-policy";
import { installPluginHubIpcHandlers } from "./plugin-hub-ipc";
import type { PluginWorkspaceProvider } from "./plugin-manager";
import { sanitizeRuntimeText } from "./runtime-log-store";

export interface McpExtensionIpcContext {
  manager(): McpExtensionManager | null;
  workspaces?(): PluginWorkspaceProvider | null;
  codexSkills?(): CodexSkillCache | null;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
}

export function installMcpExtensionIpcHandlers(
  context: McpExtensionIpcContext,
): void {
  for (const channel of Object.values(MCP_EXTENSION_IPC)) {
    ipcMain.removeHandler(channel);
  }

  secureHandle(context, MCP_EXTENSION_IPC.list, async () =>
    invoke(context, async (manager) => attachArtifactEvidence(manager, await manager.list())),
  );
  secureHandle(context, MCP_EXTENSION_IPC.install, async (args) =>
    invoke(context, async (manager) => {
      const input = args[0] as McpExtensionInstallInput;
      const installed = await manager.install(input);
      if (installed.authType === "bearer" && !installed.credentialConfigured) {
        return installed;
      }
      try {
        if (installed.authType === "oauth" && !installed.oauthConnected) {
          await manager.connectOAuth(installed.id);
        }
        return await activateInstalledDefaults(manager, installed.id);
      } catch (error) {
        await manager.remove(installed.id).catch(() => undefined);
        throw error;
      }
    }),
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
    invoke(context, async (manager) => {
      const extensionId = args[0] as string;
      const result = await manager.remove(extensionId);
      if (result.removed) await clearArtifactEvidence(manager, extensionId);
      return result;
    }),
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
    invoke(context, async (manager) => {
      const input = args[0] as McpExtensionCredentialInput;
      const before = (await manager.list()).find((item) => item.id === input.extensionId);
      const result = await manager.setCredential(input);
      if (before && !before.enabled && before.discoveredTools === 0) {
        await activateInstalledDefaults(manager, input.extensionId);
      }
      return result;
    }),
  );
  secureHandle(context, MCP_EXTENSION_IPC.credentialClear, async (args) =>
    invoke(context, (manager) => manager.clearCredential(args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.approveNext, async (args) =>
    invoke(context, (manager) => manager.approveNext(args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.activity, async (args) =>
    invoke(context, (manager) => manager.listActivity(args[0] as McpExtensionActivityQuery)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.oauthConnect, async (args) =>
    invoke(context, async (manager) => {
      const extensionId = args[0] as string;
      const before = (await manager.list()).find((item) => item.id === extensionId);
      const result = await manager.connectOAuth(extensionId);
      if (before && !before.enabled && before.discoveredTools === 0) {
        await activateInstalledDefaults(manager, extensionId);
      }
      return result;
    }),
  );
  secureHandle(context, MCP_EXTENSION_IPC.oauthRefresh, async (args) =>
    invoke(context, (manager) => manager.refreshOAuth(args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.oauthRevoke, async (args) =>
    invoke(context, (manager) => manager.revokeOAuth(args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.marketplaceSearch, async (args) =>
    invokeStandalone(() => searchGovernedMcpMarketplace(args[0] as McpMarketplaceSearchInput)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.marketplacePlan, async (args) =>
    invokeStandalone(() => planGovernedMcpMarketplaceInstall(args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.marketplaceInstall, async (args) =>
    invoke(context, async (manager) => {
      const request = args[0] as McpMarketplaceInstallRequest;
      const beforeIds = new Set((await manager.list()).map((item) => item.id));
      const plan = await planGovernedMcpMarketplaceInstall(request.serverName);
      try {
        const installed = await manager.installMarketplace(request);
        const activated = await activateInstalledDefaults(manager, installed.id);
        if (plan.server.verification) {
          await writeArtifactEvidence(manager, installed.id, "current", plan.server.verification);
          return { ...activated, artifactVerification: plan.server.verification };
        }
        return activated;
      } catch (error) {
        const created = (await manager.list()).find(
          (item) =>
            !beforeIds.has(item.id) && item.source === `registry:${request.serverName}`,
        );
        if (created) {
          await manager.remove(created.id).catch(() => undefined);
          await clearArtifactEvidence(manager, created.id).catch(() => undefined);
        }
        throw error;
      }
    }),
  );
  secureHandle(context, MCP_EXTENSION_IPC.marketplaceUpdate, async (args) =>
    invoke(context, (manager) => updateMarketplaceWithArtifactEvidence(manager, args[0] as string)),
  );
  secureHandle(context, MCP_EXTENSION_IPC.marketplaceRollback, async (args) =>
    invoke(context, (manager) => rollbackMarketplaceWithArtifactEvidence(manager, args[0] as string)),
  );

  installPluginHubIpcHandlers(context);
}

async function updateMarketplaceWithArtifactEvidence(
  manager: McpExtensionManager,
  extensionId: string,
): Promise<McpMarketplaceUpdateResult> {
  const current = await requireExtension(manager, extensionId);
  const plan = await planGovernedMcpMarketplaceInstall(registryServerName(current.source));
  const previousEvidence = await readArtifactEvidence(manager, extensionId, "current");
  const result = await manager.updateMarketplace(extensionId);
  if (
    result.rolledBack ||
    result.fromVersion === result.toVersion ||
    !plan.server.verification
  ) {
    return result;
  }

  try {
    await writeArtifactEvidence(manager, extensionId, "backup", previousEvidence);
    await writeArtifactEvidence(manager, extensionId, "current", plan.server.verification);
    return {
      ...result,
      message: `${result.message} SourceNerve retained the previous cryptographic provenance evidence with the rollback snapshot.`,
    };
  } catch (error) {
    await manager.rollbackMarketplace(extensionId).catch(() => undefined);
    await writeArtifactEvidence(manager, extensionId, "current", previousEvidence).catch(
      () => undefined,
    );
    await writeArtifactEvidence(manager, extensionId, "backup", plan.server.verification).catch(
      () => undefined,
    );
    throw error;
  }
}

async function requireExtension(
  manager: McpExtensionManager,
  extensionId: string,
): Promise<McpExtensionView> {
  const extension = (await manager.list()).find((candidate) => candidate.id === extensionId);
  if (!extension) throw new Error(`MCP extension ${extensionId} is not registered`);
  return extension;
}

function registryServerName(source: string): string {
  if (!source.startsWith("registry:")) {
    throw new Error("Only marketplace-backed MCP extensions support automatic update/rollback");
  }
  const value = source.slice("registry:".length);
  if (!/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("Installed MCP marketplace source is invalid");
  }
  return value;
}

async function activateInstalledDefaults(
  manager: McpExtensionManager,
  extensionId: string,
) {
  const before = (await manager.list()).find((item) => item.id === extensionId);
  if (!before) throw new Error(`MCP extension ${extensionId} is not registered`);

  const wasEnabled = before.enabled;
  if (!wasEnabled) await manager.enable(extensionId);
  const tools = await manager.listTools(extensionId);
  const changed = tools.filter((tool) => !tool.enabled || tool.approval !== "automatic");

  try {
    for (const tool of changed) {
      await manager.updateToolPolicy({
        extensionId,
        toolName: tool.originalName,
        enabled: true,
        approval: "automatic",
      });
    }
  } catch (error) {
    for (const tool of changed) {
      await manager
        .updateToolPolicy({
          extensionId,
          toolName: tool.originalName,
          enabled: tool.enabled,
          approval: tool.approval,
        })
        .catch(() => undefined);
    }
    if (!wasEnabled) await manager.disable(extensionId).catch(() => undefined);
    throw error;
  }

  const activated = (await manager.list()).find((item) => item.id === extensionId);
  if (!activated) throw new Error(`MCP extension ${extensionId} disappeared after activation`);
  return activated;
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
  if (/invalid|must|requires|reserved|does not|cannot|blocked|review/i.test(message)) {
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
