import { defineConfig } from "cf/config";
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import * as entrypoint from "./src/entry.worker.ts" with { type: "cf-worker" };
import manifest from "./everyapp.config.ts";

// The Worker is built from everyapp.config.ts: its bindings, its identity
// keys, its name. Nothing the Worker imports may be imported here: in dev the
// Cloudflare Vite plugin hides this file's imports from the Worker.
export default defineConfig((ctx) => ({
  worker: everyAppWorker({ manifest, entrypoint, ctx }),
}));
