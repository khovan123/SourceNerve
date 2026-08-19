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
    });
    return {
      configPath: runtime.configPath,
      environment: runtime.environment,
      redactedSecrets: credentials.redactedSecrets,
    };
  }

  // Backward-compatible unmanaged setup. #73 owns importing this configuration
  // into the Desktop-managed workspace registry; do not rewrite it here.
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
      ...(credentials.githubToken ? { SOURCENERVE_GITHUB_TOKEN: credentials.githubToken } : {}),
    },
    redactedSecrets: credentials.redactedSecrets,
  };
}

async function runtimeCredentials(bootstrap: DesktopBootstrapState): Promise<{
  localBearer: string;
  githubToken: string | null;
  redactedSecrets: string[];
}> {
  const localBearer = await bootstrap.secretStore.get("localBearer");
  if (!localBearer) throw new Error("SourceNerve local bearer is unavailable");
  const githubToken = await bootstrap.secretStore.get("githubToken");
  return {
    localBearer,
    githubToken,
    redactedSecrets: [localBearer, ...(githubToken ? [githubToken] : [])],
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
