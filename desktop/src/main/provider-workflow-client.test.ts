import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderWorkflowClient, ProviderWorkflowHttpError } from "./provider-workflow-client";

const originalFetch = globalThis.fetch;
const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";
const HEAD = "a".repeat(40);

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("ProviderWorkflowClient", () => {
  it("rejects non-loopback SourceNerve origins", () => {
    expect(() => new ProviderWorkflowClient({
      baseUrl: "https://example.test",
      getBearer: async () => "A".repeat(32),
    })).toThrow(/loopback/);
  });

  it("posts merge to one fixed route with exact head and merge method", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:7331/api/v1/tasks/provider/pulls/merge");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${"B".repeat(32)}`);
      expect(JSON.parse(String(init?.body))).toEqual({
        task_id: TASK_ID,
        expected_head_sha: HEAD,
        merge_method: "squash",
      });
      return new Response(JSON.stringify({ replayed: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = new ProviderWorkflowClient({
      baseUrl: "http://127.0.0.1:7331",
      getBearer: async () => "B".repeat(32),
    });
    await expect(client.mergePull({ taskId: TASK_ID, expectedHeadSha: HEAD, method: "squash" })).resolves.toEqual({ replayed: false });
  });

  it("surfaces bounded provider-owned 409 constraints while keeping 500 bodies hidden", async () => {
    const responses = [
      new Response(JSON.stringify({ error: "required review is missing; branch protection rejected merge" }), { status: 409 }),
      new Response(JSON.stringify({ error: "internal provider token should never leak" }), { status: 500 }),
    ];
    globalThis.fetch = vi.fn(async () => responses.shift()!) as typeof fetch;
    const client = new ProviderWorkflowClient({
      baseUrl: "http://127.0.0.1:7331",
      getBearer: async () => "C".repeat(32),
    });

    await expect(client.getPull(TASK_ID)).rejects.toMatchObject({
      status: 409,
      message: "required review is missing; branch protection rejected merge",
    } satisfies Partial<ProviderWorkflowHttpError>);
    await expect(client.getPull(TASK_ID)).rejects.toMatchObject({
      status: 500,
      message: "Provider workflow service failed",
    } satisfies Partial<ProviderWorkflowHttpError>);
  });
});
