import { PLUGIN_VERIFICATION_IPC } from "../shared/plugin-verification-api";

const NO_ARGUMENT_CHANNELS = new Set<string>([
  PLUGIN_VERIFICATION_IPC.state,
  PLUGIN_VERIFICATION_IPC.verify,
  PLUGIN_VERIFICATION_IPC.copyFields,
  PLUGIN_VERIFICATION_IPC.openChatGpt,
  PLUGIN_VERIFICATION_IPC.exportIcon,
  PLUGIN_VERIFICATION_IPC.challengeVerify,
  PLUGIN_VERIFICATION_IPC.challengeRemove,
]);

export const PLUGIN_VERIFICATION_INBOUND_IPC_CHANNELS = Object.freeze(
  Object.values(PLUGIN_VERIFICATION_IPC),
);

export function validatePluginVerificationIpcInvocation(
  channel: string,
  args: readonly unknown[],
): string | null {
  if (NO_ARGUMENT_CHANNELS.has(channel)) {
    return args.length === 0
      ? null
      : "plugin verification operation does not accept arguments";
  }
  if (channel === PLUGIN_VERIFICATION_IPC.challengeSet) {
    return args.length === 1 && isChallengeInput(args[0])
      ? null
      : "domain challenge input is invalid";
  }
  return "plugin verification IPC channel is not allowlisted";
}

export function isChallengeInput(value: unknown): value is { token: string } {
  if (!isRecord(value) || !exactKeys(value, ["token"])) return false;
  if (typeof value.token !== "string") return false;
  const bytes = Buffer.byteLength(value.token, "utf8");
  return bytes >= 1 && bytes <= 1_024 && /^[\x21-\x7e]+$/.test(value.token);
}

function exactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
