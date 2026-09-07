import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const rendererRoot = path.dirname(fileURLToPath(import.meta.url));

describe("Claude-style Desktop shell contract", () => {
  it("keeps the primary sidebar focused on work while the center surface owns collapse controls", async () => {
    const sidebarSource = await readFile(path.join(rendererRoot, "components", "organisms", "AppSidebar.tsx"), "utf8");
    const shellSource = await readFile(path.join(rendererRoot, "components", "templates", "DesktopShell.tsx"), "utf8");

    expect(sidebarSource).toContain("MAIN_NAVIGATION");
    expect(sidebarSource).toContain("Settings");
    expect(sidebarSource).toContain("Sign out");
    expect(sidebarSource).not.toContain("PanelLeftClose");
    expect(sidebarSource).not.toContain("PanelLeftOpen");
    expect(sidebarSource).not.toContain("Account & connections");
    expect(sidebarSource).not.toContain("Theme:");
    expect(shellSource).toContain("PanelLeftClose");
    expect(shellSource).toContain("PanelLeftOpen");
    expect(shellSource).toContain('sidebarCollapsed\n          ? "grid-cols-[minmax(0,1fr)]"');
    expect(shellSource).not.toContain("grid-cols-[44px_");
  });

  it("keeps the Harness sidebar trigger and workspace name adjacent in one compact header row", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "templates", "DesktopShell.tsx"), "utf8");

    expect(source).toContain('aria-label="Workspace header"');
    expect(source).toContain('flex h-11 shrink-0 items-center gap-2');
    expect(source).toContain('{selectedWorkspace?.name ?? "Workspace required"}');
    expect(source).toContain('grid size-8 shrink-0 place-items-center');
  });

  it("gives the selected workspace an explicit active state in the core sidebar", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "organisms", "AppSidebar.tsx"), "utf8");

    expect(source).toContain("aria-pressed={selected}");
    expect(source).toContain("bg-[var(--sn-sidebar-active)] font-semibold text-primary");
    expect(source).toContain("rounded-r-full bg-primary");
    expect(source).toContain('selected ? "text-primary" : ""');
    expect(source).not.toContain('size-1.5 shrink-0 rounded-full bg-primary');
  });

  it("gives the account popup an active menu item and keyboard navigation", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "organisms", "AppSidebar.tsx"), "utf8");

    expect(source).toContain("accountSelectionIndex");
    expect(source).toContain('role="menu"');
    expect(source).toContain('role="menuitem"');
    expect(source).toContain('aria-label="Account actions"');
    expect(source).toContain('event.key === "ArrowDown"');
    expect(source).toContain('event.key === "ArrowUp"');
    expect(source).toContain('event.key === "Home"');
    expect(source).toContain('event.key === "End"');
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("moveAccountSelection");
    expect(source).toContain("accountButtonRef.current?.focus()");
    expect(source).toContain("bg-[var(--sn-sidebar-active)] text-primary shadow-[inset_0_0_0_1px_var(--border)]");
  });

  it("uses a flat settings modal with a simple option sidebar", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "SettingsModal.tsx"), "utf8");

    expect(source).toContain('id: "general"');
    expect(source).toContain('id: "connections"');
    expect(source).toContain('id: "mcp"');
    expect(source).toContain('id: "plugins"');
    expect(source).not.toContain('id: "diagnostics"');
    expect(source).not.toContain("DiagnosticsScreen");
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-label="Settings sections"');
    expect(source).toContain('aria-current={selected ? "page" : undefined}');
    expect(source).toContain('aria-pressed={selected}');
    expect(source).toContain('data-active={selected ? "true" : "false"}');
    expect(source).toContain("bg-[var(--sn-sidebar-active)] font-semibold text-primary");
    expect(source).not.toContain('ml-auto size-1.5 shrink-0 rounded-full bg-primary');
    expect(source).toContain("settings-content");
    expect(source).not.toContain("description:");
    expect(source).not.toContain("active.description");
  });

  it("shows a clear active settings option and keeps the close control in the modal top-right corner", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "SettingsModal.tsx"), "utf8");

    expect(source).toContain('aria-current={selected ? "page" : undefined}');
    expect(source).toContain('aria-pressed={selected}');
    expect(source).toContain('data-active={selected ? "true" : "false"}');
    expect(source).toContain("bg-[var(--sn-sidebar-active)] font-semibold text-primary shadow-[inset_0_0_0_1px_var(--border)]");
    expect(source).toContain("rounded-r-full bg-primary");
    expect(source).toContain('selected ? "text-primary" : ""');
    expect(source).toContain('className={cn("truncate", selected ? "text-primary" : "")}');
    expect(source).not.toContain('ml-auto size-1.5 shrink-0 rounded-full bg-primary');
    expect(source).toContain('aria-label="Close settings"');
    expect(source).toContain("absolute right-3 top-3 z-20");
  });

  it("removes the persistent top header while keeping configuration deep links compatible", async () => {
    const appSource = await readFile(path.join(rendererRoot, "App.tsx"), "utf8");
    const shellSource = await readFile(path.join(rendererRoot, "components", "templates", "DesktopShell.tsx"), "utf8");

    expect(appSource).toContain("settingsSectionForRoute");
    expect(appSource).toContain("<SettingsModal");
    expect(shellSource).not.toContain("RuntimeStatusBar");
    expect(shellSource).not.toContain("AppTopbar");
    expect(shellSource).not.toContain("workspaceCount");
    expect(shellSource).toContain('route === "harness"');
  });
});
