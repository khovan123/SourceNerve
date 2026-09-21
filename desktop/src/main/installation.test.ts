import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    return Buffer.from(`encrypted:${value}`, "utf8");
  }
  decrypt(value: Buffer): string {
    const decoded = value.toString("utf8");
    if (!decoded.startsWith("encrypted:")) {
      throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
    }
    return decoded.slice("encrypted:".length);
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

  it("recovers an undecryptable local bearer without disturbing unrelated secure-store records", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-install-"));
    temporaryDirectories.push(directory);
    const secureDirectory = path.join(directory, "secure");
    await mkdir(secureDirectory, { recursive: true });
    const githubToken = "github-token-value-that-must-remain-untouched";
    const staleLocalBearer = Buffer.from("stale-ciphertext", "utf8").toString("base64");
    const githubCiphertext = Buffer.from(`encrypted:${githubToken}`, "utf8").toString("base64");
    await writeFile(
      path.join(secureDirectory, "secure-store.json"),
      `${JSON.stringify({
        version: 1,
        records: {
          localBearer: staleLocalBearer,
          githubToken: githubCiphertext,
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const store = new EncryptedSecretStore(
      secureDirectory,
      new FakeEncryptionBackend(),
    );

    const identity = await ensureInstallationIdentity(
      path.join(directory, "managed"),
      store,
    );

    expect(Buffer.from(identity.localBearer, "base64url")).toHaveLength(32);
    expect(await store.get("localBearer")).toBe(identity.localBearer);
    expect(await store.get("githubToken")).toBe(githubToken);

    const persisted = JSON.parse(
      await readFile(path.join(secureDirectory, "secure-store.json"), "utf8"),
    ) as { records: Record<string, string> };
    expect(persisted.records.localBearer).not.toBe(staleLocalBearer);
    expect(persisted.records.githubToken).toBe(githubCiphertext);
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
