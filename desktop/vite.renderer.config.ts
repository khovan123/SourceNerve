import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  build: {
    sourcemap: false,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/integration/**/*.integration.test.ts"],
  },
});
