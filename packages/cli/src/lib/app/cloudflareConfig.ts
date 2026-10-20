import fs from "node:fs/promises";
import path from "node:path";

/** What to add when an app has no cloudflare.config.ts. */
export const MISSING_CLOUDFLARE_CONFIG = [
  "No cloudflare.config.ts found. Every App apps define their Worker in a",
  "cloudflare.config.ts at the app root that builds it from everyapp.config.ts:",
  "",
  '  import { defineConfig } from "cf/config";',
  '  import { everyAppWorker } from "@every-app/sdk/cloudflare";',
  '  import * as entrypoint from "./src/entry.worker.ts" with { type: "cf-worker" };',
  '  import manifest from "./everyapp.config.ts";',
  "",
  "  export default defineConfig((ctx) => ({",
  "    worker: everyAppWorker({ manifest, entrypoint, ctx }),",
  "  }));",
  "",
  "See templates/simple-todo for the full setup (package.json, vite.config.ts).",
].join("\n");

/**
 * The app's cloudflare.config.ts: null when it has none, else whether it
 * builds the Worker with everyAppWorker() and whether it declares crons.
 */
export async function readCloudflareConfig(
  cwd: string,
): Promise<{ usesEveryAppWorker: boolean; hasCrons: boolean } | null> {
  try {
    const source = await fs.readFile(path.join(cwd, "cloudflare.config.ts"), "utf8");
    return {
      usesEveryAppWorker: source.includes("everyAppWorker"),
      hasCrons: /\bcrons\s*:/.test(source),
    };
  } catch {
    return null;
  }
}
