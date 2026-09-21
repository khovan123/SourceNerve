import { unlink } from "node:fs/promises";

import type { ManagedWorkspaceView } from "../shared/desktop-api";
import type { DesktopBootstrapState } from "./bootstrap";
import type { DaemonManager } from "./daemon-manager";
import { providerCliToken } from "./provider-cli";
import { materializeRuntime, type ManagedWorkspace } from "./runtime-profile";
import type { WorkspaceManager } from "./workspace-manager";

const DAEMON_STABLE_TIMEOUT_MS = 75_000;
const DAEMON_STABLE_POLL_MS = 100;

export interface WorkspaceGrantManagerOptions {
  bootstrap: DesktopBootstrapState;
  daemonManager: DaemonManager;
  workspaceManager: WorkspaceManager;
}

// Reconciles the managed workspace registry into the local daemon runtime.
export class WorkspaceGrantManager {
  private readonly bootstrap: DesktopBootstrapState;
  private readonly daemonManager: DaemonManager;
  private readonly workspaceManager: WorkspaceManager;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceGrantManagerOptions) {
    this.bootstrap = options.bootstrap;
    this.daemonManager = options.daemonManager;
    this.workspaceManager = options.workspaceManager;
  }

  async initialize(): Promise<void> {
    // No identity or grant registry is required in personal No Auth mode.
  }

  workspaceChanged(): Promise<void> {
    return this.enqueueMutation(async () => {
      const views = await this.workspaceManager.listManagedWorkspaces();
      await this.applyRuntime(views.map(toManagedWorkspace));
    });
  }

  private async applyRuntime(workspaces: ManagedWorkspace[]): Promise<void> {
    const current = await this.waitForDaemonStable();
    if (
      !current.managed &&
      (current.state === "external" || current.state === "incompatible")
    ) {
      throw new Error(
        "cannot update managed workspaces while an external SourceNerve daemon owns the local port",
      );
    }

    if (workspaces.length === 0) {
      if (current.managed && current.state !== "stopped") {
        await this.daemonManager.stop();
      }
      await unlink(this.bootstrap.paths.configPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      return;
    }

    const localBearer = await this.bootstrap.secretStore.get("localBearer");
    if (!localBearer) throw new Error("SourceNerve local bearer is unavailable");
    const [githubToken, gitlabToken] = await Promise.all([
      workspaces.some((workspace) => workspace.provider === "github")
        ? optionalProviderToken("github")
        : Promise.resolve(null),
      workspaces.some((workspace) => workspace.provider === "gitlab")
        ? optionalProviderToken("gitlab")
        : Promise.resolve(null),
    ]);
    const materialized = await materializeRuntime({
      productProfile: this.bootstrap.profile,
      configPath: this.bootstrap.paths.configPath,
      stateDirectory: this.bootstrap.paths.stateDirectory,
      localBearer,
      workspaces,
      githubToken,
      gitlabToken,
    });
    this.daemonManager.configure({
      configPath: materialized.configPath,
      environment: materialized.environment,
      redactedSecrets: [
        localBearer,
        ...(githubToken ? [githubToken] : []),
        ...(gitlabToken ? [gitlabToken] : []),
      ],
    });

    const stable = await this.waitForDaemonStable();
    const result =
      stable.managed && stable.state === "ready"
        ? await this.daemonManager.restart()
        : stable.state === "stopped" || stable.state === "crashed"
          ? await this.daemonManager.start()
          : stable;
    if (result.state !== "ready" || !result.managed) {
      throw new Error(
        "managed SourceNerve daemon did not become ready after applying workspace changes",
      );
    }
  }

  private async waitForDaemonStable() {
    const deadline = Date.now() + DAEMON_STABLE_TIMEOUT_MS;
    while (true) {
      const snapshot = this.daemonManager.snapshot();
      if (snapshot.state !== "starting" && snapshot.state !== "stopping") return snapshot;
      if (Date.now() >= deadline) {
        throw new Error(
          "SourceNerve daemon did not finish the current lifecycle operation before workspace reconciliation timed out",
        );
      }
      await delay(DAEMON_STABLE_POLL_MS);
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

async function optionalProviderToken(
  provider: "github" | "gitlab",
): Promise<string | null> {
  try {
    return await providerCliToken(provider);
  } catch {
    return null;
  }
}

function toManagedWorkspace(workspace: ManagedWorkspaceView): ManagedWorkspace {
  return {
    id: workspace.id,
    name: workspace.name,
    root: workspace.root,
    access: workspace.access,
    remote: workspace.remote,
    defaultBranch: workspace.defaultBranch,
    ...(workspace.provider ? { provider: workspace.provider } : {}),
    ...(workspace.repository ? { repository: workspace.repository } : {}),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
