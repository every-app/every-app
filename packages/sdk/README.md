# @every-app/sdk

The embedded SDK for building apps on the Every App platform.

This SDK handles authentication and session management for apps running within the Every App Gateway. It provides integrations for TanStack Start and Cloudflare Workers.

## Documentation

For full API reference and usage guides, see the [How Apps Work](https://everyapp.com/docs/apps).

## Entry points

- `@every-app/sdk/server`: runs in the Worker. `everyApp()` verifies the identity the gateway injects. Tokens carry the app's Worker name as their audience, which `everyAppWorker()` declares as `env.EVERYAPP_AUDIENCE` and the deploy fills in (in development, where `everyapp dev` mints for the app id, `env.EVERYAPP_APP_ID` stands in); the app id comes from `env.EVERYAPP_APP_ID`. The handler gets the runtime's `ExecutionContext` as the Worker received it, so it goes on to Hono's `app.fetch(request, env, ctx)` or React Router's request handler without a cast.
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

  Production builds are tenant-neutral: the same Build Output whoever builds the app, with placeholders (`sentinelDeployTarget()`, `BUILD_SENTINEL` in `@every-app/sdk/cloudflare/sentinel`) wherever an install's Worker name, organization, gateway URL, identity keys and resource names or ids go. `everyapp deploy` builds with `EVERYAPP_BUILD=1` and then installs the output (rewrites every placeholder, refusing one that survives); without that variable a production build throws, so deploy with `everyapp deploy` rather than `cf deploy`. Installing a shared app also swaps `EVERY_APP_ORG_ID` for `EVERYAPP_SHARED`, and a deploy that deletes Durable Object classes adds their tombstones.

  `localD1Path(root, id)` is the sqlite file `cf dev` keeps the local D1 database `id` in (`env.DB.id` of a development `everyAppWorker()`, or `localD1Id(workerName, binding)`), for drizzle-kit studio.

- `@every-app/sdk/dev`: the well-known keypair and issuer `everyapp dev` signs local identities with. Public by design: the SDK accepts it only in development (`EVERYAPP_DEV`, which `everyAppWorker()` sets there and a deploy never does) and only from the dev issuer.

## Scheduled work and secrets

`everyAppWorker()` also takes cron schedules, and the manifest names the
app's own secrets:

```ts
// everyapp.config.ts
export default {
  id: "repolens",
  // The app's own secrets, set with `everyapp secret set GITHUB_TOKEN`
  // in this directory; in dev, declared when .dev.vars sets them.
  secrets: ["GITHUB_TOKEN"],
} as const;

// cloudflare.config.ts
export default defineConfig((ctx) => ({
  worker: everyAppWorker({
    manifest,
    entrypoint,
    ctx,
    // Runs the Worker's scheduled handler every six hours (UTC).
    crons: ["17 */6 * * *"],
  }),
}));
```

- **Crons.** Export a `scheduled` handler next to `everyApp()`'s `fetch`:
  `export default { ...everyApp(handler, { tools }), scheduled }`. A
  scheduled run has no user (identity is per request). Deploys keep the
  triggers; an app can't declare routes or domains.
- **Secrets.** The manifest's `secrets` lists the app's own by name; a
  name that is one of the Gateway's settings (`OPENAI_API_KEY`, say) is
  refused there, since the app reaches those through `providers` and
  `capabilities`. `everyapp secret set GITHUB_TOKEN` in the app's directory
  puts it on the live Worker (and each helper) in a new version, and later
  deploys keep it, so production builds don't declare it. In dev, put it
  in `.dev.vars`: `everyAppWorker()` declares it only when it is set there,
  since the Vite plugin passes a `.dev.vars` value through only for a
  declared secret. Type it as optional in `src/env.d.ts`
  (`GITHUB_TOKEN?: string` in `Cloudflare.Env`).

## Compatibility flags

Every Worker `everyAppWorker()` and `everyAppAuxiliaryWorker()` build has
`nodejs_compat` and the compatibility date `2026-06-01` (or the manifest's
`compatibilityDate`). `compatibilityFlags` adds flags after `nodejs_compat`,
each once:

```ts
everyAppWorker({
  manifest,
  entrypoint,
  ctx,
  // fetch() reaches only the public internet: no private or local addresses.
  compatibilityFlags: ["global_fetch_strictly_public"],
});
```

## Durable Objects

Declare a Durable Object by binding and class,
`resources: { durableObjects: [{ name: "MAILBOX", className: "MailboxDO" }] }`,
and export the class from the Worker entry. When `entrypoint` is the entry
imported as a `cf-worker` module (as above), `cf workers types` types the
binding with the class, `env.MAILBOX: DurableObjectNamespace<MailboxDO>`, so
RPC calls on a stub type-check: the binding names the Worker by its
definition (`worker: { name, compatibilityDate, entrypoint }`), which cf
resolves to the Worker's name. With a path entrypoint, and for a class a
helper Worker defines, the binding names the Worker by name and the
namespace is untyped. Retype it in `src/env.d.ts` (a plain cast is refused):

```ts
import type { Scratchpad } from "./audit.worker";

export type AppEnv = Omit<Env, "SCRATCHPAD"> & {
  SCRATCHPAD: DurableObjectNamespace<Scratchpad>;
};
```

## Workflows

Declare a [Workflow](https://developers.cloudflare.com/workflows/) in
`everyapp.config.ts` by binding and class,
`resources: { workflows: [{ name: "RANK_CHECK", className: "RankCheckWorkflow" }] }`,
and export the `WorkflowEntrypoint` class from the Worker entry.
`everyAppWorker()` defines and binds it under a name after the Worker
(`every-acme-seo--rank-check`, from `workflowNameFor()`), because Workflow
names are shared by the whole Cloudflare account. Start one with
`env.RANK_CHECK.create({ params })`; a run has no user.

## Helper Workers

An app can run part of its work on Workers of its own, e.g. a memory-hungry
job that would crowd the app's isolate. Declare each one, and the Durable
Objects and Workflows it defines:

```ts
resources: {
  durableObjects: [{ name: "SCRATCHPAD", className: "Scratchpad", worker: "audit" }],
  workflows: [{ name: "SITE_AUDIT", className: "SiteAuditWorkflow", worker: "audit" }],
},
workers: [{ name: "audit", binding: "AUDIT" }],
```

Build it as an auxiliary Worker of the Vite plugin:

```ts
// vite.config.ts: defineConfig(({ mode }) => ({ plugins: [ … ] }))
cloudflare({
  viteEnvironment: { name: "ssr" },
  auxiliaryWorkers: [
    {
      config: everyAppAuxiliaryWorker({
        manifest,
        worker: "audit",
        entrypoint: "./src/audit.worker.ts",
        ctx: { mode },
      }),
    },
  ],
}),
```

It deploys as `every-acme-seo--audit`, private like the app: only the app's
Worker reaches it, through `env.AUDIT` and the bindings of the classes it
defines. It shares the app's D1 databases, KV namespaces and R2 buckets, and
calls the gateway as the app, with the app's `GATEWAY_URL` and
`EVERY_APP_ORG_ID`, so its background calls (a Workflow's, say) are the
organization's like the app's. `everyapp deploy` checks and uploads helpers before the
app's Worker, and `everyapp delete --purge` deletes them, and the Workflows
they run, with it. A class stays in the Worker that first defined it.

## Postgres through Hyperdrive

An app whose data lives in Postgres declares the database and a
[Hyperdrive](https://developers.cloudflare.com/hyperdrive/) config, and
migrates it with drizzle:

```ts
resources: { hyperdrive: [{ name: "HYPERDRIVE" }] },
database: { provider: "postgres", region: "aws:us-east-1" },
migrations: { engine: "drizzle", dialect: "postgresql", dir: "drizzle/pg", config: "drizzle/pg.config.ts" },
workers: [{ name: "audit", limits: { cpuMs: 300_000 } }],
limits: { cpuMs: 30_000 },
```

Every one of the app's Workers binds `env.HYPERDRIVE` (a config with
`worker: "<helper>"` binds only that helper) and reads `DATABASE_PROVIDER`
(`"postgres"`); deployed, they run near `database.region`. `limits.cpuMs`
raises a Worker's CPU time per invocation, up to 5 minutes. `everyapp
deploy` reads the database's URL from `.everyapp/secrets.env`, which it
never uploads or prints:

```sh
POSTGRES_DATABASE_URL=postgres://<user>:<password>@<host>:<port>/<database>
# optional: the origin a binding's config connects to, when it isn't that one
HYPERDRIVE_ORIGIN_URL=postgres://<app user>:<password>@<host>:<port>/<database>
```

It creates the config `every-acme-seo--hyperdrive` from it, or adopts one of
that name that connects to the same database, runs `drizzle-kit migrate`
(your config reads `process.env.POSTGRES_DATABASE_URL`) before it uploads, and
`everyapp delete --purge` deletes the config, never the database. In
development, set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`
in `.dev.vars` to a local Postgres; without it the binding is absent. Apps on
the dispatch tier (customer code in a Workers for Platforms namespace) can't
use Hyperdrive.

The configs `everyapp deploy` creates cache no queries: Hyperdrive never
invalidates a cached read when the app writes, and app code reads its own
writes. A deploy turns caching back off on a config that caches. For a
read-heavy config that tolerates reads up to a minute old,
`hyperdrive: [{ name: "HYPERDRIVE", caching: "default" }]` keeps Cloudflare's
own caching (60 s, served stale for 15 s more).

An app on Prisma migrates with `prisma migrate deploy` instead:

```ts
migrations: { engine: "prisma", dialect: "postgresql", config: "prisma.config.ts" },
```

The deploy runs the app's own `prisma` (a devDependency) with
`POSTGRES_DATABASE_URL` in its environment, so `prisma.config.ts` reads it:
`datasource: { url: process.env.POSTGRES_DATABASE_URL }`. Prisma finds its
migrations through its config; a `dir` in the manifest only makes the deploy
skip the migration when that directory is missing. The deploy can't check the
schema against the migrations (Prisma needs a shadow database for that) and
says so; run `prisma migrate diff --from-migrations <dir> --to-schema
<schema> --exit-code` yourself. Prisma on D1 is no engine of its own: generate
the SQL (`prisma migrate diff --from-empty --to-schema schema.prisma
--script`), put `--> statement-breakpoint` between its statements, and ship it
with `migrations: { engine: "d1-sql", dir: "migrations", binding: "DB" }`.

## R2 buckets

Declare the app's buckets by binding, and every one of its Workers (helpers
included) binds them:

```ts
resources: { r2: ["R2", "MEDIA"] },
```

`R2` is the bucket named after the app's Worker (`every-acme-postiz`), any
other binding `<worker>--<binding>` (`every-acme-postiz--media`); the
gateway assigns the names when it registers the app, and the deploy's policy
refuses any other bucket. The deploy doesn't create, record or purge buckets
yet: `cf deploy` should create a bound bucket that doesn't exist (not yet
confirmed on a live account), and the dashboard can create one before the
first deploy. A bucket bound by hand in
`cloudflare.config.ts`, `bindings.r2({ name: worker.name })`, keeps working
while the manifest declares none. Apps on the dispatch tier can't have
buckets yet.

## Node frameworks (Express, NestJS)

A Node HTTP framework runs in the Worker on workerd's `node:http` bridge
(`cloudflare:node`), which `nodejs_compat` and the compatibility date turn
on. `nodeServerHandler()` starts the server on the isolate's first request
and hands it every request `everyApp()` lets through:

```ts
// src/entry.worker.ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { everyApp, nodeServerHandler } from "@every-app/sdk/server";
import { AppModule } from "./app.module";

const handler = nodeServerHandler({
  boot: async () => {
    const app = await NestFactory.create(AppModule, { rawBody: true });
    await app.listen(0);
    return { port: app.getHttpServer().address().port };
  },
});

export default { ...everyApp(handler), scheduled };
```

- **`listen(0)`.** workerd picks the port. A fixed port is still held by the
  server of the module graph a Vite reload replaced, so the next boot fails
  with `EADDRINUSE`.
- **Identity.** `everyApp()` has verified the identity before the Node app
  sees the request, which still carries it as `x-everyapp-identity`. To know
  the user in Node code, verify it again from the request's headers with the
  Worker's text bindings, which `nodejs_compat` puts on `process.env`:
  `await getEveryAppUser(new Request(url, { headers }), process.env)`.
- **What comes back.** `Set-Cookie` is dropped: the gateway owns the
  session and strips cookies from what reaches the app. Drop `compression()`
  too (Cloudflare compresses at the edge); a body Node encodes anyway is
  passed through as is, since the bridge alone would encode it a second
  time.
- **No identity outside `fetch`.** `scheduled` (and `email`) handlers sit
  beside `fetch` and run with no user; they reach the Node app only if they
  call it themselves.

Three rules decide whether such a Worker runs at all:

1. **Minify the Worker.** A Node framework's dependency graph is large, and
   the isolate's heap grows with the source it loads (about 2.5 MB per MiB
   locally), against a 128 MB limit. `unplugin-swc` (for Nest's decorator
   metadata) sets `esbuild: false`, which also silently skips Vite's esbuild
   minifier: `build.minify: true` changes nothing. Use
   `build.minify: "terser"` (with `terser` installed), or minify the Worker's
   chunks yourself:

   ```ts
   // vite.config.ts
   import { transform } from "esbuild";

   const minifyWorker = {
     name: "minify-worker",
     apply: "build" as const,
     enforce: "post" as const,
     applyToEnvironment: (environment: { name: string }) =>
       environment.name !== "client",
     async renderChunk(code: string) {
       const result = await transform(code, {
         minify: true,
         format: "esm",
         target: "es2022",
         legalComments: "none",
       });
       return { code: result.code, map: null };
     },
   };
   ```

   Check that the bundle's size actually changed. On Vite 8 (oxc instead of
   SWC) measure it again before and after.

2. **No work at module scope.** workerd refuses random values
   (`crypto.randomUUID`, `getRandomValues`), timers and I/O (`fetch`,
   sockets) outside a request ("Disallowed operation called within global
   scope"), and `import.meta.url` is undefined, so
   `createRequire(import.meta.url)` and `fileURLToPath(import.meta.url)`
   throw. Nothing reachable from a module's top level may do these: make
   every client (`new Stripe()`, `new OpenAI()`, SDK singletons) a lazy
   factory, and create the app in `boot`.

3. **Stay inside the heap budget.** After `boot` and a few requests, the
   isolate's used heap should be at most about 64 MB locally, half the
   limit, leaving room for request bodies and caches. Read it from
   miniflare's inspector (`inspectorPort`, then `Runtime.getHeapUsage` over
   the websocket); `v8.getHeapStatistics()` reads zero in workerd.
   `wrangler check startup` is only a smoke test for module-scope work.

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
  `everyapp deploy` prints why.
- Throw `ToolError` for messages the model may read. Other errors are logged
  in the app and reported as "Internal error in <app> (ref <call id>)".
- Return `toolResult({ text, structured })` to give the model a written
  summary while clients get the data: `structured` is checked against the
  tool's `output` schema. A plain value is sent as JSON text.
- A handler's second argument carries `user`, `env` (typed as
  `Cloudflare.Env`, which `cf` generates from `cloudflare.config.ts`), `ctx`,
  `request` and `callId`.

## Capabilities

Third-party APIs whose key the gateway holds (`docs/capabilities.md`). List
one in `everyapp.config.ts` (`capabilities: { dataforseo: { access: "read",
why: "Keyword research" } }`) and call the provider's real URLs:

```ts
import { gatewayRefusal, integrationFetch } from "@every-app/sdk/server";

const dataforseo = integrationFetch({
  env,
  provider: "dataforseo",
  for: request,
});
const response = await dataforseo(
  "https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live",
  { method: "POST", body: JSON.stringify([{ keywords: ["seo"] }]) },
);
const refused = await gatewayRefusal(response); // null: DataForSEO answered
```

The call goes over the gateway binding, which puts the key on it.
`gatewayRefusal(response)`
tells the gateway's own refusals (`x-everyapp-error`: the manifest doesn't
list the capability, the gateway holds no key) from the provider's answers.
`integrationStatus({ env, provider })` says whether calls would go through,
without making one. In local dev, with no binding, the key comes from
`.dev.vars` under the gateway secret's name (`DATAFORSEO_API_KEY`), and so do
the AI providers' (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or
`WORKERS_AI_API_TOKEN` with `CLOUDFLARE_ACCOUNT_ID` for Workers AI, which is
billed to that account) for `createGatewayFetch`: `everyAppWorker()` declares
the settings of each capability and provider the manifest lists when they
are set there, so the dev server passes them through.

<!-- TODO(integration): PR 7 (port/ports-todo-and-docs) adds Workers AI's dev settings, as PR 1's report asked; this README is PR 2's file. -->

### Email

The gateway sends mail for apps (`docs/capabilities.md`, "Gateway services:
email"). List `capabilities: { email: { access: "write" } }`; to send as
your own addresses, set them on the installation with
`pnpm everyapp email set --sender "*@mail.example.com"` in the app's
directory after its first deploy (each domain onboarded to Email Sending in
the gateway's account), and send:

```ts
import { GatewayRefusalError, sendEmail } from "@every-app/sdk/server";

const { messageId, status } = await sendEmail({
  env,
  for: request,
  message: {
    to: ["customer@example.net"],
    subject: "Re: your question",
    text: "Thanks for writing.",
    from: { address: "support@mail.example.com", name: "Acme Support" },
    headers: { "In-Reply-To": "<original@example.net>" },
  },
});
```

Leave `from` out to send as the gateway's sender. A refusal throws
`GatewayRefusalError` with its `code` (`email_sender_not_allowed`,
`email_budget_exhausted`, `integration_not_configured`, ...) and a message to
show. `integrationStatus({ env, provider: "email" })` adds the gateway's
`sender` and the `senders` the installation allows. In local dev, with no
binding, the message is checked as the gateway would, then printed and
answered `{ status: "logged" }`; set `EVERYAPP_EMAIL_SENDERS` in `.dev.vars`
to allow `from` addresses locally, and `EMAIL_REST_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` and `EMAIL_FROM` to send for real from your own
account. An `email()` handler (inbound mail, declared with
`email: { inbound: true }`; `everyapp email set --inbound` routes addresses
to it) sits beside `everyApp()`'s `fetch` and passes
`for: { background: true, organizationId }`.

### Members

The gateway lists the organization's members who can open the app now
(`docs/capabilities.md`, "Gateway services: members"): read it when acting
for people outside a request, such as choosing whom a scheduled report goes
to, rather than a copy the app kept. List
`capabilities: { members: { access: "read" } }`, and:

```ts
import { listMembers } from "@every-app/sdk/server";

const { members } = await listMembers({ env, for: { background: true } });
// [{ id, email, name, role: "owner" | "admin" | "member" }, ...]
```

People who were deactivated, left the organization or (for an
organization's own app) weren't granted the app are left out. An agent's
tool call is refused (`integration_agent_not_allowed`). In local dev, with
no binding, it answers the request's signed-in user alone, and no one for
background work.

### Social networks' OAuth clients

The gateway holds a client for each social network its operator set up
(`docs/capabilities.md`, "OAuth clients": `linkedin`, `facebook`,
`instagram`, `threads`, `youtube`, `tiktok`, `tiktok-business`, `reddit`,
`pinterest`, `discord`, `slack`, `mastodon`, `kick`, `twitch`, `tumblr`,
`dribbble`; and for mail and calendar, `google-workspace` and
`microsoft-365`). List one for writing (`capabilities: { linkedin: { access:
"write" } }`), build the authorize URL from its public id, and exchange or
refresh tokens through the gateway without any client:

```ts
import { integrationFetch, integrationStatus } from "@every-app/sdk/server";

const { ready, clientId } = await integrationStatus({
  env,
  provider: "linkedin",
});
// ...redirect to https://www.linkedin.com/oauth/v2/authorization?client_id=${clientId}&...
const tokens = await integrationFetch({
  env,
  provider: "linkedin",
  for: request,
})("https://www.linkedin.com/oauth/v2/accessToken", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri,
  }),
});
```

The gateway completes the network's token endpoints only, putting its client
where each one takes it (form body, HTTP Basic, query string or JSON body);
anything else throws a `TypeError` before it is sent. Call the network's API
with the user's token directly. Mastodon's status also gives the instance as
`origin`. In local dev, with no binding, `.dev.vars` holds your own client
under the gateway's names (`LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`,
`MASTODON_URL`, ...) and the same rule puts it on the call.

### Whom a call is for

`createGatewayFetch`, `integrationFetch`, `sendEmail` and `listMembers` take `for`, which
decides the organization the call is attributed to:

- `for: request`, the inbound request: the identity the gateway put on it
  is forwarded, so the call is that person's, in their organization.
- `for: { background: true, organizationId }`, for work no request started
  (a cron, a Workflow step, a queue): sent as `x-everyapp-org` with no
  identity. A shared app (one Worker for every organization, on the hosted
  gateway) must name the organization; the gateway checks it is active and
  has a live member, and refuses it if the call also forwards an identity
  of another organization.
- Omitted: allowed only in an organization's own app, whose background
  calls are the app's, in its own organization (the same as
  `{ background: true }`). Naming another organization is refused.

In a shared app's Worker (`EVERYAPP_SHARED=1`, which `everyapp deploy` sets
when it installs a shared app) a call that names neither throws `AttributionError`
when the fetch is created:

```ts
// In a Workflow step of a shared app:
const dataforseo = integrationFetch({
  env,
  provider: "dataforseo",
  for: { background: true, organizationId: event.payload.organizationId },
});
```

`createMcpHandler()` from 0.2 still works in 0.3 but is deprecated and goes
away in 0.4. The gateway keeps proxying `/mcp` to an app that defines no
tools (or sets `mcp: "app"` in its manifest), so such an app keeps serving
its own MCP endpoint until it moves to `defineTools()`.
