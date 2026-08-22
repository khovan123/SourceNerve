import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchDesktopClientConfigResponse,
  resolveDesktopClientConfig,
} from "./bootstrap";

const endpoint = new URL("https://sourcenerve.example.test/v1/desktop/client-config");
const validClientConfig = {
  auth0: {
    issuer: "https://tenant.example.test/",
    audience: "https://sourcenerve.example.test/mcp",
    nativeClientId: "native-client-id",
  },
  publicMcp: {
    resource: "https://sourcenerve.example.test/mcp",
    protectedResourceMetadata: "https://sourcenerve.example.test/.well-known/oauth-protected-resource/mcp",
  },
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function cachePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-bootstrap-test-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "desktop-client-config.json");
}

describe("fetchDesktopClientConfigResponse", () => {
  it("retries transient gateway failures and succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);

    const response = await fetchDesktopClientConfigResponse(endpoint, { fetchImpl, sleep });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("retries network failures and succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);

    const response = await fetchDesktopClientConfigResponse(endpoint, { fetchImpl, sleep });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails fast on non-retryable HTTP responses", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);

    await expect(fetchDesktopClientConfigResponse(endpoint, { fetchImpl, sleep })).rejects.toThrow(
      "SourceNerve backend client configuration returned HTTP 401",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("reports the final transient HTTP status after bounded retries", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("gateway timeout", { status: 504 })) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);

    await expect(fetchDesktopClientConfigResponse(endpoint, { fetchImpl, sleep })).rejects.toThrow(
      "SourceNerve backend client configuration returned HTTP 504",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe("resolveDesktopClientConfig", () => {
  it("uses the last-known-good config when the broker is temporarily unavailable", async () => {
    const filePath = await cachePath();
    const firstFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(validClientConfig), { status: 200 })) as unknown as typeof fetch;

    await expect(
      resolveDesktopClientConfig(endpoint, filePath, {
        fetchImpl: firstFetch,
        sleep: async () => undefined,
      }),
    ).resolves.toEqual(validClientConfig);

    const offlineFetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    await expect(
      resolveDesktopClientConfig(endpoint, filePath, {
        fetchImpl: offlineFetch,
        sleep: async () => undefined,
      }),
    ).resolves.toEqual(validClientConfig);
    expect(offlineFetch).toHaveBeenCalledTimes(3);
  });

  it("does not use stale cache for non-retryable broker responses", async () => {
    const filePath = await cachePath();
    const firstFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(validClientConfig), { status: 200 })) as unknown as typeof fetch;
    await resolveDesktopClientConfig(endpoint, filePath, {
      fetchImpl: firstFetch,
      sleep: async () => undefined,
    });

    const unauthorizedFetch = vi
      .fn()
      .mockResolvedValue(new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    await expect(
      resolveDesktopClientConfig(endpoint, filePath, {
        fetchImpl: unauthorizedFetch,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("SourceNerve backend client configuration returned HTTP 401");
  });

  it("rejects an invalid cache instead of bootstrapping from unvalidated data", async () => {
    const filePath = await cachePath();
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        config: {
          ...validClientConfig,
          publicMcp: {
            ...validClientConfig.publicMcp,
            resource: "https://different.example.test/mcp",
          },
        },
      }),
      "utf8",
    );
    const offlineFetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;

    await expect(
      resolveDesktopClientConfig(endpoint, filePath, {
        fetchImpl: offlineFetch,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("SourceNerve backend client configuration is unavailable");
  });
});
