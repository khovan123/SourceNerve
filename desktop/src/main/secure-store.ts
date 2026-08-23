import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const SECRET_NAMES = [
  "localBearer",
  "auth0AccessToken",
  "auth0RefreshToken",
  "githubToken",
  "gitlabToken",
  "cloudflareTunnelToken",
  "pluginChallengeToken",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

interface SecretFile {
  version: 1;
  records: Record<string, string>;
}

export interface EncryptionBackend {
  assertAvailable(): void;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
  backendName(): string;
}

export interface SecretPresence {
  name: SecretName;
  configured: boolean;
}

export class EncryptedSecretStore {
  private readonly filePath: string;
  private readonly backend: EncryptionBackend;
  private mutationQueue: Promise<void> = Promise.resolve();
  private writeSequence = 0;

  constructor(directory: string, backend: EncryptionBackend) {
    this.filePath = path.join(directory, "secure-store.json");
    this.backend = backend;
  }

  storageBackend(): string {
    this.backend.assertAvailable();
    return this.backend.backendName();
  }

  async get(name: SecretName): Promise<string | null> {
    return this.getOpaque(name);
  }

  async set(name: SecretName, value: string): Promise<void> {
    return this.setOpaque(name, value);
  }

  async delete(name: SecretName): Promise<void> {
    return this.deleteOpaque(name);
  }

  async getOpaque(key: string): Promise<string | null> {
    this.backend.assertAvailable();
    assertSecretKey(key);
    await this.mutationQueue;
    const file = await this.readFile();
    const encoded = file.records[key];
    if (!encoded) return null;
    return this.backend.decrypt(Buffer.from(encoded, "base64"));
  }

  async setOpaque(key: string, value: string): Promise<void> {
    this.backend.assertAvailable();
    assertSecretKey(key);
    assertSecretValue(value);
    return this.enqueueMutation(async () => {
      const file = await this.readFile();
      file.records[key] = this.backend.encrypt(value).toString("base64");
      await this.writeFile(file);
    });
  }

  async deleteOpaque(key: string): Promise<void> {
    this.backend.assertAvailable();
    assertSecretKey(key);
    return this.enqueueMutation(async () => {
      const file = await this.readFile();
      delete file.records[key];
      await this.writeFile(file);
    });
  }

  async hasOpaque(key: string): Promise<boolean> {
    this.backend.assertAvailable();
    assertSecretKey(key);
    await this.mutationQueue;
    const file = await this.readFile();
    return Boolean(file.records[key]);
  }

  async presence(): Promise<SecretPresence[]> {
    this.backend.assertAvailable();
    await this.mutationQueue;
    const file = await this.readFile();
    return SECRET_NAMES.map((name) => ({
      name,
      configured: Boolean(file.records[name]),
    }));
  }

  private enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const run = this.mutationQueue.then(operation);
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  private async readFile(): Promise<SecretFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SecretFile>;
      if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object") {
        throw new Error("unsupported SourceNerve Desktop secure-store format");
      }
      const records: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.records)) {
        if (typeof value !== "string") {
          throw new Error("SourceNerve Desktop secure-store contains an invalid record");
        }
        assertSecretKey(key);
        records[key] = value;
      }
      return { version: 1, records };
    } catch (error) {
      if (isMissingFile(error)) {
        return { version: 1, records: {} };
      }
      throw error;
    }
  }

  private async writeFile(file: SecretFile): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}-${++this.writeSequence}`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }
}

function assertSecretKey(key: string): void {
  if (
    !key ||
    key.length > 256 ||
    !/^[A-Za-z0-9._:-]+$/.test(key)
  ) {
    throw new Error("secret key must be 1-256 safe ASCII characters");
  }
}

function assertSecretValue(value: string): void {
  if (!value || value.length > 32 * 1024 || value.includes("\0")) {
    throw new Error("secret value must be 1-32768 bytes without NUL");
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
