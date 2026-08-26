import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  artifactSignaturePayload,
  verifyMcpMarketplaceArtifact,
} from "./mcp-artifact-verification";

const registryName = "acme/memory";
const version = "1.2.3";
const packageIdentifier = "acme-memory";
const tarballUrl = "https://registry.npmjs.org/acme-memory/-/acme-memory-1.2.3.tgz";

function integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function stubNpmArtifact(
  artifact: Uint8Array,
  expectedArtifact: Uint8Array = artifact,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          dist: {
            integrity: integrity(expectedArtifact),
            tarball: tarballUrl,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    )
    .mockResolvedValueOnce(new Response(artifact, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function request() {
  return {
    registryName,
    version,
    installKind: "npm" as const,
    packageIdentifier,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("MCP marketplace artifact verification", () => {
  it("verifies the exact npm tarball against the registry integrity digest", async () => {
    const artifact = new TextEncoder().encode("verified npm artifact");
    const fetchMock = stubNpmArtifact(artifact);

    const result = await verifyMcpMarketplaceArtifact(request());

    expect(result.status).toBe("verified");
    expect(result.required).toBe(true);
    expect(result.digest.status).toBe("verified");
    expect(result.digest.algorithm).toBe("sha512");
    expect(result.digest.source).toBe("npm-registry");
    expect(result.digest.expected).toBe(result.digest.actual);
    expect(result.signature.status).toBe("not-provided");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the downloaded npm artifact does not match the declared digest", async () => {
    stubNpmArtifact(
      new TextEncoder().encode("tampered artifact"),
      new TextEncoder().encode("expected artifact"),
    );

    const result = await verifyMcpMarketplaceArtifact(request());

    expect(result.status).toBe("failed");
    expect(result.digest.status).toBe("mismatch");
    expect(result.notes.join(" ")).toMatch(/integrity mismatch/i);
  });

  it("fails when publisher signature evidence is required but missing", async () => {
    stubNpmArtifact(new TextEncoder().encode("signed artifact bytes"));

    const result = await verifyMcpMarketplaceArtifact({
      ...request(),
      signatureRequired: true,
    });

    expect(result.status).toBe("failed");
    expect(result.digest.status).toBe("verified");
    expect(result.signature.status).toBe("not-provided");
    expect(result.notes.join(" ")).toMatch(/requires publisher signature/i);
  });

  it("verifies an Ed25519 publisher signature only against a reviewed matching trust root", async () => {
    const artifact = new TextEncoder().encode("publisher signed artifact");
    const digest = createHash("sha512").update(artifact).digest("base64");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keyId = "acme-release-2026";
    const publisher = "Acme";
    const payload = artifactSignaturePayload({
      registryName,
      version,
      algorithm: "sha512",
      digest,
    });
    const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
    const publicKeySpki = publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
    vi.stubEnv(
      "SOURCENERVE_MCP_PUBLISHER_TRUST_ROOTS",
      JSON.stringify({
        schemaVersion: 1,
        roots: [
          {
            keyId,
            publisher,
            registryNames: ["acme/*"],
            algorithm: "ed25519",
            publicKeySpki,
          },
        ],
      }),
    );
    stubNpmArtifact(artifact);

    const result = await verifyMcpMarketplaceArtifact({
      ...request(),
      signatureRequired: true,
      signature: {
        algorithm: "ed25519",
        publisher,
        keyId,
        value: signature,
        required: true,
      },
    });

    expect(result.status).toBe("verified");
    expect(result.digest.status).toBe("verified");
    expect(result.signature).toMatchObject({
      status: "verified",
      algorithm: "ed25519",
      publisher,
      keyId,
    });
    expect(result.notes.join(" ")).toMatch(/provenance evidence only/i);
  });

  it("rejects an invalid required publisher signature even when the artifact digest matches", async () => {
    const artifact = new TextEncoder().encode("valid bytes, invalid signature");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keyId = "acme-release-2026";
    const publisher = "Acme";
    const publicKeySpki = publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
    const wrongSignature = sign(
      null,
      Buffer.from("not the SourceNerve artifact payload", "utf8"),
      privateKey,
    ).toString("base64");
    vi.stubEnv(
      "SOURCENERVE_MCP_PUBLISHER_TRUST_ROOTS",
      JSON.stringify({
        schemaVersion: 1,
        roots: [
          {
            keyId,
            publisher,
            registryNames: [registryName],
            algorithm: "ed25519",
            publicKeySpki,
          },
        ],
      }),
    );
    stubNpmArtifact(artifact);

    const result = await verifyMcpMarketplaceArtifact({
      ...request(),
      signatureRequired: true,
      signature: {
        algorithm: "ed25519",
        publisher,
        keyId,
        value: wrongSignature,
        required: true,
      },
    });

    expect(result.status).toBe("failed");
    expect(result.digest.status).toBe("verified");
    expect(result.signature.status).toBe("invalid");
  });

  it("reports unsupported artifact paths separately instead of treating them as verified", async () => {
    const result = await verifyMcpMarketplaceArtifact({
      registryName,
      version,
      installKind: "remote",
      signatureRequired: false,
    });

    expect(result.status).toBe("unsupported");
    expect(result.required).toBe(false);
    expect(result.digest.status).toBe("unsupported");
    expect(result.signature.status).toBe("unsupported");
  });
});
