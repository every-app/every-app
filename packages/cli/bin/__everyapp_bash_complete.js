#!/usr/bin/env node
// Committed launcher so package managers can link the bin at install time,
// before dist/ exists (fresh CI checkouts install with --ignore-scripts).
import("../dist/bash-complete.js").catch((error) => {
  if (error?.code === "ERR_MODULE_NOT_FOUND") {
    console.error(
      "everyapp CLI is not built. In the monorepo, run: pnpm -C packages/cli build",
    );
    process.exit(1);
  }
  throw error;
});
