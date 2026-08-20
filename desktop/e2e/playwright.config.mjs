import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "desktop.spec.mjs",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["line"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
