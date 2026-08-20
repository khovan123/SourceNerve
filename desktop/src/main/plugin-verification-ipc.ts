import { clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { writeFile } from "node:fs/promises";

import type { DesktopError, DesktopResult } from "../shared/desktop-api";
import {
  PLUGIN_VERIFICATION_IPC,
  type PluginCopyResult,
  type PluginDomainChallengeInput,
  type PluginIconExportResult,
  type PluginOpenResult,
} from "../shared/plugin-verification-api";
import { validatePluginVerificationIpcInvocation } from "./plugin-verification-policy";
import type { PluginVerificationManager } from "./plugin-verification-manager";
import { sanitizeRuntimeText } from "./runtime-log-store";

export interface PluginVerificationIpcContext {
  manager(): PluginVerificationManager | null;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
}

export function installPluginVerificationIpcHandlers(
  context: PluginVerificationIpcContext,
): void {
  for (const channel of Object.values(PLUGIN_VERIFICATION_IPC)) {
    ipcMain.removeHandler(channel);
  }

  secureHandle(context, PLUGIN_VERIFICATION_IPC.state, async () =>
    invoke(context, (manager) => manager.state()));
  secureHandle(context, PLUGIN_VERIFICATION_IPC.verify, async () =>
    invoke(context, (manager) => manager.verify()));
  secureHandle(context, PLUGIN_VERIFICATION_IPC.copyFields, async () =>
    invoke(context, async (manager): Promise<PluginCopyResult> => {
      const text = manager.setupFieldsText();
      clipboard.writeText(text);
      return { copied: true, characters: text.length };
    }));
  secureHandle(context, PLUGIN_VERIFICATION_IPC.openChatGpt, async () =>
    invoke(context, async (manager): Promise<PluginOpenResult> => {
      await manager.openChatGpt();
      return { opened: true };
    }));
  secureHandle(context, PLUGIN_VERIFICATION_IPC.exportIcon, async () =>
    invoke(context, async (manager): Promise<PluginIconExportResult> => {
      const icon = await manager.downloadIcon();
      const result = await dialog.showSaveDialog({
        title: "Export SourceNerve plugin icon",
        defaultPath: `sourcenerve-plugin-icon${icon.extension}`,
        filters: [{ name: "Image", extensions: [icon.extension.slice(1)] }],
      });
      if (result.canceled || !result.filePath) return { saved: false, bytes: 0 };
      await writeFile(result.filePath, icon.bytes, { flag: "w", mode: 0o600 });
      return { saved: true, bytes: icon.bytes.length };
    }));
  secureHandle(context, PLUGIN_VERIFICATION_IPC.challengeSet, async (args) => {
    const input = args[0] as PluginDomainChallengeInput;
    return invokeChallenge(context, (manager) => manager.setChallenge(input.token));
  });
  secureHandle(context, PLUGIN_VERIFICATION_IPC.challengeVerify, async () =>
    invokeChallenge(context, (manager) => manager.verifyChallenge()));
  secureHandle(context, PLUGIN_VERIFICATION_IPC.challengeRemove, async () =>
    invokeChallenge(context, (manager) => manager.removeChallenge()));
}

function secureHandle(
  context: PluginVerificationIpcContext,
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
    const validation = validatePluginVerificationIpcInvocation(channel, args);
    if (validation) {
      return fail({ code: "invalid_request", message: validation, retryable: false });
    }
    return handler(args);
  });
}

async function invoke<T>(
  context: PluginVerificationIpcContext,
  operation: (manager: PluginVerificationManager) => Promise<T>,
): Promise<DesktopResult<T>> {
  const manager = context.manager();
  if (!manager) {
    return fail({
      code: "not_ready",
      message: "Plugin verification is not initialized",
      retryable: true,
    });
  }
  try {
    return ok(await operation(manager));
  } catch (error) {
    return fail(toDesktopError(error));
  }
}

async function invokeChallenge<T>(
  context: PluginVerificationIpcContext,
  operation: (manager: PluginVerificationManager) => Promise<T>,
): Promise<DesktopResult<T>> {
  const manager = context.manager();
  if (!manager) {
    return fail({
      code: "not_ready",
      message: "Plugin verification is not initialized",
      retryable: true,
    });
  }
  try {
    return ok(await operation(manager));
  } catch (error) {
    const raw = error instanceof Error ? error.message : "Domain challenge operation failed";
    const safe = sanitizeRuntimeText(raw, process.env.HOME);
    const message = /external daemon|Public MCP|managed daemon|launch plan|secure storage|challenge token must/i.test(safe)
      ? safe
      : "Domain challenge operation could not be completed.";
    return fail({ code: "service_error", message, retryable: true });
  }
}

function toDesktopError(error: unknown): DesktopError {
  const message = sanitizeRuntimeText(
    error instanceof Error ? error.message : "Plugin verification failed",
    process.env.HOME,
  );
  if (/not initialized|unavailable|does not define|not configured/i.test(message)) {
    return { code: "not_ready", message, retryable: true };
  }
  if (/invalid|must be|unsupported/i.test(message)) {
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
