import type { DesktopBootstrapState } from "./bootstrap";
import type { Auth0Manager } from "./auth0-manager";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TUNNEL_TOKEN_BYTES = 32 * 1024;
const PLACEHOLDER_PATTERN = /^__[A-Z0-9_]+__$/;

export interface BrokerEnrollment {
  installationId: string;
  hostname: string;
  tunnelId: string;
  tunnelToken: string;
  status: "active";
}

export interface BrokerInstallationStatus {
  installationId: string;
  hostname: string;
  tunnelId: string;
  status: "active" | "revoked";
  updatedAt: string;
}

export class BootstrapBrokerError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "BootstrapBrokerError";
    this.status = status;
    this.code = code;
  }
}

export class BootstrapBrokerClient {
  private readonly bootstrap: DesktopBootstrapState;
  private readonly auth0: Auth0Manager;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: URL;

  constructor(options: {
    bootstrap: DesktopBootstrapState;
    auth0: Auth0Manager;
    fetchImpl?: typeof fetch;
  }) {
    this.bootstrap = options.bootstrap;
    this.auth0 = options.auth0;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const configured = options.bootstrap.profile.bootstrapBroker.baseUrl;
    if (!configured || PLACEHOLDER_PATTERN.test(configured)) {
      throw new Error("Desktop bootstrap broker URL is not configured for this build");
    }
    const baseUrl = new URL(configured);
    if (
      baseUrl.protocol !== "https:" ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.hash ||
      (baseUrl.pathname !== "/" && baseUrl.pathname !== "") ||
      baseUrl.search
    ) {
      throw new Error("Desktop bootstrap broker must use a credential-free HTTPS origin");
    }
    this.baseUrl = baseUrl;
  }

  async enroll(): Promise<BrokerEnrollment> {
    const response = await this.request(
      this.bootstrap.profile.bootstrapBroker.enrollPath,
      "POST",
      {
        installationId: this.bootstrap.installation.installationId,
        clientVersion: process.env.npm_package_version ?? "0.1.0",
        platform: process.platform,
        arch: process.arch,
      },
    );
    return parseEnrollment(response, this.bootstrap.installation.installationId);
  }

  async rotate(): Promise<BrokerEnrollment> {
    const response = await this.request(
      this.bootstrap.profile.bootstrapBroker.rotateTunnelPath,
      "POST",
      { installationId: this.bootstrap.installation.installationId },
    );
    return parseEnrollment(response, this.bootstrap.installation.installationId);
  }

  async revoke(): Promise<{ status: "revoked" }> {
    const response = await this.request(
      this.bootstrap.profile.bootstrapBroker.revokePath,
      "POST",
      { installationId: this.bootstrap.installation.installationId },
    );
    if (!isRecord(response) || response.status !== "revoked") {
      throw new Error("Desktop broker revoke response is invalid");
    }
    return { status: "revoked" };
  }

  async status(): Promise<BrokerInstallationStatus> {
    const path = this.bootstrap.profile.bootstrapBroker.statusPath;
    const url = this.url(path);
    url.searchParams.set("installationId", this.bootstrap.installation.installationId);
    const response = await this.requestUrl(url, "GET");
    if (
      !isRecord(response) ||
      response.installationId !== this.bootstrap.installation.installationId ||
      !validHostname(response.hostname) ||
      !validTunnelId(response.tunnelId) ||
      (response.status !== "active" && response.status !== "revoked") ||
      typeof response.updatedAt !== "string" ||
      response.updatedAt.length < 1 ||
      response.updatedAt.length > 128
    ) {
      throw new Error("Desktop broker status response is invalid");
    }
    return {
      installationId: response.installationId,
      hostname: response.hostname,
      tunnelId: response.tunnelId,
      status: response.status,
      updatedAt: response.updatedAt,
    };
  }

  private async request(
    path: string,
    method: "POST",
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) {
      throw new Error("Desktop broker request is oversized");
    }
    return this.requestUrl(this.url(path), method, encoded);
  }

  private async requestUrl(
    url: URL,
    method: "GET" | "POST",
    body?: string,
  ): Promise<unknown> {
    const token = await this.auth0.getAccessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      const declared = response.headers.get("content-length");
      if (declared && Number(declared) > MAX_RESPONSE_BYTES) {
        throw new Error("Desktop broker response is oversized");
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
        throw new Error("Desktop broker response is oversized");
      }
      let value: unknown = {};
      try {
        value = text ? JSON.parse(text) as unknown : {};
      } catch {
        throw new Error("Desktop broker response is not valid JSON");
      }
      if (!response.ok) {
        const errorCode = isRecord(value) && typeof value.error === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value.error)
          ? value.error
          : undefined;
        throw new BootstrapBrokerError(
          response.status,
          brokerErrorMessage(response.status, errorCode),
          errorCode,
        );
      }
      return value;
    } finally {
      clearTimeout(timeout);
    }
  }

  private url(path: string): URL {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Error("Desktop broker path must be an absolute path on the configured origin");
    }
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin || url.username || url.password || url.hash) {
      throw new Error("Desktop broker request escaped the configured origin");
    }
    return url;
  }
}

function parseEnrollment(value: unknown, installationId: string): BrokerEnrollment {
  if (
    !isRecord(value) ||
    value.installationId !== installationId ||
    !validHostname(value.hostname) ||
    !validTunnelId(value.tunnelId) ||
    !validTunnelToken(value.tunnelToken) ||
    value.status !== "active"
  ) {
    throw new Error("Desktop broker enrollment response is invalid");
  }
  return {
    installationId,
    hostname: value.hostname,
    tunnelId: value.tunnelId,
    tunnelToken: value.tunnelToken,
    status: "active",
  };
}

function validHostname(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 3 || value.length > 253 || value !== value.toLowerCase()) return false;
  return value.split(".").every((label) =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

function validTunnelId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value);
}

function validTunnelToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= MAX_TUNNEL_TOKEN_BYTES && /^[\x21-\x7e]+$/.test(value);
}

function brokerErrorMessage(status: number, code?: string): string {
  if (status === 401) return "SourceNerve account session is not authorized for Desktop enrollment";
  if (status === 403) return "SourceNerve account does not have the required enrollment scope";
  if (status === 404) return "Desktop installation is not enrolled";
  if (status === 409 && code === "installation_revoked") return "Desktop installation was revoked and must be re-enrolled";
  if (status === 429) return "Desktop enrollment is temporarily rate limited; retry later";
  if (status >= 500) return "SourceNerve bootstrap broker is temporarily unavailable";
  return "SourceNerve bootstrap broker request failed";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
