import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EncryptedSecretStore } from "./secure-store";

interface InstallationFile {
  version: 1;
  installationId: string;
}

export interface InstallationIdentity {
  installationId: string;
  localBearer: string;
}

export async function ensureInstallationIdentity(
  directory: string,
  secrets: EncryptedSecretStore,
): Promise<InstallationIdentity> {
  secrets.storageBackend();
  const installationId = await ensureInstallationId(directory);
  let localBearer = await secrets.get("localBearer");
  if (!localBearer) {
    localBearer = randomBytes(32).toString("base64url");
    await secrets.set("localBearer", localBearer);
  }
  if (localBearer.length < 32) {
    throw new Error("stored SourceNerve local bearer is invalid");
  }
  return { installationId, localBearer };
}

export async function rotateLocalBearer(
  secrets: EncryptedSecretStore,
): Promise<string> {
  const bearer = randomBytes(32).toString("base64url");
  await secrets.set("localBearer", bearer);
  return bearer;
}

async function ensureInstallationId(directory: string): Promise<string> {
  const filePath = path.join(directory, "installation.json");
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<InstallationFile>;
    if (
      parsed.version !== 1 ||
      typeof parsed.installationId !== "string" ||
      !validInstallationId(parsed.installationId)
    ) {
      throw new Error("invalid SourceNerve Desktop installation identity file");
    }
    return parsed.installationId;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const installationId = `install_${randomBytes(24).toString("base64url")}`;
  const file: InstallationFile = { version: 1, installationId };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
  return installationId;
}

export function validInstallationId(value: string): boolean {
  return (
    value.length >= 16 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
