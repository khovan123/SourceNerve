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
});
