import { defineConfig } from "vitest/config";
import tsConfigPaths from "vite-tsconfig-paths";

// `pnpm test:conformance`: the MCP conformance suite (needs the network).
export default defineConfig({
  plugins: [
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
  ],
  test: {
    environment: "node",
    include: ["conformance/**/*.conformance.ts"],
    // One local server is shared, so the scenarios run one after another.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
