---
title: everyapp.config.ts reference
description: Every field of the app manifest (everyapp.config.ts) with its rule and default, what the deploy makes from it, and what the Gateway does with it.
---

The manifest says who the app is, what it binds and what it opens to the internet. It is `everyapp.config.ts` in the app's root; `cloudflare.config.ts` turns it into the Worker with `everyAppWorker()`. The deploy validates it strictly (`INVALID_MANIFEST` names the field), registers it with the Gateway, and the Gateway enforces it on every request.

```ts
// everyapp.config.ts
import { defineEveryApp } from "@every-app/sdk";

export default defineEveryApp({
  id: "notes",
  name: "Notes",
  resources: { d1: ["DB"] },
  public: [{ path: "/share/:id" }],
  capabilities: { email: { access: "write", why: "Sends a note to a teammate." } },
});
```

```ts
// cloudflare.config.ts
import { defineConfig } from "cf/config";
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import * as entrypoint from "./src/entry.worker.ts" with { type: "cf-worker" };
import manifest from "./everyapp.config.ts";

export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));
```

Only `id` is required. Everything not declared is private and refused.

## Identity and display

- `id`: kebab-case (`^[a-z]([a-z0-9-]*[a-z0-9])?$`), no `--`, not `everyapp`. It names the hostname (`<id>.<app base domain>`), the Worker (`every-<orgKey>-<id>`) and every resource (`<worker>--<binding>`). Changing it alone makes a new app; to rename one, list the old id under `previousIds`.
- `previousIds`: the ids the app had before, to rename it (`id: "scribe", previousIds: ["talk"]`). The deploy moves the registered app to the new id after a confirmation: it keeps its Worker, data, secrets and everything the Gateway holds for it, and the old hostname keeps working (page loads redirect; bearer and non-GET requests are served there) until the id leaves this list. An id here that no app has stops the deploy. [Renaming an app](/docs/agent/deploy#renaming-an-app)
- `name`: the display name (default: the id). `description`: one line for the app library. `icon`: the path of an SVG the app serves (`/everyapp-icon.svg`).
- `compatibilityDate`: `YYYY-MM-DD` for every Worker of the app (default `2026-06-01`).
- `access`: who can open the app when it is first registered. `admins` (default): owners and admins, who open every app anyway. `everyone`: the app is available to everyone, every member now and later. A redeploy changes nothing; admins manage access in Admin → Apps afterwards.

## `resources`

Bindings the Worker reads from `env`. The deploy creates each in the person's Cloudflare account, named after the Worker (`W`), records it as the app's, and reuses it on the next deploy. `everyapp delete --purge` deletes what the app recorded.

| Field | Form | Account name and notes |
|---|---|---|
| `resources.d1` | `["DB"]` | `W` for `DB`, else `W--<binding>`. Migrated by the deploy (`migrations`). |
| `resources.kv` | `["KV"]` | Same naming. |
| `resources.r2` | `["FILES"]` | Same naming. R2 must be enabled on the account once (`R2_NOT_ENABLED`). |
| `resources.durableObjects` | `[{ name, className, worker? }]` | `resources.durableObjects[].name` is the binding, `resources.durableObjects[].className` the exported class, `resources.durableObjects[].worker` the helper that defines it (default: the app's Worker). Dropping a class deletes its data: the deploy refuses without `--allow-delete-durable-object-data`. |
| `resources.workflows` | `[{ name, className, worker? }]` | `W--<binding>`, at most 64 characters. `resources.workflows[].name`, `resources.workflows[].className`, `resources.workflows[].worker` as for Durable Objects. Dropping one needs `--allow-delete-workflows`. |
| `resources.hyperdrive` | `[{ name, worker?, caching? }]` | Postgres through Hyperdrive ([Postgres](#postgres)). `resources.hyperdrive[].name` is the binding; `resources.hyperdrive[].worker` limits it to one helper; `resources.hyperdrive[].caching` is `off` (default: apps read their own writes) or `default`. |
| `resources.queues` | `[{ name, consumer? }]` | [Queues](#queues). |
| `resources.ai` | `["AI"]` | The Workers AI binding (`env.AI.run()`), account-wide, nothing created. Remote even under `everyapp dev`. Not the Gateway's AI providers (`providers`). |
| `resources.browser` | `["BROWSER"]` | Browser Rendering (`@cloudflare/puppeteer`), account-wide. Works locally. |
| `resources.images` | `["IMAGES"]` | Cloudflare Images, account-wide. Works locally. |
| `resources.vectorize` | `[{ name, dimensions, metric }]` or `[{ name, preset }]` | [Vectorize](#vectorize). |
| `resources.aiGateway` | `[{ name, collectLogs?, cacheTtl? }]` | An AI Gateway of the app's own, id `W-<binding>`. `resources.aiGateway[].name` is the binding (a json `{ id, accountId, url }`); `resources.aiGateway[].collectLogs` (default `true`); `resources.aiGateway[].cacheTtl` seconds (default `0`). Separate from the Gateway's AI proxy. |
| `resources.sendEmail` | `[{ name, allowedSenderAddresses, … }]` | [Email sending](#email-sending). |
| `resources.secretsStore` | `[{ name }]` | A Secrets Store secret `W--<binding>`, read with `await env.<NAME>.get()`. `resources.secretsStore[].name` is the binding. The account needs a store (create one once in the dashboard); the value comes from `<BINDING>=` in `.everyapp/secrets.env`. |
| `resources.analyticsEngine` | `[{ name, dataset? }]` | `resources.analyticsEngine[].name` is the binding; `resources.analyticsEngine[].dataset` defaults to `W--<binding>`. Nothing created; data expires after 90 days. |
| `resources.artifacts` | `[{ name }]` | A Cloudflare Artifacts namespace `W--<binding>` (git repos the Worker creates). `resources.artifacts[].name` is the binding. Remote under `everyapp dev`. |

Every D1, KV, R2, queue producer and Vectorize binding is on all of the app's Workers.

### Queues

`resources.queues[].name` is the producer binding; the queue is `W--<binding>`. `resources.queues[].consumer` is `true` (the app's Worker consumes) or an object: `resources.queues[].consumer.worker` (a helper consumes), `resources.queues[].consumer.maxBatchSize`, `resources.queues[].consumer.maxBatchTimeout`, `resources.queues[].consumer.maxRetries`, `resources.queues[].consumer.maxConcurrency`, `resources.queues[].consumer.retryDelay`, `resources.queues[].consumer.visibilityTimeoutMs` and `resources.queues[].consumer.deadLetterQueue` (another declared queue's binding). The consuming Worker must export `queue(batch, env)` beside its fetch handler (`QUEUE_HANDLER_MISSING`).

### Vectorize

`resources.vectorize[].name` is the binding; the index is `W--<binding>` (at most 64 characters). Give either `resources.vectorize[].dimensions` (32 to 1536) with `resources.vectorize[].metric` (`cosine`, `euclidean` or `dot-product`), or `resources.vectorize[].preset`: `@cf/baai/bge-small-en-v1.5`, `@cf/baai/bge-base-en-v1.5`, `@cf/baai/bge-large-en-v1.5`, `openai/text-embedding-ada-002` or `cohere/embed-multilingual-v2.0`. An index's shape can't change (`VECTORIZE_CONFIG_MISMATCH`): rename the binding for a new one.

### Email sending

`resources.sendEmail` binds Cloudflare's own `send_email` binding, for an app that sends with its own Email Sending domain. Most apps use the Gateway's `email` capability and `sendEmail()` instead ([email](/docs/agent/email)). `resources.sendEmail[].name` is the binding; `resources.sendEmail[].allowedSenderAddresses` (required, exact addresses) are the only `from` addresses; `resources.sendEmail[].destinationAddress` or `resources.sendEmail[].allowedDestinationAddresses` limit the recipients. Under `everyapp dev` nothing is sent.

### Postgres

Any Postgres with a URL (Neon, Supabase, PlanetScale, your own) goes through Hyperdrive:

1. Put the direct (not pooled) URL in `.everyapp/secrets.env` as `POSTGRES_DATABASE_URL=postgres://…` (or `<BINDING>_ORIGIN_URL`). It stays on the machine that deploys; never paste it in chat.
2. Declare `database: { provider: "postgres" }` and `resources: { hyperdrive: [{ name: "HYPERDRIVE" }] }`, and for drizzle migrations `migrations: { engine: "drizzle", dialect: "postgresql", config: "drizzle/pg.config.ts" }`.
3. In code, open a client per request on `env.HYPERDRIVE.connectionString` (`postgres(url, { max: 1, fetch_types: false })`).

Under `everyapp dev`, set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://…` in `.dev.vars`. OpenSEO is the example. Turso isn't Postgres: its URL and token are app `secrets`.

## `workers`

Helper Workers deployed beside the app's Worker, for work that shouldn't share its memory or CPU: `workers[].name` (kebab-case, at most 20 characters; the Worker is `W--<name>`), `workers[].binding` (a service binding on the app's Worker), `workers[].limits` with `workers[].limits.cpuMs`. Only the app's own Worker can reach a helper. Build one with `everyAppAuxiliaryWorker()`.

## `database` and `limits`

- `database.provider`: `d1` or `postgres`; every Worker gets it as `DATABASE_PROVIDER`. `database.region`: `aws:us-east-1`-style, for placement near the database.
- `limits.cpuMs`: CPU time per invocation of the app's Worker, 1 to 300000.

## `public` and `publicAssets`

The app is private by default: every request needs a signed-in member with access.

- `public`: routes anyone can reach, each `{ path, methods?, bearer? }`. Each `public[].path` is an absolute glob (`*` within a segment, `**` across, `:name` one segment), with `public[].methods` (default `["GET"]`). Public means auth-optional: a signed-in member still gets their identity; an anonymous visitor gets `x-everyapp-public` instead. Refused: catch-alls (`/**`), percent-encoding, backslashes, `.` segments, anything under `/__everyapp`, and `/mcp`. Declare a route public only when something other than a member must reach it (a webhook, a share page).
- `public[].bearer`: `true` makes the entry a bearer route: a bearer client (a native app, a script with a personal token) reaches it with its Gateway token only, on every method, never anonymously, so it takes no `methods`. A request with the session cookie there is refused (`cookie_on_bearer_route`). It can't be `/mcp` or also an anonymous route. Behind Access, `access on` lets it through Access. [Native apps](/docs/agent/native)

  ```ts
  public: [{ path: "/api/**", bearer: true }],
  ```

- `publicAssets`: up to 25 path globs of static files anyone may GET (favicons, `/assets/**` a public page loads). No identity is forwarded, ever.

## What the app needs set: providers, capabilities, secrets, settings, features

Everything listed at the top level is required: the app shows Needs setup until it's set. What the app works without, or what a person sets up together (a GitHub App, a Slack app), goes in a [feature](#features). `everyapp configure <app>` walks it all. [secrets](/docs/agent/secrets)

### providers

`providers`: AI providers the app calls through the Gateway's AI proxy, as ids (`"openrouter"`) or `{ id, why?, docs? }`: `providers[].id`, `providers[].why`, `providers[].docs`. The key stays on the Gateway. [ai](/docs/agent/ai)

### capabilities

`capabilities`: Gateway-held APIs by id. An API-key provider or service takes `capabilities.<id>.access` (`read` or `write`); an OAuth provider takes `capabilities.<id>.scopes` (the provider's own short scope names) and a required `capabilities.<id>.why`. All take `capabilities.<id>.docs`. The deployed entry is the grant; calls outside it are refused. Built-ins include `email`, `members`, `dataforseo` and `context`; OAuth presets include `google-workspace`, `microsoft-365` and `slack`, each registered when the app deploys; the full list is on [providers](/docs/agent/providers).

### secrets

`secrets`: the app's own secrets, as names or `{ name, why?, docs?, how?, generate?, file? }`:

- `secrets[].name`: an identifier, not reserved (`GATEWAY_URL`, `CF_VERSION_METADATA`, `EVERYAPP_*`, `EVERY_APP_*`, `APP__*`), not a Gateway setting (list the provider instead), and not a binding.
- `secrets[].why`, `secrets[].docs`: why the app needs it, and an https page about it.
- `secrets[].how`: where the value lives and what permission it needs, at most 200 characters. `{appUrl}` and `{gatewayUrl}` are filled in.
- `secrets[].generate`: `true` makes the value (32 random bytes, base64url). The deploy sets a top-level one that has no `how`; `configure` sets the rest and shows one once when its `how` says where to paste it.
- `secrets[].file`: `true` for a file's contents (a `.pem`): the prompt takes the file's path.

### settings

`settings`: plain values that differ per install (an analytics host, a region). `settings[].name`, a required `settings[].why`, `settings[].how`, `settings[].type` (`text`, `url`, `number` or `boolean`), `settings[].values` (a list a text setting must be one of), `settings[].default` (the deploy writes it, so a setting with one never blocks), `settings[].docs`. Shown when typed; anything that grants access belongs in `secrets`.

### features

`features`: what the app needs set, grouped by what it gives, each with numbered setup steps. The key is the feature's id, a lowercase slug.

```ts
features: {
  github: {
    name: "GitHub",
    required: true,
    why: "Agents push branches and open pull requests through your GitHub App.",
    steps: [
      "Create a GitHub App: https://github.com/settings/apps/new",
      "Webhook URL: {appUrl}/github/webhooks. Permissions: Contents, Pull requests → Read and write.",
    ],
    settings: [{ name: "GITHUB_APP_ID", how: "The App's General page → App ID" }],
    secrets: [
      { name: "GITHUB_APP_PRIVATE_KEY", file: true, how: "General → Private keys → Generate; give the downloaded .pem" },
      { name: "GITHUB_WEBHOOK_SECRET", generate: true, how: "Paste this into the App's Webhook secret" },
    ],
  },
  slack: { name: "Slack", why: "Agents answer in Slack.", capabilities: ["slack"], secrets: ["SLACK_SIGNING_SECRET"] },
},
```

- `features.<id>.name`: what people read. `features.<id>.why`: what it gives, one sentence.
- `features.<id>.required`: `true` keeps the app closed until every value is set. Default `false`: optional, all or nothing. An optional feature is `off` while none of its values is set (never blocks), `incomplete` while some are (a warning, never a block), `ready` once all are.
- `features.<id>.steps`: short Markdown lines, numbered when shown; links as plain URLs or `[text](url)`; `{appUrl}` and `{gatewayUrl}` are filled in.
- `features.<id>.settings`: `{ name, how?, type?, values?, default? }`: `features.<id>.settings[].name`, `features.<id>.settings[].how`, `features.<id>.settings[].type`, `features.<id>.settings[].values`, `features.<id>.settings[].default`.
- `features.<id>.secrets`: names or `{ name, how?, generate?, file? }`: `features.<id>.secrets[].name`, `features.<id>.secrets[].how`, `features.<id>.secrets[].generate`, `features.<id>.secrets[].file`.
- `features.<id>.capabilities`, `features.<id>.providers`: ids the feature needs, each declared under `capabilities` or `providers` too. Listed in an optional feature, it no longer blocks the app. `configure` says whether each is set and the one command if not (`everyapp provider add <id>`; `secret set` for a Gateway service such as email).

A name goes in one place: the top level or one feature. A capability or provider belongs to one feature at most. A feature lists something to set.

## `ai`

Limits on the app's use of the Gateway's AI proxy (not `resources.ai`):

- `ai.chat`: the app takes the workspace's default chat model. `true`, or `{ why?, docs? }`: `ai.chat.why`, `ai.chat.docs`. Always required.
- `ai.models`: model ids the app may request. Omitted: any.
- `ai.routes`: OpenAI API paths beyond inference (`/v1/files`), each covering its sub-paths. The deployed manifest is the grant.

## email and events

- `email.inbound`: `true` when the Worker exports an `email()` handler. The addresses are set with `everyapp email set --inbound`, not here. [email](/docs/agent/email)
- `events`: `{ subscribe, why }`: Gateway events pushed to the app. `events.subscribe` lists 1 to 25 types or patterns (`member.*`, `app.tools_changed`); `events.why` is the subscription's description. [events](/docs/agent/events)

## Build, dev and install

- `build`: the production build command, run with `EVERYAPP_BUILD=1` (default `cf build`, with `--mode production` for an app without Vite).
- `dev`: the dev server command `everyapp dev` runs with `PORT` set; it must listen there (default `cf dev`).
- `install`: `false` to skip, a command, or omitted to detect the package manager.

## `migrations`

| Field | Values | Default |
|---|---|---|
| `migrations.engine` | `drizzle`, `d1-sql` (SQL files written another way), `prisma` | required when `migrations` is set |
| `migrations.dialect` | `sqlite` (D1), `postgresql` | `sqlite` |
| `migrations.dir` | relative path | `drizzle` (required for `d1-sql`) |
| `migrations.config` | the drizzle or Prisma config, relative | the tool's default |
| `migrations.binding` | a `resources.d1` binding | the first one |

Prisma needs `postgresql`; `postgresql` needs `database.provider: "postgres"`. On D1 the deploy saves a restore point, then applies the migrations before the upload; `everyapp db restore` goes back. With drizzle the deploy first checks the schema against the migrations (`SCHEMA_DRIFT`: run `pnpm db:generate`).
