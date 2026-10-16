# The perimeter and the app-invocation seam, for hosted Every App

Researcher: perimeter / dispatch. Date: 2026-10-15. Code read at `main`
e1d9d3c6, plus the in-flight CLI-redesign branches `cli-redesign/06-gateway-registry`
and `cli-redesign/07-cli-registry` (PRs #286-#293), because they move the
registry rules this report builds on. Cloudflare facts are from docs pages
fetched today (dates given in §6) and from the Cloudflare OpenAPI spec queried
today through the Cloudflare API MCP.

## TL;DR

- The seam is real but leaky. `getAppFetcher()` is meant to be the single
  place an app is invoked (`packages/perimeter/src/getAppFetcher.ts:1-9`),
  but `server/deploy-api.ts:63-79` (and its successor
  `server/app-activation.ts` on branch 06) reaches `env["APP__<worker>"]`
  directly, and the ToolBus rebuilds a target that drops everything except
  `workerName` and `tier` (`toolbus/runtime.ts:84-87`, `toolbus/catalog-sync.ts:52-55`).
  Adding `tier: "dispatch"` is about 40 lines in `getAppFetcher` plus routing
  those three callers through it.
- **Keep app identity in upload-time binding props. Don't move it to
  per-request dispatch props.** Per-request props exist only while a
  dispatched request is running. Workflows, Durable Object alarms and
  sockets, and queue consumers never get one, and OpenSEO uses Workflows, a
  Durable Object and 5-minute crons. Service bindings can't carry
  per-request props, so moving identity there would also split the SDK by
  tier. In hosted, the platform has to build the `EVERY_APP_GATEWAY` binding
  itself and reject any Worker-to-Worker binding a tenant supplies. Today
  `everyAppWorker()` builds it on the client from `.everyapp/deploy.json`.
- Dispatch scripts have no cron API. The spec has `.../workers/scripts/{name}/schedules`
  but no dispatch-namespace equivalent. The gateway's own cron would have to
  fan out to apps over the seam.
- The hostname design in the docs (`{app}-{tenant}.everyapp.host`, single
  label, one wildcard cert) leaves out the session cookie. Today the cookie
  is scoped to `APP_BASE_DOMAIN` and covers every app host and the control
  plane (`auth/config.ts:204-221`, `control-plane-guard.ts:4-6`). In hosted,
  sibling subdomains run hostile tenant code, so the overview's accepted
  risk "cross-app GET under XSS" (`architecture-v2-overview.md:161-163`)
  becomes a cross-tenant capability that is there by design, and cookie
  tossing becomes possible. The fix: put the app domain on the Public
  Suffix List and give each app host its own session through a redirect
  handshake.
- The perimeter assumes one org per session in four places. The most urgent
  is that a user in two organizations (a personal org plus an invited one,
  which is the founder's own onboarding model) gets no app session at all
  unless an active org is set, and gets a 403 on the other org's apps
  (`orgContext.ts:94-98`, `betterAuthAuthenticator.ts:136`).
- The identity JWT's `aud` is the bare app id (`gateway.ts:327`), and that
  id repeats across tenants. Set `aud` to `workerName`, which is unique
  across the whole account. The recommendation already asked for
  tenant-scoped `aud` (`architecture-v2-recommendation.md:73`), and the code
  never got it.
- "Activate on first request" (branch 06) only runs in self-host mode, which
  is correct. In hosted, a first upload is synchronous (Cloudflare changelog,
  2025-02-20), so the hosted deploy API can write `active` as soon as the
  upload returns 200.

---

## 1. What exists today

### 1.1 The one door (`apps/every-app-gateway/src/server.ts`)

The default `fetch` handler sorts each request by its Host header:

| Host | What happens | Code |
|---|---|---|
| empty, or equal to `GATEWAY_URL`'s host | control plane: MCP/OAuth routes, then TanStack Start, behind `guardControlPlaneRequest` and the credential rate limits | `server.ts:173-179`, `114-140` |
| any host when `GATEWAY_URL` is unset | control plane only while no app is `active`, else 404 `gateway_misconfigured` | `server.ts:183-206` |
| a host in the registry | `handleGatewayRequest` with `resolveApp: async () => app`, `interceptMcp: serveAppHostMcp` | `server.ts:211-216`, `242-252` |
| unregistered host under `.<gatewayHost>` or `.<appHostParent>` | 404 `unknown_app_host` | `server.ts:217-228` |
| any other host | 404 `unknown_host` in prod; control plane in `vite dev` | `server.ts:229-239` |

The registry lookup is `resolveAppByHostname()`, which uses a per-isolate
`Map`: at most 500 entries, 30 s TTL for hits, 5 s for misses
(`server.ts:55-105`). It runs for every non-gateway host, before any check
on the host's shape (`server.ts:211-216`).

`appHostParent(env)` returns `APP_BASE_DOMAIN`, or the gateway host when
that is unset (`server/app-hosts.ts:42-44`). The header comment
(`app-hosts.ts:4-14`) says what that implies: every app is one label below
the base, `<appId>.<base>` for the install's own organization and
`<appId>-<orgKey>.<base>` for any other, and the session cookie is scoped
to the base. Branch 06 removes the route-mode fallback and uses
`appBaseDomain` directly.

The private app-to-gateway surface is `class AppGateway extends WorkerEntrypoint<Env, AppCallerProps>`
(`server.ts:152-164`). Apps reach it through their `EVERY_APP_GATEWAY`
binding.

### 1.2 The perimeter core (`packages/perimeter/src/gateway.ts`)

`handleGatewayRequest` runs these steps in order. Each step is shared code
and does not care which tier the app is on:

1. `parseHost`, then `deps.resolveApp` (`gateway.ts:183-193`). `parseHost`
   splits off the first label (`host.ts:18-34`). Production ignores that
   split and resolves by the full hostname (`server.ts:249`).
2. Status gate: `disabled` gets 503 `app_unavailable`; any other status
   that isn't `active` gets 503 `app_deploying` with `retry-after: 5`
   (`gateway.ts:194-203`). Branch 06 adds `deps.activate` for `binding`
   rows here.
3. Reserved paths: the tools contract under any spelling
   (`publicRoutes.ts:129-135`) and RFC 9728 metadata (`gateway.ts:204-218`).
4. Server-function guard (`gateway.ts:221-229`).
5. Public-route match with path canonicalization (`publicRoutes.ts:41-113`, `213-238`).
6. CSRF: a state-changing request passes only with `Sec-Fetch-Site: same-origin`,
   or with an `Origin` equal to the app host. WebSocket upgrades get an
   Origin check (`csrf.ts:25-65`, `79-99`; `gateway.ts:252-268`).
7. `authenticator.authenticate(request)`, then
   `authenticator.hasAppAccess(session, app)` (`gateway.ts:276-290`).
8. Strip inbound trust headers: `cookie`, `authorization`,
   `cloudflare-workers-version-overrides`, `x-everyapp-*` and `cf-access-*`
   (`headers.ts:44-59`).
9. Mint the identity JWT with `audience: app.appId` (`gateway.ts:320-337`).
   Public routes get a signed public marker instead, also with
   `audience: app.appId`, cached per `${appId}\0${issuer}` in a Map with no
   size limit (`gateway.ts:95-98`, `141-160`).
10. Call `(deps.fetcherFor ?? getAppFetcher)(deps.env, app).fetch(outbound)`.
    An `AppUnreachableError` becomes 503 `app_unreachable`; anything else
    becomes 502 `app_error` (`gateway.ts:395-422`). A 101 passes through
    without being rewrapped (`gateway.ts:432-434`).
11. `withSecurityHeaders`, which strips `Domain=` from app Set-Cookie
    headers and enforces the CSP floor (`headers.ts:178-187`, `219-255`).

### 1.3 The seam (`packages/perimeter/src/getAppFetcher.ts`)

```ts
export interface AppFetcherTarget { workerName: string; tier: "service_binding" | "dispatch"; }
// service_binding → env[`APP__${workerName}`]; anything else → AppUnreachableError("dispatch namespaces are deferred")
```
(`getAppFetcher.ts:16-57`). `appServiceBindingName` (`:30-32`) duplicates
`appBindingName` in `manifest/deploy.ts:12-14`.

Callers:

| Caller | Goes through the seam? |
|---|---|
| `handleGatewayRequest` (`gateway.ts:396`) | yes, passes the whole `RegisteredApp` |
| ToolBus `invokeApp` (`toolbus/runtime.ts:80-88`) | yes, but rebuilds `{workerName, tier}` |
| ToolBus catalog sync (`toolbus/catalog-sync.ts:49-62`) | yes, but rebuilds `{workerName, tier}` |
| `probeAppBinding` (`server/deploy-api.ts:63-79` on main; `server/app-activation.ts` on branch 06) | **no**: reads `env[appBindingName(workerName)]` directly |

### 1.4 The registry

- Read model: `RegisteredApp {appId, hostname, workerName, tier, organizationId, status, manifest}`
  (`registry.ts:28-40`). Branch 06 adds `rowId` and `versionId`.
  `AppRegistry` has `hasAnyActiveApp`, `findByHostname`, `findByAppId` and
  `findByOrgApp` (`registry.ts:42-50`). `rowToRegisteredApp` maps an
  unknown status to `disabled` and any tier other than `"dispatch"` to
  `service_binding`, and re-validates the manifest JSON (`registry.ts:63-77`).
- D1 adapter: `DrizzleAppRegistry` never routes a `deleted` tombstone
  (`drizzleAppRegistry.ts:38-47`). It throws if `hostname`, `workerName` or
  `manifest` is null (`:76-89`). `findByAppId` filters on `app_slug` alone
  with `limit 1` (`:62-64`); only the dev gateway calls it
  (`perimeter/src/dev/devGateway.ts:113`).
- Table: `apps.hostname` is UNIQUE, `apps.worker_name` is UNIQUE, and
  `apps.tier` defaults to `'service_binding'` with the comment "'dispatch'
  reserved for the hosted tier". `status` is
  `pending | binding | active | disabled | deleted`. Columns `version_id`
  and `deployed_at` exist (`db/apps.schema.ts:25-55`). Branch 06 adds
  `deployed_by_actor` and drops `legacy_names`.
- Naming rule: `registryWorkerNameFor` gives `every-<orgKey>-<appId>`
  (`manifest/manifest.ts:379-387`). `isRegistryWorkerName` exists "so the
  registry can never route a hostname to another Worker in the Cloudflare
  account" (`manifest.ts:389-407`). It is checked when the gateway binds an
  app, not on every request.
- Registration rules: on main they live in `services/AppRegistrationService.ts`
  (`hostnameFor` `:141-186`, `orgKeyFor` `:229-252`, `activate` `:587-622`).
  On branch 06 they become pure functions in `@every-app/perimeter/registry`
  (`registry/registration.ts`: `appNames`, `planRegistration`,
  `markDeployedUpdate`, `deleteUpdate`). New rows are written with
  `tier: "service_binding"` hard-coded, and `markDeployedUpdate` moves
  `pending` to `binding`.

### 1.5 The app-to-gateway direction (identity in props)

- The SDK builds the binding at build time from `.everyapp/deploy.json`:
  `EVERY_APP_GATEWAY = {type: "worker", worker: "every-app-gateway", exportName: "AppGateway", props: {organizationId, appId: manifest.id, workerName}}`
  (`packages/sdk/src/cloudflare/worker.ts:311-321`).
- The gateway parses those props (`app-gateway-entrypoint.ts:160-180`) and
  looks up the caller with `findByOrgApp`, using a 500-entry, 30 s/5 s cache
  (`:208-228`). It requires the registry row to match all three fields
  (`:103-113`) and the manifest to allow the provider (`:114-120`).
  Attribution checks the forwarded identity JWT against `audience: props.appId`
  and `user.orgId === props.organizationId` (`:230-260`).
- Cloudflare's guarantee behind this (Workers `ctx.props` docs): props "can
  only be set by someone who has permission to edit and deploy the worker
  to which it is being delivered". In self-host that is the operator, which
  ADR-0003 treats as the root of trust. In hosted it has to be the
  platform, never the tenant.

### 1.6 Hostnames and the session cookie today

- Self-host serves each app host as a Workers Custom Domain on the gateway.
  Branch 04 deletes wildcard routing (`cli-redesign.md:499`). Cloudflare
  allows 100 Custom Domains per zone and 1,000 routes per zone (Workers
  limits page, updated 2026-10-12).
- Better Auth sets `crossSubDomainCookies` to `APP_BASE_DOMAIN`, or to the
  gateway hostname (`auth/config.ts:204-221`, `280-287`). The control-plane
  guard says this outright: "The control plane is reachable with the same
  session cookie as every app subdomain, so a page on any app is
  'same-site'" (`server/control-plane-guard.ts:4-6`).
- The security model states the rule as "the gateway denies access when the
  active session organization does not own the target app"
  (`docs/security-model.md:278-279`).

### 1.7 Caches on the perimeter path

| Cache | Key | Size cap | TTL | Code |
|---|---|---|---|---|
| hostname → app | full host | 500, FIFO (a `Map.get` hit doesn't refresh) | hit 30 s, miss 5 s, one shared map | `server.ts:55-105` |
| caller → app (AppGateway) | `[orgId, appId]` | 500, FIFO | 30 s / 5 s | `app-gateway-entrypoint.ts:9-12`, `208-228` |
| org context | `userId\0activeOrgId\|sole` | 500, FIFO | 30 s | `organization/orgContext.ts:15-16`, `41-75` |
| public marker | `appId\0issuer` | **none** | half the identity TTL | `gateway.ts:93-98`, `141-160` |
| app access (`user_app_access`) | none: one D1 query per request | – | – | `AppAccessRepository.ts:93-113` via `betterAuthAuthenticator.ts:148-152` |
| Better Auth session | none: `auth.api.getSession` hits D1 on every request (no `cookieCache` or `secondaryStorage` configured) | – | – | `betterAuthAuthenticator.ts:116` |

### 1.8 Where the design docs and the code disagree

- §2.6 of the recommendation proposes a `tenants` table, scripts named
  `t_<tenant>_<app>`, and "hostname→tenant in KV"
  (`architecture-v2-recommendation.md:26`, `73`). The code went another
  way: organizations plus `organization_keys` (`db/organization-keys.schema.ts`),
  Worker names `every-<orgKey>-<appId>`, and the hostname as a unique D1
  column. Keep the code's model. An org is the tenant and `orgKey` is the
  tenant label. No `tenants` table is needed.
- The recommendation puts the admin plane on its own origin
  (`architecture-v2-recommendation.md:24`). The code has
  `APP_BASE_DOMAIN == gateway host` ("for now", `app-hosts.ts:8-10`), so
  apps sit one label under the control plane and share its site.
- The recommendation's "Internal JWTs are tenant-scoped (`aud = t_<tenant>_<app>`)"
  (`:73`) was never built. `aud` is `app.appId` (`gateway.ts:327`,
  `toolbus/src/execute.ts:219`, `toolbus/src/catalog.ts:243`; SDK
  `everyApp.ts:113-130` expects `EVERYAPP_APP_ID`, which is `manifest.id`,
  `worker.ts:299`).
- The overview's hosted flow says "first upload is SYNCHRONOUS → 200 = live"
  and "NO binding step exists" (`architecture-v2-overview.md:380-384`).
  Cloudflare's changelog confirms this for **first-time** uploads. It says
  nothing about how fast a redeploy propagates (§5).

---

## 2. What the hosted tier needs

### (a) `tier: "dispatch"` in `getAppFetcher`

**The API, as of today.** `DispatchNamespace.get(name, args?, options?: {limits?: {cpuMs?, subRequests?}, outbound?: {...}}): Fetcher`.
The type comment says it throws when the script doesn't exist
(`@cloudflare/workers-types` 4.20260702.1, `index.d.ts:16128-16165`). In
practice, the docs examples catch an error starting with "Worker not found"
from the call (dynamic-dispatch page, updated 2026-09-16). The second
argument carries `props`, which the user Worker reads as `this.ctx.props`.
The docs say: "These data values are visible to the user code. The
dispatch Worker can select different props for each invocation", and "An
RPC stub passed through dynamic dispatch props is valid only during the
request that received it." Outbound parameters go in the third argument
and must be declared in the namespace binding's `outbound.parameters`.
`limits` lives in the same third argument (custom-limits page, 2026-04-21).
The upload metadata also accepts static `limits: {cpu_ms, subrequests}`
and `tags` (at most 8 per script) (OpenAPI, `PUT /accounts/{id}/workers/dispatch/namespaces/{ns}/scripts/{name}`).

**What to pass:**

| Argument | v1 value | Why |
|---|---|---|
| `name` | `app.workerName`, which is `every-<orgKey>-<appId>`, unchanged | It is already globally unique (`apps.worker_name` UNIQUE) and already the naming rule. Check `isRegistryWorkerName` again at dispatch time, because dispatch by name turns a corrupted row into a cross-tenant jump. |
| `args.props` | `{}` | See the table below. Caller identity already travels as the signed `x-everyapp-identity` JWT, which the SDK verifies the same way on both tiers. App identity is in the upload-time binding. Service bindings can't carry per-request props (only `ctx.exports` loopbacks can), so putting anything the app relies on here would split the SDK by tier. |
| `options.limits` | `app.limits ?? undefined`, a new nullable registry column filled from the plan | Per-plan ceilings without re-uploading. |
| `options.outbound` | `{ caller: { organizationId, appId, workerName } }` | So the outbound Worker can enforce the manifest's egress list and log per app. The schema's dispatch binding accepts `outbound.worker.entrypoint`, so the outbound handler can be a named entrypoint on the gateway Worker itself, with no third Worker. |

**Could per-request props replace upload-time binding props for app identity?** No, for these reasons:

| How the user Worker is invoked | Gateway binding with upload-time props | Per-request dispatch props | Outbound params |
|---|---|---|---|
| HTTP through the perimeter | yes | yes | yes |
| ToolBus `tools/call` and catalog sync (over the seam) | yes | yes | yes |
| Gateway-driven cron (proposed G10, over the seam) | yes | yes | yes |
| Native Cron Trigger | n/a: **no schedules endpoint for dispatch scripts** in the OpenAPI spec (only `/accounts/{id}/workers/scripts/{name}/schedules`) | – | – |
| Workflow step (OpenSEO `rank-check-workflow`, `site-audit-workflow`: `open-seo/wrangler.jsonc:22-38`) | yes | **no** | not documented |
| Durable Object method, alarm or WebSocket (OpenSEO `SAM_CHAT`: `wrangler.jsonc:45-51`) | yes (`env`) | **no** | **no**: "Outbound Workers do not intercept fetch requests from Durable Objects" (outbound page) |
| Queue consumer | yes | **no** | not documented |

So `EVERY_APP_GATEWAY` keeps its upload-time `props: {organizationId, appId, workerName}`.
Two things change for hosted. (1) The hosted deploy API, not the tenant's
build, writes the binding into the upload metadata. (2) It refuses any
`service`, `dispatch_namespace`, `mtls_certificate` or Durable Object
binding with a foreign `script_name` coming from the tenant. Without that
filter, a tenant script with a `dispatch_namespace` binding to the
production namespace could call any other tenant's Worker directly and
skip the perimeter. Combined with `aud = appId`, it could also replay a
JWT minted for its own `todo` to another org's `todo`.

If the live check in §5 shows a namespaced user Worker **can't** bind to
the gateway Worker, the fallback is a per-request capability:
`ctx.exports.AppGateway({props})` passed as `props.EVERY_APP_GATEWAY`. That
works for HTTP, ToolBus and gateway-driven crons. Workflows, DOs and
queues would then need a per-app bearer secret to a public broker route.
That is a worse design, so the binding question must be settled first.

### (b) Hostnames for hosted

Proposed scheme:

| | Self-host (unchanged) | Hosted |
|---|---|---|
| Control plane | `GATEWAY_URL` host, e.g. `apps.example.com` | `everyapp.com`, with **host-only** cookies |
| App host | `<appId>.<base>` for the install org, `<appId>-<orgKey>.<base>` for others | always `<appId>-<orgKey>.<APP_BASE_DOMAIN>` (no install org), with `APP_BASE_DOMAIN` a **separate registrable domain on the PSL**, e.g. `everyapp.app` |
| How hosts reach the gateway | one Workers Custom Domain per app (100 per zone) | one route `*.everyapp.app/*`, plus a proxied wildcard DNS record `*` pointing at `192.0.2.0` (hostname-routing page, 2026-09-24). Universal SSL covers one wildcard level, which is why the label stays single. |
| BYO domains (later) | n/a | `*/*` route on the SaaS zone, Cloudflare for SaaS custom hostnames, and the registry `hostname` column (or an `app_hostnames` child table) |
| Session on app hosts | shared parent-domain cookie (`config.ts:282-285`) | per-host `__Host-` cookie set by a redirect handshake (G7) |

`<appId>-<orgKey>` splits unambiguously at the last hyphen because org
keys contain no hyphens (`manifest.ts:358-364`), and `DNS_LABEL_PATTERN`
already caps the label at 63 characters.

Why a separate domain on the PSL is required, not just nicer. Branch 06's
cookie config would scope the Better Auth cookie to `APP_BASE_DOMAIN`
whenever it is set (`config.ts:208-210`). With the control plane on
`everyapp.com` and apps on `everyapp.app`, the browser would reject the
cookie, because a host can't set a cookie for an unrelated domain, so
sign-in breaks outright. Suppose instead the apps stay under the control
plane's domain. Then every tenant's code runs on a sibling subdomain of
the cookie domain, and three things follow:

- A tenant page can set `__Secure-better-auth.session_token; Domain=<base>`
  from client JavaScript. `stripSetCookieDomains` only filters response
  headers (`headers.ts:178-187`), so this is cookie tossing that leads to
  login CSRF.
- A tenant page can send credentialed GETs to another tenant's app host and
  to the control plane. Those requests are same-site, so `SameSite=Lax`
  doesn't stop them.
- The overview's accepted risk #2 (`architecture-v2-overview.md:161-163`)
  assumed the attacker was an "XSS'd app". In hosted, the attacker is a
  tenant who deployed the app on purpose.

`workers.dev`, `pages.dev`, `vercel.app`, `github.io` and `netlify.app`
are all on the PSL (`public_suffix_list.dat`, version 2026-10-07) for
exactly this reason.

Changes in `server.ts` (shape in G6): classify the host **before** the D1
lookup:
- control plane: exactly `GATEWAY_URL`'s host;
- app candidate: exactly one label below `APP_BASE_DOMAIN`, and in hosted
  mode that label must match `^[a-z][a-z0-9-]*-[a-z0-9]{1,12}$`;
- custom hostname candidate: hosted with BYO enabled only;
- otherwise 404 without touching D1.

Today any non-gateway host costs a D1 query on a cache miss
(`server.ts:211-216`). Behind a wildcard route, any random label reaches
the gateway, so an attacker can force a D1 read per request and push real
entries out of the shared 500-entry cache. `appHostParent` reduces to
`appBaseDomain` (branch 06 already does this). `ownGatewayHost` duplicates
`gatewayHostOf` (`server.ts:64-71` against `app-hosts.ts:32-39`). The
no-`GATEWAY_URL` bootstrap (`server.ts:183-206`) is self-host only.

### (c) The registry row for hosted, and two writers sharing one set of rules

Keep one `apps` table and one read model. For hosted, the hosted HTTP
control plane writes the row through Drizzle in the gateway. For
self-host, the CLI writes it through `cf d1 query` batches (ADR-0003
Decision 1). Both call the same pure functions in
`@every-app/perimeter/registry` (branch 06 `registration.ts`; ADR-0003
Decision 2). The gateway still re-validates on read
(`rowToRegisteredApp`, `registry.ts:63-77`). What differs between the
writers is authority (ADR-0003 Decision 5), the format of
`deployed_by_actor`, and who builds the bindings, which is the platform in
hosted.

| Column | Today | Hosted |
|---|---|---|
| `tier` | default `'service_binding'`, never written as `'dispatch'` (`planRegistration` hard-codes it) | `'dispatch'`, passed in as `RegistrationInput.tier` |
| `worker_name` | `every-<orgKey>-<appId>` | same value, used as the **dispatch script name**. No `t_<tenant>_<app>` scheme. |
| dispatch namespace | – | **no column.** One namespace, bound as `env.DISPATCHER`. Cloudflare's guidance is "Do not create a namespace per customer" (how-WfP-works page). |
| `limits` | – | **new** nullable JSON `{cpuMs, subRequests}`, filled from the plan by billing, read on every request (it rides in the cached row) |
| tags | – | **no column**: derived at upload as `org:<orgId>`, `app:<slug>`, `src:<catalog\|org>` (8 max) |
| `status` | `pending\|binding\|active\|disabled\|deleted` | same values. In hosted, the deploy API goes `pending → active` because the upload is synchronous. **New** `disabled_reason` (`admin\|billing\|abuse`) for the 503 body and the UI. |
| `source` / `catalog_app_id` | – | **new**: `catalog` (an org's copy of OpenSEO and similar) or `org` (tenant code). Decides who may push upgrades and which brokered providers are on offer. |
| `version_id`, `deployed_at`, `deployed_by_actor` | exist (the last one on branch 06) | same. Actor is `user:<id>` or `ci:<credentialId>` in hosted. |
| `hostname` | UNIQUE, assigned once | same, built by `appNames` with `isInstallOrganization: false` |

### (d) Caches under many tenants

- **Hostname cache.** Split hits from misses. Make it a real LRU (delete
  and re-set on hit). Raise the cap to about 5k entries; a manifest row is
  a few KB. Gate on host shape before lookup (b). Optionally add a
  per-colo L2 through `caches.default` keyed `https://registry.internal/h/<host>`.
  The gateway isn't a namespaced script, so `caches.default` is available
  to it; only namespaced scripts lose it (WfP limits page). That shares
  lookups across isolates and cuts D1 reads. TTL stays 30 s. A hosted
  billing or abuse suspension then takes effect within 30 s plus the L2
  TTL, which is a founder call (Q8). KV dual-write (the recommendation's
  idea) only pays off when one writer controls every write. The CLI
  writes D1 in self-host, so the Cache API with a TTL is the simpler
  choice for both.
- **Caller cache.** Same LRU fix. Its key comes from binding props, which
  tenants can't influence, so there is no flooding risk.
- **Org context.** Key it by `(userId, app.organizationId)` once
  authentication resolves the app's org (G5). Same cap and LRU fix.
- **Public marker cache.** Give it a cap. Key it by `workerName` once
  `aud = workerName` (G4). With `aud = appId`, org A's and org B's `todo`
  share one marker today; that is harmless only because they share an
  audience.
- **App access.** Cache `hasAccessByUserAndAppSlug` for 30 s per
  `(userId, appRowId)` alongside the org context. Under hosted load, the
  uncached access query plus `getSession` is two D1 round trips per proxied
  request. Better Auth's `session.cookieCache` is the other lever; that is
  for the auth researcher.

### (e) "Activate on first request" against synchronous WfP upload

Branch 06's `activateApp` probes `env[APP__<worker>]` and flips the row to
`active`, but only when `GATEWAY_DEPLOYMENT_MODE` is `self_hosted`
(`app-activation.ts`, branch 06; `cli-redesign.md:86-104`). That fits the
service-binding tier, where the gateway Worker has to be redeployed before
an app can be reached. For dispatch there is nothing to bind:
`DISPATCHER.get(name)` resolves by name at request time, and "first-time
uploads of User Workers are now deployed synchronously. A 200 OK response
guarantees the script is fully provisioned" (changelog 2025-02-20). So:

- The hosted deploy API uploads, and on 200 writes
  `markDeployedUpdate(..., {tier: "dispatch"})`, which returns
  `status: "active"`, in the same handler. Rows never sit in `binding`.
- `activateApp` stays self-host only, but its probe should go through the
  seam (G2), so one function knows how to reach an app.
- `getAppFetcher` turns "Worker not found" into `AppUnreachableError`
  (503 `app_unreachable`). That is the honest answer for a deleted script
  or a broken row.
- Redeploy ordering. User Workers have no gradual deployments; "Changes
  ... deployed all-at-once to 100%" (WfP limits page). Write the new
  manifest (route policy) after the upload returns 200, as self-host does
  (`apps.schema.ts:42-43`). For the propagation window, old policy may
  front new code. Accept that.
- The CLI's single live wait (fetch the hostname until it stops returning
  503 `app_deploying`) works unchanged against hosted.

### (f) Places the perimeter assumes one organization or one owner

| # | Assumption | Where | What breaks in hosted |
|---|---|---|---|
| 1 | The session acts for **one active org**. An app counts only if `session.orgId === app.organizationId`. | `betterAuthAuthenticator.ts:119-130`, `136`; `orgContext.ts:41-99`; `security-model.md:278-279` | A user in a personal org and an invited org gets a 403 on the other org's apps. With no `activeOrganizationId`, `resolveOrgContext` returns null unless the user has exactly one membership (`orgContext.ts:94-98`), and the session-create hook sets it only for a sole org (`config.ts:380-391`). The result is a 302-to-sign-in loop while signed in. |
| 2 | **Install organization.** The owner's org gets bare `<appId>.<base>` hosts. | `OrganizationRepository.ts:37-52`; `AppRegistrationService.ts:153-161`; branch 06 `appNames({isInstallOrganization})` | No install org exists. Hosted always passes `false`. |
| 3 | **`aud = appId`** for identity and public markers | `gateway.ts:153`, `327`; toolbus `execute.ts:219`, `catalog.ts:243`; SDK `everyApp.ts:113-130`; `app-gateway-entrypoint.ts:244` | App ids repeat across tenants, so a token for org A's `todo` verifies at org B's `todo`. Only topology prevents replay today. |
| 4 | `findByAppId` (app slug alone, `limit 1`) on the production registry interface | `registry.ts:45`; `drizzleAppRegistry.ts:62-64` | Ambiguous across orgs. Only dev uses it. |
| 5 | Shared parent-domain session cookie; the control plane is same-site with every app | `config.ts:204-221`, `282-285`; `control-plane-guard.ts:4-6` | Cross-tenant cookie tossing and same-site GETs, see (b). |
| 6 | Bootstrap "no active app anywhere" | `server.ts:183-206` | Global across tenants. Hosted must always set `GATEWAY_URL`, so this path must be off in hosted mode. |
| 7 | Cloudflare Access membership assumes one owner org | `auth/cloudflare-access/membership.ts:215-248` | Turn the Access plugin off in hosted mode. |
| 8 | Organizations can't be created by users | `config.ts:315` | Hosted sign-up must create the personal org server-side (auth researcher's area). |
| 9 | One shared provider key | `app-gateway-entrypoint.ts:22` | Fine for hosted v1 (ADR-0001 #5). Metering needs `{organizationId, appId}`, which is already in props (`:122-140`). |

Every other perimeter rule (CSRF, public routes, header stripping, the CSP
floor, reserved paths) works per host and per request and already holds
for many tenants.

---

## 3. Gaps and the smallest change that closes each (diff shape)

Sizes are engineer-days for one person with agents. G1-G5 and G8-G9 are
perimeter-local and land without the hosted deploy API. G3 and G7 are
hosted-only.

### G1. A dispatch branch in the seam (0.5-1 d)

```diff
// packages/perimeter/src/getAppFetcher.ts
-export interface AppFetcherTarget { workerName: string; tier: "service_binding" | "dispatch"; }
+import { appBindingName } from "./manifest/deploy";
+export interface DispatchLimits { cpuMs?: number; subRequests?: number }
+export interface AppFetcherTarget {
+  workerName: string;
+  tier: Tier;
+  appId: string;
+  organizationId: string;
+  limits?: DispatchLimits | null;
+}
+export const DISPATCH_NAMESPACE_BINDING = "DISPATCHER";
+interface DispatchNamespaceLike {
+  get(name: string, args?: Record<string, unknown>,
+      options?: { limits?: DispatchLimits; outbound?: Record<string, unknown> }): AppFetcher;
+}
 export function getAppFetcher(env, app): AppFetcher {
   if (app.tier === "service_binding") { /* unchanged, appBindingName() instead of the local copy */ }
-  throw new AppUnreachableError(`Tier "${app.tier}" is not supported yet ...`);
+  const ns = env[DISPATCH_NAMESPACE_BINDING] as DispatchNamespaceLike | undefined;
+  if (!ns || typeof ns.get !== "function")
+    throw new AppUnreachableError(`No dispatch namespace binding "${DISPATCH_NAMESPACE_BINDING}".`);
+  let stub: AppFetcher;
+  try {
+    stub = ns.get(app.workerName, {}, {
+      ...(app.limits ? { limits: app.limits } : {}),
+      outbound: { caller: { organizationId: app.organizationId, appId: app.appId, workerName: app.workerName } },
+    });
+  } catch (error) { throw new AppUnreachableError(`dispatch ${app.workerName}: ${messageOf(error)}`); }
+  return { async fetch(request) {
+    try { return await stub.fetch(request); }
+    catch (error) {
+      if (/^Worker not found/.test(messageOf(error))) throw new AppUnreachableError(`no script ${app.workerName}`);
+      throw error;
+    }
+  } };
 }
```
```diff
// packages/perimeter/src/registry.ts (registry/apps.ts after branch 06)
 export interface RegisteredApp { ...; tier: Tier; organizationId: string;
+  /** Per-request dispatch limits (hosted); null: none. */
+  limits?: DispatchLimits | null;
 }
 export interface AppRegistry {
   hasAnyActiveApp(): Promise<boolean>;
   findByHostname(hostname: string): Promise<RegisteredApp | null>;
-  findByAppId(appId: string): Promise<RegisteredApp | null>;   // moves to InMemoryAppRegistry/dev only
   findByOrgApp(organizationId: string, appId: string): Promise<RegisteredApp | null>;
 }
```
Also check the naming rule again at dispatch time. `RegisteredApp` gains
`orgKey` (from a join to `organization_keys` in `DrizzleAppRegistry`), and
the dispatch branch refuses unless `isRegistryWorkerName({appId, orgKey, workerName})`.
Tests: a fake `DISPATCHER` in `getAppFetcher.test.ts`, plus a
`gateway.test.ts` case for a dispatch app returning 503 on "Worker not
found".

### G2. Every invocation goes through the seam (0.5 d)

```diff
// apps/every-app-gateway/src/server/toolbus/runtime.ts:84 and catalog-sync.ts:52
-  getAppFetcher(env, { workerName: app.workerName, tier: app.tier === "dispatch" ? "dispatch" : "service_binding" })
+  getAppFetcher(env, app)   // SyncableApp carries organizationId, appSlug→appId, limits
// server/app-activation.ts (branch 06) / deploy-api.ts:63-79
-  const binding = env[appBindingName(app.workerName)]; if (typeof binding?.fetch !== "function") return false;
+  // packages/perimeter: export async function probeApp(env, app): Promise<boolean>
+  //   try { await getAppFetcher(env, app).fetch(new Request(`https://${app.hostname}/__everyapp/health`)); return true }
+  //   catch { return false }
```

### G3. Platform-built app bindings and a binding allowlist (1.5 d, inside the hosted deploy API)

`everyAppWorker()` keeps building the self-host config
(`worker.ts:301-323`). The hosted deploy API takes the tenant's bundle and
manifest, **discards any tenant-supplied bindings**, and builds the upload
metadata from the manifest and the registry row:

```ts
// apps/every-app-gateway/src/server/hosted/uploadMetadata.ts (new)
bindings: [
  { type: "service", name: "EVERY_APP_GATEWAY", service: "every-app-gateway", entrypoint: "AppGateway",
    props: { organizationId: row.organizationId, appId: row.appSlug, workerName: row.workerName } }, // props: see §5 claim 1
  { type: "plain_text", name: "EVERYAPP_APP_ID", text: row.appSlug },
  { type: "plain_text", name: "EVERYAPP_AUDIENCE", text: row.workerName },            // G4
  { type: "plain_text", name: "EVERYAPP_IDENTITY_PUBLIC_KEYS", text: JSON.stringify(keys) },
  { type: "plain_text", name: "EVERYAPP_IDENTITY_ISSUER", text: env.GATEWAY_URL },
  ...d1/kv/do/workflow bindings from appResources(row.workerName, manifest),           // perimeter/registry
],
tags: [`org:${row.organizationId}`, `app:${row.appSlug}`, `src:${row.source}`],
limits: planUploadLimits(org),
```
Allowed tenant-declared kinds are only those the manifest can express:
d1, kv, a Durable Object in the same script, a workflow in the same
script, secrets. `service`, `dispatch_namespace`, `mtls_certificate`,
cross-script DOs and workflows, and `vpc_*` are refused. This is the
hosted counterpart to ADR-0003's "the operator is trusted".

### G4. A tenant-unique JWT audience (0.5 d)

```diff
// packages/perimeter/src/gateway.ts
-  const cacheKey = `${app.appId}\0${deps.issuer}`;
+  const cacheKey = `${app.workerName}\0${deps.issuer}`;
-    audience: app.appId,                  // :153 public marker
+    audience: app.workerName,
-      audience: app.appId,                // :327 identity
+      audience: app.workerName,
// packages/toolbus/src/execute.ts:219, catalog.ts:243 — audience: app.workerName (ToolBusApp gains workerName)
// apps/every-app-gateway/src/server/app-gateway-entrypoint.ts:244 — audience: props.workerName
// packages/sdk/src/server/everyApp.ts audienceFor(): EVERYAPP_AUDIENCE ?? EVERYAPP_APP_ID
// packages/sdk/src/cloudflare/worker.ts:299 — add EVERYAPP_AUDIENCE: { type: "text", value: name }
```
Do this on both tiers. Then a replayed token fails even if a path between
tenants opens up later.

### G5. Authenticate against the app's organization, not the active org (1 d)

```diff
// packages/perimeter/src/session.ts
 export interface SessionAuthenticator {
-  authenticate(request: Request): Promise<AuthenticatedSession | null>;
+  /** Resolve the caller and their membership in `app`'s organization. */
+  authenticate(request: Request, app: RegisteredApp): Promise<AuthenticatedSession | null>;
   hasAppAccess(session: AuthenticatedSession, app: RegisteredApp): Promise<boolean>;
 }
// packages/perimeter/src/gateway.ts:279
-      session = await deps.authenticator.authenticate(request);
+      session = await deps.authenticator.authenticate(request, app);
// apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts:116-130
-      const org = await resolveOrgContext({ userId, activeOrganizationId: session.session.activeOrganizationId ?? null });
-      if (!org) return null;
+      const role = await resolveLiveOrgRole(session.user.id, app.organizationId);  // cached (userId, orgId)
+      if (!role) return null;   // not a member of the app's org → anonymous/401, not a silent wrong-org JWT
+      return { sub: session.user.id, email: session.user.email, orgId: app.organizationId, orgRole: role };
// PAT branch: additionally require pat.organizationId === app.organizationId
```
`hasAppAccess`'s check `session.orgId !== app.organizationId` (`:136`)
then always passes for cookie sessions and stays as a guard for PATs.
Update `security-model.md:278-279` to match. This is right for self-host
too: an owner invited to a second org stops getting 403s.

### G6. Host classification before the lookup, and the hosted hostname scheme (1 d)

```diff
// apps/every-app-gateway/src/server/app-hosts.ts
+export type HostRoute =
+  | { kind: "control_plane" }
+  | { kind: "app"; host: string }
+  | { kind: "reject"; error: "unknown_app_host" | "unknown_host" };
+export function routeHost(host: string, env: HostEnv & { GATEWAY_DEPLOYMENT_MODE?: string }): HostRoute {
+  const gateway = gatewayHostOf(env);
+  if (!host || host === gateway) return { kind: "control_plane" };
+  const base = appBaseDomain(env);
+  if (base && host.endsWith(`.${base}`)) {
+    const label = host.slice(0, -(base.length + 1));
+    const hosted = env.GATEWAY_DEPLOYMENT_MODE === "hosted";
+    return isAppLabel(label, { requireOrgKey: hosted }) ? { kind: "app", host } : { kind: "reject", error: "unknown_app_host" };
+  }
+  if (gateway && host.endsWith(`.${gateway}`)) return { kind: "reject", error: "unknown_app_host" };
+  return { kind: "reject", error: "unknown_host" };   // BYO custom hostnames: a later "app" branch, hosted only
+}
// server.ts: replace :173-240 with a switch on routeHost(); resolveAppByHostname only for kind "app"
// auth/config.ts:204-221: in hosted mode return null (host-only cookie on everyapp.com)
// hosted gateway deploy config: routes ["everyapp.com/*", "*.everyapp.app/*"], DNS "* A 192.0.2.0 proxied",
//   dispatch_namespaces: [{ binding: "DISPATCHER", namespace: "production",
//     outbound: { service: "every-app-gateway", entrypoint: "Outbound", parameters: ["caller"] } }]
```
Branch 06's `appNames` already accepts `isInstallOrganization`. The hosted
writer passes `false`.

### G7. Per-host app sessions in hosted, plus the PSL entry (3-4 d; the PSL entry adds weeks of lead time)

- A new reserved path `/__everyapp/session` on app hosts. It sits under
  `EVERYAPP_INTERNAL_PREFIX` and is already never public
  (`publicRoutes.ts:116-121`). The perimeter handles it before the app
  lookup's status gate.
- Unauthenticated HTML navigation on a hosted app host redirects to
  `https://everyapp.com/app-session/authorize?host=<h>&return_to=...`
  instead of `loginUrl` (`gateway.ts:361-371`). The control plane checks
  the host against the registry and that the user can reach the app, mints
  a single-use 60 s code, and redirects to
  `https://<h>/__everyapp/session?code=...`. The perimeter exchanges the
  code and sets `__Host-everyapp_s=<opaque>; Secure; HttpOnly; SameSite=Lax; Path=/`.
- Storage: `app_host_sessions(token_hash, user_id, organization_id, hostname, auth_session_id, expires_at)`,
  joined to Better Auth `sessions`, so signing out on the control plane
  revokes every app-host session.
- `betterAuthAuthenticator.authenticate` reads `__Host-everyapp_s` on app
  hosts in hosted mode. `prepareOutboundHeaders` already strips `cookie`.
- Self-host keeps the shared cookie (Q2).
- Submit `everyapp.app` (or whichever domain is chosen) to the PSL private
  section early.

### G8. Caches that hold up under many tenants (1 d)

```diff
// apps/every-app-gateway/src/server.ts:55-105 (and the same helper reused by app-gateway-entrypoint.ts, orgContext.ts)
-const hostnameCache = new Map<string, { app: RegisteredApp | null; expiresAt: number }>();
+const hostHits = new LruTtl<string, RegisteredApp>({ max: 5_000, ttlMs: 30_000 });
+const hostMisses = new LruTtl<string, true>({ max: 2_000, ttlMs: 5_000 });
+// optional L2: caches.default.match(`https://registry.internal/h/${host}`) with s-maxage=30
// packages/perimeter/src/gateway.ts:95 publicMarkerCache → LruTtl({ max: 2_000 }) keyed by workerName (G4)
// betterAuthAuthenticator.hasAppAccess → LruTtl keyed `${userId}\0${appRowId}`, 30 s, forgotten with forgetOrgContext()
```
`LruTtl` is about 30 lines in `packages/perimeter/src/lru.ts`.

### G9. Tier in the shared registry rules, and the new columns (1 d, after branch 06)

```diff
// packages/perimeter/src/registry/registration.ts (branch 06)
 export interface RegistrationInput { ...
+  tier: Tier;                          // CLI: "service_binding"; hosted API: "dispatch"
+  source?: "catalog" | "org";
 }
-          tier: "service_binding",
+          tier: input.tier,
 export function markDeployedUpdate(app, { versionId, manifest, actor, now }) {
-    status: app.status === "pending" ? "binding" : app.status,
+    status: app.status !== "pending" ? app.status : app.tier === "dispatch" ? "active" : "binding",
 }
// apps/every-app-gateway/src/db/apps.schema.ts (+ regenerate the single baseline, cli-redesign §6)
+    limits: text("limits"),                         // JSON {cpuMs, subRequests} | null
+    disabledReason: text("disabled_reason"),        // 'admin' | 'billing' | 'abuse' | null
+    source: text("source").notNull().default("org"),// 'catalog' | 'org'
+    catalogAppId: text("catalog_app_id"),
// DrizzleAppRegistry.registryColumns + toRegistryRow: limits (JSON.parse, validated), orgKey (join organization_keys)
```

### G10. Crons for dispatch apps, driven by the gateway (2 d)

There is no schedules API for dispatch scripts (§5 claim 2), and the
`Fetcher` type has no `scheduled()` (`workers-types` `index.d.ts:2149-2157`).
Proposal:

- The hosted gateway's `scheduled` handler (`server.ts:269-275`; today a
  single hourly trigger, `cloudflare.config.ts:116`) runs every minute.
- It reads `app_schedules(app_row_id, cron)`, written by the deploy API
  from the manifest's crons, and for each app that is due sends
  `POST /__everyapp/scheduled` over `getAppFetcher`.
- That request carries a gateway-minted JWT with `chan=cron`, the same way
  the ToolBus signs `tools/call`.
- The SDK's `everyApp()` maps it to the app's `scheduled()` handler, and
  the perimeter refuses the path from outside, as it does
  `isReservedToolsPath`.

This also gives cron work per-request limits and outbound parameters.

### G11. Apps made of several scripts (decision, then about 1 d)

OpenSEO binds a Workflow in a second script, `open-seo-audit`
(`open-seo/wrangler.jsonc:22-33`). The registry holds one `worker_name` per
app, and the manifest's `workflows` only names `<worker>--<binding>` in the
same script (`manifest.ts:42-48`). Smallest fix: hosted v1 requires one
script per app (OpenSEO folds the audit Workflow back in, or ships it as a
second catalog app). The general fix, an `app_scripts` child table, can
wait.

### G12. Egress claims, stated honestly (0.5 d of docs and lint)

The outbound Worker sees only `fetch()` from dispatched invocations. It
doesn't see fetches from Durable Objects (docs), and its coverage of
Workflows is undocumented. OpenSEO's SAM agent is a DO that calls
OpenRouter. "Each app only has what the gateway gave it" holds for
**secrets**, because the broker injects keys and apps never hold them. It
does not hold for **raw egress**. Say this in the hosted security model,
and add the deploy-time lint the overview already promised
(`architecture-v2-overview.md:164-165`).

### G13. Activation for dispatch apps (0.25 d)

Covered by G9 (`markDeployedUpdate` gives `active` for dispatch) and G1
("Worker not found" becomes 503). `activateApp` stays as it is and only
runs in self-host mode.

### Suggested PR order

1. G1 + G2: the seam (no behaviour change in self-host).
2. G4: audience.
3. G5: org from host.
4. G8: caches.
5. G9: tier in the registry rules (after branch 06 merges).
6. G6 + G7: hosted hosts and sessions.
7. G10: crons.

G3 and G11 come with the hosted deploy API PR. That totals about 10-12
engineer-days of perimeter work. G1-G5 and G8 are useful to self-host as
they stand.

---

## 4. Open questions only the founder can answer

1. **Which domain do hosted apps live on?** Options: a separate registrable
   domain on the PSL (`<app>-<orgKey>.everyapp.app`), or subdomains of
   `everyapp.com`. *Why it matters:* it goes into certs, the PSL entry
   (weeks of lead time), cookies and marketing, and it decides whether
   tenants share a cookie site. *Default:* a dedicated domain on the PSL,
   with `everyapp.com` as the control plane.
2. **Per-host app sessions (one invisible redirect per app per browser
   session), or a shared cookie with cross-tenant same-site exposure?**
   *Why:* the shared cookie can't be made safe when siblings run hostile
   tenant code. *Default:* per-host in hosted, shared in self-host
   (trusted apps).
3. **Catalog apps: one Worker per org per catalog app (ADR-0001 #6), or a
   multi-tenant catalog Worker?** *Why:* it changes the script count
   (orgs × catalog apps), upgrade fan-out, and whether D1 is per org.
   *Default:* one Worker per org. WfP has unlimited scripts and isolation
   comes free.
4. **Can one browser session use apps of several orgs at once?** (org taken
   from the host, G5, or an explicit active-org switch). *Why:* the founder's
   own onboarding (a personal org plus invited orgs) hits the current rule
   right away. *Default:* the org comes from the host.
5. **Per-request CPU and subrequest limits by plan: when, and what
   values?** *Why:* a runaway tenant loop costs CPU billed to the
   platform. *Default:* no per-request limits until billing lands; set
   upload-time `limits` at a generous ceiling so a loop can't run without
   bound.
6. **Do org apps get crons in hosted v1?** (gateway fan-out, G10). *Why:*
   it is two days of work, and OpenSEO needs `*/5` crons
   (`open-seo/wrangler.jsonc:98`). *Default:* yes, at minute granularity.
7. **May tenant apps use Durable Objects, given they bypass the outbound
   Worker?** *Why:* egress control doesn't cover them. *Default:* allow
   them. No secrets are ever given to apps, so the bypass grants internet
   access only.
8. **Is 30-60 s acceptable for a billing or abuse suspension to take
   effect?** *Why:* it decides whether the hostname cache needs active
   purge (an epoch in KV) or a TTL is enough. *Default:* a TTL is enough.
9. **BYO custom domains in hosted v1?** *Default:* no. G6 leaves a `*/*`
   and custom-hostname branch open for later.

---

## 5. Load-bearing claims

1. **A WfP user Worker can carry an upload-time `service` binding, with
   `entrypoint` and `props`, to a Worker outside the namespace**
   (`every-app-gateway` / `AppGateway`). *Source:* the OpenAPI schema for
   dispatch-script upload lists `service` among binding types, with
   `entrypoint` but no documented `props`. Props on service bindings are
   documented for Wrangler and `ctx.props` (Workers Context docs), and
   self-host deploys rely on them today through cf. Neither the WfP
   bindings page nor the OpenAPI spec confirms props on a binding from a
   namespaced script. **If false:** app identity has to move to a
   per-request capability, Workflows/DO/queue work loses broker access,
   and a per-app bearer path is needed (§2a fallback). *Live check:*
   upload a one-line user Worker with
   `{"type":"service","name":"G","service":"every-app-gateway","entrypoint":"AppGateway","props":{"x":"1"}}`
   and echo `ctx.props` from the gateway.
2. **Dispatch scripts have no Cron Triggers.** *Source:* the OpenAPI spec
   has `/accounts/{id}/workers/scripts/{name}/schedules` and no
   `/workers/dispatch/namespaces/{ns}/scripts/{name}/schedules`, and the
   upload metadata has no `triggers` key (queried 2026-10-15). **If
   false:** G10 shrinks to writing schedules at upload, and per-request
   props still don't reach cron work.
3. **A first-time WfP upload is dispatchable as soon as the API returns
   200.** *Source:* changelog 2025-02-20. Redeploy propagation is not
   stated. **If false:** hosted rows need a `binding`-style activation
   with a dispatch probe (`probeApp`, G2).
4. **Outbound Workers see only `fetch()` from user Workers, not DO
   fetches, and parameters reach them only through `dispatcher.get`.**
   *Source:* outbound page (2026-04-21), dynamic-dispatch page
   (2026-09-16). Coverage of Workflow invocations is undocumented.
   **If wrong in the permissive direction:** G12's egress story improves.
   Nothing in the perimeter design depends on it.

Also unverified and worth one session (the recommendation's Phase 0 list,
`architecture-v2-recommendation.md:151`):

- WebSocket 101 through `DISPATCHER.get().fetch`. The SAM agent needs it;
  the perimeter already passes 101s through (`gateway.ts:432-434`).
- Whether a stub passed through dispatch props survives `ctx.waitUntil`
  after the response.

---

## 6. Sources

Code (worktree `/Users/bensenescu/.t3/worktrees/private-every-app/t3-afce8c8f`, `main` e1d9d3c6):
- `apps/every-app-gateway/src/server.ts`, `src/server/app-hosts.ts`, `src/perimeter/drizzleAppRegistry.ts`, `src/perimeter/betterAuthAuthenticator.ts`, `src/server/app-gateway-entrypoint.ts`, `src/server/organization/orgContext.ts`, `src/server/control-plane-guard.ts`, `src/server/deploy-api.ts`, `src/server/toolbus/{runtime,catalog-sync,app-host-mcp}.ts`, `src/server/services/AppRegistrationService.ts`, `src/server/repositories/{OrganizationRepository,AppAccessRepository}.ts`, `src/auth/config.ts`, `src/db/{apps,organization-keys}.schema.ts`, `cloudflare.config.ts`
- `packages/perimeter/src/{gateway,getAppFetcher,registry,host,session,publicRoutes,csrf,headers,index}.ts`, `packages/perimeter/src/manifest/{manifest,deploy}.ts`, `packages/perimeter/src/dev/devGateway.ts`
- `packages/sdk/src/cloudflare/worker.ts`, `packages/sdk/src/server/{everyApp,gatewayFetch}.ts`, `packages/toolbus/src/{execute,catalog}.ts`
- Branch `cli-redesign/06-gateway-registry`: `packages/perimeter/src/registry/{apps,registration,index}.ts`, `apps/every-app-gateway/src/server/app-activation.ts`, `server.ts` diff
- Docs: `docs/architecture-v2-overview.md` §1, §2 (residual risks, lines 156-168), §5 (lines 307-394); `docs/architecture-v2-recommendation.md` §2.1, §2.6 (lines 20-27, 71-73, 151, 174); `docs/cli-redesign.md` §1 (lines 60-135), §3, §6; `adr/ADR-0001`, `adr/ADR-0003`; `docs/security-model.md:278-285`
- OpenSEO: `/Users/bensenescu/workspaces/open-seo/wrangler.jsonc` (workflows 22-38, DO 45-51, crons 98)
- `@cloudflare/workers-types` 4.20260702.1 `index.d.ts:2149-2157` (Fetcher), `16128-16165` (DispatchNamespace)

Cloudflare (fetched 2026-10-15):
- Dynamic dispatch Worker, updated 2026-09-16: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/
- Custom limits, updated 2026-04-21: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/
- Outbound Workers, updated 2026-04-21: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/
- Bindings (WfP), updated 2026-09-16: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/
- Hostname routing, updated 2026-09-24: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/hostname-routing/
- How WfP works, updated 2026-04-21: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/
- WfP limits (cf object, caches.default disabled, 8 tags, no gradual deployments), updated 2026-10-13: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/
- Worker isolation (untrusted vs trusted), updated 2026-04-21: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/
- Tags, updated 2026-04-21: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/tags/
- Workers limits (Custom Domains 100/zone, routes 1,000/zone), updated 2026-10-12: https://developers.cloudflare.com/workers/platform/limits/
- Context: `ctx.props`, `ctx.exports`: https://developers.cloudflare.com/workers/runtime-apis/context/
- Changelog, synchronous first-time uploads (2025-02-20): https://developers.cloudflare.com/changelog/post/2025-02-20-synchronous-uploads/
- Cron Triggers (propagation up to 15 min; Workflow `schedules`), updated 2026-09-04: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Cloudflare OpenAPI (through the Cloudflare API MCP, 2026-10-15): `PUT /accounts/{account_id}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}` metadata keys and binding types; full list of dispatch-namespace paths (no schedules); `/accounts/{account_id}/workers/scripts/{script_name}/schedules`
- Public Suffix List, version 2026-10-07_07-28-19_UTC: https://publicsuffix.org/list/public_suffix_list.dat (lists `workers.dev`, `pages.dev`, `github.io`, `netlify.app`, `vercel.app`)
