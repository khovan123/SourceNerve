import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const mainRoot = path.dirname(fileURLToPath(import.meta.url));

describe("Harness bang-command IPC contract", () => {
  it("registers the command handler in Electron main and exposes the same channel through preload", async () => {
    const [taskIpcSource, mainSource, preloadSource, sharedSource] = await Promise.all([
      readFile(path.join(mainRoot, "task-ipc.ts"), "utf8"),
      readFile(path.join(mainRoot, "..", "main.ts"), "utf8"),
      readFile(path.join(mainRoot, "..", "preload.ts"), "utf8"),
      readFile(path.join(mainRoot, "..", "shared", "harness-api.ts"), "utf8"),
    ]);

    expect(sharedSource).toContain('commandExecute: "desktop:harness-command-execute"');
    expect(mainSource).toContain('import { installTaskIpcHandlers } from "./main/task-ipc";');
    expect(mainSource).toContain("installTaskIpcHandlers({");
    expect(taskIpcSource).toContain("secureHandle(context, HARNESS_IPC.commandExecute");
    expect(taskIpcSource).toContain("manager.runHarnessCommand(args[0] as DesktopHarnessCommandInput)");
    expect(preloadSource).toContain("runHarnessCommand: (input: DesktopHarnessCommandInput)");
    expect(preloadSource).toContain("ipcRenderer.invoke(HARNESS_IPC.commandExecute, input)");
  });
});
