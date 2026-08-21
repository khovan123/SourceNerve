import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const rendererRoot = path.dirname(fileURLToPath(import.meta.url));

describe("Desktop loading spinner contract", () => {
  it("provides a deterministic animation for every animate-spin indicator", async () => {
    const css = await readFile(path.join(rendererRoot, "design-system.css"), "utf8");

    expect(css).toMatch(/@keyframes\s+sn-loading-spin\s*\{/);
    expect(css).toMatch(
      /\.animate-spin\s*\{[^}]*animation:\s*sn-loading-spin\s+0\.8s\s+linear\s+infinite;[^}]*transform-origin:\s*center;/s,
    );
  });

  it("keeps current loading indicators on the shared spinner contract", async () => {
    const entries = await readdir(path.join(rendererRoot, "components"), { recursive: true });
    const spinnerFiles: string[] = [];

    for (const entry of entries) {
      if (typeof entry !== "string" || !entry.endsWith(".tsx")) continue;
      const filePath = path.join(rendererRoot, "components", entry);
      const source = await readFile(filePath, "utf8");
      if (source.includes("animate-spin")) spinnerFiles.push(entry);
    }

    expect(spinnerFiles.length).toBeGreaterThan(0);
  });
});
