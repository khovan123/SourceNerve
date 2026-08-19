import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DesktopBootstrapState } from "./bootstrap";

const STATE_LOCATION_SCHEMA_VERSION = 1 as const;

interface StateLocationRecord {
  schemaVersion: typeof STATE_LOCATION_SCHEMA_VERSION;
  strategy: "desktop" | "reference" | "copy" | "move";
  path: string;
  sourcePath?: string;
}

export interface ManagedStateLocation {
  strategy: StateLocationRecord["strategy"];
  path: string;
  sourcePath?: string;
}

export function stateLocationPath(bootstrap: DesktopBootstrapState): string {
  return stateLocationPathFromManagedDirectory(bootstrap.paths.managedDirectory);
}

export function stateLocationPathFromManagedDirectory(managedDirectory: string): string {
  return path.join(managedDirectory, "state-location.json");
}

export async function resolveStateDirectoryFromManagedDirectory(
  managedDirectory: string,
  defaultStateDirectory: string,
): Promise<string> {
  const record = await readStateLocationFile(
    stateLocationPathFromManagedDirectory(managedDirectory),
  );
  return record?.path ?? defaultStateDirectory;
}

export async function resolveManagedStateDirectory(bootstrap: DesktopBootstrapState): Promise<string> {
  return resolveStateDirectoryFromManagedDirectory(
    bootstrap.paths.managedDirectory,
    bootstrap.paths.stateDirectory,
  );
}

export async function readManagedStateLocation(
  bootstrap: DesktopBootstrapState,
): Promise<ManagedStateLocation | null> {
  return readStateLocationFile(stateLocationPath(bootstrap));
}

export async function writeManagedStateLocation(
  bootstrap: DesktopBootstrapState,
  value: ManagedStateLocation,
): Promise<void> {
  await writeStateLocationFile(stateLocationPath(bootstrap), value);
  bootstrap.paths.stateDirectory = value.path;
}

export async function writeStateLocationFile(
  filePath: string,
  value: ManagedStateLocation,
): Promise<void> {
  if (!isStrategy(value.strategy) || !path.isAbsolute(value.path)) {
    throw new Error("invalid Desktop state location");
  }
  if (value.sourcePath !== undefined && !path.isAbsolute(value.sourcePath)) {
    throw new Error("invalid Desktop source state location");
  }
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  const payload: StateLocationRecord = {
    schemaVersion: STATE_LOCATION_SCHEMA_VERSION,
    strategy: value.strategy,
    path: value.path,
    ...(value.sourcePath ? { sourcePath: value.sourcePath } : {}),
  };
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

async function readStateLocationFile(filePath: string): Promise<ManagedStateLocation | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
      throw new Error("Desktop state-location registry exceeds 64 KB");
    }
    const parsed = JSON.parse(raw) as Partial<StateLocationRecord>;
    if (
      parsed.schemaVersion !== STATE_LOCATION_SCHEMA_VERSION ||
      !isStrategy(parsed.strategy) ||
      typeof parsed.path !== "string" ||
      !path.isAbsolute(parsed.path) ||
      (parsed.sourcePath !== undefined &&
        (typeof parsed.sourcePath !== "string" || !path.isAbsolute(parsed.sourcePath)))
    ) {
      throw new Error("unsupported Desktop state-location registry schema");
    }
    return {
      strategy: parsed.strategy,
      path: parsed.path,
      ...(parsed.sourcePath ? { sourcePath: parsed.sourcePath } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isStrategy(value: unknown): value is StateLocationRecord["strategy"] {
  return value === "desktop" || value === "reference" || value === "copy" || value === "move";
}
