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
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
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
    plugin: {
      name: "SourceNerve",
      description: "Repository intelligence",
      iconUrl: "https://sourcenerve.example.test/icon.svg",
      chatgptSetupUrl: "https://chatgpt.com/",
    },
    daemon: {
      managed: true,
      bind: "127.0.0.1:7331",
      healthPath: "/healthz",
      readinessPath: "/api/v1/readiness",
      mcpPath: "/mcp",
    },
    desktopBehavior: {
      allowBackgroundMode: true,
      allowLaunchAtLogin: true,
      allowNotifications: true,
    },
    gitProviders: {
      github: { cli: "gh", hostname: "github.com", apiBaseUrl: "https://api.github.com" },
      gitlab: { cli: "glab", hostname: "gitlab.com", apiBaseUrl: "https://gitlab.com/api/v4" },
    },
    publicMcp: {
      authentication: "none",
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
    githubToken: "github-cli-token-value-that-is-long-enough",
    gitlabToken: "gitlab-cli-token-value-that-is-long-enough",
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
  };
}

describe("Desktop runtime profile", () => {
  it("materializes a local runtime without OAuth configuration", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-runtime-"));
    temporaryDirectories.push(directory);
    const input = runtimeInput(directory);

    const result = await materializeRuntime(input);
    const toml = await readFile(result.configPath, "utf8");

    expect(toml).toContain("[auth]");
    expect(toml).not.toContain("[oauth]");
    expect(toml).not.toContain("[[oauth.grant]]");
    expect(toml).not.toContain(input.localBearer);
    expect(toml).not.toContain(input.githubToken as string);
    expect(toml).not.toContain(input.gitlabToken as string);
    expect(toml).toContain('provider = "github"');
    expect(result.environment.SOURCENERVE_BEARER_TOKEN).toBe(input.localBearer);
    expect(result.environment.SOURCENERVE_GITHUB_TOKEN).toBe(input.githubToken);
    expect(result.environment.SOURCENERVE_GITLAB_TOKEN).toBe(input.gitlabToken);
    expect(result.environment.SOURCENERVE_OAUTH_ISSUER).toBeUndefined();
    expect(result.environment.SOURCENERVE_OAUTH_RESOURCE).toBeUndefined();
  });

  it("requires Public MCP to use No Auth", () => {
    const value = profile();
    value.publicMcp.authentication = "none";
    expect(() => validateProductProfile(value, { allowPlaceholders: false })).not.toThrow();

    const invalid = value as unknown as { publicMcp: { authentication: string } };
    invalid.publicMcp.authentication = "oauth";
    expect(() => validateProductProfile(invalid, { allowPlaceholders: false })).toThrow(/No Auth/);
  });

  it("requires the broker URL to be resolved for runtime use", () => {
    const value = profile();
    value.bootstrapBroker.baseUrl = "__SOURCENERVE_BOOTSTRAP_BROKER_URL__";
    expect(() => validateProductProfile(value, { allowPlaceholders: false })).toThrow(
      /bootstrapBroker.baseUrl/,
    );
  });

  it("requires gh and glab provider ownership", () => {
    const value = profile();
    value.gitProviders.github = { ...value.gitProviders.github, cli: "glab" };
    expect(() => validateProductProfile(value, { allowPlaceholders: true })).toThrow(/GitHub provider must use gh CLI/);
  });

  it("rejects workspace/provider inconsistencies", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-runtime-"));
    temporaryDirectories.push(directory);
    const input = runtimeInput(directory);
    delete input.workspaces[0].provider;
    expect(() => buildRuntimeToml(input)).toThrow(/repository requires provider/);
  });
});
