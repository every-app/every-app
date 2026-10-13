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

## Scheduled work and secrets

`everyAppWorker()` also takes cron schedules and the app's own secrets:

```ts
export default defineConfig((ctx) => ({
  worker: everyAppWorker({
    manifest,
    entrypoint,
    ctx,
    // Runs the Worker's scheduled handler every six hours (UTC).
    crons: ["17 */6 * * *"],
    // The app's own secrets: in dev, declared when .dev.vars sets them.
    secrets: ["GITHUB_TOKEN"],
  }),
}));
```

- **Crons.** Export a `scheduled` handler next to `everyApp()`'s `fetch`:
  `export default { ...everyApp(handler, { tools }), scheduled }`. A
  scheduled run has no user (identity is per request). Deploys keep the
  triggers; an app can't declare routes or domains.
- **Secrets.** `npx everyapp app secret set GITHUB_TOKEN` deploys the app
  with the secret in the same version, and later deploys keep it, so
  production builds don't declare it. In dev, put it in `.dev.vars`:
  `everyAppWorker()` declares it only when it is set there, since the Vite
  plugin passes a `.dev.vars` value through only for a declared secret.
  Type it as optional in `src/env.d.ts` (`GITHUB_TOKEN?: string` in
  `Cloudflare.Env`).

## Agent tools

`defineTools()` describes the actions an app offers to AI clients (Claude,
Cursor, any MCP client). The app never speaks MCP itself: the gateway
snapshots the catalog when you deploy, serves MCP clients from it, and calls a
tool over a private, internal contract with a verified identity.

```ts
import { defineTools, everyApp, ToolError } from "@every-app/sdk/server";
import { z } from "zod"; // or any Standard Schema + Standard JSON Schema validator

export const tools = defineTools(
  {
    list_todos: {
      description: "List the user's todos.",
      risk: "read",
      input: z.object({}).strict(),
      handler: async (_input, { user }) => listTodos(user.id),
    },
    delete_todo: {
      description: "Permanently delete one todo.",
      risk: "destructive", // hidden from AI clients until approvals exist
      input: z.object({ id: z.string() }).strict(),
      handler: async ({ id }, { user }) => {
        if (!(await deleteTodo(user.id, id)))
          throw new ToolError("Todo not found");
      },
    },
  },
  { instructions: "Never guess todo ids; call list_todos first." },
);

export default everyApp(handler, { tools });
```

- `risk` is `read`, `write` or `destructive`. AI clients never see
  destructive tools yet.
- `input` (and the optional `output`) take zod >= 4.2 or any validator that
  implements Standard Schema and Standard JSON Schema; a plain
  `{ jsonSchema, validate }` pair works too. Both describe objects: a
  `z.object`, or a union of objects. A tool whose schema can't be described
  that way is left out of the catalog (the other tools keep working), and
  `everyapp app deploy` prints why.
- Throw `ToolError` for messages the model may read. Other errors are logged
  in the app and reported as "Internal error in <app> (ref <call id>)".
- A handler's second argument carries `user`, `env` (typed as
  `Cloudflare.Env`, which `cf` generates from `cloudflare.config.ts`), `ctx`,
  `request` and `callId`.

`createMcpHandler()` from 0.2 still works in 0.3 but is deprecated and goes
away in 0.4. The gateway keeps proxying `/mcp` to an app that defines no
tools (or sets `mcp: "app"` in its manifest), so such an app keeps serving
its own MCP endpoint until it moves to `defineTools()`.
