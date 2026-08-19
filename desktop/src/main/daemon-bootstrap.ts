import { access } from "node:fs/promises";

import type { DesktopBootstrapState } from "./bootstrap";
import type { DaemonLaunchPlan } from "./daemon-manager";

export async function existingDaemonLaunchPlan(
  bootstrap: DesktopBootstrapState,
): Promise<DaemonLaunchPlan | null> {
  try {
    await access(bootstrap.paths.configPath);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }

  const localBearer = await bootstrap.secretStore.get("localBearer");
  if (!localBearer) throw new Error("SourceNerve local bearer is unavailable");
  const githubToken = await bootstrap.secretStore.get("githubToken");
  const gitlabToken = await bootstrap.secretStore.get("gitlabToken");

  const environment: NodeJS.ProcessEnv = {
    SOURCENERVE_CONFIG: bootstrap.paths.configPath,
    SOURCENERVE_BEARER_TOKEN: localBearer,
    SOURCENERVE_OAUTH_ISSUER: bootstrap.profile.auth0.issuer,
    SOURCENERVE_OAUTH_RESOURCE: bootstrap.profile.auth0.audience,
    SOURCENERVE_OAUTH_ALLOW_OPERATOR_BEARER: "false",
  };
  if (githubToken) environment.SOURCENERVE_GITHUB_TOKEN = githubToken;
  if (gitlabToken) environment.SOURCENERVE_GITLAB_TOKEN = gitlabToken;

  return {
    configPath: bootstrap.paths.configPath,
    environment,
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
