import { afterEach, describe, expect, it, vi } from "vitest";

import { McpExtensionClient } from "./mcp-extension-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("McpExtensionClient request bounds", () => {
  it("allows the largest valid MCP environment payload", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new McpExtensionClient({
      baseUrl: "http://127.0.0.1:7331",
      getBearer: async () => "local-test-bearer",
    });
    const values = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`VALUE_${index}`, "x".repeat(32 * 1024)]),
    );

    await expect(client.materializeEnvironment("example", values)).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still rejects unbounded request bodies", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new McpExtensionClient({
      baseUrl: "http://127.0.0.1:7331",
      getBearer: async () => "local-test-bearer",
    });

    await expect(
      client.materializeEnvironment("example", { HUGE: "x".repeat(2 * 1024 * 1024) }),
    ).rejects.toThrow("MCP extension request exceeds the Desktop size limit");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
