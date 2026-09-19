import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readPluginSetupFields } from "./plugin-product-contract";

describe("plugin product contract", () => {
  it("maps the packaged personal-plugin fields without OAuth configuration", async () => {
    const filePath = path.join(process.cwd(), "bootstrap", "product-profile.template.json");
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    const fields = readPluginSetupFields(replaceBuildPlaceholders(raw));

    expect(fields.name.length).toBeGreaterThan(0);
    expect(fields.description.length).toBeGreaterThan(0);
    expect(fields.authentication).toBe("none");
    expect(fields.privacyUrl).toMatch(/^https:\/\//);
    expect(fields.termsUrl).toMatch(/^https:\/\//);
    expect(fields.supportUrl).toMatch(/^https:\/\//);
    expect(JSON.stringify(fields)).not.toMatch(/oauth|auth0|token|bearer|cloudflare.*secret/i);
  });

  it("rejects credential-bearing or insecure product URLs", () => {
    const base = fixture();
    expect(() => readPluginSetupFields({
      ...base,
      legal: { ...base.legal, privacyUrl: "http://example.test/privacy" },
    })).toThrow(/HTTPS/);
    expect(() => readPluginSetupFields({
      ...base,
      plugin: { ...base.plugin, iconUrl: "https://user:pass@example.test/icon.png" },
    })).toThrow(/credential-free/);
  });
});

function fixture() {
  return {
    product: { name: "SourceNerve" },
    plugin: {
      name: "SourceNerve",
      description: "Repository intelligence",
      iconUrl: "https://sourcenerve.example/icon.png",
      chatgptSetupUrl: "https://chatgpt.com/",
    },
    legal: {
      privacyUrl: "https://sourcenerve.example/privacy",
      termsUrl: "https://sourcenerve.example/terms",
      supportUrl: "https://sourcenerve.example/support",
    },
  };
}

function replaceBuildPlaceholders(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(replaceBuildPlaceholders);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceBuildPlaceholders(item)]));
  }
  if (typeof value !== "string" || !/^__[A-Z0-9_]+__$/.test(value)) return value;
  const key = value.slice(2, -2);
  if (key.includes("NAME")) return "SourceNerve";
  if (key.includes("DESCRIPTION")) return "Repository intelligence";
  if (key.includes("URL") || key.includes("HOST")) return "https://sourcenerve.example/";
  return "configured";
}
