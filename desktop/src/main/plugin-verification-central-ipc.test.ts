import { describe, expect, it } from "vitest";

import { PLUGIN_VERIFICATION_IPC } from "../shared/plugin-verification-api";
import {
  DESKTOP_INBOUND_IPC_CHANNELS,
  validateDesktopIpcInvocation,
} from "./ipc-policy";

describe("plugin verification central IPC integration", () => {
  it("allowlists every semantic plugin operation without generic URL/path arguments", () => {
    for (const channel of Object.values(PLUGIN_VERIFICATION_IPC)) {
      expect(DESKTOP_INBOUND_IPC_CHANNELS).toContain(channel);
    }
    expect(validateDesktopIpcInvocation(PLUGIN_VERIFICATION_IPC.verify, [])).toBeNull();
    expect(validateDesktopIpcInvocation(PLUGIN_VERIFICATION_IPC.openChatGpt, [{ url: "https://evil.example" }])).toMatch(/does not accept arguments/);
    expect(validateDesktopIpcInvocation(PLUGIN_VERIFICATION_IPC.exportIcon, [{ path: "/tmp/icon.png" }])).toMatch(/does not accept arguments/);
    expect(validateDesktopIpcInvocation(PLUGIN_VERIFICATION_IPC.challengeSet, [{ token: "challenge-abc" }])).toBeNull();
    expect(validateDesktopIpcInvocation(PLUGIN_VERIFICATION_IPC.challengeSet, [{ token: "challenge-abc", command: "restart" }])).toMatch(/invalid/);
  });
});
