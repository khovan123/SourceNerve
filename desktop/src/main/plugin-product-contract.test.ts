import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readPluginSetupFields } from "./plugin-product-contract";
import { validateProductProfile } from "./runtime-profile";

describe("plugin product contract", () => {
  it("maps the packaged personal-plugin fields without an external auth provider", async () => {
    const filePath = path.join(process.cwd(), "bootstrap", "product-profile.template.json");
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    const profile = validateProductProfile(raw, { allowPlaceholders: false });
    const fields = readPluginSetupFields(profile);

    expect(fields.name).toBe("SourceNerve");
    expect(fields.description.length).toBeGreaterThan(0);
    expect(fields.authentication).toBe("none");
    expect(fields.privacyUrl).toMatch(/^https:\/\//);
    expect(fields.termsUrl).toMatch(/^https:\/\//);
    expect(fields.supportUrl).toMatch(/^https:\/\//);
    expect(JSON.stringify(fields)).not.toMatch(/oauth|auth0|token|bearer|client[_-]?secret/i);
  });
});
