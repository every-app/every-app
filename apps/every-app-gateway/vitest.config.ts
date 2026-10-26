import { configDefaults, defineConfig } from "vitest/config";
import tsConfigPaths from "vite-tsconfig-paths";

const INTEGRATION = ["**/*.sqlite.test.ts", "**/*.e2e.test.ts"];

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
    server: {
      deps: {
        // Processed by vitest rather than loaded by node, so a test's
        // `cloudflare:workers` mock reaches the real OAuth library.
        inline: ["@cloudflare/workers-oauth-provider"],
      },
    },
    // Two projects. `unit` is what a pull request runs (`pnpm test`).
    // `integration` is the *.sqlite.test.ts and *.e2e.* files: each test
    // migrates a fresh SQLite database and drives real services, ~80% of
    // this package's test time. They run on demand, nightly and on main
    // (.github/workflows/integration.yml, `pnpm test:integration`).
    // `vitest run <file>` with no --project still runs a file from either.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          exclude: [...configDefaults.exclude, ...INTEGRATION],
        },
      },
      {
        extends: true,
        test: { name: "integration", include: INTEGRATION },
      },
    ],
  },
});
