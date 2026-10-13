import { bindings, defineConfig } from "cf/config";
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import manifest from "./everyapp.config.ts";

// The Worker definition comes from everyapp.config.ts, plus Chef's own
// bindings. Nothing the Worker imports may be imported here: in dev the
// Cloudflare Vite plugin hides this file's imports from the Worker.
export default defineConfig((ctx) => {
  const worker = everyAppWorker({
    manifest,
    entrypoint: "@tanstack/react-start/server-entry",
    ctx,
  });
  return {
    worker: {
      ...worker,
      env: {
        ...worker.env,
        // Recipe images, in a bucket named after this install's Worker.
        R2: bindings.r2({ name: worker.name }),
        // Dev only: your own OpenAI key from .dev.vars, used because local dev
        // has no gateway binding to proxy OpenAI through.
        ...(ctx.mode === "production"
          ? {}
          : { OPENAI_API_KEY: bindings.secret() }),
      },
    },
  };
});
