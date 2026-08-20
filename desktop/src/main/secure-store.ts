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
  records: Partial<Record<SecretName, string>>;
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

  constructor(directory: string, backend: EncryptionBackend) {
    this.filePath = path.join(directory, "secure-store.json");
    this.backend = backend;
  }

  storageBackend(): string {
    this.backend.assertAvailable();
    return this.backend.backendName();
  }

  async get(name: SecretName): Promise<string | null> {
    this.backend.assertAvailable();
    const file = await this.readFile();
    const encoded = file.records[name];
    if (!encoded) return null;
    return this.backend.decrypt(Buffer.from(encoded, "base64"));
  }

  async set(name: SecretName, value: string): Promise<void> {
    this.backend.assertAvailable();
    assertSecretValue(value);
    const file = await this.readFile();
    file.records[name] = this.backend.encrypt(value).toString("base64");
    await this.writeFile(file);
  }

  async delete(name: SecretName): Promise<void> {
    this.backend.assertAvailable();
    const file = await this.readFile();
    delete file.records[name];
    await this.writeFile(file);
  }

  async presence(): Promise<SecretPresence[]> {
    this.backend.assertAvailable();
    const file = await this.readFile();
    return SECRET_NAMES.map((name) => ({
      name,
      configured: Boolean(file.records[name]),
    }));
  }

  private async readFile(): Promise<SecretFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SecretFile>;
      if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object") {
        throw new Error("unsupported SourceNerve Desktop secure-store format");
      }
      return { version: 1, records: parsed.records };
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
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
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
