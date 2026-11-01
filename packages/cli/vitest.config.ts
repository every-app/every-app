import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Two projects. `unit` is what a pull request runs (`pnpm test`).
// `integration` is every test file that installs a Gateway into the fake
// Cloudflare account: it packs a release tarball, unpacks it and applies
// every migration before each test, about a second a test, ~90% of this
// package's test time. They run on demand, nightly and on main
// (.github/workflows/integration.yml, `pnpm test:integration`). A file is
// sorted by what it imports, so a new one lands in the right project.
// `vitest run <file>` with no --project still runs a file from either.
const INTEGRATION = /from "@\/test\/(gatewayRelease|gatewayWorker)"/;
const integrationFiles = fs
  .readdirSync(path.join(__dirname, "src"), { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => path.join("src", file))
  .filter((file) => INTEGRATION.test(fs.readFileSync(path.join(__dirname, file), "utf8")));

// starter/ is the template packed in at build (scripts/bundle-starter.mjs): its tests are the starter's own.
const exclude = [...configDefaults.exclude, "starter/**"];

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
    projects: [
      {
        extends: true,
        test: { name: "unit", exclude: [...exclude, ...integrationFiles] },
      },
      {
        extends: true,
        test: { name: "integration", include: integrationFiles, exclude },
      },
    ],
  },
});
