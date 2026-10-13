import { defineConfig } from "cf/config";
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import manifest from "./everyapp.config.ts";

// The Worker definition comes from everyapp.config.ts. Nothing the Worker
// imports may be imported here: in dev the Cloudflare Vite plugin hides this
// file's imports from the Worker.
export default defineConfig((ctx) => ({
  worker: everyAppWorker({
    manifest,
    entrypoint: "@tanstack/react-start/server-entry",
    ctx,
  }),
}));
