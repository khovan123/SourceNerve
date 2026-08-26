import { describe, expect, it, vi } from "vitest";

import type {
  McpExtensionView,
  McpMarketplaceArtifactVerificationView,
} from "../shared/mcp-extension-api";
import {
  attachArtifactEvidence,
  readArtifactEvidence,
  rollbackMarketplaceWithArtifactEvidence,
  writeArtifactEvidence,
} from "./mcp-artifact-evidence-store";
import type { McpExtensionManager } from "./mcp-extension-manager";
import type { EncryptedSecretStore } from "./secure-store";

function evidence(label: string): McpMarketplaceArtifactVerificationView {
  return {
    status: "verified",
    required: true,
    digest: {
      status: "verified",
      algorithm: "sha512",
      source: "npm-registry",
      expected: `sha512-${label}`,
      actual: `sha512-${label}`,
    },
    signature: { status: "not-provided" },
    notes: [`verified ${label}`],
  };
}

function inMemoryStore(): {
  store: EncryptedSecretStore;
  records: Map<string, string>;
} {
  const records = new Map<string, string>();
  const store = {
    getOpaque: vi.fn(async (key: string) => records.get(key) ?? null),
    setOpaque: vi.fn(async (key: string, value: string) => {
      records.set(key, value);
    }),
    deleteOpaque: vi.fn(async (key: string) => {
      records.delete(key);
    }),
  } as unknown as EncryptedSecretStore;
  return { store, records };
}

function managerWithStore(
  store: EncryptedSecretStore,
  rollbackMarketplace = vi.fn().mockResolvedValue({
    extensionId: "memory",
    fromVersion: "2.0.0",
    toVersion: "1.0.0",
    message: "Restored 1.0.0.",
  }),
): McpExtensionManager {
  return {
    secretStore: store,
    rollbackMarketplace,
  } as unknown as McpExtensionManager;
}

function extension(): McpExtensionView {
  return {
    id: "memory",
    name: "Memory",
    version: "2.0.0",
    namespace: "memory",
    source: "registry:acme/memory",
    transport: { transport: "stdio", command: "npx", args: ["acme-memory@2.0.0"] },
    authType: "none",
    status: "enabled",
    enabled: true,
    required: false,
    updateChannel: "stable",
    credentialConfigured: false,
    credentialMaterialized: false,
    environmentConfigured: false,
    environmentMaterialized: false,
    oauthConfigured: false,
    oauthConnected: false,
    discoveredTools: 1,
    exposedTools: 1,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("MCP artifact evidence store", () => {
  it("attaches only validated current provenance evidence to Desktop extension views", async () => {
    const { store } = inMemoryStore();
    const manager = managerWithStore(store);
    const current = evidence("current");
    await writeArtifactEvidence(manager, "memory", "current", current);

    const listed = await attachArtifactEvidence(manager, [extension()]);

    expect(listed[0].artifactVerification).toEqual(current);
  });

  it("restores the previous version provenance evidence when runtime rollback succeeds", async () => {
    const { store } = inMemoryStore();
    const rollbackMarketplace = vi.fn().mockResolvedValue({
      extensionId: "memory",
      fromVersion: "2.0.0",
      toVersion: "1.0.0",
      message: "Restored 1.0.0.",
    });
    const manager = managerWithStore(store, rollbackMarketplace);
    const current = evidence("version-2");
    const backup = evidence("version-1");
    await writeArtifactEvidence(manager, "memory", "current", current);
    await writeArtifactEvidence(manager, "memory", "backup", backup);

    const result = await rollbackMarketplaceWithArtifactEvidence(manager, "memory");

    expect(rollbackMarketplace).toHaveBeenCalledTimes(1);
    expect(await readArtifactEvidence(manager, "memory", "current")).toEqual(backup);
    expect(await readArtifactEvidence(manager, "memory", "backup")).toEqual(current);
    expect(result.message).toMatch(/provenance evidence was restored/i);
  });

  it("rejects unexpected secret-bearing fields in persisted provenance evidence", async () => {
    const { store, records } = inMemoryStore();
    const manager = managerWithStore(store);
    records.set(
      "mcp-extension-verification:memory:current",
      JSON.stringify({ ...evidence("current"), accessToken: "must-not-be-persisted" }),
    );

    await expect(readArtifactEvidence(manager, "memory", "current")).rejects.toThrow(
      /verification evidence is invalid/i,
    );
  });
});
