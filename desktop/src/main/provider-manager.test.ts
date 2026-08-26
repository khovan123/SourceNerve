import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DesktopBootstrapState } from "./bootstrap";
import type { ProviderCliClient } from "./provider-cli";
import { ProviderManager } from "./provider-manager";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ProviderManager", () => {
  it("detects an authenticated gh CLI session without persisting a provider token", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-provider-"));
    temporaryDirectories.push(directory);
    const events: string[] = [];
    const cli = stubCli();
    const manager = new ProviderManager({
      bootstrap: bootstrap(directory),
      workspaceManager: { listManagedWorkspaces: async () => [] } as never,
      cliClient: cli,
      onEvent: (event) => {
        if (event.type === "state") events.push(`${event.component}:${event.state}`);
      },
      now: () => 123456789,
    });

    const state = await manager.connect("github");
    expect(state.status).toBe("connected");
    expect(state.login).toBe("desktop-user");
    expect(state.connectedAt).toBe(123456789);
    expect(events).toContain("git:connected");

    const metadata = await readFile(path.join(directory, "provider-sessions.json"), "utf8");
    expect(metadata).toContain("desktop-user");
    expect(metadata).not.toContain("provider-token");
    expect(metadata).not.toContain("oauth");
  });

  it("surfaces CLI setup guidance when the external session is unavailable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-provider-"));
    temporaryDirectories.push(directory);
    const cli = stubCli();
    cli.account = async () => {
      throw new Error("GitHub CLI 'gh' is not installed. Install it, run 'gh auth login --hostname github.com', then retry.");
    };
    const manager = new ProviderManager({
      bootstrap: bootstrap(directory),
      workspaceManager: { listManagedWorkspaces: async () => [] } as never,
      cliClient: cli,
    });

    await manager.initialize();
    const state = manager.state("github");
    expect(state.status).toBe("disconnected");
    expect(state.error).toMatch(/gh auth login/);
    await expect(manager.connect("github")).rejects.toThrow(/gh auth login/);
  });

  it("lists and validates repositories through the CLI client", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-provider-"));
    temporaryDirectories.push(directory);
    const cli = stubCli();
    const manager = new ProviderManager({
      bootstrap: bootstrap(directory),
      workspaceManager: { listManagedWorkspaces: async () => [] } as never,
      cliClient: cli,
    });

    await manager.connect("github");
    const repositories = await manager.listRepositories("github");
    expect(repositories).toHaveLength(1);
    expect(repositories[0].slug).toBe("example/repo");
    const repository = await manager.validateRepository("github", "example/repo");
    expect(repository.writable).toBe(true);
  });

  it("lists bounded repository pull requests through the authenticated CLI client", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-provider-"));
    temporaryDirectories.push(directory);
    const cli = stubCli();
    const manager = new ProviderManager({
      bootstrap: bootstrap(directory),
      workspaceManager: { listManagedWorkspaces: async () => [] } as never,
      cliClient: cli,
    });

    await manager.connect("github");
    const pulls = await manager.listPullRequests("github", "example/repo", "open", 25);
    expect(pulls).toEqual([
      expect.objectContaining({
        provider: "github",
        repository: "example/repo",
        number: 12,
        title: "feat: provider browser",
        state: "open",
      }),
    ]);
  });

  it("does not log out the external CLI when SourceNerve disconnects", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-provider-"));
    temporaryDirectories.push(directory);
    const cli = stubCli();
    let accountCalls = 0;
    const originalAccount = cli.account;
    cli.account = async (provider) => {
      accountCalls += 1;
      return originalAccount(provider);
    };
    const manager = new ProviderManager({
      bootstrap: bootstrap(directory),
      workspaceManager: { listManagedWorkspaces: async () => [] } as never,
      cliClient: cli,
    });

    await manager.connect("github");
    const disconnected = await manager.disconnect("github");
    expect(disconnected.status).toBe("disconnected");
    expect(disconnected.error).toMatch(/CLI login was not modified/);
    expect(accountCalls).toBe(1);
  });
});

function bootstrap(directory: string): DesktopBootstrapState {
  return {
    profile: {
      gitProviders: {
        github: { cli: "gh", hostname: "github.com", apiBaseUrl: "https://api.github.com" },
        gitlab: { cli: "glab", hostname: "gitlab.com", apiBaseUrl: "https://gitlab.com/api/v4" },
      },
    },
    paths: { managedDirectory: directory },
  } as unknown as DesktopBootstrapState;
}

function stubCli(): ProviderCliClient {
  return {
    async account(provider) {
      return provider === "github"
        ? { login: "desktop-user", name: "Desktop User", providerUserId: "123" }
        : { login: "gitlab-user", name: "GitLab User", providerUserId: "456" };
    },
    async repositories(provider) {
      return [repository(provider)];
    },
    async repository(provider) {
      return repository(provider);
    },
    async pulls(provider, repositorySlug) {
      return [{
        provider,
        repository: repositorySlug,
        number: 12,
        title: "feat: provider browser",
        state: "open",
        draft: false,
        baseBranch: "main",
        headBranch: "feat/browser",
        headSha: "a".repeat(40),
        author: "desktop-user",
        updatedAt: "2026-08-26T12:00:00.000Z",
        url: provider === "github"
          ? "https://github.com/example/repo/pull/12"
          : "https://gitlab.com/example/repo/-/merge_requests/12",
      }];
    },
    async token() {
      return "provider-token-" + "T".repeat(48);
    },
  };
}

function repository(provider: "github" | "gitlab") {
  return {
    provider,
    slug: "example/repo",
    name: "repo",
    defaultBranch: "main",
    private: true,
    writable: true,
    webUrl: provider === "github" ? "https://github.com/example/repo" : "https://gitlab.com/example/repo",
    httpsCloneUrl: provider === "github" ? "https://github.com/example/repo.git" : "https://gitlab.com/example/repo.git",
  } as const;
}
