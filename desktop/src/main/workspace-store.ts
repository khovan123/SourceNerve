import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ManagedWorkspace } from "./runtime-profile";

const REGISTRY_SCHEMA_VERSION = 1 as const;
const MAX_REGISTRY_BYTES = 1024 * 1024;

interface WorkspaceRegistryFile {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  workspaces: ManagedWorkspace[];
}

export async function loadWorkspaceRegistry(filePath: string): Promise<ManagedWorkspace[] | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_REGISTRY_BYTES) {
    throw new Error("Desktop workspace registry exceeds 1 MiB limit");
  }
  const parsed = JSON.parse(raw) as unknown;
  return validateRegistry(parsed).workspaces;
}

export async function saveWorkspaceRegistry(
  filePath: string,
  workspaces: ManagedWorkspace[],
): Promise<void> {
  const registry = validateRegistry({
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    workspaces,
  });
  const content = `${JSON.stringify(registry, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_REGISTRY_BYTES) {
    throw new Error("Desktop workspace registry exceeds 1 MiB limit");
  }

  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function validateRegistry(value: unknown): WorkspaceRegistryFile {
  if (!isRecord(value) || value.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(value.workspaces)) {
    throw new Error("Desktop workspace registry has invalid schema");
  }
  if (value.workspaces.length > 256) {
    throw new Error("Desktop workspace registry exceeds 256 workspace limit");
  }

  const ids = new Set<string>();
  const workspaces = value.workspaces.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Desktop workspace registry item is invalid");
    const allowed = new Set([
      "id",
      "name",
      "root",
      "access",
      "remote",
      "defaultBranch",
      "provider",
      "repository",
    ]);
    if (Object.keys(candidate).some((key) => !allowed.has(key))) {
      throw new Error("Desktop workspace registry item contains unknown fields");
    }
    if (!workspaceId(candidate.id)) throw new Error("Desktop workspace registry has invalid id");
    if (ids.has(candidate.id)) throw new Error(`duplicate workspace id: ${candidate.id}`);
    ids.add(candidate.id);
    if (!boundedText(candidate.name, 1, 128)) throw new Error(`invalid workspace name: ${candidate.id}`);
    if (!boundedText(candidate.root, 1, 4096) || !path.isAbsolute(candidate.root)) {
      throw new Error(`workspace root must be absolute: ${candidate.id}`);
    }
    if (candidate.access !== "read-only" && candidate.access !== "read-write") {
      throw new Error(`invalid workspace access: ${candidate.id}`);
    }
    if (!remoteName(candidate.remote)) throw new Error(`invalid workspace remote: ${candidate.id}`);
    if (!boundedText(candidate.defaultBranch, 1, 256) || candidate.defaultBranch.startsWith("-")) {
      throw new Error(`invalid workspace default branch: ${candidate.id}`);
    }
    if (candidate.provider !== undefined && candidate.provider !== "github" && candidate.provider !== "gitlab") {
      throw new Error(`invalid workspace provider: ${candidate.id}`);
    }
    if (candidate.repository !== undefined && !repositorySlug(candidate.repository)) {
      throw new Error(`invalid workspace repository: ${candidate.id}`);
    }
    if ((candidate.provider === undefined) !== (candidate.repository === undefined)) {
      throw new Error(`workspace provider/repository must be configured together: ${candidate.id}`);
    }
    return {
      id: candidate.id,
      name: candidate.name,
      root: candidate.root,
      access: candidate.access,
      remote: candidate.remote,
      defaultBranch: candidate.defaultBranch,
      ...(candidate.provider ? { provider: candidate.provider } : {}),
      ...(candidate.repository ? { repository: candidate.repository } : {}),
    } satisfies ManagedWorkspace;
  });

  return { schemaVersion: REGISTRY_SCHEMA_VERSION, workspaces };
}

function workspaceId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value);
}

function remoteName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  );
}

function repositorySlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 512 &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("..") &&
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(value)
  );
}

function boundedText(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= min &&
    value.length <= max &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
