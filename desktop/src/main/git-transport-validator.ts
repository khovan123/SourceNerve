import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

import type { GitTransportValidation } from "../shared/desktop-api";
import type { WorkspaceManager } from "./workspace-manager";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 12_000;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;

export async function validateWorkspaceGitTransport(
  workspaceManager: WorkspaceManager,
  workspaceId: string,
): Promise<GitTransportValidation> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(workspaceId)) {
    throw new Error("invalid workspace id");
  }
  const workspace = (await workspaceManager.listManagedWorkspaces()).find(
    (candidate) => candidate.id === workspaceId,
  );
  if (!workspace) throw new Error(`workspace '${workspaceId}' is not registered`);
  if (workspace.validation.state !== "ready") {
    throw new Error(`workspace '${workspaceId}' must be repaired before Git transport validation`);
  }

  const usePushTransport = workspace.access === "read-write";
  const remoteUrl = (
    await git(
      workspace.root,
      usePushTransport
        ? ["remote", "get-url", "--push", workspace.remote]
        : ["remote", "get-url", workspace.remote],
      false,
    )
  ).trim();
  const transport = classifyGitTransport(remoteUrl);

  try {
    if (usePushTransport) {
      const checkRef = `refs/heads/sourcenerve-connectivity-check-${process.pid}-${randomBytes(6).toString("hex")}`;
      await git(
        workspace.root,
        ["push", "--dry-run", "--porcelain", "--no-verify", workspace.remote, `HEAD:${checkRef}`],
        true,
      );
      return {
        workspace: workspaceId,
        ready: true,
        transport,
        message: `Non-interactive ${transport.toUpperCase()} Git write transport is ready (dry-run only; no remote ref was created).`,
      };
    }

    await git(workspace.root, ["ls-remote", "--exit-code", workspace.remote, "HEAD"], true);
    return {
      workspace: workspaceId,
      ready: true,
      transport,
      message: `Non-interactive ${transport.toUpperCase()} Git read transport is ready. This workspace is read-only, so push credentials are not required.`,
    };
  } catch {
    return {
      workspace: workspaceId,
      ready: false,
      transport,
      message: transportFailureMessage(transport, usePushTransport),
    };
  }
}

async function git(cwd: string, args: string[], network: boolean): Promise<string> {
  const environment: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    ...(network
      ? {
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes",
        }
      : {}),
  };
  for (const name of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "LANG", "LC_ALL"] as const) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: environment,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
  });
  return stdout;
}

function classifyGitTransport(value: string): "ssh" | "https" | "other" {
  if (/^(?:[^@\s]+@)?[^:\s/]+:.+/.test(value) && !value.includes("://")) return "ssh";
  try {
    const url = new URL(value);
    if (url.protocol === "ssh:") return "ssh";
    if (url.protocol === "https:") return "https";
  } catch {
    return "other";
  }
  return "other";
}

function transportFailureMessage(
  transport: "ssh" | "https" | "other",
  writeCheck: boolean,
): string {
  if (!writeCheck) {
    if (transport === "ssh") {
      return "Non-interactive SSH read failed. Check SSH agent/key availability and known_hosts, then retry.";
    }
    if (transport === "https") {
      return "Non-interactive HTTPS read failed. Check repository access or configure a Git credential helper, then retry.";
    }
    return "Non-interactive Git read failed for the configured remote. Repair the remote or credentials, then retry.";
  }
  if (transport === "ssh") {
    return "Git push dry-run failed. Check SSH agent/key availability, known_hosts, repository write permission, and provider branch-creation policy; SourceNerve did not create a remote ref.";
  }
  if (transport === "https") {
    return "Git push dry-run failed. Configure a non-interactive Git credential helper with repository write access, then retry; SourceNerve did not create a remote ref.";
  }
  return "Git push dry-run failed for the configured remote. Repair non-interactive write credentials or remote policy, then retry; no remote ref was created.";
}
