import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeLogStore,
  sanitizeRuntimeEvent,
  sanitizeRuntimeText,
} from "./runtime-log-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("RuntimeLogStore", () => {
  it("redacts bearer credentials, secret assignments, JWT-like values and home paths", () => {
    const secret = "eyJheader.payload.signature0123456789";
    const message = sanitizeRuntimeText(
      `Authorization: Bearer very-secret-token token=abc123 credential=hidden ${secret} /home/alice/repo`,
      "/home/alice",
    );

    expect(message).toContain("Authorization: Bearer [REDACTED]");
    expect(message).toContain("token=[REDACTED]");
    expect(message).toContain("credential=[REDACTED]");
    expect(message).toContain("[REDACTED]");
    expect(message).toContain("[HOME]/repo");
    expect(message).not.toContain("very-secret-token");
    expect(message).not.toContain("abc123");
    expect(message).not.toContain("/home/alice");
  });

  it("redacts raw provider/API token formats and private-key blocks", () => {
    const github = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const fineGrained = "github_pat_abcdefghijklmnopqrstuvwxyz_123456";
    const gitlab = "glpat-abcdefghijklmnopqrstuvwxyz123456";
    const apiKey = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "super-secret-private-key-material",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const message = sanitizeRuntimeText(
      `${github} ${fineGrained} ${gitlab} ${apiKey}\n${privateKey}`,
    );

    for (const secret of [github, fineGrained, gitlab, apiKey, "super-secret-private-key-material"]) {
      expect(message).not.toContain(secret);
    }
    expect(message).toContain("[REDACTED]");
    expect(message).toContain("[REDACTED PRIVATE KEY]");
  });

  it("keeps copied diagnostics larger than one log line while still bounded and redacted", () => {
    const diagnosticBundle = JSON.stringify(
      {
        generatedAt: new Date(0).toISOString(),
        logRetention: { retainedEntries: 400 },
        recentLogs: Array.from({ length: 400 }, (_, index) => ({
          sequence: index + 1,
          message: `safe-diagnostic-line-${index}-${"x".repeat(30)}`,
        })),
        credential: "secret-secret-secret-secret",
      },
      null,
      2,
    );
    const diagnostics = sanitizeRuntimeText(diagnosticBundle, "/home/alice");

    expect(Buffer.byteLength(diagnostics, "utf8")).toBeGreaterThan(4_096);
    expect(Buffer.byteLength(diagnostics, "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(diagnostics).toContain('"credential": "[REDACTED]"');
    expect(diagnostics).not.toContain("secret-secret-secret-secret");
  });

  it("sanitizes state messages before they can be published to the renderer", () => {
    const event = sanitizeRuntimeEvent(
      {
        type: "state",
        component: "auth",
        state: "error",
        message: "Bearer secret-secret-secret-secret password=bad-value",
      },
      "/home/alice",
    );

    expect(event.type).toBe("state");
    if (event.type !== "state") throw new Error("expected state event");
    expect(event.message).not.toContain("secret-secret");
    expect(event.message).not.toContain("bad-value");
  });

  it("bounds in-memory retention and reports dropped entries", async () => {
    const directory = await tempDirectory();
    const store = new RuntimeLogStore(directory, {
      maxEntries: 16,
      maxMemoryBytes: 16 * 1024,
      maxFileBytes: 64 * 1024,
    });

    for (let index = 0; index < 40; index += 1) {
      store.record({
        type: "log",
        component: "daemon",
        level: "info",
        message: `message-${index}`,
        timestamp: new Date(1_700_000_000_000 + index).toISOString(),
      });
    }
    await store.flush();

    const snapshot = store.snapshot();
    expect(snapshot.entries).toHaveLength(16);
    expect(snapshot.droppedEntries).toBe(24);
    expect(snapshot.entries[0]?.message).toBe("message-24");
    expect(snapshot.entries.at(-1)?.message).toBe("message-39");
  });

  it("rotates bounded JSONL files instead of growing one log forever", async () => {
    const directory = await tempDirectory();
    const store = new RuntimeLogStore(directory, {
      maxEntries: 100,
      maxMemoryBytes: 64 * 1024,
      maxFileBytes: 512,
      rotations: 2,
    });

    for (let index = 0; index < 20; index += 1) {
      store.record({
        type: "log",
        component: "desktop",
        level: "warn",
        message: `rotation-${index}-${"x".repeat(120)}`,
        timestamp: new Date(1_700_000_100_000 + index).toISOString(),
      });
    }
    await store.flush();

    const files = await readdir(directory);
    expect(files).toContain("desktop-runtime.log");
    expect(files).toContain("desktop-runtime.log.1");
    expect(files.filter((file) => file.startsWith("desktop-runtime.log")).length).toBeLessThanOrEqual(3);

    const current = await readFile(path.join(directory, "desktop-runtime.log"), "utf8");
    expect(current).toContain("rotation-");
    expect(current.length).toBeGreaterThan(0);
  });
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-runtime-log-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
