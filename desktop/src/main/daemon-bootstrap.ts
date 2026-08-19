import { access } from "node:fs/promises";

import type { DesktopBootstrapState } from "./bootstrap";
import type { DaemonLaunchPlan } from "./daemon-manager";
import { materializeRuntime } from "./runtime-profile";
import { loadWorkspaceRegistry } from "./workspace-store";

export async function existingDaemonLaunchPlan(
  bootstrap: DesktopBootstrapState,
): Promise<DaemonLaunchPlan | null> {
  const managedWorkspaces = await loadWorkspaceRegistry(bootstrap.paths.workspaceRegistryPath);
  if (managedWorkspaces !== null) {
    if (managedWorkspaces.length === 0) return null;
    const credentials = await runtimeCredentials(bootstrap);
    const runtime = await materializeRuntime({
      productProfile: bootstrap.profile,
      configPath: bootstrap.paths.configPath,
      stateDirectory: bootstrap.paths.stateDirectory,
      localBearer: credentials.localBearer,
      workspaces: managedWorkspaces,
      githubToken: credentials.githubToken,
      gitlabToken: credentials.gitlabToken,
    });
    return {
      configPath: runtime.configPath,
      environment: runtime.environment,
      redactedSecrets: credentials.redactedSecrets,
    };
  }

  try {
    await access(bootstrap.paths.configPath);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }

  const credentials = await runtimeCredentials(bootstrap);
  return {
    configPath: bootstrap.paths.configPath,
    environment: {
      SOURCENERVE_CONFIG: bootstrap.paths.configPath,
      SOURCENERVE_BEARER_TOKEN: credentials.localBearer,
      SOURCENERVE_OAUTH_ISSUER: bootstrap.profile.auth0.issuer,
      SOURCENERVE_OAUTH_RESOURCE: bootstrap.profile.auth0.audience,
      SOURCENERVE_OAUTH_ALLOW_OPERATOR_BEARER: "false",
      ...(credentials.githubToken
        ? { SOURCENERVE_GITHUB_TOKEN: credentials.githubToken }
        : {}),
      ...(credentials.gitlabToken
        ? { SOURCENERVE_GITLAB_TOKEN: credentials.gitlabToken }
        : {}),
    },
    redactedSecrets: credentials.redactedSecrets,
  };
}

async function runtimeCredentials(bootstrap: DesktopBootstrapState): Promise<{
  localBearer: string;
  githubToken: string | null;
  gitlabToken: string | null;
  redactedSecrets: string[];
}> {
  const localBearer = await bootstrap.secretStore.get("localBearer");
  if (!localBearer) throw new Error("SourceNerve local bearer is unavailable");
  const [githubToken, gitlabToken] = await Promise.all([
    bootstrap.secretStore.get("githubToken"),
    bootstrap.secretStore.get("gitlabToken"),
  ]);
  return {
    localBearer,
    githubToken,
    gitlabToken,
    redactedSecrets: [
      localBearer,
      ...(githubToken ? [githubToken] : []),
      ...(gitlabToken ? [gitlabToken] : []),
    ],
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
