import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ManagedWorkspaceView } from "../shared/desktop-api";
import type { McpExtensionView } from "../shared/mcp-extension-api";
import type { McpExtensionManager } from "./mcp-extension-manager";
import { DEFAULT_PLUGIN_REGISTRY_URL } from "./plugin-marketplace";
import {
  PluginManager,
  isSafeSkillsOnlyAutoInstall,
  type PluginRuntimeMaterialization,
} from "./plugin-manager";

const REMOTE_URL = "https://example.com/mcp";
const REMOTE_DEFINITION_HASH = createHash("sha256")
  .update(JSON.stringify({ type: "streamable-http", url: REMOTE_URL, auth: "none" }), "utf8")
  .update("\0", "utf8")
  .digest("hex");

function extension(overrides: Partial<McpExtensionView> = {}): McpExtensionView {
  return {
    id: `plugin-remote-${REMOTE_DEFINITION_HASH.slice(0, 16)}`,
    name: "Fixture · remote",
    version: "1.0.0",
    namespace: `plugin-remote-${REMOTE_DEFINITION_HASH.slice(0, 8)}`,
    source: "plugin-hub:fixture:remote:legacy",
    transport: { transport: "streamable-http", url: REMOTE_URL },
    authType: "none",
    status: "enabled",
    enabled: true,
    required: false,
    updateChannel: "plugin",
    credentialConfigured: false,
    credentialMaterialized: false,
    oauthConfigured: false,
    oauthConnected: false,
    discoveredTools: 0,
    exposedTools: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("PluginManager MCP ownership recovery", () => {
  it("adopts a compatible stale plugin-managed MCP instead of registering it twice", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-plugin-manager-"));
    const packageRoot = path.join(root, "package");
    const registryPath = path.join(root, "state", "plugin-hub.json");
    const skillStoreRoot = path.join(root, "skills");
    const stale = extension();
    const installCalls: unknown[] = [];
    const removeCalls: string[] = [];

    try {
      await mkdir(path.join(packageRoot, ".codex-plugin"), { recursive: true });
      await writeFile(
        path.join(packageRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "fixture",
          version: "1.0.0",
          description: "Fixture plugin",
          mcpServers: "./.mcp.json",
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(packageRoot, ".mcp.json"),
        `${JSON.stringify({
          remote: {
            type: "http",
            url: REMOTE_URL,
          },
        }, null, 2)}\n`,
        "utf8",
      );

      const fakeMcp = {
        list: async () => [stale],
        install: async (input: unknown) => {
          installCalls.push(input);
          throw new Error("duplicate registration should not be attempted");
        },
        enable: async () => stale,
        disable: async () => stale,
        remove: async (id: string) => {
          removeCalls.push(id);
          return { removed: true };
        },
        listTools: async () => [],
        updateToolPolicy: async () => undefined,
      } as unknown as McpExtensionManager;

      const manager = new PluginManager({
        mcp: fakeMcp,
        registryPath,
        skillStoreRoot,
      });

      const installed = await manager.installLocal(packageRoot);
      expect(installCalls).toHaveLength(0);
      expect(installed.createdMcpExtensions).toEqual([]);
      expect(installed.reusedMcpExtensions).toEqual([stale.id]);
      expect(installed.plugin.mcpExtensionIds).toEqual([stale.id]);

      const snapshot = await manager.list();
      expect(snapshot.mcpOwnership).toEqual([
        expect.objectContaining({
          extensionId: stale.id,
          owners: ["fixture"],
          directInstall: false,
        }),
      ]);

      await manager.remove("fixture");
      expect(removeCalls).toEqual([stale.id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers and completes SourceNerve OAuth before enabling a new remote plugin MCP", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-plugin-oauth-"));
    const packageRoot = path.join(root, "package");
    const registryPath = path.join(root, "state", "plugin-hub.json");
    const skillStoreRoot = path.join(root, "skills");
    const calls: string[] = [];
    const installInputs: unknown[] = [];

    try {
      await mkdir(path.join(packageRoot, ".codex-plugin"), { recursive: true });
      await writeFile(
        path.join(packageRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "oauth-fixture",
          version: "1.0.0",
          description: "OAuth fixture plugin",
          mcpServers: "./.mcp.json",
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(packageRoot, ".mcp.json"),
        `${JSON.stringify({
          remote: {
            type: "http",
            url: REMOTE_URL,
          },
        }, null, 2)}\n`,
        "utf8",
      );

      const installedView = extension({
        name: "OAuth Fixture · remote",
        source: "plugin-hub:oauth-fixture:remote:test",
        authType: "oauth",
        status: "installed",
        enabled: false,
        oauthConfigured: true,
      });
      const fakeMcp = {
        list: async () => [],
        install: async (input: unknown) => {
          calls.push("install");
          installInputs.push(input);
          return installedView;
        },
        connectOAuth: async (id: string) => {
          calls.push("oauth");
          return { extensionId: id, connected: true, message: "connected" };
        },
        enable: async () => {
          calls.push("enable");
          return { ...installedView, status: "enabled", enabled: true, oauthConnected: true };
        },
        disable: async () => installedView,
        remove: async () => ({ removed: true }),
        listTools: async () => {
          calls.push("list-tools");
          return [];
        },
        updateToolPolicy: async () => undefined,
      } as unknown as McpExtensionManager;

      const manager = new PluginManager({
        mcp: fakeMcp,
        registryPath,
        skillStoreRoot,
        discoverAuthorization: async (url) => {
          expect(url).toBe(REMOTE_URL);
          calls.push("discover");
          return {
            status: "oauth",
            source: "well-known",
            registration: "dynamic",
            scopes: ["read"],
            config: {
              authorizationEndpoint: "https://auth.example.com/authorize",
              tokenEndpoint: "https://auth.example.com/token",
              registrationEndpoint: "https://auth.example.com/register",
              scopes: ["read"],
              issuer: "https://auth.example.com/",
            },
            notes: [],
          };
        },
      });

      const installed = await manager.installLocal(packageRoot);
      expect(installed.createdMcpExtensions).toEqual([installedView.id]);
      expect(calls).toEqual(["discover", "install", "oauth", "enable", "list-tools"]);
      expect(installInputs).toEqual([
        expect.objectContaining({
          authType: "oauth",
          oauth: expect.objectContaining({
            authorizationEndpoint: "https://auth.example.com/authorize",
            tokenEndpoint: "https://auth.example.com/token",
          }),
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("installs and persists a skill-only plugin without changing the inspected content hash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-plugin-skill-hash-"));
    const packageRoot = path.join(root, "package");
    const registryPath = path.join(root, "state", "plugin-hub.json");
    const skillStoreRoot = path.join(root, "skills-store");

    try {
      await mkdir(path.join(packageRoot, ".codex-plugin"), { recursive: true });
      await mkdir(path.join(packageRoot, "skills", "repository-change-workflow"), { recursive: true });
      await writeFile(
        path.join(packageRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "skill-fixture",
          version: "1.0.0",
          description: "Skill hash fixture",
          skills: "./skills/",
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(packageRoot, "skills", "repository-change-workflow", "SKILL.md"),
        "# Repository change workflow\n\nUse a guarded branch workflow.\n",
        "utf8",
      );

      const fakeMcp = {
        list: async () => [],
        install: async () => {
          throw new Error("unexpected MCP install");
        },
        enable: async () => {
          throw new Error("unexpected MCP enable");
        },
        disable: async () => {
          throw new Error("unexpected MCP disable");
        },
        remove: async () => ({ removed: true }),
        listTools: async () => [],
        updateToolPolicy: async () => undefined,
      } as unknown as McpExtensionManager;

      const manager = new PluginManager({
        mcp: fakeMcp,
        registryPath,
        skillStoreRoot,
      });
      const installed = await manager.installLocal(packageRoot);

      expect(installed.plugin.id).toBe("skill-fixture");
      expect(installed.plugin.skills).toHaveLength(1);
      expect(installed.plugin.skills[0].id).toBe("repository-change-workflow");
      const snapshot = await manager.list();
      expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["skill-fixture"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("installs the official cached GitHub plugin through the native provider without copying PAT credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-plugin-github-native-"));
    const skillStoreRoot = path.join(root, "runtime", "skills");
    const packageRoot = path.join(root, "runtime", "plugin-marketplace-cache", "github");
    const registryPath = path.join(root, "state", "plugin-hub.json");
    const installCalls: unknown[] = [];

    try {
      await mkdir(path.join(packageRoot, ".codex-plugin"), { recursive: true });
      await mkdir(path.join(packageRoot, "skills", "github"), { recursive: true });
      await writeFile(
        path.join(packageRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "github",
          version: "0.1.6",
          description: "GitHub plugin",
          apps: "./.app.json",
          mcpServers: "./.mcp.json",
          skills: "./skills/",
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(packageRoot, ".app.json"),
        `${JSON.stringify({ apps: { github: { id: "connector_GitHub" } } }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(packageRoot, ".mcp.json"),
        `${JSON.stringify({
          github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            bearer_token_env_var: "GITHUB_PAT_TOKEN",
          },
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(packageRoot, "skills", "github", "SKILL.md"),
        "# GitHub\n\nUse the connected GitHub provider for repository workflows.\n",
        "utf8",
      );

      const fakeMcp = {
        list: async () => [],
        install: async (input: unknown) => {
          installCalls.push(input);
          throw new Error("GitHub PAT-backed MCP should not be installed");
        },
        enable: async () => { throw new Error("unexpected MCP enable"); },
        disable: async () => { throw new Error("unexpected MCP disable"); },
        remove: async () => ({ removed: true }),
        listTools: async () => [],
        updateToolPolicy: async () => undefined,
      } as unknown as McpExtensionManager;

      const manager = new PluginManager({
        mcp: fakeMcp,
        registryPath,
        skillStoreRoot,
        pluginRegistryUrl: DEFAULT_PLUGIN_REGISTRY_URL,
      });

      const installed = await manager.installLocal(packageRoot);
      expect(installCalls).toEqual([]);
      expect(installed.createdMcpExtensions).toEqual([]);
      expect(installed.plugin.mcpExtensionIds).toEqual([]);
      expect(installed.plugin.skills.map((skill) => skill.id)).toEqual(["github"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("does not install a self-referential MCP for the bundled SourceNerve plugin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-plugin-self-bundled-"));
    const packageRoot = path.join(root, "plugins", "sourcenerve");
    const registryPath = path.join(root, "state", "plugin-hub.json");
    const skillStoreRoot = path.join(root, "skills");
    const installCalls: unknown[] = [];

    try {
      await mkdir(path.join(packageRoot, ".codex-plugin"), { recursive: true });
      await writeFile(
        path.join(packageRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "sourcenerve",
          version: "0.3.0",
          description: "SourceNerve bundled plugin",
          mcpServers: "./.mcp.json",
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(packageRoot, ".mcp.json"),
        `${JSON.stringify({
          sourcenerve: { type: "http", url: "https://sourcenerve.example/mcp" },
        }, null, 2)}\n`,
        "utf8",
      );

      const fakeMcp = {
        list: async () => [],
        install: async (input: unknown) => {
          installCalls.push(input);
          throw new Error("bundled SourceNerve must use the built-in MCP runtime");
        },
        enable: async () => { throw new Error("unexpected MCP enable"); },
        disable: async () => { throw new Error("unexpected MCP disable"); },
        remove: async () => ({ removed: true }),
        listTools: async () => [],
        updateToolPolicy: async () => undefined,
      } as unknown as McpExtensionManager;

      const manager = new PluginManager({
        mcp: fakeMcp,
        registryPath,
        skillStoreRoot,
        repositoryRoot: root,
        discoverAuthorization: async () => {
          throw new Error("bundled SourceNerve must not discover public OAuth");
        },
      });

      const installed = await manager.installLocal(packageRoot);
      expect(installCalls).toEqual([]);
      expect(installed.createdMcpExtensions).toEqual([]);
      expect(installed.plugin.mcpExtensionIds).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("migrates an installed bundled SourceNerve plugin away from its public self-MCP", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-plugin-self-migrate-"));
    const registryPath = path.join(root, "state", "plugin-hub.json");
    const skillStoreRoot = path.join(root, "skills");
    const staleId = "plugin-sourcenerve-764ee3fdd9ad67a3";
    const removeCalls: string[] = [];

    try {
      await mkdir(path.dirname(registryPath), { recursive: true });
      await writeFile(
        registryPath,
        `${JSON.stringify({
          schemaVersion: 1,
          plugins: [{
            id: "sourcenerve",
            name: "SourceNerve",
            version: "0.2.0",
            description: "SourceNerve bundled plugin",
            source: { kind: "catalog", label: "sourcenerve" },
            status: "enabled",
            enabled: true,
            manifestHash: "b".repeat(64),
            mcpExtensionIds: [staleId],
            skills: [],
            installedAt: 1,
            updatedAt: 1,
          }],
          mcpOwnership: [{
            extensionId: staleId,
            definitionHash: "a".repeat(64),
            owners: ["sourcenerve"],
            directInstall: false,
          }],
        }, null, 2)}\n`,
        "utf8",
      );

      const stale = extension({
        id: staleId,
        name: "SourceNerve · sourcenerve",
        source: "plugin-hub:sourcenerve:sourcenerve:764ee3fdd9ad67a3",
      });
      const fakeMcp = {
        list: async () => [stale],
        remove: async (id: string) => {
          removeCalls.push(id);
          return { removed: true };
        },
      } as unknown as McpExtensionManager;

      const manager = new PluginManager({
        mcp: fakeMcp,
        registryPath,
        skillStoreRoot,
        repositoryRoot: root,
      });

      const snapshot = await manager.list();
      expect(snapshot.plugins[0].mcpExtensionIds).toEqual([]);
      expect(snapshot.mcpOwnership).toEqual([]);
      expect(removeCalls).toEqual([staleId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materializes installed skills with exact workspace scopes from repository signals", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-plugin-workspace-scope-"));
    const packageRoot = path.join(root, "package");
    const workspaceA = path.join(root, "workspace-a");
    const workspaceB = path.join(root, "workspace-b");
    const registryPath = path.join(root, "state", "plugin-hub.json");
    const skillStoreRoot = path.join(root, "runtime", "skills");
    const materializations: PluginRuntimeMaterialization[] = [];

    const managedWorkspace = (id: string, workspaceRoot: string): ManagedWorkspaceView => ({
      id,
      name: id,
      root: workspaceRoot,
      access: "read-write",
      remote: "origin",
      defaultBranch: "main",
      validation: { state: "ready" },
      head: "0".repeat(40),
      branch: "main",
      dirty: false,
      localWritable: true,
      index: { state: "not-indexed" },
    });

    try {
      await mkdir(path.join(packageRoot, ".codex-plugin"), { recursive: true });
      for (const skillId of ["repository-review", "react-components", "django-migrations"]) {
        await mkdir(path.join(packageRoot, "skills", skillId), { recursive: true });
      }
      await writeFile(
        path.join(packageRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "workspace-skills",
          version: "1.0.0",
          description: "Workspace scope fixture",
          skills: "./skills/",
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(packageRoot, "skills", "repository-review", "SKILL.md"),
        "# Repository Review\n\nReview repository changes before commit.\n",
        "utf8",
      );
      await writeFile(
        path.join(packageRoot, "skills", "react-components", "SKILL.md"),
        "# React Components\n\nImplement React and TypeScript UI components.\n",
        "utf8",
      );
      await writeFile(
        path.join(packageRoot, "skills", "django-migrations", "SKILL.md"),
        "# Django Migrations\n\nMaintain Django database migrations.\n",
        "utf8",
      );

      await mkdir(workspaceA, { recursive: true });
      await writeFile(
        path.join(workspaceA, "package.json"),
        `${JSON.stringify({ dependencies: { react: "19.0.0" }, devDependencies: { typescript: "5.9.0" } })}\n`,
        "utf8",
      );
      await mkdir(workspaceB, { recursive: true });
      await writeFile(
        path.join(workspaceB, "pyproject.toml"),
        "[project]\nname = \"django-service\"\ndependencies = [\"django>=5\"]\n",
        "utf8",
      );

      const fakeMcp = {
        list: async () => [],
        install: async () => { throw new Error("unexpected MCP install"); },
        enable: async () => { throw new Error("unexpected MCP enable"); },
        disable: async () => { throw new Error("unexpected MCP disable"); },
        remove: async () => ({ removed: true }),
        listTools: async () => [],
        updateToolPolicy: async () => undefined,
      } as unknown as McpExtensionManager;

      const manager = new PluginManager({
        mcp: fakeMcp,
        registryPath,
        skillStoreRoot,
        workspaces: {
          listManagedWorkspaces: async () => [
            managedWorkspace("workspace-a", workspaceA),
            managedWorkspace("workspace-b", workspaceB),
          ],
        },
        runtime: {
          materialize: async (input) => {
            materializations.push(structuredClone(input));
          },
        },
      });

      await manager.installLocal(packageRoot);
      const latest = materializations.at(-1);
      expect(latest).toBeDefined();
      const scopes = Object.fromEntries(
        latest!.skills.map((skill) => [skill.skillId, skill.workspaceIds]),
      );
      expect(scopes["repository-review"]).toEqual(["workspace-a", "workspace-b"]);
      expect(scopes["react-components"]).toEqual(["workspace-a"]);
      expect(scopes["django-migrations"]).toEqual(["workspace-b"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("auto-install accepts matching skills-only packages and rejects MCP or Harness packages", () => {
    const baseReview = {
      id: "react-guidance",
      name: "React Guidance",
      version: "1.0.0",
      description: "React guidance",
      source: { kind: "catalog" as const, label: "react-guidance" },
      manifestHash: "a".repeat(64),
      mcpServers: [],
      skills: [{
        id: "react-components",
        name: "React Components",
        description: "Implement React UI components",
        relativePath: "skills/react-components/SKILL.md",
        contentHash: "b".repeat(64),
        bytes: 42,
      }],
      warnings: [],
    };

    expect(isSafeSkillsOnlyAutoInstall(baseReview, ["react"])).toBe(true);
    expect(isSafeSkillsOnlyAutoInstall(baseReview, ["django"])).toBe(false);
    expect(isSafeSkillsOnlyAutoInstall({
      ...baseReview,
      mcpServers: [{
        id: "remote",
        name: "remote",
        transport: { kind: "streamable-http" as const, url: "https://example.com/mcp" },
        auth: "none" as const,
        definitionHash: "c".repeat(64),
      }],
    }, ["react"])).toBe(false);
    expect(isSafeSkillsOnlyAutoInstall({
      ...baseReview,
      harness: {
        configHash: "d".repeat(64),
        policyInterceptors: [],
        jobProviders: [],
        sandboxProviders: [],
        contextProviders: [],
        eventObservers: [],
      },
    }, ["react"])).toBe(false);
  });

  it("reconciles immediately when automatic skills-only install is enabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-plugin-auto-install-policy-"));
    const workspaceRoot = path.join(root, "workspace");
    const registryPath = path.join(root, "state", "plugin-hub.json");
    const skillStoreRoot = path.join(root, "runtime", "skills");
    await mkdir(workspaceRoot, { recursive: true });

    const fakeMcp = {
      list: async () => [],
    } as unknown as McpExtensionManager;
    const workspace: ManagedWorkspaceView = {
      id: "workspace-a",
      name: "Workspace A",
      root: workspaceRoot,
      access: "read-write",
      remote: "origin",
      defaultBranch: "main",
      validation: { state: "ready" },
      head: "0".repeat(40),
      branch: "main",
      dirty: false,
      localWritable: true,
      index: { state: "not-indexed" },
    };

    try {
      const manager = new PluginManager({
        mcp: fakeMcp,
        registryPath,
        skillStoreRoot,
        workspaces: { listManagedWorkspaces: async () => [workspace] },
      });
      const expected = {
        policy: {
          workspaceId: "workspace-a",
          discovery: "automatic" as const,
          use: "automatic" as const,
          install: "skills-only" as const,
          include: [],
          exclude: [],
          updatedAt: 1,
        },
        signals: [],
        activeSkillKeys: [],
        recommendations: [],
        autoInstalledPluginIds: [],
      };
      const reconcile = vi.spyOn(manager, "reconcileWorkspaceSkills").mockResolvedValue(expected);

      await expect(manager.setSkillPolicy({
        workspaceId: "workspace-a",
        discovery: "automatic",
        use: "automatic",
        install: "skills-only",
        include: [],
        exclude: [],
      })).resolves.toEqual(expected);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith("workspace-a");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
