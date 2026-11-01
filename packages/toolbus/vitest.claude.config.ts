import { defineConfig } from "vitest/config";
import tsConfigPaths from "vite-tsconfig-paths";

// `pnpm test:claude-code`: a real `claude -p` against a local ToolBus
// (claude-code/listen-reopen.claude.ts). Needs the claude CLI, logged in.
export default defineConfig({
  plugins: [
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
  ],
  test: {
    environment: "node",
    include: ["claude-code/**/*.claude.ts"],
    fileParallelism: false,
    testTimeout: 110 * 60_000,
    hookTimeout: 60_000,
  },
});
