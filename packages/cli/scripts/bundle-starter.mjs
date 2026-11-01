/**
 * Pack the starter template into this package: `../../starter` to
 * `./starter`, without local state (the same list lib/app/starter.ts
 * leaves out of a new app), with its `.gitignore` kept as `gitignore` so
 * npm keeps it in the package (lib/app/starter.ts `copyStarter` puts the
 * dot back). Runs at `build`, so `pnpm pack` and the published package
 * carry the template for an everyapp that doesn't run from a checkout
 * (lib/checkout.ts `templateSource`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = path.join(CLI_DIR, "..", "..", "starter");
const TARGET = path.join(CLI_DIR, "starter");

/** Never packed: local state, build output, installs (lib/app/starter.ts LOCAL_ONLY). */
const LOCAL_ONLY = new Set([
  "node_modules",
  ".git",
  "pnpm-lock.yaml",
  "package-lock.json",
  ".env",
  ".env.local",
  ".env.production",
  ".dev.vars",
  ".cloudflare",
  ".everyapp",
  ".wrangler",
  ".output",
  ".tanstack",
  "dist",
  "manual-steps.md",
]);

if (!fs.existsSync(path.join(SOURCE, "everyapp.config.ts"))) {
  console.error(`No starter template at ${SOURCE}`);
  process.exit(1);
}
fs.rmSync(TARGET, { recursive: true, force: true });
fs.cpSync(SOURCE, TARGET, {
  recursive: true,
  filter: (file) => !LOCAL_ONLY.has(path.basename(file)),
});
const gitignore = path.join(TARGET, ".gitignore");
if (fs.existsSync(gitignore)) fs.renameSync(gitignore, path.join(TARGET, "gitignore"));
