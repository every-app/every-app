# @every-app/sdk

The embedded SDK for building apps on the Every App platform.

This SDK handles authentication and session management for apps running within the Every App Gateway. It provides integrations for TanStack Start and Cloudflare Workers.

## Documentation

For full API reference and usage guides, see the [Embedded SDK documentation](https://everyapp.dev/docs/embedded-sdk/overview/).

## Entry points

- `@every-app/sdk/server`: runs in the Worker. `everyApp()` verifies the identity the gateway injects; the app id comes from `env.EVERYAPP_APP_ID`.
- `@every-app/sdk/cloudflare`: runs in Node while `cf` loads `cloudflare.config.ts`. `everyAppWorker()` builds the Worker definition from `everyapp.config.ts`:

  ```ts
  import { defineConfig } from "cf/config";
  import * as entrypoint from "./src/entry.worker.ts" with { type: "cf-worker" };
  import manifest from "./everyapp.config.ts";
  import { everyAppWorker } from "@every-app/sdk/cloudflare";

  export default defineConfig((ctx) => ({
    worker: everyAppWorker({ manifest, entrypoint, ctx }),
  }));
  ```

  Production builds read `.everyapp/deploy.json`, which only `everyapp app deploy` writes, so deploy with `everyapp app deploy` rather than `cf deploy`.
