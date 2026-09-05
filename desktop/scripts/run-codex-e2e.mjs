import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(
  command,
  [
    "vitest",
    "run",
    "--config",
    "vitest.integration.config.ts",
    "src/integration/codex-native.integration.test.ts",
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, SOURCENERVE_CODEX_E2E: "1" },
    stdio: "inherit",
  },
);

child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : "Unable to start Codex live E2E");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Codex live E2E terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
