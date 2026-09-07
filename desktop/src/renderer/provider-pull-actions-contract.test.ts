import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const rendererRoot = path.dirname(fileURLToPath(import.meta.url));

describe("provider pull action contract", () => {
  it("renders guarded merge, close, comment and provider-open actions on pull cards", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "ProviderPullBrowser.tsx"), "utf8");

    expect(source).toContain("mergeProviderPull");
    expect(source).toContain("closeProviderPull");
    expect(source).toContain("commentProviderPull");
    expect(source).toContain("Merge");
    expect(source).toContain("Close");
    expect(source).toContain("Comment");
    expect(source).toContain("Post comment");
    expect(source).toContain("exact head before merging");
    expect(source).toContain("window.confirm");
    expect(source).toContain('maxLength={10_000}');
  });
});
