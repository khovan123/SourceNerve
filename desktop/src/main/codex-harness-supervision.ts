export const CODEX_HARNESS_INTERNAL_RECOVERY_PREFIX = "[[SOURCENERVE_HARNESS_RECOVERY]]";

export function isCodexHarnessInternalRecoveryPrompt(value: string): boolean {
  return value.trimStart().startsWith(CODEX_HARNESS_INTERNAL_RECOVERY_PREFIX);
}
