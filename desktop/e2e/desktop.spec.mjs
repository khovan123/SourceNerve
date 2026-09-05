import { _electron as electron, expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowHarness = path.join(desktopRoot, "e2e", "electron-harness.mjs");
const migrationRecoveryHarness = path.join(desktopRoot, "e2e", "migration-recovery-harness.mjs");

async function launchDesktop(harness = workflowHarness) {
  const profileDir = path.join(os.tmpdir(), `sourcenerve-e2e-${process.pid}-${randomUUID()}`);
  const electronApp = await electron.launch({
    args: [harness, `--user-data-dir=${profileDir}`],
    cwd: desktopRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const page = await electronApp.firstWindow();
  page.on("dialog", (dialog) => void dialog.accept());
  await page.waitForLoadState("domcontentloaded");
  return { electronApp, page };
}

async function addWorkspace(page, access = "read-write") {
  await page.getByRole("link", { name: "Workspaces" }).click();
  await page.getByRole("button", { name: "Add workspace" }).click();
  await expect(page.getByText("Workspace setup").first()).toBeVisible();
  await page.getByLabel("Access").selectOption(access);
  await page.getByRole("button", { name: "Save workspace" }).click();
  await expect(page.getByRole("heading", { name: "E2E Workspace", exact: true })).toBeVisible();
}

async function completeCodexBootstrap(page) {
  await expect(page.getByRole("heading", { name: "Set up SourceNerve" })).toBeVisible();
  await expect(page.getByText(/Auth0, Public MCP, and Git-provider connections are optional integrations/)).toBeVisible();
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByText("Codex + ChatGPT", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Install Codex" }).click();
  await expect(page.getByText("Codex 0.153.4", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  await expect(page.getByText("Workspace", { exact: true }).first()).toBeVisible();
}

test("clean install reaches Ready with workspace-scoped Harness and a browse-only Pull Requests screen", async () => {
  const { electronApp, page } = await launchDesktop();
  try {
    await completeCodexBootstrap(page);
    await addWorkspace(page, "read-write");

    await page.getByRole("link", { name: "Harness" }).click();
    const harnessWorkspacePolicies = page.getByLabel("Harness workspace policies");
    await expect(harnessWorkspacePolicies).toBeVisible();
    await expect(harnessWorkspacePolicies.getByText("E2E Workspace", { exact: true })).toBeVisible();
    await expect(harnessWorkspacePolicies.locator("select")).toHaveCount(0);
    await expect(harnessWorkspacePolicies.getByRole("button", { name: /^Workspace write\b/ })).toBeVisible();

    await expect(page.getByRole("link", { name: /Tasks/ })).toHaveCount(0);
    await page.evaluate(() => { window.location.hash = "#/tasks"; });
    await expect(page.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");

    await page.getByRole("link", { name: "Pull Requests" }).click();
    const repositoryPulls = page.getByLabel("fogewise/source-nerve-e2e pull requests");
    await expect(repositoryPulls).toBeVisible();
    await expect(repositoryPulls.getByText("Browse existing pull request", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open in provider" })).toBeVisible();

    await expect(page.getByText("Durable task", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Provider lifecycle", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Optional provider issue", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Phase 1 · exact pushed task SHA", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Create Pull Request/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Merge exact head/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Sync main/ })).toHaveCount(0);
    const removedProviderApis = await page.evaluate(() => ({
      state: typeof window.sourcenerveDesktop.getProviderWorkflowState,
      issue: typeof window.sourcenerveDesktop.createProviderIssue,
      createPull: typeof window.sourcenerveDesktop.createProviderPull,
      refresh: typeof window.sourcenerveDesktop.refreshProviderPull,
      merge: typeof window.sourcenerveDesktop.mergeProviderPull,
      sync: typeof window.sourcenerveDesktop.syncProviderDefaultBranch,
    }));
    expect(Object.values(removedProviderApis)).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined", "undefined"]);
  } finally {
    await electronApp.close();
  }
});

test("managed workspace is ready without repository indexing", async () => {
  const { electronApp, page } = await launchDesktop();
  try {
    await completeCodexBootstrap(page);
    await addWorkspace(page, "read-write");
    await expect(page.getByRole("button", { name: /^(Index workspace|Reindex)$/ })).toHaveCount(0);

    await page.getByRole("link", { name: "Overview" }).click();
    await expect(page.getByLabel("SourceNerve operational overview")).toBeVisible();
  } finally {
    await electronApp.close();
  }
});
test("removed workspace stays removed and Workspaces remains interactive", async () => {
  const { electronApp, page } = await launchDesktop();
  try {
    await addWorkspace(page, "read-write");
    await expect(page.getByRole("heading", { name: "E2E Workspace", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirm remove" })).toBeVisible();
    await page.getByRole("button", { name: "Confirm remove" }).click();

    await expect(page.getByText("E2E Workspace", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Choose a local Git repository to start", { exact: true })).toBeVisible();
    const addWorkspaceButton = page.getByRole("button", { name: "Add workspace" });
    await expect(addWorkspaceButton).toBeEnabled();

    await addWorkspaceButton.click();
    await expect(page.getByText("Workspace setup").first()).toBeVisible();
    await page.getByRole("button", { name: "Save workspace" }).click();
    await expect(page.getByText("E2E Workspace", { exact: true }).first()).toBeVisible();
  } finally {
    await electronApp.close();
  }
});

test("Tasks surface is removed and the legacy hash falls back to Overview", async () => {
  const { electronApp, page } = await launchDesktop();
  try {
    await addWorkspace(page, "read-only");
    await expect(page.getByRole("link", { name: /Tasks/ })).toHaveCount(0);
    await page.evaluate(() => { window.location.hash = "#/tasks"; });
    await expect(page.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "Start durable task" })).toHaveCount(0);
  } finally {
    await electronApp.close();
  }
});

test("migration and safe recovery remain explicit and sanitized", async () => {
  const { electronApp, page } = await launchDesktop(migrationRecoveryHarness);
  try {
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByText("Existing setup migration", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Choose sourcenerve.toml" }).click();
    await expect(page.getByText("1 workspace(s) detected", { exact: true })).toBeVisible();
    await expect(page.getByText("Shell environment and shell history are not inspected.")).toBeVisible();
    await page.getByRole("button", { name: "Backup and import" }).click();
    await expect(page.getByText("Migration completed", { exact: true })).toBeVisible();
    await expect(page.getByText(/1 workspace\(s\) imported/)).toBeVisible();

    await page.getByRole("link", { name: "Diagnostics" }).click();
    await expect(page.getByText("Previous Desktop exit", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Last daemon exit", { exact: true })).toHaveCount(0);
    await expect(page.getByText("State location", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Latest backup", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Re-run readiness" }).click();
    await expect(page.getByText("Health: ok", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rebuild indexes" })).toHaveCount(0);
    await page.getByRole("button", { name: "Create + validate backup" }).click();
    await expect(page.getByText("Backup valid", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Validate latest backup" }).click();
    await expect(page.getByText("Latest Desktop state backup is valid.", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Generate preview" }).click();
    const supportPreview = page.getByLabel("Exact support bundle preview");
    await expect(supportPreview).toContainText("Authorization: [REDACTED]");
    await expect(supportPreview).not.toContainText("Bearer ");
    await expect(supportPreview).not.toContainText("/legacy/repository");
  } finally {
    await electronApp.close();
  }
});
