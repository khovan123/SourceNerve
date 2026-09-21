import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("Fedora Desktop registration", () => {
  it("does not register an obsolete SourceNerve authentication URI scheme", async () => {
    const [forge, main, backgroundController] = await Promise.all([
      readFile(path.join(desktopRoot, "forge.config.ts"), "utf8"),
      readFile(path.join(desktopRoot, "src", "main.ts"), "utf8"),
      readFile(path.join(desktopRoot, "src", "main", "background-controller.ts"), "utf8"),
    ]);

    expect(forge).not.toContain('x-scheme-handler/sourcenerve');
    expect(forge).not.toContain('schemes: ["sourcenerve"]');
    expect(forge).not.toContain("SourceNerve authentication callback");
    expect(main).not.toContain('setAsDefaultProtocolClient("sourcenerve")');
    expect(backgroundController).not.toContain("MimeType=x-scheme-handler/sourcenerve");
  });

  it("refreshes the desktop application database after RPM install and uninstall", async () => {
    const scripts = await Promise.all([
      readFile(path.join(desktopRoot, "resources", "rpm", "post-install.sh"), "utf8"),
      readFile(path.join(desktopRoot, "resources", "rpm", "post-uninstall.sh"), "utf8"),
    ]);

    for (const script of scripts) {
      expect(script).toContain("update-desktop-database /usr/share/applications");
      expect(script).toContain("exit 0");
    }
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
