import type { DesktopUpdateRelease } from "../shared/update-api";

export const SUPPORTED_PRODUCT_PROFILE_SCHEMA_VERSION = 1 as const;

interface RawUpdateInfo {
  version?: unknown;
  releaseDate?: unknown;
  releaseNotes?: unknown;
  sourcenerve?: unknown;
}

interface RawSourceNerveCompatibility {
  daemonVersion?: unknown;
  profileSchemaVersion?: unknown;
}

export function updateReleaseFromInfo(
  value: unknown,
  currentVersion: string,
): DesktopUpdateRelease {
  if (!isRecord(value)) throw new Error("update metadata must be an object");
  const info = value as RawUpdateInfo;
  if (typeof info.version !== "string" || !isStableSemver(info.version)) {
    throw new Error("update metadata contains an invalid stable Desktop version");
  }
  if (compareSemver(info.version, currentVersion) <= 0) {
    throw new Error("update metadata must target a newer Desktop version");
  }
  if (!isRecord(info.sourcenerve)) {
    throw new Error("update metadata is missing SourceNerve compatibility information");
  }
  const compatibility = info.sourcenerve as RawSourceNerveCompatibility;
  if (compatibility.daemonVersion !== info.version) {
    throw new Error("update metadata Desktop and daemon versions do not match");
  }
  if (compatibility.profileSchemaVersion !== SUPPORTED_PRODUCT_PROFILE_SCHEMA_VERSION) {
    throw new Error(
      `update requires unsupported product profile schema ${String(compatibility.profileSchemaVersion)}`,
    );
  }

  return {
    version: info.version,
    daemonVersion: info.version,
    profileSchemaVersion: SUPPORTED_PRODUCT_PROFILE_SCHEMA_VERSION,
    ...(typeof info.releaseDate === "string" ? { releaseDate: info.releaseDate } : {}),
    ...(releaseNotesText(info.releaseNotes) ? { releaseNotes: releaseNotesText(info.releaseNotes) } : {}),
  };
}

export function updaterChannelForArch(arch: string): string {
  if (!/^[a-z0-9_-]{2,32}$/i.test(arch)) throw new Error("invalid updater architecture");
  return `latest-${arch}`;
}

export function compareSemver(left: string, right: string): number {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function isStableSemver(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

function semverParts(value: string): [number, number, number] {
  if (!isStableSemver(value)) throw new Error(`invalid stable semantic version: ${value}`);
  const [major, minor, patch] = value.split(".").map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`invalid stable semantic version: ${value}`);
  }
  return [major, minor, patch];
}

function releaseNotesText(value: unknown): string | undefined {
  const raw = typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
        .map((entry) => (isRecord(entry) && typeof entry.note === "string" ? entry.note : ""))
        .filter(Boolean)
        .join("\n\n")
      : "";
  if (!raw) return undefined;

  const normalized = plainTextReleaseNotes(raw);
  return normalized ? bounded(normalized) : undefined;
}

function plainTextReleaseNotes(value: string): string {
  const withoutActiveContent = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  const withLayout = withoutActiveContent
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "• ")
    .replace(/<\s*\/\s*li\s*>/gi, "\n")
    .replace(/<\s*\/?\s*(?:h[1-6]|p|div|ul|ol|section|article|blockquote|pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(withLayout)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, decimal, hex, named) => {
    if (decimal || hex) {
      const codePoint = Number.parseInt(decimal ?? hex, decimal ? 10 : 16);
      if (
        Number.isSafeInteger(codePoint)
        && codePoint >= 0
        && codePoint <= 0x10ffff
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return String.fromCodePoint(codePoint);
      }
      return "";
    }

    const entities: Record<string, string> = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      nbsp: " ",
      quot: '"',
    };
    return entities[String(named).toLowerCase()] ?? match;
  });
}

function bounded(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, 16_384);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
