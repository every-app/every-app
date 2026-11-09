// The Electron e2e smoke (e2e/smoke.spec.ts): the built app (`pnpm build`, not packaged) with the
// fake helper against the in-memory mock /api/v1 (e2e/mock-api.mjs). `pnpm e2e` locally;
// CI runs it under xvfb-run (.github/workflows/ci.yml, job desktop-e2e).

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results/e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
});
