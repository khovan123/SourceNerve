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

async function addWorkspaceWithoutIndex(page, access = "read-write") {
  await page.getByRole("link", { name: "Workspaces" }).click();
  await page.getByRole("button", { name: "Add workspace" }).click();
  await expect(page.getByText("Workspace setup").first()).toBeVisible();
  await page.getByLabel("Access").selectOption(access);
  await page.getByRole("button", { name: "Save workspace" }).click();
  await expect(page.getByText("E2E Workspace", { exact: true }).first()).toBeVisible();
}

async function addWorkspace(page, access = "read-write") {
  await addWorkspaceWithoutIndex(page, access);
  await page.getByRole("button", { name: "Index workspace" }).click();
  await expect(page.getByText("Index: current", { exact: true })).toBeVisible();
}

async function completeAccountBootstrapAndGit(page) {
  await expect(page.getByRole("heading", { name: "Set up SourceNerve" })).toBeVisible();
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: "Open account connection" }).click();
  await page.getByRole("button", { name: "Sign in to SourceNerve" }).click();
  await expect(page.getByText("desktop-e2e@example.invalid", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Enroll Public MCP" }).click();
  await expect(page.getByText("E2E public MCP ready", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Detect gh session" }).click();
  await expect(page.getByText("CLI authenticated", { exact: true }).first()).toBeVisible();
}

test("clean install reaches Ready and completes guarded task/provider workflow", async () => {
  const { electronApp, page } = await launchDesktop();
  try {
    await expect(page.getByRole("heading", { name: "Set up SourceNerve" })).toBeVisible();
    await expect(page.getByText("No infrastructure fields in the normal setup.")).toBeVisible();
    await page.getByRole("button", { name: "Get started" }).click();
    await expect(page.getByText("SourceNerve account", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Open account connection" }).click();

    await page.getByRole("button", { name: "Sign in to SourceNerve" }).click();
    await expect(page.getByText("desktop-e2e@example.invalid", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Enroll Public MCP" }).click();
    await expect(page.getByText("E2E public MCP ready", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Detect gh session" }).click();
    await expect(page.getByText("CLI authenticated", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Desktop E2E", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "Verify SourceNerve connection" }).click();
    await expect(page.getByText("Ready to connect", { exact: true })).toBeVisible();
    await page.getByLabel("One-time challenge token").fill("desktop-e2e-domain-challenge");
    await page.getByRole("button", { name: "Set & verify" }).click();
    await expect(page.getByText("Public response verified", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Remove challenge" }).click();
    await expect(page.getByText("No challenge", { exact: true })).toBeVisible();

    await addWorkspace(page, "read-write");

    await page.getByRole("link", { name: "Tasks" }).click();
    await page.getByRole("button", { name: "Start durable task" }).click();
    await expect(page.getByText("Phase: snapshot", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create / recover feature branch" }).click();
    await expect(page.getByText("Phase: branched", { exact: true })).toBeVisible();

    await page.getByPlaceholder("src/module.rs").fill("e2e.txt");
    await page.getByLabel("New file").check();
    await page.getByPlaceholder("diff --git a/... b/...").fill(
      "diff --git a/e2e.txt b/e2e.txt\nnew file mode 100644\n--- /dev/null\n+++ b/e2e.txt\n@@ -0,0 +1 @@\n+quality gate\n",
    );
    await page.getByRole("button", { name: "Validate proposal" }).click();
    await expect(page.getByText("Reviewed proposal in this session", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Apply reviewed proposal" }).click();
    await expect(page.getByText("Phase: patched", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review complete delta" }).click();
    await expect(page.getByText("Phase: reviewed", { exact: true })).toBeVisible();
    await page.getByPlaceholder("feat: describe guarded change").fill("feat: exercise quality gate");
    await page.getByRole("button", { name: "Commit exact reviewed delta" }).click();
    await expect(page.getByText("Phase: committed", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Push exact commit" }).click();
    await expect(page.getByText("Task pushed", { exact: true })).toBeVisible();

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.getByText("quality gate", { exact: true }).first().click();
    await expect(page.getByText("Task pushed", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Pull Requests" }).click();
    await expect(page.getByText("Provider constraints are authoritative.")).toBeVisible();
    const createPull = page.getByRole("button", { name: /Create (pull request|Pull Request)/ });
    await expect(createPull).toBeEnabled();
    await createPull.click();
    await expect(page.getByText(/#79/).first()).toBeVisible();
    await page.getByRole("button", { name: /Merge exact head/ }).click();
    await expect(page.getByText(/Merged at/)).toBeVisible();
    await page.getByRole("button", { name: "Sync main" }).click();
    await expect(page.getByText("Provider workflow complete", { exact: true })).toBeVisible();
  } finally {
    await electronApp.close();
  }
});

test("Retry runtime check indexes pending managed workspaces", async () => {
  const { electronApp, page } = await launchDesktop();
  try {
    await completeAccountBootstrapAndGit(page);
    await addWorkspaceWithoutIndex(page, "read-write");
    await expect(page.getByText("Index: not-indexed", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Overview" }).click();
    const continueSetup = page.getByRole("button", { name: "Continue setup" });
    await expect(continueSetup).toHaveCount(1);
    await continueSetup.click();
    await expect(page.getByText("Runtime & indexing", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Retry runtime check" }).click();
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

    await page.getByRole("link", { name: "Workspaces" }).click();
    await expect(page.getByText("Index: current", { exact: true })).toBeVisible();
  } finally {
    await electronApp.close();
  }
});

test("removed workspace stays removed and Workspaces remains interactive", async () => {
  const { electronApp, page } = await launchDesktop();
  try {
    await addWorkspaceWithoutIndex(page, "read-write");
    await expect(page.getByText("E2E Workspace", { exact: true }).first()).toBeVisible();

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

test("read-only workspace never exposes guarded mutation controls", async () => {
  const { electronApp, page } = await launchDesktop();
  try {
    await addWorkspace(page, "read-only");
    await page.getByRole("link", { name: "Tasks" }).click();
    await expect(page.getByText("A new task requires a ready, clean, current-index, read-write workspace on its default branch.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start durable task" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create / recover feature branch" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Push exact commit" })).toHaveCount(0);
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
    await page.getByRole("button", { name: "Rebuild indexes" }).click();
    await expect(page.getByText("Rebuilt 1 managed workspace index.", { exact: true })).toBeVisible();
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
