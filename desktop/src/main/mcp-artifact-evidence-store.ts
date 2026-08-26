import type {
  McpExtensionView,
  McpMarketplaceArtifactVerificationView,
} from "../shared/mcp-extension-api";
import type { McpExtensionManager } from "./mcp-extension-manager";
import type { EncryptedSecretStore } from "./secure-store";

const VERIFICATION_PREFIX = "mcp-extension-verification:";
const MAX_EVIDENCE_BYTES = 32 * 1024;

export async function attachArtifactEvidence(
  manager: McpExtensionManager,
  extensions: McpExtensionView[],
): Promise<McpExtensionView[]> {
  return Promise.all(
    extensions.map(async (extension) => {
      const artifactVerification = await readArtifactEvidence(manager, extension.id, "current");
      return artifactVerification ? { ...extension, artifactVerification } : extension;
    }),
  );
}

export async function readArtifactEvidence(
  manager: McpExtensionManager,
  extensionId: string,
  slot: "current" | "backup",
): Promise<McpMarketplaceArtifactVerificationView | undefined> {
  const raw = await managerSecretStore(manager).getOpaque(verificationKey(extensionId, slot));
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

export async function writeArtifactEvidence(
  manager: McpExtensionManager,
  extensionId: string,
  slot: "current" | "backup",
  verification: McpMarketplaceArtifactVerificationView | undefined,
): Promise<void> {
  const store = managerSecretStore(manager);
  const key = verificationKey(extensionId, slot);
  if (!verification) {
    await store.deleteOpaque(key);
    return;
  }
  const encoded = JSON.stringify(parseVerification(verification));
  if (Buffer.byteLength(encoded, "utf8") > MAX_EVIDENCE_BYTES) {
    throw new Error("MCP artifact verification evidence exceeds the SourceNerve size limit");
  }
  await store.setOpaque(key, encoded);
}

export async function clearArtifactEvidence(
  manager: McpExtensionManager,
  extensionId: string,
): Promise<void> {
  const store = managerSecretStore(manager);
  await store.deleteOpaque(verificationKey(extensionId, "current")).catch(() => undefined);
  await store.deleteOpaque(verificationKey(extensionId, "backup")).catch(() => undefined);
}

function managerSecretStore(manager: McpExtensionManager): EncryptedSecretStore {
  const store = (manager as unknown as { secretStore?: EncryptedSecretStore }).secretStore;
  if (!store) {
    throw new Error("MCP artifact verification storage is unavailable in Desktop Main");
  }
  return store;
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
