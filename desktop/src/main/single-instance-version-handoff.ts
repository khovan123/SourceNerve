export const SOURCE_NERVE_SINGLE_INSTANCE_VERSION_KEY = "sourceNerveDesktopVersion";

export function sourceNerveSingleInstanceData(version: string): Record<string, string> {
  return { [SOURCE_NERVE_SINGLE_INSTANCE_VERSION_KEY]: version };
}

export function shouldRestartForNewerInstalledInstance(
  currentVersion: string,
  additionalData: unknown,
): boolean {
  if (!isRecord(additionalData)) return false;
  const requested = additionalData[SOURCE_NERVE_SINGLE_INSTANCE_VERSION_KEY];
  if (typeof requested !== "string") return false;

  const current = stableSemver(currentVersion);
  const next = stableSemver(requested);
  if (!current || !next) return false;

  for (let index = 0; index < 3; index += 1) {
    if (next[index] === current[index]) continue;
    return next[index] > current[index];
  }
  return false;
}

function stableSemver(value: string): readonly [number, number, number] | null {
  if (!/^\d+\.\d+\.\d+$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  if (parts.length !== 3 || !parts.every(Number.isSafeInteger)) return null;
  return [parts[0], parts[1], parts[2]];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
