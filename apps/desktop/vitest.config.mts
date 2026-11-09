import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(import.meta.dirname, "src/shared"),
      // Headless: no test may load Electron (see test/no-electron.ts).
      electron: resolve(import.meta.dirname, "test/no-electron.ts"),
    },
  },
  test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 15_000 },
});
