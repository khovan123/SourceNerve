import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  DesktopRuntimeEvent,
  PublicMcpView,
} from "../shared/desktop-api";
import type { Auth0Manager } from "./auth0-manager";
import {
  BootstrapBrokerClient,
  BootstrapBrokerError,
  type BrokerEnrollment,
} from "./bootstrap-broker-client";
import type { DesktopBootstrapState } from "./bootstrap";
import { CloudflaredManager } from "./cloudflared-manager";
import { rotateInstallationId } from "./installation";

const METADATA_VERSION = 1 as const;
const PUBLIC_CHECK_TIMEOUT_MS = 12_000;
const MAX_PUBLIC_RESPONSE_BYTES = 2 * 1024 * 1024;
const PUBLIC_READY_RETRIES = 8;
const PUBLIC_READY_DELAY_MS = 1500;
const MCP_PROTOCOL_VERSION = "2025-06-18";

interface StoredPublicMcpMetadata {
  version: typeof METADATA_VERSION;
  installationId: string;
  hostname: string;
  tunnelId: string;
  status: "active" | "revoked";
  updatedAt: string;
}

export class PublicMcpManager {
  private readonly bootstrap: DesktopBootstrapState;
  private readonly auth0: Auth0Manager;
  private broker: BootstrapBrokerClient;
  private readonly cloudflared: CloudflaredManager;
  private readonly onEvent: (event: DesktopRuntimeEvent) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly delayImpl: (milliseconds: number) => Promise<void>;
  private readonly metadataPath: string;
  private metadata: StoredPublicMcpMetadata | null = null;
  private authBoundaryShutdown: Promise<void> | null = null;
  private current: PublicMcpView = {
    state: "not-enrolled",
    tunnelRunning: false,
  };

  constructor(options: {
    bootstrap: DesktopBootstrapState;
    auth0: Auth0Manager;
    cloudflared: CloudflaredManager;
    onEvent: (event: DesktopRuntimeEvent) => void;
    fetchImpl?: typeof fetch;
    delayImpl?: (milliseconds: number) => Promise<void>;
  }) {
    this.bootstrap = options.bootstrap;
    this.auth0 = options.auth0;
    this.cloudflared = options.cloudflared;
    this.onEvent = options.onEvent;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.delayImpl = options.delayImpl ?? delay;
    this.metadataPath = path.join(options.bootstrap.paths.managedDirectory, "public-mcp.json");
    this.broker = new BootstrapBrokerClient({
      bootstrap: options.bootstrap,
      auth0: options.auth0,
      fetchImpl: options.fetchImpl,
    });
  }

  state(): PublicMcpView {
    if (
      this.auth0.state().status !== "authenticated" &&
      this.current.state !== "not-enrolled" &&
      this.current.state !== "revoked"
    ) {
      this.ensureAuthBoundaryShutdown();
      return {
        ...structuredClone(this.current),
        state: "offline",
        tunnelRunning: false,
        message: "Sign in to SourceNerve to resume Public MCP",
      };
    }
    return structuredClone(this.current);
  }

  async initialize(): Promise<PublicMcpView> {
    this.metadata = await readMetadata(this.metadataPath);
    const token = await this.bootstrap.secretStore.get("cloudflareTunnelToken");
    if (!this.metadata) {
      if (token) await this.bootstrap.secretStore.delete("cloudflareTunnelToken");
      this.setView({ state: "not-enrolled", tunnelRunning: false });
      return this.state();
    }
    if (this.metadata.installationId !== this.bootstrap.installation.installationId) {
      await this.clearLocalEnrollment();
      this.setView({ state: "not-enrolled", tunnelRunning: false, message: "Public MCP enrollment belongs to an older installation identity" });
      return this.state();
    }
    if (this.metadata.status === "revoked") {
      await this.bootstrap.secretStore.delete("cloudflareTunnelToken");
      this.setView({
        state: "revoked",
        tunnelRunning: false,
        hostname: this.metadata.hostname,
        publicMcpUrl: `https://${this.metadata.hostname}/mcp`,
        message: "Public MCP enrollment was revoked. Re-enroll to create a new installation route.",
      });
      return this.state();
    }
    if (!token) {
      this.setViewFromMetadata("degraded", false, "Tunnel credential is missing. Repair enrollment to obtain a fresh credential.");
      return this.state();
    }

    try {
      const status = await this.broker.status();
      if (status.status !== "active") {
        this.metadata = { ...this.metadata, status: "revoked", updatedAt: status.updatedAt };
        await writeMetadata(this.metadataPath, this.metadata);
        await this.bootstrap.secretStore.delete("cloudflareTunnelToken");
        this.setViewFromMetadata("revoked", false, "Public MCP installation is revoked");
        return this.state();
      }
      await this.cloudflared.start(token);
      return await this.verifyUntilReady();
    } catch (error) {
      this.setViewFromMetadata("offline", this.cloudflared.snapshot().state === "running", safePublicError(error));
      return this.state();
    }
  }

  async enroll(): Promise<PublicMcpView> {
    this.requireSignedIn();
    this.setView({ state: "enrolling", tunnelRunning: false, message: "Provisioning public MCP route…" });
    const enrollment = await this.broker.enroll();
    await this.applyEnrollment(enrollment);
    return this.verifyUntilReady();
  }

  async retry(): Promise<PublicMcpView> {
    this.requireSignedIn();
    if (!this.metadata || this.metadata.status === "revoked") {
      return this.reEnroll();
    }
    this.setViewFromMetadata("checking", this.cloudflared.snapshot().state === "running", "Checking public MCP route…");
    try {
      const status = await this.broker.status();
      if (status.status === "revoked") {
        this.metadata = { ...this.metadata, status: "revoked", updatedAt: status.updatedAt };
        await writeMetadata(this.metadataPath, this.metadata);
        await this.bootstrap.secretStore.delete("cloudflareTunnelToken");
        await this.cloudflared.stop();
        this.setViewFromMetadata("revoked", false, "Public MCP installation was revoked");
        return this.state();
      }
      let token = await this.bootstrap.secretStore.get("cloudflareTunnelToken");
      if (!token) {
        const refreshed = await this.broker.enroll();
        await this.applyEnrollment(refreshed);
        token = refreshed.tunnelToken;
      } else if (this.cloudflared.snapshot().state !== "running") {
        await this.cloudflared.start(token);
      }
      return this.verifyUntilReady();
    } catch (error) {
      if (error instanceof BootstrapBrokerError && error.code === "installation_revoked") {
        this.setViewFromMetadata("revoked", false, "Public MCP installation was revoked");
        return this.state();
      }
      this.setViewFromMetadata("degraded", this.cloudflared.snapshot().state === "running", safePublicError(error));
      return this.state();
    }
  }

  async rotateTunnelCredential(): Promise<PublicMcpView> {
    this.requireSignedIn();
    if (!this.metadata || this.metadata.status !== "active") {
      throw new Error("Public MCP must be enrolled before rotating its tunnel credential");
    }
    this.setViewFromMetadata("enrolling", this.cloudflared.snapshot().state === "running", "Rotating tunnel credential…");
    const enrollment = await this.broker.rotate();
    await this.applyEnrollment(enrollment, true);
    return this.verifyUntilReady();
  }

  async revoke(): Promise<PublicMcpView> {
    this.requireSignedIn();
    this.setViewFromMetadata("checking", this.cloudflared.snapshot().state === "running", "Revoking public MCP route…");
    await this.cloudflared.stop();
    if (this.metadata) {
      await this.broker.revoke();
      this.metadata = {
        ...this.metadata,
        status: "revoked",
        updatedAt: new Date().toISOString(),
      };
      await writeMetadata(this.metadataPath, this.metadata);
    }
    await this.bootstrap.secretStore.delete("cloudflareTunnelToken");
    this.setViewFromMetadata("revoked", false, "Public MCP route is revoked. Re-enroll to create a new route.");
    return this.state();
  }

  async reEnroll(): Promise<PublicMcpView> {
    this.requireSignedIn();
    await this.cloudflared.stop();
    await this.bootstrap.secretStore.delete("cloudflareTunnelToken");
    const installationId = await rotateInstallationId(this.bootstrap.paths.managedDirectory);
    this.bootstrap.installation.installationId = installationId;
    await unlink(this.metadataPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    this.metadata = null;
    this.broker = new BootstrapBrokerClient({
      bootstrap: this.bootstrap,
      auth0: this.auth0,
      fetchImpl: this.fetchImpl,
    });
    return this.enroll();
  }

  async shutdown(): Promise<void> {
    await this.cloudflared.stop();
    if (this.current.state === "not-enrolled") {
      this.setView({
        ...this.current,
        state: "not-enrolled",
        tunnelRunning: false,
      });
      return;
    }
    if (this.metadata?.status === "revoked" || this.current.state === "revoked") {
      this.setViewFromMetadata(
        "revoked",
        false,
        this.current.message ?? "Public MCP route is revoked. Re-enroll to create a new route.",
      );
      return;
    }
    if (this.metadata?.status === "active") {
      this.setViewFromMetadata(
        "offline",
        false,
        "Public MCP connector is stopped. Sign in to SourceNerve to resume it.",
      );
      return;
    }
    this.setView({
      ...this.current,
      state: "offline",
      tunnelRunning: false,
      message: "Public MCP connector is stopped",
    });
  }

  private ensureAuthBoundaryShutdown(): void {
    if (this.authBoundaryShutdown) return;
    this.authBoundaryShutdown = this.shutdown()
      .catch(() => undefined)
      .finally(() => {
        this.authBoundaryShutdown = null;
      });
  }

  private async applyEnrollment(enrollment: BrokerEnrollment, restart = false): Promise<void> {
    await this.bootstrap.secretStore.set("cloudflareTunnelToken", enrollment.tunnelToken);
    this.metadata = {
      version: METADATA_VERSION,
      installationId: enrollment.installationId,
      hostname: enrollment.hostname,
      tunnelId: enrollment.tunnelId,
      status: "active",
      updatedAt: new Date().toISOString(),
    };
    await writeMetadata(this.metadataPath, this.metadata);
    if (restart) await this.cloudflared.restart(enrollment.tunnelToken);
    else await this.cloudflared.start(enrollment.tunnelToken);
  }

  private async verifyUntilReady(): Promise<PublicMcpView> {
    if (!this.metadata) throw new Error("Public MCP enrollment metadata is unavailable");
    this.setViewFromMetadata("checking", true, "Waiting for public MCP route…");
    let lastError: unknown = new Error("Public MCP route is not ready");
    for (let attempt = 0; attempt < PUBLIC_READY_RETRIES; attempt += 1) {
      if (attempt > 0) await this.delayImpl(PUBLIC_READY_DELAY_MS);
      try {
        await this.verifyPublicMcp(this.metadata.hostname);
        this.setViewFromMetadata("ready", true, "Public MCP is ready");
        return this.state();
      } catch (error) {
        lastError = error;
      }
    }
    this.setViewFromMetadata("degraded", this.cloudflared.snapshot().state === "running", safePublicError(lastError));
    return this.state();
  }

  private async verifyPublicMcp(hostname: string): Promise<void> {
    const origin = `https://${hostname}`;
    const health = await this.publicRequest(`${origin}/healthz`, { method: "GET" });
    const healthJson = await boundedJson(health, "public health");
    if (!isRecord(healthJson) || healthJson.status !== "ok") {
      throw new Error("Public SourceNerve health check returned an invalid response");
    }

    const metadataUrl = new URL(this.bootstrap.profile.publicMcp.protectedResourceMetadata);
    const protectedMetadata = await this.publicRequest(
      `${origin}${metadataUrl.pathname}`,
      { method: "GET", headers: { accept: "application/json" } },
    );
    const metadataJson = await boundedJson(protectedMetadata, "OAuth protected-resource metadata");
    if (!isRecord(metadataJson) || metadataJson.resource !== this.bootstrap.profile.publicMcp.resource) {
      throw new Error("Public MCP OAuth metadata does not advertise the configured SourceNerve resource");
    }

    const challenge = await this.publicRequest(`${origin}${this.bootstrap.profile.daemon.mcpPath}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(initializeRequest()),
    }, [401]);
    if (challenge.status !== 401) {
      throw new Error("Public MCP did not require OAuth authentication");
    }
    const authenticate = challenge.headers.get("www-authenticate") ?? "";
    if (!/^Bearer\b/i.test(authenticate) || !authenticate.includes("resource_metadata=")) {
      throw new Error("Public MCP OAuth challenge is missing protected-resource metadata");
    }

    const accessToken = await this.auth0.getAccessToken();
    const initResponse = await this.publicRequest(`${origin}${this.bootstrap.profile.daemon.mcpPath}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(initializeRequest()),
    });
    const initJson = await boundedMcpJson(initResponse, "MCP initialize");
    if (!isRecord(initJson) || !isRecord(initJson.result) || initJson.result.protocolVersion !== MCP_PROTOCOL_VERSION) {
      throw new Error("Public MCP initialize response is invalid");
    }
    const sessionId = initResponse.headers.get("mcp-session-id");
    const commonHeaders: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    };

    await this.publicRequest(`${origin}${this.bootstrap.profile.daemon.mcpPath}`, {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });
    const toolsResponse = await this.publicRequest(`${origin}${this.bootstrap.profile.daemon.mcpPath}`, {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const toolsJson = await boundedMcpJson(toolsResponse, "MCP tools/list");
    if (!isRecord(toolsJson) || !isRecord(toolsJson.result) || !Array.isArray(toolsJson.result.tools) || toolsJson.result.tools.length === 0) {
      throw new Error("Public MCP tool discovery returned no tools");
    }
  }

  private async publicRequest(
    url: string,
    init: RequestInit,
    allowedStatuses: number[] = [],
  ): Promise<Response> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw new Error("Public MCP validation requires a credential-free HTTPS URL");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PUBLIC_CHECK_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(parsed, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok && !allowedStatuses.includes(response.status)) {
        throw new Error(publicHttpError(response.status));
      }
      const declared = response.headers.get("content-length");
      if (declared && Number(declared) > MAX_PUBLIC_RESPONSE_BYTES) {
        throw new Error("Public MCP response is oversized");
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireSignedIn(): void {
    if (this.auth0.state().status !== "authenticated") {
      throw new Error("Sign in to SourceNerve before managing Public MCP");
    }
  }

  private async clearLocalEnrollment(): Promise<void> {
    await this.bootstrap.secretStore.delete("cloudflareTunnelToken");
    await unlink(this.metadataPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    this.metadata = null;
  }

  private setView(view: PublicMcpView): void {
    this.current = { ...view, lastCheckedAt: Date.now() };
    this.onEvent({
      type: "state",
      component: "public-mcp",
      state: view.state,
      message: view.message,
    });
  }

  private setViewFromMetadata(
    state: PublicMcpView["state"],
    tunnelRunning: boolean,
    message?: string,
  ): void {
    const hostname = this.metadata?.hostname;
    this.setView({
      state,
      tunnelRunning,
      ...(hostname
        ? {
            hostname,
            publicMcpUrl: `https://${hostname}/mcp`,
          }
        : {}),
      message,
    });
  }
}

function initializeRequest(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "sourcenerve-desktop", version: "1.0" },
    },
  };
}

async function boundedJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_PUBLIC_RESPONSE_BYTES) {
    throw new Error(`${label} response is oversized`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  }
}

async function boundedMcpJson(response: Response, label: string): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_PUBLIC_RESPONSE_BYTES) {
    throw new Error(`${label} response is oversized`);
  }
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        return JSON.parse(line.slice(5).trim()) as unknown;
      } catch {
        // Ignore non-JSON SSE data until a JSON message is found.
      }
    }
    throw new Error(`${label} SSE response did not include JSON data`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePublicError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 512);
  return "Public MCP validation failed";
}

function publicHttpError(status: number): string {
  if (status === 401 || status === 403) return "Public MCP authentication failed";
  if (status === 404) return "Public MCP route is not available yet";
  if (status === 429) return "Public MCP route is temporarily rate limited";
  if (status >= 500) return "Public MCP route is temporarily unavailable";
  return `Public MCP request failed (${status})`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readMetadata(filePath: string): Promise<StoredPublicMcpMetadata | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.version !== METADATA_VERSION || typeof value.installationId !== "string" || typeof value.hostname !== "string" || typeof value.tunnelId !== "string" || (value.status !== "active" && value.status !== "revoked") || typeof value.updatedAt !== "string") {
      throw new Error("Public MCP metadata is invalid");
    }
    return value as unknown as StoredPublicMcpMetadata;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function writeMetadata(filePath: string, value: StoredPublicMcpMetadata): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
