import { describe, expect, it } from "vitest";

import {
  isAllowedExternalHttpsUrl,
  isAllowedRendererNavigation,
  parseAuthCallbackUrl,
  validateDevServerUrl,
} from "./security-policy";

describe("Desktop security policy", () => {
  it("accepts only loopback HTTP development servers", () => {
    expect(validateDevServerUrl("http://127.0.0.1:5173/").ok).toBe(true);
    expect(validateDevServerUrl("http://localhost:5173/").ok).toBe(true);
    expect(validateDevServerUrl("https://localhost:5173/").ok).toBe(false);
    expect(validateDevServerUrl("http://example.com:5173/").ok).toBe(false);
    expect(validateDevServerUrl("http://user:pass@localhost:5173/").ok).toBe(false);
  });

  it("allows only same-document hash navigation in the packaged renderer", () => {
    const current = "file:///opt/SourceNerve/resources/app/.vite/renderer/main_window/index.html#/overview";
    expect(
      isAllowedRendererNavigation(
        "file:///opt/SourceNerve/resources/app/.vite/renderer/main_window/index.html#/workspaces",
        current,
      ),
    ).toBe(true);
    expect(isAllowedRendererNavigation("file:///etc/passwd", current)).toBe(false);
    expect(isAllowedRendererNavigation("https://example.com/", current)).toBe(false);
  });

  it("locks development renderer navigation to the configured loopback document", () => {
    const dev = "http://localhost:5173/";
    expect(isAllowedRendererNavigation("http://localhost:5173/#/harness", dev, dev)).toBe(true);
    expect(isAllowedRendererNavigation("http://localhost:5173/other", dev, dev)).toBe(false);
    expect(isAllowedRendererNavigation("http://127.0.0.1:5173/", dev, dev)).toBe(false);
    expect(isAllowedRendererNavigation("https://localhost:5173/", dev, dev)).toBe(false);
  });

  it("requires an explicit HTTPS origin allowlist for external URLs", () => {
    const allowlist = ["https://sourcenerve.fogewise.io.vn/"];
    expect(
      isAllowedExternalHttpsUrl("https://sourcenerve.fogewise.io.vn/support", allowlist),
    ).toBe(true);
    expect(isAllowedExternalHttpsUrl("http://sourcenerve.fogewise.io.vn/", allowlist)).toBe(false);
    expect(isAllowedExternalHttpsUrl("https://evil.example/", allowlist)).toBe(false);
    expect(
      isAllowedExternalHttpsUrl(
        "https://user:pass@sourcenerve.fogewise.io.vn/support",
        allowlist,
      ),
    ).toBe(false);
  });

  it("parses bounded Auth0 callbacks without accepting arbitrary deep links", () => {
    expect(
      parseAuthCallbackUrl("sourcenerve://oauth/callback?code=abc_123&state=state-123"),
    ).toEqual({
      ok: true,
      value: { kind: "success", code: "abc_123", state: "state-123" },
    });
    expect(
      parseAuthCallbackUrl(
        "sourcenerve://oauth/callback?error=access_denied&error_description=Denied&state=state-123",
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: "error",
        error: "access_denied",
        errorDescription: "Denied",
        state: "state-123",
      },
    });
    expect(parseAuthCallbackUrl("sourcenerve://oauth/callback?code=abc").ok).toBe(false);
    expect(
      parseAuthCallbackUrl("sourcenerve://oauth/callback?code=abc&state=a&state=b").ok,
    ).toBe(false);
    expect(
      parseAuthCallbackUrl("sourcenerve://oauth/callback?code=abc&state=state&next=https://evil.example").ok,
    ).toBe(false);
    expect(parseAuthCallbackUrl("sourcenerve://other/callback?code=abc&state=state").ok).toBe(false);
  });
});
