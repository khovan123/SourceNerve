import { describe, expect, it } from "vitest";

import { PLUGIN_VERIFICATION_IPC } from "../shared/plugin-verification-api";
import { validatePluginVerificationIpcInvocation } from "./plugin-verification-policy";

describe("plugin verification IPC policy", () => {
  it("keeps verification/export/open/remove operations zero-argument", () => {
    for (const channel of [
      PLUGIN_VERIFICATION_IPC.state,
      PLUGIN_VERIFICATION_IPC.verify,
      PLUGIN_VERIFICATION_IPC.copyFields,
      PLUGIN_VERIFICATION_IPC.openChatGpt,
      PLUGIN_VERIFICATION_IPC.exportIcon,
      PLUGIN_VERIFICATION_IPC.challengeVerify,
      PLUGIN_VERIFICATION_IPC.challengeRemove,
    ]) {
      expect(validatePluginVerificationIpcInvocation(channel, [])).toBeNull();
      expect(validatePluginVerificationIpcInvocation(channel, [{
        url: "https://evil.example",
        path: "/tmp/evil",
        command: "curl",
        token: "smuggled",
      }])).toMatch(/does not accept arguments/);
    }
  });

  it("accepts only one bounded one-time domain challenge token field", () => {
    expect(validatePluginVerificationIpcInvocation(
      PLUGIN_VERIFICATION_IPC.challengeSet,
      [{ token: "challenge-abc_123.XYZ" }],
    )).toBeNull();
    expect(validatePluginVerificationIpcInvocation(
      PLUGIN_VERIFICATION_IPC.challengeSet,
      [{ token: "contains space" }],
    )).toMatch(/invalid/);
    expect(validatePluginVerificationIpcInvocation(
      PLUGIN_VERIFICATION_IPC.challengeSet,
      [{ token: "challenge", url: "https://evil.example" }],
    )).toMatch(/invalid/);
    expect(validatePluginVerificationIpcInvocation(
      PLUGIN_VERIFICATION_IPC.challengeSet,
      [{ token: "x".repeat(1_025) }],
    )).toMatch(/invalid/);
  });
});
