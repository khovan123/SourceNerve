import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureInstallationIdentity,
  rotateLocalBearer,
  validInstallationId,
} from "./installation";
import {
  EncryptedSecretStore,
  type EncryptionBackend,
} from "./secure-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

class FakeEncryptionBackend implements EncryptionBackend {
  assertAvailable(): void {}
  encrypt(value: string): Buffer {
    return Buffer.from(value, "utf8");
  }
  decrypt(value: Buffer): string {
    return value.toString("utf8");
  }
  backendName(): string {
    return "test";
  }
}

describe("Desktop installation identity", () => {
  it("creates stable installation identity and per-install bearer", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-install-"));
    temporaryDirectories.push(directory);
    const store = new EncryptedSecretStore(
      path.join(directory, "secure"),
      new FakeEncryptionBackend(),
    );

    const first = await ensureInstallationIdentity(path.join(directory, "managed"), store);
    const second = await ensureInstallationIdentity(path.join(directory, "managed"), store);

    expect(first).toEqual(second);
    expect(validInstallationId(first.installationId)).toBe(true);
    expect(Buffer.from(first.localBearer, "base64url")).toHaveLength(32);
  });

  it("rotates the local bearer without changing installation identity", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-install-"));
    temporaryDirectories.push(directory);
    const store = new EncryptedSecretStore(
      path.join(directory, "secure"),
      new FakeEncryptionBackend(),
    );
    const identity = await ensureInstallationIdentity(path.join(directory, "managed"), store);

    const rotated = await rotateLocalBearer(store);
    const after = await ensureInstallationIdentity(path.join(directory, "managed"), store);

    expect(rotated).not.toBe(identity.localBearer);
    expect(after.installationId).toBe(identity.installationId);
    expect(after.localBearer).toBe(rotated);
    expect(Buffer.from(rotated, "base64url")).toHaveLength(32);
  });
});
