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

async function submitHarnessCommand(page, command) {
  const composer = page.getByPlaceholder("Message Harness…");
  await expect(composer).toBeVisible();
  await composer.fill(command);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function addWorkspace(page, access = "read-write") {
  await submitHarnessCommand(page, `/workspace add --access ${access}`);
  await expect(page.getByRole("button", { name: "E2E Workspace", exact: true })).toBeVisible();
}

async function openSettings(page) {
  await page.getByRole("button", { name: /SourceNerve account|Desktop E2E/ }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
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
  await page.getByRole("button", { name: "Open Harness" }).click();
  await expect(page.getByLabel("Harness conversation")).toBeVisible();
}

test("clean install reaches Ready with workspace-scoped Harness and a browse-only Pull Requests screen", async () => {
  const { electronApp, page } = await launchDesktop();
  try {
    await completeCodexBootstrap(page);
    await addWorkspace(page, "read-write");

    await expect(page.getByLabel("Harness conversation")).toBeVisible();
    const workspaceButton = page.getByRole("button", { name: "E2E Workspace", exact: true });
    await expect(workspaceButton).toBeEnabled();
    await expect(workspaceButton).toHaveAttribute("aria-pressed", "true");

    await expect(page.getByRole("link", { name: /Tasks/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Overview" })).toHaveCount(0);
    await page.evaluate(() => { window.location.hash = "#/tasks"; });
    await expect(page.getByLabel("Harness conversation")).toBeVisible();

    await page.getByRole("link", { name: "Pull Requests" }).click();
    const repositoryPulls = page.getByLabel("fogewise/source-nerve-e2e pull requests");
    await expect(repositoryPulls).toBeVisible();
    await expect(repositoryPulls.getByText("Browse existing pull request", { exact: true })).toBeVisible();
    await expect(repositoryPulls.getByRole("button", { name: "Open", exact: true })).toBeVisible();

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
    await expect(page.getByRole("button", { name: "E2E Workspace", exact: true })).toBeEnabled();
    await expect(page.getByPlaceholder("Message Harness…")).toBeEnabled();
  } finally {
    await electronApp.close();
  }
});

test("removed workspace stays removed and slash workspace commands remain interactive", async () => {
  const { electronApp, page } = await launchDesktop();
  try {
    await completeCodexBootstrap(page);
    await addWorkspace(page, "read-write");

    await submitHarnessCommand(page, "/workspace remove e2e-workspace");
    await expect(page.getByRole("button", { name: "E2E Workspace", exact: true })).toHaveCount(0);
    await expect(page.getByText(/Use .*\/workspace add.* in Harness\./)).toBeVisible();

    await addWorkspace(page, "read-write");
    await expect(page.getByRole("button", { name: "E2E Workspace", exact: true })).toBeEnabled();
  } finally {
    await electronApp.close();
  }
});

test("Tasks surface is removed and the legacy hash falls back to Harness", async () => {
  const { electronApp, page } = await launchDesktop();
  try {
    await completeCodexBootstrap(page);
    await addWorkspace(page, "read-only");
    await expect(page.getByRole("link", { name: /Tasks/ })).toHaveCount(0);
    await page.evaluate(() => { window.location.hash = "#/tasks"; });
    await expect(page.getByLabel("Harness conversation")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start durable task" })).toHaveCount(0);
  } finally {
    await electronApp.close();
  }
});

test("migration remains explicit and sanitized in Settings", async () => {
  const { electronApp, page } = await launchDesktop(migrationRecoveryHarness);
  try {
    await openSettings(page);
    await expect(page.getByText("Existing setup migration", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Choose sourcenerve.toml" }).click();
    await expect(page.getByText("1 workspace(s) detected", { exact: true })).toBeVisible();
    await expect(page.getByText("Shell environment and shell history are not inspected.")).toBeVisible();
    await page.getByRole("button", { name: "Backup and import" }).click();
    await expect(page.getByText("Migration completed", { exact: true })).toBeVisible();
    await expect(page.getByText(/1 workspace\(s\) imported/)).toBeVisible();

    await expect(page.getByText("Previous Desktop exit", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Last daemon exit", { exact: true })).toHaveCount(0);
    await expect(page.getByText("State location", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Latest backup", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Rebuild indexes" })).toHaveCount(0);
    await expect(page.getByLabel("Exact support bundle preview")).toHaveCount(0);
  } finally {
    await electronApp.close();
  }
});
