import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DesktopControlPreferencesStore, defaultDesktopControlPermissions } from "./desktop-control-preferences";

describe("DesktopControlPreferencesStore", () => {
  it("defaults all computer-use capabilities to disabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sn-desktop-control-"));
    const store = new DesktopControlPreferencesStore(path.join(root, "permissions.json"));

    expect(await store.initialize()).toEqual(defaultDesktopControlPermissions());
  });

  it("persists explicit permissions and restores them after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sn-desktop-control-"));
    const filePath = path.join(root, "permissions.json");
    const store = new DesktopControlPreferencesStore(filePath);
    await store.initialize();

    const expected = { screen: true, mouse: true, keyboard: true, clipboard: false };
    expect(await store.update(expected)).toEqual(expected);
    const restored = new DesktopControlPreferencesStore(filePath);
    expect(await restored.initialize()).toEqual(expected);

    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(1);
  });

  it("fails closed to disabled defaults when the stored schema is invalid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sn-desktop-control-"));
    const filePath = path.join(root, "permissions.json");
    await writeFile(filePath, JSON.stringify({ schemaVersion: 99, screen: true, mouse: true, keyboard: true, clipboard: true }));

    const store = new DesktopControlPreferencesStore(filePath);
    expect(await store.initialize()).toEqual(defaultDesktopControlPermissions());
  });
});
