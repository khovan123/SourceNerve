import { createHash } from "node:crypto";

import type {
  PluginDomainChallengeResult,
  PluginSetupFields,
  PluginVerificationCheck,
  PluginVerificationRunResult,
  PluginVerificationView,
} from "../shared/plugin-verification-api";
import type { DesktopBootstrapState } from "./bootstrap";
import { existingDaemonLaunchPlan } from "./daemon-bootstrap";
import type { DaemonManager } from "./daemon-manager";
import type { Auth0Manager } from "./auth0-manager";
import type { PublicMcpManager } from "./public-mcp-manager";
import type { SourceNerveClient } from "./sourcenerve-client";
import { readPluginSetupFields } from "./plugin-product-contract";

const CHALLENGE_SECRET = "pluginChallengeToken" as const;
const CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
const MAX_JSON_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_ICON_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const EMPTY_PUBLIC_MCP = { state: "not-enrolled" as const, tunnelRunning: false };

export class PluginVerificationManager {
  private readonly fields: PluginSetupFields;
  private lastVerifiedAt?: string;
  private challengeLastVerifiedAt?: string;

  constructor(private readonly options: {
    bootstrap: DesktopBootstrapState;
    auth0(): Auth0Manager | null;
    publicMcp(): PublicMcpManager | null;
    daemon(): DaemonManager | null;
    client(): SourceNerveClient | null;
    openExternal(url: string): Promise<void>;
  }) {
    this.fields = readPluginSetupFields(options.bootstrap.profile);
  }

  async state(): Promise<PluginVerificationView> {
    const auth = this.options.auth0()?.state();
    const publicMcp = this.options.publicMcp()?.state() ?? EMPTY_PUBLIC_MCP;
    const challengeConfigured = Boolean(
      await this.options.bootstrap.secretStore.get(CHALLENGE_SECRET),
    );
    const checks = this.baseChecks(auth?.status === "authenticated", publicMcp.state === "ready");
    return {
      status: checks.every((check) => check.state === "ready")
        ? "ready-to-connect"
        : "needs-attention",
      account: {
        status: auth?.status ?? "unavailable",
        ...(auth?.identity ? { identity: auth.identity } : {}),
        workspaceGrants: auth?.workspaceGrants ?? [],
      },
      publicMcp,
      fields: { ...this.fields, oauthScopes: [...this.fields.oauthScopes] },
      checks,
      challenge: {
        configured: challengeConfigured,
        verified: Boolean(challengeConfigured && this.challengeLastVerifiedAt),
        ...(this.challengeLastVerifiedAt
          ? { lastVerifiedAt: this.challengeLastVerifiedAt }
          : {}),
      },
      ...(this.lastVerifiedAt ? { lastVerifiedAt: this.lastVerifiedAt } : {}),
    };
  }

  async verify(): Promise<PluginVerificationRunResult> {
    const checks: PluginVerificationCheck[] = [];
    const auth = this.options.auth0()?.state();
    checks.push(check(
      "auth0",
      "SourceNerve account",
      auth?.status === "authenticated" && Boolean(auth.identity),
      auth?.status === "authenticated"
        ? `Authenticated${auth.identity?.email ? ` as ${auth.identity.email}` : ""}; ${auth.workspaceGrants?.length ?? 0} workspace grant(s).`
        : "Sign in to SourceNerve with the operator-issued Auth0 account.",
    ));

    const client = this.options.client();
    if (!client) {
      checks.push(check("local-daemon", "Local SourceNerve daemon", false, "Local SourceNerve client is unavailable."));
    } else {
      try {
        await client.health();
        checks.push(check("local-daemon", "Local SourceNerve daemon", true, "Loopback daemon health is ready."));
      } catch {
        checks.push(check("local-daemon", "Local SourceNerve daemon", false, "Loopback daemon health check failed."));
      }
    }

    const publicManager = this.options.publicMcp();
    let publicMcp = publicManager?.state() ?? EMPTY_PUBLIC_MCP;
    let toolCount: number | undefined;
    let serverName: string | undefined;
    let serverVersion: string | undefined;
    if (!publicManager) {
      checks.push(check("public-mcp", "Public MCP", false, "Managed Public MCP is unavailable in this product profile."));
    } else {
      try {
        publicMcp = await publicManager.retry();
        checks.push(check(
          "public-mcp",
          "Public MCP / protected resource / tool discovery",
          publicMcp.state === "ready",
          publicMcp.state === "ready"
            ? "Public health, protected-resource metadata, Bearer challenge, MCP initialize and tools/list checks passed."
            : publicMcp.message ?? `Public MCP is ${publicMcp.state}.`,
        ));
        const details = readPublicVerificationDetails(publicMcp);
        toolCount = details.toolCount;
        serverName = details.serverName;
        serverVersion = details.serverVersion;
      } catch {
        publicMcp = publicManager.state();
        checks.push(check("public-mcp", "Public MCP / protected resource / tool discovery", false, publicMcp.message ?? "Public MCP verification failed."));
      }
    }

    checks.push(await this.verifyOauthDiscovery());
    checks.push(await this.verifyHttpsEndpoint("privacy", "Privacy policy", this.fields.privacyUrl));
    checks.push(await this.verifyHttpsEndpoint("terms", "Terms of service", this.fields.termsUrl));
    checks.push(await this.verifyHttpsEndpoint("support", "Support page", this.fields.supportUrl));
    if (this.fields.iconUrl) checks.push(await this.verifyIcon(this.fields.iconUrl));
    else checks.push({ id: "icon", label: "Plugin icon", state: "warning", message: "No public icon URL is configured; use the packaged icon export if manual upload is required." });

    this.lastVerifiedAt = new Date().toISOString();
    const challengeConfigured = Boolean(await this.options.bootstrap.secretStore.get(CHALLENGE_SECRET));
    const requiredReady = checks
      .filter((item) => item.state !== "warning")
      .every((item) => item.state === "ready");
    const view: PluginVerificationView = {
      status: requiredReady ? "ready-to-connect" : "needs-attention",
      account: {
        status: auth?.status ?? "unavailable",
        ...(auth?.identity ? { identity: auth.identity } : {}),
        workspaceGrants: auth?.workspaceGrants ?? [],
      },
      publicMcp,
      fields: { ...this.fields, oauthScopes: [...this.fields.oauthScopes] },
      checks,
      challenge: {
        configured: challengeConfigured,
        verified: Boolean(challengeConfigured && this.challengeLastVerifiedAt),
        ...(this.challengeLastVerifiedAt ? { lastVerifiedAt: this.challengeLastVerifiedAt } : {}),
      },
      lastVerifiedAt: this.lastVerifiedAt,
    };
    return {
      view,
      ...(toolCount !== undefined ? { toolCount } : {}),
      ...(serverName ? { serverName } : {}),
      ...(serverVersion ? { serverVersion } : {}),
    };
  }

  setupFieldsText(): string {
    return [
      `Name: ${this.fields.name}`,
      `Description: ${this.fields.description}`,
      `Public MCP resource: ${this.fields.publicMcpResource}`,
      `OAuth issuer: ${this.fields.oauthIssuer}`,
      `OAuth resource: ${this.fields.oauthResource}`,
      `OAuth scopes: ${this.fields.oauthScopes.join(" ")}`,
      `Privacy: ${this.fields.privacyUrl}`,
      `Terms: ${this.fields.termsUrl}`,
      `Support: ${this.fields.supportUrl}`,
      ...(this.fields.iconUrl ? [`Icon: ${this.fields.iconUrl}`] : []),
    ].join("\n");
  }

  async openChatGpt(): Promise<void> {
    const url = this.fields.chatgptSetupUrl;
    if (!url) throw new Error("The packaged product profile does not define a ChatGPT setup URL.");
    await this.options.openExternal(url);
  }

  async downloadIcon(): Promise<{ bytes: Buffer; extension: string }> {
    const url = this.fields.iconUrl;
    if (!url) throw new Error("The packaged product profile does not define a public plugin icon URL.");
    const response = await fixedFetch(url, { maxBytes: MAX_ICON_BYTES, accept: "image/png,image/jpeg,image/svg+xml" });
    const type = (response.contentType ?? "").split(";", 1)[0]?.trim().toLowerCase();
    const extension = type === "image/png"
      ? ".png"
      : type === "image/jpeg"
        ? ".jpg"
        : type === "image/svg+xml"
          ? ".svg"
          : null;
    if (!extension) throw new Error("Plugin icon endpoint did not return PNG, JPEG or SVG content.");
    return { bytes: response.bytes, extension };
  }

  async setChallenge(token: string): Promise<PluginDomainChallengeResult> {
    validateChallengeToken(token);
    this.assertManagedDaemon();
    await this.options.bootstrap.secretStore.set(CHALLENGE_SECRET, token);
    this.challengeLastVerifiedAt = undefined;
    try {
      await this.reloadManagedDaemon();
    } catch (error) {
      throw new Error(`Domain challenge was stored securely but the managed daemon could not reload: ${safeError(error)}`);
    }
    return this.verifyChallenge();
  }

  async verifyChallenge(): Promise<PluginDomainChallengeResult> {
    const token = await this.options.bootstrap.secretStore.get(CHALLENGE_SECRET);
    if (!token) return { configured: false, verified: false, message: "No domain challenge token is configured." };
    validateChallengeToken(token);
    const publicMcp = this.options.publicMcp()?.state();
    if (!publicMcp?.hostname) {
      return { configured: true, verified: false, message: "Public MCP hostname is unavailable; repair Public MCP first." };
    }
    const url = `https://${publicMcp.hostname}${CHALLENGE_PATH}`;
    try {
      const response = await fixedFetch(url, { maxBytes: 2_048, accept: "text/plain" });
      const body = response.bytes.toString("utf8");
      if (body !== token) {
        this.challengeLastVerifiedAt = undefined;
        return { configured: true, verified: false, message: "Public challenge response did not exactly match the configured token." };
      }
      this.challengeLastVerifiedAt = new Date().toISOString();
      return {
        configured: true,
        verified: true,
        lastVerifiedAt: this.challengeLastVerifiedAt,
        message: "Public domain challenge response exactly matches the configured token.",
      };
    } catch {
      this.challengeLastVerifiedAt = undefined;
      return { configured: true, verified: false, message: "Public domain challenge endpoint could not be verified." };
    }
  }

  async removeChallenge(): Promise<PluginDomainChallengeResult> {
    this.assertManagedDaemon();
    await deleteSecureSecret(this.options.bootstrap.secretStore, CHALLENGE_SECRET);
    this.challengeLastVerifiedAt = undefined;
    await this.reloadManagedDaemon();
    return { configured: false, verified: false, message: "Domain challenge token was removed from secure storage and the managed daemon was reloaded." };
  }

  private baseChecks(authReady: boolean, publicReady: boolean): PluginVerificationCheck[] {
    return [
      check("auth0", "SourceNerve account", authReady, authReady ? "Authenticated." : "Sign in to SourceNerve."),
      check("public-mcp", "Public MCP", publicReady, publicReady ? "Public MCP is ready." : "Run verification or repair Public MCP."),
    ];
  }

  private async verifyOauthDiscovery(): Promise<PluginVerificationCheck> {
    const discovery = new URL(".well-known/openid-configuration", this.fields.oauthIssuer).toString();
    try {
      const response = await fixedFetch(discovery, { maxBytes: MAX_JSON_BYTES, accept: "application/json" });
      const value = JSON.parse(response.bytes.toString("utf8")) as unknown;
      if (!isRecord(value) || typeof value.issuer !== "string") throw new Error("issuer missing");
      const expected = normalizeIssuer(this.fields.oauthIssuer);
      const actual = normalizeIssuer(value.issuer);
      if (actual !== expected) throw new Error("issuer mismatch");
      return check("oauth-discovery", "OAuth issuer discovery", true, `OIDC discovery reports the expected issuer ${expected}.`);
    } catch {
      return check("oauth-discovery", "OAuth issuer discovery", false, "OIDC discovery is unavailable or reports a different issuer.");
    }
  }

  private async verifyHttpsEndpoint(id: string, label: string, url: string): Promise<PluginVerificationCheck> {
    try {
      await fixedFetch(url, { maxBytes: MAX_TEXT_BYTES, accept: "text/html,text/plain,application/json" });
      return check(id, label, true, `${label} endpoint is reachable.`);
    } catch {
      return check(id, label, false, `${label} endpoint is unavailable.`);
    }
  }

  private async verifyIcon(url: string): Promise<PluginVerificationCheck> {
    try {
      const response = await fixedFetch(url, { maxBytes: MAX_ICON_BYTES, accept: "image/png,image/jpeg,image/svg+xml" });
      const type = (response.contentType ?? "").toLowerCase();
      const valid = type.startsWith("image/png") || type.startsWith("image/jpeg") || type.startsWith("image/svg+xml");
      return check("icon", "Plugin icon", valid, valid ? `Plugin icon is reachable (${response.bytes.length} bytes).` : "Plugin icon endpoint returned an unsupported content type.");
    } catch {
      return check("icon", "Plugin icon", false, "Plugin icon endpoint is unavailable.");
    }
  }

  private assertManagedDaemon(): void {
    const daemon = this.options.daemon();
    if (!daemon) throw new Error("SourceNerve daemon manager is unavailable.");
    const snapshot = daemon.snapshot();
    if (snapshot.state === "external") {
      throw new Error("Domain challenge cannot modify an external daemon. Start the Desktop-managed SourceNerve daemon instead.");
    }
  }

  private async reloadManagedDaemon(): Promise<void> {
    const daemon = this.options.daemon();
    if (!daemon) throw new Error("SourceNerve daemon manager is unavailable.");
    const current = daemon.snapshot();
    if (current.state === "external") throw new Error("External daemon is not controlled by Desktop.");
    const plan = await existingDaemonLaunchPlan(this.options.bootstrap);
    if (!plan) throw new Error("Managed SourceNerve launch plan is unavailable.");
    daemon.configure(plan);
    if (current.state === "ready" || current.state === "starting" || current.state === "stopping" || current.state === "crashed") {
      await daemon.restart();
    } else {
      await daemon.start();
    }
  }
}

function check(id: string, label: string, ready: boolean, message: string): PluginVerificationCheck {
  return { id, label, state: ready ? "ready" : "error", message };
}

function validateChallengeToken(value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > 1_024 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error("Domain challenge token must be 1-1024 ASCII graphic characters with no whitespace or control characters.");
  }
}

async function fixedFetch(urlValue: string, options: { maxBytes: number; accept: string }): Promise<{ bytes: Buffer; contentType?: string }> {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Verification URL must be credential-free HTTPS.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: options.accept },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`verification endpoint returned ${response.status}`);
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > options.maxBytes) throw new Error("verification response exceeded size limit");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > options.maxBytes) throw new Error("verification response exceeded size limit");
    return {
      bytes,
      ...(response.headers.get("content-type") ? { contentType: response.headers.get("content-type")! } : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function deleteSecureSecret(store: DesktopBootstrapState["secretStore"], key: typeof CHALLENGE_SECRET): Promise<void> {
  const candidate = store as unknown as {
    delete?: (name: typeof CHALLENGE_SECRET) => Promise<void>;
    remove?: (name: typeof CHALLENGE_SECRET) => Promise<void>;
  };
  if (typeof candidate.delete === "function") {
    await candidate.delete(key);
    return;
  }
  if (typeof candidate.remove === "function") {
    await candidate.remove(key);
    return;
  }
  throw new Error("OS-backed secret store does not support secure deletion.");
}

function normalizeIssuer(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return url.toString();
}

function readPublicVerificationDetails(value: unknown): { toolCount?: number; serverName?: string; serverVersion?: string } {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.toolCount === "number" && Number.isSafeInteger(value.toolCount) && value.toolCount >= 0 ? { toolCount: value.toolCount } : {}),
    ...(typeof value.serverName === "string" && value.serverName.length <= 256 ? { serverName: value.serverName } : {}),
    ...(typeof value.serverVersion === "string" && value.serverVersion.length <= 128 ? { serverVersion: value.serverVersion } : {}),
  };
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\r\n\t]+/g, " ").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 512)
    : "operation failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function challengeTokenFingerprint(token: string): string {
  validateChallengeToken(token);
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}
