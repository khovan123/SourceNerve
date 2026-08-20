import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/integration/**/*.integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
    pool: "forks",
    fileParallelism: false,
  },
});
