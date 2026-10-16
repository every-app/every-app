# Hosted Every App: security and abuse threat model

Date: 2026-10-15. Researcher report for the hosted, multi-tenant tier (open sign-up, orgs deploying their own code into our Cloudflare account through Workers for Platforms (WfP), the gateway holding platform provider keys). It covers the six areas the brief names, then gives a prioritized build list with sizes and the exact place each control is enforced.

Cloudflare doc dates are each page's own "Last updated" line, read on 2026-10-15 unless noted. Code references are `path:line` in this worktree.

---

## 0. Summary

The perimeter design carries over to hosted. One public Worker strips trust headers and mints a short identity JWT, and apps are private. What doesn't carry over is the self-host assumption that **whoever deploys an app is the operator**. Today the operator writes the app's manifest (which grants its providers), its Worker bindings (including the `props` that name it to the broker) and its build. In hosted, a stranger writes all three. Six things change as a result:

1. **The deploy service has to be the binding allowlist.** WfP upload metadata accepts about 37 binding types (from Cloudflare's OpenAPI spec). Several of them give one tenant another tenant's or the platform's resources: `dispatch_namespace`, `durable_object_namespace` with `script_name`, `d1`/`kv`/`r2` by id, `secrets_store_secret`, `ratelimit` by `namespace_id`, `service`, `mtls_certificate`, `ai`, `vpc_*`. Deploying bindings "does not need separate permissions on the bound resources", and Cloudflare has no token scope that covers only a dispatch namespace. Nothing at Cloudflare stops a mis-built upload from binding the gateway's own D1. One concrete case: the gateway's sign-in limiters (namespaces 4180–4182) can be shared, and so drained, by any Worker in the account.
2. **The JWT audience isn't unique across tenants.** `aud = appId` is unique only within an org (`apps.schema.ts:72-75`), and the SDK never checks `org_id`. The v2 design promised `aud = t_<tenant>_<app>`. The code doesn't do it (`gateway.ts:327`, `app-gateway-entrypoint.ts:244`, `toolbus/catalog.ts:243`, `toolbus/execute.ts:219`).
3. **A cross-tenant cache bug exists today.** The ToolBus argument-validator cache is keyed by `appId + the app-reported catalog hash + tool name` (`toolbus/execute.ts:283-286`). The gateway stores that hash without recomputing it (`catalog-sync.ts:119`, `toolbus/catalog.ts:68-71`). In hosted, org B's `todo` can plant a validator that rejects every call under org A's `todo` key, in any shared isolate.
4. **The egress gap is real and wider than documented.** Outbound Workers still don't see `fetch()` from Durable Objects or mTLS bindings (docs, Apr 21 2026). Custom limits on `dispatcher.get()` apply only to dispatched invocations, so DOs, crons and queue consumers need script-level `limits` set in upload metadata. Workflows "do not support Workers for Platforms" (Workflows limits page, Sep 21 2026), and Every App just shipped app Workflows (#282).
5. **The broker has no money controls.** Apps grant themselves providers in the manifest (`manifest.ts:174`, checked at `app-gateway-entrypoint.ts:114`). The broker has no quotas or holds. Usage exists only as a log line (`ai-proxy.ts:176-190`), and logs drop to 1% sampling account-wide after 5B a day. A public route that forwards to the broker turns the platform key into a free LLM proxy ("LLMjacking").
6. **Hosting strangers' HTML on our cookie domain is the GitHub-Pages-2013 problem.** The session cookie is `Domain=APP_BASE_DOMAIN`, which is the gateway's host (`auth/config.ts:204-219`, `app-hosts.ts:1-15`). Any org app's JavaScript can toss cookies onto the gateway. Phishing pages on our domain also damage the domain's reputation for every tenant. The fix before GA is a separate registrable domain for org apps, listed on the Public Suffix List, plus a per-host session handoff, as Cloudflare Access does.

The prioritized list is in §6:

| Tier | Items | Engineer-days |
|---|---|---|
| Must have before anyone but us uses it | 13 | ~12 |
| Before public sign-up | 9 | ~16 |
| Before GA | 7 | ~18 |

---

## 1. What exists today

### 1.1 The perimeter ("one door")

| Piece | Where | Hosted-relevant behaviour |
|---|---|---|
| Host routing | `apps/every-app-gateway/src/server.ts:166-267` | The gateway host gets the control plane. A registry hostname gets the perimeter. An unknown subdomain gets a 404. The hostname→app cache lasts 30 s for hits and 5 s for misses (`server.ts:55-105`), so a takedown takes up to 30 s per isolate. |
| Proxy core | `packages/perimeter/src/gateway.ts:178-436` | Reserved paths are refused, server functions are guarded, CSRF is checked (`:252-268`), routes are classed public or private, the session is authenticated, the 120 s identity JWT is minted with `audience: app.appId` (`:320-336`), and the request goes through `getAppFetcher`. WebSocket 101s pass through without rewrapping (`:431-433`). `disabled` answers 503 (`:194-196`). |
| Header hygiene | `packages/perimeter/src/headers.ts:44-58` | Inbound `Cookie`, `Authorization`, the version override, and every `x-everyapp-*` and `cf-access-*` header are deleted. **Apps never receive any cookie**, their own included. |
| Response hygiene | `headers.ts:179-186`, `:215-250` | `Domain=` is removed from app `Set-Cookie`, a CSP floor is applied (no `default-src`), plus HSTS. App `Set-Cookie` is otherwise forwarded. Since apps never get cookies back, those cookies only ever reach the gateway. |
| Public routes | `packages/perimeter/src/manifest/manifest.ts:434-486`, `publicRoutes.ts` | `/`, `/*`, `/**` and `*` are hard errors. But `/:p` plus `/:p/**` passes and exposes everything except `/` (`:name` compiles to `[^/]+` and `**` to `.*`). This guards honest authors against mistakes; it does nothing against a hostile one. |
| Fetcher seam | `packages/perimeter/src/getAppFetcher.ts:38-57` | The `dispatch` tier throws "not supported yet". The signature `(env, app)` takes no per-request context, so it can't pass `props`, `limits` or `outbound`. |
| Identity JWT | `packages/sdk/src/internal/protocol.ts:23`, `identity.ts:177-236` | RS256 with a pinned kid, TTL 120 s, a random `jti`, and no replay cache. The SDK checks `aud = EVERYAPP_APP_ID` (`server/everyApp.ts:117-130`) and **never checks `org_id`**. |
| Org binding | `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts:133-153` | `hasAppAccess` requires `session.orgId === app.organizationId`, so a JWT always names the app's own org. |

### 1.2 The broker (AppGateway entrypoint)

- The entrypoint is `server.ts:152-164` (`AppGateway extends WorkerEntrypoint`). It serves `/api/ai/<provider>/*` only (`app-gateway-entrypoint.ts:194-206`).
- **Caller identity comes from `ctx.props` = `{organizationId, appId, workerName}`.** The props are checked against the registry row: registered, active, and the same org, app and Worker (`app-gateway-entrypoint.ts:72-113`). The props are written into the app's Worker by `everyAppWorker()` at build time, from `.everyapp/deploy.json` (`packages/sdk/src/cloudflare/worker.ts:311-320`). In self-host the operator runs that build. In hosted, the org would.
- **The grant is self-declared.** `manifest.providers` must include the provider (`app-gateway-entrypoint.ts:114-120`), and the manifest is uploaded by whoever deploys (`manifest.ts:173-178`). The `ai.routes` widening also needs the operator's `AI_PROXY_EXTRA_ROUTES` (`ai-proxy.ts:203-220`), which is a real ceiling. `ai.models` can only narrow.
- **User attribution is optional.** The app forwards its inbound `x-everyapp-identity` (`packages/sdk/src/server/gatewayFetch.ts:53-55`). The broker verifies `aud = props.appId` and `org_id = props.organizationId` (`app-gateway-entrypoint.ts:242-249`). On failure it falls back to "app" attribution; it doesn't deny.
- **The provider path is inference-only on one shared OpenAI key** (`ai-proxy.ts:39-49`, `:125-127`), with `store: false` forced (`:268-270`).
- **Metering is a log line.** `ai.proxy.usage` is emitted from a stream tap (`ai-proxy.ts:176-190`, `ai-usage.ts:39-59`). There are no quotas, holds, concurrency caps or `max_tokens` clamps.
- **The caller cache is keyed by `[orgId, appId]`** (`app-gateway-entrypoint.ts:55-58`, `:208-228`). That is tenant-safe.

### 1.3 Accounts, sign-up, rate limits

| Control | Where | Today |
|---|---|---|
| Sign-up | `auth/config.ts:89-108`, `:361-365` | Invite-only: a live invite link for the same email |
| Org creation | `auth/config.ts:315` | `allowUserToCreateOrganization: false`. Only the setup claim creates one. |
| Email verification | `auth/shared.ts:16` | `requireEmailVerification: false` |
| Credential rate limits | `cloudflare.config.ts:141-152`, `server/auth-rate-limit.ts:30-201` | Rate-limit bindings in namespaces 4180 (60/min per IP or /64), 4181 (10/min per IP+email) and 4182 (30/min per email). Counted per Cloudflare location. |
| Cross-isolate budgets | `db/rate-limit.schema.ts`, `server/mcp-auth/registration-limit.ts:30` | D1 counters, e.g. dynamic client registration capped at 200 a day per gateway. A refused request writes nothing. This is the pattern to reuse for org quotas. |
| Better Auth limiter | `auth/config.ts:270-273` | Per isolate: weak on Workers, as the file itself notes |
| Deploy API | `server/deploy-token-auth.ts:55-66` | `GATEWAY_DEPLOYMENT_MODE=hosted` turns it off (404) |

### 1.4 Isolation and naming

- Worker and resource names are `every-<orgKey>-<appId>`, with `--` before resource suffixes (`manifest.ts:379-420`, `db/organization-keys.schema.ts`). They are unique per account and checked before binding (`isRegistryWorkerName`).
- The SDK binds Durable Objects only to the app's own script (`worker: name`, `packages/sdk/src/cloudflare/worker.ts:362-372`). Hosted upload metadata needs the same rule.
- App Workflows (#282) are named `<worker>--<binding>` (`worker.ts:376-395`). App crons go through `triggers` (`worker.ts:425-432`).

### 1.5 In-isolate caches and their keys

| Cache | Where | Key | Tenant-safe in hosted? |
|---|---|---|---|
| hostname → app | `server.ts:59` | full hostname (unique) | Yes. A takedown is stale for up to 30 s. |
| broker caller | `app-gateway-entrypoint.ts:55` | `[orgId, appId]` | Yes |
| org context | `server/organization/orgContext.ts:18` | `userId\0…` | Yes |
| public marker | `packages/perimeter/src/gateway.ts:95-98`, key at `:146` | `appId\0issuer` | **Shared across orgs with the same slug.** Harmless today, since the marker is anonymous, but it goes with fixing the audience. |
| tool argument validator | `packages/toolbus/src/validation.ts:38`, key at `execute.ts:283-286` | `appId\0catalogHash\0tool`, **with the hash reported by the app** (`catalog-sync.ts:119`; only its format is checked, `catalog.ts:68-71`) | **No.** Cross-tenant poisoning, see S9. |
| catalog sync | `server/toolbus/app-host-mcp.ts:93`, `catalog-sync.ts:159` | `orgId\0appId` / `appRowId` | Yes |

### 1.6 Secrets

- Platform secrets are plain Worker secrets on the gateway: `OPENAI_API_KEY`, `BETTER_AUTH_SECRET`, `JWT_PRIVATE_KEY` (`cloudflare.config.ts:27-54`, `:153-163`).
- App secrets are Worker secrets set by `everyapp secret set` and never read back (`worker.ts:52-61`).
- No gateway-side encrypted store exists. The integrations design (branch `research/app-integrations`, `app-integrations.md` "Security → Storage") proposes envelope encryption: a KEK in a Worker secret, per-org DEKs in D1.

### 1.7 Where the design docs and the code or Cloudflare now disagree

| Design says | Reality |
|---|---|
| "Internal JWTs are tenant-scoped in hosted mode (`aud = t_<tenant>_<app>`)" (`docs/architecture-v2-recommendation.md:73`, overview `:151-152`) | Every mint and verify uses `appId`: `gateway.ts:153,327`, `app-gateway-entrypoint.ts:244`, `toolbus/catalog.ts:243`, `toolbus/execute.ts:219`, `sdk/server/everyApp.ts:117-130`. |
| "per-tenant D1/KV attached in upload metadata" (recommendation §2.6) | KV allows **1,000 namespaces per account** (KV limits, Oct 8 2026). One KV per app can't survive open sign-up. D1 allows 50,000 per account, which can be raised (D1 limits, Apr 21 2026). |
| "DO-originated fetches bypass the outbound worker … flagged by deploy-time lint" (recommendation §4, overview §2) | Still true (outbound-workers page, Apr 21 2026), and mTLS bindings bypass it too. Cron and queue invocations of user Workers aren't documented either way (§2.1). A lint on the bundle can be evaded by any dynamic `fetch`. |
| "Metering via per-script GraphQL analytics + tags; Logpush for audit" (§2.6) | Fine for Cloudflare's own usage. But AI metering today is `logEvent` (`ai-proxy.ts:176`), and Workers Logs fall to a 1% sample **for the whole account** after 5B logs a day (Workers Logs, Oct 12 2026). One noisy tenant degrades our audit and billing logs. |
| "the CF token lives HERE [the gateway], as a worker secret" (overview `:372`), versus "isolated deploy service" (recommendation `:108`) | The two docs disagree. Keep the token out of the gateway (S24). |
| Integrations design: "props can only be set by someone who can deploy Workers in the account … a known limit until a gateway-owned deployer exists" | Hosted *is* the gateway-owned deployer. WfP adds a second, request-scoped way to identify the caller: a capability passed through dispatch props (§2.3). |
| "Hosted abuse controls … must be added deliberately before metered handlers" (recommendation `:50`) | The broker is a metered handler and already ships without them. |
| App Workflows (#282) | Workflows "do not support Workers for Platforms" (Workflows limits, Sep 21 2026). The WfP bindings page (Sep 16 2026) lists Workflows. The two pages conflict, so a spike is needed (S4). |

---

## 2. What the hosted tier needs: threat model

### 2.1 Actors, assets, boundaries

**Actors.**

| Code | Actor |
|---|---|
| A0 | Anonymous internet |
| A1 | Free sign-up who controls a whole org: their own code, manifest and public routes |
| A2 | Paying org running hostile code |
| A3 | Compromised or malicious member of a victim org |
| A4 | Prompt-injected agent acting with a victim's token |
| A5 | Us: a bug in our own deploy service |

**Assets.**

| Code | Asset |
|---|---|
| M1 | Platform provider keys and the money behind them (OpenAI, OpenRouter, DataForSEO) |
| M2 | Other orgs' data (D1/KV/DO, tool results, sessions) |
| M3 | The gateway's own D1: users, sessions, invitations, encrypted secrets |
| M4 | The platform Cloudflare API token, and with it every Worker in the account |
| M5 | Our domain's reputation and the Cloudflare account's standing |
| M6 | The availability of shared limits: account KV/D1 quotas, the log budget, rate-limit namespaces, provider rate limits |

**Enforcement points.** These are named the same way throughout the report.

```
Browser ─► [PERIMETER] gateway fetch (server.ts → perimeter/gateway.ts)
             │  getAppFetcher(env, app, reqCtx)
             ▼
           [DISPATCHER.get(name, {props}, {limits, outbound})]  ← per request
             ▼
           user Worker (WfP, untrusted mode)
             ├─ fetch() ─► [OUTBOUND WORKER] allowlist, egress budget (dispatched requests only)
             ├─ props.GATEWAY / env.EVERY_APP_GATEWAY ─► [BROKER] grant, quota, hold, key injection
             └─ DO / cron / queue: no dispatcher, so only [SCRIPT LIMITS] apply; DO fetch bypasses OUTBOUND
CLI / CI ─► hosted deploy API ─► [DEPLOY SERVICE] holds the CF token; metadata allowlist; provisioning; takedown
Agents ─► /mcp ─► [TOOLBUS] risk policy, budgets
```

### 2.2 Threat table

| # | Actor → goal | Path through today's code | Control | Enforcement point |
|---|---|---|---|---|
| T1 | A1 → read another org's D1/KV/DO | Upload metadata binds a foreign `database_id` or `namespace_id`, or a DO with `script_name`/`dispatch_namespace` | Build the metadata from an allowlist; verify bindings after upload | DEPLOY SERVICE |
| T2 | A1 → steal a platform secret | `secrets_store_secret`, a `service` binding to the gateway, or a `d1` binding to the gateway's DB | Same; the deploy token lacks Secrets Store Edit | DEPLOY SERVICE, token scope |
| T3 | A1 → lock victims out of sign-in | `ratelimit` binding with `namespace_id: "4182"`, calling `limit({key:"account:<victim email>"})` | Forbid `ratelimit` bindings, or allow only per-app namespace ids; move the gateway's namespace ids | DEPLOY SERVICE |
| T4 | A1 → free LLM or DataForSEO | Public route → broker (self-granted `providers`) → platform key | Grants tied to billing; per-mode budgets (public, user, background); provider sub-key hard limits | BROKER, DISPATCHER props |
| T5 | A1 → mining or a denial-of-wallet bill | CPU in fetch, DO wall-clock, alarms, crons, log spam, storage | `dispatcher.get` limits plus script `limits`; observability set by us; usage poller with auto-suspend | DISPATCHER, DEPLOY SERVICE, poller |
| T6 | A1 → open proxy, scraping or spam relay from our IPs | User Worker `fetch()` to arbitrary hosts; DO fetches bypass the outbound Worker | Outbound default-deny for unverified orgs; restrict DOs | OUTBOUND WORKER, DEPLOY SERVICE |
| T7 | A1 → phishing on our domain, or cookie tossing | Public HTML routes; `document.cookie=…; domain=<base>` from an app page; app `Set-Cookie` on its own host | Separate registrable domain on the PSL; strip app `Set-Cookie`; interstitial for new orgs; takedown | PERIMETER, DNS/PSL |
| T8 | A1 → consent-phish MCP tokens from other orgs' members | A CIMD document on an org app's public route; the redirect URI on an apps domain outside `onGatewayDomain` | Refuse client ids and redirect URIs on the apps domain too | `server/mcp-auth/own-domain.ts:25-35` |
| T9 | A2 → impersonate users at the broker | Replays a JWT forwarded by its app (`aud = appId`) | aud = Worker name; user attribution from a request-scoped capability | PERIMETER, BROKER |
| T10 | A1 → break another tenant's tools | Poisons the validator cache (§1.5) | Key by app row id or a hash the gateway computes | TOOLBUS |
| T11 | A1 → mass sign-ups exhaust account quotas (KV 1,000, D1 50,000, scripts) | Every org gets N catalog Workers and D1s at sign-up | Provision lazily; cap orgs per user; Turnstile; email verification | Sign-up hooks, DEPLOY SERVICE |
| T12 | A4 → burn a victim org's credits through metered "read" tools | ToolBus allows reads on read-only connections (`toolbus/policy.ts:25-41`) | A `metered` risk class with per-connection budgets | TOOLBUS, BROKER |
| T13 | A5 → our deploy bug ships tenant code with platform bindings | The token can bind anything | Verify bindings after upload; deploy-service code review boundary | DEPLOY SERVICE |
| T14 | A1 → cache-leak other users' pages | User Worker turns on Workers Caching (`cache_options`); the cache key ignores identity headers | Force caching off; later, put `sub` and `org` in dispatch props | DEPLOY SERVICE, DISPATCHER props |

---

## 3. The six areas: findings, sources, smallest changes

### 3.1 Untrusted org code

**Custom limits.** The dispatcher sets per-invocation CPU and subrequest caps: `env.dispatcher.get(name, {}, { limits: { cpuMs, subRequests } })`. "If a user Worker hits either of these limits, the user Worker will immediately throw an exception" (custom-limits, Apr 21 2026). They cover only invocations made through the dispatcher. Durable Objects take CPU limits from the script's own `limits.cpu_ms` ("can be increased for all Durable Objects associated with a Durable Object definition by setting `limits.cpu_ms`", DO limits, Jun 1 2026). The WfP upload metadata accepts `limits: {cpu_ms, subrequests}` (Cloudflare OpenAPI, `PUT …/dispatch/namespaces/{ns}/scripts/{name}`, queried 2026-10-15). It can be changed later with `PATCH …/settings`.

WfP pricing caps CPU at "30 seconds … per invocation" and "15 minutes of CPU time per Cron Trigger or Queue Consumer invocation" (WfP pricing, Apr 21 2026).

**Smallest change:** set both levels.
- In the dispatcher: `limits` per plan (free: `cpuMs: 50, subRequests: 50`; verified: `cpuMs: 2_000, subRequests: 500`; numbers to tune).
- In the deploy service: `limits.cpu_ms` and `subrequests` in metadata, the same or lower, so DOs, crons and queues are capped too.

**Egress (outbound Worker).**
- "Outbound Workers do not intercept fetch requests made from Durable Objects or mTLS certificate bindings" (outbound-workers, Apr 21 2026).
- Enabling an outbound Worker disables `connect()` for user Workers (same page). That's good: raw TCP can't route around it.
- Parameters come only from `dispatcher.get(…, …, {outbound: {…}})`. The namespace API has no namespace-level outbound setting: namespace PUT takes `name` and `trusted_workers` only (OpenAPI, 2026-10-15).

So invocations that don't go through the dispatcher have no outbound context: cron triggers, queue consumers, DO alarms and DO fetches. **Assume those are uncontrolled until a spike proves otherwise.** A bundle lint ("this bundle calls `fetch` inside a DO class") is advisory at best.

Three options to close the gap:
- **(a) Restrict DOs.** No DO exports, crons or queues for unverified orgs. Verified orgs accept the documented gap. Fastest.
- **(b) Move org code to Dynamic Workers.** `globalOutbound` "intercepts every `fetch()` and `connect()` call", and DO Facets give dynamic code its own SQLite under a supervisor DO the platform writes, with `globalOutbound` set on the facet's code (Dynamic Workers egress control and DO Facets, both Oct 12 2026). That would close the DO gap. It is a runtime change that belongs in the platform-architecture report.
- **(c) Accept and monitor.** Per-script subrequest analytics plus auto-suspend.

**Recommended:** (a) now, and evaluate (b) before GA.

**Memory and time.** Memory is 128 MB per isolate, and on overflow the runtime "lets in-flight requests complete and creates a new isolate" (Workers limits, Oct 12 2026), so memory is self-limiting. Wall-clock time is not. DOs are billed "for compute duration (wall-clock time) while the Durable Object is actively running or is idle in memory but unable to hibernate". Calling `accept()` on a WebSocket bills "for the entire time the WebSocket is connected". The price is $12.50 per million GB-s at a fixed 128 MB (DO pricing, Sep 30 2026), which is about $4 per always-on DO per month. A tenant holding 1,000 DOs awake with alarms or non-hibernating sockets costs us about $4k a month, and no CPU limit catches it.

**Smallest change:** a usage poller (cron in the deploy service) that queries GraphQL:
- `workersInvocationsAdaptive` filtered by `scriptName`: requests, errors and CPU quantiles (WfP observability doc);
- `durableObjectsPeriodicGroups` and `durableObjectsInvocationsAdaptiveGroups` (DO metrics, Oct 8 2026).

It compares each script against its plan budget and auto-disables (S27) at about 10x.

**Logs as a shared resource.** Workers Logs: "a daily limit of 5 billion logs per account per day. After the limit is exceed[ed], a 1% head-based sample will be applied for the remainder of the day", and $0.60 per million beyond 20 M a month (Workers Logs, Oct 12 2026). The SDK ships every app with `logs.headSamplingRate: 1, persist: true, invocationLogs: true` (`sdk/cloudflare/worker.ts:226-243`).

**Smallest change:**
- The deploy service sets `observability` itself: logs off or sampled at 1% for unverified orgs, a capped rate for verified ones.
- The broker meters into D1 or a per-org Durable Object, never logs (S19).

**Abuse patterns to expect.**
- **CPU mining** is uneconomic under 50 ms to 30 s CPU caps. Cloudflare's terms treat it as malicious code: you warrant content is free of "crypto-mining software" (Developer Platform Service-Specific Terms, Sep 28 2026).
- **Open proxies and scrapers** use our egress IPs. The outbound default-deny closes this for dispatched requests. DOs are the hole.
- **Phishing kits** go on public routes (§3.6).
- **LLMjacking**: reselling access to someone else's AI key through a reverse proxy. Sysdig named it in May 2024 and measured one proxy at "nearly $50,000 in just 4.5 days" (The Hacker News, May 2024). Stolen compute as offensive infrastructure was still being reported in June 2026 (CSA research note, 2026-06-26). Our version: an org app whose public route forwards to the broker.

**Cloudflare's terms for us as a WfP platform** (Developer Platform Service-Specific Terms, last updated Sep 28 2026):
- We "are solely responsible for the acts of [our] End Users."
- Cloudflare "may, but is not obligated to, limit or suspend [our] or [our] End Users access" for suspected violations, generally with notice but not necessarily.
- §10 permits offering Workers to End Users "on your Internet Properties" through WfP, subject to the Agreement.
- The prohibited list includes phishing, malware and "volumetric attacks".
- Cloudflare will "remove or disable access to" hosted content that violates the terms, and "generally also notify the website operator" (Cloudflare abuse approach, trust hub).
- The terms impose no explicit abuse-desk duty on us. In practice, though, reports about our tenants land on our account, so we need our own intake and takedown (S27, S30).

**Build plane.** RFC-0001 Phase 3 imagines "GitHub URL → build/deploy pipeline" (`adr/RFC-0001-org-rearchitecture-phase-1.md:96-99`). Building a stranger's repo runs their `npm install` scripts and Vite plugins on our infrastructure. **Smallest change:** v1 accepts prebuilt bundles only, built by the CLI or the org's own CI. A hosted build later runs in a Sandbox with no secrets and an outbound policy (Sandbox egress options in the integrations research, `raw/build-patterns.md` §6).

**Workflows.** Workflows limits (Sep 21 2026): "Workflows cannot be deployed to Workers for Platforms namespaces, as Workflows do not support Workers for Platforms." The WfP bindings page (Sep 16 2026) lists Workflows among what bindings enable, and the API spec has a `workflow` binding type for namespace scripts. **Smallest change:** the hosted deploy service refuses manifests with `resources.workflows` until a 1-hour spike settles it.

### 3.2 Cross-tenant isolation

**Untrusted mode.** Keep the namespace untrusted. In untrusted mode `request.cf` is unavailable, each Worker has its own cache for the Cache API and for `fetch` through Cloudflare's cache, and `caches.default` is disabled (Worker isolation, Apr 21 2026; WfP limits, Oct 13 2026). Never set `trusted_workers: true`. The gateway itself isn't in the namespace, so it keeps `request.cf` (ASN, bot signals) for sign-up and abuse decisions.

**Workers Caching (new; affects isolation).**
- "Cloudflare checks the cache before running your Worker". The key is the request path, entrypoint, `ctx.props` and (by default) the version.
- "Requests that differ only in request headers that are not part of the cache key (for example … `Cookie`, or `Authorization`) return the same cached response."
- "Each user Worker has its own cache, isolated from the dispatcher and from other user Workers in the namespace."

(Workers Cache and Cache keys, both Oct 12 2026.)

`x-everyapp-identity` isn't in the key. An org app that turns on caching through `cache_options` or `exports[*].cache` in its metadata, and returns `Cache-Control: public` on a signed-in page, serves user U's page to user V. A multi-tenant catalog Worker would do the same across orgs.

**Smallest change:**
- The deploy service always sends `cache_options` off and strips `exports[*].cache`.
- If we ever allow caching, pass `props: {orgId, sub}` on `dispatcher.get`. Props *are* part of the key ("Multi-tenant safety with `ctx.props`", Cache keys doc).

**D1, KV, R2 and DO per app.**
- WfP's own guidance: "Each User Worker can only access the bindings that are explicitly attached to it. For complete isolation, you can create and attach a unique resource … to every User Worker" (WfP bindings, Sep 16 2026).
- Per-account ceilings: KV **1,000 namespaces** (Oct 8 2026); D1 50,000, raisable "to millions" (Apr 21 2026); DO namespaces have no limit in WfP (WfP limits).

So:
- Per-app D1 and DOs are fine.
- Per-app KV isn't viable with open sign-up. Either drop `resources.kv` for hosted apps (use D1 or DO SQLite) or offer KV as a gateway capability over one shared namespace with prefixes enforced by our code (weaker isolation, and it must be our RPC, never a raw binding).
- R2 isn't in the manifest today. If added, use one bucket per app or a capability.

**Durable Object namespaces.** The `durable_object_namespace` binding accepts `script_name` and `dispatch_namespace` (OpenAPI). An upload naming another tenant's script binds that tenant's DO class, storage included. The SDK already emits `worker: <own name>` (`worker.ts:363-367`). The deploy service must enforce that DO bindings have no `script_name` (or it equals self) and no `dispatch_namespace`.

**Rate-limit namespaces are account-shared.** "Two rate limiting bindings that share the same `namespace_id` — even across different Workers on the same account — share the same rate limit counters for a given key" (Rate limit binding, Oct 12 2026). The gateway's sign-in limiters are namespaces 4180, 4181 and 4182 (`cloudflare.config.ts:141-152`), keyed `account:<email>` (`auth-rate-limit.ts:194-198`). A tenant Worker that binds `namespace_id: "4182"` and calls `limit()` 30 times a minute per victim email locks those victims out of password sign-in in that location.

**Smallest change:**
- The deploy service rejects `ratelimit` bindings, or assigns ids from a reserved per-app range.
- Optionally move the gateway's ids to random high values. TODO.md:59 already flags collisions.

**Audience and org binding of identity JWTs.** Slugs are unique per org only (`apps.schema.ts:72-75`), and every audience is `appId` (§1.7). The SDK doesn't compare `org_id` with `EVERY_APP_ORG_ID`, even though the deploy sets that secret (`worker.ts:323`).

There is no live exploit path today. Untrusted user Workers can't reach each other directly, and the perimeter strips `x-everyapp-*` inbound. But the aud check is exactly the "dispatch routing is not the only line between tenants" defence the design promised.

**Smallest change:** `audience = app.workerName` (globally unique). Mint it at `gateway.ts:153,327`, `toolbus/catalog.ts:243`, `toolbus/execute.ts:219`. Verify it at `app-gateway-entrypoint.ts:244` (`props.workerName`). The SDK reads it from a new `EVERYAPP_AUDIENCE` text binding set by the deploy service, and checks `org_id === EVERY_APP_ORG_ID` whenever that's set. Key `publicMarkerCache` by the same value (`gateway.ts:146`).

**ToolBus validator poisoning (fix before any second org).** The key is `${app.appId}\0${app.catalogHash}\0${tool.name}` (`toolbus/execute.ts:283-286`). `catalogHash` is whatever the app reported (`catalog-sync.ts:119`); `normalizeCatalog` checks only its format (`toolbus/catalog.ts:68-71`).

The attack: org B registers `todo`, reports org A's catalog hash (deterministic for a catalog app, since it's computed from public source), and serves a schema of `{"not": {}}` for a tool name A also has. In any isolate where B's validator is compiled first, A's calls fail "invalid arguments". With `{}` instead, the gateway's own checks are silently skipped for A; the app's SDK still validates.

**Smallest change:** key the cache by the registry row id (`app.rowId`) plus the hash, or recompute the hash in the gateway from the stored tools. 0.25 day.

**Service-binding props: who can set them.**
- The platform's guarantee: "`ctx.props` can only be set by someone who has permission to edit and deploy the worker to which it is being delivered … you can trust that the content of `ctx.props` is authentic" (Context API, Oct 12 2026).
- But deploying a Worker with bindings needs only Editor on the Worker: "You do not need separate permissions on the bound resources to deploy the Worker" (Workers authorization, 2026-09-15).
- The only token permissions are account-wide "Workers Scripts Edit/Read". There is nothing WfP- or namespace-specific (API token permissions, Oct 12 2026).

So in hosted, **only our deploy service may ever upload, and it must build the props itself**. The org's bundle can't carry them: `cf build` writes them from `.everyapp/deploy.json` (`worker.ts:276-283`), and the org controls that file.

WfP also offers a request-scoped alternative that the org can't forge. The dispatcher passes a capability: `ctx.exports.AppGateway({ props: { organizationId, appId, workerName, mode, sub } })`, delivered inside `dispatcher.get(name, { props: { GATEWAY: stub } })`. "These props configure the Connector stub. The user Worker cannot read them directly." The catch: "An RPC stub passed through dynamic dispatch props is valid only during the request that received it" (Dynamic dispatch, Sep 16 2026).

That gives two transports:
1. **Per-request capability (preferred for user traffic).** It binds the broker call to the live request, including whether it is a public, user or MCP request. This is stronger than a 120 s JWT the app can replay.
2. **Upload-time `service` binding with props** for DOs, crons and queues (mode `background`). The OpenAPI schema for namespace-script `service` bindings lists `entrypoint, environment, name, service, type` and **no `props` field**. The same is true for non-namespaced scripts, which Wrangler and cf do send props for, so the spec is incomplete. A 1-hour spike decides whether WfP user Workers accept a `service` binding with `props` to a non-namespaced Worker's named entrypoint. If they don't, the background fallback is a per-app HMAC credential as a `secret_text`, verified by the broker against the registry. It is weaker (the app could leak it), but only the app's own power leaks.

**Replay across apps** (the brief's question 3):

| Attempt | Outcome |
|---|---|
| App A uses user U's JWT (aud=A) at the broker as itself | Allowed, within A's grant. This is the intended design. |
| App A presents U's JWT while posing as app B | Impossible. The caller comes from props, which A can't set (`app-gateway-entrypoint.ts:103-113`), and aud must equal `props.appId` (`:244`). |
| App A sends U's JWT straight to app B | No path in WfP: user Workers have no bindings to each other, and going through the public host passes the perimeter, which strips `x-everyapp-*` (`headers.ts:44-58`). If a path existed, B's SDK rejects it on aud, **except when B is another org's app with the same slug**. Fixed by the aud change. |
| App A replays U's JWT up to 120 s after U's request | Possible at the broker for user-scoped grants (per-person integration accounts). With the per-request capability, user attribution comes from the stub, which dies with the request. Keep the JWT path for compatibility, or limit it to read access. |
| App A omits identity | The call is attributed to the app (`app-gateway-entrypoint.ts:235-236`). **So per-user quotas can't be the only quotas**; org and app budgets come first. |

### 3.3 The broker

**Grants.** Today the manifest grants itself (`providers`). For platform-paid providers in hosted, a grant needs three things:
1. the org's plan entitles the provider;
2. an org admin approved this app's request (the integrations design's flow B/C, `app-integrations.md`);
3. the app has budget headroom.

**Smallest change:** an `app_provider_grants` table (`app_row_id, provider, mode: user|background|public, status, monthly_cap, approved_by`) checked in `handleAppGatewayRequest` next to the `providers` check (`app-gateway-entrypoint.ts:114`). The manifest's `providers` stays the request.

**Quotas and holds.**
- OpenSEO already does the right thing in-app. It takes `check({lock})` holds before expensive calls and finalizes after (`open-seo/src/server/billing/autumn.ts:58-69`). A replayed lock answers 409.
- The broker needs the same, per org, in front of every metered provider:
  - **Pre-call hold:** estimate cost from `max_tokens` (clamped by the gateway) or the DataForSEO task price, and reserve against a per-org ledger. A per-org Durable Object gives single-writer balances and a concurrency semaphore; Autumn locks also work.
  - **Settle** from the usage tap (`ai-usage.ts`) and release the remainder.
  - **Per-app and per-mode caps:** public mode is zero by default; background has its own cap.
  - **A concurrent-request cap per app.**
- Never derive billing from logs (§3.1).

**Shared fate at the provider.** One OpenAI key for every org means one abuser can get the key rate-limited or banned for everyone. OpenRouter's provisioning API creates keys programmatically with a credit `limit`, a `limit_reset` (daily, weekly or monthly), and `disabled: true` or DELETE to revoke (OpenRouter provisioning keys docs, read 2026-10-15). **Smallest change:** one OpenRouter sub-key per org (or per app), created at grant time and envelope-encrypted in D1 (§3.4). The provider then enforces a hard ceiling that no gateway race or bug can exceed. Takedown sets `disabled: true`.

**LLMjacking through public routes.** With the per-request capability, the broker knows `mode`. The rule: public mode gets no platform-paid providers unless the plan allows it, and then only under a separate small budget. Without the capability (the JWT path), the broker can't tell, which is a reason to prefer the capability.

**Prompt injection reaching metered tools.**
- ToolBus has read, write and destructive (`toolbus/policy.ts:25-41`). Read tools run on read-only connections. A credit-spending "research" tool, like OpenSEO's keyword research, is a read.
- Industry experience: "tool descriptions and outputs are treated as untrusted content" (recommendation §2.4). The "lethal trifecta" warning appears in `raw/build-patterns.md` §9.
- **Smallest change:**
  - add a `metered: true` (or `cost`) tool annotation;
  - add a per-connection, per-day credit budget in ToolBus, keyed by the `mcp_connections` row;
  - over budget means confirmation (once approvals ship) or refusal.
- The broker sees `chan: "mcp"` and `tc` in the forwarded identity (`security-model.md:180-184`), so it can also apply a lower MCP-channel cap. Because the app can drop the identity, ToolBus is the reliable place to count.

### 3.4 Secrets at rest

**What belongs where:**

| Secret | Store | Why |
|---|---|---|
| An org's own app secrets (their Stripe key for their app) | WfP script secrets: `PUT …/dispatch/namespaces/{ns}/scripts/{name}/secrets` (OpenAPI) | They go to the org's own Worker anyway. Cloudflare encrypts them and the API doesn't return values (the type is `secret_text`). No envelope scheme is needed. |
| Secrets the gateway holds for orgs (integration OAuth tokens, per-org provider sub-keys, BYO keys later) | Envelope encryption in gateway D1: AES-GCM ciphertext with a per-org DEK; the DEK wrapped by a platform KEK; `kek_version` stored with every wrapped DEK | Thousands of rows; rotation must be cheap |
| Platform secrets (KEK, JWT signing key, OpenAI/OpenRouter management keys, DataForSEO) | Gateway Worker secrets, or Secrets Store | A handful of values |

**Secrets Store fit.**
- It is in open beta, with "one store per account" and "up to 100 secrets per account" (Secrets Store, Aug 14 2026; Manage secrets, Sep 25 2026). That can't hold per-org secrets.
- It fits platform secrets. Workers read them with `await env.<BINDING>.get()` (Workers integration, Oct 12 2026).
- One useful property: binding a store secret needs a token with **Account Secrets Store Edit**, and a secret whose scopes include `workers` (Access control, Jun 29 2026). If the deploy token lacks that permission, even a buggy deploy service can't bind a platform secret into a tenant Worker. Plain Worker secrets have no such second gate.
- Pricing isn't stated on the pages read (open beta).

**KEK as a non-extractable key.** The upload API has a `secret_key` binding type (`algorithm, format, key_base64 | key_jwk, usages`; OpenAPI 2026-10-15), which would put a CryptoKey on `env` with fixed usages. If it's non-extractable, a gateway code bug can't exfiltrate the KEK. It isn't in the public docs I found, so treat it as unverified and fall back to a Worker secret imported with `extractable: false`.

**Rotation.**
- KEK: add a new version, re-wrap all DEKs in a background job (only small rows are rewritten), then retire the old version.
- DEK (per org): re-encrypt that org's rows lazily on read.
- JWT signing key: the set already supports current and next keys (`identity.ts:70-104`). In hosted the deploy service is the deployer, so a rotation re-pushes `EVERYAPP_IDENTITY_PUBLIC_KEYS` to every script with `PATCH …/settings` (bindings) and needs no rebuild.

**Blast radius of the platform Cloudflare token.**
- No permission is scoped to WfP (§3.2). A token that can upload user Workers can also overwrite the gateway and the outbound Worker, and bind the gateway's D1.
- Granular per-Worker roles exist, but "Creating a new Worker requires Workers Admin because per-Worker permissions can only apply to Workers that already exist" (Workers roles, 2026-09-15).

**Smallest change:**
1. A **separate `deploy-service` Worker** holds the token, and the gateway never does. The gateway calls it over a service binding with props (org, actor). It exposes exactly: provision app resources, upload a script from an allowlisted template, set secrets, patch settings, tombstone, delete.
2. Token permissions: Workers Scripts Edit (account), D1 Edit, plus KV Edit if KV stays. **Not**: Secrets Store Edit, Zone, DNS, Workers Routes, Access, API Tokens or Account Settings.
3. After every upload, `GET …/scripts/{name}/bindings` must equal the expected set, or the script is deleted and the event raised.
4. A Cloudflare audit-log alert on any edit to `every-app-gateway`, the outbound Worker or `deploy-service` made by the deploy token.
5. Later: a second Cloudflare account. The dispatch Worker must share the namespace's account, so the split would be "platform control (gateway D1, Secrets Store) vs runtime (namespace, dispatcher, per-app D1)". That needs an authenticated hop between the accounts (see founder question 9).

### 3.5 Open sign-up abuse

**Today:** invite-only sign-up, no Turnstile, no email verification (§1.3).

**Smallest set for open sign-up:**
- **Turnstile** through Better Auth's captcha plugin. Turnstile is supported, the defaults cover `/sign-up/email`, `/sign-in/email` and `/request-password-reset`, and the token goes in `x-captcha-response` (Better Auth captcha docs, read 2026-10-15). Add the social and mobile start paths that `auth-rate-limit.ts:40-42` already counts.
- **Email verification required** (`shared.ts:16` → `true`) before an org can deploy code, get an OpenRouter sub-key or use more than starter credits.
- **Disposable-domain block** in the `isSignUpEmailPath` hook (`auth/config.ts:360-366`), from `disposable-email-domains/disposable-email-domains` (active, pushed 2026-10-15). Normalize `+tags` and dots for Gmail.
- **Rate limits.** A sign-up limiter keyed by IP or /64 (reuse `clientAddressKey`, `auth-rate-limit.ts:98-104`) and by `request.cf.asn`, plus a global daily sign-up budget in `rate_limit_counters`, as dynamic client registration does (`registration-limit.ts:30`). Zone-level WAF rate-limit rules can count by ASN or Host only on Enterprise with Advanced Rate Limiting; Pro and Business count by IP (WAF rate limiting rules, Aug 25 2026). So do it in the gateway with the bindings.
- **Personal org created server-side on first verified sign-in.** Keep `allowUserToCreateOrganization: false` and create from a hook. Cap orgs per user (e.g. 3).
- **Lazy provisioning.** Create no Workers, D1 or KV at sign-up. Catalog apps provision on first open, or run as multi-tenant Workers (T11).

**Capability tiers (gating custom code):**

| Tier | How reached | Can do |
|---|---|---|
| Free | Verified email + Turnstile | Catalog apps, starter credits, no custom code, no public routes |
| Verified | Card on file through Stripe Checkout in setup mode ("save payment details … and charge your customers later", Stripe docs) via Autumn | Custom code (≤3 apps), outbound allowlist ≤10 hosts, ≤5 public routes, no DO, cron or queue |
| Paid | Plan | Higher caps, DOs, crons, BYO domains |

**Automated takedown** (one action, run by an admin or the poller):
1. Registry `status = 'disabled'`, which makes the perimeter answer 503 (`gateway.ts:194-196`). Isolates go stale for up to 30 s (`server.ts:55-57`). WebSockets already open stay open until the script is replaced.
2. Replace the script's code, keeping bindings and DO data for appeals: `PUT …/scripts/{name}/content` with a stub that throws. This stops DO, cron and queue code, which the dispatcher can't.
3. Set `limits.cpu_ms` to the minimum with `PATCH …/settings`, as belt and braces. Drop the crons by redeploying without triggers.
4. Revoke broker grants and disable the org's provider sub-keys (OpenRouter `disabled: true`).
5. If caching is ever allowed, purge.
6. Audit row and an email to the org owner.

### 3.6 Public routes of org apps on our domain

**Cookie tossing and session confusion.**
- The Better Auth session cookie is `Domain=APP_BASE_DOMAIN`, which is the gateway's host (`auth/config.ts:197-219`, `server/app-hosts.ts:1-15`). Every org app is one label below it.
- Server-side, the perimeter strips `Domain=` from app `Set-Cookie` (`headers.ts:179-186`). An app can still set a host-only cookie with the session cookie's name on its own host, and the gateway's Better Auth reads that host's cookies.
- Client-side, an org page's JavaScript can set `document.cookie = "…; domain=<base>"`, which reaches the gateway and every other tenant's host. The CSP floor doesn't stop scripts (`headers.ts:139-158`).
- This is what GitHub moved Pages off `github.com` for: "mitigating phishing attacks and cross-domain cookie vulnerabilities arising from hosting custom user content in a subdomain of our main website". The attack could "throw" cookies to the parent domain, and cookie overflow "could not be blocked server-side", making the domain move "a drastic, but ultimately necessary measure" (GitHub blog, 2013-04-09).

The robust fix is a separate registrable domain for org apps, added to the PSL private section, which is meant for owners who "delegate subdomains to mutually-untrusting parties" (PSL submit page; Mozilla PSL wiki). Browsers then refuse supercookies on it, and each app host is its own *site* ("Websites that have the same scheme and the same eTLD+1 are considered same-site", web.dev). Chrome also "uses the PSL to restrict Safe Browsing exceptions to registered domains" (Mozilla PSL Uses).

Consequence: the single cross-subdomain cookie stops working for org apps. The gateway needs a **per-app-host session handoff**: a top-level redirect to the gateway, then a one-time code, then a host-only `__Host-` cookie on the app host bound to the Better Auth session. Cloudflare Access does exactly this: a global session on the team domain and an "Application token … stored as a cookie on the protected domain" per application (Access authorization cookie, 2026-08-03). Catalog apps can stay on the gateway's domain under the current cookie model if we want, since they're our code.

**Interim (before public sign-up):**
- In hosted mode, strip all app `Set-Cookie` headers at the perimeter, since apps never receive cookies anyway (`headers.ts:44-47`).
- Org custom code only on the Verified tier.
- An ngrok-style interstitial: ngrok shows free accounts' browser visitors a one-time warning page "to block phishing attacks using our platform" (ngrok abuse page and ERR_NGROK_6024, read 2026-10-15). Ours would cover HTML responses on public routes of orgs younger than N days, set by the perimeter with a per-host consent cookie.

**OAuth consent phishing.** `onGatewayDomain` refuses client ids and redirect URIs only on the gateway host and its subdomains (`server/mcp-auth/own-domain.ts:25-35`). Once org apps move to a separate apps domain, an org app's public route can serve a Client ID Metadata Document. `global_fetch_strictly_public` routes that fetch through Cloudflare's front door, back to the gateway and on to the app (`security-model.md:226-233`). The client would then show as "verified" for a redirect on the same apps domain, and a member of another org consents to give "acme-helper.<apps domain>" their `/mcp` token. **Smallest change:** extend `onGatewayDomain` to the hosted apps domain, which is TODO.md:38 made concrete.

**Public-route surface and per-hostname limits.**
- Cap the route count and forbid a root-level single-segment parameter (`/:p`) below the Paid tier, at the hosted deploy API (manifest validation in hosted mode).
- Per-hostname rate limits: a gateway Rate Limiting binding keyed `pub:<workerName>:<ip or /64>` per location (10 or 60 s windows only, per location; Rate limit binding doc), plus an aggregate daily per-app budget in D1 counters. Enforce it in the perimeter before `getAppFetcher`, on `publicMatch.public` (`gateway.ts:234-238`). Zone WAF can't count by Host below Enterprise (§3.5).

**Abuse intake and content policy.**
- Publish an AUP (no phishing, malware, open proxies, mining, unlicensed resale of AI access, or spam relay), an abuse form or address, and response times.
- Keep 30-day per-app request metadata (not bodies) for investigations.
- Before GA, scan new public HTML for password inputs plus brand terms, and check app hosts against Safe Browsing.

---

## 4. Gaps and the smallest change that closes each

Sizes are engineer-days for one person working with agents. Each "Where" names the enforcement point.

| ID | Gap | Where | Smallest change | Days |
|---|---|---|---|---|
| S1 | Upload metadata can bind anything in the account | DEPLOY SERVICE (new) | `buildUserWorkerMetadata()` from the manifest. Allowlist: own `d1` ids, own DO classes without `script_name`, `plain_text`/`json` for identity keys and issuer, `secret_text`, `version_metadata`, and the gateway `service` binding built by us. Deny everything else, including `cache_options`, `exports[*].cache`, `tail_consumers`, `logpush` and `placement`. Set `limits` and `observability`. Then verify with `GET …/bindings`. | 2 |
| S2 | No CPU or subrequest caps on tenant code | DISPATCHER + DEPLOY SERVICE | `dispatcher.get(name, {props}, {limits})` per plan, plus script `limits` in metadata for DO, cron and queue | 0.5 |
| S3 | Egress uncontrolled; DO fetches bypass | OUTBOUND WORKER + DEPLOY SERVICE | Default-deny outbound with a per-app allowlist (manifest `egress`, approved by the org admin) passed as an outbound param. No DO, cron or queue below Paid. Spike cron and queue interception. | 1.5 |
| S4 | Workflows may not work on WfP | DEPLOY SERVICE | Refuse `resources.workflows` in hosted; 1-hour spike | 0.25 |
| S5 | Denial of wallet from DO duration, logs and storage | Poller (DEPLOY SERVICE cron) | GraphQL per-script usage → budget → auto-suspend; logs set by us | 2 |
| S6 | `getAppFetcher` can't dispatch | `packages/perimeter/src/getAppFetcher.ts:38-57` | `getAppFetcher(env, app, reqCtx)` returning `env.DISPATCHER.get(app.workerName, {props}, {limits, outbound})` | 0.5 |
| S7 | Build plane runs untrusted code | Hosted deploy API | Prebuilt bundles only in v1 | 0 |
| S8 | JWT `aud` collides across orgs; SDK doesn't check `org_id` | PERIMETER, BROKER, TOOLBUS, SDK | `aud = workerName` everywhere; `EVERYAPP_AUDIENCE` binding; SDK checks `org_id` | 0.75 |
| S9 | ToolBus validator cache poisoning | `packages/toolbus/src/execute.ts:283-286` | Key by `app.rowId` plus a gateway-computed hash | 0.25 |
| S10 | Public-marker cache shared across orgs | `packages/perimeter/src/gateway.ts:146` | Key by `workerName` (with S8) | 0.1 |
| S11 | Workers Caching could leak users' pages | DEPLOY SERVICE (+ DISPATCHER props later) | Force caching off; later put `{orgId, sub}` in dispatch props | 0.25 |
| S12 | KV 1,000-namespace ceiling; account quota exhaustion by sign-ups | Manifest validation (hosted), provisioning | No `resources.kv` in hosted (D1 or DO SQLite instead), lazy provisioning, caps on orgs and apps | 1 |
| S13 | Rate-limit namespace sharing (4180–4182) | DEPLOY SERVICE, `cloudflare.config.ts:141-152` | Deny `ratelimit` bindings; random high ids for the gateway | 0.1 |
| S14 | Caller props written by the org's own build | DISPATCHER props + DEPLOY SERVICE | Per-request `ctx.exports.AppGateway({props:{…, mode, sub}})` capability; upload-time `service` + props for background (spike) | 1.5 |
| S15 | Broker attribution from a replayable JWT; no mode | BROKER | Read `mode` and `sub` from capability props; JWT path for reads only | 0.5 |
| S18 | Providers self-granted | BROKER (`app-gateway-entrypoint.ts:114`) | `app_provider_grants` with admin approval and plan entitlement | 1.5 |
| S19 | No quotas, holds or concurrency caps; metering via logs | BROKER | Per-org ledger DO (hold → settle), per-app and per-mode caps, `max_tokens` clamp, D1 usage rows | 3 |
| S20 | Free LLM proxy through public routes | BROKER + DISPATCHER props | `mode=public` has no platform-paid providers by default | 0.25 (with S14) |
| S21 | Prompt injection burns credits through metered reads | TOOLBUS (`toolbus/policy.ts`) | `metered` annotation plus a per-connection daily budget | 1.5 |
| S22 | One shared provider key (shared fate) | BROKER | Per-org OpenRouter sub-keys with `limit` and `limit_reset`; disable on takedown | 1 |
| S23 | No store for gateway-held org secrets | Gateway D1 + KEK | Envelope encryption (per-org DEK, versioned KEK), rotation job | 2 |
| S24 | Platform CF token blast radius | DEPLOY SERVICE Worker (separate) | Separate Worker, minimal token (no Secrets Store Edit, no zone), binding verification, audit-log alerts | 1.5 |
| S25 | Invite-only sign-up; no bot defence | `auth/config.ts:360-366`, `auth/shared.ts:16`, `auth-rate-limit.ts` | Turnstile (captcha plugin), required verification, disposable block, /64 + ASN + global daily limits, server-side personal org | 2 |
| S26 | No capability tiers or free caps | Hosted deploy API + PERIMETER + BROKER | Free, Verified (card on file) and Paid caps for apps, deploys, routes, egress hosts, requests and credits | 2 |
| S27 | Disabling doesn't stop DO, cron or queue code, or open sockets | DEPLOY SERVICE | Takedown: disable, then a content stub, minimal limits, no crons, revoked grants, disabled sub-keys, audit | 1.5 |
| S28 | Strangers' HTML on our cookie domain | DNS/PSL + PERIMETER + auth | Interim: strip app `Set-Cookie`, interstitial, Verified-only custom code. GA: separate PSL-listed apps domain plus a per-host session handoff. | 0.5 interim / 4 GA |
| S29 | Public routes can cover almost everything; no per-host limits | Hosted manifest validation + PERIMETER (`gateway.ts:234`) | Route caps, no root `/:p` below Paid, `pub:<worker>:<ip>` limiter plus a per-app daily budget | 1 |
| S30 | No abuse intake or policy | everyapp.com, ops | AUP, report form, response SLA, 30-day metadata retention; scanning before GA | 1 (+3 GA) |
| S31 | OAuth "verified" clients on the apps domain | `server/mcp-auth/own-domain.ts:25-35` | Include the hosted apps domain in `onGatewayDomain` | 0.25 |

(S16 and S17 were folded into S14, S15 and S8.)

---

## 5. Concrete code shape of the main enforcement points

**Dispatcher call** (`getAppFetcher`, replacing `getAppFetcher.ts:52-56`):

```ts
const gateway = ctx.exports.AppGateway({
  props: { organizationId: app.organizationId, appId: app.appId,
           workerName: app.workerName, mode: reqCtx.mode, // "user" | "public" | "mcp"
           sub: reqCtx.sub ?? null, plan: reqCtx.plan },
});
return env.DISPATCHER.get(app.workerName,
  { props: { GATEWAY: gateway } },
  { limits: PLAN_LIMITS[reqCtx.plan],                       // { cpuMs, subRequests }
    outbound: { egress: { workerName: app.workerName, allow: app.egressAllow, plan: reqCtx.plan } } });
```

(Sources: custom limits, Apr 21 2026; dynamic dispatch, Sep 16 2026. The props and stub shapes are as documented. `PLAN_LIMITS` and `egressAllow` are ours.)

**Deploy service metadata** (the only writer of tenant scripts):

```ts
{ main_module, compatibility_date: pinned, compatibility_flags: ["nodejs_compat"],
  bindings: [ ...ownD1, ...ownDurableObjects /* no script_name */, identityKeys, issuer, audience,
              versionMetadata, gatewayServiceBinding /* built here, if the spike passes */ ],
  limits: { cpu_ms, subrequests }, observability: PLAN_OBSERVABILITY,
  tags: [`org:${orgId}`, `app:${appId}`, `plan:${plan}`] }   // ≤ 8 tags per script (WfP limits)
// then: GET …/scripts/{name}/bindings must deep-equal `bindings`, or delete + alert
```

---

## 6. Prioritized list

### Tier 0: must have before anyone but us uses it (design partners, invite-only, custom code by approval) · ~12 days

| # | Item | Gap | Enforcement point | Days |
|---|---|---|---|---|
| 0.1 | Deploy service as binding allowlist with post-upload verification; deny `ratelimit`, `secrets_store_secret`, `dispatch_namespace`, foreign DO and D1, `service` (except ours), mTLS, VPC, `ai`; caching off; logs set by us | S1, S11, S13 | DEPLOY SERVICE | 2 |
| 0.2 | Separate `deploy-service` Worker with a minimal token; gateway never holds it; audit-log alert | S24 | DEPLOY SERVICE | 1.5 |
| 0.3 | `getAppFetcher` dispatch with `limits` and `outbound`; script `limits` in metadata | S2, S6 | DISPATCHER, DEPLOY SERVICE | 1 |
| 0.4 | Outbound Worker default-deny with per-app allowlist; no DO, cron or queue for unapproved orgs; refuse Workflows; spikes on cron, queue and Workflows | S3, S4 | OUTBOUND WORKER, DEPLOY SERVICE | 1.5 |
| 0.5 | `aud = workerName`; SDK `org_id` check; marker cache key | S8, S10 | PERIMETER, BROKER, TOOLBUS, SDK | 0.75 |
| 0.6 | ToolBus validator cache key | S9 | TOOLBUS | 0.25 |
| 0.7 | Broker caller from a per-request capability (`mode`, `sub`); background binding spike | S14, S15, S20 | DISPATCHER props, BROKER | 1.5 |
| 0.8 | Broker hard ceilings: per-org OpenRouter sub-key with `limit`; per-app concurrency cap; `max_tokens` clamp; usage rows in D1, not logs | S19 (part), S22 | BROKER | 2 |
| 0.9 | Strip app `Set-Cookie` in hosted mode | S28 (interim) | PERIMETER (`headers.ts:179`) | 0.25 |
| 0.10 | Takedown v1 (disable, stub, limits, grants, sub-keys) | S27 | DEPLOY SERVICE | 1 |
| 0.11 | `onGatewayDomain` covers the apps domain | S31 | `mcp-auth/own-domain.ts` | 0.25 |

### Tier 1: before public sign-up · ~16 days

| # | Item | Gap | Enforcement point | Days |
|---|---|---|---|---|
| 1.1 | Turnstile (Better Auth captcha), required email verification, disposable-domain block, /64 + ASN + global daily sign-up limits | S25 | auth hooks, `auth-rate-limit.ts` | 2 |
| 1.2 | Server-side personal org; orgs-per-user cap; lazy provisioning; no hosted KV | S12, S25 | sign-up hook, DEPLOY SERVICE | 1.5 |
| 1.3 | Capability tiers (Free, Verified with card on file, Paid) and free-tier caps | S26 | hosted deploy API, PERIMETER, BROKER | 2 |
| 1.4 | Provider grants: admin approval plus plan entitlement | S18 | BROKER | 1.5 |
| 1.5 | Broker ledger: holds and settle, per-app and per-mode budgets | S19 | BROKER (per-org DO) | 2 |
| 1.6 | Usage poller with auto-suspend (CPU, requests, DO duration) | S5 | DEPLOY SERVICE cron | 2 |
| 1.7 | Metered-tool budgets per MCP connection | S21 | TOOLBUS | 1.5 |
| 1.8 | Public-route caps, per-host limiter, interstitial for new orgs, AUP and abuse form | S29, S28 (interim), S30 | PERIMETER, hosted manifest validation | 2 |
| 1.9 | Envelope encryption for gateway-held org secrets, with KEK rotation | S23 | gateway D1 | 2 |

### Tier 2: before GA · ~18 days

| # | Item | Gap | Enforcement point | Days |
|---|---|---|---|---|
| 2.1 | Separate registrable apps domain on the PSL; per-app-host session handoff (Access-style); keep catalog apps on the gateway domain if wanted | S28 | DNS/PSL, auth, PERIMETER | 4 (+ PSL lead time) |
| 2.2 | Close the DO egress gap: evaluate Dynamic Workers with `globalOutbound` and DO Facets, or keep DOs Paid-only with monitoring | S3 | runtime choice | 3 |
| 2.3 | Abuse ops: public-HTML scanning (password forms plus brand terms), Safe Browsing checks, appeal flow, 30-day metadata retention | S30 | ops, PERIMETER | 3 |
| 2.4 | Cross-tenant isolation test suite: two orgs with the same slug, poisoning attempts, binding-forgery uploads | all | CI | 2 |
| 2.5 | Account split review (control vs runtime), key-rotation drill, deploy-token rotation | S24 | Cloudflare accounts | 2 |
| 2.6 | Hosted build sandbox if "deploy from GitHub" ships | S7 | Sandbox | 3 |
| 2.7 | User-partitioned caching (props), if caching is offered | S11 | DISPATCHER | 0.5 |

---

## 7. Open questions only the founder can answer

1. **Can free or unverified orgs run custom code at all?**
   - Why it matters: custom code is the largest abuse surface (T1 to T7). Gating it on a card removes most of the drive-by abuse.
   - Default: no. Custom code needs a card on file (Verified). Free orgs get catalog apps only.
2. **A separate registrable domain for org apps, on the PSL?**
   - Why it matters: without it, org JavaScript can toss cookies onto the gateway, and phishing on one app damages the domain's reputation for everyone. With it, the one-cookie model ends for org apps, and the per-host session handoff costs about 4 days. PSL inclusion takes weeks.
   - Default: yes. The gateway on everyapp.com, org apps on a dedicated apps domain (name to pick), submitted to the PSL once chosen.
3. **Public routes for org apps: which tier, and how many?**
   - Why it matters: public routes are the phishing and LLMjacking path and the reason for interstitials.
   - Default: Verified and up, at most 5 routes, no root `/:p`, an interstitial for HTML for the first 14 days, and no platform-paid providers in public mode.
4. **Durable Objects, crons and queues in org apps despite the egress gap?**
   - Why it matters: their fetches aren't seen by the outbound Worker (DOs documented, cron and queue unknown), and DO wall-clock time is the main denial-of-wallet vector.
   - Default: Paid only, with monitoring. Evaluate Dynamic Workers before GA.
5. **Provider keys: one platform key, or a sub-key per org or per app?**
   - Why it matters: shared fate and hard ceilings. A per-org OpenRouter sub-key with `limit` caps the damage at the provider.
   - Default: a per-org OpenRouter sub-key. The OpenAI shared key only for catalog apps' built-in features.
6. **Who approves an app's provider access: the org admin alone, or us too?**
   - Why it matters: the org pays, so the admin's approval is normally enough. Platform review only makes sense for very expensive providers.
   - Default: the org admin approves, and the platform enforces plan entitlement and caps.
7. **Prepaid credits with holds, or postpaid overage for metered providers?**
   - Why it matters: postpaid invites stolen-card abuse and bills that never get paid.
   - Default: prepaid credits with holds (OpenSEO's model), and no overage on the Free or Verified tiers.
8. **Auto-suspend without a human?**
   - Why it matters: speed versus false positives on real customers.
   - Default: automatic for hard signals (spend over 10x the plan, a Safe Browsing hit, a confirmed phishing report); a human for content disputes; always notify the owner.
9. **One Cloudflare account, or a split between platform control and tenant runtime?**
   - Why it matters: no token scope covers only the namespace, and binding needs no permission on the bound resource. A split adds a cross-account hop, because the dispatcher must live with the namespace.
   - Default: one account through Tier 1, with a separate deploy-service token. Revisit at GA.
10. **"Deploy from a GitHub URL" in v1?**
    - Why it matters: it means running strangers' builds.
    - Default: no. Prebuilt bundles from the CLI or CI only.
11. **Log policy for tenant Workers.**
    - Why it matters: cost, the account-wide 5B-a-day cap, and tenant privacy.
    - Default: logs off or 1% sampled for Free and Verified; per-tenant Tail Workers later as a paid feature.

---

## 8. Load-bearing claims (if wrong, the design changes)

| # | Claim | Source | If wrong |
|---|---|---|---|
| C1 | Outbound Workers don't intercept `fetch()` from Durable Objects or mTLS bindings. `connect()` is disabled when one is set. No namespace-level outbound setting exists, so cron and queue invocations probably bypass it too (unverified). | outbound-workers (Apr 21 2026); namespace API schema (2026-10-15) | If DOs were covered, S3 shrinks to an allowlist. If crons and queues are covered, they can open to Verified orgs. |
| C2 | Capability stubs passed in dispatch props die with the request. Whether a WfP user Worker accepts an upload-time `service` binding with `props` to a non-namespaced Worker is unverified (the OpenAPI schema shows no `props`). | dynamic dispatch (Sep 16 2026); OpenAPI (2026-10-15) | If upload-time props are rejected, background broker calls need an HMAC app credential instead (weaker). |
| C3 | Deploying a Worker with bindings needs only Workers edit, not permission on the bound resources, and no token permission is scoped to WfP. So our deploy service is the only thing between a tenant and the gateway's D1. | Workers authorization (2026-09-15); API token permissions (Oct 12 2026) | If namespace-scoped tokens exist, S24 gets simpler and the account split matters less. |
| C4 | Workflows don't support WfP. | Workflows limits (Sep 21 2026), contradicted by WfP bindings (Sep 16 2026) | Hosted apps could keep #282's Workflows. |
| C5 | Rate-limit namespaces are account-wide across Workers. | Rate limit binding (Oct 12 2026) | S13 matters less. |
| C6 | Workers Caching keys on path, entrypoint, `ctx.props` and version, not identity headers, and a user Worker can turn it on through upload metadata. | Workers Cache and Cache keys (Oct 12 2026); OpenAPI `cache_options` | S11 can be dropped. |
| C7 | KV allows 1,000 namespaces per account; D1 allows 50,000 (raisable). | KV limits (Oct 8 2026); D1 limits (Apr 21 2026) | Per-app KV could return. |
| C8 | Workers Logs fall to a 1% sample account-wide after 5B logs a day. | Workers Logs (Oct 12 2026) | Logs could serve as a metering backup (still not recommended). |
| C9 | Secrets Store is in open beta, with one store and 100 secrets per account; binding a store secret needs Secrets Store Edit. | Secrets Store pages (Aug 14, Sep 25, Jun 29 2026) | It might hold per-org secrets; the "deploy token can't bind platform secrets" property depends on this. |
| C10 | OpenRouter sub-keys can carry `limit` and `limit_reset` and be disabled by API. | OpenRouter provisioning keys docs (read 2026-10-15) | Spend ceilings would live only in our ledger. |

---

## 9. Sources

Cloudflare (each page's "Last updated" date; all read 2026-10-15):
- WfP Outbound Workers, Apr 21 2026: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/
- WfP Custom limits, Apr 21 2026: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/
- WfP Dynamic dispatch (props, capabilities, outbound params), Sep 16 2026: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/
- WfP Bindings, Sep 16 2026: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/
- WfP Worker isolation, Apr 21 2026: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/
- WfP Limits, Oct 13 2026: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/
- WfP Pricing, Apr 21 2026: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/
- WfP Observability: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/observability/
- Cloudflare API (OpenAPI) for `PUT /accounts/{account_id}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}` metadata, and the namespace and settings endpoints, queried through the Cloudflare API MCP on 2026-10-15: https://developers.cloudflare.com/api/resources/workers_for_platforms/
- Workflows limits, Sep 21 2026: https://developers.cloudflare.com/workflows/reference/limits/
- Durable Objects limits, Jun 1 2026: https://developers.cloudflare.com/durable-objects/platform/limits/
- Durable Objects pricing, Sep 30 2026: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Durable Objects metrics, Oct 8 2026: https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/
- Workers limits, Oct 12 2026: https://developers.cloudflare.com/workers/platform/limits/
- Workers Cache, Oct 12 2026: https://developers.cloudflare.com/workers/cache/ and Cache keys: https://developers.cloudflare.com/workers/cache/cache-keys/
- Rate limit binding, Oct 12 2026: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Workers Logs, Oct 12 2026: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- KV limits, Oct 8 2026: https://developers.cloudflare.com/kv/platform/limits/
- D1 limits, Apr 21 2026: https://developers.cloudflare.com/d1/platform/limits/
- Secrets Store overview, Aug 14 2026: https://developers.cloudflare.com/secrets-store/; Manage secrets, Sep 25 2026: https://developers.cloudflare.com/secrets-store/manage-secrets/; Access control, Jun 29 2026: https://developers.cloudflare.com/secrets-store/access-control/; Workers integration, Oct 12 2026: https://developers.cloudflare.com/secrets-store/integrations/workers/
- Workers roles and permissions, 2026-09-15: https://developers.cloudflare.com/workers/authorization/workers/ and changelog https://developers.cloudflare.com/changelog/post/2026-09-15-granular-worker-permissions/
- API token permissions, Oct 12 2026: https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- Context API (`ctx.props` authenticity), Oct 12 2026: https://developers.cloudflare.com/workers/runtime-apis/context/
- WAF rate limiting rules, Aug 25 2026: https://developers.cloudflare.com/waf/rate-limiting-rules/
- Dynamic Workers egress control, Oct 12 2026: https://developers.cloudflare.com/dynamic-workers/usage/egress-control/; DO Facets, Oct 12 2026: https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/; Dynamic Workers pricing, Jun 11 2026: https://developers.cloudflare.com/dynamic-workers/pricing/
- Access authorization cookie, 2026-08-03: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/
- Developer Platform Service-Specific Terms, Sep 28 2026: https://www.cloudflare.com/service-specific-terms-developer-platform/
- Cloudflare abuse approach (trust hub, undated): https://www.cloudflare.com/trust-hub/abuse-approach/

Other:
- GitHub, "Yummy cookies across domains", 2013-04-09: https://github.blog/news-insights/yummy-cookies-across-domains/
- web.dev, "Understanding same-site and same-origin", 2020-04-15: https://web.dev/articles/same-site-same-origin
- Mozilla wiki, Public Suffix List uses (2015-10-01): https://wiki.mozilla.org/Public_Suffix_List/Uses; PSL submission: https://publicsuffix.org/submit/
- Better Auth captcha plugin (read 2026-10-15): https://www.better-auth.com/docs/plugins/captcha
- disposable-email-domains (pushed 2026-10-15): https://github.com/disposable-email-domains/disposable-email-domains
- ngrok abuse and interstitial (read 2026-10-15): https://ngrok.com/abuse and https://ngrok.com/docs/errors/err_ngrok_6024
- The Hacker News on Sysdig's LLMjacking, May 2024: https://thehackernews.com/2024/05/researchers-uncover-llmjacking-scheme.html
- CSA research note, "LLMjacking evolved", 2026-06-26: https://labs.cloudsecurityalliance.org/research/csa-research-note-llmjacking-evolved-offensive-agentic/
- OpenRouter provisioning API keys (read 2026-10-15): https://openrouter.ai/docs/features/provisioning-api-keys
- Stripe Checkout "Set up future payments" (read 2026-10-15): https://docs.stripe.com/payments/checkout/save-and-reuse

Internal:
- Prior research on branch `research/app-integrations`: `docs/research/2026-10-integrations-hub/app-integrations.md` and `raw/build-patterns.md` (§6 egress options, `ctx.props` authenticity, the lethal trifecta).
- OpenSEO billing holds: `/Users/bensenescu/workspaces/open-seo/src/server/billing/autumn.ts:58-69`.
