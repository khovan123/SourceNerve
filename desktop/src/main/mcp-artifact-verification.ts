import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

import type {
  McpMarketplaceArtifactVerificationView,
  McpMarketplaceInstallKind,
} from "../shared/mcp-extension-api";

const TRUST_ROOTS_ENV = "SOURCENERVE_MCP_PUBLISHER_TRUST_ROOTS";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_TRUST_ROOTS_BYTES = 64 * 1024;
const MAX_TRUST_ROOTS = 64;
const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";

export interface McpPublisherSignatureDeclaration {
  algorithm: "ed25519";
  publisher: string;
  keyId: string;
  value: string;
  required?: boolean;
}

export interface McpArtifactVerificationRequest {
  registryName: string;
  version: string;
  installKind: McpMarketplaceInstallKind;
  packageIdentifier?: string;
  signature?: McpPublisherSignatureDeclaration;
  signatureRequired?: boolean;
}

interface PublisherTrustRoot {
  keyId: string;
  publisher: string;
  registryNames: string[];
  publicKeySpki: string;
}

interface NpmArtifactEvidence {
  algorithm: "sha256" | "sha384" | "sha512";
  expectedDigest: Buffer;
  actualDigest: Buffer;
}

export function previewMcpArtifactVerification(
  installKind: McpMarketplaceInstallKind,
  signature?: McpPublisherSignatureDeclaration,
): McpMarketplaceArtifactVerificationView {
  if (installKind !== "npm") {
    return unsupportedVerification(
      installKind === "pypi"
        ? "PyPI artifact selection is platform-dependent; SourceNerve does not yet claim package-byte verification for this install path."
        : "This transport does not expose a package artifact that SourceNerve can cryptographically verify before activation.",
    );
  }
  return {
    status: "unverified",
    required: true,
    digest: { status: "unverified", source: "npm-registry" },
    signature: signature
      ? {
          status: "untrusted",
          algorithm: "ed25519",
          publisher: signature.publisher,
          keyId: signature.keyId,
        }
      : { status: "not-provided" },
    notes: [
      "SourceNerve will fetch the exact npm version metadata and tarball during install review, then verify the registry-declared integrity digest before activation.",
      "Publisher signatures are independent evidence and are accepted only against explicitly configured SourceNerve trust roots.",
    ],
  };
}

export async function verifyMcpMarketplaceArtifact(
  request: McpArtifactVerificationRequest,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<McpMarketplaceArtifactVerificationView> {
  if (request.installKind !== "npm" || !request.packageIdentifier) {
    const unsupported = unsupportedVerification(
      "Artifact verification is currently supported for exact npm package versions; this install path is reported separately as unsupported rather than treated as trusted.",
    );
    if (request.signatureRequired) {
      return {
        ...unsupported,
        status: "failed",
        required: true,
        notes: [
          ...unsupported.notes,
          "A publisher signature is required, but this artifact path cannot establish the package digest that the signature must bind.",
        ],
      };
    }
    return unsupported;
  }

  validateRegistryName(request.registryName);
  validatePackageIdentifier(request.packageIdentifier);
  validateVersion(request.version);

  let digestEvidence: NpmArtifactEvidence;
  try {
    digestEvidence = await verifyNpmArtifact(request.packageIdentifier, request.version);
  } catch (error) {
    const message = safeMessage(error);
    return {
      status: "failed",
      required: true,
      digest: {
        status: /mismatch/i.test(message) ? "mismatch" : "unverified",
        source: "npm-registry",
      },
      signature: request.signature
        ? {
            status: "untrusted",
            algorithm: "ed25519",
            publisher: request.signature.publisher,
            keyId: request.signature.keyId,
          }
        : { status: "not-provided" },
      notes: [`npm artifact verification failed: ${message}`],
    };
  }

  const algorithm = digestEvidence.algorithm;
  const expected = digestEvidence.expectedDigest.toString("base64");
  const actual = digestEvidence.actualDigest.toString("base64");
  const digest = {
    status: "verified" as const,
    algorithm,
    source: "npm-registry" as const,
    expected: `${algorithm}-${expected}`,
    actual: `${algorithm}-${actual}`,
  };

  if (!request.signature) {
    if (request.signatureRequired) {
      return {
        status: "failed",
        required: true,
        digest,
        signature: { status: "not-provided" },
        notes: [
          "The npm registry integrity digest matched the downloaded artifact.",
          "Organization/catalog policy requires publisher signature evidence, but no signature was declared for this artifact.",
        ],
      };
    }
    return {
      status: "verified",
      required: true,
      digest,
      signature: { status: "not-provided" },
      notes: [
        "The npm registry integrity digest matched the downloaded artifact.",
        "No publisher signature was declared. Digest verification and publisher identity are intentionally reported as separate evidence.",
      ],
    };
  }

  const signature = request.signature;
  const roots = loadPublisherTrustRoots(environment);
  const root = roots.find(
    (candidate) =>
      candidate.keyId === signature.keyId &&
      candidate.publisher === signature.publisher &&
      candidate.registryNames.some((pattern) => wildcardMatch(request.registryName, pattern)),
  );
  if (!root) {
    return {
      status: signature.required || request.signatureRequired ? "failed" : "verified",
      required: true,
      digest,
      signature: {
        status: "untrusted",
        algorithm: "ed25519",
        publisher: signature.publisher,
        keyId: signature.keyId,
      },
      notes: [
        "The npm registry integrity digest matched the downloaded artifact.",
        "A publisher signature was declared, but no reviewed SourceNerve trust root binds this key, publisher and registry identity.",
      ],
    };
  }

  let signatureBytes: Buffer;
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    signatureBytes = strictBase64(signature.value, 128, "publisher signature");
    const keyBytes = strictBase64(root.publicKeySpki, 1024, "publisher trust root");
    publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  } catch (error) {
    return {
      status: "failed",
      required: true,
      digest,
      signature: {
        status: "invalid",
        algorithm: "ed25519",
        publisher: signature.publisher,
        keyId: signature.keyId,
      },
      notes: [
        "The npm registry integrity digest matched the downloaded artifact.",
        `Publisher signature material is invalid: ${safeMessage(error)}`,
      ],
    };
  }

  const payload = artifactSignaturePayload({
    registryName: request.registryName,
    version: request.version,
    algorithm,
    digest: expected,
  });
  const valid = verifySignature(null, Buffer.from(payload, "utf8"), publicKey, signatureBytes);
  if (!valid) {
    return {
      status: "failed",
      required: true,
      digest,
      signature: {
        status: "invalid",
        algorithm: "ed25519",
        publisher: signature.publisher,
        keyId: signature.keyId,
      },
      notes: [
        "The npm registry integrity digest matched the downloaded artifact.",
        "The declared publisher signature did not verify against the reviewed SourceNerve trust root.",
      ],
    };
  }

  return {
    status: "verified",
    required: true,
    digest,
    signature: {
      status: "verified",
      algorithm: "ed25519",
      publisher: signature.publisher,
      keyId: signature.keyId,
    },
    notes: [
      "The npm registry integrity digest matched the downloaded artifact.",
      "The publisher signature verified against a reviewed SourceNerve trust root for this registry identity.",
      "Signature verification is provenance evidence only; SourceNerve policy and runtime isolation still determine whether the extension is allowed to run.",
    ],
  };
}

export function artifactVerificationBlockers(
  verification: McpMarketplaceArtifactVerificationView,
): string[] {
  if (verification.status === "failed") {
    return verification.notes.map((note) => `Artifact verification: ${note}`);
  }
  if (verification.required && verification.status !== "verified") {
    return ["Artifact verification is required before this extension can be activated."];
  }
  return [];
}

export function artifactSignaturePayload(input: {
  registryName: string;
  version: string;
  algorithm: "sha256" | "sha384" | "sha512";
  digest: string;
}): string {
  return [
    "SourceNerve MCP artifact signature v1",
    `registry=${input.registryName}`,
    `version=${input.version}`,
    `digest=${input.algorithm}-${input.digest}`,
  ].join("\n");
}

export function parsePublisherSignatureDeclaration(
  value: unknown,
): McpPublisherSignatureDeclaration | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("MCP artifact publisher signature metadata is invalid");
  const allowed = new Set(["algorithm", "publisher", "keyId", "value", "required"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("MCP artifact publisher signature metadata contains unsupported fields");
  }
  if (value.algorithm !== "ed25519") {
    throw new Error("MCP artifact publisher signature algorithm is unsupported");
  }
  const publisher = boundedText(value.publisher, 160);
  const keyId = boundedText(value.keyId, 160);
  const signature = boundedText(value.value, 512);
  if (!publisher || !keyId || !signature) {
    throw new Error("MCP artifact publisher signature metadata is incomplete");
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    throw new Error("MCP artifact publisher signature required flag is invalid");
  }
  return {
    algorithm: "ed25519",
    publisher,
    keyId,
    value: signature,
    ...(value.required === true ? { required: true } : {}),
  };
}

function unsupportedVerification(note: string): McpMarketplaceArtifactVerificationView {
  return {
    status: "unsupported",
    required: false,
    digest: { status: "unsupported" },
    signature: { status: "unsupported" },
    notes: [note],
  };
}

async function verifyNpmArtifact(
  packageIdentifier: string,
  version: string,
): Promise<NpmArtifactEvidence> {
  const metadataUrl = new URL(
    `/${encodeURIComponent(packageIdentifier)}/${encodeURIComponent(version)}`,
    NPM_REGISTRY_ORIGIN,
  );
  const metadataResponse = await fetch(metadataUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "SourceNerve-Desktop/0.1 MCP-Artifact-Verification",
    },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const metadataText = await readBoundedText(metadataResponse, MAX_METADATA_BYTES, "npm package metadata");
  if (!metadataResponse.ok) {
    throw new Error(`npm package metadata returned HTTP ${metadataResponse.status}`);
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText) as unknown;
  } catch {
    throw new Error("npm package metadata returned invalid JSON");
  }
  if (!isRecord(metadata) || !isRecord(metadata.dist)) {
    throw new Error("npm package metadata is missing dist integrity evidence");
  }
  const integrity = boundedText(metadata.dist.integrity, 4096);
  const tarball = fixedNpmTarball(metadata.dist.tarball);
  if (!integrity || !tarball) {
    throw new Error("npm package metadata is missing a supported integrity digest or fixed tarball URL");
  }
  const sri = strongestSri(integrity);
  if (!sri) {
    throw new Error("npm package integrity does not contain a supported sha256/sha384/sha512 digest");
  }

  const artifactResponse = await fetch(tarball, {
    method: "GET",
    headers: { "user-agent": "SourceNerve-Desktop/0.1 MCP-Artifact-Verification" },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const artifact = await readBoundedBytes(artifactResponse, MAX_ARTIFACT_BYTES, "npm package artifact");
  if (!artifactResponse.ok) {
    throw new Error(`npm package artifact returned HTTP ${artifactResponse.status}`);
  }
  const actual = createHash(sri.algorithm).update(artifact).digest();
  if (actual.length !== sri.digest.length || !timingSafeEqual(actual, sri.digest)) {
    throw new Error("npm package artifact integrity mismatch");
  }
  return {
    algorithm: sri.algorithm,
    expectedDigest: sri.digest,
    actualDigest: actual,
  };
}

function strongestSri(value: string): {
  algorithm: "sha256" | "sha384" | "sha512";
  digest: Buffer;
} | undefined {
  const candidates = value.split(/\s+/).filter(Boolean);
  for (const algorithm of ["sha512", "sha384", "sha256"] as const) {
    for (const candidate of candidates) {
      const match = new RegExp(`^${algorithm}-([^?]+)(?:\\?.*)?$`).exec(candidate);
      if (!match) continue;
      try {
        const digest = strictBase64(match[1], 128, "npm integrity digest");
        if (digest.length === createHash(algorithm).digest().length) {
          return { algorithm, digest };
        }
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function loadPublisherTrustRoots(environment: NodeJS.ProcessEnv): PublisherTrustRoot[] {
  const raw = environment[TRUST_ROOTS_ENV]?.trim();
  if (!raw) return [];
  if (Buffer.byteLength(raw, "utf8") > MAX_TRUST_ROOTS_BYTES) {
    throw new Error("MCP publisher trust roots exceed the SourceNerve size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("MCP publisher trust roots are not valid JSON");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.roots)) {
    throw new Error("MCP publisher trust roots must use schemaVersion 1 and a roots array");
  }
  if (parsed.roots.length > MAX_TRUST_ROOTS) {
    throw new Error(`MCP publisher trust roots may contain at most ${MAX_TRUST_ROOTS} entries`);
  }
  return parsed.roots.map((candidate) => parseTrustRoot(candidate));
}

function parseTrustRoot(value: unknown): PublisherTrustRoot {
  if (!isRecord(value)) throw new Error("MCP publisher trust root is invalid");
  const allowed = new Set(["keyId", "publisher", "registryNames", "algorithm", "publicKeySpki"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("MCP publisher trust root contains unsupported fields");
  }
  if (value.algorithm !== "ed25519") {
    throw new Error("MCP publisher trust root algorithm must be ed25519");
  }
  const keyId = boundedText(value.keyId, 160);
  const publisher = boundedText(value.publisher, 160);
  const publicKeySpki = boundedText(value.publicKeySpki, 2048);
  if (!keyId || !publisher || !publicKeySpki) {
    throw new Error("MCP publisher trust root is incomplete");
  }
  if (
    !Array.isArray(value.registryNames) ||
    value.registryNames.length < 1 ||
    value.registryNames.length > 32
  ) {
    throw new Error("MCP publisher trust root registryNames must be a non-empty bounded list");
  }
  const registryNames = value.registryNames.map((candidate) => {
    const pattern = boundedText(candidate, 200);
    if (!pattern || !/^[A-Za-z0-9._/*+-]+$/.test(pattern)) {
      throw new Error("MCP publisher trust root registry pattern is invalid");
    }
    return pattern;
  });
  strictBase64(publicKeySpki, 1024, "publisher trust root");
  return { keyId, publisher, registryNames, publicKeySpki };
}

async function readBoundedText(response: Response, max: number, label: string): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > max) throw new Error(`${label} exceeds the SourceNerve size limit`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > max) throw new Error(`${label} exceeds the SourceNerve size limit`);
  return text;
}

async function readBoundedBytes(response: Response, max: number, label: string): Promise<Buffer> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > max) throw new Error(`${label} exceeds the SourceNerve size limit`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > max) throw new Error(`${label} exceeds the SourceNerve size limit`);
  return bytes;
}

function fixedNpmTarball(value: unknown): URL | undefined {
  const text = boundedText(value, 2048);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (
      url.origin !== NPM_REGISTRY_ORIGIN ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function strictBase64(value: string, maxBytes: number, label: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64") !== value) {
    throw new Error(`${label} is invalid or exceeds the SourceNerve size limit`);
  }
  return bytes;
}

function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function validateRegistryName(value: string): void {
  if (value.length < 3 || value.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new Error("MCP registry server name is invalid for artifact verification");
  }
}

function validatePackageIdentifier(value: string): void {
  if (
    value.length > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._~-]{0,99}\/)?[a-z0-9][a-z0-9._~-]{0,99}$/i.test(value)
  ) {
    throw new Error("npm package identifier is invalid for artifact verification");
  }
}

function validateVersion(value: string): void {
  if (!boundedText(value, 128)) throw new Error("MCP package version is invalid for artifact verification");
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "artifact verification failed";
  return message.replace(/[\r\n\0]+/g, " ").slice(0, 512);
}
