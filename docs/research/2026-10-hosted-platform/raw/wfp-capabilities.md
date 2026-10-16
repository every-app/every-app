# Workers for Platforms (WfP) for hosted Every App: capabilities, limits, topology

Researcher report, 2026-10-15. Scope: can each organization's apps run as WfP
user Workers behind the gateway (the dispatch Worker), what Cloudflare
actually supports as of October 2026, where the repo and prior design docs
need to change, and the exact REST calls a gateway-resident deploy service
would make. Every external fact carries the "Last updated" date of the page
it came from, or the date of the changelog, issue or package. Code citations
are `path:line` in this worktree unless stated.

## TL;DR

- WfP fits the "org apps" half of the vision well: one dispatch namespace,
  dispatch by Worker name (no gateway rebind), per-invocation CPU and
  subrequest caps, an outbound Worker for egress policy, per-request
  capability stubs, tags for bulk delete, and $0.02 per extra script.
- Three things the self-host app model relies on do **not** work in a user
  Worker: **Cron Triggers** (Cloudflare staff, 2026-05-11), **defining
  Workflows** (Workflows limits page, 2026-09-21), and very likely **Queue
  consumers** (the consumer API only takes an account `script_name`). The
  repo just shipped app Workflows (#282, `acad8b29`) and app crons
  (`packages/sdk/src/cloudflare/worker.ts:51,425-432`). OpenSEO uses all
  three (`open-seo/wrangler.jsonc:22-39,95-99`).
- **Per-app KV does not scale** (1,000 KV namespaces per account), and no
  catalog app reads its declared `KV` binding (0 references in
  `apps/{todo-app,chef,workout-tracker}/src`). Drop KV from hosted
  manifests; keep per-app D1 (50,000 databases per account, raisable).
- Recommended topology: **one** production namespace (plus staging),
  untrusted mode, scripts named with the existing org-scoped `workerName`,
  tags `org-*`/`app-*`/`kind-*`/`plan-*`. Catalog apps that are already
  multi-tenant SaaS and need Workflows/crons (OpenSEO) run as **shared
  platform Workers** on service bindings, not per-org WfP copies.
- The app-to-gateway identity model (a service binding with `props`
  `{organizationId, appId, workerName}`) carries over only if the WfP upload
  API accepts `props` on a `service` binding. Wrangler 4.151.0 sends it; the
  public API schema and the official TS SDK omit it. **Spike this first.**
- Dynamic Workers (open beta 2026-03-24) beat WfP for ephemeral or
  AI-generated code, previews and per-run tools (no deploy, ms startup,
  `globalOutbound` covers `fetch` and `connect`), but not for durable org
  apps with D1, static assets and DOs.

---

## 1. What exists today (repo)

| Area | Where | What it does today | Hosted relevance |
|---|---|---|---|
| The one seam | `packages/perimeter/src/getAppFetcher.ts:38-57` | `service_binding` tier resolves `env["APP__<worker>"]`; `dispatch` throws "deferred" (`:52-56`) | Add the dispatch branch here; callers stay untouched |
| Registry tier | `packages/perimeter/src/registry.ts:11,28-40`; `apps/every-app-gateway/src/db/apps.schema.ts:26-41` | `tier` column, `workerName` unique per gateway, already `every-<orgKey>-<appId>` (`apps.schema.ts:29-32`) | `workerName` is a ready-made WfP script name |
| Perimeter proxy | `packages/perimeter/src/gateway.ts:320-337,384-397` | Mints identity JWT (`audience: app.appId`), proxies via `getAppFetcher` | Dispatch must pass per-request props/limits; `aud=appId` is not unique across orgs |
| App-to-gateway entrypoint | `apps/every-app-gateway/src/server.ts:151-164`; `src/server/app-gateway-entrypoint.ts:13-17,103-120` | `AppGateway` WorkerEntrypoint trusts `ctx.props` `{organizationId, appId, workerName}` and re-checks the registry | Same shape works for WfP if `props` survive the WfP upload (Claim 1) |
| App Worker bindings | `packages/sdk/src/cloudflare/worker.ts:298-450` | Emits `cf/config` shapes: `text`, `secret`, `d1`, `kv`, `durable-object` + `exports` sqlite, `workflow` + `exports`, `worker` (gateway, `props`, `:311-320`), `version-metadata`, cron `triggers` | Needs a second compiler target: WfP upload `metadata` JSON |
| Gateway Worker config | `apps/every-app-gateway/cloudflare.config.ts:97,116,123-179` | compat date `2025-09-02`; hourly cron; D1, OAUTH_KV, rate limits `4180-4182`; no `dispatch_namespaces` binding | Hosted build adds `DISPATCHER` + outbound; compat date predates default `ctx.exports` |
| Self-host deploy | `packages/cli/src/lib/cf/d1.ts:1-160`, `lib/cf/workflows.ts:1-5`, `lib/gateway/patchBuildOutput.ts:3,51` | Shells out to the `cf` CLI (`cf@1.0.0-beta.14` in `apps/every-app-gateway/node_modules/cf`) for D1 migrations with Time Travel bookmarks, deploys, then redeploys the gateway with `APP__*` bindings | A Worker can't run `cf`; hosted needs REST. WfP removes the gateway rebind entirely |
| App hosts | `apps/every-app-gateway/src/server/app-hosts.ts:1-15` | Per-app Workers Custom Domains under `APP_BASE_DOMAIN` | Custom Domains cap at 100 per zone; hosted needs a wildcard route |
| Catalog manifests | `apps/todo-app/everyapp.config.ts:14-20`, `apps/chef/everyapp.config.ts:11-14`, `apps/workout-tracker/everyapp.config.ts:11-14` | All declare `d1: ["DB"]`, `kv: ["KV"]`; todo adds a DO | KV unused in all three `src/` trees |
| SDK audience | `packages/sdk/src/server/everyApp.ts:117-131` | Verifies `aud = EVERYAPP_APP_ID`; no org check | Defense in depth for multi-tenant |
| Prior hosted sketch | `docs/architecture-v2-recommendation.md:26,73,106,151`; `docs/architecture-v2-overview.md:359-388`; `adr/ADR-0001-hosted-vs-self-hosted-topology.md:34-36` | One namespace, `t_<tenant>_<app>` scripts, per-tenant D1/KV, outbound + LLM gateway, GraphQL+tags metering, single-tenant app Workers per org | Mostly right; see "Where prior docs are wrong" below |
| First real app | `/Users/bensenescu/workspaces/open-seo/wrangler.jsonc:22-148`; `open-seo/src/db/app.schema.ts:19,49` | 2 Workflows (one in an aux Worker), DO (Agents SDK), service binding to aux Worker, crons every 5 min, KV x2, D1, R2; data already scoped by `organization_id` | Does not fit a WfP user Worker; fits a shared platform Worker |

### Where prior docs are wrong or stale (as of 2026-10)

- `architecture-v2-recommendation.md:73` "per-tenant D1/**KV** attached in
  upload metadata": KV is capped at 1,000 namespaces per account
  (KV limits, 2026-10-08). Per-tenant KV caps the whole platform at ~1,000
  app installs.
- Same line, "Metering via per-script GraphQL analytics + tags": the WfP
  observability page (2026-10-12) documents `scriptName` and
  `dispatchNamespaceName` dimensions only, no tag dimension. Tags reach
  Tail Workers instead (`TraceItem.scriptTags`, workers-types
  5.20261016.1).
- The hosted sketch (`architecture-v2-overview.md:359-388`) assumes app
  Workers carry everything a self-hosted app has. Since then the repo added
  app Workflows (#282) and crons; neither works in WfP.
- Phase 0 spike "static assets in dispatch-namespace uploads"
  (`architecture-v2-recommendation.md:151`) is resolved: supported since the
  2025-01-31 changelog, documented upload-session flow (2026-10-12).
  "miniflare `dispatch_namespaces` local dev" is still remote-only
  (WfP local development, 2026-06-25), so dev keeps the service-binding
  tier. "WebSocket 101 through `dispatcher.get`" is still undocumented: keep
  the spike.
- `architecture-v2-recommendation.md:106` "DO-originated fetches bypass the
  outbound worker": still true (Outbound Workers page, 2026-04-21).

---

## 2. What the hosted tier needs

### 2.1 Cloudflare reality, October 2026

#### Pricing (WfP pricing page, last updated 2026-04-21)

| Item | Included | Overage |
|---|---|---|
| Subscription | $25/month | |
| Requests | 20M/month | $0.30 per million |
| CPU time | 60M CPU-ms/month | $0.02 per million CPU-ms |
| Scripts | 1,000 | **$0.02 per additional script** (per month) |
| Duration | no charge | |

- One billed request for the whole chain dispatch Worker -> user Worker ->
  outbound Worker; CPU is summed across them (same page, footnote 2).
- "Max of 30 seconds of CPU time per invocation", 15 min for Cron/Queue
  consumer invocations (same page). Plain Workers Paid allows up to 5 min
  (Workers limits, 2026-10-12), so treat 30 s as the user-Worker ceiling
  until verified.
- Service binding calls (app -> gateway broker) add no request charge, only
  CPU (Workers pricing, 2026-10-02).
- Tail Workers are billed by CPU time only (Tail Workers, 2026-10-02).
- Workers Logs: 20M events/month then $0.60/M; **switches to Cloudflare
  Observability pricing on 2026-12-01** (Workers pricing, 2026-10-02).
- Not documented: whether the $25 replaces or adds to the $5 Workers Paid
  plan (founder question 8).
- Example at hosted scale: 1,000 orgs x 4 apps = 4,000 scripts ->
  $25 + 3,000 x $0.02 = $85/month before request/CPU overage. D1 has no
  per-database fee (D1 pricing, 2026-04-21).

#### Limits

| Limit | Value | Source (date) |
|---|---|---|
| Scripts per namespace | Unlimited | WfP limits (2026-10-13) |
| Namespaces per account | Undocumented; docs say "Do not create a namespace per customer" | How WfP works (2026-04-21) |
| Durable Object namespaces | Unlimited in WfP (vs 500 DO classes/account otherwise) | WfP limits (2026-10-13); DO limits (2026-06-01) |
| Tags per script | 8; avoid `,` and `&` | WfP limits / Tags (2026-04-21) |
| Gradual deployments | Not supported for user Workers (100% on upload) | WfP limits (2026-10-13) |
| Version URLs / workers.dev | Not generated for user Workers | Version URLs (Workers docs) |
| `caches.default` | Disabled in namespaced scripts | WfP limits (2026-10-13) |
| API rate limit | 1,200 requests / 5 min per token; 200/s per IP | WfP limits (2026-10-13) |
| Worker size | 64 MiB uncompressed, no compressed limit | Workers limits (2026-10-12) |
| Vars + secrets per Worker | 128 (5 KB each) | Workers limits (2026-10-12) |
| Startup time | 1 s | Workers limits (2026-10-12) |
| Static assets | 100,000 files/version, 25 MiB each | Workers limits (2026-10-12) |
| Subrequests | 10,000 default, up to 10M | Workers limits (2026-10-12) |
| Worker invocations per request | **32**; each service-binding call counts | Service bindings limits |
| Script metadata | ~1 MB; ~5,000 D1 bindings per script | D1 limits footnote 3 (2026-04-21) |
| First upload | Synchronous: 200 means dispatchable | Changelog 2025-02-20 |

The 32-invocation cap matters for the broker: a user request that calls the
gateway's `AppGateway` 31 times will throw. The SDK should batch broker
calls.

#### Bindings a user Worker may carry

The WfP upload endpoint `PUT /accounts/{account_id}/workers/dispatch/namespaces/{ns}/scripts/{name}`
(API reference, fetched 2026-10-15) accepts these binding `type`s: `ai`,
`ai_search`, `ai_search_namespace`, `analytics_engine`, `artifacts`,
`assets`, `browser`, `d1`, `dispatch_namespace`, `durable_object_namespace`
(with optional `script_name` and `dispatch_namespace`), `flagship`,
`hyperdrive`, `images`, `inherit`, `json`, `k2`, `kv_namespace`, `media`,
`messaging`, `mtls_certificate`, `pipelines`, `plain_text`, `queue`,
`r2_bucket`, `ratelimit`, `secret_key`, `secret_text`,
`secrets_store_secret`, `send_email`, `service` (`entrypoint`,
`environment`), `vectorize`, `version_metadata`, `vpc_network`,
`vpc_service`, `workflow`. Top-level metadata also takes `assets`,
`exports`, `migrations`, `limits {cpu_ms, subrequests}`, `observability`,
`placement`, `tags`, `tail_consumers`, `logpush`, `keep_bindings`,
`keep_assets`, `compatibility_date/flags`.

| Capability | Works in a user Worker? | Evidence (date) | Every App use |
|---|---|---|---|
| D1 | Yes | Bindings page (2026-09-16); upload schema | Per-app DB |
| KV | Yes, but 1,000 namespaces/account | KV limits (2026-10-08) | **Do not** provision per app |
| R2 | Yes; 1,000,000 buckets/account | R2 limits (2026-06-08) | Per-app bucket on request |
| Durable Objects, SQLite | Yes; `migrations` or declarative `exports` (`storage: "sqlite"`, tombstones); unlimited DO namespaces | Upload schema; WfP limits (2026-10-13) | todo's `UserSyncDO` |
| DO transfers across the dispatch boundary | Rejected (`*_in_dispatch_namespace` scenarios) | Upload schema; DO exports docs | Can't migrate a self-host DO into WfP |
| Queues producer | Yes (`queue`); 10,000 queues/account | Upload schema; Queues limits (2026-04-21) | Optional |
| Queues consumer | **Not supported as far as documented**: consumer API body is `{script_name, ...}` with no namespace field | Queues consumer API (2026-10-15) | Gateway consumes and fans out |
| Workflows defined in the user Worker | **No**: "Workflows cannot be deployed to Workers for Platforms namespaces" | Workflows limits (2026-09-21); contradicts the WfP bindings page (2026-09-16) listing Workflows | Hosted org apps lose `resources.workflows` |
| Service binding to a regular Worker | `service` with `entrypoint` is in the schema; **`props` is not** in the public schema or `cloudflare-typescript` (`WorkersBindingKindService`), but wrangler 4.151.0 sends `...props && { props }` on the same form it PUTs to the dispatch URL | Upload schema; wrangler `cli.js` (2026-10) | `EVERY_APP_GATEWAY` with org/app props (Claim 1) |
| `secret_text` / secrets API | Yes, in metadata or `PUT .../secrets`, `PATCH .../secrets-bulk`; `inherit` keeps a binding by name on re-upload | WfP API (2026-10-15) | Identity values, app secrets |
| Static assets | Yes, via `assets-upload-session` then `metadata.assets.jwt` | Static assets (2026-10-12); changelog 2025-01-31 | TanStack Start client bundle |
| `version_metadata` | Yes | Metadata doc (2026-07-03) | `CF_VERSION_METADATA` |
| Rate limit binding | Yes (`ratelimit`, `namespace_id` account-unique; same id = shared counters) | Rate limit docs (2026-10-12) | Prefer gateway-side limits |
| `ai` (Workers AI / AI Gateway) | Yes, billed to the platform account | Upload schema | **Don't attach**: broker through the gateway to meter |
| `browser` | Yes | Upload schema | Broker it |
| Vectorize | Yes; 50,000 indexes/account | Vectorize limits (2026-08-05) | Per-app index is feasible |
| Hyperdrive | Yes; **25 configs/account** | Hyperdrive limits (2026-06-09) | Not per-tenant |
| Containers | Docs say yes (bound as DO); wrangler's WfP container deploy hits the wrong endpoint | Bindings page (2026-09-16); workers-sdk#13936 (open, 2026-05-15) | Out of scope |
| Cron Triggers / `scheduled` | **No**: "Cron triggers aren't supported on dispatch namespace workers today. Instead, you can use Durable Objects + alarms" | workers-sdk#13840, Cloudflare comment 2026-05-11; wrangler 4.151.0 returns before `triggersDeploy()` for WfP; no `/schedules` under dispatch scripts | Gateway-driven scheduler |
| `request.cf`, shared cache | Only in `trusted_workers` namespaces | Worker isolation (2026-04-21) | Not used by apps (grep: none) |

#### Custom limits per dispatch

`env.DISPATCHER.get(name, { props }, { limits: { cpuMs, subRequests }, outbound: {...} })`
(Custom limits, 2026-04-21; Dynamic dispatch, 2026-09-16;
`DynamicDispatchLimits` in workers-types 5.20261016.1). Exceeding either
throws in the user Worker; the dispatcher catches it. Limits apply per
dispatched invocation, so they don't cap DO alarms; the script-level
`metadata.limits.cpu_ms` is the backstop there (WfP enforcement of
script-level limits is not separately documented; verify).

#### Outbound Workers (Outbound Workers page, 2026-04-21; dynamic dispatch, 2026-09-16)

- Declared on the dispatcher's namespace binding:
  `outbound: { service, parameters: [...] }`; per dispatch the dispatcher
  passes `{ outbound: { <param>: <JSON> } }`; the outbound Worker reads
  `env.<param>`. It does not otherwise learn which script called, so pass
  `{organizationId, appId, workerName, egress}` as a parameter.
- Sees every `fetch()` from the user Worker during dispatched invocations.
  With an outbound Worker configured, user Workers lose `connect()`.
- **Does not see** fetches from Durable Objects or mTLS bindings. Service
  binding calls (to the gateway) are bindings, not egress.
- Since user Workers can't have crons or queue consumers, the only
  non-dispatch code path is DO execution (including alarms), so "DO =
  egress bypass" is the whole gap.

#### Dispatcher props and RPC capability stubs (Dynamic dispatch, 2026-09-16)

- `props` in the 2nd argument reach the user Worker as `ctx.props`;
  visible to user code; can differ per invocation.
- A **capability**: the dispatcher exports a `WorkerEntrypoint`, mints
  `ctx.exports.Broker({ props: {...} })`, and places the stub in the user
  Worker's props. The user Worker calls methods; the stub's props stay
  hidden. "An RPC stub passed through dynamic dispatch props is valid only
  during the request that received it."
- `ctx.exports` defaults on from compat date 2025-11-17 (compat flags page);
  the gateway is on `2025-09-02` (`cloudflare.config.ts:97`).
- `ctx.props` trust: "can only be set by someone who has permission to edit
  and deploy the worker" (Context docs). Hosted tenants never hold CF
  credentials, so props are trustworthy **as long as the deploy service
  builds all bindings itself** and never forwards tenant metadata.
- `DispatchNamespace.get()` returns a `Fetcher`; it has no entrypoint
  option, so dispatch always hits the default export.

#### Tags, analytics, observability

- Tags: set in `metadata.tags` or `PUT .../tags`; list or **bulk delete**
  with `?tags=<tag>:yes` (Tags, 2026-04-21).
- GraphQL `workersInvocationsAdaptive`: filter by `scriptName` or
  `dispatchNamespaceName`; requests, errors, CPU quantiles, memory
  quantiles; no Workers Logs needed (Observability, 2026-10-12). No tag
  dimension is documented.
- Workers Logs per user Worker: enable via `metadata.observability`; query
  the Observability API with `dataset=cloudflare-workers` and
  `$metadata.service=<script>` server-side (Observability, 2026-10-12).
- Logpush: enabling it on the dispatch Worker covers every user Worker in
  the namespace (same page).
- Tail Workers: attach via `metadata.tail_consumers`. Each `TraceItem`
  carries `scriptName`, `dispatchNamespace`, **`scriptTags`**, `cpuTime`,
  and alarm/fetch event info (workers-types 5.20261016.1). Tail events
  "include sub-requests via ... Dynamic Dispatch" (Tail Workers,
  2026-10-02). This is how tags become per-org usage.
- Analytics Engine: "Platforms can write/query events by script tag"
  (Observability, 2026-10-12).

#### Builds

- Workers Builds connects a repo to an account Worker; there is no
  documented dispatch-namespace target. 6 concurrent builds per account,
  20 min timeout (Builds limits, 2026-05-29). Not a multi-tenant build
  farm.
- Artifacts + `@cloudflare/ci` (a CI Workflow with sandbox runners) can run
  `wrangler deploy --dispatch-namespace <ns>` on push (guide, 2026-10-12).
  This is the Cloudflare-native path if we host org repos.
- `wrangler deploy --dispatch-namespace` exists, but it silently drops
  crons (workers-sdk#13840) and mishandles containers (#13936).

#### Isolation modes (Worker Isolation, 2026-04-21)

Untrusted (default): no `request.cf`, per-Worker cache, `caches.default`
off. Trusted: `PUT .../dispatch/namespaces/{ns}` with
`{"trusted_workers": true}` gives a shared zone cache and `request.cf`.
Every App needs neither (grep finds no `request.cf` or `caches.default` in
apps, SDK or perimeter). **Stay untrusted.**

#### Account ceilings that bound tenant count

| Resource | Per account | If one per app install |
|---|---|---|
| D1 databases | 50,000 Paid, raisable to "millions to tens-of-millions" (D1 limits, 2026-04-21) | ~12,500 orgs at 4 apps; ask early |
| D1 storage | 1 TB, raisable; 10 GB/DB | Fine |
| KV namespaces | **1,000** (KV limits, 2026-10-08) | ~250 orgs at 4 apps. **No** |
| R2 buckets | 1,000,000 (R2 limits, 2026-06-08) | Fine |
| Queues | 10,000 (Queues limits, 2026-04-21) | Producers only, ok |
| Hyperdrive configs | 25 (2026-06-09) | Never per tenant |
| Vectorize indexes | 50,000 (2026-08-05) | Fine |
| DO classes | 500, **unlimited in WfP** | Fine in WfP |
| Workflows | 500 scripts shared with Workers; 50,000 concurrent instances; 300 creations/s/account, 100/s/workflow (Workflows limits, 2026-09-21; changelog 2026-04-15) | Only on platform Workers |
| Cron Triggers | 250 per account (Workers limits, 2026-10-12) | Gateway needs 1-2 |
| Workers (non-WfP) | 500 | Shared platform Workers only |

#### Dynamic Workers / Worker Loader (open beta 2026-03-24)

- Pricing (2026-06-11): requests and CPU at Workers Standard rates plus
  **$0.002 per unique Dynamic Worker per day** beyond 1,000/month (unique =
  ID + code), billed from 2026-05-26.
- Concurrency: 4 distinct Dynamic Workers in flight per request, 10 per DO
  (limits, 2026-08-27; changelog 2026-08-28).
- Bindings are capability stubs only. Raw D1/KV/R2 must be wrapped in a
  loader-side `WorkerEntrypoint` (Bindings, 2026-10-12). Static assets come
  from your own KV/R2 at load time (2026-05-05). Persistent state via
  **DO Facets** (per-facet SQLite under a supervisor DO, 2026-10-12).
  Durable steps via **Dynamic Workflows** (`@cloudflare/dynamic-workflows`,
  blog 2026-05-01).
- Egress: `globalOutbound: null` or a stub intercepts both `fetch()` and
  `connect()` (Egress control, 2026-10-12). Stricter than WfP's outbound
  Worker.

**Dynamic Workers beat WfP when:**

- the code is ephemeral or generated per run (ToolBus "code mode", agent
  scratch tools, "preview this fork before deploying");
- you want no deploy step and no per-script fee;
- you need egress control with no DO bypass;
- you want per-tenant Workflow logic today (Dynamic Workflows), which WfP
  can't host.

**WfP wins for long-lived org apps:**

- native D1/R2/DO bindings with no RPC shim;
- an upload-session static asset pipeline;
- $0.02/script/month vs about $0.06/month for a Dynamic Worker invoked
  daily ($0.002 x 30);
- no 4-per-request fan-out cap;
- Workers Logs and analytics per script.

### 2.2 Recommended topology

```
                       *.everyapp.host/*  (wildcard route; CF for SaaS later)
                                   |
                     every-app-gateway  (dispatch Worker, regular account Worker)
       perimeter auth -> plan limits -> env.DISPATCHER.get(workerName, {props}, {limits, outbound})
            |                                   |                              |
   shared platform Workers           dispatch namespace "everyapp-prod" (untrusted)
   (service bindings, today's tier)   every-<orgKey>-<appId>  tags: org-*, app-*, kind-*, plan-*
   e.g. OpenSEO: Workflows, crons,    D1 per app, DO (sqlite exports), R2 on request,
   queues, org-scoped data            EVERY_APP_GATEWAY service binding (props), assets
            |                                   |  fetch()            | tail events
            +------ AppGateway broker <---------+  everyapp-egress    everyapp-meter (Tail)
                    (AI, OpenRouter, integrations; metered)  (outbound)  -> Analytics Engine
```

1. **One namespace, not one per org.** The dispatcher's
   `dispatch_namespaces` binding names one namespace. Namespace-per-org
   would mean redeploying the gateway on every signup, which is the
   `APP__*` rebind problem self-host has today
   (`patchBuildOutput.ts:3,51`). Cloudflare also says not to do it.
   Add `everyapp-staging` for testing. Script name = the existing
   `workerName` (`apps.schema.ts:29-32`).
2. **Tags (up to 8):** `org-<orgId>`, `app-<appSlug>`, `kind-catalog` or
   `kind-org`, `plan-<plan>`, optionally `src-<git sha>`. Org deletion =
   `DELETE .../scripts?tags=org-<id>:yes` plus D1 deletes.
3. **Two hosting tiers for apps.** This refines ADR-0001 §6
   (`ADR-0001:34-36`):
   - **Per-org WfP user Workers:** instance-per-org catalog apps (todo is
     user-scoped with no org column, `apps/todo-app/src/db/schema.ts:5-16`)
     and every org app or fork.
   - **Shared platform Workers:** catalog apps that are already
     multi-tenant SaaS and need Workflows, crons or queue consumers.
     OpenSEO is org-scoped (`open-seo/src/db/app.schema.ts:19`). These are
     regular account Workers on the existing `service_binding` tier, so
     they keep Workflows (#282) and crons. They receive org identity
     per request from the perimeter's JWT.
4. **Storage per WfP app:**
   - **D1: yes**, `<workerName>-db` (or keep `resourceNameFor`,
     `worker.ts:510-514`).
   - **KV: no.** Remove `kv: ["KV"]` from the three catalog manifests
     (unused), and make the hosted validator reject `resources.kv`.
     Apps needing a cache use a D1 table or DO SQLite. If KV semantics are
     truly needed, expose a gateway capability (`Broker.kv.get/put`) over
     one platform KV namespace with a forced `<orgId>/<appId>/` key prefix,
     the pattern Cloudflare documents for Dynamic Workers (Bindings,
     2026-10-12).
   - **DO: allowed**, via `exports` with `storage: "sqlite"` as today
     (`worker.ts:362-372`). Document the egress bypass, and audit via
     Tail events (alarm events carry `scriptTags`).
5. **Crons:** keep `crons` in the manifest (`worker.ts:51`), store them in
   the registry, and let the gateway drive them:
   - add a `* * * * *` trigger next to `17 * * * *`
     (`cloudflare.config.ts:116`);
   - enqueue due (app, cron) pairs on a gateway-owned Queue; the gateway's
     consumer calls
     `DISPATCHER.get(workerName, { props: { everyapp: { event: "scheduled", cron, scheduledTime } } }, { limits })`;
   - `everyApp()` in the SDK routes `ctx.props.everyapp.event === "scheduled"`
     to the app's `scheduled` handler. Props are only settable by the
     dispatcher, so this is unforgeable; no special URL needed.
   - Alternatively, apps use DO alarms (Cloudflare's suggested workaround).
6. **Workflows:**
   - v1: the hosted validator rejects `resources.workflows` for WfP apps;
     apps that need them go on the platform tier.
   - v2 (spike): the gateway defines one generic Workflow class whose steps
     dispatch into the user Worker (a `DynamicWorkflow` equivalent over
     `DISPATCHER` instead of `LOADER`). This requires passing a `step` stub
     through dispatch props, which is unverified.
7. **Gateway identity binding (static) plus a per-request broker
   (dynamic):**
   - **Static:** `service` binding `EVERY_APP_GATEWAY -> every-app-gateway`
     / `AppGateway` with `props {organizationId, appId, workerName}`. This
     mirrors `worker.ts:311-320`, works in DO alarms, and keeps
     `app-gateway-entrypoint.ts:103-113` unchanged.
   - **Dynamic:** on each dispatched request, also pass
     `props.everyapp.broker = ctx.exports.Broker({ props: { orgId, appId, userId, grants } })`,
     so user-attributed broker calls need no identity-header forwarding.
   - If the spike shows `props` is dropped on WfP uploads, fall back to a
     per-app HMAC secret (`secret_text`) signed into broker calls.
8. **Limits by plan** (defaults to confirm, Founder Q3):

   | Tier | `cpuMs` per dispatch | `subRequests` | Apps | Notes |
   |---|---|---|---|---|
   | Free org | 100 | 100 | 3 | SSR typically 10-20 ms (Workers limits, 2026-10-12) |
   | Paid org | 2,000 | 1,000 | 25 | Broker calls count as subrequests |
   | Catalog WfP | 30,000 | 10,000 | n/a | 30 s = WfP max |

   Also set `metadata.limits` (`cpu_ms`) as a backstop for DO work.
   Rate limiting stays in the gateway (its own `ratelimit` bindings keyed
   `org:app:user`), not as per-app bindings.
9. **Egress:** an outbound Worker `everyapp-egress` with
   `parameters: ["everyapp"]`:
   - org apps: default-deny outside a new manifest `egress` allowlist;
   - always block direct calls to metered providers (api.openai.com,
     openrouter.ai, api.dataforseo.com) so usage goes through the metered
     broker;
   - log to Analytics Engine.
10. **Metering:** a Tail Worker `everyapp-meter` on every user Worker writes
    `{scriptTags, cpuTime, outcome, event type}` to Analytics Engine. D1
    usage per database comes from D1 GraphQL analytics. Request counts per
    app come from the gateway's own perimeter logs (`logProxy`,
    `gateway.ts:162,401-414`).
11. **Hostnames:** `app-hosts.ts` creates a Custom Domain per app, but
    Custom Domains cap at 100 per zone (Workers limits, 2026-10-12).
    Hosted uses an orange-clouded `*.everyapp.host` wildcard DNS record and
    a `*.everyapp.host/*` route to the gateway (Hostname routing,
    2026-09-24). Later, a `*/*` route plus Cloudflare for SaaS custom
    hostnames for BYO domains.

### 2.3 REST calls a gateway-resident deploy service makes

All under `https://api.cloudflare.com/client/v4/accounts/{acct}`, with one
platform API token (Workers Scripts Write, D1 Edit, R2 Edit, Queues Write).
A deploy is about 6-12 calls; at 1,200/5 min/token that is about 100
deploys per 5 min per token.

One-time setup:

1. `POST /workers/dispatch/namespaces` with `{"name":"everyapp-prod"}`, and
   the same for `everyapp-staging`.
2. The gateway's hosted build adds
   `DISPATCHER: bindings.dispatchNamespace({ namespace: "everyapp-prod", outbound: { worker: "everyapp-egress", parameters: ["everyapp"] } })`
   (cf/config builder per the `cf` Config Explorer) and bumps the compat
   date to 2025-11-17 or later for `ctx.exports`.

Per deploy (the CLI uploads a built bundle + asset manifest + manifest to
the hosted API):

1. **D1:** `POST /d1/database` with `{"name":"every-acme-todo-db"}`.
   Idempotent lookup: `GET /d1/database?name=...`.
2. **Bookmark:** `GET /d1/database/{id}/time_travel/bookmark`, stored with
   the deploy for rollback (mirrors `lib/cf/d1.ts:70-104`).
3. **Migrations:** `POST /d1/database/{id}/query` with
   `{"batch":[{"sql":"CREATE TABLE IF NOT EXISTS d1_migrations(...)"},{"sql":"<0001.sql>"},{"sql":"INSERT INTO d1_migrations(name) VALUES (?)","params":["0001_init"]}, ...]}`.
   This reimplements `cf d1 migrations apply`.
4. **Optional:** `POST /r2/buckets` with `{"name":"every-acme-todo-files"}`
   and `POST /queues` with `{"queue_name":"every-acme-todo-jobs"}`.
5. **Assets:**
   - `POST /workers/dispatch/namespaces/everyapp-prod/scripts/every-acme-todo/assets-upload-session`
     with `{"manifest":{"/index.html":{"hash":"<32hex>","size":1234}, ...}}`
     returns `jwt` and `buckets`;
   - for each bucket: `POST /workers/assets/upload?base64=true` with
     `Authorization: Bearer <upload jwt>`, multipart `<hash>=<base64>;type=<mime>`;
   - the final upload returns 201 with the completion `jwt`.
6. **Upload:** `PUT /workers/dispatch/namespaces/everyapp-prod/scripts/every-acme-todo`
   as multipart: `metadata` (below), then each module as
   `<name>.js;type=application/javascript+module`.
7. **App secrets:** `PATCH .../scripts/every-acme-todo/secrets-bulk` (or
   `PUT .../secrets` with `{"name":"X","text":"...","type":"secret_text"}`).
   Re-uploads keep them via `inherit` bindings or
   `keep_bindings: ["secret_text"]`.
8. **Verify:** `GET .../scripts/every-acme-todo/settings`. Then the
   registry flips `pending -> active`. No gateway redeploy (the
   `binding` state, `apps.schema.ts:46-52`, disappears for this tier).
9. **Teardown:**
   - `DELETE .../scripts/every-acme-todo` for one app; for an org,
     `DELETE /workers/dispatch/namespaces/everyapp-prod/scripts?tags=org-<id>:yes`;
   - then `DELETE /d1/database/{id}` and `DELETE /r2/buckets/{name}`.

Example `metadata` for a hosted todo install, with every binding type we
need (valid JSON):

```json
{
  "main_module": "index.js",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "bindings": [
    { "type": "plain_text", "name": "EVERYAPP_APP_ID", "text": "todo" },
    { "type": "plain_text", "name": "EVERYAPP_IDENTITY_ISSUER", "text": "https://everyapp.com" },
    { "type": "plain_text", "name": "EVERYAPP_IDENTITY_PUBLIC_KEYS", "text": "[{\"kid\":\"everyapp-identity\",\"kty\":\"RSA\",\"n\":\"...\",\"e\":\"AQAB\"}]" },
    { "type": "version_metadata", "name": "CF_VERSION_METADATA" },
    { "type": "secret_text", "name": "GATEWAY_URL", "text": "https://everyapp.com" },
    { "type": "secret_text", "name": "EVERY_APP_ORG_ID", "text": "org_8f2c" },
    {
      "type": "service",
      "name": "EVERY_APP_GATEWAY",
      "service": "every-app-gateway",
      "entrypoint": "AppGateway",
      "props": { "organizationId": "org_8f2c", "appId": "todo", "workerName": "every-acme-todo" }
    },
    { "type": "d1", "name": "DB", "database_id": "3f1c9a2e-0b7d-4e55-9a51-1c2d3e4f5a6b" },
    { "type": "durable_object_namespace", "name": "USER_SYNC", "class_name": "UserSyncDO" },
    { "type": "r2_bucket", "name": "FILES", "bucket_name": "every-acme-todo-files" },
    { "type": "queue", "name": "JOBS", "queue_name": "every-acme-todo-jobs" },
    { "type": "assets", "name": "ASSETS" },
    { "type": "inherit", "name": "MY_APP_API_KEY" }
  ],
  "exports": {
    "UserSyncDO": { "type": "durable-object", "storage": "sqlite" }
  },
  "assets": {
    "jwt": "<completion-token>",
    "config": { "not_found_handling": "single-page-application", "run_worker_first": true }
  },
  "limits": { "cpu_ms": 30000, "subrequests": 1000 },
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1,
    "redact_query_string": true,
    "logs": { "enabled": true, "invocation_logs": true, "persist": true, "head_sampling_rate": 1 },
    "traces": { "enabled": true, "persist": true, "head_sampling_rate": 0.1 }
  },
  "tail_consumers": [{ "service": "everyapp-meter" }],
  "tags": ["org-org_8f2c", "app-todo", "kind-catalog", "plan-pro"],
  "logpush": false
}
```

Notes on the example:

- Deliberately absent: `ai`, `browser`, `kv_namespace`, `ratelimit`,
  `workflow`, `hyperdrive`. AI and browser go through the broker; KV is
  out; rate limits live in the gateway; Workflows are unsupported;
  Hyperdrive is capped at 25 configs.
- `exports` vs `migrations`: the schema allows both; keep `exports` to
  match `worker.ts:362-403`.
- The JWKS shape in `EVERYAPP_IDENTITY_PUBLIC_KEYS` is illustrative; reuse
  `deploy.identityPublicKeys` (`worker.ts:303-306`).
- `observability` maps one-to-one from the SDK's `EVERYAPP_OBSERVABILITY`
  (`worker.ts:226-243`), camelCase to snake_case; `redact_query_string`
  sits at the top level of `observability` in the API schema, as in the
  SDK.

Dispatcher side, the shape of the new `getAppFetcher` branch:

```ts
const worker = env.DISPATCHER.get(app.workerName,
  { props: { everyapp: { event: "fetch", broker: ctx.exports.Broker({ props: { orgId, appId, userId } }) } } },
  { limits: limitsFor(plan), outbound: { everyapp: { organizationId, appId, workerName, egress } } });
return worker.fetch(outbound); // "Worker not found" -> AppUnreachableError
```

---

## 3. Gaps and the smallest change that closes each

| # | Gap | Where | Smallest fix | Days |
|---|---|---|---|---|
| G1 | `props` on a WfP `service` binding is undocumented | External | 1-hour spike: upload a user Worker with `EVERY_APP_GATEWAY` + props, check `ctx.props` in `AppGateway`. Fallback: per-app HMAC `secret_text` | 0.5 |
| G2 | `getAppFetcher` has no dispatch branch | `packages/perimeter/src/getAppFetcher.ts:52-56`; `AppFetcherTarget` (`:16-21`) lacks org/plan context | Add `dispatch` branch calling `env.DISPATCHER.get(workerName, {props}, {limits, outbound})`; extend the target with `organizationId`, `appId`, `plan`; map "Worker not found" to `AppUnreachableError` | 0.5 |
| G3 | Gateway config has no dispatch namespace, outbound or ctx.exports | `apps/every-app-gateway/cloudflare.config.ts:97,123-179` | Hosted-mode binding `DISPATCHER`; compat date to 2025-11-17 or later (or `enable_ctx_exports`); export a `Broker` entrypoint | 0.5 |
| G4 | No outbound Worker | new `apps/everyapp-egress` | Allowlist from manifest `egress` + deny metered-provider hosts + Analytics Engine log | 1 |
| G5 | No WfP metadata compiler | `packages/sdk/src/cloudflare/worker.ts:298-450` emits `cf/config` only | `toDispatchMetadata(manifest, inputs)`: text->`plain_text`, secret->`secret_text`, worker->`service`+props, d1->`d1`, durable-object->`durable_object_namespace`+`exports`, version-metadata->`version_metadata`; reject kv/workflows/crons-as-triggers | 1 |
| G6 | No hosted deploy service (CLI shells out to `cf`) | `packages/cli/src/lib/cf/d1.ts`, `commands/app/deploy/deployApp.ts` | Gateway `HostedDeployService` running §2.3 over REST, including D1 migration bookkeeping and the assets session | 4-6 |
| G7 | No hosted deploy auth or API | `docs/cli-redesign.md:132-134,585-590` | Device-code login -> org-scoped token -> `POST /api/hosted/apps/:slug/deploy` (bundle + manifest) calling the perimeter registry rules | 3 |
| G8 | Crons unsupported in WfP | manifest `crons` (`worker.ts:51,425-432`), gateway `scheduled` (`server.ts:269-275`) | Registry `schedules` column; gateway minute cron -> Queue -> dispatch with `props.everyapp.event="scheduled"`; SDK routes to the app's `scheduled` | 2 |
| G9 | Workflows unsupported in WfP | `ResourcesSchema.workflows` (`packages/perimeter/src/manifest/manifest.ts:46-48`) | v1: hosted validator rejects them for the dispatch tier; such apps go to the platform tier. v2: gateway Workflow shim (spike) | 0.5 (v1) / 4-5 (v2) |
| G10 | Per-app KV can't scale; unused anyway | `apps/todo-app/everyapp.config.ts:16`, `apps/chef/everyapp.config.ts:13`, `apps/workout-tracker/everyapp.config.ts:13` | Delete `kv: ["KV"]`; hosted validator rejects `resources.kv`; optional `Broker.kv` capability over one prefixed namespace | 0.5 |
| G11 | Identity `aud` = appId, not unique across orgs | `packages/perimeter/src/gateway.ts:327`; `packages/sdk/src/server/everyApp.ts:117-131` | Mint `aud = workerName` (unique, `apps.schema.ts:32`) and have the SDK expect that audience; or keep `aud = appId` and also check the JWT `orgId` against `EVERY_APP_ORG_ID` in the SDK | 1 |
| G12 | Hostnames via per-app Custom Domains (cap 100/zone) | `apps/every-app-gateway/src/server/app-hosts.ts:1-15` | Hosted: wildcard DNS + `*.everyapp.host/*` route; routing already resolves by hostname (`server.ts:211-216`) | 1 |
| G13 | No per-app/org compute metering | none | `everyapp-meter` Tail Worker (scriptTags + cpuTime -> Analytics Engine); D1 GraphQL per DB | 2 |
| G14 | No plan -> limits mapping | org model / registry | `limitsFor(plan)` table, passed per dispatch, mirrored in `metadata.limits` | 0.5 |
| G15 | Catalog SaaS apps (OpenSEO) don't fit WfP | `open-seo/wrangler.jsonc:22-99` | Platform tier: deploy as shared account Worker, service-bound (`service_binding` tier), org from JWT `orgId` | 1 (wiring) |
| G16 | Org deletion/teardown | registry delete path | `DELETE ...scripts?tags=org-<id>:yes` + D1/R2 deletes, as a gateway job | 0.5 |
| G17 | Local dev can't run dispatch locally | WfP local dev (2026-06-25) | Keep `service_binding` tier in dev; the seam already isolates it | 0 |
| G18 | WebSocket 101 through `DISPATCHER.get` unverified | todo `UserSyncDO` | Spike with the deployed todo; fallback is none needed if it works like service bindings | 0.5 |

---

## 4. Open questions only the founder can answer

1. **Catalog apps: shared multi-tenant Worker or per-org WfP copy?**
   - *Why it matters:* WfP can't run Workflows, crons or queue consumers.
     OpenSEO needs all three and is already org-scoped. Per-org copies give
     hard isolation and per-org D1 but multiply scripts and migrations.
   - *Default:* shared platform Worker for OpenSEO-style SaaS apps;
     per-org WfP for instance-per-org apps (todo, chef, workout) and every
     org app.
2. **Do we accept arbitrary org-written code in v1, or only forks of our
   SDK template?**
   - *Why it matters:* untrusted code needs egress default-deny, and DOs
     are an egress bypass.
   - *Default:* accept it; untrusted namespace; outbound default-deny with
     a manifest `egress` allowlist; DOs allowed but flagged in the admin
     UI.
3. **Per-plan CPU and subrequest caps and app counts?**
   - *Why it matters:* they are the denial-of-wallet guard and the
     billable tiers.
   - *Default:* table in §2.2 item 8 (free 100 ms/100, paid 2 s/1,000,
     catalog 30 s/10,000; 3 vs 25 apps).
4. **App hostname domain.**
   - *Why it matters:* it sets cookie isolation from everyapp.com, the
     wildcard cert and the route.
   - *Default:* separate registrable domain `*.everyapp.host` with
     single-label `<app>-<orgKey>`; BYO domains later via Cloudflare for
     SaaS.
5. **Where do org apps get built?**
   - *Why it matters:* Workers Builds has no dispatch target and allows 6
     concurrent builds per account.
   - *Default:* the `everyapp` CLI builds locally (or in the org's GitHub
     Actions) and uploads to the hosted deploy API. Artifacts +
     `@cloudflare/ci` comes later for "edit in browser/agent" flows.
6. **Workflows for org apps.**
   - *Why it matters:* a gateway Workflow shim is 4-5 days plus a risky
     spike.
   - *Default:* not in v1.
7. **Dedicated Cloudflare account for hosted.**
   - *Why it matters:* ceilings are per account: D1 50,000, KV 1,000,
     Workers 500, cron triggers 250, API 1,200/5 min/token.
   - *Default:* a new account used only for hosted; file the D1 limit
     increase at launch.
8. **WfP subscription.**
   - *Why it matters:* it must be purchased in the dashboard (an account
     without it gets error 10121). Whether the $25 replaces or adds to the
     $5 Workers Paid plan is undocumented.
   - *Default:* buy it on the hosted account now; confirm the invoice line.

---

## 5. Load-bearing claims (if wrong, the design changes)

1. **(Critical)** The WfP upload API honors `props` (and `entrypoint`) on a
   `service` binding to a regular account Worker, delivered as `ctx.props`
   in `AppGateway`.
   - *Source:* wrangler 4.151.0 serializes `props` into the upload form it
     PUTs to `/workers/dispatch/namespaces/{ns}/scripts/{name}`. The
     public API reference and `cloudflare-typescript` omit it.
   - *Unverified on the server side.*
2. **(Critical)** User Workers can't define Workflows.
   - *Source:* Workflows limits page, 2026-09-21. The WfP bindings page
     (2026-09-16) says otherwise.
   - *If Workflows work,* OpenSEO-style apps could live in WfP.
3. **(Critical)** Cron Triggers don't fire for user Workers.
   - *Source:* Cloudflare reply on workers-sdk#13840, 2026-05-11; wrangler
     4.151.0 still skips them; no `/schedules` route under dispatch
     scripts.
4. **(Critical for the security model)** Outbound Workers don't intercept
   fetches from Durable Objects.
   - *Source:* Outbound Workers page, 2026-04-21.
5. Queue consumers can't be dispatch-namespace scripts.
   - *Source:* the consumer API body takes only `script_name`, fetched
     2026-10-15. Inferred, not stated.
6. 1,000 KV namespaces per account and 50,000 D1 databases per account
   (raisable).
   - *Source:* KV limits 2026-10-08; D1 limits 2026-04-21.
7. Per-dispatch `limits {cpuMs, subRequests}` and per-request RPC stubs in
   `props` work as documented.
   - *Source:* Custom limits 2026-04-21; Dynamic dispatch 2026-09-16;
     workers-types 5.20261016.1.
8. GraphQL exposes no tag dimension; `TraceItem.scriptTags` does.
   - *Source:* Observability 2026-10-12; workers-types 5.20261016.1.

---

## 6. Sources

Cloudflare docs (dates are each page's "Last updated"):

- WfP overview (2026-10-15): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
- How WfP works (2026-04-21): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/
- WfP pricing (2026-04-21): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/
- WfP limits (2026-10-13): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/
- WfP bindings (2026-09-16): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/
- Dynamic dispatch, props and capability stubs (2026-09-16): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/
- Custom limits (2026-04-21): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/
- Outbound Workers (2026-04-21): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/
- Observability (2026-10-12): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/observability/
- Tags (2026-04-21): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/tags/
- Static assets (2026-10-12): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/
- Hostname routing (2026-09-24): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/hostname-routing/
- Worker isolation (2026-04-21): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/
- Local development (2026-06-25): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/local-development/
- Upload metadata (2026-07-03): https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
- WfP script upload API (fetched 2026-10-15): https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/methods/update/
- WfP API index: https://developers.cloudflare.com/api/resources/workers_for_platforms/
- Dispatch namespace create API: https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/methods/create/
- Workers limits (2026-10-12): https://developers.cloudflare.com/workers/platform/limits/
- Workers pricing (2026-10-02): https://developers.cloudflare.com/workers/platform/pricing/
- Context (`ctx.props`, `ctx.exports`): https://developers.cloudflare.com/workers/runtime-apis/context/
- Compatibility flags (`enable_ctx_exports` default 2025-11-17): https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- Service bindings (32 invocations): https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
- Rate limit binding (2026-10-12): https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Tail Workers (2026-10-02): https://developers.cloudflare.com/workers/observability/logs/tail-workers/
- Cron Triggers (2026-09-04): https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Workflows limits (2026-09-21): https://developers.cloudflare.com/workflows/reference/limits/
- Workflows pricing (2026-09-21): https://developers.cloudflare.com/workflows/reference/pricing/
- D1 limits (2026-04-21): https://developers.cloudflare.com/d1/platform/limits/
- D1 pricing (2026-04-21): https://developers.cloudflare.com/d1/platform/pricing/
- D1 query API: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
- KV limits (2026-10-08): https://developers.cloudflare.com/kv/platform/limits/
- R2 limits (2026-06-08): https://developers.cloudflare.com/r2/platform/limits/
- Queues limits (2026-04-21): https://developers.cloudflare.com/queues/platform/limits/
- Queue consumer API: https://developers.cloudflare.com/api/resources/queues/subresources/consumers/methods/create/
- DO limits (2026-06-01): https://developers.cloudflare.com/durable-objects/platform/limits/
- Hyperdrive limits (2026-06-09): https://developers.cloudflare.com/hyperdrive/platform/limits/
- Vectorize limits (2026-08-05): https://developers.cloudflare.com/vectorize/platform/limits/
- Workers Builds limits (2026-05-29): https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
- Artifacts build and deploy (2026-10-12): https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/
- Dynamic Workers (2026-10-12): https://developers.cloudflare.com/dynamic-workers/
- Dynamic Workers pricing (2026-06-11): https://developers.cloudflare.com/dynamic-workers/pricing/
- Dynamic Workers limits (2026-08-27): https://developers.cloudflare.com/dynamic-workers/platform/limits/
- Dynamic Workers bindings (2026-10-12): https://developers.cloudflare.com/dynamic-workers/usage/bindings/
- Dynamic Workers egress control (2026-10-12): https://developers.cloudflare.com/dynamic-workers/usage/egress-control/
- Durable Object Facets (2026-10-12): https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/
- Dynamic Workflows (2026-10-12): https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/

Changelog and blog:

- Dynamic Workers open beta (2026-03-24): https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/
- Workflows limits raised (2026-04-15): https://developers.cloudflare.com/changelog/post/2026-04-15-workflows-limits-raised/
- Synchronous user Worker uploads (2025-02-20): https://developers.cloudflare.com/changelog/post/2025-02-20-synchronous-uploads/
- WfP static assets (2025-01-31): https://developers.cloudflare.com/changelog/post/2025-01-31-workers-platforms-static-assets/
- KV namespaces raised to 1,000 (2025-01-27): https://developers.cloudflare.com/changelog/post/2025-01-27-kv-increased-namespaces-limits/
- Dynamic Workflows blog (2026-05-01): https://blog.cloudflare.com/dynamic-workflows/

GitHub and packages:

- Crons dropped for WfP; Cloudflare reply 2026-05-11: https://github.com/cloudflare/workers-sdk/issues/13840
- WfP containers registration bug (2026-05-15, open): https://github.com/cloudflare/workers-sdk/issues/13936
- Unmerged "tenant/platform binding" docs PR, closed 2026-01-28 (signal only): https://github.com/cloudflare/cloudflare-docs/pull/26688
- `wrangler@4.151.0` (`wrangler-dist/cli.js`: service binding `props` serialization; WfP early return before `triggersDeploy`), fetched 2026-10-15 via `npm pack`
- `@cloudflare/workers-types@5.20261016.1` (`DispatchNamespace`, `DynamicDispatchOptions`, `TraceItem.scriptTags/cpuTime`), fetched 2026-10-15
- `cloudflare-typescript` `src/resources/workers-for-platforms/dispatch/namespaces/scripts/scripts.ts` (`WorkersBindingKindService` has no `props`), fetched 2026-10-15
