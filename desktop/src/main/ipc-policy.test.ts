import { describe, expect, it } from "vitest";

import { DESKTOP_IPC } from "../shared/desktop-api";
import {
  DESKTOP_INBOUND_IPC_CHANNELS,
  validateDesktopIpcInvocation,
} from "./ipc-policy";

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
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.listWorkspaces, ["https://evil.example"])).toMatch(
      /does not accept arguments/,
    );
  });

  it("bounds cancellation identifiers", () => {
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.cancelOperation, ["index-123"])).toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.cancelOperation, [])).not.toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.cancelOperation, ["has spaces"])).not.toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.cancelOperation, ["x".repeat(129)])).not.toBeNull();
    expect(validateDesktopIpcInvocation(DESKTOP_IPC.cancelOperation, [{ id: "index" }])).not.toBeNull();
  });
});
