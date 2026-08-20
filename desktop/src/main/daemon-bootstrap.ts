import { access } from "node:fs/promises";

import type { DesktopBootstrapState } from "./bootstrap";
import type { DaemonLaunchPlan } from "./daemon-manager";
import { materializeRuntime } from "./runtime-profile";
import { resolveManagedStateDirectory } from "./state-location";
import { loadWorkspaceRegistry } from "./workspace-store";

const OPENAI_APPS_CHALLENGE_ENV = "SOURCENERVE_OPENAI_APPS_CHALLENGE";

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
      stateDirectory: await resolveManagedStateDirectory(bootstrap),
      localBearer: credentials.localBearer,
      workspaces: managedWorkspaces,
      githubToken: credentials.githubToken,
      gitlabToken: credentials.gitlabToken,
    });
    return {
      configPath: runtime.configPath,
      environment: withPluginChallenge(runtime.environment, credentials.pluginChallengeToken),
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
    environment: withPluginChallenge({
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
    }, credentials.pluginChallengeToken),
    redactedSecrets: credentials.redactedSecrets,
  };
}

async function runtimeCredentials(bootstrap: DesktopBootstrapState): Promise<{
  localBearer: string;
  githubToken: string | null;
  gitlabToken: string | null;
  pluginChallengeToken: string | null;
  redactedSecrets: string[];
}> {
  const localBearer = await bootstrap.secretStore.get("localBearer");
  if (!localBearer) throw new Error("SourceNerve local bearer is unavailable");
  const [githubToken, gitlabToken, pluginChallengeToken] = await Promise.all([
    bootstrap.secretStore.get("githubToken"),
    bootstrap.secretStore.get("gitlabToken"),
    bootstrap.secretStore.get("pluginChallengeToken"),
  ]);
  if (pluginChallengeToken) validatePluginChallengeToken(pluginChallengeToken);
  return {
    localBearer,
    githubToken,
    gitlabToken,
    pluginChallengeToken,
    redactedSecrets: [
      localBearer,
      ...(githubToken ? [githubToken] : []),
      ...(gitlabToken ? [gitlabToken] : []),
      ...(pluginChallengeToken ? [pluginChallengeToken] : []),
    ],
  };
}

export function withPluginChallenge(
  environment: NodeJS.ProcessEnv,
  token: string | null,
): NodeJS.ProcessEnv {
  if (!token) return { ...environment };
  validatePluginChallengeToken(token);
  return { ...environment, [OPENAI_APPS_CHALLENGE_ENV]: token };
}

function validatePluginChallengeToken(value: string): void {
  if (Buffer.byteLength(value, "utf8") > 1024 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error("plugin challenge token must be 1-1024 ASCII graphic characters");
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
