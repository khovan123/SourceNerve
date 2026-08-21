import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Auth0Identity, ManagedWorkspaceView } from "../shared/desktop-api";
import type { DesktopBootstrapState } from "./bootstrap";
import type { DaemonManager } from "./daemon-manager";
import { providerCliToken } from "./provider-cli";
import {
  materializeRuntime,
  type ManagedWorkspace,
  type OAuthGrant,
} from "./runtime-profile";
import type { WorkspaceManager } from "./workspace-manager";

const GRANT_SCHEMA_VERSION = 1 as const;
const DAEMON_STABLE_TIMEOUT_MS = 25_000;
const DAEMON_STABLE_POLL_MS = 100;

interface GrantRegistry {
  schemaVersion: typeof GRANT_SCHEMA_VERSION;
  grants: OAuthGrant[];
}

export interface WorkspaceGrantManagerOptions {
  bootstrap: DesktopBootstrapState;
  daemonManager: DaemonManager;
  workspaceManager: WorkspaceManager;
}

export class WorkspaceGrantManager {
  private readonly bootstrap: DesktopBootstrapState;
  private readonly daemonManager: DaemonManager;
  private readonly workspaceManager: WorkspaceManager;
  private readonly filePath: string;
  private grants: OAuthGrant[] = [];
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceGrantManagerOptions) {
    this.bootstrap = options.bootstrap;
    this.daemonManager = options.daemonManager;
    this.workspaceManager = options.workspaceManager;
    this.filePath = path.join(options.bootstrap.paths.managedDirectory, "oauth-grants.json");
  }

  async initialize(): Promise<void> {
    this.grants = await readRegistry(this.filePath);
    await this.reconcileRemovedAndAccessChangedWorkspaces(false);
  }

  effectiveFor(subject: string): OAuthGrant[] {
    return this.grants
      .filter((grant) => grant.subject === subject)
      .map((grant) => ({ ...grant }))
      .sort((a, b) => a.workspace.localeCompare(b.workspace));
  }

  grantCurrentIdentity(identity: Auth0Identity): Promise<OAuthGrant[]> {
    return this.enqueueMutation(() => this.grantCurrentIdentityNow(identity));
  }

  workspaceChanged(currentIdentity?: Auth0Identity): Promise<void> {
    return this.enqueueMutation(async () => {
      if (currentIdentity) {
        await this.grantCurrentIdentityNow(currentIdentity);
        return;
      }
      await this.reconcileRemovedAndAccessChangedWorkspaces(true);
    });
  }

  private async grantCurrentIdentityNow(identity: Auth0Identity): Promise<OAuthGrant[]> {
    const workspaces = await this.workspaceManager.listManagedWorkspaces();
    const byKey = new Map(this.grants.map((grant) => [`${grant.subject}\u0000${grant.workspace}`, grant]));
    for (const workspace of workspaces) {
      if (workspace.validation.state !== "ready") continue;
      byKey.set(`${identity.subject}\u0000${workspace.id}`, {
        subject: identity.subject,
        workspace: workspace.id,
        access: workspace.access,
      });
    }
    this.grants = [...byKey.values()];
    await this.reconcileRemovedAndAccessChangedWorkspaces(true);
    return this.effectiveFor(identity.subject);
  }

  private async reconcileRemovedAndAccessChangedWorkspaces(applyRuntime: boolean): Promise<void> {
    const views = await this.workspaceManager.listManagedWorkspaces();
    const workspaceById = new Map(views.map((workspace) => [workspace.id, workspace]));
    const next = this.grants
      .filter((grant) => workspaceById.has(grant.workspace))
      .map((grant) => {
        const workspace = workspaceById.get(grant.workspace)!;
        return {
          ...grant,
          access:
            workspace.access === "read-only" || grant.access === "read-only"
              ? "read-only"
              : "read-write",
        } satisfies OAuthGrant;
      });
    const changed = JSON.stringify(next) !== JSON.stringify(this.grants);
    this.grants = next;
    if (changed || applyRuntime) await writeRegistry(this.filePath, this.grants);
    if (applyRuntime) await this.applyRuntime(views.map(toManagedWorkspace));
  }

  private async applyRuntime(workspaces: ManagedWorkspace[]): Promise<void> {
    const current = await this.waitForDaemonStable();
    if (!current.managed && (current.state === "external" || current.state === "incompatible")) {
      throw new Error("cannot update Auth0 workspace grants while an external SourceNerve daemon owns the local port");
    }

    if (workspaces.length === 0) {
      if (current.managed && current.state !== "stopped") await this.daemonManager.stop();
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
      oauthGrants: this.grants,
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
      throw new Error("managed SourceNerve daemon did not become ready after applying Auth0 workspace grants");
    }
  }

  private async waitForDaemonStable() {
    const deadline = Date.now() + DAEMON_STABLE_TIMEOUT_MS;
    while (true) {
      const snapshot = this.daemonManager.snapshot();
      if (snapshot.state !== "starting" && snapshot.state !== "stopping") return snapshot;
      if (Date.now() >= deadline) {
        throw new Error("SourceNerve daemon did not finish the current lifecycle operation before workspace reconciliation timed out");
      }
      await delay(DAEMON_STABLE_POLL_MS);
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

export async function readPersistedWorkspaceGrants(managedDirectory: string): Promise<OAuthGrant[]> {
  return readRegistry(path.join(managedDirectory, "oauth-grants.json"));
}

async function optionalProviderToken(provider: "github" | "gitlab"): Promise<string | null> {
  try {
    return await providerCliToken(provider);
  } catch {
    // Keep local repository intelligence available when a provider CLI session is
    // unavailable. Remote provider lifecycle operations remain unavailable.
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

async function readRegistry(filePath: string): Promise<OAuthGrant[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) throw new Error("Desktop OAuth grant registry exceeds 1 MB");
    const parsed = JSON.parse(raw) as Partial<GrantRegistry>;
    if (parsed.schemaVersion !== GRANT_SCHEMA_VERSION || !Array.isArray(parsed.grants)) {
      throw new Error("unsupported Desktop OAuth grant registry schema");
    }
    return parsed.grants.map(validateGrant);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeRegistry(filePath: string, grants: OAuthGrant[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  const payload: GrantRegistry = { schemaVersion: GRANT_SCHEMA_VERSION, grants };
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function validateGrant(value: unknown): OAuthGrant {
  if (!value || typeof value !== "object") throw new Error("invalid Desktop OAuth grant registry entry");
  const grant = value as Partial<OAuthGrant>;
  if (
    typeof grant.subject !== "string" ||
    grant.subject.length < 1 ||
    grant.subject.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(grant.subject) ||
    typeof grant.workspace !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(grant.workspace) ||
    (grant.access !== "read-only" && grant.access !== "read-write")
  ) {
    throw new Error("invalid Desktop OAuth grant registry entry");
  }
  return { subject: grant.subject, workspace: grant.workspace, access: grant.access };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
