import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const rendererRoot = path.dirname(fileURLToPath(import.meta.url));

describe("Connections layout contract", () => {
  it("uses compact grouped connection rows instead of verbose provider cards", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "ConnectionsScreen.tsx"), "utf8");

    expect(source).toContain('title="Accounts"');
    expect(source).toContain('title="Remote access"');
    expect(source).toContain("ConnectionRow");
    expect(source).not.toContain("Workspace access");
    expect(source).not.toContain("Uses the gh CLI session");
    expect(source).not.toContain("Uses the glab CLI session");
    expect(source).not.toContain("Sign in with the provider CLI");
    expect(source).not.toContain("gh auth login");
    expect(source).not.toContain("glab auth login");
  });

  it("keeps plugin verification out of the Connections section", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "SettingsModal.tsx"), "utf8");

    expect(source).toContain('{section === "connections" ? <ConnectionsScreen /> : null}');
    expect(source).toContain("<PluginVerificationPanel />");
    expect(source).toContain('{section === "plugins" ? (');
  });
});
