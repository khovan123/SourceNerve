import { afterEach, describe, expect, it, vi } from "vitest";

import { SourceNerveClient, SourceNerveHttpError } from "./sourcenerve-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("SourceNerveClient", () => {
  it("rejects non-loopback API origins", () => {
    expect(
      () =>
        new SourceNerveClient({
          baseUrl: "https://sourcenerve.example.test",
          getBearer: async () => "A".repeat(32),
        }),
    ).toThrow(/loopback HTTP base URL/);
  });

  it("calls health without authorization", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.has("authorization")).toBe(false);
      return new Response('{"status":"ok"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new SourceNerveClient({
      baseUrl: "http://127.0.0.1:7331",
      getBearer: async () => "A".repeat(32),
    });

    await expect(client.health()).resolves.toEqual({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("authenticates fixed workspace requests and validates result shape", async () => {
    const bearer = "B".repeat(32);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:7331/api/v1/workspaces");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${bearer}`);
      return new Response(
        JSON.stringify([
          { id: "source-nerve", name: "SourceNerve", writable: true },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const client = new SourceNerveClient({
      baseUrl: "http://localhost:7331",
      getBearer: async () => bearer,
    });

    await expect(client.listWorkspaces()).resolves.toEqual([
      { id: "source-nerve", name: "SourceNerve", writable: true },
    ]);
  });

  it("uses a fixed authenticated POST body for workspace indexing", async () => {
    const bearer = "I".repeat(32);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:7331/api/v1/index");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${bearer}`);
      expect(JSON.parse(String(init?.body))).toEqual({ workspace: "repo-1" });
      return new Response('{"indexed_files":12}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = new SourceNerveClient({
      baseUrl: "http://127.0.0.1:7331",
      getBearer: async () => bearer,
    });

    await expect(client.indexWorkspace("repo-1")).resolves.toEqual({ indexed_files: 12 });
    await expect(client.indexWorkspace("../etc")).rejects.toThrow(/invalid SourceNerve workspace id/);
  });

  it("maps HTTP failures without exposing response bodies", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{"secret":"must-not-leak"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof fetch;

    const client = new SourceNerveClient({
      baseUrl: "http://127.0.0.1:7331",
      getBearer: async () => "C".repeat(32),
    });

    await expect(client.serviceStatus()).rejects.toMatchObject({
      name: "SourceNerveHttpError",
      status: 401,
      message: "SourceNerve local authentication failed",
    } satisfies Partial<SourceNerveHttpError>);
  });

  it("rejects malformed workspace payloads", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('[{"id":"a","name":"A","writable":"yes"}]', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof fetch;

    const client = new SourceNerveClient({
      baseUrl: "http://127.0.0.1:7331",
      getBearer: async () => "D".repeat(32),
    });

    await expect(client.listWorkspaces()).rejects.toThrow(/invalid required fields/);
  });
});
