import { afterEach, describe, expect, it, vi } from "vitest";

import { MCP_EXTENSION_IPC } from "../shared/mcp-extension-api";
import { McpExtensionClient } from "./mcp-extension-client";
import { McpExtensionManager } from "./mcp-extension-manager";
import { validateMcpExtensionIpcInvocation } from "./mcp-extension-policy";
import type { EncryptedSecretStore } from "./secure-store";

const backendActivity = {
  id: 42,
  occurred_at: 1_787_744_000,
  principal_kind: "oauth",
  principal_subject: "auth0|user-a",
  workspace_id: "workspace-a",
  extension_id: "memory",
  extension_version: "1.2.3",
  public_tool: "memory__search",
  original_tool: "search",
  schema_hash: "schema-abc",
  policy_decision: "allow",
  approval_decision: "approved",
  result_category: "success",
  duration_ms: 17,
  error_category: null,
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MCP extension activity Desktop boundary", () => {
  it("allowlists only bounded activity IPC queries", () => {
    expect(
      validateMcpExtensionIpcInvocation(MCP_EXTENSION_IPC.activity, [
        { extensionId: "memory", limit: 100 },
      ]),
    ).toBeNull();
    expect(
      validateMcpExtensionIpcInvocation(MCP_EXTENSION_IPC.activity, [{}]),
    ).toBeNull();
    expect(
      validateMcpExtensionIpcInvocation(MCP_EXTENSION_IPC.activity, [
        { extensionId: "../escape", limit: 100 },
      ]),
    ).toContain("invalid");
    expect(
      validateMcpExtensionIpcInvocation(MCP_EXTENSION_IPC.activity, [{ limit: 501 }]),
    ).toContain("invalid");
    expect(
      validateMcpExtensionIpcInvocation(MCP_EXTENSION_IPC.activity, [
        { authorization: "Bearer should-not-cross-ipc" },
      ]),
    ).toContain("invalid");
  });

  it("queries the loopback activity endpoint with bounded filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("[]", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "2",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpExtensionClient({
      baseUrl: "http://127.0.0.1:7331",
      getBearer: async () => "desktop-test-bearer",
    });
    await client.listActivity({ extensionId: "memory", limit: 25 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "http://127.0.0.1:7331/api/v1/mcp/extensions/activity?extension_id=memory&limit=25",
    );
    expect(init.method).toBe("GET");
    expect((init.headers as Headers).get("authorization")).toBe(
      "Bearer desktop-test-bearer",
    );
  });

  it("maps safe activity metadata and rejects unexpected payload fields", async () => {
    const listActivity = vi.fn().mockResolvedValue([backendActivity]);
    const manager = new McpExtensionManager({
      client: { listActivity } as unknown as McpExtensionClient,
      secretStore: {} as unknown as EncryptedSecretStore,
      openExternal: async () => undefined,
    });

    const activity = await manager.listActivity({ extensionId: "memory", limit: 10 });
    expect(activity).toEqual([
      {
        id: 42,
        occurredAt: 1_787_744_000,
        principalKind: "oauth",
        principalSubject: "auth0|user-a",
        workspaceId: "workspace-a",
        extensionId: "memory",
        extensionVersion: "1.2.3",
        publicTool: "memory__search",
        originalTool: "search",
        schemaHash: "schema-abc",
        policyDecision: "allow",
        approvalDecision: "approved",
        resultCategory: "success",
        durationMs: 17,
      },
    ]);
    expect(listActivity).toHaveBeenCalledWith({ extensionId: "memory", limit: 10 });

    listActivity.mockResolvedValueOnce([
      {
        ...backendActivity,
        authorization: "Bearer leaked-secret",
      },
    ]);
    await expect(manager.listActivity()).rejects.toThrow("unsupported fields");
  });
});
