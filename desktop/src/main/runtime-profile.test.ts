import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildRuntimeToml,
  materializeRuntime,
  validateProductProfile,
  type MaterializeRuntimeInput,
  type ProductProfile,
} from "./runtime-profile";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function profile(): ProductProfile {
  return {
    schemaVersion: 1,
    product: {
      name: "SourceNerve",
      channel: "development",
      websiteUrl: "https://sourcenerve.example.test/",
      supportUrl: "https://sourcenerve.example.test/support",
      privacyUrl: "https://sourcenerve.example.test/privacy",
      termsUrl: "https://sourcenerve.example.test/terms",
    },
    daemon: {
      managed: true,
      bind: "127.0.0.1:7331",
      healthPath: "/healthz",
      readinessPath: "/api/v1/readiness",
      mcpPath: "/mcp",
    },
    auth0: {
      issuer: "https://auth.example.test/",
      nativeClientId: "desktop-public-client-id",
      audience: "https://sourcenerve.example.test/mcp",
      scopes: ["openid", "sourcenerve:read", "sourcenerve:write"],
      callbackUri: "sourcenerve://oauth/callback",
      flow: "authorization_code_pkce",
    },
    publicMcp: {
      resource: "https://sourcenerve.example.test/mcp",
      protectedResourceMetadata:
        "https://sourcenerve.example.test/.well-known/oauth-protected-resource/mcp",
      routingMode: "bootstrap-broker",
      hostnameStrategy: "installation-scoped",
    },
    bootstrapBroker: {
      baseUrl: "https://bootstrap.example.test",
      enrollPath: "/v1/desktop/enroll",
      rotateTunnelPath: "/v1/desktop/tunnel/rotate",
      revokePath: "/v1/desktop/revoke",
      statusPath: "/v1/desktop/bootstrap-status",
    },
    cloudflare: {
      mode: "broker-managed",
      bundleCloudflared: true,
      desktopReceivesAccountApiToken: false,
      desktopReceivesInstallationCredential: true,
    },
    installation: {
      localBearerEntropyBits: 256,
      generateInstallationId: true,
      secureStoreRequired: true,
    },
    workspace: {
      userSelectsRepository: true,
      userSelectsLocalRoot: true,
      userSelectsAccessMode: true,
      deriveProviderMetadata: true,
    },
  };
}

function runtimeInput(directory: string): MaterializeRuntimeInput {
  return {
    productProfile: profile(),
    configPath: path.join(directory, "managed", "sourcenerve.toml"),
    stateDirectory: path.join(directory, "state"),
    localBearer: "A".repeat(43),
    githubToken: "github-user-token-value-that-is-long-enough",
    workspaces: [
      {
        id: "source-nerve",
        name: "SourceNerve",
        root: path.join(directory, "repo"),
        access: "read-write",
        remote: "origin",
        defaultBranch: "main",
        provider: "github",
        repository: "example/source-nerve",
      },
    ],
    oauthGrants: [
      {
        subject: "auth0|desktop-user",
        workspace: "source-nerve",
        access: "read-write",
      },
    ],
  };
}

describe("Desktop runtime profile", () => {
  it("keeps secret values out of generated TOML", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-runtime-"));
    temporaryDirectories.push(directory);
    const input = runtimeInput(directory);

    const result = await materializeRuntime(input);
    const toml = await readFile(result.configPath, "utf8");

    expect(toml).toContain("[auth]");
    expect(toml).not.toContain(input.localBearer);
    expect(toml).not.toContain(input.githubToken as string);
    expect(toml).toContain('provider = "github"');
    expect(toml).toContain('subject = "auth0|desktop-user"');
    expect(result.environment.SOURCENERVE_BEARER_TOKEN).toBe(input.localBearer);
    expect(result.environment.SOURCENERVE_GITHUB_TOKEN).toBe(input.githubToken);
    expect(result.environment.SOURCENERVE_OAUTH_ALLOW_OPERATOR_BEARER).toBe("false");
  });

  it("rejects unresolved placeholders for packaged profiles", () => {
    const value = profile();
    value.auth0.nativeClientId = "__SOURCENERVE_AUTH0_NATIVE_CLIENT_ID__";
    expect(() => validateProductProfile(value, { allowPlaceholders: false })).toThrow(
      /unresolved packaged Desktop profile value/,
    );
    expect(() => validateProductProfile(value, { allowPlaceholders: true })).not.toThrow();
  });

  it("rejects workspace/provider inconsistencies", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-runtime-"));
    temporaryDirectories.push(directory);
    const input = runtimeInput(directory);
    delete input.workspaces[0].provider;
    expect(() => buildRuntimeToml(input)).toThrow(/repository requires provider/);
  });
});
