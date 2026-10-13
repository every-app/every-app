import { defineConfig } from "cf/config";
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import * as entrypoint from "./src/entry.worker.ts" with { type: "cf-worker" };
import manifest from "./everyapp.config.ts";

// The Worker definition comes from everyapp.config.ts. Add app-specific
// bindings by spreading the result, e.g.
//   const worker = everyAppWorker({ manifest, entrypoint, ctx });
//   return { worker: { ...worker, env: { ...worker.env, BUCKET: bindings.r2({ name: worker.name }) } } };
// (A bucket is named after the Worker: worker.name, or `${worker.name}--<suffix>`.)
// Nothing the Worker imports may be imported here: in dev the Cloudflare Vite
// plugin hides this file's imports from the Worker.
export default defineConfig((ctx) => ({
  worker: everyAppWorker({ manifest, entrypoint, ctx }),
}));
