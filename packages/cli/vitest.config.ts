import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
    // Tests run everyapp as the checkout does (lib/output/command.ts `CLI`),
    // however vitest itself was started.
    env: { npm_config_user_agent: "pnpm/test" },
  },
});
