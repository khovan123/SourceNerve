import type {
  McpExtensionView,
  McpMarketplaceArtifactVerificationView,
  McpMarketplaceInstallRequest,
  McpMarketplaceRollbackResult,
  McpMarketplaceUpdateResult,
} from "../shared/mcp-extension-api";
import { planGovernedMcpMarketplaceInstall } from "./mcp-enterprise-marketplace";
import {
  McpExtensionManager,
  type McpExtensionManagerOptions,
} from "./mcp-extension-manager";
import type { EncryptedSecretStore } from "./secure-store";

const VERIFICATION_PREFIX = "mcp-extension-verification:";
const MAX_EVIDENCE_BYTES = 32 * 1024;

export class McpVerifiedExtensionManager extends McpExtensionManager {
  private readonly verificationStore: EncryptedSecretStore;

  constructor(options: McpExtensionManagerOptions) {
    super(options);
    this.verificationStore = options.secretStore;
  }

  override async list(): Promise<McpExtensionView[]> {
    const extensions = await super.list();
    return Promise.all(
      extensions.map(async (extension) => {
        const artifactVerification = await this.readVerification(extension.id, "current");
        return artifactVerification ? { ...extension, artifactVerification } : extension;
      }),
    );
  }

  override async installMarketplace(
    request: McpMarketplaceInstallRequest,
  ): Promise<McpExtensionView> {
    const plan = await planGovernedMcpMarketplaceInstall(request.serverName);
    const installed = await super.installMarketplace(request);
    if (!plan.server.verification) return installed;
    try {
      await this.writeVerification(installed.id, "current", plan.server.verification);
    } catch (error) {
      await super.remove(installed.id).catch(() => undefined);
      throw error;
    }
    return this.requireVerifiedView(installed.id);
  }

  override async updateMarketplace(extensionId: string): Promise<McpMarketplaceUpdateResult> {
    const current = await this.requireVerifiedView(extensionId);
    const serverName = registryServerName(current.source);
    const plan = await planGovernedMcpMarketplaceInstall(serverName);
    const previousEvidence = current.artifactVerification;
    const result = await super.updateMarketplace(extensionId);
    if (
      result.rolledBack ||
      result.fromVersion === result.toVersion ||
      !plan.server.verification
    ) {
      return result;
    }

    try {
      await this.writeOptionalVerification(extensionId, "backup", previousEvidence);
      await this.writeVerification(extensionId, "current", plan.server.verification);
      return {
        ...result,
        message: `${result.message} SourceNerve retained the previous cryptographic provenance evidence with the rollback snapshot.`,
      };
    } catch (error) {
      await super.rollbackMarketplace(extensionId).catch(() => undefined);
      await this.writeOptionalVerification(extensionId, "current", previousEvidence).catch(
        () => undefined,
      );
      throw error;
    }
  }

  override async rollbackMarketplace(
    extensionId: string,
  ): Promise<McpMarketplaceRollbackResult> {
    const currentEvidence = await this.readVerification(extensionId, "current");
    const backupEvidence = await this.readVerification(extensionId, "backup");
    const result = await super.rollbackMarketplace(extensionId);
    try {
      await this.writeOptionalVerification(extensionId, "current", backupEvidence);
      await this.writeOptionalVerification(extensionId, "backup", currentEvidence);
      return {
        ...result,
        message: `${result.message} Cryptographic provenance evidence was restored with the selected version.`,
      };
    } catch (error) {
      await super.rollbackMarketplace(extensionId).catch(() => undefined);
      await this.writeOptionalVerification(extensionId, "current", currentEvidence).catch(
        () => undefined,
      );
      await this.writeOptionalVerification(extensionId, "backup", backupEvidence).catch(
        () => undefined,
      );
      throw error;
    }
  }

  override async remove(extensionId: string): Promise<{ removed: boolean }> {
    const result = await super.remove(extensionId);
    if (result.removed) {
      await this.verificationStore.deleteOpaque(verificationKey(extensionId, "current")).catch(
        () => undefined,
      );
      await this.verificationStore.deleteOpaque(verificationKey(extensionId, "backup")).catch(
        () => undefined,
      );
    }
    return result;
  }

  private async requireVerifiedView(extensionId: string): Promise<McpExtensionView> {
    const extension = (await this.list()).find((candidate) => candidate.id === extensionId);
    if (!extension) throw new Error(`MCP extension ${extensionId} is not registered`);
    return extension;
  }

  private async writeOptionalVerification(
    extensionId: string,
    slot: "current" | "backup",
    verification: McpMarketplaceArtifactVerificationView | undefined,
  ): Promise<void> {
    if (!verification) {
      await this.verificationStore.deleteOpaque(verificationKey(extensionId, slot));
      return;
    }
    await this.writeVerification(extensionId, slot, verification);
  }

  private async writeVerification(
    extensionId: string,
    slot: "current" | "backup",
    verification: McpMarketplaceArtifactVerificationView,
  ): Promise<void> {
    const validated = parseVerification(verification);
    const encoded = JSON.stringify(validated);
    if (Buffer.byteLength(encoded, "utf8") > MAX_EVIDENCE_BYTES) {
      throw new Error("MCP artifact verification evidence exceeds the SourceNerve size limit");
    }
    await this.verificationStore.setOpaque(verificationKey(extensionId, slot), encoded);
  }

  private async readVerification(
    extensionId: string,
    slot: "current" | "backup",
  ): Promise<McpMarketplaceArtifactVerificationView | undefined> {
    const raw = await this.verificationStore.getOpaque(verificationKey(extensionId, slot));
    if (!raw) return undefined;
    if (Buffer.byteLength(raw, "utf8") > MAX_EVIDENCE_BYTES) {
      throw new Error(`MCP extension ${extensionId} artifact verification evidence is oversized`);
    }
    try {
      return parseVerification(JSON.parse(raw) as unknown);
    } catch {
      throw new Error(`MCP extension ${extensionId} artifact verification evidence is invalid`);
    }
  }
}

function registryServerName(source: string): string {
  if (!source.startsWith("registry:")) {
    throw new Error("Only marketplace-backed MCP extensions support automatic update/rollback");
  }
  const value = source.slice("registry:".length);
  if (!/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("Installed MCP marketplace source is invalid");
  }
  return value;
}

function verificationKey(extensionId: string, slot: "current" | "backup"): string {
  if (!extensionId || extensionId.length > 64 || !/^[a-z0-9_-]+$/.test(extensionId)) {
    throw new Error("MCP extension id is invalid for artifact verification storage");
  }
  return `${VERIFICATION_PREFIX}${extensionId}:${slot}`;
}

function parseVerification(value: unknown): McpMarketplaceArtifactVerificationView {
  if (!isRecord(value)) throw new Error("verification evidence must be an object");
  const allowed = new Set(["status", "required", "digest", "signature", "notes"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("verification evidence contains unsupported fields");
  }
  if (!isArtifactStatus(value.status) || typeof value.required !== "boolean") {
    throw new Error("verification evidence status is invalid");
  }
  if (!isRecord(value.digest) || !isRecord(value.signature)) {
    throw new Error("verification digest/signature evidence is invalid");
  }
  const digestAllowed = new Set(["status", "algorithm", "source", "expected", "actual"]);
  if (Object.keys(value.digest).some((key) => !digestAllowed.has(key))) {
    throw new Error("verification digest contains unsupported fields");
  }
  const signatureAllowed = new Set(["status", "algorithm", "publisher", "keyId"]);
  if (Object.keys(value.signature).some((key) => !signatureAllowed.has(key))) {
    throw new Error("verification signature contains unsupported fields");
  }
  if (!isDigestStatus(value.digest.status) || !isSignatureStatus(value.signature.status)) {
    throw new Error("verification digest/signature status is invalid");
  }
  if (value.digest.algorithm !== undefined && !isDigestAlgorithm(value.digest.algorithm)) {
    throw new Error("verification digest algorithm is invalid");
  }
  if (
    value.digest.source !== undefined &&
    value.digest.source !== "npm-registry" &&
    value.digest.source !== "catalog"
  ) {
    throw new Error("verification digest source is invalid");
  }
  if (value.signature.algorithm !== undefined && value.signature.algorithm !== "ed25519") {
    throw new Error("verification signature algorithm is invalid");
  }
  const expected = optionalText(value.digest.expected, 512);
  const actual = optionalText(value.digest.actual, 512);
  const publisher = optionalText(value.signature.publisher, 160);
  const keyId = optionalText(value.signature.keyId, 160);
  if (value.digest.expected !== undefined && !expected) throw new Error("verification expected digest is invalid");
  if (value.digest.actual !== undefined && !actual) throw new Error("verification actual digest is invalid");
  if (value.signature.publisher !== undefined && !publisher) throw new Error("verification publisher is invalid");
  if (value.signature.keyId !== undefined && !keyId) throw new Error("verification key id is invalid");
  if (!Array.isArray(value.notes) || value.notes.length > 16) {
    throw new Error("verification notes are invalid");
  }
  const notes = value.notes.map((note) => {
    const parsed = optionalText(note, 512);
    if (!parsed) throw new Error("verification note is invalid");
    return parsed;
  });
  return {
    status: value.status,
    required: value.required,
    digest: {
      status: value.digest.status,
      ...(value.digest.algorithm ? { algorithm: value.digest.algorithm } : {}),
      ...(value.digest.source ? { source: value.digest.source } : {}),
      ...(expected ? { expected } : {}),
      ...(actual ? { actual } : {}),
    },
    signature: {
      status: value.signature.status,
      ...(value.signature.algorithm ? { algorithm: value.signature.algorithm } : {}),
      ...(publisher ? { publisher } : {}),
      ...(keyId ? { keyId } : {}),
    },
    notes,
  };
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return undefined;
  }
  return value;
}

function isArtifactStatus(value: unknown): value is McpMarketplaceArtifactVerificationView["status"] {
  return value === "verified" || value === "unverified" || value === "unsupported" || value === "failed";
}

function isDigestStatus(
  value: unknown,
): value is McpMarketplaceArtifactVerificationView["digest"]["status"] {
  return value === "verified" || value === "unverified" || value === "unsupported" || value === "mismatch";
}

function isSignatureStatus(
  value: unknown,
): value is McpMarketplaceArtifactVerificationView["signature"]["status"] {
  return (
    value === "verified" ||
    value === "not-provided" ||
    value === "unsupported" ||
    value === "untrusted" ||
    value === "invalid"
  );
}

function isDigestAlgorithm(
  value: unknown,
): value is NonNullable<McpMarketplaceArtifactVerificationView["digest"]["algorithm"]> {
  return value === "sha256" || value === "sha384" || value === "sha512";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
