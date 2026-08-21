import { describe, expect, it, vi } from "vitest";

import { fetchDesktopClientConfigResponse } from "./bootstrap";

const endpoint = new URL("https://sourcenerve.example.test/v1/desktop/client-config");

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
