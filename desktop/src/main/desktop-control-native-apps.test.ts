import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listNativeApplications, parseLinuxDesktopEntry } from "./desktop-control-native-apps";

describe("parseLinuxDesktopEntry", () => {
  it("accepts a visible application desktop entry without trusting Exec", () => {
    expect(parseLinuxDesktopEntry([
      "[Desktop Entry]",
      "Name=Spotify",
      "Type=Application",
      "Exec=/usr/bin/flatpak run com.spotify.Client",
      "NoDisplay=false",
    ].join("\n"))).toEqual({ name: "Spotify" });
  });

  it("rejects hidden and non-application entries", () => {
    expect(parseLinuxDesktopEntry([
      "[Desktop Entry]",
      "Name=Hidden App",
      "Type=Application",
      "Hidden=true",
    ].join("\n"))).toBeNull();
    expect(parseLinuxDesktopEntry([
      "[Desktop Entry]",
      "Name=Folder",
      "Type=Directory",
    ].join("\n"))).toBeNull();
  });

  it("stops at the next desktop-file section", () => {
    expect(parseLinuxDesktopEntry([
      "[Desktop Entry]",
      "Name=Visible App",
      "Type=Application",
      "[Desktop Action NewWindow]",
      "Name=Wrong Name",
    ].join("\n"))).toEqual({ name: "Visible App" });
  });
});

describe.skipIf(process.platform !== "linux")("Linux native application discovery", () => {
  it("discovers a symlinked XDG desktop entry such as an exported Flatpak application", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sourcenerve-native-apps-"));
    const applicationsDirectory = path.join(root, "applications");
    const exportedDirectory = path.join(root, "exported");
    const target = path.join(exportedDirectory, "com.sourcenerve.NativeFixture.desktop");
    const link = path.join(applicationsDirectory, "com.sourcenerve.NativeFixture.desktop");
    const previousDataHome = process.env.XDG_DATA_HOME;

    try {
      await mkdir(applicationsDirectory, { recursive: true });
      await mkdir(exportedDirectory, { recursive: true });
      await writeFile(target, [
        "[Desktop Entry]",
        "Type=Application",
        "Name=SourceNerve Native Fixture",
        "Exec=/bin/false --must-not-run",
      ].join("\n"));
      await symlink(target, link);
      process.env.XDG_DATA_HOME = root;

      await expect(listNativeApplications({ query: "SourceNerve Native Fixture", maxApplications: 5 })).resolves.toEqual([
        {
          id: "com.sourcenerve.NativeFixture",
          name: "SourceNerve Native Fixture",
          launcher: "linux-desktop-entry",
        },
      ]);
    } finally {
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousDataHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});
