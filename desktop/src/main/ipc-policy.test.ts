import { describe, expect, it } from "vitest";

import { DESKTOP_IPC, type ManagedWorkspaceInput } from "../shared/desktop-api";
import {
  DESKTOP_INBOUND_IPC_CHANNELS,
  validateDesktopIpcInvocation,
} from "./ipc-policy";

const WORKSPACE: ManagedWorkspaceInput = {
  id: "repo",
  name: "Repository",
  root: "/tmp/repository",
  access: "read-write",
  remote: "origin",
  defaultBranch: "main",
  provider: "github",
  repository: "owner/repo",
};

describe("Desktop IPC policy", () => {
  it("keeps runtime events outbound-only and rejects unknown channels", () => {
    expect(DESKTOP_INBOUND_IPC_CHANNELS).not.toContain(DESKTOP_IPC.runtimeEvent);
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.runtimeEvent, [])).toMatch(/outbound-only/);
    expect(validateDesktopIpcInvocation("desktop:run-shell", [])).toMatch(/not allowlisted/);
  });

  it("rejects payload smuggling on no-argument semantic operations", () => {
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.daemonStart, [])).toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.daemonStart, [{ command: "rm -rf /" }])).toMatch(
      /does not accept arguments/,
    );
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.workspacePickDirectory, ["/etc"])).toMatch(
      /does not accept arguments/,
    );
  });

  it("accepts only the bounded workspace payload schema", () => {
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.workspaceValidate, [WORKSPACE])).toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.workspaceSave, [WORKSPACE])).toBeNull();
    expect(
      validateDesktopIpcInvocation(DESKTOP_IPC.workspaceSave, [
        { ...WORKSPACE, command: "git clean -fdx" },
      ]),
    ).toMatch(/bounded Desktop workspace schema/);
    expect(
      validateDesktopIpcInvocation(DESKTOP_IPC.workspaceSave, [
        { ...WORKSPACE, access: "admin" },
      ]),
    ).not.toBeNull();
    expect(
      validateDesktopIpcInvocation(DESKTOP_IPC.workspaceSave, [
        { ...WORKSPACE, root: "x".repeat(4097) },
      ]),
    ).not.toBeNull();
  });

  it("bounds workspace mutation identifiers", () => {
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.workspaceIndex, ["repo-1"])).toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.workspaceRemove, ["../repo"])).not.toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.workspaceIndex, ["has spaces"])).not.toBeNull();
  });

  it("bounds cancellation identifiers", () => {
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.cancelOperation, ["index-123"])).toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.cancelOperation, [])).not.toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.cancelOperation, ["has spaces"])).not.toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.cancelOperation, ["x".repeat(129)])).not.toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.cancelOperation, [{ id: "index" }])).not.toBeNull();
  });
});
