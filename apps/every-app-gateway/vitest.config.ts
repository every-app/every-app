import { defineConfig } from "vitest/config";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    tsConfigPaths({
      // The CLI's own paths too: a cross-component test runs the CLI's
      // setup-link minting against the gateway's migrated schema.
      projects: ["./tsconfig.json", "../../packages/cli/tsconfig.json"],
    }),
  ],
  test: {
    globals: true,
    environment: "node",
  },
});
