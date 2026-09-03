import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("Fedora OAuth callback registration", () => {
  it("registers sourcenerve as an RPM URI scheme handler", async () => {
    const forge = await readFile(path.join(desktopRoot, "forge.config.ts"), "utf8");

    expect(forge).toContain('mimeType: ["x-scheme-handler/sourcenerve"]');
    expect(forge).toContain('schemes: ["sourcenerve"]');
    expect(forge).toContain('post: rpmPostInstall');
    expect(forge).toContain('postun: rpmPostUninstall');
  });

  it("refreshes the desktop MIME database after RPM install and uninstall", async () => {
    const scripts = await Promise.all([
      readFile(path.join(desktopRoot, "resources", "rpm", "post-install.sh"), "utf8"),
      readFile(path.join(desktopRoot, "resources", "rpm", "post-uninstall.sh"), "utf8"),
    ]);

    for (const script of scripts) {
      expect(script).toContain("update-desktop-database /usr/share/applications");
      expect(script).toContain("exit 0");
    }
  });

  it("keeps development Electron runs from replacing the packaged protocol launcher", async () => {
    const [main, backgroundController] = await Promise.all([
      readFile(path.join(desktopRoot, "src", "main.ts"), "utf8"),
      readFile(path.join(desktopRoot, "src", "main", "background-controller.ts"), "utf8"),
    ]);

    expect(main).toContain(
      'if (app.isPackaged && !app.setAsDefaultProtocolClient("sourcenerve"))',
    );
    expect(backgroundController).toContain(
      'if (process.platform === "linux" && app.isPackaged)',
    );
  });

  it("lets the RPM system launcher own sourcenerve.desktop and reserves user launchers for AppImage", async () => {
    const backgroundController = await readFile(
      path.join(desktopRoot, "src", "main", "background-controller.ts"),
      "utf8",
    );

    expect(backgroundController).toContain("const appImagePath = process.env.APPIMAGE?.trim()");
    expect(backgroundController).toContain("if (!appImagePath)");
    expect(backgroundController).toContain("await rm(desktopFile, { force: true })");
    expect(backgroundController).toContain("await writeFile(desktopFile, content");
  });
});
