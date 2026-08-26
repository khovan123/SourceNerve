import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpExtensionInstallInput } from "../shared/mcp-extension-api";
import { McpExtensionClient } from "./mcp-extension-client";
import { McpExtensionManager } from "./mcp-extension-manager";
import type { EncryptedSecretStore } from "./secure-store";

const baseInput: McpExtensionInstallInput = {
  id: "jira-acme",
  name: "Jira",
  version: "1.4.2",
  namespace: "jira",
  source: "registry:acme/jira",
  transport: { transport: "streamable-http", url: "https://mcp.acme.test/mcp" },
  authType: "none",
  required: false,
  updateChannel: "stable",
};

const backendTool = {
  extension_id: "jira-acme",
  original_name: "create_issue",
  public_name: "jira__create_issue",
  description: "Create Jira issue",
  schema_hash: "schema-1",
  policy: {
    enabled: true,
    approval: "automatic",
    classification: {
      read_only: false,
      destructive: false,
      idempotent: false,
      open_world: true,
    },
  },
} as const;

function policy(value: Record<string, unknown>): string {
  return JSON.stringify({ schemaVersion: 1, ...value });
}

function manager(client: Partial<McpExtensionClient>): McpExtensionManager {
  return new McpExtensionManager({
    client: client as McpExtensionClient,
    secretStore: {
      hasOpaque: vi.fn().mockResolvedValue(false),
    } as unknown as EncryptedSecretStore,
    openExternal: async () => undefined,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("MCP extension manager enterprise governance", () => {
  it("blocks denied installs before registration reaches the daemon", async () => {
    vi.stubEnv(
      "SOURCENERVE_MCP_ENTERPRISE_POLICY",
      policy({ deny: { extensions: ["jira-*"], publishers: [], transports: [] } }),
    );
    const install = vi.fn();
    const subject = manager({ install } as Partial<McpExtensionClient>);

    await expect(subject.install(baseInput)).rejects.toThrow(/governance blocked install/i);
    expect(install).not.toHaveBeenCalled();
  });

  it("prevents local policy changes from weakening central Ask requirements", async () => {
    vi.stubEnv(
      "SOURCENERVE_MCP_ENTERPRISE_POLICY",
      policy({
        toolPolicies: [
          { extension: "jira-*", tool: "create_*", enabled: true, approval: "ask" },
        ],
      }),
    );
    const updateToolPolicy = vi.fn().mockImplementation(async (input) => ({
      ...backendTool,
      policy: {
        ...backendTool.policy,
        enabled: input.enabled,
        approval: input.approval,
      },
    }));
    const subject = manager({ updateToolPolicy } as Partial<McpExtensionClient>);

    const tool = await subject.updateToolPolicy({
      extensionId: "jira-acme",
      toolName: "create_issue",
      enabled: true,
      approval: "automatic",
    });

    expect(updateToolPolicy).toHaveBeenCalledWith({
      extensionId: "jira-acme",
      toolName: "create_issue",
      enabled: true,
      approval: "ask",
    });
    expect(tool.approval).toBe("ask");
  });

  it("disables emergency-revoked extensions during reconciliation without uninstalling them", async () => {
    vi.stubEnv(
      "SOURCENERVE_MCP_ENTERPRISE_POLICY",
      policy({ revokedExtensions: ["jira-*"] }),
    );
    const enabledHealth = {
      extension: {
        id: "jira-acme",
        name: "Jira",
        version: "1.4.2",
        namespace: "jira",
        source: "registry:acme/jira",
        transport: { transport: "streamable-http", url: "https://mcp.acme.test/mcp" },
        auth_type: "none",
        status: "enabled",
        enabled: true,
        required: false,
        update_channel: "stable",
        created_at: 1,
        updated_at: 1,
      },
      discovered_tools: 1,
      exposed_tools: 1,
      credential_materialized: false,
      environment_materialized: false,
    };
    const disabledHealth = {
      ...enabledHealth,
      extension: {
        ...enabledHealth.extension,
        status: "disabled",
        enabled: false,
      },
      exposed_tools: 0,
    };
    const health = vi
      .fn()
      .mockResolvedValueOnce([enabledHealth])
      .mockResolvedValueOnce([disabledHealth]);
    const disable = vi.fn().mockResolvedValue(disabledHealth.extension);
    const subject = manager({ health, disable } as Partial<McpExtensionClient>);

    const listed = await subject.list();

    expect(disable).toHaveBeenCalledWith("jira-acme");
    expect(listed).toHaveLength(1);
    expect(listed[0].enabled).toBe(false);
    expect(listed[0].id).toBe("jira-acme");
  });
});
