import { describe, expect, it } from "vitest";

import { DESKTOP_IPC } from "../shared/desktop-api";
import {
  DESKTOP_INBOUND_IPC_CHANNELS,
  validateDesktopIpcInvocation,
} from "./ipc-policy";

describe("Desktop IPC policy", () => {
  it("keeps runtime event streams outbound-only and rejects unknown channels", () => {
    expect(DESKTOP_INBOUND_IPC_CHANNELS).not.toContain(DESKTOP_IPC.runtimeEvent);
    expect(DESKTOP_INBOUND_IPC_CHANNELS).not.toContain(DESKTOP_IPC.runtimeLogEvent);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.runtimeEvent, [])).toMatch(/outbound-only/);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.runtimeLogEvent, [])).toMatch(/outbound-only/);
    expect(validateDesktopIpcInvocation("desktop:run-shell", [])).toMatch(/not allowlisted/);
  });

  it("rejects payload smuggling on no-argument semantic operations", () => {
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.daemonStart, [])).toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.daemonStart, [{ command: "arbitrary-command" }])).toMatch(/does not accept arguments/);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.listWorkspaces, ["https://evil.example"])).toMatch(/does not accept arguments/);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.workspacePickRepository, ["/tmp"])).toMatch(/does not accept arguments/);
    for (const channel of [
      DESKTOP_IPC.auth0State,
      DESKTOP_IPC.auth0SignIn,
      DESKTOP_IPC.auth0Refresh,
      DESKTOP_IPC.auth0Logout,
      DESKTOP_IPC.providerStates,
      DESKTOP_IPC.publicMcpState,
      DESKTOP_IPC.publicMcpEnroll,
      DESKTOP_IPC.publicMcpRetry,
      DESKTOP_IPC.publicMcpRotate,
      DESKTOP_IPC.publicMcpRevoke,
      DESKTOP_IPC.publicMcpReEnroll,
      DESKTOP_IPC.runtimeLogs,
      DESKTOP_IPC.diagnosticsCopy,
      DESKTOP_IPC.supportBundlePreview,
      DESKTOP_IPC.recoveryState,
      DESKTOP_IPC.recoveryBackupCreateValidate,
      DESKTOP_IPC.recoveryBackupValidateLatest,
      DESKTOP_IPC.recoveryOpenStateDirectory,
      DESKTOP_IPC.recoveryOpenLogsDirectory,
      DESKTOP_IPC.recoveryResetUiSettings,
      DESKTOP_IPC.recoveryReadiness,
      DESKTOP_IPC.desktopBehavior,
      DESKTOP_IPC.legacyImportPick,
    ]) {
      expect(validateDesktopIpcInvocation(channel, [])).toBeNull();
      expect(
        validateDesktopIpcInvocation(channel, [{
          token: "do-not-accept",
          hostname: "evil.example",
          tunnelId: "attacker-controlled",
          url: "https://evil.example",
          path: "/tmp/attacker-controlled",
          command: "arbitrary-command",
          query: "secret",
        }]),
      ).toMatch(/does not accept arguments/);
    }
  });

  it("accepts only a one-shot preview ID and fixed export format for support bundles", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.supportBundleExport, [id, "text"])).toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.supportBundleExport, [id, "zip"])).toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.supportBundleExport, [id, "zip", { path: "/tmp/leak" }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.supportBundleExport, [id, "html"])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.supportBundleExport, ["not-a-selection", "text"])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.supportBundleExport, [{ selectionId: id, token: "secret" }, "text"])).toMatch(/invalid/);
  });

  it("accepts only a one-shot selection and fixed state strategy for legacy import", () => {
    const valid = {
      selectionId: "123e4567-e89b-42d3-a456-426614174000",
      stateStrategy: "copy",
    };
    for (const stateStrategy of ["copy", "move", "reference", "fresh"]) {
      expect(validateDesktopIpcInvocation(DESKTOP_IPC.legacyImportApply, [{ ...valid, stateStrategy }])).toBeNull();
    }
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.legacyImportApply, [{ ...valid, path: "/tmp/legacy" }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.legacyImportApply, [{ ...valid, stateStrategy: "delete" }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.legacyImportApply, [{ ...valid, selectionId: "not-a-selection" }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.legacyImportApply, [])).toMatch(/invalid/);
  });

  it("accepts only the bounded Desktop background preference shape", () => {
    const valid = {
      backgroundMode: true,
      closeBehavior: "tray",
      launchAtLogin: true,
      notificationsEnabled: true,
    };
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.desktopBehaviorUpdate, [valid])).toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.desktopBehaviorUpdate, [{ ...valid, command: "shutdown" }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.desktopBehaviorUpdate, [{ ...valid, closeBehavior: "shell" }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.desktopBehaviorUpdate, [{ ...valid, backgroundMode: false }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.desktopBehaviorUpdate, [])).toMatch(/invalid/);
  });

  it("allows bounded semantic workspace saves but never renderer-supplied roots", () => {
    const valid = {
      selectionId: "123e4567-e89b-42d3-a456-426614174000",
      id: "my-api",
      name: "My API",
      access: "read-write",
      remote: "origin",
      defaultBranch: "main",
    };
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.workspaceSave, [valid])).toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.workspaceSave, [{ ...valid, root: "/tmp" }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.workspaceSave, [{ ...valid, access: "admin" }])).toMatch(/invalid/);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.workspaceSave, [{ ...valid, defaultBranch: "-danger" }])).toMatch(/invalid/);
  });

  it("bounds workspace mutation identifiers", () => {
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.workspaceRemove, ["api_1"])).toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.providerValidateTransport, ["api_1"])).toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.workspaceRemove, ["../repo"])).not.toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.providerValidateTransport, ["/tmp"])).not.toBeNull();
  });

  it("accepts only fixed providers and bounded repository slugs", () => {
    for (const channel of [
      DESKTOP_IPC.providerConnect,
      DESKTOP_IPC.providerDisconnect,
      DESKTOP_IPC.providerRepositories,
    ]) {
      expect(validateDesktopIpcInvocation(channel, ["github"])).toBeNull();
      expect(validateDesktopIpcInvocation(channel, ["gitlab"])).toBeNull();
      expect(validateDesktopIpcInvocation(channel, ["https://evil.example"])).not.toBeNull();
      expect(validateDesktopIpcInvocation(channel, ["github", { token: "x" }])).not.toBeNull();
    }
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.providerValidateRepository, ["github", "openai/example"])).toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.providerValidateRepository, ["gitlab", "group/sub/repo"])).toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.providerValidateRepository, ["github", "../etc"])).not.toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.providerValidateRepository, ["github", "openai/example", "token"])).not.toBeNull();
  });

  it("bounds cancellation identifiers", () => {
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.cancelOperation, ["task-123"])).toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.cancelOperation, [])).not.toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.cancelOperation, ["has spaces"])).not.toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.cancelOperation, ["x".repeat(129)])).not.toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.cancelOperation, [{ id: "task" }])).not.toBeNull();
  });
});
