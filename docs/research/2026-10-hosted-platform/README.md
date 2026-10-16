# Hosted Every App: synthesis of the 2026-10-15 research round

> **Since 2026-10-16:** the plan the overnight build started from is
> [final-plan-2026-10-16.md](final-plan-2026-10-16.md); what was built, with
> every default taken without the founder, is
> [docs/hosted-platform-build.md](../../hosted-platform-build.md) (both on `main`).

## Decisions digest

One line per founder decision, with the default we take if you say nothing.
Answer in one message ("all defaults" is a valid answer); the full text of each
is in §4.

| # | Decision | Default |
|---|---|---|
| D1 | Control plane host, tenant content domain, PSL timing | `app.everyapp.com`; apps on a new dedicated domain (`everyapp.dev` until bought); PSL PR when the first outside org deploys |
| D2 | Catalog apps shared or per org; OpenSEO on day one; eager or lazy installs | Two tiers (shared `platform` for OpenSEO, per-org `dispatch` for the rest); dispatch catalog apps install lazily on first open with a warm D1 pool; OpenSEO joins in phase 2 as a second deployment for new sign-ups only |
| D3 | Who runs custom code, with which runtime features | Free = catalog only; Verified (card on file) = custom code, ≤3 apps, one DO class, no crons/queues; Paid = more DOs, gateway crons, BYO domains |
| D4 | Money model and plans | One org wallet, prepaid credits with holds, 1.28× per provider, "Every App Pro" $10/10k, Free 500 one-off credits after email verification; per-app caps enforced in `OrgWallet`, not Autumn |
| D5 | Autumn org, customer-id rule, cutover timing, sandbox safety | Reuse the live Autumn org; customer id = gateway `organizations.id`, always, never renamed; existing app.openseo.so customers move only in a later one-window cutover; no live provider keys while billing runs in the Autumn sandbox (invite-only until live Autumn) |
| D6 | LLM upstream and provider keys | OpenRouter only, per-org provisioning keys with `limit`; AI Gateway as backstop only; prompts never stored (requires AI Gateway payload logging off) |
| D7 | Cloudflare account(s) | New hosted-only account (prod) plus a second staging account; `everyapp.com` zone and OpenSEO prod move into the hosted account; D1 count → 250k and storage → 5 TB filed at creation; no KV request |
| D8 | Who approves capabilities | Catalog apps implicit; org apps and forks pending until an org admin approves (inline when the admin deploys); no platform review |
| D9 | Build plane | v1 prebuilt bundles from a laptop or a thin GitHub Action (needs the SDK and CLI on npm, D13); v2 Sandbox 1.0 builder with one platform GitHub App |
| D10 | Platform operations and abuse intake | `ops.everyapp.com` behind Access, no impersonation, auto-suspend on hard signals; `abuse@`, Turnstile form, `security.txt`, DMCA agent, NCMEC path |
| D11 | The agent | `EveryAgent` DO in the gateway per (org, user), metered as app `everyapp`; one connection per org as the v1 UX choice |
| D12 | Onboarding and org lifecycle | Invitees join only the inviting org; ≤3 owned orgs; hard email verification; 7-day deletion grace; export promise |
| D13 | Forks and publishing | Fork = new org app in the org's own repo seeded from a public per-app source mirror, zero grants; publish `@every-app/sdk` and an app-developer `everyapp` at 0.4.0 in lockstep via npm trusted publishing, timed with H12; self-host stays checkout-only |
| D14 | Per-host sessions on self-host too | Yes: one `__Host-` per-app-host session mechanism in both modes (the perimeter report dissented; a mode flag keeps the shared cookie on self-host if you prefer) |
| D15 | Email provider | Transactional on Cloudflare Email Sending from `noreply@mail.everyapp.com`; lifecycle on OpenSEO's Loops; human mail on Proton at the apex; tenants never get `send_email` |
| D16 | Legal, AUP and abuse documents | Agent adapts OpenSEO's Every App, Inc documents now; Ben approves and publishes before the first outside org; counsel reviews once before public sign-up; OpenRouter's written OK before org apps get metered AI |


### Founder answers so far (2026-10-15 and 2026-10-16)

- **D2, answered.** Two kinds of apps. *First-party* apps (OpenSEO, and
  by default the rest of our catalog) are deployed by us into our own
  Cloudflare account as ordinary Workers with normal observability, use
  Every App identity and org membership, and are **multi-tenant on the back
  end** (OpenSEO: one Postgres database, org-scoped authorization in the
  app). Customers never own or touch that infrastructure. *Third-party*
  apps are the only thing deployed to Workers for Platforms. This is the
  `platform` / `dispatch` split of §1 with the line drawn by trust, not by
  runtime features. **OpenSEO must work on day one.**
- **D5 and D7, narrowed.** `app.openseo.so` production is not moved,
  migrated or touched. The Every App version of OpenSEO is a **second,
  separate deployment** (its own database, its own customers). Phase 3
  (H35-H42, the cutover) is **dropped**; D7's "move OpenSEO prod into the
  hosted account" is dropped. Whether hosted gets a new account or lives in
  the existing one is still open.
- **D1, under discussion.** Ben asked why third-party apps need a second
  registrable domain rather than `*.everyapp.com`; answered in the thread
  (cookie tossing, cookie bombing and reputation isolation; first-party apps
  do not need it; `*.apps.everyapp.com` plus a PSL entry is the alternative).
- **D13, under discussion.** Ben did not find the fork question clear; it
  reduces to "third-party apps need the SDK and CLI back on npm, and may
  start from our catalog apps as templates".
- **2026-10-16, 07:02 UTC (thread "Port OpenSEO Auth to Every App").**
  "app.openseo.so will continue to operate as normal. On everyapp.com, we'll
  offer OpenSEO as one of the first-party apps. People will also be able to
  deploy forks of OpenSEO as third-party apps. This will likely mean 1-2 new
  AUTH_MODEs for OpenSEO; there may be slightly different logic for each.
  The first-party version will use 1 Postgres database; 3rd-party forks
  hosted on Workers for Platforms will use D1. Ideally the Google Client &
  Secret will be handled in the Gateway for both these new auth modes."
  The OpenSEO cutover (Phase 3) stays dropped; forks of OpenSEO are new
  third-party work, since H17b had marked OpenSEO not forkable onto the
  dispatch tier.
- **Still open:** D3, D4, D6, D8-D12, D14-D16 (defaults stand).

---

Chief-architect synthesis of the 14 round-1 reports under `raw/`
(perimeter-dispatch, broker, identity-orgs, deploy-pipeline, wfp-capabilities,
hostnames-certs-cookies, schema-tenancy, security-abuse-hosted,
ai-gateway-and-openrouter-metering, autumn-billing-platform,
build-and-deploy-from-github, comparables, mcp-toolbus-hosted, openseo-fit),
the independent verification pass (`raw/verification.md`), and the five
round-2 gap reports (`raw/r2-*.md`: forks and SDK publishing, unit economics
and tenant ceilings, the OpenSEO cutover, the hosted release pipeline and CLI
conflicts, email and legal), read against `BRIEF.md`. Code refs are to this
worktree (`e1d9d3c6`) unless a branch is named. PRs #286-#294 (the self-host
CLI redesign) are merged on `main` as of today; where a report cites "branch
06" or "the stack", that code is now on `main`.

**On verification.** 56 load-bearing claims from the round-1 reports were
each checked by one or two independent verifiers (a *docs* lens reading
primary sources, and for critical claims an *adversary* lens looking for the
qualification the claim omitted): 98 verdicts in `raw/verification.md`, 47
`confirmed`, 49 `partly`, 2 `refuted`. By claim: 20 confirmed by every
verifier, 35 qualified by at least one, 1 refuted (#13, "Workflows can be
defined and bound in WfP user Workers"). This synthesis was first written
without those verdicts and has been corrected against them; every corrected
statement carries `(verified #n)` or `(qualified #n)` pointing at the claim.
Status key used below: **verified** = every verifier confirmed it against a
dated doc or code; **qualified** = true with a qualification a verifier
found, stated inline; **refuted** = the claim as written is wrong and is
replaced; **unverified** = no verifier was assigned and no source settles it,
so a live check in §6 or `live-checks.md` must. Nothing below has been proven
in a live account yet.

## The three findings that matter most

1. **The hosted shape assumed by ADR-0001 §6 and the brief (every catalog app
   as a per-org Workers for Platforms user Worker) does not hold for OpenSEO
   and may not hold for any app with background work.** Workflow classes
   cannot be *defined* or hosted in a dispatch-namespace user Worker: the
   Workflows limits page (2026-09-21) says so, the Workflows control-plane
   API (`PUT /workflows/{name}`) has no namespace field, and a third-party
   measurement shows the PUT fails for a namespace script (verified #24,
   #29; the "can be defined" reading of the WfP bindings page is refuted
   #13). The two Cloudflare pages do not contradict each other, as the first
   draft of this synthesis said: the WfP bindings page (2026-09-16) lists
   Workflows as something a user Worker may *bind to*, and the dispatch
   upload schema's `workflow` binding has a `script_name` field, so a user
   Worker can plausibly bind to a Workflow hosted in one of our regular
   platform Workers (qualified #10, #16, #44; runtime leg unverified, live
   check R2). Cron Triggers are unsupported on dispatch scripts (Cloudflare
   staff on workers-sdk#13840, 2026-05-11; no `/schedules` endpoint; wrangler
   early-exits before `triggersDeploy`: verified #5, #15, #30). Queue
   consumers take only an account `script_name`; still inferred, not
   documented (qualified #49). OpenSEO uses two Workflows, a second Worker,
   crons, a DO, two KV namespaces, R2 and Hyperdrive. Five reports (wfp,
   schema, openseo-fit, broker, deploy) converge on two hosting tiers: shared
   platform Workers for the catalog SaaS apps we ship, and WfP user Workers
   for org apps and instance-per-org catalog apps. I agree. The cross-script
   Workflow binding, if it works, lets a per-org dispatch app *call*
   platform-hosted Workflow classes; it does not change the default (OpenSEO
   on the platform tier), because the class, its bindings and its instances
   live in our Worker, but it is an option for catalog apps with light
   background work.
2. **The app-to-broker transport in WfP is half settled and everything about
   background work depends on the other half.** The upload-time `service`
   binding with `entrypoint` *is* in the dispatch upload schema, and nothing
   in any WfP page says a user Worker may not bind an account Worker
   (verified #4, #12, #17, #28, #47, #53: every verifier agrees on this part).
   What no source documents is `props`: it appears in no Cloudflare OpenAPI
   schema for *any* upload path (including the regular one where it
   demonstrably works since wrangler 4.13.0), wrangler sends it on
   `--dispatch-namespace` uploads, and no WfP page mentions service bindings
   held by user Workers at all (qualified #4, #8, #12, #28, #47, #53). The
   live check R1 stands. The documented alternative, an RPC capability stub
   from `ctx.exports` in dispatch `props`, is request-scoped (verified #7,
   #9, #18, #48: it lives for the dispatch Worker's execution context,
   extended by `waitUntil` or a live WebSocket; a DO can `dup()` it while the
   connection is open, but alarms, crons and later requests cannot use it),
   and it needs the dispatch Worker on compat date ≥ 2025-11-17 or
   `enable_ctx_exports` (qualified #18, #48; the gateway pins 2025-09-02). So
   the background paths that would lose the broker if `props` fail are DO
   alarms only: Workflows and crons do not run in WfP, and queue consumers
   are unconfirmed (qualified #47, #49, #53). A half-day spike decides the
   shape of the deploy service, the SDK and the KV capability.
3. **The shared parent-domain session cookie is unsafe once strangers deploy
   apps, and the fix is architectural, not a hardening item.** Tenant
   JavaScript on a sibling subdomain can write `Domain=<base>` cookies (RFC
   6265 §4.1.2.3 and §5.3; the 2013 GitHub Pages move; verified #0). The
   mechanics in the first draft were wrong: Better Auth 1.7.7 does not read
   the session token through its own last-wins `parseCookies`; `getSession`
   reads it through better-call 1.4.0's `getSignedCookie`, whose parser keeps
   the **first** occurrence of a repeated cookie name, so with both cookies
   on `Path=/` the victim's older cookie is listed first (RFC 6265 §5.4) and
   wins (qualified #40, refuting the "last duplicate wins" clause). The
   attack still stands: §5.4 orders cookies by **path length first**, then
   creation time, so the attacker sets their cookie with a longer `Path`
   (e.g. `/api/auth`) and it sorts first on every request under that path,
   including `/api/auth/get-session`; first-wins then authenticates the
   victim as the attacker (verified #0, qualified #40). The result is a
   path-scoped fixation rather than "every app runs as the attacker", plus
   cookie-bombing of the whole brand domain past the 128 KB header cap.
   `docs/security-model.md:284-285` is wrong on this point (verified #0) and
   arch-v2's accepted risk #2 assumed an XSS'd app, not a hostile deployer.
   The fix (control plane on its own host with a host-only cookie, apps on a
   separate registrable domain submitted to the PSL, a per-host `__Host-`
   cookie minted by a silent redirect handoff) is about 3-5 engineer-days plus
   PSL lead time, and the gateway already has the OAuth server and one-time
   code handoff that arch-v2 said made per-app cookies too expensive. The
   ordering-agnostic mitigation (refuse a Cookie header that repeats the
   session cookie name, H4) holds under either parser; any fix that assumed
   last-wins would not.

---

## 1. The hosted end state, one screen

```
                                   INTERNET
                                      │
      ┌───────────────────────────────┼─────────────────────────────┬──────────────────────────┐
      │                               │                             │                          │
 everyapp.com                 app.everyapp.com          {app}-{orgKey}.<content domain>   ops.everyapp.com
 marketing Worker             CONTROL PLANE             APP HOSTS: one wildcard DNS +     Cloudflare Access +
 (apex Custom Domain)         sign-up/in · orgs ·       one route, Universal SSL,         OPS_EMAILS allowlist
                              billing · Admin→Apps ·    PSL-listed; per-host __Host-      bans · suspend · usage
                              /mcp + OAuth AS · /agents cookie set by a silent handoff    (no Better Auth admin
                              deploy API · device login · /app-session/start               role, no impersonation)
                                      │                             │
                                      ▼                             ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│  every-app-gateway   one public Worker · GATEWAY_DEPLOYMENT_MODE=hosted · platformPolicy(env)      │
│                                                                                                   │
│  PERIMETER   routeHost (classify before D1) → registry LRU → status gate → CSRF → app-host        │
│              session → strip trust headers → mint JWT (aud = workerName, chan) →                  │
│              getAppFetcher(env, app, reqCtx)                                      ← the one seam  │
│                                                                                                   │
│  BROKER      AppGateway entrypoint. Caller = upload-time props {org, app, worker} (background)    │
│              + per-request capability stub {mode, sub} (user traffic).                            │
│              packs: openrouter · openai · anthropic · dataforseo · github · kv · tools (later)     │
│              caller → grant (app_capability_grants) → pack policy → OrgWallet.reserve →           │
│              inject key → stream tap (head/tail cost) → OrgWallet.settle (waitUntil) → ledger     │
│                                                                                                   │
│  DURABLE OBJECTS   OrgWallet per org (snapshot · holds · usage_events · outbox → Autumn · caps)    │
│                    EveryAgent per (org, user): Think/AIChatAgent over the ToolBus, metered as app  │
│                    `everyapp`                                                                     │
│  TOOLBUS     one /mcp for all orgs · one OAuth resource · PATs · mcp_tool_calls audit per org      │
│  SCHEDULER   minute cron → app_schedules → dispatch /__everyapp/scheduled (JWT chan=cron)         │
│  OUTBOUND    named entrypoint: default-deny egress for org apps; always deny provider hosts       │
└──────┬──────────────────────────────────┬─────────────────────────────────────────────────────────┘
       │ service binding (props)          │ env.DISPATCHER.get(workerName, {props}, {limits, outbound})
       ▼                                  ▼
┌───────────────────────────┐  ┌─────────────────────────────────────────────────────────────────────┐
│ PLATFORM TIER             │  │ DISPATCH NAMESPACE  everyapp-prod (untrusted); staging in own acct  │
│ shared catalog Workers    │  │  every-acme-todo  every-acme-crm  every-beta-todo  every-beta-tool… │
│ we ship (tier='platform') │  │  org apps, forks, and instance-per-org catalog apps (todo, chef)    │
│ e.g. everyapp-cat-openseo │  │  bindings written ONLY by the deploy service: own D1, own DOs,     │
│ Workflows · crons · R2 ·  │  │  EVERY_APP_GATEWAY (props), identity keys, secrets, assets         │
│ Hyperdrive; org from the  │  │  never: KV, Workflows, crons, service/ratelimit/ai/dispatch_ns,    │
│ identity JWT; props       │  │  foreign DO/D1 ids; caching off; logs sampled                       │
│ {trust:"catalog"}         │  │  tags org-*/app-*/kind-*/plan-*  · limits {cpuMs, subRequests}     │
└───────────────────────────┘  └─────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐   ┌───────────────────────────────┐
│ every-app-deployer   private Worker; the only holder of the CF  │   │ MONEY                         │
│ API token (Workers Scripts Edit + D1 Edit; no Secrets Store,    │   │ Autumn = system of record     │
│ zone or routes). Called by the gateway over a service binding.  │   │ (plans, wallet, invoices,     │
│  AppDeployer DO per app: provision D1 (ledger first) → bookmark │◄──│ Stripe). Fed by OrgWallet     │
│  + migrate via REST → metadata FROM REGISTRY → PUT namespace    │   │ outbox, Idempotency-Key,      │
│  script → GET bindings must equal expected → apps row active    │   │ async:false, chunked $0.05    │
│  catalog_releases in R2 → install → upgrade fan-out (Queue,     │   │ Backstops: OpenRouter per-org │
│  canary waves) → uninstall by tag                               │   │ keys with limit · AI Gateway  │
│  takedown: disable → stub content → min limits → revoke grants  │   │ spend rules · daily reconcile │
└────────────────────────────────────────────────────────────────┘   └───────────────────────────────┘
   ▲ DeployBundle = tenant-neutral Build Output v0 + evaluated manifest + migrations (sha256, R2)
   │ producers: `everyapp deploy` (CLI; SDK + CLI from npm, D13) · every-app/deploy GitHub Action ·
   │ catalog CI · (v2) Sandbox builder from a connected GitHub repo. Producers run tenant code; the
   │ deployer never does. Control plane itself ships by hosted-release.yml (H27): build once,
   │ staging auto, production by manual promote.
```

Reading the picture:

- The gateway stays "one door" and the perimeter steps are unchanged; what
  changes is where the session lives (per host), what `aud` is, and that
  `getAppFetcher` gets a dispatch branch with per-request limits and outbound
  parameters.
- Two app tiers, not one. ADR-0001 §6's "single-tenant per org" survives for
  org apps and instance-per-org catalog apps; OpenSEO-type SaaS apps run as
  shared platform Workers because WfP cannot host their Workflows or crons.
- The broker is `AppGateway`, not an outbound Worker. Key injection, grants,
  holds and metering happen where caller identity already is. The outbound
  Worker is an egress firewall only.
- Money has one hot-path gate (the `OrgWallet` DO) and one record (Autumn).
  AI Gateway spend limits and OpenRouter per-key limits are ceilings that
  catch our own bugs, never the ledger.
- The Cloudflare API token never sits in the public gateway.

**Positioning: like Cloudflare OS, but easier.** Cloudflare OS (Apache-2.0,
v2 2026-08-05, managed version on a waitlist since 2026-10-01 with no price)
is the nearest shape: per-company instances where "gatekeeper" Workers hold
credentials and hand agents typed capabilities, every side effect is
mediated, and AI goes through one metered choke point (`raw/comparables.md`
§2). What we **keep** from it: "access to nothing" by default; credentials
held by a per-service broker, never by the app; typed capabilities instead of
raw keys; approval of side effects; AI through one metered gate; forks that
carry code but no data, credentials or grants. What we **make easier**: no
Cloudflare account to own (Cloudflare OS needs one per company, plus Access
setup, plus an OAuth client per gatekeeper, and its README says obtaining
those credentials is hard); sign up on everyapp.com and get an org;
platform-held provider keys, so there is no BYOK chore; catalog apps that
work on install. Where we **differ on purpose**: Every App apps are shared,
multi-user org apps (TanStack Start + D1, deployed from a repo), not a
per-user copy of an agent-built gadget; and outside agents reach them through
the gateway's one `/mcp`, which Cloudflare OS consumes but does not expose.
Cloudflare OS has no multi-tenant SaaS offering or published pricing today;
if that changes, the framing changes (R23).

---

## 2. What the code already gives us

Verdicts: **as-is** (reuse unchanged or with a flag), **refactor** (same
file, new shape), **new** (does not exist), **port** (exists elsewhere:
OpenSEO, PR #257, PR #281 POC).

| Component | Verdict | Where | Notes |
|---|---|---|---|
| **Perimeter core** (status gate, reserved paths, server-function guard, public routes, CSRF, header strip, CSP floor) | as-is | `packages/perimeter/src/gateway.ts:178-436`, `csrf.ts`, `publicRoutes.ts`, `headers.ts:44-59,178-255` | Per host, per request; already holds for N tenants. Add: `aud = workerName`, `authenticate(request, app)`, reserved `/__everyapp/session` and `/__everyapp/home`, CORS-credential strip, reserved-cookie strip. |
| Host routing | refactor | `apps/every-app-gateway/src/server.ts:166-240`, `server/app-hosts.ts` | Classify the host *before* the D1 lookup (`routeHost`); content domain decoupled from the gateway host; the no-`GATEWAY_URL` bootstrap and install-org short hosts are self-host only. |
| `getAppFetcher()` seam | refactor | `packages/perimeter/src/getAppFetcher.ts:38-57` | Add the `dispatch` branch: `env.DISPATCHER.get(workerName, {props}, {limits, outbound})`; "Worker not found" → `AppUnreachableError`. Route the three callers that bypass it (`toolbus/runtime.ts:84`, `toolbus/catalog-sync.ts:52`, `server/app-activation.ts`) through it. |
| Registry read model and rules | refactor | `packages/perimeter/src/registry.ts`, `registry/registration.ts` (now on main), `apps/every-app-gateway/src/perimeter/drizzleAppRegistry.ts` | Keep one `apps` table and `every-<orgKey>-<appId>` as the dispatch script name. Add `tier` as an input (`dispatch`, `platform`), `limits`, `source`/`catalog_app_id`, `disabled_reason`; `markDeployedUpdate` goes `pending → active` for dispatch. Drop `findByAppId` (global slug lookup). |
| Per-isolate caches | refactor | `server.ts:55-105`, `app-gateway-entrypoint.ts:208-228`, `orgContext.ts:41-75`, `gateway.ts:93-98` | Real LRU with hit/miss split and caps; public-marker cache keyed by `workerName`; add an app-access cache. |
| Manifest schema | refactor | `packages/perimeter/src/manifest/manifest.ts` | `providers` + `ai` + POC `integrations` → `capabilities` keyed by pack; `meters`/`billing.features`; `resources.r2`, `resources.browser`, `egress`; per-tier refusals (`kv`, `workflows` on dispatch). |
| **Broker caller identity** (`parseCallerProps`, `resolveCallerApp`, `resolveAttribution`) | as-is | `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts:72-140,160-260` | Already unforgeable in self-host; in hosted the deploy service must build the binding. Handler gains `waitUntil`, grants, billing, `mode`/`sub` from a capability stub. |
| AI proxy | refactor | `apps/every-app-gateway/src/server/ai-proxy.ts` | Generic proxy + provider packs (origin, credential, route policy, body rewrite, cost parser, hold estimate, hazards). `AI_PROXY_EXTRA_ROUTES` ignored in hosted. |
| Usage tap | refactor | `apps/every-app-gateway/src/server/ai-usage.ts` | Head + tail buffers, per-pack parsers (OpenRouter `cost`, Anthropic head, DataForSEO head), `cancel()` on abort, cached/reasoning tokens. |
| SDK gateway fetch | refactor | `packages/sdk/src/server/gatewayFetch.ts`; POC `packages/sdk/src/server/integrationFetch.ts` | One `brokerFetch({provider, request?, feature?})` taking real provider URLs, optional `request` (DOs, Workflows, crons), per-provider dev fallback. |
| `everyAppWorker()` | refactor | `packages/sdk/src/cloudflare/worker.ts:265-451` | Production build becomes tenant-neutral (placeholders, id-less D1/KV shapes, no gateway props, no identity values); `.everyapp/deploy.json` and `deployInputs.ts` are deleted, since a neutral build needs no inputs (H11). Self-host patches locally with `patchAppBuildOutput()`; the hosted deployer patches from the registry. |
| Build-output patching pattern | as-is | `packages/cli/src/lib/gateway/patchBuildOutput.ts` | The gateway release is already built once and patched per install; `patchAppBuildOutput()` is its sibling. |
| App policy check | port to perimeter | `packages/cli/src/lib/app/policy.ts:80-298` | Pure functions over JSON; add a hosted profile (no ids or gateway binding expected in the bundle). |
| Deploy pipeline steps | mixed | `packages/cli/src/commands/app/deploy/deployApp.ts` | Share: manifest/secret-name validation, version gates, registry rules, dropped-DO/Workflow checks, build. Replace: `cf` login, D1 lease, `cf d1 migrations`, `cf deploy`, gateway rebind, binding-activation poll. |
| Resource ownership ledger and `provisionOne` | port | `packages/cli/src/lib/app/ownership.ts`, `resources.ts:139-235` | Claim-before-create logic survives; transport becomes REST; hosted ledger gains `organization_id` and `cf_account_id`. |
| D1 migration bookkeeping | port | `packages/cli/src/lib/migrations/remote.ts`, `lib/cf/d1.ts:29-35` | cf's `d1_migrations` DDL and naming are reproducible over `POST /d1/database/{id}/query`; bookmarks over `GET .../time_travel/bookmark`. |
| Cloudflare REST transport | port from PR #257 | `claude/deploy-for-users:packages/deployer/src/api/{client,errors,assets,scripts}.ts`, parts of `resources.ts`, `d1sql.ts` | About 1,000 Worker-safe lines (429 backoff, assets session, multipart PUT). Drop `engine/*`, `node/*`, OAuth bootstrap. |
| Catalog publish pattern | port from PR #257 | `apps/deployer/scripts/publish-bundle.ts`, `src/manifest.ts` | Build in CI → R2 blobs + index → verify on load. |
| Device login and deploy keys | new wiring on existing pieces | Better Auth 1.7.7 `device-authorization` plugin (in `node_modules`); `apps/every-app-gateway/src/server/services/UserPatService.ts` | Deploy key = PAT with `appRowId` + `deploy` scope. `app_tokens`/`eak_` are deleted by the redesign. |
| **Org model** (Better Auth organization plugin, three roles, org-scoped repositories and middleware, switcher, invitations) | as-is | `auth/config.ts:307-343`, `server/org-roles.ts`, `middleware/auth.ts`, `services/InvitationService.ts`, `client/components/OrganizationSwitcher.tsx` | RFC-0001 Phase 1 items 1-3 and 5 (join, switch) are done. |
| Better Auth config | refactor | `apps/every-app-gateway/src/auth/config.ts` | Read a typed `platformPolicy(env)`: open sign-up, personal org in `session.create.before`, email verification, Turnstile (captcha plugin), social providers, host-only cookie, Access plugin off, `/admin/*` closed. |
| One-time-code handoff | as-is pattern | `apps/every-app-gateway/src/auth/cloudflare-access/mobile-sign-in.ts` | Same shape as the per-app-host session handoff. |
| Auto-accept pending invitations | refactor (move) | `auth/cloudflare-access/membership.ts:163-200` → `server/organization/` | Generalize off the Access plugin. |
| Setup claim, owner bootstrap, install organization, Access auto-join | as-is, self-host only | `services/SetupService.ts`, `organization/owner-membership.ts`, `db/owner-bootstrap.schema.ts`, `auth/cloudflare-access/membership.ts:207-284` | 404 / off in hosted via the policy module. |
| Membership and admin services | refactor | `services/MembershipService.ts:81-173`, `services/AdminService.ts:76-207` | In hosted, org admins remove members; they never ban, reset or delete accounts. Add leave, transfer ownership, delete my account. |
| Credential rate limits and cross-isolate budgets | as-is (reuse) | `server/auth-rate-limit.ts`, `db/rate-limit.schema.ts`, `mcp-auth/registration-limit.ts` | The D1-counter pattern is the one to reuse for sign-up and org-creation budgets. |
| Email transport | refactor (small) | `server/email/sendEmail.ts`, `services/InvitationService.ts:40-48`, `auth/config.ts:294-301` | Cloudflare Email Sending (public beta since 2026-04-16; needs Workers Paid; 3,000/month included, then $0.35/1,000; new accounts start on a "conservative" daily quota, R45) through the `send_email` binding; Docker self-host uses the REST endpoint with `EMAIL_REST_API_TOKEN`, which is a Cloudflare API token. Hosted adds escaped templates (the invitation email interpolates the org name and inviter email raw, and in hosted any stranger names an org: C11), invitation budgets, suppression-aware errors, and a Queue consumer for bounce and complaint events. Sender `noreply@mail.everyapp.com`. Lifecycle and founder sequences stay on Loops: Cloudflare's Email Service terms allow transactional mail only (D15; `raw/r2-email-and-legal.md`). |
| **D1 schema**: `apps`, `user_app_access`, `user_access_tokens`, `organization_keys`, `app_tool_catalogs`, `app_tools`, `mcp_connections`, `mcp_tool_calls` | as-is (+columns) | `apps/every-app-gateway/src/db/*.schema.ts` | Org scoping is sound: composite FKs `(app_row_id, organization_id)` reject cross-org children. Add `organization_id` to `mcp_connection_apps`, unique `(organization_id, user_id)` on `members`, `apps` columns and a partial unique on `worker_name` excluding `tier='platform'`. |
| New hosted tables | new | `src/db/hosted/*.schema.ts` (proposed) | `organization_platform`, `platform_operators`, `audit_events`, `catalog_apps`, `app_versions`, `deploy_jobs`, `app_resources`, `app_capability_grants`, `organization_data_keys`, `app_secrets`, `billing_customers`, `usage_daily`, `app_schedules`, `app_host_sessions`. Created empty in self-host; one baseline (PR #286 rule). |
| **MCP/OAuth**: consent picks an org, token props carry org, per-request re-check, catalog filtered by org and access | as-is | `server/mcp-auth/{consent,authorize,validate}.ts`, `repositories/AppToolRepository.ts:177-286` | One AS and one resource serve every org. |
| Own-domain refusal | refactor | `server/mcp-auth/own-domain.ts:25-35` | Becomes `onPlatformDomain()`: issuer ∪ content domain ∪ preview domains; BYO custom domains allowed. |
| Connection supersede | refactor | `repositories/McpConnectionRepository.ts:106-136`, `services/McpConnectionService.ts:199-241` | Add the org to both predicates; flip the test at `gateway-mcp.e2e.sqlite.test.ts:2156-2215`. |
| DCR budget | refactor | `server/mcp-auth/registration-limit.ts:26-30` | Env-configurable; hosted defaults ~20k/day global, 20/address. |
| ToolBus runtime and `executeToolCall` | as-is (+agent credential) | `server/toolbus/runtime.ts`, `packages/toolbus/src/execute.ts` | Fix the validator cache key (`execute.ts:283-286`) to use the registry row id. `auditToolCall` is the metering hook point. |
| In-gateway agent | new (template exists) | none; template `open-seo/src/server/features/sam/SamChatAgent.ts` | `EveryAgent extends Think` DO per `(org, user)` over `listTools`/`executeToolCall` in-process. |
| **Billing**: Autumn client, svix webhook, status mirror, lifecycle emails, billing UI, `creditsForProviderUsd` | port from OpenSEO | `open-seo/src/server/billing/*`, `src/client/features/billing/*`, `src/routes/_app/billing*.tsx`, `src/shared/billing.ts:17-18,61-70` | The gateway UI is on OpenSEO's design system since #283, so components move with little restyling. |
| Wallet / ledger | new | `apps/every-app-gateway/src/server/billing/org-wallet.ts` (proposed) | Per-org SQLite DO: snapshot, holds, `usage_events`, outbox → Autumn with `Idempotency-Key`, alarm flush and reconcile, per-app caps. Three reports designed the same object under three names (`OrgMeter`, `OrgWallet`, `Wallet`); I use `OrgWallet`. |
| DataForSEO metering seam | keep in app; transport swap | `open-seo/src/server/lib/dataforseo/{client,core,envelope,pricing}.ts` | `pricing.ts` becomes the hold hint; holds, settles, markup and keys move to the gateway pack. The 23 feature files that call the client do not change. |
| GitHub integration POC | port (rebase as a pack) | branch `poc/github-integration`: `integrations.schema.ts:88-115`, `integrations/{grants,proxy,crypto}.ts` | Grant math and proxy pipeline generalize; key grants by `app_row_id` not slug; replace HKDF-from-`BETTER_AUTH_SECRET` with envelope encryption. |
| Gateway Worker config | refactor | `apps/every-app-gateway/cloudflare.config.ts` | One build for both modes (`cf` refuses `--mode` for TanStack Start, `build-release.ts:286`): DO bindings (`OrgWallet`, `EveryAgent`; `AppDeployer` lives in the deployer Worker), compat date ≥ 2025-11-17 for `ctx.exports` (qualified #18, #48) and the `AI` binding go in `cloudflare.config.ts`; the hosted-only parts (`DISPATCHER` + outbound entrypoint, minute cron, wildcard route, control-plane Custom Domain, `GATEWAY_DEPLOYMENT_MODE=hosted` as a release-patched text binding) are the H27 patch profile (`raw/r2-hosted-release-and-cli-conflicts.md`). Note: any Worker in the account with an `ai` binding is pre-authenticated for every AI Gateway in the account (verified #35), so only the gateway gets one. |

---

## 3. Gaps and things not yet considered

Ranked by how much each changes the architecture. "Size" is engineer-days for
one person working with agents, from the reports. "Verdict" marks where a
prior design doc was wrong or where current Cloudflare reality changed the
answer.

### Tier A: these change the shape of the system

**A1. Workflow classes, crons and queue consumers do not run in WfP user
Workers; a user Worker may still bind to a platform-hosted Workflow.**
Verdict: Workflows **verified** unsupported as *definitions* (limits page
2026-09-21; `PUT /workflows/{name}` takes only `script_name`/`class_name`
with no namespace field; wrangler early-exits before registering them;
third-party measurement 2026-09-27 shows the PUT returns 500 for a namespace
script: #24, #29, #13 refuted as "can be defined"). The WfP bindings page
(2026-09-16) does not contradict this: it lists a Workflow *binding*, and the
dispatch upload schema's `workflow` binding has `script_name` ("Script name
that contains the Workflow"), so a user Worker can plausibly call a Workflow
hosted in one of our regular platform Workers (qualified #10, #16, #44;
runtime leg unverified, R2). Crons **verified** unsupported (staff reply
2026-05-11, wrangler skips `triggersDeploy`, no `/schedules` under dispatch
scripts: #5, #15, #30; the promised wrangler warning, PR #13966, was closed
unmerged, so crons are still silently dropped). Queue consumers inferred
unsupported (consumer API takes `script_name` only; qualified #49, still
inferred). The repo shipped app Workflows (#282) and app crons after the
hosted sketch was written. ADR-0001 §6 and the brief's "each catalog app on
WfP per org" cannot hold for OpenSEO.
Smallest change: two tiers. `tier='platform'` shared catalog Workers on the
existing service-binding path for apps that need Workflows/crons/queues (org
from the identity JWT, `trust:"catalog"` props, install-scoped background
grants); `tier='dispatch'` for everything else; the hosted validator refuses
`resources.workflows` on dispatch; a gateway-driven scheduler for crons (A6).
Size: decision + ~1.5 d wiring + 2 d scheduler. If the cross-script Workflow
binding works in WfP (R2), a dispatch app can call platform-hosted Workflow
classes; that does not move OpenSEO off the platform tier (its classes,
bindings and instances would still live in our Worker, and the account-wide
Workflow names, the 100 Workflow `schedules` per account and per-org data
migration still favor shared), but it is an option for catalog apps with
light background work. The first draft's "500-script count" argument is
withdrawn: WfP user scripts are unlimited ($0.02 per script per month after
1,000; `raw/r2-unit-economics-and-limits.md`); the 500 cap binds only regular
Workers and the scripts that hold Workflows.

**A2. How a user Worker reaches the broker.** Verdict: half **verified**,
half **unverified** (critical in seven reports). Option A (upload-time
`service` binding with `props`) is what the SDK builds and what DO alarms
need. The `service` binding with `entrypoint` is in the dispatch upload
schema, its target is named as a bare account Worker (no namespace
qualifier, unlike the DO binding's `dispatch_namespace`), and nothing in any
WfP page says a user Worker may not bind an account Worker (verified by
every verifier on #4, #12, #17, #28, #47, #53). `props` is undocumented for
*every* upload path, including the regular one where it demonstrably works
since wrangler 4.13.0, so the OpenAPI's silence is spec lag, not evidence
against; wrangler sends `...(props && { props })` on `--dispatch-namespace`
uploads; the WfP bindings page never mentions service bindings held by user
Workers (qualified #4, #8, #12, #28, #47, #53). The live check R1 stands.
Option B (per-request `ctx.exports.AppGateway({props})` stub in dispatch
`props`) is documented and gives verified per-request `mode` and `sub`, but
is request-scoped: it lives for the dispatch Worker's execution context
(extended by `waitUntil` or a live WebSocket, and a DO may `dup()` it while
the connection is open), and cannot be used by alarms, crons or later
requests (verified #7, #9, #18, #48). It needs the dispatch Worker on compat
date ≥ 2025-11-17 or `enable_ctx_exports` (qualified #18, #48; the gateway
pins 2025-09-02, so H10 bumps it), and props may carry only
structured-cloneable values and Service Binding stubs. The user Worker
cannot read the stub's own bound props, only call the methods `AppGateway`
declares (verified #48), so no method on `AppGateway` may echo `ctx.props`.
Option C (per-app HMAC/bearer secret) is the weak fallback.
Smallest change: a half-day spike (upload a one-line user Worker with
`{type:"service", service:"every-app-gateway", entrypoint:"AppGateway",
props:{x:1}}`, echo `ctx.props`). Design for A + B together: A for background
work, B for user traffic. If A fails: B for requests, C for DO alarms (the
only background path that exists in WfP: Workflows and crons do not run
there and queue consumers are unconfirmed, qualified #47, #49, #53), and the
brokered-KV capability falls back to a DO-backed SDK shim. Size: 0.5 d
spike; 1.5 d to wire B into `getAppFetcher` and `brokerFetch`; +2 d if C is
needed. Prior doc wrong: arch-v2 (`recommendation.md:51,73`, `overview.md:46-56`)
put key injection and metering in the **outbound Worker**; outbound Workers do
not see DO or mTLS-binding fetches (verified #7, #31, #52, 2026-04-21),
disable `connect()` in user Workers, get no caller context outside
dispatched requests, and have no manifest context. The broker stays on
`AppGateway`; the outbound Worker is an egress firewall. Security
precondition: props are trustworthy only because the deploy service builds
the user Worker's bindings; apps must never supply their own `services`
entries (qualified #53).

**A3. Domains, certificates and the session cookie.** Verdict: **verified**
for the cookie-write rule (RFC 6265 §4.1.2.3/§5.3, MDN, the 2013 GitHub
Pages move: #0), the 100 Custom Domains per zone cap with no documented
increase path (#1), Universal SSL covering one wildcard level on a Free
full-setup zone whose apex is the content domain (#41: ECDSA-only cert,
multi-label hosts would still reach the gateway but fail TLS, the apex needs
its own route), Cloudflare for SaaS plans (wildcard custom hostnames
Enterprise-only, 100 included then $0.10 each to 50,000: #42), PSL private
section (no SLA, no expediting, 2+ years of registration, small projects
"quite likely to be declined": #3, #43). **Qualified** on the parser: Better
Auth 1.7.7's own `cookie-utils.mjs:157-168` is last-wins but is not on the
`getSession` path; the session token is read via better-call 1.4.0's
`parseCookies`, which is **first**-wins (`if (!cookies.has(key))`), so the
attacker's cookie must sort first, which it does with a longer `Path` (RFC
6265 §5.4 orders by path length, then creation time) (#40). The session
fixation attack is derived, not reproduced (live check R6 now reproduces the
longer-Path variant). Prior docs wrong: `security-model.md:284-285` ("apps
cannot set parent-domain cookies") is false for client-side JS (verified
#0); arch-v2 §2.6 proposed `{app}-{tenant}.everyapp.host` but never placed
the control plane, so it implicitly needs a handoff; `recommendation.md:96`'s
reason for rejecting per-app cookies ("a hand-rolled OAuth AS") is paid for;
`overview.md:161-163`'s accepted risk assumed an XSS'd app at consumer scale.
Also: the redesign deleted wildcard routing for self-host (#289); hosted
needs it back, which is fine because the hosted gateway has its own pipeline
(H27).
Smallest change: scheme C. Control plane `app.everyapp.com` with a host-only
cookie; apps `{app}-{orgKey}.<content domain>` on a separate zone (`* AAAA
100::` proxied, Universal SSL wildcard, one `*.<domain>/*` route; app ids and
org keys must never contain a dot); per-host `__Host-everyapp_s` cookie via
`/app-session/start` → 60 s single-use code → `/__everyapp/session`, with an
`app_host_sessions` table cascading from Better Auth `sessions`; `return_to`
validated against the registry; CORS credentials and reserved cookie names
stripped; duplicate session cookie → 401 (ordering-agnostic, so it holds
under either parser); `onGatewayDomain` extended to the content domain; PSL
submission early. Catalog apps with third-party OAuth (OpenSEO's GSC/GA)
keep one fixed callback host (`app.openseo.so`) that relays to the org host,
because Google requires exact, wildcard-free redirect URIs
(`raw/r2-openseo-cutover.md` §2.5).
Size: 3 d handoff, ~5 d for the layer, plus PSL lead time (weeks to months, no
SLA, may be declined at prototype scale; C is safe without it except for
same-site GET riding and cookie bombing confined to the content domain).

**A4. The deploy service must be the binding allowlist and must not live in
the public gateway.** Verdict: **verified** for D1, KV, R2, DO and service
bindings (Workers authorization 2026-09-15: deploying bindings needs only
Editor on the Worker, no permission on the bound resource; API token
permissions 2026-10-12: nothing is scoped to WfP or a namespace, and the
namespace endpoints simply require Workers Scripts Write; the dispatch
upload schema accepts ~37 binding types including `dispatch_namespace`,
`durable_object_namespace` with `script_name`, `d1`/`kv`/`r2` by id,
`secrets_store_secret`, `ratelimit`, `service`, `mtls_certificate`, `ai`,
`vpc_*`: #54). **Qualified**: Secrets Store bindings are a
Cloudflare-enforced exception (the token needs Account Secrets Store Edit
*and* the secret's scope list must include `workers`), so for gateway
secrets Cloudflare provides a second control; the per-Worker "Specified
Workers" token scope (2026-09-15) does not help (it still permits binding any
D1 in the account and cannot create Workers, which needs product-level
Admin) (#54). Today the only binding allowlist is client-side in the CLI
(`packages/cli/src/lib/app/policy.ts`), which a hosted tenant could bypass
(#54). Concrete cases: a tenant binding `ratelimit` namespace `4182` can lock
victims out of password sign-in (rate-limit counters are account-shared);
a tenant with an `ai` binding is pre-authenticated for every AI Gateway in
the account and can spend its Unified Billing credits or `default`-alias
BYOK key (verified #35), so tenants never get `ai`. Prior docs disagree with
each other: `overview.md:372` puts the CF token in the gateway,
`recommendation.md:108` wants an isolated deploy service. I side with the
isolated service; the public gateway parses hostile traffic from every
tenant.
Smallest change: `every-app-deployer` Worker (no routes) with a minimal token
(account-wide by necessity; whether creating dispatch scripts needs
product-level Workers Admin, which would let that token overwrite the
gateway, is R43); the gateway calls it over a service binding with props; it
builds metadata from the manifest and registry only (own D1 ids, own DO
classes without `script_name`, identity text bindings, `secret_text`,
`version_metadata`, the gateway `service` binding if A2 passes), sets
`limits`, `observability` and `tags`, forces caching off, then `GET
.../bindings` must deep-equal the expected set or the script is deleted
(note: `GET /bindings` does not echo `props`, so the service binding's props
cannot be verified after the fact, qualified #12; the deployer must include
them exactly as wrangler does). The deployer also owns the Cloudflare API
budget (`CfApiBudget`, C10). Size: 2 d allowlist + 1.5 d separate Worker +
1 d takedown + 1 d budget governor.

**A5. Money: the hot-path gate is a per-org Durable Object, Autumn is the
record, and AI Gateway cannot be the cap.** Verdict: **verified** from AI
Gateway spend-limit docs (2026-09-30: 20 rules per gateway, `maxItems: 20`
in the API; partition by metadata gives each value its own bucket with ONE
shared `limit` amount applied per bucket, so a different cap for one org
costs a `filter` rule and one of the 20 slots; check before, record after,
eventually consistent; cost recorded only for models with known pricing
whose responses carry token usage, so an unpriced model is effectively
unmetered; partition keys must fit the 5-custom-metadata-entries cap: #32,
#50), AI Gateway limits (Unified Billing 200 req/60 s per gateway, 429
beyond; BYOK exempt only when the key sits under the `default` alias or
`byok_only` is on; Workers AI frontier models add a 50 req/min per-account
per-model cap; the increase path is a generic form with no commitment: #33),
Autumn docs and server source (`track` async by default on API 2.5.0 with
202 and `balance: null`; `async:false` returns the post-deduction balance,
null when tracking by `event_name` across features: #38; `Idempotency-Key`
honored on every route, 409 `duplicate_idempotency_key` on replay, non-409
4xx/5xx releases the key best-effort, TTL 24 h by default and
org-configurable 1 h-30 d, 30 min for Atom-forwarded requests, dedup fails
open when Autumn's DynamoDB is unavailable: #27, #37; locks ≤ 24 h; "other
endpoints" 25 req/s per org), OpenSEO's two incidents (2026-07-06 hot-path
retries, 2026-07-20 stale balance). **Qualified** on per-app caps: an
entity-level `usage_limits` entry caps that entity's draw for `check` and
for `track` with the default `overage_behavior: cap`, but **not** for
`track` with `overage_behavior: "overflow"`, which the outbox uses;
overflow bypasses usage-window caps and only spend limits clamp (#36). So
per-app caps must be enforced in the `OrgWallet` DO (already the design) and
the H13 outbox must not rely on entity limits; a `month` window is also
anchored to the customer's billing cycle and restarts on a plan change
unless `anchor: "utc"` is set (#36). **Qualified** on payouts: Autumn has no
first-class revenue share, but `attach.checkout_session_params` and
`updateSubscription.subscription_params` pass `application_fee_percent`,
`transfer_data` and `on_behalf_of` through to Stripe, so Stripe Connect
destination charges with a platform fee can be driven from Autumn on our one
org; Autumn's Platform API (private preview) would instead make each
developer the merchant of record (#39). Prior docs wrong: arch-v2 "per-app
spend metering" in the outbound Worker; `recommendation.md:73` "metering via
per-script GraphQL analytics + tags" (GraphQL has no tag dimension, is
adaptive/sampled, is capped at 300 queries / 5 min on top of the API budget,
and cannot bill one request; fine for compute attribution only); TODO.md "AI
Gateway routing" as a limiter.
Smallest change: `OrgWallet` DO (snapshot, holds, `usage_events`, outbox →
Autumn `balances.track` with `Idempotency-Key`, `async:false`,
`overage_behavior: overflow`, $0.05 chunks; refresh via webhook and alarm;
refresh-before-refuse only; two pools, `usage_credits` then `topup_credits`,
tracked by credit-system id until no customer holds `topup_credits`, D5).
Reserve before upstream, settle in `waitUntil` from the stream tap.
`NoopBillingPort` in self-host. Backstops: AI Gateway rules partitioned by
`{org, app}`, per-org OpenRouter keys with `limit` and `limit_reset`
(verified #51: server-enforced, 402/403 `openrouter_key_limit`, per-key
`usage`/`usage_daily`). Daily reconciliation against GraphQL and OpenRouter
per-key usage. Size: 3 d DO + 1 d Autumn client/webhook + 1 d meter hook +
1 d price catalog.

**A6. Crons for dispatch apps must be driven by the gateway.** Follows from
A1. Smallest change: `app_schedules` written at deploy from the manifest; the
gateway's `scheduled` runs every minute, fans out over `getAppFetcher` to
`POST /__everyapp/scheduled` with a gateway JWT `chan=cron`; the SDK maps it
to the app's `scheduled()`. Gives cron work per-request limits and outbound
parameters for free. Size: 2 d. Alternative noted by wfp: DO alarms.

### Tier B: these change the data model or the trust model

**B1. Per-app KV cannot scale.** Verdict: **verified** (KV limits
2026-10-08: 1,000 namespaces per account on Free *and* Paid, unchanged since
January 2025, so upgrading the plan buys nothing: #14, #19). **Qualified**:
"raisable" for KV is not documented; the page offers only the generic Limit
Increase Request Form ("if the limit can be increased"), whereas D1's 50,000
databases and 1 TB per account are explicitly raisable on Paid/Enterprise
"to millions", and D1's 10 GB per database "cannot be further increased"
(#14, #19, #21). Each D1 database is single-threaded; read replication
spreads reads across per-region replicas but writes still serialize on the
primary, and a Worker can bind at most ~5,000 D1 databases (#19). Prior doc
wrong: `recommendation.md:73` "per-tenant D1/KV attached in upload
metadata". No catalog app reads its declared `KV` binding (grep: zero hits).
Smallest change: delete `kv: ["KV"]` from todo/chef/workout/template; hosted
validator refuses `resources.kv`; later a brokered KV capability over a
prefixed pool (depends on A2) or a DO-backed shim. Size: 0.5 d now; 2 d
capability later. With KV gone, no KV increase is filed at all (D7).

**B2. Identity JWT `aud` is the bare app slug, which repeats across orgs; the
SDK never checks `org_id`.** Verdict: `verified` in code (`gateway.ts:153,327`,
`toolbus/execute.ts:219`, `catalog.ts:243`, `app-gateway-entrypoint.ts:244`,
SDK `everyApp.ts:117-130`; `EVERY_APP_ORG_ID` is bound and unused). Prior doc
wrong: `recommendation.md:73` promised `aud = t_<tenant>_<app>`; RFC-0001:58
promised an org-claim check; neither was built. Reports split between
`aud = workerName` (perimeter, wfp, security, mcp) and `aud = apps.id`
(schema). I take `workerName`: it is already globally unique, it equals the
dispatch script name, and the dispatch branch can re-check it with
`isRegistryWorkerName`. For shared platform Workers the SDK additionally pins
`org_id` to the install table. Smallest change: mint and verify `workerName`
everywhere, new `EVERYAPP_AUDIENCE` text binding, SDK `org_id ===
EVERY_APP_ORG_ID` when set, public-marker cache keyed by `workerName`. Size:
0.75-1 d. Useful on self-host too.

**B3. Grants are self-approved.** The manifest's `providers` list *is* the
grant (`app-gateway-entrypoint.ts:114`); ToolBus trusts the app's own risk
labels (`toolbus/policy.ts:1-3`, contradicting `overview.md:88-91,206-207`).
Every comparable with third-party apps keeps the approved grant apart from
the request (Slack, GitHub Apps, Shopify, Claude connectors). Smallest change:
`app_capability_grants` keyed by `app_row_id` (generalizing the POC's
`app_integration_grants`), `syncAppRequests` at `markDeployed`, implicit
grants for catalog apps, broader → pending while the old grant keeps serving,
narrower → immediate, org-policy ceilings that only tighten (including tool
risk overrides), typed errors with fix URLs. Size: 3 d + 1-2 d tool overrides.

**B4. Five places assume one gateway = one customer.** Global
`hasAnyOwnerMembership()`, the `owner_bootstrap` singleton, the "install
organization" with bare `<app>.<base>` hosts (namespace grab in hosted), Access
auto-join into "the owner's org", and org admins banning/deleting accounts
that span orgs (`UserRepository.deactivate`, `AdminService.deleteUser`). Plus
the perimeter gates app access on the session's *active* org, so a user in a
personal org and an invited org gets 403 or a sign-in loop
(`betterAuthAuthenticator.ts:136`, `orgContext.ts:94-98`). Smallest change:
`platformPolicy(env)` with ~15 call sites; hosted passes
`isInstallOrganization:false`; resolve membership in the *app's* org on app
hosts (`authenticate(request, app)`); last-active org for the control plane;
account powers split from org powers. Size: 0.75 d policy + 1 d org-from-host
+ 1 d hosted-off switches + 1.5 d power split.

**B5. Nothing lets a stranger in.** Invite-only sign-up, no email
verification, no Turnstile, no org creation, no personal org. RFC-0001:31
specified the personal-org flow; it was not built. Smallest change: open
sign-up when policy allows; in `session.create.before` accept pending
invitations first, else create a personal org (slug + random suffix) in one
`db.batch`; `requireEmailVerification: true` in hosted; Better Auth captcha
plugin (Turnstile); disposable-domain block; `/64` + ASN + global daily
budgets in `rate_limit_counters`; `createOrganization` server fn with an org
limit; leave/transfer/delete-my-account; random-suffix org keys (the 50-attempt
rule exhausts at 50 orgs named "Ben"). Size: ~8 d across identity gaps
G2-G6, G9, G13.

**B6. Builds bake the tenant in; the hosted sketch uploads source with a
retired token.** `everyAppWorker()` writes org id, identity keys, D1/KV ids
and the gateway props into `worker.config.json` `env` from
`.everyapp/deploy.json`. Prior doc wrong: `overview.md` §5 uses `eak_` tokens
(retired by ADR-0003) and "code + manifest" (the platform must never run
tenant TypeScript); `recommendation.md` §2.5 "Wrangler stays" predates the
move to `cf` (#271). Smallest change: tenant-neutral production build
(placeholders, id-less shapes), `patchAppBuildOutput()` for self-host, the
deployer patches from the registry in hosted; `everyapp bundle` emitting
`bundle.json` + `output/v0` + `migrations/`; policy moved to perimeter. One
catalog build then deploys to N orgs unchanged. Size: 2 d + 1 d + 1-2 d.

**B7. Org deletion cascades away the tombstones; no export; derived keys
cannot be crypto-shredded.** `organization_keys` and `apps` rows cascade on
org delete, freeing `every-<orgKey>-*` names for the next org that derives the
same key; D1 Time Travel keeps 30 days regardless (`verified`, 2026-04-21);
the POC's HKDF-from-`BETTER_AUTH_SECRET` cannot be destroyed. Smallest change:
soft-delete with a grace period on `organization_platform`; purge driven by
`app_resources` (bulk delete scripts by tag with `force`, D1 by UUID, R2
lifecycle then delete, KV prefix); per-org random DEK wrapped by a versioned
KEK, deleted at purge; tombstones kept forever; `onOrgDeleted`/`exportOrg`
hooks for shared catalog apps. Size: 4 d + 2 d envelope encryption.

**B8. OpenSEO is a two-Worker app.** The audit Workflow and DO live in
`open-seo-audit` (split for OOM), bound cross-script. The manifest models one
Worker per app and the policy forbids every cross-Worker binding except the
gateway. The shared platform tier (A1) sidesteps this for OpenSEO; only a
per-org OpenSEO would need a `workers: [...]` manifest extension. Size: 3.5 d
if needed; 0 under the A1 default.

**B9. Nothing outside this repository can build an app, and forks have no
mechanics.** Verdict: **verified** in code (`packages/{sdk,cli}/package.json:3`
are `private: true` since #276; every catalog app and the starter take the
SDK and CLI from `workspace:*`; `create` outside the checkout rewrites each
dependency into a `link:` path back into our checkout,
`updateConfiguration.ts:11-48`; `checkoutRoot()` throws `CHECKOUT_MISSING`
outside a checkout). npm's `latest` is `@every-app/sdk` 0.2.0 and `everyapp`
0.2.2 (2026-07/08), which cannot deploy this Gateway and predate the
hardening PRs #267-#271; 0.3.0 was never published. This blocks every org app
(laptop, the H24 GitHub Action, and our own v2 Sandbox builder, whose
container reaches only the npm registry), not only forks, and the "first
outside org" estimate omitted it. Also: as the manifests stand, no catalog
app is forkable onto hosted (all four declare KV, which hosted refuses;
todo declares a Durable Object, which D3's Verified plan forbade; chef
declares `providers: ["openai"]` while D6 makes OpenRouter the only metered
upstream; OpenSEO is platform-tier). Smallest change: publish
`@every-app/sdk` and an app-developer `everyapp` (carrying no Gateway
release, so self-host stays checkout-only) at 0.4.0 in lockstep via npm
trusted publishing; one `PROTOCOL` integer stamped into `bundle.json` with a
deploy-time floor; a fork = a new org app seeded from a per-app source
mirror with history, `source='fork'`, `forked_from_release_id`, zero grants.
Size: 3 d (publish + floor) + 3.5 d (mirrors + `everyapp fork`). D13;
`raw/r2-forks-and-sdk-publishing.md`.

**B10. The OpenSEO cutover was unspecified.** H18 said how OpenSEO's billing
code moves to the gateway; nothing said how the live product at
`app.openseo.so` (paying Stripe subscriptions, a directory-listed MCP
connector, running audits with open Autumn locks) gets onto hosted. Now
covered: identity imports with the **same ids** (password hashes are
byte-compatible: both Better Auth 1.6.22 and 1.7.7 use
`@better-auth/utils@0.4.2` scrypt with no pepper; sessions, GSC/GA grants
and Google tokens are not imported); Autumn customer id = gateway org id
always, so no Autumn customer writes; `topup_credits` drains as a second
wallet pool; in-flight Autumn locks settle through the old code for 24 h;
`app.openseo.so` becomes a gateway "catalog home host" (UI redirects to
per-org hosts; `/mcp`, OAuth and Google callback paths pass through with
`Authorization`); OpenSEO prod moves into the hosted account because service
bindings are same-account only. New risk found: Autumn's sandbox is a Stripe
sandbox, so live provider keys must never run on a sandbox wallet with open
sign-up (D5). Smallest change: Stage P now (second deployment for new
sign-ups, ~4.25 d), Phase 3 cutover later (~11 d, lossless rollback until
Autumn mode is deleted). `raw/r2-openseo-cutover.md`.

### Tier C: bugs and holes to close before a second org exists

**C1. Cross-tenant ToolBus validator cache poisoning (exists today).** Key is
`appId\0catalogHash\0tool` with the hash *reported by the app*
(`execute.ts:283-286`, `catalog-sync.ts:119`). Org B's `todo` can plant a
validator that rejects every call under org A's `todo`. Fix: key by registry
row id or a gateway-computed hash. 0.25 d.

**C2. Metering can be bypassed or lost.** Streamed chat completions without
`stream_options.include_usage` report nothing; aborted streams skip `flush()`;
cached tokens are ignored; `cf-aig-*`, `x-api-key`, `openai-organization` and
`openai-project` headers pass through (an app could set `cf-aig-custom-cost`
to 0 or pick a BYOK alias once AI Gateway is in the path). OpenRouter now
includes `usage.cost` on every completed response with no opt-in (the old
`usage.include` / `stream_options.include_usage` flags are deprecated
no-ops: verified #11, #34), but the location differs per endpoint: chat
completions put it in an extra final SSE chunk before `[DONE]`,
`/v1/responses` inside `response.completed`, `/v1/messages` inside
`message_delta`, so each pack route needs its own tail parser; `cost` is
schema-optional and an aborted stream emits no usage frame, so the abort
path reconciles via `GET /api/v1/generation?id=` (`total_cost`, USD)
(qualified #34). Fix: force `include_usage` on non-OpenRouter packs,
`cancel()` callback with provider-record reconciliation, per-provider and
per-endpoint parsers, strip by prefix. 1.5-2 d.

**C3. Shared-account hazards on the platform key become cross-tenant.**
`AI_PROXY_EXTRA_ROUTES` must be ignored in hosted; OpenRouter `/credits`,
`/key(s)`, `/generation` denied; DataForSEO `tasks_ready`, `id_list`,
`/v3/appendix/user_data` denied and `task_get/{id}` allowed only for ids this
org received from its own `task_post`. 1.5 d.

**C4. MCP under many tenants.** DCR's 200/day cap is global (one actor blocks
every tenant's Cursor users); `/oauth/token` is counted per client IP (claude.ai
refreshes from Anthropic's `160.79.104.0/21`); own-domain refusal misses the
content domain (a tenant app could pose as a "verified" OAuth client);
connecting a client to a second org silently revokes the first (by design, now
wrong). ~2.25 d total.

**C5. D1 is one single-threaded database for the whole platform.** Session
`cookieCache` is off, `user_app_access` is uncached, every `/mcp` request
re-reads all tool rows and runs an UPDATE, the audit table has a Free-plan
prune budget and one retention, and the usage ledger must not land there
(10 GB cap). Fix: `cookieCache` ~60 s, access cache, tools cached per
`(appRowId, catalogHash)`, skip fresh `touchLastUsed`, ledger in the
`OrgWallet` DO with a daily rollup, per-org audit retention. ~3 d.

**C6. New Cloudflare features that bite.** Workers Caching keys on path,
entrypoint, `ctx.props` and version, not identity headers, and a user Worker
can turn it on through upload metadata (serve user U's page to V): force it
off (0.25 d). Rate-limit namespaces are account-shared (0.1 d). Workers Logs
drop to a 1% sample account-wide after 5B/day, so the deploy service sets
`observability` per plan and billing never reads logs. DO wall-clock billing
(~$4 per always-on DO per month) is the main denial-of-wallet vector that no
CPU limit catches: usage poller with auto-suspend (2 d).

**C7. Egress: the DO gap is the whole gap.** Outbound Workers see only
`fetch()` from dispatched invocations and disable `connect()`; DO fetches
bypass them (`verified`, 2026-04-21); cron and queue coverage is moot since
those do not run in WfP. Since no secret is ever given to an app, the bypass
grants raw internet access only. Options: restrict DOs below a paid tier,
evaluate Dynamic Workers (`globalOutbound` covers `fetch` and `connect`) before
GA, or accept and monitor. The deploy-time lint promised at
`overview.md:164-165` is advisory at best.

**C8. Build plane.** Workers Builds is unusable as the multi-tenant builder
(verified #45): triggers attach to a Worker in our account (keyed by Worker
tag, two per Worker, repo connected through Cloudflare's GitHub App); the
Builds API and build tokens are user-scoped only ("account-owned token
support coming soon", 2026-09-22); the auto-created build token carries
account-wide Workers Scripts edit plus KV, R2 and Workers Routes edit on all
zones; 6 concurrent builds per account on Paid (1 on Free), 20-minute
timeout, no WfP target. **Qualified**: Cloudflare does not document that the
build token is readable by the build command's process; that follows from
the deploy command being an arbitrary shell command that runs wrangler
(#45). `@cloudflare/ci` injects the CF token into the runner. v1 accepts
prebuilt bundles only; v2 builds in **Sandbox SDK 1.0** (GA, not preview:
1.0.0 shipped 2026-09-30, 1.0.1 on 2026-10-13; verified #46) in a Firecracker
microVM with `enableInternet: false` (the 1.0 default; set it explicitly
because `start()` requires it when options are passed) and
`ctx.container.interceptOutboundHttps(host, WorkerEntrypoint)` handlers that
inject the GitHub token, deploying from the trusted Worker (VibeSDK's
pattern). Qualifiers (#46): interception covers 80/443 only (clone over
HTTPS, never SSH), the container must trust the ephemeral CA at
`/etc/cloudflare/certs/`, 128 intercept entries and 64 hosts per container,
intercepts die when the container stops, the gateway entrypoint must
restrict method/host/path or the sandbox has the token's full authority,
and it needs `ctx.exports` (compat date ≥ 2025-11-17) and Workers Paid. PR
#281's GitHub App needs Contents, Pull requests, Checks and Deployments
write (never Administration, which can delete repos), per-client webhook
URLs, `repository_ids`-narrowed tokens and a non-colliding name on hosted.

**C9. Autumn API drift to plan for.** `track` is async by default on API
2.5.0 (202, `balance: null`); `finalize` now requires `customer_id`;
`autumn-js@1.5.1` pins 2.6.0 while OpenSEO's 1.2.33 pins 2.3.0; entities
cannot nest (apps *or* users as entities, not both); Autumn Free caps
customers + entities at 10,000. Add: Autumn customer ids are not immutable
(`customers.update` has `new_customer_id`; its side effects on Stripe links,
locks and entities are unverified, R34), and `billing.import` is for
adopting outside Stripe subscriptions, not for our own customers
(`raw/r2-openseo-cutover.md` §2.3).

**C10. Tenant ceilings, turned into org counts.** Per org: Free = 4 dispatch
scripts + 4 D1 (todo, chef, workout, RepoLens; OpenSEO is platform tier,
zero per-org resources); Verified = 7 + 7. Eager (everything created at
sign-up), the first ceilings are Autumn Free (10,000 customers + entities →
2,000 orgs if every install is an entity), the control-plane D1 (about
330-500 proxied req/s today with `cookieCache` off and access uncached →
~8,000-12,000 active orgs; the 10 GB cap cannot be raised, so audit rows must
leave it, C5), then D1 databases (50,000/account → 12,500 orgs; raisable to
millions by form). WfP scripts are unlimited ($0.02/script/month after
1,000), DO namespaces are unlimited in WfP, KV is 0 per org after B1 (else
250 orgs), regular Workers (500) and cron triggers (250) bind only the
platform tier, Custom Domains (100/zone) bind nothing under one wildcard
route, Cloudflare for SaaS caps BYO at 50,000 hostnames ($0.10 each after
100). Rates: the API allows 1,200 calls / 5 min per user principal,
cumulative across that user's tokens and the dashboard, and a 429 blocks
every call for 5 min, so eager sign-up provisioning tops out at ~600
orgs/hour (24 calls/org) and one code-only catalog release to 10k orgs takes
~1.4 h (2 calls/install; 4.2 h with a migration and changed assets; 16.7 h
for all four apps installed eagerly). GraphQL is 300 queries / 5 min on top
of that: the poller must query per namespace, never per org. Workers Logs
drop to 1% for the whole account after 5B events/day, and one public tenant
route can reach that in about half an hour (~$3,000-5,500/day, UNVERIFIED
event size). The scheduler's fan-out may hit the 32-Worker-invocations-per-
request cap if dispatch counts (R30). Unit cost of an idle Free org:
~$0.08/month eager, ~$0.03 lazy, dominated by script fees; an active org
adds ~$0.05-$0.08. Cost is not the deciding factor; ceilings, API time and
abuse are. Smallest change: lazy catalog installs with a warm D1 pool (D2,
H17b), a `CfApiBudget` governor in the deployer (H10), Autumn entities only
for metering apps (H13), Queue fan-out in the scheduler (H15), per-plan
`observability` forced by the deployer (H10, D10), and the D1 limit
increases filed at account creation (D7). Usage assumptions (1.5 of 4 apps
opened, 5 members × 300 requests/day, 10% peak hour, ~50 KB per migrated DB)
are UNVERIFIED until the first 100 orgs. Source:
`raw/r2-unit-economics-and-limits.md`.

**C11. Email and legal minimums.** (a) The invitation email puts the org
name and inviter email into the subject and HTML unescaped
(`InvitationService.ts:40-48`). In hosted, anyone names an org and invites
any address, so our sender would deliver their link or phone number.
Scammers did exactly this through OpenAI's team invites (BleepingComputer,
2026-06-26) and through Zoom, PayPal and Microsoft notifications, about
133,260 emails (Check Point, 2026-02-05). Complaints count against the
account that also sends every verification email (Email Service terms §3).
Fix in H9: escape everything, validate org names, verified inviters only,
per-org invite budgets, complaints as an abuse signal. 1 d. (b) Hosted has
no Terms, AUP, privacy policy, subprocessor list, abuse channel or takedown
runbook. `everyapp.com/privacy` covers only the iOS app and says "We do not
operate any servers that receive your data"
(`landing-page/src/routes/privacy.tsx:36-37`). Cloudflare makes us "solely
responsible for the acts of [our] End Users" (Developer Platform terms §3,
2026-09-28), forbids deceptive subdomain names (§6; a tenant app called
`paypal-login` is our violation), and can terminate an account over repeated
DMCA notices (Self-Serve Agreement §8), so one tenant's infringement or
phishing endangers the whole account. OpenRouter §7 forbids "reselling API
access to Models"; whether a metered broker for org apps is "incorporating"
or "reselling" is open (R46). "Prompts never stored" (D6) is true only with
AI Gateway payload logging off and OpenRouter's logging opt-in off; the
draft backstop config set `collect_logs: true`. Also: `everyapp.dev` has two
`_dmarc` records, so DMARC is not applied there. Fix: H28 and D16.
`raw/r2-email-and-legal.md`.

---

## 4. Decisions only the founder can make

Sixteen, merged across the reports' 90-odd questions and the five round-2
reports' further 20 (anything an architect can decide alone went to
"Defaults we will take unless told otherwise" below). Each: the question, why
it matters, options, the recommended default, and what it costs to change
later. The one-line digest at the top of this document is the short form.

**D1. Where does the control plane live, which registrable domain hosts
tenant apps, and when do we submit it to the PSL?**
Why: baked into every app URL, the certificate, the cookie boundary, the
`/mcp` connector URL, the OAuth issuer and the brand's reputation.
`everyapp.com`'s apex is the marketing Worker. Options: (a) control plane
`app.everyapp.com`, apps on a new dedicated domain (`everyapp.app` or
`.host`); (b) apps under `everyapp.com` (scheme A: unsafe once org code runs);
(c) use the already-owned `everyapp.dev` as the content domain for the
prototype. Default: (a), with (c) until the domain is bought; submit to the
PSL when the first outside org deploys and accept a possible rejection. Cost
to change later: every tenant URL, bookmark, PSL entry and certificate; weeks.

**D2. Catalog apps: shared multi-tenant platform Workers, or one WfP copy per
org? And does hosted day one include OpenSEO?**
Why: decides whether OpenSEO can run at all (Workflows), the script count,
upgrade fan-out, whether `worker_name` is unique, whether D1 is per org, and
whether deletion/export need app hooks; and, for the dispatch tier, whether
each org's copies are created at sign-up (eager) or on first open (lazy),
which sets how many orgs fit in one account (12,500 vs ~33,000 at the
default D1 limit), how long a launch spike or a release takes, and how much a
bot that passes email verification can consume (C10). Options: shared for
everything; per org for everything (blocked for OpenSEO today); two tiers;
eager, lazy with a warm pool, or prefetch-all on first sign-in. Default: two
tiers: shared `tier='platform'` for OpenSEO-type SaaS apps already keyed by
`organization_id` (no per-org Cloudflare resources); per-org dispatch for
todo/chef/workout/RepoLens, forks and org apps. Dispatch-tier catalog apps
install **lazily, per app, the first time a member of a verified org opens
them**: the perimeter shows an install interstitial for a catalog host with
no `apps` row and the deployer runs the install (about six Cloudflare API
calls; a warm pool of pre-migrated D1 per catalog app takes create and
migrate off the wait; target p95 ≤ 10 s, to confirm in H0). Nothing is
created at sign-up. An idle Free org costs ~$0.03/month lazy vs ~$0.08
eager, and lazy fits about 2.7× more orgs under the D1 and Autumn ceilings.
No reclaim of unused installs in v1; revisit at 70% of the D1 grant. Phase 1
ships single-Worker dispatch apps; OpenSEO joins on the platform tier in
phase 2 as a **second deployment** of the same code in the hosted account
with its own D1, for new Every App sign-ups only; `app.openseo.so`
customers move only at the cutover (D5, §5 Phase 3). Cost to change: moving
an app between tiers is a data migration per org (D1 per org vs shared
Postgres); moderate. Lazy ↔ eager is a per-app flag
(`catalog_apps.auto_install`) that affects only new orgs; cheap. Reclaiming
installs that hold data is a policy promise, so decide before launch copy
mentions it.

**D3. Who may run custom code in hosted, and with which runtime features?**
Why: custom code is the whole abuse surface (foreign bindings, LLMjacking
through public routes, phishing on our domain, DO wall-clock bills, open
proxies via DO fetch). Options: everyone from day one; card-on-file
("Verified") and up; paid only. Default: Free = catalog apps only, no custom
code, no public routes; Verified (card on file via Autumn/Stripe setup mode) =
custom code ≤3 apps, ≤5 public routes, no root `/:p`, egress allowlist ≤10
hosts, **one Durable Object class** (guarded by the C6 wall-clock usage
poller with auto-suspend at ~10× the plan), no crons/queues, HTML
interstitial for 14 days; Paid = more DO classes, gateway crons, BYO
domains, higher caps. Per-plan dispatch limits (free 100 ms/100
subrequests; paid 2 s/1,000; catalog 30 s/10,000). Forks of catalog apps are
custom code under this decision (not on Free; count toward Verified's app
cap; per-plan limits, not the catalog's). The one-DO-class allowance exists
because todo, the flagship demo, declares `UserSyncDO`; without it a todo
fork would need Paid (D13). Cost to change: tier rules are data; cheap to
loosen, painful to tighten on live tenants.

**D4. The money model: one org wallet in credits, prepaid with holds, one
markup per provider, and what the plans look like.**
Why: shapes the Autumn catalog, the `OrgWallet`, credit risk and margin.
Today: 1 credit = $0.001, 1.28× on every provider (not just DataForSEO),
`usage_credits` + `topup_credits` with identical schemas, base-plan overage is
a 500-credit *unbilled* buffer, default plan is `onboarding_plan` not
`free_plan`. Options: prepaid with holds vs postpaid overage in arrears; one
pool vs per-app plans; per-token markup vs platform fee with equal usage
credit (the 2026 infrastructure norm). Default: one org wallet, prepaid
credits with holds and opt-in auto top-up, no arrears overage in v1, 1.28× per
provider as a gateway table, OpenSEO's Base ($10 / 10k) becomes "Every App
Pro" in a `platform` plan group, Free = 500 one-off credits spendable only
after email verification, org apps capped at 2,000 credits/month until an
admin raises it, catalog apps uncapped. Per-app caps are enforced in the
`OrgWallet` DO, not by Autumn entity `usage_limits`: those do not clamp a
`track` sent with `overage_behavior: "overflow"`, which the outbox uses
(qualified #36). Autumn entities are created only for apps that meter, on
the app's first metered call, which keeps a Free org at 1-2 Autumn units and
moves the Free cap (10,000 customers + entities) from ~2,000 to ~5,000 orgs;
Autumn Pro ($375/mo, unlimited) at 8,000 units. Cost to change: plan versions
in Autumn are cheap; changing the wallet unit or markup after launch means
customer communication.

**D5. Reuse the existing Autumn org; one customer-id rule; when existing
app.openseo.so customers move; no live provider keys on a sandbox wallet.**
Why: the live org owns the Stripe connection, OpenSEO's paying customers and
the wallet unit; Autumn customer ids are what join Every App orgs to Stripe;
moving paying customers puts them on a system the prototype rules allow us
to break; and Autumn's sandbox is a Stripe Connect sandbox, so anyone could
"buy" credits with a test card while the gateway pays DataForSEO and
OpenRouter with live keys (R33). Options: reuse vs new Autumn org; move
existing customers now, later in one window, or never (OpenSEO stays
standalone and Every App only lists it); open sign-up on the sandbox or not.
Default:
- Reuse "Ben Senescu's Org"; build the Every App catalog in sandbox
  `everyapp`.
- **Autumn customer id = gateway `organizations.id`, always.** New orgs get
  fresh ids through `customers.get_or_create`; imported OpenSEO orgs keep
  their ids, so their customers, subscriptions and balances carry over with
  no Autumn writes. Never rename customers (`new_customer_id` exists but its
  side effects are unverified, R34). `billing.import` is not used: it adopts
  outside Stripe subscriptions, and ours are already in Autumn. This makes
  the first draft's D5 and openseo-fit Q1 say the same thing.
- **Existing app.openseo.so customers move only in a later one-window
  cutover** (§5 Phase 3), after the tier-0 PRs, H8, H19 and ≥4 weeks of the
  wallet on live Autumn with daily reconciliation inside 2%. Until then,
  hosted gets OpenSEO as a second deployment for new sign-ups only (D2).
  Everyone signs in once at cutover (same password or Google); sessions are
  not imported.
- At cutover, keep plan ids (`base-plan` is renamed "Every App Pro"). The
  top-up add-on gets a new version granting one-off `usage_credits`; the
  wallet keeps `topup_credits` as a second pool until it drains. No entities
  until a plan-version migration adds `apps` (plan versions grandfather
  existing subscribers). In-flight Autumn locks settle through the old code
  for 24 h; then OpenSEO's ~5.6k lines of billing are deleted.
- **While the wallet bills through the Autumn sandbox, hosted sign-up is
  invite-only, or provider packs run against provider sandboxes** (DataForSEO
  sandbox; an OpenRouter key with a $5 daily `limit`). Live provider keys go
  together with live Autumn (`platformPolicy`).
- Turn on Stripe Tax at hosted launch, USD only.
Cost to change: free before any customer moves. After that, a per-customer
rename and a Stripe-link audit. Moving customers now instead pulls ~11 d of
Phase 3 and its prerequisites forward.

**D6. LLM upstream and provider keys for hosted v1.**
Why: OpenRouter returns `usage.cost` on every completed response with no
opt-in (verified #11, #34; the location differs per endpoint, so each pack
route has its own tail parser, C2); direct vendors need a maintained price
table and head+tail parsing; one shared key means shared fate at the
provider; AI Gateway Unified Billing is capped at 200 req/60 s per gateway
(BYOK exempt only under the `default` alias or `byok_only`: qualified #33)
and takes 5%; any Worker in the account with an `ai` binding can spend every
AI Gateway's credits (verified #35), which is one reason for a dedicated
account (D7) and for never giving tenants `ai` (A4). Options:
OpenRouter-only; AI Gateway Unified Billing; AI Gateway BYOK; mixed. Default:
OpenRouter is the one metered LLM upstream in hosted v1, with a per-org
provisioning key (`limit`, `limit_reset: daily`, guardrail from `ai.models`;
server-enforced, verified #51) created at grant approval and disabled on
takedown; `openai`/`anthropic` packs stay for self-host; AI Gateway (via the
gateway's `AI` binding) only for Workers AI and as a backstop, `byok_only`
once volume is real; prompts never stored, which holds only with no
request-body logging in the gateway (true today), AI Gateway payload logging
off (`cf-aig-collect-log-payload: false`; the draft backstop config set
`collect_logs: true` and must be fixed in H20), and the hosted OpenRouter
account's logging opt-in off and training opt-out on (C11, D16). OpenRouter's
written OK that a metered broker for org apps is "incorporating", not
"reselling" (§7), before the first outside org deploys its own AI-using code
(R46). Cost to change: packs are additive; switching the backstop is config.

**D7. Which Cloudflare accounts: one dedicated hosted account, a separate
staging account, and what moves into them?**
Why: ceilings are per account (D1 50,000 databases and 1 TB, both raisable;
KV 1,000, not documented as raisable; regular Workers 500; cron triggers
250; see C10 for org counts). The API allows 1,200 requests per 5 minutes
**per user principal, counted cumulatively across all of that user's tokens
and the dashboard**; a 429 blocks every call for 5 minutes; only Enterprise
can raise it, through Support (`raw/r2-unit-economics-and-limits.md`;
whether account-owned tokens get independent budgets is R29). WfP must be
purchased (error 10121 otherwise; whether $25 replaces or adds to Workers
Paid is undocumented, R18), a new account lands on Workers Logs where AI
Gateway `getLog()` is unverified, no token scope covers only a namespace
(verified #54), any Worker with an `ai` binding can spend every AI Gateway in
the account (verified #35), fixed names (`every-app-gateway` Worker and D1,
rate-limit namespaces 4180-4182) collide if staging shares production's
account, service bindings are same-account only (so the platform tier needs
OpenSEO's production Worker in the hosted account), and `app.everyapp.com`
(a Custom Domain) and the `mail.everyapp.com` sender both need the
`everyapp.com` zone in the account that runs them. Options: the founder's
existing account; a new hosted-only account; a split (control vs runtime)
later; OpenSEO in its own account reached over HTTPS with a catalog bearer
credential (+2 d, weaker broker identity). Default: a new account used only
for hosted production, WfP bought now; at account creation the Developer
Platform Limit Increase Request Form filed for **D1 databases → 250,000**
and **D1 account storage → 5 TB** (no KV request: B1 removes per-app KV; ask
about the API rate limit in the same form and plan for 1,200 regardless;
file the Email Sending increase the same day); `cf_account_id` recorded per
org and resource from day one so sharding later is a data change; shard when
the API budget runs >50% for a week or D1 passes 70% of the granted limit.
**A second account, "Every App Staging"**, with its own WfP subscription and
two cheap zones, same resource names, namespace `everyapp-staging` (H27).
**The `everyapp.com` zone and the marketing Worker move into the hosted
account** before H8 (interim: send mail through REST with a narrowly scoped
token from the zone's current account). **OpenSEO production moves into the
hosted account at the cutover**; the `openseo.so` zone (Enterprise) stays
where it is and `app.openseo.so` is attached as one Cloudflare for SaaS
custom hostname (H40). Cost to change: moving tenants between accounts is a
full re-deploy per org; expensive. Moving staging into the production account
is 1-2 d of renaming and patching. Each OpenSEO account move is ~2.5 d plus a
Workflow drain.

**D8. Who approves an app's capabilities, and do catalog apps need approval
at all?**
Why: decides whether "sign up and use all the apps" is one click, and whether
org apps spending the org's credits need an admin. Options: approval screen
for everything; implicit for catalog, admin approval for org apps; deployer
self-approves. Default: catalog apps get implicit grants from the reviewed
manifest (admins can disable or cap afterwards); org apps record pending
grants at deploy and calls fail 403 `capability_not_approved` with a link; an
org admin deploying their own app approves inline (CLI prompt or API flag);
members request but cannot approve; the platform enforces plan entitlement
and caps, no platform review per app. Public-route ("mode=public") traffic
gets no platform-paid providers by default. A fork of a catalog app is an
org app: it gets no implicit grants and `forked_from` never confers trust.
At `everyapp fork`, an admin may "approve as upstream" (grants equal to the
forked release's capability set, under org-app caps); anything new stays
pending. Cost to change: policy data; cheap.

**D9. Build plane: v1 "you build, we deploy", cloud builds in v2, and one
platform GitHub App?**
Why: cloud builds run strangers' `npm install` and Vite plugins on our
infrastructure (~2 weeks of Sandbox/cache/preview work); per-org GitHub Apps
(PR #281) isolate keys but collide on name and need N webhook secrets.
Options: cloud builds in v1; prebuilt only; Workers Builds (unusable,
verified #45). Default: v1 = `everyapp deploy` from a laptop or a thin
`every-app/deploy` GitHub Action with a per-app deploy key; v2 = Sandbox SDK
1.0 (GA since 2026-09-30, verified #46) builder from a connected repo with a
single platform GitHub App (Contents, Pull requests, Checks and Deployments
write; never Administration, which can delete repos), PR previews as
separate scripts with empty data, **outside-contributor PRs** (pull requests
from GitHub forks of an org's repo; not catalog forks, D13) gated by an org
member, OIDC replacing deploy keys; keep the manifest-flow app for self-host
and BYO-GitHub-App orgs. v1 needs `@every-app/sdk` and `everyapp` on npm
(D13): without them no org repo, laptop or Action outside our checkout can
build (B9). Cost to change: the bundle format is the contract; builders are
additive.

**D10. Platform operations: how do operators act, and does suspension run
without a human?**
Why: Better Auth's admin plugin exposes 15 open HTTP endpoints including
impersonation to any account with `users.role = 'admin'`; RFC-0001 forbids an
admin org; Cloudflare's terms make us "solely responsible for the acts of
[our] End Users" and may suspend our account. Options: Better Auth admin role;
an Access-protected ops host with an allowlist; both. Default: ops host
(`ops.everyapp.com`) behind Cloudflare Access with `OPS_EMAILS`, `/admin/*`
closed over HTTP, `platform_operators` table, every action in `audit_events`,
no impersonation in v1; automatic suspend on hard signals (spend >10× plan,
Safe Browsing hit, confirmed phishing report), human for content disputes,
owner always notified; logs off or 1% for Free/Verified (this carries money,
not only fidelity: one public tenant route can trip the account-wide 5B/day
Workers Logs threshold in about half an hour, C10). Abuse intake:
`abuse@everyapp.com`, a Turnstile-protected form at `everyapp.com/abuse`
feeding an `abuse_reports` table in the ops console,
`/.well-known/security.txt`, a DMCA notice and counter-notice path with a
registered designated agent and a repeat-infringer rule (Cloudflare's
Self-Serve Agreement §8 makes ours necessary), app ids and org keys checked
against a deceptive-names list (Cloudflare Developer Platform terms §6), and
apparent CSAM reported to NCMEC's CyberTipline as 18 U.S.C. § 2258A
requires. Documents and owners: D16. Cost to change: cheap.

**D11. The agent: in the gateway or an app, per user or per org, metered?**
Why: "users sign up for an agent" is the vision's first sentence and nothing
exists; in-gateway is fastest and self-host gets it too; as an app it is
least-privilege and forkable but needs a tools broker first; chat history
privacy depends on the DO key. Options: in-gateway DO; first-party app over a
tools broker; agent as an OAuth client of our own `/mcp` (rejected: own-domain
refusal, self-fetch). Default: `EveryAgent` DO in the gateway per
`(org, user)`, routed at `/agents/*` with an exact-Origin check on the
WebSocket upgrade, delegation as an `mcp_connections` row with
`client_id = "everyapp:agent"`, tools via `listTools`/`executeToolCall`
in-process, LLM through the broker as app `everyapp` under the org's credits;
one AI connection = one org with parallel connections allowed, **as the v1
UX choice** rather than a library constraint: per-org connector URLs are
possible today without a library change, because paths beneath the
registered resource (e.g. `https://app.everyapp.com/mcp/o/<org>`) validate
via `workers-oauth-provider`'s path-descendant audience matching, and
per-org hostnames can be served by constructing the AS per request or per
org-list version with every org's resource listed (qualified #20; the cost
is gateway-side, not upstream); extract to a first-party app once the tools
broker exists. Cost to change: the ToolBus seam makes the move mechanical;
chat history would migrate.

**D12. Onboarding and org lifecycle rules.**
Why: each sets the free-credit abuse surface, how many users live in two
orgs (which drives the active-org fix), and what deletion promises we make.
Sub-questions and defaults: invited sign-ups join only the inviting org (no
personal org until they ask); verified users may own ≤3 orgs with a global
daily org-creation budget; hard email verification (no session until
verified, auto sign-in after); password + Google + GitHub, no magic link,
Cloudflare Access self-host only; org URL key auto from the name plus a random
suffix, editable once, then permanent; the last owner cannot leave while
others remain (transfer first); owner-initiated deletion = 7-day "deleting"
state then purge, secrets crypto-shredded, "residual backups up to 30 days" in
the policy; accounts are platform-owned and survive org deletion; a stated
promise that an org can export and leave for self-host (spec the format now,
build after billing). Cost to change: policy and copy; cheap, except the org
key and deletion promise.

**D13. Forks and publishing: what is a fork, where does its code live, and
do we publish the SDK and CLI again?**
Why: nothing outside our private checkout can build an Every App app (B9),
so no outside org can run `create`, a GitHub Action or our future builder;
the founder's "customizations/forks of a repo" has no mechanics; a fork
needs a source to copy, a way to take upstream fixes, and rules for data,
grants and plans. Options: (a) forks live in the org's own repo, seeded from
a per-app source mirror with history, and get the SDK and CLI from npm; (b)
as (a) but the source arrives as a private git bundle and the SDK as a
tarball vendored in each repo; (c) forks live in our monorepo (works only for
us); (d) each org gets a copy of the monorepo. Default: (a).
- **Fork** = an org app whose code starts as a copy of one catalog release:
  new app id (catalog ids are reserved per org for installs), fresh
  resources, no data, `source='fork'`, `forked_from_release_id`, always
  `tier='dispatch'`, WfP tag `kind-fork`; v2 adds **eject in place**, which
  turns an install into a fork keeping its row, Worker, D1 and DOs.
- **Grants:** zero, with an admin "approve as upstream" shortcut (D8).
  **Plans:** custom code under D3. **Upgrades:** catalog fan-out never
  deploys into forks; `everyapp status` and the control plane show "1
  release behind" (v1), an upstream PR into the fork's repo (v2).
- **Mirrors:** `every-app/app-<slug>` repos, one tagged commit per catalog
  release with `workspace:*` rewritten to the lockstep version, a standalone
  `pnpm-workspace.yaml` carrying the root's `allowBuilds` and security
  overrides, a committed lockfile, a LICENSE. **Public and MIT** for todo,
  chef, workout and the starter (OpenSEO is already public MIT); choose
  private git bundles behind org auth (+1 d) if catalog code should stay
  closed. Public is irreversible; private can open later. GitHub forks of a
  public mirror would be public, and template repos have no merge base, so
  the fork is a clone with history pushed to a repo the user creates.
- **Publishing:** `@every-app/sdk` and an app-developer `everyapp` on npm at
  **0.4.0, one version for both** (lockstep), via npm trusted publishing
  from a GitHub Actions workflow on a `v*` tag (no provenance while the repo
  is private), **timed with H12** (the hosted deploy API), not now; `<0.4.0`
  deprecated. The published CLI carries **no Gateway release**: `setup`,
  `gateway *` and self-host `deploy`/`delete` keep requiring a checkout, so
  the "checkout is the truth" rule and the deferred release-identity problem
  (RELEASE.md:33-36) are untouched. Compatibility: one `PROTOCOL` integer in
  `@every-app/sdk/internal/protocol.ts` covering headers, claims,
  `/__everyapp/*` paths, the tools body and the `bundle.json` schema;
  `everyapp bundle` stamps `{sdkVersion, protocol}`; the hosted deployer
  refuses `protocol < MIN_PROTOCOL` with `SDK_TOO_OLD`; self-host `deploy`
  checks `MIN_SDK_VERSION` (closes `TODO.md:32`). Once an outside org exists,
  the hosted gateway serves protocols N-1 and N, raising the floor requires
  zero active Workers below it, and forks get a 30-day notice.
- Until then our own forks live in `apps/` and deploy from the checkout.
Cost to change: fork-model details are additive; publishing commits us to a
protocol-compatibility window once outside orgs build and npm versions are
permanent; public mirrors cannot be un-published; not publishing blocks every
outside org app. `raw/r2-forks-and-sdk-publishing.md`.

**D14. Per-host `__Host-` app sessions on self-host too?**
Why: scheme C (A3) gives every app host its own cookie minted by a silent
handoff. Doing that in both modes is one mechanism, one test suite and no
`crossSubDomainCookies` branch, and it lifts the self-host "apps one label
under the gateway" rule; but it adds one redirect per app per session on
self-host, where the deployer is the operator and the shared cookie is not
unsafe. The perimeter report defaulted to keeping the shared cookie on
self-host; the hostnames and identity reports (and this synthesis) default
to one mechanism under the no-backcompat rule. Options: (a) per-host
sessions in both modes; (b) hosted only, shared cookie stays on self-host
behind a mode flag (+0.5 d in H8). Default: (a). Cost to change: (a)→(b) is
the +0.5 d policy branch at any time; (b)→(a) later means re-testing
self-host app hosts.

**D15. Which email provider, for which mail, from which domain?**
Why: hosted sign-up needs verification, invitations, resets, billing and
suspension notices; Cloudflare's Email Service terms (2026-09-28, §1-§2)
allow **transactional mail only**, so founder check-ins and product news
cannot go through it; the bounce/complaint budget is per **account**, so one
tenant abusing invitations slows every sign-up's verification mail;
`everyapp.com` has a null MX and `v=spf1 -all` today; and the sender's zone
must sit in the account that sends (D7). Options: everything on Cloudflare
Email Sending (no lifecycle mail at all); Cloudflare for transactional plus
Loops for lifecycle; a second vendor (Resend, Postmark, SES) for everything.
Default: transactional mail (verification, reset, invitations, payment and
balance notices, suspension, takedown and deletion notices) through
**Cloudflare Email Sending** via the `send_email` binding the gateway already
declares, from `Every App <noreply@mail.everyapp.com>` with `reply_to`
`support@everyapp.com` (public beta since 2026-04-16, Workers Paid, 3,000
included then $0.35/1,000, automatic suppression, bounce and complaint
events over Queues); **lifecycle and founder sequences through OpenSEO's
Loops account**, porting spec 0015 as is and tagging contacts by product;
**human mail** (`support@`, `abuse@`, `security@`, `postmaster@`) on
**Proton** at the `everyapp.com` apex, as `everyapp.dev` already runs; apex
DMARC `p=none` for two weeks, then `p=reject`; delete the duplicate
`_dmarc.everyapp.dev` record. Tenant apps never get `send_email`. No second
transactional provider unless the new account's "conservative" daily quota
cannot carry sign-ups (R45; a Resend transport behind `sendEmail.ts` is
~0.5 d). This is a prerequisite of H9, where the escaped template module,
org-name validation and invite budgets land (C11). Cost to change:
transactional ~0.5 d of code plus DNS and warm-up; lifecycle ~1 d to
recreate Loops workflows elsewhere.

**D16. Who writes the Terms, AUP, privacy policy, subprocessor list and
abuse process, and when?**
Why: Cloudflare makes us solely responsible for our End Users and flows its
whole Agreement down to them (Developer Platform terms §3, §10); the
broker's privacy promise holds only with specific OpenRouter and AI Gateway
settings; OpenRouter forbids "reselling API access to Models" (§7); the
current `everyapp.com/privacy` is false for hosted (C11). Options: (a) the
agent adapts OpenSEO's Every App, Inc documents (Terms revised 2026-08-23
with AUP, DMCA agent and arbitration; privacy 2026-08-24; a GDPR erasure
runbook), Ben approves, counsel reviews before public sign-up; (b) counsel
drafts from scratch now; (c) a policy generator. Default: (a). **Before the
first outside org** (the tier-0 subset, ~2.5 writing days + 1 engineering
day): Terms covering customer apps and code, prepaid credits and holds, AI
output, flow-down of model terms, suspension, the 7-day deletion grace and
export promise; an AUP flowing Cloudflare's terms down (no phishing or
deceptive names, malware, volumetric attacks, VPN/proxy services, PHI, IP
infringement, CSAM) plus ours (no spam invitations, no reselling AI or data
access, no evading metering); a hosted privacy policy that matches what the
code stores (the iOS page moves to `/privacy/ios`); a subprocessor list;
`abuse@` plus the form plus `security.txt`; the takedown runbook; the DMCA
designated agent registered or amended for Every App, Inc listing
`everyapp.com`, the content domain and `openseo.so` ($6; use a P.O. box or
registered-agent address if 34 Harding Street is personal); OpenRouter's
written OK if the org's own code uses AI; acceptance stamped on `users` at
sign-up and invitation acceptance. **Before public sign-up:** counsel
review, a DPA, consumer billing disclosures, automated phishing scanning.
Cost to change: pages are cheap to revise; retracting a promise (prompt
storage, export, deletion windows) needs user notice (OpenSEO's policy
commits to 30 days), so keep first versions precise and modest.
`raw/r2-email-and-legal.md` §3 B.

### Defaults we will take unless told otherwise

Architect-level choices the reports settled; listed so they are visible.

- One dispatch namespace per account: `everyapp-prod` in the hosted account,
  `everyapp-staging` in the separate staging account (D7, H27); untrusted
  mode, never `trusted_workers`. Script name = the existing `workerName`.
  Tags `org-*`, `app-*`, `kind-*` (incl. `kind-fork`), `plan-*` (8 max, no
  `:`/`,`/`&`; that four tags fit is checked in H0).
- No `tenants` table and no `t_<tenant>_<app>` scheme; orgs + `organization_keys`
  are the tenant model. No hostname→tenant KV; D1 plus the isolate LRU resolve
  hosts.
- `aud = workerName` on both tiers; `EVERYAPP_AUDIENCE` binding; SDK pins
  `org_id`.
- Org from the host on app hosts; the active org only steers the control
  plane. Both tiers.
- Per-host `__Host-` app sessions in **both** modes (D14; one mechanism; no
  backcompat; lifts the self-host "apps one label under the gateway" rule).
  If the founder prefers the shared cookie on self-host, it is a mode flag.
  Duplicate-session-cookie refusal is ordering-agnostic (qualified #40).
- HTTP over the binding for proxied traffic; RPC only for `meter`, `reserve`,
  `settle`, `capabilities`. One path shape `/v1/<provider>/<upstream path>`.
- `capabilities` manifest map replaces `providers` + `ai` + `integrations`;
  packs own their entry schemas. `meters` labels copy the `scopes` record
  shape.
- Grants keyed by `app_row_id`; `AppRepository.tombstone` deletes them.
- `OrgWallet` DO is the only spender and the only per-app cap (entity
  `usage_limits` do not clamp overflow tracks, qualified #36); `usage_events`
  live in the DO with a `usage_daily` rollup in D1; Autumn sees org totals
  with `app` as an entity (`entity_id = apps.id`, feature `apps`) for
  attribution only, created on an app's **first metered call**, never at
  install, and only after a plan-version migration grants `apps` (attribution
  through `properties.app` until then); no `ai_credit_system`/`trackTokens`;
  new top-ups land in `usage_credits`, and `topup_credits` stays a second
  wallet pool tracked by credit-system id until no customer holds it (D5).
  Autumn Pro at 8,000 customers + entities.
- Separate `every-app-deployer` Worker; post-upload binding verification;
  caching forced off; `observability` set by us; `limits` on both the
  dispatch call and script metadata.
- Hosted refuses `resources.kv` and `resources.workflows` on the dispatch
  tier; drop unused KV from catalog manifests now; brokered KV later.
- Gateway-driven crons at minute granularity; native crons stay on self-host
  and the platform tier.
- Suspension via the 30 s registry TTL (plus optional `caches.default` L2),
  no active purge; takedown also replaces script content so DO/alarm code
  stops.
- Hosted tables ship in self-host, empty, under `src/db/hosted/`. One
  regenerated baseline until the first production deploy that opens sign-up
  beyond the team; then `drizzle/frozen.json` (sha256 of every frozen file,
  enforced by `release-migrations.test.ts`) freezes it **for both modes**,
  and new migrations are numbered `0001_*` onward and expand-only, with
  drops carrying `-- everyapp:contract <release>`. At that point the hosted
  contracts (D1 schema, SDK↔gateway, gateway↔deployer, CLI↔`/api/v1`)
  become N-1 compatible. The alternative, a separate `drizzle-hosted/`
  history (+0.5 d, two histories to keep in step), is not taken. Until the
  freeze, the staging and production hosted D1s are dropped and recreated
  whenever the baseline is regenerated.
- `platformPolicy(env)` as one frozen object; `GATEWAY_DEPLOYMENT_MODE`
  becomes a release-patched text binding; `invalid` fails closed everywhere.
- Envelope encryption (per-org DEK, versioned KEK in a Worker secret) for
  gateway-held org secrets; app-own secrets go to WfP script secrets.
- MCP: one AS, one resource; org-scoped supersede; DCR on with hosted caps;
  `/oauth/token` off the IP limiter; app-host `/mcp` kept (PAT/session only);
  tool calls counted, not billed; PAT defaults narrowed to `mcp:*`.
- Previews never get metered or integration grants; empty D1 per preview.
- Dub referrals dropped for the prototype; multipart AI routes excluded from
  hosted v1.
- Email per D15: transactional through Cloudflare Email Sending from
  `noreply@mail.everyapp.com`; lifecycle and founder sequences through Loops
  (OpenSEO spec 0015, ported); human mail on Proton at the `everyapp.com`
  apex; DMARC `p=none` → `p=reject`. Tenant apps never get `send_email`. No
  second transactional provider unless R45 fails.
- Third-party developer payouts deferred (Autumn has no revenue share; Stripe
  Connect separate charges and transfers when needed).
- BYO custom domains not in v1 (`*/*` route + Cloudflare for SaaS later).
  Exception: `app.openseo.so` is attached by ops as a `catalog_home` host at
  the OpenSEO cutover (a Workers Custom Domain if the zone is in the hosted
  account, otherwise one SaaS custom hostname, H40). It passes only `/mcp`,
  OAuth and third-party callback paths to OpenSEO with `Authorization` (for
  `trust: catalog` apps only) and redirects the UI to per-org hosts.
- Catalog installs on the dispatch tier are lazy (first open) with a warm D1
  pool (N = 25 per catalog app, refilled by a deployer cron, migrated with
  every release); nothing is provisioned at sign-up; `catalog_apps.auto_install`
  defaults to false (D2).
- The deployer owns the Cloudflare API budget (`CfApiBudget` DO: one token
  bucket per principal fed by the `Ratelimit` header, priority lanes takedown
  > interactive install > deploy > fan-out > poller, never sends a call that
  would 429); nothing else calls the Cloudflare REST API in production.
- `apps.source` ∈ `org | catalog | fork`; forks carry `forked_from_release_id`,
  always `tier='dispatch'`, WfP tag `kind-fork`; `catalog_app_id` is
  install-only; catalog ids reserved per org for installs (D13).
- Catalog fan-out never deploys into forks; forks get a notice (v1) or an
  upstream PR (v2).
- SDK and CLI share one version; one `PROTOCOL` integer; `bundle.json`
  stamps both; the hosted deployer refuses bundles below the floor; the
  published CLI carries no Gateway release, so `setup`/`gateway *`/self-host
  `deploy` stay checkout-only (D13).
- `tier` values `service_binding` (self-host default, ~20 tests use it),
  `dispatch` (one org's Worker in the namespace), `platform` (one shared
  catalog Worker reached over a service binding); **no rename**; one column,
  not transport + tenancy (only three combinations exist); unknown tiers
  fail closed instead of coercing to `service_binding`.
- One credential per target, chosen locally by `lib/target.ts` with no HTTPS
  call: the cf login for self-host, an org-bound `epat_` for hosted
  (exchanged from the device-flow session, which is a full account session
  and is signed out right after). No `login` verb (the redesign's deletion
  stands); `everyapp logout` is the one new, hosted-only verb; CI uses
  `EVERYAPP_TOKEN`. `secret set` keeps one verb with per-target semantics
  stated on its first line: self-host redeploys from `cwd`; hosted dispatch
  apps set the secret on the live version through the WfP secrets API
  ("creating a new version with that secret", `keep_bindings:
  ["secret_text"]`); platform-tier installs use `app_secrets` (H20); hosted
  `--for gateway` is refused.
- A bare `everyapp deploy` with no cf login and no Gateway offers "sign in to
  everyapp.com" next to "install your own Gateway" (`action_required
  choose_target` under `--json`); otherwise hosted is reached only through
  `--gateway`, `EVERYAPP_GATEWAY_URL`, `EVERYAPP_TOKEN` or a stored token.
  Self-host stays the default target.
- Hosted control plane ships from `hosted-release.yml` (H27): build once on
  every merge to main, staging deploys automatically, production deploys
  only on a `workflow_dispatch` that promotes a green staging run's artifact
  (restricted to main; GitHub Team on a private repo has no required
  reviewers, and agent PRs auto-merge). The install row gains
  `mode='hosted'`, and self-host `connectToGateway`/`setup` refuse it: that
  refusal is the only thing between the founder's cf login and a laptop
  redeploy of production. Never `--allow-downgrade` or `setup --redeploy` on
  hosted.
- DataForSEO capacity is shared through a global `ProviderGate` DO: 30
  concurrent for DB-backed live APIs with ≤10 per org, live Google Ads 12/min
  with ≤4 per org and idle borrowing, short queue then 429 `provider_busy`.
  Hosted uses its own DataForSEO login until the OpenSEO cutover; previews
  and any sandbox-billed org use `sandbox.dataforseo.com`; a gateway cron
  watches the prepaid balance and 503s the pack at zero. Fixed third-party
  OAuth redirect URIs for catalog apps live on the app's home host
  (`app.openseo.so`), which relays to the org host.
- The scheduler always fans out through a Queue (≤25 dispatches per consumer
  invocation) until R30 shows dispatch is exempt from the 32-invocation
  cap; hourly-or-slower catalog crons get per-org minute jitter.
- Deployer `observability` is forced per plan (Free/Verified: invocation
  logs only or `head_sampling_rate` ≤ 0.01).

---

## 5. DRAFT PR series toward the vision

Assumes #286-#293 are merged (they are). Sizes are engineer-days for one
person with agents; many PRs are independent and can run as parallel lanes.
"Self-host" states whether self-host keeps working.

### Phase 0: settle the unknowns (~3.5 d, not code PRs)

Every check below is consolidated, with commands, expected outcomes and the
account each needs, in `docs/research/2026-10-hosted-platform/live-checks.md`.

| # | Title | Contains | Depends on | Size | Self-host |
|---|---|---|---|---|---|
| H0 | **WfP live checks in a scratch account** | Upload a one-line namespaced Worker with `{type:"service", service:"every-app-gateway", entrypoint:"AppGateway", props}` and echo `ctx.props` (R1; also `GET /bindings` to confirm `props` is not echoed); try a `workflow` binding with `script_name` pointing at a platform Worker and call `.create()` from the user Worker (R2, the only open Workflow question: hosting a class in the namespace is settled); try `triggers` on a dispatch upload (R3, expected refused); queue consumer with a namespaced `script_name` (R4); WebSocket 101 through `DISPATCHER.get().fetch` (R5); assets upload-session JWT used from a second process (R7); D1 multi-statement `query` atomicity on a failing statement (R8); script-level `metadata.limits` on a DO alarm (R9); `secret_key` non-extractable (R20); `cf deploy --prebuilt --dispatch-namespace` with DO `exports` (R19); four tags incl. `kind-fork` on one script; 50 sequential + 50 concurrent (×10) fresh todo installs from a deployer Worker with per-step timings, p50/p95, with and without a pool D1 (R28); asset-upload dedupe across two scripts in one namespace (R31); whether two account-owned tokens have independent 1,200/5 min budgets, reading `Ratelimit` (R29); whether `DISPATCHER.get().fetch` counts toward the 32-invocation limit (one request dispatching to 40 scripts, R30); control-plane D1 bytes per org (seed 100 synthetic orgs, read `file_size` and `meta.duration`, R32); AI Gateway `getLog()` on a Workers-Logs account and spend-limit `window` units (R10). | WfP subscription on a scratch account (D7's staging account can be it) | 2 | n/a |
| H0a | **Cookie and session checks in a browser** | Two-tab cookie-toss test against Better Auth 1.7.7 behind the gateway: a tenant page sets a `Domain=<base>` session cookie copied from the attacker's own session, first with `Path=/` (expected: victim's cookie wins, first-wins parser, qualified #40) and then with a longer `Path` such as `/api/auth` (expected: `/api/auth/get-session` returns the attacker's account) (R6); Safari ITP against a bounce-only control plane, and whether Better Auth can emit a `__Host-` cookie with a custom name (R15); claude.ai adding the same connector twice and the refresh traffic's source range (R16). | a deployed gateway with two apps | 0.5 | Informs D14 |
| H0b | **Billing live checks** | Autumn sandbox `everyapp`: duplicate `track` with the same `Idempotency-Key` → 409 (R11); an entity-level `usage_limits` entry below the customer balance, then `track` with `overage_behavior: "overflow"` (expected: not clamped, qualified #36) and with the default (expected: clamped); `entities.create` for a customer on the Free/`onboarding_plan` plan with no `apps` feature (R11); which pool Autumn draws when tracking `seo_data_usage` with both `usage_credits` and `topup_credits` present; `check` with a 100-credit lock, read `remaining`, let it expire, watch the webhook log (R35); `billing.attach` of a paid plan with `4242 4242 4242 4242` (R33); `customers.update` with `new_customer_id` on a customer holding a plan, a lock and an entity (R34). DataForSEO sandbox: one Lighthouse `task_post` + `task_get`, record body size and the byte offset of top-level `cost` (expected ~200 bytes, docs examples only), confirm `cost: 0` on `task_get`, and whether the sandbox accepts the prod login and serves AI Optimization `llm_responses` (R12, R36); 35 parallel Labs live calls from one login, record the 31st response status and any `X-RateLimit-*` headers (R36). OpenRouter management key: one streamed call on each of `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, record where `usage.cost` lands (R13); create a provisioning key with `limit: 0.01`, spend past it, expect 402/403 `openrouter_key_limit`; create keys in a loop to find any per-account count ceiling on provisioning keys (UNVERIFIED, no doc states one). | Autumn sandbox `everyapp`; a DataForSEO sandbox login; an OpenRouter management key | 1 | `NoopBillingPort` unaffected |

### Phase 1: tenancy hardening that self-host wants too (~13 d, parallel lanes)

| # | Title | Contains | Depends on | Size | Self-host |
|---|---|---|---|---|---|
| H1 | **One seam: dispatch branch and every caller through `getAppFetcher`** | `AppFetcherTarget` gains `appId`, `organizationId`, `limits`; `dispatch` branch with `limits`/`outbound`, "Worker not found" → 503; `probeApp` via the seam; ToolBus callers pass the whole app; `LruTtl` for hostname/caller/org/marker caches with hit/miss split; `isRegistryWorkerName` re-checked at dispatch. | none | 2 | Works unchanged |
| H2 | **Tenant-unique identity** | `aud = workerName` at all four mint sites and two verify sites; `EVERYAPP_AUDIENCE` text binding from `everyAppWorker()`; SDK `audienceFor()` and `org_id === EVERY_APP_ORG_ID` check; marker cache keyed by `workerName`; ToolBus validator cache keyed by registry row id + gateway-computed hash. | H1 | 1.5 | Gateway and SDK must ship together (no backcompat) |
| H3 | **Org from the host** | `authenticate(request, app)`; membership resolved in `app.organizationId`; PAT must match the app's org; `users.lastActiveOrganizationId` for the control plane; unique `members(organization_id, user_id)` via plugin schema; `mcp_connection_apps.organization_id` + composite FK; `AppToolRepository.replace` org predicate; drop `findByAppId`; `security-model.md:278-279` updated. | H1 | 2 | Fixes the 403 for owners invited to a second org |
| H4 | **MCP and cookie hardening** | `onPlatformDomain()` covering `APP_BASE_DOMAIN` and `PLATFORM_DOMAINS`; org-scoped supersede + flipped test + "two orgs, two connections" test; env-configurable DCR caps; `/oauth/token` off the IP limiter; refuse requests whose Cookie header repeats the session cookie name; `security-model.md:284-285` corrected. | none | 2 | Works unchanged; closes TODO.md:38 |
| H5 | **Broker: correct metering and the OpenRouter pack (log-only)** | `PACKS` table (`openai`, `openrouter`): origin, secret, inference routes, denied prefixes (`/credits`, `/key(s)`, `/generation`), body rewrite (`store:false`, forced `stream_options.include_usage`); `AI_PROXY_EXTRA_ROUTES` ignored when hosted; strip `cf-aig-*`, `x-api-key`, `openai-organization`, `openai-project`, `x-everyapp-feature` before upstream; tap reads `cost`, `cached_tokens`, `reasoning_tokens`, `gen-` id; `cancel()` on abort; usage line gains `costUsd`, `costSource`, `feature`, `userId`, `attribution`, `ref`; `createGatewayFetch({provider, feature, request?})` with per-provider dev fallback; `OPENROUTER_API_KEY` declared in `cloudflare.config.ts`, `env.d.ts`, `secretsFile.ts`. | none | 2.5 | Operators gain OpenRouter; Chef demo |
| H6 | **Platform policy module and hosted-off switches** | `server/platform-policy.ts` (`platformPolicy(env)`, frozen, fail-closed on `invalid`); mode as a release-patched text binding; `sign-in-methods` exposes `signUp` and providers; hosted: setup claim and `has-owner` 404, no install org (`isInstallOrganization:false`), Access plugin not registered, `/admin/*` in `DISABLED_AUTH_PATHS`, tenant admins cannot ban/reset/delete accounts, `deleteUser` never deletes the account. | none | 2 | Unchanged under `self_hosted`; `/admin/*` closure applies to both (it is inert today) |

### Phase 2: hosted foundations (hosted-mode only unless noted)

| # | Title | Contains | Depends on | Size | Self-host |
|---|---|---|---|---|---|
| H7 | **Hosted schema baseline** | `organization_platform`, `platform_operators`, `audit_events`, `catalog_apps`, `app_versions` (with `sdk_version`, `protocol`), `deploy_jobs`, `app_resources`, `app_capability_grants`, `organization_data_keys`, `app_secrets`, `billing_customers`, `usage_daily`, `app_schedules`, `app_host_sessions`, `abuse_reports`; `Tier = 'service_binding' \| 'dispatch' \| 'platform'` (no rename; `service_binding` stays the self-host default; `platform` is a shared catalog Worker reached over a service binding and `getAppFetcher` maps it to `APP__<worker>`; unknown tiers fail closed instead of coercing); `apps` gains `source` (`org \| catalog \| fork`), `catalog_app_id` (installs only), `forked_from_release_id`, `limits`, `disabled_reason`, `current_version_id`; partial unique `worker_name` excluding `platform`; `organization_keys` FK dropped (PK kept, tombstone survives org deletion); `_everyapp_install.mode` (`self_hosted \| hosted`); regenerate the one baseline; `RegistrationInput.tier`/`source`; `markDeployedUpdate(tier)` → `active` for dispatch. Self-host files that change: perimeter `registry/registration.ts`, `registry/apps.ts`, `getAppFetcher.ts` (+ tests; `apps.test.ts:45-47` flips); CLI `lib/gateway/registry.ts` (takeover SELECT excludes `platform`), `desiredState.ts` (`tiers` option), `install.ts` (`mode`), `connect.ts` (`requireInstall` refuses `mode='hosted'` with `HOSTED_INSTALL`) (+ `registry.test.ts`, `discover.test.ts`, `apply.test.ts`). | H3 | 2.5 | Tables created empty; the CLI writes `tier='service_binding'` as today |
| H27 | **Hosted control-plane release pipeline** | `hosted-release.yml`: build once on push to main (SDK, `build:release`, deployer release, sha256); `staging` job automatic; `production` job only on `workflow_dispatch` promoting a green staging run's artifact (branch-restricted to main; builds are not reproducible, so never a rebuild); both run `packages/cli/src/ops/hostedRelease.ts`, which reuses `applyGateway` with a `hosted` profile. Per env: D1 lease → `olderThanInstalled` refusal (never `allowDowngrade`) → bookmark → `cf d1 migrations apply` (expand-only) → deployer at 100% (its RPC methods only ever get added) → gateway patched by `patchHostedGatewayBuildOutput()` (`GATEWAY_DEPLOYMENT_MODE=hosted` text binding, `DISPATCHER` + `Outbound`, `* * * * *` beside `17 * * * *`, control-plane Custom Domain + `*.<content>/*` route, `APP__*` only for `tier='platform'` rows; DO classes, compat date ≥ 2025-11-17 and `AI` stay in `cloudflare.config.ts` for both modes) → upload: staging and any release whose `exports` change DO class lifecycle use `cf deploy --prebuilt` at 100%; production otherwise, once R40 passes, `cf workers versions create --prebuilt` → `deployments create` new at 0% → smoke via `Cloudflare-Workers-Version-Overrides` → 10/50/100% with a 5xx gate (thresholds are tuning), version affinity from a Transform Rule setting `Cloudflare-Workers-Version-Key` from the session cookie; `cf workers triggers deploy --prebuilt` when triggers differ. Record: install row `mode='hosted'`, `updated_by: hosted-release <run url>`; `_everyapp_releases {version_id, release_sha256, version, order, bookmark, run_url, deployed_at}`. `hosted-rollback` job: `deployments create` previous version at 100%, refused across a DO lifecycle change or past a `-- everyapp:contract` migration; `cf d1 time-travel restore` founder-only (overwrites in place, loses every write since the bookmark). `drizzle/frozen.json` + `release-migrations.test.ts` freeze the baseline at the first public hosted deploy. Staging = second Cloudflare account, same names, namespace `everyapp-staging`, own control + content zones, Autumn sandbox, capped OpenRouter key, email allowlist, test org with a deploy key. Smoke suite (`scripts/hosted-smoke.ts`): new `GET /__everyapp/release` (returns `EVERYAPP_RELEASE` + `CF_VERSION_METADATA.id`), sign up + verify against a test inbox, deploy the template through the hosted CLI, open via the handoff, one metered broker call, one scheduler tick, `/mcp` initialize, and an N-1 check that the previous run's template build still works. Tokens: per-env account-owned token (per-Worker Editor on the two Workers, D1 Edit, Workers Routes Write on the two zones) as a GitHub Environment secret; deployer runtime token only as that Worker's secret; platform secrets via `--secrets-file`, never the secrets API (which marks the Worker API-edited and makes cf abort the next unattended deploy); gateway identity keypair generated by the first deploy. `cf-dry-run.yml` dry-runs the hosted profile. | H6, H7, D7 (H10 adds the deployer step) | 3.5 | Unchanged; self-host commands refuse a `mode='hosted'` install |
| H8 | **Hostnames and per-host app sessions (scheme C)** | `routeHost()` classification before D1 (hosted label must match `^[a-z][a-z0-9-]*-[a-z0-9]{1,12}$`); `APP_BASE_DOMAIN` decoupled from the gateway host; hosted gateway config `routes ["app.everyapp.com/*", "*.<content>/*"]`; `/app-session/start` on the control plane (registry + membership + access check, 60 s single-use code bound to a `__Host-everyapp_handoff` nonce); perimeter `/__everyapp/session` sets `__Host-everyapp_s`; `app_host_sessions` cascading from `sessions`; `HostSessionAuthenticator`; `crossSubDomainCookies` removed; `getSafeReturnTo` against the registry; `/__everyapp/home`; strip CORS credentials and reserved `__Host-everyapp_*` Set-Cookie; mobile shell cookie host-only; `gatewayHome.ts` in three apps; reserve impersonating org keys/app ids (`everyapp`, `app`, `admin`, `login`, `auth`, `api`, `www`); PSL PR opened. | H3, H7, D1 | 4 | Default: both modes switch (one redirect per app per session). If the founder keeps the shared cookie on self-host, this becomes a hosted-only policy branch (+0.5 d) |
| H9 | **Open sign-up, personal orgs, org lifecycle** | Open sign-up under policy (invite token still validated when present); `session.create.before` accepts pending invitations else creates a personal org + owner membership in one `db.batch`; slug + 6-char suffix; random-suffix org keys assigned at org creation; `emailVerification` via `sendEmail.ts`, `requireEmailVerification`, `requireEmailVerificationOnInvitation`, `/verify-email`; Better Auth captcha plugin (Turnstile) on sign-up/sign-in/reset/social; disposable-domain block; `/64` + ASN + global daily sign-up and org-creation budgets in `rate_limit_counters`; `createOrganization` server fn with `orgLimit`; `leaveOrganization`, `transferOwnership`, `deleteMyAccount`; social providers Google + GitHub with the mobile handoff generalized; Autumn `customers.get_or_create` hook (stubbed until H13); email per D15: one escaped template module (layout, `escapeHtml` on every value, text part, footer with "why you got this" and the abuse link) used by reset, invitation and verification; org-name validation (length, no URLs, no `<>`); invitations only from verified users with a per-org daily budget in `rate_limit_counters`; `E_RECIPIENT_SUPPRESSED`/`E_DAILY_LIMIT_EXCEEDED`/`E_RATE_LIMIT_EXCEEDED` mapped to typed errors with UI copy; `allowedSenderAddresses` on the binding; Terms and Privacy acceptance stamped on `users` (`terms_version`, `terms_accepted_at`) at sign-up and invitation acceptance. | H6, H7, D15 (sender onboarded, `mail.everyapp.com` DNS, see H28 ops) | 6 | Off under `self_hosted`; the escaping fix applies to both modes |
| H10 | **Deploy service Worker and `packages/cf-rest`** | `apps/every-app-deployer` (no routes, `workersDev:false`) holding the CF token; service binding from the gateway with `{orgId, actor}` props; `packages/cf-rest` extracted from PR #257 (`client`, `errors`, assets session, dispatch-script multipart PUT, settings PATCH, secrets-bulk, tags, delete-by-tag, D1 create/delete/query with `{batch}`/params, bookmark/restore); `AppDeployer` DO per `{orgId}:{appId}` as the lease and state machine with SSE progress; `deploy_jobs`; R2 bucket for staged artifacts with lifecycle; `buildUserWorkerMetadata()` from manifest + registry only (allowlist; refuses `service` except ours, `dispatch_namespace`, foreign DO/D1/KV ids, `ratelimit`, `secrets_store_secret`, `mtls`, `vpc_*`, `ai`; `cache_options` off; `exports[*].cache` stripped; `tail_consumers`/`logpush` ours); `limits`, `observability` per plan, `tags`; post-upload `GET .../bindings` deep-equal or delete + alert (`props` is not echoed, so the service binding is emitted exactly as wrangler does and trusted); takedown v1 (disable → content stub → min limits → revoke grants → audit); dispatch namespaces created; `DISPATCHER` binding + `Outbound` entrypoint + compat date bump to ≥ 2025-11-17 in the hosted gateway config (qualified #18, #48); `CfApiBudget` DO: one token bucket per Cloudflare principal fed by the `Ratelimit` response header, priority lanes takedown > interactive install > deploy > fan-out > poller, never sends a call that would 429 (a 429 blocks every call for 5 min); `observability` forced per plan (Free/Verified: invocation logs only or `head_sampling_rate` ≤ 0.01); the binding allowlist also refuses `send_email` and `ai`. | H0 (decides the gateway binding shape), H7, H27 (ships it) | 7 | None |
| H11 | **Tenant-neutral builds, `everyapp bundle`, policy in perimeter** | `everyAppWorker()` production emits placeholders, id-less D1/KV shapes, no gateway props, no identity values; `.everyapp/deploy.json` and `deployInputs.ts` (SDK and CLI) deleted: the neutral build needs no inputs, so the first draft's "deploy inputs schema 2 `target`" is unnecessary; `patchAppBuildOutput()` (sibling of `patchGatewayBuildOutput`) fills Worker name, D1/KV ids, Workflow names, identity text bindings and gateway props for self-host and refuses any surviving placeholder; `appPolicyProblems`, `exportProblems`, `validateWorkerConfig` moved to `@every-app/perimeter/policy` with a hosted profile (self-host profile runs on the patched output, hosted on the neutral one); `everyapp bundle` writes `bundle.json` (evaluated manifest, `sdkVersion`, `protocol`, `buildOutputVersion`, source) + `output/v0` + `migrations/`; `readBuildOutput()` from `@cloudflare/build-output-utils`. Self-host files: SDK `cloudflare/worker.ts` (+ test); CLI `lib/app/{buildApp,patchAppBuildOutput,workflows,resources}.ts`, `lib/app/policy.ts` → perimeter, `commands/app/deploy/deployApp.ts` (build/provision/deploy steps), `lib/cfDryRun.test.ts`, `cf-dry-run.yml` comment. | none | 3 | Self-host switches to the patched neutral build; same `cf deploy --prebuilt` |
| H12 | **Hosted deploy API and CLI target** | Better Auth `device-authorization` plugin; **no `login` verb**: the first hosted command that needs a token runs the device flow itself (under `--json`: `action_required authorize_device {verificationUri, userCode}`); the plugin returns a full account session (`routes.mjs:455-473`), which the CLI immediately exchanges at `POST /api/v1/cli/tokens {organizationId}` for an org-bound `epat_` (`deploy`, `apps:read`, 30 days, dies with membership) and then signs out; stored per host in `${XDG_CONFIG_HOME:-~/.config}/everyapp/hosted-tokens.json` (0700/0600); `everyapp logout [--gateway]` (hosted-only) revokes and forgets; CI uses `EVERYAPP_TOKEN` + `EVERYAPP_GATEWAY_URL` and stores nothing; deploy keys = PATs with `appRowId` + `deploy` scope ("Apps → Deploy keys"); routes `POST /api/v1/orgs/{org}/apps/{app}/deploys`, `PUT /deploys/{id}/artifact` (streamed to R2, authoritative policy, refuses `protocol < MIN_PROTOCOL` with `SDK_TOO_OLD`), `POST /deploys/{id}/start`, `GET /deploys/{id}/events` (SSE), `PUT\|DELETE\|GET .../secrets` (dispatch apps: WfP secrets API, a new version of the live code, `keep_bindings: ["secret_text"]`; platform-tier installs: `app_secrets`, H20; `secret set` says on its first line whether code comes from `cwd` or stays live; `--for gateway` refused on hosted), `DELETE .../apps/{app}?purge=1`, `GET /api/v1/catalog/{slug}`, `POST .../apps` with `forkOf` (H32); D1 migrations over REST with bookmarks and cf's `d1_migrations` naming; CLI hosted branch chosen locally by `lib/target.ts` (`EVERYAPP_TOKEN`, a hosted host in `--gateway`/`EVERYAPP_GATEWAY_URL` with staging hosts from `EVERYAPP_HOSTED_HOSTS`, or a stored token), never calling `ensureCfAuth`, `resolveAccount` or discovery; `cf` only for `build`/`workers types` (whether they run with no login is R44); build neutral, bundle, direct asset upload with the session JWT, follow SSE; a one-paragraph "Hosted target" note in `docs/cli-redesign.md` §1 (ADR-0003 Decision 5 already gives hosted its own credentials). | H10, H11, H30 (floor) | 5.5 | Self-host CLI path untouched; no HTTPS call to choose the target |
| H13 | **Billing core: `OrgWallet`, Autumn, the meter hook** | `OrgWallet` DO (snapshot, holds with TTL, `usage_events`, outbox, alarm flush with `Idempotency-Key = orgId:flushId`, `async:false`, `overage_behavior: overflow`, $0.05 chunks, refresh-before-refuse with a 1.5 s budget, fail closed 503 `billing_unavailable`); raw Autumn client pinned `x-api-version: 2.6.0` (no `autumn-js` in the bundle); `autumn/autumn.config.ts` catalog as code in sandbox `everyapp` (`platform` group Free/Pro, `apps` entity feature, `compute_usage`, top-up retargeted to `usage_credits`, usage alerts 80/100%); `afterCreateOrganization` → `customers.get_or_create` + prewarm; `entities.create` on an app's **first metered call** (from `OrgWallet`), `entities.delete` on tombstone, and only after a plan-version migration grants `apps` (attribution through `properties.app` until then); alert at 8,000 Autumn customers + entities; per-app caps live in the DO only (entity `usage_limits` do not clamp overflow tracks, qualified #36); two-pool tracking (`usage_credits`, then `topup_credits`) by credit-system id with `properties.{app, feature, provider}`; live provider keys only with live Autumn (`platformPolicy`), else provider sandboxes or invite-only (D5); `/api/billing/autumn` webhook (svix port) → `refresh()`, created in the live env next to OpenSEO's and refreshing only imported orgs; `BillingPort` with `NoopBillingPort`; price catalog + per-provider markup table (1.28×); `max_tokens` clamp; reserve before upstream, settle in `waitUntil` with 402 `{code: insufficient_credits \| app_budget_exceeded, billingUrl}`; `usage_daily` rollup; Loops lifecycle port (spec 0015) behind the status mirror; `AUTUMN_SECRET_KEY`, `AUTUMN_WEBHOOK_SECRET` declared. | H5, H7, H0b, D4, D5 | 5.5 | `NoopBillingPort`; usage page works, no Autumn |
| H14 | **Grants and capabilities** | Manifest `capabilities` map + `meters` replacing `providers`/`ai`/`integrations` (no backcompat); `app_capability_grants` with POC `effectiveGrant`/`statusForRequest` generalized over pack dimensions; `syncAppRequests` at `markDeployed`; implicit catalog grants; Admin → Apps approval UI (port POC `routes/admin/integrations.tsx`); `capabilities()` RPC; typed errors `grant_pending {approveUrl}`, `budget_exceeded {scope, resetsAt, raiseUrl}`, `out_of_credits {billingUrl}`, `needs_account {connectUrl}`; org policy ceilings (`org_policies`: allowed models, blocked providers, tool-risk overrides that only tighten); per-mode rule (public gets no platform-paid providers); per-isolate grant cache. | H7, H5 | 4 | Self-host auto-approves AI providers for admin deployers, so `providers: ["openai"]` keeps working as `capabilities.openai` |
| H15 | **Gateway scheduler for dispatch apps** | `app_schedules` written at deploy; hosted gateway cron `* * * * *` alongside `17 * * * *` (which version runs `scheduled` during a split deployment is R41, so claims must be idempotent); due pairs → `getAppFetcher` → `POST /__everyapp/scheduled` with JWT `chan=cron`; perimeter refuses the path from outside; SDK `everyApp()` routes it to `scheduled()`; fan-out **always** through a Queue, ≤25 dispatches per consumer invocation (a request may invoke at most 32 Workers; whether dispatch counts is R30); per-org minute jitter for hourly-or-slower catalog schedules (RepoLens's `17 */6 * * *` would otherwise fire for every org on one tick). | H1, H10 | 2 | Self-host keeps native crons |
| H16 | **Egress, plan limits, usage poller** | `Outbound` entrypoint: default-deny with the manifest `egress` allowlist (admin-approved) passed as an outbound parameter, always deny `api.openai.com`, `openrouter.ai`, `api.dataforseo.com`, `gateway.ai.cloudflare.com`, log to Analytics Engine; `limitsFor(plan)` on every dispatch and in metadata; usage poller (deployer cron) over `workersInvocationsAdaptive` and `durableObjectsPeriodicGroups` per script (one GraphQL query per namespace per window grouped by `scriptName`; GraphQL allows 300 queries / 5 min on top of the API budget, so never per org) plus Workers Logs events per script → budget → auto-disable at ~10× with owner notification (this is also the guard for Verified's one DO class, D3); per-hostname public-route limiter `pub:<worker>:<ip>` + daily per-app budget. | H10, D3 | 3 | None |
| H17a | **Platform tier wiring** | `tier='platform'` end to end: shared catalog Workers (`everyapp-cat-<id>`) on the service-binding path, `APP__<worker>` bindings emitted by the H27 patch profile from `readDesiredState` filtered by tier, props `{appId, workerName, trust:"catalog"}`, org from the identity JWT else `x-everyapp-org` checked against an install row, `org_source` recorded; an install row per org (`apps` with `tier='platform'`, `catalog_app_id`) created instantly (no Cloudflare resources); install-scoped background grants; the `trust: catalog` passthrough rule for machine paths with `Authorization` (used by the catalog home host, H38). | H7 | 1.5 | Platform tier does not exist on self-host |
| H17b | **Catalog releases, installs, upgrades** | `catalog_apps` + `catalog_releases` (CI publishes tenant-neutral bundles with asset files to R2 `catalog/{slug}/{version}/`, sha256, `minGatewayVersion`, `source_repo`/`source_tag`/`source_commit` per release, `forkable` computed at publish by the dispatch-tier validator: false for OpenSEO); **lazy install on first open**: perimeter interstitial on a catalog host with no `apps` row (entitlement: plan + verified email) → `POST /api/v1/orgs/{org}/catalog/{slug}/install` reusing `AppDeployer` with `source=catalog` (gateway uploads assets from R2) → SSE → redirect; `apps` row `provisioning → active`; launcher lists `catalog_apps` by plan, not `apps` rows; warm pool of pre-migrated D1 per catalog app (N = 25, opaque names, ledger maps by UUID; deployer cron refills; every release with a migration migrates the pool); `catalog_apps.auto_install` (default false) runs the same job at sign-up for new orgs; upgrade fan-out over **installed apps only**, via Queue with canary waves (our org → 10% → all), paced by `CfApiBudget`, `keep_assets: true` when the asset manifest hash is unchanged (2 calls per install), pinned across majors, expand-only migrations within a major, never into forks; uninstall/org-leave via `DELETE ...scripts?tags=org-<id>:yes` + ledger deletes; drop `kv` from todo/chef/workout/template; chef moves to `capabilities.openrouter` (D6) or stays uninstallable on hosted. | H10, H12, H17a, D2 | 5 | Catalog bundles also serve self-host installs (same artifact, `cf deploy --prebuilt`) |
| H18 | **DataForSEO pack, billing endpoints, OpenSEO `everyapp` mode** | Gateway: `/v1/dataforseo/...` pack (Basic auth, `metering: "hold"`, hold from `x-everyapp-hold-usd` clamped by pack bounds, head-parsed top-level `cost` which is "total tasks cost, USD" and sits ~200 bytes in on every docs example though key order is not guaranteed (R12), 0 on `task_get`, deny `tasks_ready`/`id_list`/`user_data`, `broker_refs` task-id ownership; note that DataForSEO auto-refunds SERP `depth` overshoot to the balance and the refund never appears in any `cost` field, so settling at `task_post` cost over-bills by that refund exactly as OpenSEO does today, qualified #26); `ProviderGate` DO (`dfs:db_live` semaphore of 30 with ≤10 per org and 120 s lease TTL; `dfs:google_ads_live` 12/min bucket with ≤4 per org and idle borrowing; ≤2 s queue then 429 `provider_busy` with `Retry-After`; DataForSEO's own concurrency refusal mapped to the same error); `DATAFORSEO_ENV=sandbox` default until live Autumn; separate hosted DataForSEO login until the cutover; `appendix/user_data` balance-watch cron every 10 min with a pack-wide 503 `provider_unavailable` at zero; `/api/billing/{status,holds,settle,release,track}` behind the caller check + SDK `gatewayBilling()`; manifest `billing.features`; `resources.r2`, `resources.browser`. OpenSEO (separate repo PR, additive): `everyapp` auth mode with a vendored verifier; shadow `user`/`organization`/`member` rows upserted from the JWT (authorization from claims only; team, invite and ownership UI hidden in `everyapp` mode); MCP off in the Every App deployment; GSC/GA callbacks relayed through `app.openseo.so` by `state` prefix (Google requires exact redirect URIs); `getBillingMode()`; DataForSEO transport through the gateway (~60 lines in `core.ts`/`client.ts`); SAM via `createOpenRouter({baseURL, fetch})` with the gate and chunked tracking deleted; gates via `status()`; rendering holds via gateway holds; `everyapp.config.ts`; an `everyapp` alchemy stage in the hosted account (`open-seo` + `open-seo-audit` with `DATABASE_PROVIDER=d1`, new R2, Workflows, service binding to `AppGateway` with props, no `AUTUMN_*`/`DATAFORSEO_*`/`OPENROUTER_*`/`LOOPS_*`/`DUB_*` secrets); a `catalog_apps` row with `auto_install` on for OpenSEO; tests. | H13, H14, H17a | 5.5 gateway + 7 OpenSEO (+1 deploy stage) | Gateway: packs proxy with operator keys, unmetered; `ProviderGate` off by flag. OpenSEO: `everyapp` mode runs on self-host Every App too (needs the companion-Worker extension or the merged audit Worker) |
| H19 | **Billing UI, usage pages, Admin, ops console** | `/billing` ported from OpenSEO (plan, balances, top-up $10-$99, portal, fix-payment, YC promo; owner-only writes); usage by app/feature/user from `usage_daily`; per-app budget editor → `entities.update usage_limits` + `refresh()`; Admin → Apps grants; Agent activity page over `mcp_tool_calls` (admins: org, members: own); `ops.everyapp.com` behind Cloudflare Access with `OPS_EMAILS` (list orgs/users, ban/unban, suspend org, usage), every action to `audit_events`. | H13, H14, D10 | 4 | Admin pages work; billing page hidden without Autumn |
| H20 | **Secrets at rest, per-org OpenRouter keys, AI Gateway backstop** | Envelope encryption (`organization_data_keys`, `app_secrets`, AAD = org\|app\|name\|version, KEK rotation job); gateway-held integration tokens and sub-keys moved onto it; OpenRouter provisioning: key per org (`limit`, `limit_reset: daily`, `expires_at`), guardrail from `ai.models`, `disabled: true` on takedown, nightly `usage_daily` reconcile; `AI` binding + gateway `everyapp` with `spend_limits` rules (`org_app_day`, `org_day`, `all_day`), `cache_ttl: 0`, `retry_max_attempts: 1`, `cf-aig-metadata {org, app, user, chan}`, `cf-aig-event-id`, payload logging off; daily GraphQL reconciliation with a 2% drift alert; `anthropic` pack (head+tail). | H13, H14, D6 | 4 | Self-host: operator keys only; AI Gateway optional |
| H21 | **Hosted agent v1** | `toolBusDeps()` exported from `runtime.ts`; credential kind `"agent"`, `actorFor` → `agent:<connectionId>`; `EveryAgent extends Think` DO per `${orgId}:${userId}` in the gateway config; `/agents/*` via `routeAgentRequest` with session check, DO-name check and exact-Origin check on upgrade; agent connection row (`client_id = "everyapp:agent"`, first-run consent sheet, redirect columns nullable); tools via `gatewaySurfaceView` + `listTools`/`executeToolCall`; LLM via `handleAuthenticatedAiProxyRequest` as app `everyapp` (metered by H13); chat UI in the home shell (shadcn); SDK `toolsEndpoint` accepts `chan: mcp|agent`. | H3, H13, D11 | 6 | Self-host gets the agent too (operator keys, no wallet) |
| H22 | **MCP governance and efficiency per org** | Org settings `ai_connections`, `max_access`, `allowed_clients`, `pats`, `pat_max_days`; enforced at consent and per request (`org_blocked` branch wired); admin list/revoke of members' connections and PATs; AI-app PAT default scope `mcp:*`; tools cached per `(appRowId, catalogHash)`; skip fresh `touchLastUsed`; audit inserts batched via Queue; `/mcp` rate-limit binding keyed by connection; per-org audit retention + Paid-sized prune + `(org, user, created_at)` index; OAuth KV sweep loops to ~800 ops. | H3, H4, H7 | 4 | Works unchanged (settings default open) |
| H23 | **Org deletion and export** | Owner-only, re-authenticated deletion → `organization_platform.status='deleting'`, apps disabled, connections/PATs/CI creds revoked, Autumn subscription cancelled, wallet flushed; 7-day grace with restore; purge Workflow driven by `app_resources` (scripts by tag with `force`, D1 by UUID, R2 lifecycle, KV prefix, custom hostnames); crypto-shred; tombstones scrubbed but kept; `sessions.active_organization_id` cleared; export job (gateway rows, D1 `export` per app, R2 listing, KV prefix) to a 7-day signed R2 link; `onOrgDeleted`/`exportOrg` SDK hooks; "move to self-host" export format documented. | H7, H10, H13, H20, D12 | 4 | Deletion works on self-host without Cloudflare purge of shared resources |
| H24 | **GitHub Action (v1) and repo-connect builds (v2)** | v1: composite `every-app/deploy` (setup-node, pnpm, `everyapp deploy --gateway` with `EVERYAPP_TOKEN`; `pnpm install --frozen-lockfile` needs the committed lockfile the mirrors carry) with a deploy key; outside-contributor PRs run `--dry-run`. v2: single platform GitHub App (Contents, Pull requests, Checks and Deployments write; **never Administration**, which can delete every repo it is installed on; events, per-client webhook URL, `repository_ids`-narrowed tokens), webhook verify/dedupe/enqueue, `app_sources` + `builds`, `AppBuilder` DO on Sandbox SDK 1.0 (GA; `standard-3`, `enableInternet:false` set explicitly, `interceptOutboundHttps` handlers for npm and the GitHub tarball restricted by method/host/path, container trusts the ephemeral CA, per-org snapshot cache, 15-min cap, logs to R2), previews `<worker>--pr-<n>` with empty D1, outside-contributor approval gate, check runs and Deployments, OIDC, build-minute metering. | H12, H29 (v1); H10, H14, H17b (v2), D9 | 1 (v1) + 13-15 (v2) | v1 Action works against self-host gateways that expose the deploy API? No: self-host has no deploy API by design (ADR-0003); the Action is hosted-only |
| H25 | **Multi-Worker apps** (conditional) | Manifest `workers: [{name, main}]`; bindings allowed only between Workers of one app in one namespace; `app_scripts` child table; pipeline uploads N scripts. Only if OpenSEO or another catalog app must run per org. | H12, D2 | 3.5 | Self-host deploy also uploads N Workers |
| H26 | **BYO custom domains** (later) | Content zone enabled for Cloudflare for SaaS, originless fallback + `*/*` route, `app_hostnames` alias rows, `POST /zones/{id}/custom_hostnames` at deploy with HTTP DCV, TXT pre-validation for cutovers, `onPlatformDomain` allows registered BYO hosts, handoff unchanged. Not a cutover prerequisite: the OpenSEO cutover needs only H40 (one ops-created hostname). | H8 | 3 | n/a |
| H28 | **Email events, legal pages, abuse intake** | Ops (D15): onboard `mail.everyapp.com` for Email Sending on the account holding the zone (R47), Proton MX/SPF/DKIM on the apex, apex DMARC `p=none` → `p=reject`, delete the duplicate `_dmarc.everyapp.dev`, file the Email Sending limit increase. Code: Queue event subscription for `message.bounced`/`message.complained` → `users.email_undeliverable_at` and an org abuse signal for complaints on invitations; landing-page `/terms`, `/acceptable-use`, `/privacy` (hosted; the iOS policy moves to `/privacy/ios`), `/subprocessors`, `/abuse` (Turnstile form → `POST /api/abuse-reports` → `abuse_reports` + a notice to a verified destination); `/.well-known/security.txt` on `everyapp.com` and the content domain; deceptive-names check on app ids and org keys; `docs/runbooks/abuse-and-takedown.md` (phishing/malware: H10 takedown within hours; DMCA notice → takedown → counter-notice → restore in 10-14 business days; repeat-infringer rule; CSAM: disable, report to NCMEC, preserve 1 year); DMCA agent registered; OpenRouter settings (logging off, training opt-out) and AI Gateway `collect_logs: false` confirmed (L11). Writing (D16): Terms, AUP, hosted privacy policy, subprocessor list drafted from OpenSEO's documents. | H9 (stamp), H10 (takedown), D15, D16 | 1.5 code + 2.5 writing | Pages and runbook are hosted-only |
| H29 | **Publish the SDK and the app-developer CLI** | Drop `private`; restore the SDK `prepack`; CLI `prepack` = build + bundled starter (`workspace:*` → `^0.4.0`, standalone `pnpm-workspace.yaml` with the root's `allowBuilds` and security overrides), **no Gateway bundle**; launcher `bin/everyapp.js` runs `dist/` when there is no `src/`; self-host commands keep `CHECKOUT_MISSING` with new words ("self-host runs from a checkout of the repository"); `.github/workflows/publish.yml` (tag `v*`, `id-token: write`, npm ≥ 11.5.1, `pnpm pack` then `npm publish <tgz>`, trusted publishing, no provenance while private: R24); lockstep version 0.4.0 and `SDK_VERSION` generated from `package.json`; deprecate `<0.4.0`; restore the npm update check for the published CLI; RELEASE.md rewritten; root README "An app in its own repository" uses `^0.4.0`; `TODO.md:74` narrowed. | H12 (timing only), D13 | 2 | Unchanged: in-repo apps keep `workspace:*` |
| H30 | **Protocol version and SDK floor** | `PROTOCOL` integer in `@every-app/sdk/internal/protocol.ts` (folds in `TOOLS_PROTOCOL_VERSION`); `bundle.json` stamps `sdkVersion`/`protocol`/`buildOutputVersion`; the hosted deployer refuses below the floor (`SDK_TOO_OLD` + the `pnpm up` to run); self-host `deploy` checks `MIN_SDK_VERSION` (closes `TODO.md:32`); `app_versions.sdk_version`/`protocol`; a test pinning the protocol module's exports to `PROTOCOL`; H2's `aud` change can mint `aud: [workerName, appId]` for one window if jose accepts an array `aud` (R27). | H11 | 1 | Self-host gains the SDK floor check |
| H31 | **Catalog source mirrors** | Catalog CI step beside H17b's bundle publish: copy `apps/<app>`, rewrite `workspace:*`, write the standalone workspace file, generate and commit `pnpm-lock.yaml`, add LICENSE and a "This is a fork" README section, drop KV/hosted-refused resources, commit to `every-app/app-<slug>` as "Todos 1.4.0 from private-every-app@<sha>", tag `v1.4.0`; `source_repo`/`source_tag`/`source_commit` on the release; `forkable` computed at publish; if D13 keeps sources private, serve the same history as a git bundle from `GET /api/v1/catalog/{slug}/source.bundle` behind org auth (+1 d). | H17b, D13 | 1.5 | n/a |
| H32 | **`everyapp fork` and `forked_from`** | `everyapp fork <catalog-app> <new-app-id>`: check the caller (hosted token, admin/owner, plan allows custom code else `PLAN_REQUIRED {billingUrl}`) → `GET /api/v1/catalog/{slug}` (`forkable`, `sourceRepo`, `tag`, `releaseId`, `capabilities`) → `git clone --origin upstream --branch v1.4.0` → rename via `updateEveryappManifestId`/`updatePackageJson` → `POST /api/v1/orgs/{org}/apps {appId, forkOf}` (registered before any deploy, so the slug is reserved and lineage is server-side) → admin "approve as upstream" prompt → install, `cf workers types`, local migrations; `source='fork'`, `forked_from_release_id`, `kind-fork` tag, catalog ids reserved per org; upstream notice in `everyapp status` and the control plane ("Fork of Todos 1.4.0, 1 release behind"); self-host copy variant (`pnpm everyapp fork todo my-todo` copies `apps/todo-app` to `apps/my-todo`, no lineage, 0.25 d). | H7, H12, H14, H31 | 2 | Copy variant only |
| H33 | **Fork to GitHub and upstream PRs** (v2) | Dashboard "Fork": pre-filled `https://github.com/new?owner=<gh-org>&name=<app>&visibility=private` link (R26), install-selection check, `AppBuilder` push job with the installation token injected by an outbound handler (`Contents: write`), `app_sources.upstream_repo`/`upstream_ref`; a Queue job per catalog release that pushes `everyapp/upstream-v<x>` and opens a PR into each fork's production branch with release notes and the capability diff ("requests `openrouter`; stays pending after merge until an admin approves"); security-flagged releases (banner, email, `security` PR label). | H24 v2, H32 | 4 | n/a |
| H34 | **Eject in place** (v2) | Convert a catalog install into a fork keeping its row, Worker name, D1 and DO namespaces; the deployer checks the fork bundle's migrations extend the installed release's applied `d1_migrations`; fan-out exclusion; implicit catalog grants become explicit grants approved by the ejecting admin. | H17b, H32 | 2 | n/a |

### Phase 3: OpenSEO cutover (DROPPED 2026-10-15: `app.openseo.so` stays as is; the Every App OpenSEO is a separate deployment. Kept for the record.)

Gates: the tier-0 set shipped, H8, H13 live, H19 (portal, fix-payment,
top-ups, YC promo), the wallet on **live** Autumn for Every App orgs for ≥4
weeks with daily reconciliation inside 2%, and D7's OpenSEO account choice
confirmed. Rollback is lossless until H41, because ids, the Postgres
database and Autumn customers are shared by both modes. Lanes: H35 ∥ H36-H37
∥ H38 ∥ H39-H40, then the runbook. `raw/r2-openseo-cutover.md` §3.5.

| # | Title | Contains | Depends on | Size | Rollback point |
|---|---|---|---|---|---|
| H35 | **Identity export and import** | OpenSEO `scripts/export-identity.ts` (NDJSON: `user`, `organization`, `member`, pending `invitation`, `account` rows with `provider_id IN ('credential','google')` and Google tokens nulled; not `session`, `verification`, `apikey` or GSC/GA grants; read-only against prod). Gateway `scripts/import-openseo.ts`: chunked D1 SQL with `INSERT … ON CONFLICT DO NOTHING`, an `import_batch` tag, a dry-run diff (counts, email and slug collisions, unique-index violations), `organization_keys` (random suffix), `organization_platform`, `billing_customers` (`autumn_customer_id = organizations.id`), an OpenSEO install row per org (`tier='platform'`), copied `billing_customer_status`, `last_active_organization_id` into H3's column, timestamps `timestamptz` → ms. OpenSEO ids win on collision (hosted prototype data is disposable). Rehearse against a PlanetScale branch and a scratch D1; one rehearsal sign-in confirms the hash compatibility. | H7, H17a | 2 | `DELETE … WHERE import_batch=?` (lossless until imported users sign in on the gateway) |
| H36 | **Cutover-safe billing (OpenSEO)** | `getBillingMode()` per deployment; the audit Workflow settles payload Autumn locks through Autumn and gateway holds through the gateway; `AUTUMN_SECRET_KEY` kept on the audit Worker until the last `render_` lock (≤24 h) has expired; webhook handler unchanged. | H18 OpenSEO part | 0.5 | Revert |
| H37 | **MCP and OAuth in `everyapp` mode (OpenSEO)** | `/authorize` consent reads the user from the gateway identity through the handoff on `app.openseo.so`; `oseo_` keys and `OAUTH_KV` grants unchanged (same ids); tool calls bill through the pack with `x-everyapp-org` from token props, checked against installs. | H36, H17a | 1.5 | Revert |
| H38 | **Catalog home host** | `app_hostnames.kind='catalog_home'` (not org-bound); machine-path passthrough with `Authorization` for `trust:catalog` only (`/mcp`, `/.well-known/oauth-*`, `/authorize`, `/token`, `/register`, `/oauth/*`, `/api/gsc/oauth/callback`, `/api/ga4/oauth/callback`); every other path 302s to `openseo-<orgKey>.<content>/<path>` (org = owner of the project in the path via an RPC to OpenSEO, else the user's last-active org with OpenSEO installed); `www.app.openseo.so` likewise; reserved `__Host-everyapp_*` cookies still stripped; tests. | H8, H17a | 2 | Remove the hostname row (traffic falls back to the old Worker if DNS is reverted) |
| H39 | **Move OpenSEO prod into the hosted account** (D7) | Hyperdrive in the hosted account (same PlanetScale); R2 `open-seo` copy; `OAUTH_KV` bulk copy (list/get/put; validity after copy is UNVERIFIED); `every-super-seo` KV dropped (caches, Dub pins); Workflows drained (no new audits 1 h before; `reconcileStaleAudits` reaps); `SamChatAgent` storage abandoned (SAM hidden since 2026-10-01); `AuditScratchpad` disposable by design; Alchemy `hosted-prod` stage re-pointed; old resources retained (`RemovalPolicy.retain`). | D7 | 2.5 + drain | Old account resources intact; point DNS back |
| H40 | **H26-lite: one ops-created hostname** | Content zone SaaS-enabled, originless fallback, `*/*` route (O2O affects which route pattern matches), one custom hostname `app.openseo.so` (+ `www`) with TXT pre-validation, zone-hold check (`hold: true, include_subdomains: false` should allow a subdomain, R38), the existing Workers Custom Domain removed first, CNAME flip. A Workers Custom Domain on the gateway instead, if the `openseo.so` zone ever moves. | H8 | 1 | Delete the custom hostname; restore the Workers Custom Domain |
| — | **Cutover window (~1 h, runbook)** | (1) Email users 7 days and 1 day ahead ("sign in once; same password or Google"). (2) Freeze sign-ups on `app.openseo.so`. (3) Delta export and import (H35). (4) Prewarm `OrgWallet` snapshots (`customers.get` per imported org). (5) Gateway webhook live in the live env (created earlier). (6) Deploy OpenSEO `everyapp` mode to prod. (7) Flip `app.openseo.so`. (8) Smoke: password sign-in, Google sign-in, MCP OAuth refresh with an old grant, an `oseo_` key, a GSC callback, a DataForSEO call with hold and settle, a running audit settling an old lock, a portal link, a top-up. | H35-H40 | 0.5 prep | **Lossless until H41**: DNS back, redeploy `AUTH_MODE=hosted`; let the wallet outbox flush first |
| H41 | **Delete Autumn mode (OpenSEO)** | ≥24 h after the window (after the last `render_` lock expired): the ~5.6k lines listed in `openseo-fit.md` §2.5, `AUTUMN_*` secrets removed, OpenSEO's Autumn webhook deleted. | window + 24 h | 1 | Point of no return for one-command rollback (a revert restores it, ~0.5 d) |
| H42 | **Billing cleanup** | `apps` feature by plan-version migration, then entities; optional `topup_credits` fold via idempotent `balances.create` per customer (or let them drain); org-level `usage_limits`. | H41 | 1 | Revert |

**Totals.** Phase 0 about 3.5 d; phase 1 about 13 d; phase 2 core (H7-H23
with the size changes above, plus H27 and H28) about 84 d; forks and
publishing add about 6.5 d (v1: H29-H32) and 6 d (v2: H33-H34); with the
GitHub Action, v2 builds, multi-Worker and BYO about 125 d; Phase 3 (OpenSEO
cutover) is about 11 d plus a drain window and the email lead time, gated as
above. Independent lanes after H7: {H27}, {H8, H9 → H28}, {H10 → H12, H15,
H16, H17a → H17b}, {H11 → H30}, {H13 → H14 → H18, H19, H20}, {H21, H22},
{H23}, {H29 → H31 → H32}. With parallel agents the calendar time is a
fraction of the day count.

**The first outside org** (security's "tier 0") needs at least H0-H0b, H1-H6,
H7, H27 (nothing deploys the hosted control plane without it), H8, H10, H12,
H13 (ceilings and holds), H14 (grants), H16 (egress and limits), the takedown
in H10, H29-H30 (the SDK and CLI on npm with a version floor; without them no
one outside the checkout can build anything), and H28's tier-0 subset (Terms,
AUP, hosted privacy policy, subprocessors, `abuse@` and the form, the takedown
runbook, the DMCA agent, OpenRouter's written OK if the org's own code uses
AI): roughly 50 d of the series, up from the first draft's 40.

---

## 6. Risks and unknowns, with the live checks that settle them

### What each load-bearing claim rests on

One page: whether a claim stands on a dated document, on inference from an
API shape or vendor code, or on code read in this repo, and which live check
(§6 table or `live-checks.md`) closes the gap. "Settled" means every verifier
confirmed it and no check is needed.

| Claim | Rests on | Closed by |
|---|---|---|
| Workflow classes cannot be hosted in a WfP namespace | Dated docs (Workflows limits 2026-09-21), API shape (no namespace field on `PUT /workflows`), wrangler source, a third-party measurement (#13, #24, #29) | Settled |
| A user Worker can bind via `script_name` to a Workflow hosted in a platform Worker and `.create()` it | Inference from the dispatch upload schema (#10, #16, #44) | R2 |
| Crons unsupported on dispatch scripts | Cloudflare staff statement 2026-05-11, wrangler source, API path list (#5, #15, #30) | Settled (R3 confirmatory) |
| Queue consumers cannot be namespace scripts | Inference from the consumer API body (#49) | R4 |
| A user Worker's `service` binding with `entrypoint` may target an account Worker | Dated docs (dispatch upload schema; no namespace qualifier) (#4, #12, #17) | Settled as to schema; R1 exercises it |
| `props` on that binding arrive as `ctx.props` | Inference (wrangler sends it; works on regular Workers; in no OpenAPI schema anywhere) (#4, #8, #12, #28, #47, #53) | **R1** |
| Dispatch-props RPC stubs are request-scoped; `ctx.exports` needs compat ≥ 2025-11-17 | Dated docs 2026-09-16, 2026-10-12 (#7, #9, #18, #48) | Settled |
| Outbound Workers miss DO and mTLS fetches, disable `connect()` | Dated docs 2026-04-21 (#7, #31, #52) | Settled |
| Cookie tossing fixates a session via a longer `Path` and better-call's first-wins parser | RFC 6265 §5.3-5.4 + vendor code (`better-call@1.4.0/dist/cookies.mjs:33`) (#0, #40) | **R6** |
| 100 Custom Domains/zone; Universal SSL one wildcard level; SaaS wildcard Enterprise-only | Dated docs + live certificate-pack read on the account (#1, #41, #42) | Settled |
| PSL private section: no SLA, likely declined at small scale | Dated wiki 2025-05-23 (#3, #43) | R14 |
| Deploying bindings needs only Worker Editor; no namespace token scope; Secrets Store the exception | Dated docs 2026-09-15, 2026-10-12, 2026-06-29 (#54) | R43 (whether script creation needs product Admin) |
| KV 1,000 (not documented raisable); D1 50,000 and 1 TB raisable, 10 GB not | Dated docs 2026-10-08, 2026-04-21 (#14, #19, #21) | R17 (turnaround of the increase) |
| API 1,200 / 5 min per user, cumulative; 429 blocks all calls 5 min | Dated docs 2026-08-25 | R29 (per-token independence) |
| AI Gateway spend limits: 20 rules, one `limit` per bucket, eventually consistent, priced models only | Dated docs 2026-09-30 + OpenAPI `maxItems` (#32, #50) | R10 (`window` unit, `getLog()`) |
| Unified Billing 200 req/60 s; BYOK exempt only under `default` alias | Dated docs 2026-09-24, 2026-09-30 (#33) | Settled |
| Any Worker with an `ai` binding spends every AI Gateway in the account | Dated docs 2026-06-17, 2026-10-02 (#35) | Settled |
| Autumn `Idempotency-Key` → 409; TTL 24 h default, org-configurable | Docs + Autumn server source (#27, #37) | R11 (exercise once) |
| Entity `usage_limits` do not clamp `track` with `overage_behavior: overflow` | Docs + server source (#36) | H0b (exercise once) |
| `track` async by default on 2.5.0; `async:false` returns the balance | Dated changelog 2026-10-12 (#38) | Settled |
| Autumn passes `application_fee_percent`/`transfer_data` to Stripe | Server source + unit test (#39) | Settled (unused until payouts) |
| OpenRouter `usage.cost` always present; location differs per endpoint | Dated docs (#11, #34) | R13 |
| OpenRouter provisioning-key `limit` is server-enforced | Docs (#51) | R13 (402 vs 403) |
| DataForSEO top-level `cost` is the billed USD, 0 on `task_get`, ~200 bytes in | Docs examples only; key order not guaranteed; refunds invisible (#26) | **R12** |
| Workers Builds unusable; build token readable by tenant build | Dated docs; the token exposure is inference (#45) | None (not used) |
| Sandbox SDK 1.0 GA, `enableInternet` false by default | Dated docs 2026-09-30 + npm (#46) | Settled |
| Per-org connector URLs need no `workers-oauth-provider` change | Vendor code (1.2.3 dist) (#20) | Settled |
| D1 single-threaded; 6 statements per tools/call | Dated docs + repo code (#21) | R22 (load) |
| OpenSEO password hashes verify on the gateway unchanged | Vendor code in both trees (`@better-auth/utils@0.4.2`) | H35 rehearsal sign-in |
| WfP user scripts unlimited, $0.02 after 1,000 | Dated docs 2026-10-13, 2026-04-21 | R18 (invoice) |
| Lazy first-open install fits p95 ≤ 10 s | Inference (no documented D1-create or `PUT` latency) | **R28** |
| `DISPATCHER.get().fetch` does not count toward the 32-invocation cap | Unverified | **R30** |
| npm trusted publishing works from the private repo | Docs imply (no provenance) | R24 |
| Email Sending's new-account daily quota carries sign-ups | Docs say only "conservative" | R45 |
| `cf workers deployments create` does not trip cf's strict-mode abort | Inference from cf beta.14 code | R40 |
| A WfP secret PUT is live at once and survives `keep_bindings` | OpenAPI wording ("creating a new version") | R44 |
| Autumn's sandbox checkout accepts Stripe test cards | Inference (it is a Stripe Connect sandbox) | R33 |
| `app.openseo.so` custom hostname activates under the zone hold | A SaaS provider guide | R38 |

### The table

| # | Risk or unknown | Status today | Live check | If it goes the wrong way |
|---|---|---|---|---|
| R1 | A WfP user Worker can carry an upload-time `service` binding with `entrypoint` and `props` to `every-app-gateway`/`AppGateway`, and `ctx.props` arrives | `service` + `entrypoint` in the dispatch schema and no WfP page forbids an account-Worker target (verified #4, #12, #17, #28, #47, #53); `props` undocumented for every upload path, wrangler sends it, `GET /bindings` does not echo it (qualified, same claims) | Upload a one-line namespaced script with that binding; call it via `DISPATCHER.get`; log `ctx.props` in `AppGateway`; also `GET .../bindings` to confirm `props` is absent from the read | DO alarms on the dispatch tier (the only background path that exists in WfP) need a per-app HMAC credential (weaker); brokered KV falls back to a DO shim; H10 builds a different binding set |
| R2 | A user Worker can bind via `script_name` to a Workflow hosted in a platform Worker and create instances | Hosting a Workflow class in the namespace is settled unsupported (verified #24, #29; #13 refuted); the cross-script binding is schema-permitted and the two docs pages reconcile on it, runtime unverified (qualified #10, #16, #44) | Upload a user Worker with `{type:"workflow", workflow_name, script_name:"<platform worker>"}`; call `env.WF.create()` from the user Worker; also `cf deploy --dispatch-namespace` with the binding | Dispatch apps have no Workflow access at all; background work for them is DO alarms and the gateway scheduler only. If it works, dispatch apps can call platform-hosted Workflow classes; OpenSEO stays on the platform tier regardless |
| R3 | Cron Triggers on dispatch scripts | `verified` unsupported (staff 2026-05-11; no `/schedules`) | Try `triggers` in dispatch upload metadata | If accepted, H15 shrinks to writing schedules; props still do not reach cron work |
| R4 | Queue consumers as dispatch scripts | inferred unsupported | Consumer create API with a namespaced script | If supported, org apps could own queues |
| R5 | WebSocket 101 through `DISPATCHER.get().fetch` | `unverified` | Deploy todo (`UserSyncDO`) to the test namespace; open a socket through the gateway | Realtime apps (SAM, todo sync) need the platform tier |
| R6 | Cookie tossing fixates a Better Auth session via a longer `Path` (better-call 1.4.0 keeps the first occurrence; RFC 6265 §5.4 lists longer paths first) | derived from RFC 6265 + `better-call@1.4.0/dist/cookies.mjs:33`, not reproduced; the first draft's "last duplicate wins" is wrong (qualified #40) | Two-tab browser test (H0a): tenant page sets a `Domain=<base>` session cookie copied from the attacker's session, first with `Path=/` (expected: victim's cookie still wins) then with `Path=/api/auth` (expected: `/api/auth/get-session` returns the attacker's account) | If neither variant reproduces, scheme A is viable on CSRF grounds alone; bombing, reputation and BYO still argue for C. The duplicate-name refusal in H4 holds either way |
| R7 | Assets upload-session JWT works from a client other than the one that opened the session | `unverified` | Open the session from the gateway, upload from the CLI with the JWT | Asset bytes route through the gateway (as catalog installs do anyway) |
| R8 | D1 REST multi-statement `sql` is atomic on failure | OpenAPI says "executed as a batch"; atomicity on failure unstated | Run a file + `INSERT INTO d1_migrations` where the file fails mid-way | Migration bookkeeping needs explicit transactions or per-statement checks |
| R9 | Script-level `metadata.limits.cpu_ms` is enforced on DO alarms and non-dispatched work | not separately documented | Alarm loop in a test user Worker with `cpu_ms: 50` | DO denial-of-wallet has no CPU ceiling; rely on the poller and DO restrictions |
| R10 | AI Gateway `getLog()`/Logs API on a Workers-Logs account; `window` unit; whether OpenRouter via AI Gateway is priced | `unverified` | One gateway in a new account; one `PUT` with `window: 86400`; one OpenRouter call through it | Provisional (price table) cost becomes the final figure for AI Gateway providers; OpenRouter backstop lives only in per-key limits |
| R11 | Autumn: `Idempotency-Key` 409 on `track`; `entities.create` when the plan lacks the `apps` feature; which pool is drawn when `usage_credits` and `topup_credits` both map the tracked feature | 409 and TTL confirmed from docs + server source (verified #27, #37: TTL 24 h default, 1 h-30 d per org, dedup fails open if Autumn's DynamoDB is down); entity `usage_limits` confirmed **not** to clamp overflow tracks (qualified #36), so that part is now a design fact, not a risk; the other two unstated | Sandbox org (H0b): duplicate `track` with one key; `entities.create` on an `onboarding_plan` customer; a customer with both balances, `track seo_data_usage 10`, read both | Outbox needs value reconciliation; entities wait for the plan-version migration (already the plan, D5); the wallet tracks credit-system ids explicitly rather than the feature |
| R12 | DataForSEO top-level `cost` is the billed USD, 0 on `task_get`, and sits in the head of large (Lighthouse) bodies | "total tasks cost, USD" and `cost: 0` on `task_get` verified; all docs examples place `cost` 5th in the header, ~200 bytes in, but DataForSEO guarantees no key order; SERP `depth` overshoot is auto-refunded and the refund never appears in any `cost` field (qualified #26) | Sample a Lighthouse `task_get` body on the sandbox (H0b); record body size and the byte offset of `cost` | Head parser needs a bigger buffer or an endpoint price table; H18 holds settle at `task_post` cost and over-bill by the refund, as OpenSEO does today |
| R13 | OpenRouter includes `usage.cost` on every completed response; its location per endpoint; provisioning key over limit → 402/403 `openrouter_key_limit` | Always-present and no-opt-in verified (#11, #34); chat completions put it in an extra final SSE chunk, `/v1/responses` in `response.completed`, `/v1/messages` in `message_delta` (qualified #34); key limits server-enforced, docs cite both 402 and 403 (verified #51) | One streamed call per endpoint (H0b); one key with `limit: 0.01` spent past the limit; create keys in a loop to find any per-account provisioning-key count ceiling (no doc states one) | Per-endpoint parsers (already planned); backstop only in our ledger; if there is a key ceiling, per-org keys become per-plan keys |
| R14 | PSL private-section acceptance and diffusion time for a small project | "likely declined" per guidelines; no SLA | Submit the PR with the `_psl` TXT record | C stays safe; same-site GET riding and content-domain bombing remain |
| R15 | Safari ITP on a bounce-only control plane; Better Auth can emit a `__Host-` cookie with a custom name | `unverified`; moved to Phase 0 (H0a) because D14 (per-host sessions on self-host too) rests on it | Manual Safari test of the handoff with the control plane visited only by redirect; Better Auth config test for `__Host-everyapp_s` | Re-authentication frequency; `__Secure-` host-only cookie as fallback; D14 may flip to hosted-only |
| R16 | Anthropic egress spread vs the per-IP `/oauth/token` limiter; claude.ai allows two connectors with one URL | plausible, not measured | Observe refresh traffic from `160.79.104.0/21`; add the same connector twice in claude.ai | Keep `/oauth/token` off the IP limiter either way (0.25 d) |
| R17 | D1 databases (50,000) and account storage (1 TB) can be raised in time; turnaround of the increase | D1 limits fn 1-2: by request on Paid/Enterprise, "millions to tens-of-millions"; no SLA on the form (verified #14, #19). KV no longer needs an increase (B1 removes per-app KV) and is not documented as raisable anyway | File D1 count → 250,000 and storage → 5 TB at account creation; record the response time in `live-checks.md`; ask about the API rate limit in the same form | Lazy installs + pool already give ~33,000 Free orgs at 50,000; shard by `cf_account_id` |
| R18 | WfP $25 adds to or replaces Workers Paid $5; purchase needed before API use (error 10121) | undocumented | Buy on the hosted account; read the invoice line | Cost model only |
| R19 | `cf deploy --prebuilt --dispatch-namespace` together with DO `exports`; Build Output v0 stability during the `cf` beta | `unverified`; `cf` warns output can change | One deploy of todo to the test namespace | Pin `cf`; version the bundle schema |
| R20 | `secret_key` binding is non-extractable (KEK in `env`) | in the upload schema, undocumented | Upload with `secret_key`; attempt `exportKey` | KEK as a Worker secret imported with `extractable:false` |
| R21 | `@cloudflare/workers-oauth-provider` 1.2.3 fixes the resource registry per instance at construction | `verified` in `oauth-provider.d.ts:1165-1172`; but per-org connector URLs do **not** need a library change: paths beneath the registered resource (`/mcp/o/<org>`) validate today via path-descendant audience matching, and per-org hostnames can be served by constructing the AS per request or per org-list version with every org's resource listed, reusing `getMcpAuth`'s memoization (qualified #20; upstream has no resolver planned, issue #141 closed "not planned") | None needed; a unit test that `/mcp/o/<org>` validates against the `/mcp` resource when D11 relaxes | n/a: D11's "one connection = one org" is a UX choice, not a constraint |
| R22 | D1 single-writer throughput under hosted load (session + access reads, MCP, audit) | ~1,000 qps at 1 ms per the limits page | Load test the perimeter with `cookieCache` on and off | Per-org D1 for gateway state, or earlier move of audit/ledger off D1 |
| R23 | Cloudflare adds per-value spend-limit overrides or strong consistency to AI Gateway; launches multi-tenant managed Cloudflare OS with billing | watch items | Changelog | A5's budget engine could move into AI Gateway; competitive framing changes |
| R24 | npm trusted publishing works from the private `every-app/private-every-app` repo for public packages; `pnpm publish` does OIDC | docs imply yes, without provenance; `pnpm publish` OIDC not checked | Add a trusted publisher for `.github/workflows/publish.yml`; publish `0.4.0-rc.0` under dist-tag `next` within the 2-day window via `pnpm pack` + `npm publish <tgz>` (npm ≥ 11.5.1); also try `pnpm publish`; `npm access list packages @every-app` to confirm the scope and add a second maintainer | A granular write token (≤ 90 days) in a repo secret, rotated; or publish from a public mirror of `packages/` |
| R25 | A standalone copy of a catalog app builds and runs `everyapp dev` with packed SDK and CLI tarballs | configs read, not built | Pack both; copy `apps/todo-app` to `/tmp`; swap `workspace:*` for `file:` tarballs; add the overrides; `pnpm install && pnpm run build && pnpm dev` | Fix the hidden coupling before H29 (+0.5 d) |
| R26 | The platform GitHub App installed on "selected repositories" can push to an empty repo the user creates and adds; the pre-filled `github.com/new?owner=&visibility=private` link behaves for org members | unverified (v2 only) | Use the PR #281 POC app on a test org; try the link as a member without repo-creation rights | Ask for the "all repositories" install or fall back to the v1 CLI path; tell the user to pick the owner manually |
| R27 | The SDK's jose verification accepts an array `aud` containing the expected audience (dual-audience transition for H2) | unverified | Unit test: mint `aud: [workerName, appId]` with `protocol.ts` minters; verify with `everyApp()` | Transitions need a two-key window or a forced upgrade |
| R28 | Lazy first-open install fits p50 ≤ 5 s, p95 ≤ 10 s | unverified (no documented D1-create or `PUT` latency) | H0 timing run: 50 sequential + 50 concurrent (×10) todo installs from a deployer Worker, with and without a pool D1, per-step wall time and `Ratelimit` after each call; delete by `org-` tag | Prefetch on launcher open or tile hover; if still slow, eager for one "starter" app via `auto_install` |
| R29 | Account-owned API tokens have independent 1,200/5 min budgets | API limits page says "per user/account token" in the table and "per user … cumulatively" in the note | Two tokens issuing calls in parallel; read `Ratelimit` on each | One budget for everything; `CfApiBudget` priorities matter more; ask Cloudflare in the limit form rather than sharding tokens |
| R30 | `DISPATCHER.get().fetch` counts toward the 32-Worker-invocations-per-request cap | undocumented | One gateway request dispatching sequentially to 40 user scripts; watch for the exception at 33 | If it counts, Queue fan-out is mandatory (already the default); if not, the scheduler may dispatch in-process up to the subrequest limit |
| R31 | Asset uploads dedupe across scripts in one namespace | "recently uploaded" files omitted from the session response; scope unstated | Upload the same asset manifest to two new scripts; check that the second session returns empty `buckets` | b = 0 after the first org; otherwise ~1 extra call per install |
| R32 | Control-plane D1 bytes per org (~50 KB static, ~1.5 MB with 30 days of audit) and ~1 ms per query | estimates only | Seed 100 synthetic orgs with a realistic MCP audit; read `GET /d1/database/{id}` `file_size` and `meta.duration` | Audit and ledger off D1 sooner (C5); per-org gateway shards |
| R33 | Autumn sandbox checkout accepts Stripe test cards, so live provider spend could be "paid" with test money | docs: every Autumn org gets a Stripe Connect sandbox | Sandbox `billing.attach` of a paid plan paying with `4242 4242 4242 4242` | Invite-only or provider sandboxes until live Autumn (D5 default already) |
| R34 | `customers.update.new_customer_id` keeps the Stripe link, subscriptions, balances, locks, entities and events | undocumented | Sandbox: a customer with `base-plan`, one lock and one entity; rename; `customers.get` with expand; finalize the lock | Never rename (default already) |
| R35 | Autumn `remaining` is net of outstanding locks; lock expiry and finalize emit no webhook | undocumented | Sandbox: `check` with a lock of 100, `customers.get`, wait for expiry, watch the webhook log | Wallet's first snapshot is briefly conservative; the 60 s active-org refresh covers the release |
| R36 | DataForSEO limits (30 concurrent on DB-backed live APIs, 12/min live Google Ads) apply per account vs per login; the refusal status/error code; rate-limit headers; general 10,000/min vs 2,000/min; the sandbox accepts prod credentials and serves AI Optimization and Lighthouse | help center 15.10.2026 vs undated sandbox page; nothing stated on scope or codes | Email DataForSEO support; fire 35 parallel Labs live calls from one login and record the 31st response; one call each to `llm_responses` and Lighthouse on `sandbox.dataforseo.com` with the prod login | `ProviderGate` per login; separate hosted login stays after the cutover; previews need a stubbed sandbox for those endpoints |
| R37 | A running Workflow instance resumes on newly deployed code | unverified | Scratch Worker: an instance with `step.sleep(2m)` logging a version constant after the sleep; deploy a new constant during the sleep | The 24 h legacy settle path (H36) covers both outcomes |
| R38 | An `app.openseo.so` custom hostname on another account's SaaS zone activates under `openseo.so`'s hold (`hold: true, include_subdomains: false`); O2O traffic reaches the gateway's `*/*` route with nothing on the `openseo.so` zone intercepting once the Workers Custom Domain is removed | provider guide says only "Also prevent Subdomains" blocks a subdomain | Create the hostname with TXT pre-validation on a scratch SaaS zone; read `status`; CNAME a scratch subdomain and curl for `cf-connecting-o2o: 1` | Release the hold briefly, or move the zone (Enterprise; ask the account team, U13) |
| R39 | Adding Every App domains or redirect URIs to OpenSEO's verified Google OAuth client triggers re-verification of sensitive scopes; the Google `sub` is identical across OAuth clients | unverified; mitigated by keeping all redirect URIs on `app.openseo.so` and by implicit linking on verified email | Google Cloud console / support; sign in with one Google account through two clients and compare `sub` | Keep the relay on `app.openseo.so` (default); rely on email linking |
| R40 | After `cf workers deployments create`, the next unattended `cf deploy`/`versions create` aborts on `last_deployed_from: api` | `unverified`; cf beta.14 prompts on `api` | In CI mode: `versions create` → `deployments create` 50/50 → `cf deploy --prebuilt </dev/null` | Gradual steps via `wrangler versions deploy`, or 100% deploys with rollback only |
| R41 | Which gateway version runs `scheduled` (the minute cron) during a split deployment; whether `versions create --prebuilt` ignores routes, domains and crons in the Build Output | `unverified` | Split 50/50 and log `CF_VERSION_METADATA.id` in `scheduled`; compare triggers before and after | Scheduler claims must be idempotent (they already must be); apply triggers only with `triggers deploy` |
| R42 | A patched `dispatch_namespace` binding with `outbound` passes `OutputWorkerSchema` and `cf deploy --prebuilt` | `unverified` | `cf-dry-run` with the hosted profile | Upload the hosted gateway through the REST API from the ops script |
| R43 | D1 Edit can be scoped to one database; creating dispatch scripts needs product-level Workers Admin (so the deployer token could also overwrite the gateway) | `unverified`; the roles page says creating a new Worker needs Workers Admin and is silent on namespace scripts (qualified #54) | Create both tokens in the dashboard and try both operations | Accept the account-wide deployer token; watch the gateway Worker with a version alert |
| R44 | A WfP secret PUT is live immediately and survives the next upload with `keep_bindings: ["secret_text"]`; `cf build` and `cf workers types` run with no Cloudflare login; WfP $25 on a second account adds to Workers Paid | `unverified` (OpenAPI says "creating a new version with that secret") | Secret PUT then request; upload; request; `HOME=$(mktemp -d) cf build`; read the staging account's first invoice (with R18) | Hosted `secret set` re-uploads the stored bundle; hosted users need cf only for build; cost model only |
| R45 | Cloudflare Email Sending's starting daily quota and "Sandbox" on a new account carry sign-up verification mail; an unrestricted `send_email` binding reaches arbitrary recipients on Workers Paid; where onboarding a subdomain writes `_dmarc` | documented only as "conservative" (limits page 2026-09-25; terms §4); send-bindings page says "any verified destination address" | Onboard `mail.everyapp.com` on the hosted account; request a password reset to an unverified Gmail address; read the quota in the dashboard; `dig TXT _dmarc.mail.everyapp.com` and `_dmarc.everyapp.com`; file the increase | Add a Resend transport behind `sendEmail.ts` (0.5 d; Pro $20/mo for 50k); or verified destinations only until the increase lands |
| R46 | OpenRouter §7 item 4 ("reselling API access to Models") covers metered model access for customers' own apps through our broker | Terms 2026-08-31; interpretation open | Ask OpenRouter in writing, describing the broker and the 1.28× markup; also confirm the hosted key has logging off and training opt-out on | Org apps get AI only through catalog-style features, or AI Gateway BYOK/Unified Billing for org apps (D6) |
| R47 | `app.everyapp.com` (a Custom Domain) and the `mail.everyapp.com` sender both need the `everyapp.com` zone in the account that runs them; a binding cannot send from a zone in another account | Custom Domains "on a zone you do not own" refused (2026-09-29); Email Sending onboards "a domain from your Cloudflare account" | `cf zones list` on both accounts; try onboarding from the hosted account before the zone moves | Move the zone and the marketing Worker into the hosted account with D7 (default), or send through REST with a token from the zone's account |

---

## 7. Appendix: every refuted or qualified claim, and its correction

| Claim (where) | Status | Correction (report) |
|---|---|---|
| A `tenants` table with `dispatch_prefix "t_<tenant>"` and `kek_id`; scripts `t_<tenant>_<app>`; hostname→tenant in KV (`architecture-v2-recommendation.md:26,73`; `overview.md:221-223,375`) | refuted by code | Organizations are the tenant; `organization_keys.org_key` is the label; scripts and resources are `every-<orgKey>-<appId>`; the D1 registry + isolate LRU resolve hosts. Add a 1:1 `organization_platform`, not `tenants` (schema, perimeter, hostnames) |
| "per-tenant D1/KV attached in upload metadata" (`recommendation.md:73`) | qualified | D1 yes (50,000/account, raisable). KV no: 1,000 namespaces/account caps the platform at ~250 orgs with four apps; brokered prefixed KV or none (wfp, schema, deploy, security) |
| "Internal JWTs are tenant-scoped (`aud = t_<tenant>_<app>`)" (`recommendation.md:73`; `overview.md:150-152`) | never built | `aud = app.appId` everywhere; org A's and org B's `todo` accept each other's tokens; fix `aud = workerName` + SDK `org_id` pin (perimeter, security, schema, wfp, mcp) |
| "Metering via per-script GraphQL analytics + tags; Logpush for audit" (`recommendation.md:73`) | qualified | GraphQL exposes `scriptName`/`dispatchNamespaceName`, no tag dimension (tags reach Tail Workers as `scriptTags`); the dataset is adaptive/sampled; fine for compute attribution, never for billing AI or provider spend, which must be metered at the broker (wfp, ai-gateway, broker, autumn) |
| LLM key injection and per-app spend metering in the WfP **outbound Worker** (`overview.md:46-56,148-150`; `recommendation.md:51`) | refuted | Outbound Workers do not intercept DO fetches (2026-04-21), know the caller only from dispatcher parameters, and have no manifest context; the broker is `AppGateway`; the outbound Worker is a deny-by-default egress firewall (broker, ai-gateway, comparables, perimeter) |
| "DO-originated fetches bypass the outbound worker … flagged by deploy-time lint" (`recommendation.md` §4; `overview.md:164-165`) | still true, lint insufficient | mTLS bindings bypass too; `connect()` is disabled when an outbound Worker is set; a bundle lint is advisory (any dynamic `fetch`) (security, openseo-fit) |
| Accepted risk #2: "an XSS'd app can fire authenticated GETs at sibling apps … accepted at consumer scale" (`overview.md:161-163`; `recommendation.md:105`) | premise invalid in hosted | The attacker is a tenant who deployed the app on purpose; the shared cookie also enables cookie tossing → session fixation and cookie bombing (hostnames, identity, perimeter, security) |
| Per-app cookies rejected because they need "a hand-rolled OAuth AS" (`recommendation.md:96`) | stale | The gateway has an OAuth server (`server/mcp-auth/*`) and a hardened one-time-code handoff (`mobile-sign-in.ts`); the per-host handoff is ~3 d (identity, hostnames) |
| Admin plane on its own origin (`recommendation.md:24`) vs code `APP_BASE_DOMAIN == gateway host` (`app-hosts.ts:8-10`) | code diverged | Hosted needs the control plane and the content domain separated anyway (scheme C) (perimeter, hostnames) |
| "first upload is SYNCHRONOUS → 200 = live"; "NO binding step exists" (`overview.md:380-384`) | first part verified; second qualified | Synchronous for first-time uploads (changelog 2025-02-20); redeploy propagation unstated; bindings still attach via upload `metadata` (perimeter, deploy, build) |
| Hosted deploy sketch: CLI uploads "code + manifest" with an `eak_` token; CF token in the gateway (`overview.md` §5, `:372`) | stale / disagrees with `recommendation.md:108` | `eak_` retired by ADR-0003; the artifact is Build Output, never source; the token lives in a separate deploy-service Worker (build, deploy, security) |
| "Wrangler stays — as an internal compile target" (`recommendation.md` §2.5) | stale | Pipeline is `cf build` / `cf deploy --prebuilt` since #271 (build) |
| Phase 0 spike "static assets in dispatch-namespace uploads" (`recommendation.md:151`) | resolved | Supported since 2025-01-31 with an upload-session flow; miniflare dispatch local dev is still remote-only; WebSocket-through-dispatch spike still open (wfp) |
| Tool risk is "operator-set, never app-supplied hints"; the manifest "only proposes" (`overview.md:88-91,206-207`) | refuted by code | `toolbus/policy.ts:1-3` trusts the app's declared risk; fine for the org's own code, wrong for catalog apps installed by strangers; add org overrides that only tighten (comparables) |
| "Hosted abuse controls … must be added deliberately before metered handlers" (`recommendation.md:50`) | not honored | The broker is a metered handler and ships with no quotas, holds or caps (security) |
| ADR-0001 §6: hosted app Workers are single-tenant per org | qualified | Holds for org apps and instance-per-org catalog apps; OpenSEO needs Workflows (not in WfP), crons, a second Worker, R2 and Hyperdrive, and is already org-scoped; two tiers (wfp, schema, openseo-fit, broker, deploy) |
| ADR-0001 §5: one platform-owned provider key for hosted v1 | correct, consequences missed | The route lockdown in `ai-proxy.ts:31-49` becomes a cross-tenant control; `AI_PROXY_EXTRA_ROUTES` must be ignored in hosted; shared fate at the provider argues for per-org OpenRouter sub-keys (broker, security, ai-gateway) |
| RFC-0001:58 "runtime auth enforces token organization claim matches worker organization" | not implemented | `EVERY_APP_ORG_ID` is bound and never read by the SDK (schema, mcp, security) |
| RFC-0001:31 "if user has no invite, create a personal org" | not built | Invite-only sign-up, `allowUserToCreateOrganization: false`, global owner bootstrap (identity, schema, comparables) |
| RFC-0001:82 "usage metering dimensions include org/app/token" | qualified | AI Gateway allows five metadata entries; use `org`, `app`, `user`, `chan`; the token adds nothing to billing (ai-gateway) |
| RFC-0001 "hosted-mode tests verify `/api/internal/*` is disabled" | moot | The deploy API and deploy tokens were deleted by #292/#293 (identity) |
| `docs/security-model.md:284-285`: stripping `Domain=` means "apps cannot set parent-domain cookies" | refuted | True only for `Set-Cookie` headers through the proxy; page JS can write `document.cookie = "…; Domain=<parent>"` unless the parent is a public suffix (hostnames, identity, security) |
| `docs/security-model.md:278-279`: access denied when the *active* session org does not own the app | to be replaced | Resolve membership in the app's org (from the host); the active org only steers the control plane (perimeter, identity, hostnames, schema) |
| `docs/cli-redesign.md:132-135`: "Nothing here should be built for [hosted] yet" | still right | The hosted API is new code calling the same perimeter rules; the bearer-token shape kept at `:803-809` is the hosted shape with a real login behind it (deploy) |
| `docs/cli-redesign.md` deletes wildcard routing (#289) | right for self-host, reversed for hosted | Hosted needs one wildcard route (100 Custom Domains per zone, verified #1; WfP user Workers have no routes); the hosted gateway has its own pipeline, which the first draft asserted and never defined and which is now H27 (hostnames, wfp, identity, r2-hosted-release) |
| Brief: OpenSEO bills "over two metered features (`seo_data_usage`, `llm_usage`)" | qualified | Those features exist but are never tracked; OpenSEO locks and tracks the credit systems `usage_credits`/`topup_credits` directly (which Autumn's docs discourage); features live only in event `properties` (openseo-fit, autumn) |
| Brief: "base $10/mo 10k credits with overage" | qualified | `usage_credits` on base-plan v4 has `price: null`; overage is a 500-credit **unbilled** buffer under `spend_limits`, not billed overage (autumn, openseo-fit) |
| Brief: "a 1.28x markup on DataForSEO cost" | qualified | The same markup applies to OpenRouter spend and Browser Rendering (`subscription.ts:568-569`, `audit-rendering.ts:22-26`) (openseo-fit, broker) |
| Brief / OpenSEO comments: `free_plan` is the Autumn default | stale | Live default is `onboarding_plan` (`auto_enable: true`); grants are identical (autumn, openseo-fit) |
| OpenSEO `autumn.ts:65`: "track() has no idempotency key" | stale | Every Autumn route honors `Idempotency-Key` (24 h, 409 on duplicate, retryable failures release the key); `batch_track` items take `idempotency_key` (autumn, ai-gateway, openseo-fit) |
| OpenSEO `openrouter.ts:47,58`: `usage: { include: true }` | no-op now | OpenRouter always includes usage; the flag has no effect (ai-gateway, broker) |
| OpenSEO spec 0002 rejects "serialize each org in a DO" | misapplied | It objected to serializing provider calls; a ledger DO that only does hold/settle takes microseconds (openseo-fit, autumn) |
| `landing-page/content/docs/how-it-works/gateway.mdx:68`: "there is no hard spending cap" | qualified | Still true for the Workers bill; AI through an AI Gateway with spend limits can now 429 past a budget (ai-gateway) |
| `TODO.md:36` "AI Gateway routing" as a metering/limiting path | qualified | 20 rules per gateway, one `limit` per rule, eventually consistent, Unified Billing 200 req/60 s; backstop only (ai-gateway, broker, comparables) |
| Integrations research: "tokens stay in the customer's own Cloudflare account" is the differentiator | reversed by hosted | Hosted is a central multi-tenant vault (the Composio shape); envelope encryption, no token-returning API, and an exit to self-host become load-bearing (comparables, security) |
| PR #281 POC: grants keyed by `app_slug`; HKDF-from-`BETTER_AUTH_SECRET` encryption; one shared webhook path; app named `Every App ${host}` | to change | Key by `app_row_id`; envelope encryption with a destroyable DEK; per-client webhook URL (or look up by `X-GitHub-Hook-Installation-Target-ID` before verifying); org slug in the name (schema, security, build) |
| PR #257: `ADR-0003-oauth-bootstrap-and-rest-deployer.md`; `ensureD1Database` adopts same-named resources and lists with `per_page=1000`; `runDrizzleD1Migrations` | collides / obsolete | ADR number collides with today's ADR-0003; adoption contradicts the ownership ledger and breaks past 1,000 databases; drizzle carry-over is being deleted; keep only the REST transport (deploy) |
| WfP bindings page (2026-09-16) lists Workflows for user Workers; five reports and the first draft of this synthesis called it "contradicted" by the Workflows limits page (2026-09-21) | reconciled, not contradicted (qualified #10, #16, #44; #13 refuted) | "Deployed to" means hosting the `WorkflowEntrypoint` class, which is unsupported (the limits note dates from 2026-01-22 and is maintained; the Workflows API has no namespace field; a namespace PUT returns 500). The bindings page's bullet, added deliberately 2026-07-02, describes *binding* a user Worker to a Workflow, and the upload schema's `workflow` binding has `script_name`, so a user Worker can plausibly call a Workflow hosted in a platform-account Worker (runtime unverified, R2). Cloudflare's path for tenant-authored Workflow code is Dynamic Workers + `@cloudflare/dynamic-workflows`, not WfP |
| WfP docs silent on crons for user Workers | settled elsewhere | Cloudflare staff (workers-sdk#13840, 2026-05-11): "Cron triggers aren't supported on dispatch namespace workers today"; wrangler skips `triggersDeploy` for WfP (wfp) |
| Workers Builds as the multi-tenant build farm | unusable | Account-bound triggers, user-scoped account-wide build token next to tenant scripts, 6 concurrent builds per account, no WfP target (build, wfp) |
| `@cloudflare/ci` as the tenant deploy path | unsafe for tenants | Injects `CLOUDFLARE_API_TOKEN` into the runner that executes the tenant's `wrangler` (build) |
| Workers Caching is tenant-safe by default | new hazard | Keys on path, entrypoint, `ctx.props`, version, not identity headers; a user Worker can enable it via metadata; force off (security) |
| Rate-limit bindings are private to a Worker | refuted | Same `namespace_id` shares counters across Workers in the account; tenants could drain the gateway's 4180-4182 (security) |
| Autumn `balances.finalize` without `customer_id` (OpenSEO 1.2.33 call sites) | API drift | `customer_id` is required on current API; `track` is async by default on 2.5.0; `autumn-js@1.5.1` pins 2.6.0 (autumn) |
| AI Gateway docs: provider/model "split by value" in spend-limit rules | docs vs API | The API accepts only `filter` for `provider` and `model`; `partition` exists for metadata only (ai-gateway) |
| Cloudflare OS has a multi-tenant SaaS offering to compete with | not today | Per-company instances; managed version on a waitlist (2026-10-01) with no price; consumes MCP, exposes none (comparables) |
| Perimeter report default: keep the shared cookie on self-host | disagreement | Hostnames and identity reports (and this synthesis) default to one session mechanism in both modes under the no-backcompat rule; founder may override (D1 note, defaults list) |
| Schema report default: `aud = apps.id` | disagreement | This synthesis takes `aud = workerName` (globally unique, equals the dispatch script name, re-checkable with `isRegistryWorkerName`); shared platform Workers add an SDK `org_id` pin against the install table |
| **Corrections to the first draft of this synthesis, from `raw/verification.md`** | | |
| Finding 3, A3, R6: "Better Auth 1.7.7 keeps the last duplicate cookie it parses" | refuted in mechanism, attack stands (#40; #0 confirmed) | `cookie-utils.mjs` is last-wins but not on the `getSession` path; better-call 1.4.0's `getSignedCookie` parser is first-wins. With equal `Path=/` the victim's older cookie wins. The attacker uses a longer `Path` so their cookie sorts first (RFC 6265 §5.4). Scheme C unchanged; R6 reproduces the longer-Path variant |
| Finding 1, A1, R2, D2: "the WfP bindings page says the opposite: contradicted" | refuted (#10, #16, #44; #13 refuted as "can be defined") | The pages reconcile on define vs bind; see the row above |
| Finding 2, A2, R1: "no page says a user Worker may bind a Worker outside its namespace" (as a reason to doubt the service binding itself) | qualified (#4, #12, #17, #28, #47, #53) | The `service` binding with `entrypoint` is in the dispatch upload schema and nothing forbids an account-Worker target; only `props` is undocumented, for every upload path |
| A2: dispatch-props capability stubs "die with the request" | qualified (#7, #9, #18, #48) | They live for the dispatch Worker's execution context (extended by `waitUntil` or a live connection; a DO may `dup()` one while the connection is open); unusable by alarms, crons or later requests. `ctx.exports` needs compat date ≥ 2025-11-17 or `enable_ctx_exports` |
| A1/A2/C7: "DOs, Workflows, crons and queues would lose the broker" | qualified (#47, #49, #53) | Only DO alarms: Workflows and crons do not run in WfP, queue consumers are unconfirmed |
| A4: "deploying bindings needs no permission on the bound resource" (all bindings) | qualified (#54) | Holds for D1/KV/R2/DO/service; Secrets Store bindings need Account Secrets Store Edit and a secret scope list including `workers` |
| A5/H13: entity `usage_limits` as a per-app cap | qualified (#36) | They clamp `check` and default-`cap` tracks, not `overage_behavior: overflow` tracks; per-app caps live in `OrgWallet` only |
| A5/C9: `Idempotency-Key` "24 h" | qualified (#37) | Default 24 h, org-configurable 1 h-30 d, 30 min for Atom-forwarded requests; dedup fails open during an Autumn store outage; release-on-failure is undocumented (code only) |
| Defaults: "Third-party developer payouts deferred (Autumn has no revenue share; Stripe Connect separate charges and transfers when needed)" | qualified (#39) | Autumn passes `application_fee_percent`, `transfer_data` and `on_behalf_of` to Stripe via `checkout_session_params`/`subscription_params`, so destination charges with a platform fee are drivable from Autumn; its Platform API would make the developer the merchant of record. Still deferred |
| D6/C2: OpenRouter "`usage.cost` in the last SSE chunk" | qualified (#34) | Chat Completions only; `/v1/responses` → `response.completed`, `/v1/messages` → `message_delta`; `cost` is schema-optional and absent on aborted streams |
| A5/D6: AI Gateway "one `limit` per rule even when partitioned" | qualified (#32, #50) | One configured amount applied independently per bucket, not one pooled budget; and only priced models with token usage are recorded at all |
| D6: "Unified Billing … BYOK exempt" | qualified (#33) | Exempt only when the key is under the `default` alias or `byok_only` is on; Workers AI frontier models add a 50 req/min per-account per-model cap |
| B1/D7: "KV 1,000 … D1 50,000, raisable" | qualified (#14, #19) | KV's cap is identical on Free and Paid and is not documented as raisable (generic form only); D1's count and storage are explicitly raisable; D1's 10 GB per database is not (#21) |
| C8/D9/H24: "Sandbox 1.0" as preview | corrected (#46) | Sandbox SDK 1.0.0 shipped 2026-09-30 (1.0.1 on 2026-10-13); GA, not preview; `enableInternet` false by default in 1.0 only |
| C8: "Workers Builds … token next to tenant build scripts" | qualified (#45) | The exposure of the build token to the build command is inferred, not documented; the account-binding, user-token-only and 6-build facts are verbatim |
| R12/H18: DataForSEO `cost` "in the first ~8 KB" | qualified (#26) | ~200 bytes in on every docs example, but key order is not guaranteed, and depth-overshoot refunds never appear in any `cost` field |
| R21/D11: "per-org connector URLs need a library change" | refuted (#20) | Path-descendant audience matching validates `/mcp/o/<org>` today; per-org hostnames via per-request or per-org-list AS construction |
| A1, R2: "the 500-script count … favor[s] the shared tier" | qualified (r2-unit-economics) | WfP user scripts are unlimited ($0.02/script/month after 1,000); 500 binds only regular Workers and the scripts that hold Workflows. Shared still wins on account-wide Workflow names, 100 Workflow `schedules` per account and per-org data migration |
| D7: "API 1,200/5 min/token" | qualified (r2-unit-economics) | Per user principal, cumulative across that user's tokens and the dashboard; a 429 blocks all calls for 5 min; raisable only for Enterprise (API rate limits, 2026-08-25) |
| D7, R17: "File KV and D1 increases at launch" | qualified (r2-unit-economics) | No KV increase once B1 removes per-app KV; file D1 count and storage at account creation, not launch |
| **Corrections and additions from the round-2 gap reports** | | |
| D5 (keep OpenSEO org ids) vs openseo-fit Q1 (new customer ids = Every App org ids) | resolved (r2-openseo-cutover) | With import keeping ids, both say "customer id = gateway org id" |
| "Autumn customer id is immutable" (implicit in D5's "painful split") | refuted (r2-openseo-cutover) | `customers.update` has `new_customer_id`; its side effects are unverified (R34); never rename by default |
| H13 / Defaults: "track the metered feature; fold `topup_credits` into `usage_credits`" | qualified (r2-openseo-cutover) | Both credit systems map the same metered features and which pool Autumn draws is undocumented (R11); the wallet tracks credit-system ids with two pools until `topup_credits` drains; new top-ups land in `usage_credits` by plan version |
| hostnames Q5: "catalog apps get per-org hostnames" | qualified (r2-openseo-cutover) | Google OAuth needs exact, wildcard-free redirect URIs, so catalog apps with third-party OAuth keep one fixed callback host (`app.openseo.so`) that relays to the org host |
| D5: build in the Autumn sandbox, open sign-up | qualified (r2-openseo-cutover) | The sandbox is a Stripe Connect sandbox; test cards would "pay" for live provider spend (R33). Invite-only or provider sandboxes until live Autumn |
| D7 / H17: platform tier with OpenSEO in the founder's account | qualified (r2-openseo-cutover) | Service bindings are same-account only; OpenSEO prod moves into the hosted account at cutover; `openseo.so` stays and `app.openseo.so` becomes one SaaS custom hostname (H40) |
| `docs/cli-redesign.md:740-745`: "`secret set` keeps redeploying" | self-host only (r2-hosted-release) | Hosted dispatch apps set the secret on the live version (WfP "creating a new version with that secret"); platform-tier installs use `app_secrets`; the first line names which |
| `docs/cli-redesign.md:28,48`: `login` deleted; "the Cloudflare login is the only credential" | per target (r2-hosted-release) | One credential per target. Hosted uses an org-bound `epat_` exchanged from the device-flow session; no `login` verb, hosted-only `logout`; the hosted branch never calls `ensureCfAuth` |
| README H12 (first draft): "branch on the gateway's reported mode" | contradicts `docs/cli-redesign.md:60` (r2-hosted-release) | The target is resolved locally by `lib/target.ts`, with no HTTPS call |
| README H11 (first draft): "deploy inputs schema 2 `target`" | unnecessary (r2-hosted-release) | A tenant-neutral build needs no inputs; `.everyapp/deploy.json` and `deployInputs.ts` are deleted |
| README H7 (first draft): "`tier` as an input (`dispatch`, `platform`)" read as a rename | settled (r2-hosted-release) | `Tier = 'service_binding' \| 'dispatch' \| 'platform'`; no rename; unknown tiers fail closed |
| `docs/cli-redesign.md:772-790`: "No backwards compatibility", "One migration" | end at the hosted freeze (r2-hosted-release) | `drizzle/frozen.json` for both modes at the first public hosted deploy; then N-1 compatibility for SDK↔gateway, gateway↔deployer, CLI↔`/api/v1` |
| `docs/cli-redesign.md:137-154,733`: discovery through the account; the gateway built from the checkout | holds, with one gap (r2-hosted-release) | CI builds main once and promotes the same bytes (H27). Without a `mode='hosted'` install row the founder's cf login discovers production and can redeploy it from a laptop |
| README §7 (first draft): "the hosted gateway has its own pipeline" | was undefined (r2-hosted-release) | H27 |
| README §5 "first outside org ~40 d" | qualified (r2-forks, r2-hosted-release, r2-email-and-legal) | Omitted H27 (nothing deploys the control plane), H29-H30 (nothing outside the checkout can build) and the legal tier-0 subset; ~50 d |
| D9/H24: "fork PRs" | renamed (r2-forks) | "Outside-contributor PRs" (pull requests from GitHub forks of an org's repo), to avoid confusion with catalog forks (D13) |
| D3 (first draft): Verified = "no DOs" | changed (r2-forks) | todo declares `UserSyncDO`, so a todo fork would need Paid; Verified now allows one DO class guarded by the C6 poller |
| `TODO.md:74` "Publish again" with the public repository sync as prerequisite | narrowed (r2-forks) | Publish `@every-app/sdk` and the app-developer `everyapp` with H12 (D13); source mirrors replace the public sync |
| `everyapp.com/privacy`: "We do not operate any servers that receive your data" (`landing-page/src/routes/privacy.tsx:36-37`) | false once hosted runs (r2-email-and-legal) | Scope it to the iOS app at `/privacy/ios`; publish a hosted policy (H28, D16) |
| Defaults (first draft): "lifecycle emails via the gateway's email transport" | qualified (r2-email-and-legal) | Cloudflare's Email Service terms §1-§2 allow transactional mail only; founder check-ins and product news stay on Loops (D15) |
| §2 (first draft): email transport "as-is" | qualified (r2-email-and-legal) | Templates interpolate org names and inviter emails unescaped; in hosted those are attacker-controlled (C11, H9) |
| D6: "prompts never stored" | conditional (r2-email-and-legal; ai-gateway §2.1.6) | True only with AI Gateway payload logging off and OpenRouter's logging opt-in off; the draft backstop config set `collect_logs: true` |
| ai-gateway report / first draft: OpenRouter is "incorporating" under its terms | open (r2-email-and-legal) | OpenRouter §7 item 4 forbids "reselling API access to Models"; a metered broker for org apps' custom code is near the line; written OK sought (R46) |
