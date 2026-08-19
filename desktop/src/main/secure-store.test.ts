import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
    if (!decoded.startsWith("encrypted:")) throw new Error("invalid fake ciphertext");
    return decoded.slice("encrypted:".length);
  }

  backendName(): string {
    return "test-keychain";
  }
}

describe("EncryptedSecretStore", () => {
  it("persists encrypted records without plaintext token values", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-secrets-"));
    temporaryDirectories.push(directory);
    const store = new EncryptedSecretStore(directory, new FakeEncryptionBackend());

    const secret = "very-sensitive-desktop-secret-value";
    await store.set("localBearer", secret);

    expect(await store.get("localBearer")).toBe(secret);
    const raw = await readFile(path.join(directory, "secure-store.json"), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("encrypted:very-sensitive");
    expect(store.storageBackend()).toBe("test-keychain");
  });

  it("returns presence without exposing secret values", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-secrets-"));
    temporaryDirectories.push(directory);
    const store = new EncryptedSecretStore(directory, new FakeEncryptionBackend());
    await store.set("auth0AccessToken", "auth0-access-token-for-test-only");

    const presence = await store.presence();
    expect(presence.find((item) => item.name === "auth0AccessToken")?.configured).toBe(true);
    expect(JSON.stringify(presence)).not.toContain("auth0-access-token-for-test-only");
  });

  it("removes one secret without disturbing other records", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-secrets-"));
    temporaryDirectories.push(directory);
    const store = new EncryptedSecretStore(directory, new FakeEncryptionBackend());
    await store.set("localBearer", "local-bearer-value-that-is-long-enough");
    await store.set("githubToken", "github-token-value-that-is-long-enough");

    await store.delete("githubToken");

    expect(await store.get("githubToken")).toBeNull();
    expect(await store.get("localBearer")).toBe("local-bearer-value-that-is-long-enough");
  });
});
