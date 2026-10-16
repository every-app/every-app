# R2 gap: tenant ceilings, unit economics and catalog provisioning

Round 2 gap fill for the hosted research round (2026-10-15). It reads
`README.md` D2, D3, D7, H17, §4-§5, `raw/wfp-capabilities.md` (pricing and
account ceilings), `raw/schema-tenancy.md` Q8, and
`raw/security-abuse-hosted.md` T11 and S12. It also uses code on
`origin/main` (#284-#294 merged). Cloudflare facts come from the
developers.cloudflare.com Markdown pages fetched today. Each source is
cited with the page's own "Last updated" date. Anything without a source
is marked **UNVERIFIED**.

---

## 1. The question

The synthesis lists Cloudflare ceilings (D7, A1, B1, C6) but never turns
them into a number of orgs. It also never says when a catalog app's
per-org resources get created or what they cost. This report answers four
questions:

1. Which ceiling binds first, and at how many orgs, under the defaults?
   - **Free:** catalog only, 4 dispatch-tier catalog apps per org (todo,
     chef, workout, RepoLens).
   - **Verified:** Free plus 3 org apps.
   - OpenSEO stays on the shared platform tier (D2).
2. What does one org cost per month if every catalog app is created at
   sign-up (eager), compared with on first open (lazy)? How long does a
   lazy install make the user wait?
3. Which limit increases should be filed when the account is created, and
   how?
4. Eager or lazy, and what text in README.md changes?

### What one org consumes (from the manifests on `origin/main`)

| App | Resources per install | Source |
|---|---|---|
| todo | 1 script, 1 D1, 1 DO class (`UserSyncDO`, hibernating WebSockets), KV declared but unused | `apps/todo-app/everyapp.config.ts:14-20`; `src/durableObjects/UserSyncDO.ts:33` (`acceptWebSocket`) |
| chef | 1 script, 1 D1, KV declared but unused, `providers: ["openai"]` (it meters) | `apps/chef/everyapp.config.ts:11-15` |
| workout | 1 script, 1 D1, KV declared but unused | `apps/workout-tracker/everyapp.config.ts:11-14` |
| RepoLens | 1 script, 1 D1, cron `17 */6 * * *` (run by the gateway scheduler on hosted, per A6) | `~/workspaces/repolens/everyapp.config.ts`, `cloudflare.config.ts` |
| OpenSEO | none per org: a shared platform Worker, org from the JWT | README D2, A1 |

Migrations are tiny: one SQL file per app, 629 B (todo), 5,684 B (chef)
and 4,532 B (workout) on `origin/main`. Each fits in one D1 `query` batch.
B1 drops KV, so per org:

- **Free:** 4 dispatch scripts and 4 D1 databases.
- **Verified:** 7 scripts and 7 D1 (assuming one D1 per org app; D3 allows
  no DOs below Paid).

---

## 2. Findings with sources

### 2.1 Ceiling → what it bounds → orgs under the defaults

The "lazy" column assumes a Free org opens 1.5 of its 4 catalog apps on
average. That figure is an **UNVERIFIED usage assumption**; replace it
with the open rate measured over the first 100 orgs.

| Ceiling (source, date) | What it bounds | Free, eager (4/org) | Verified, eager (7/org) | Free, lazy (~1.5/org) |
|---|---|---|---|---|
| **WfP scripts:** "unlimited number of scripts" ([WfP limits, 2026-10-13](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/)). 1,000 scripts included, then **+$0.02 per additional script per month**; the page's example bills 1,200 scripts at $4.00/month ([WfP pricing, 2026-04-21](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/)) | Cost only, not a count | No ceiling. Fees start after 250 orgs; then $0.08/org/mo | No ceiling. Fees start after 142 orgs; then $0.14/org/mo | No ceiling. Fees start after ~666 orgs; then ~$0.03/org/mo |
| **D1 databases per account:** 50,000 on Paid, raisable by request to "millions to tens-of-millions" ([D1 limits fn 1, 2026-04-21](https://developers.cloudflare.com/d1/platform/limits/)) | Every install that has a D1, plus the warm pool, plus gateway/staging DBs | **12,500 orgs. This is the first hard ceiling.** | 7,142 orgs | ~33,000 orgs |
| **D1 10 GB per database:** "cannot be further increased" (same page) | (a) One org's data in one app; not a count bound. (b) **The control-plane D1, which holds every org's gateway rows** | n/a | n/a | Control plane holds 10 GB ÷ bytes per org. About 200,000 orgs at ~50 KB/org static. **About 6,600 orgs** if 30 days of MCP audit at 100 calls/day × 500 B (1.5 MB/org) stays in D1. Both per-org sizes are UNVERIFIED (R28). C5 already moves audit and ledger out. |
| **D1 storage per account:** 1 TB, raisable (D1 limits fn 2) | The sum of all tenant DBs | 1 TB ÷ (4 × avg DB). About 62,500 orgs at 4 MB/DB (UNVERIFIED size); does not bind before the DB count | ~35,000 | ~166,000 |
| **KV namespaces:** 1,000 per account, Free and Paid alike ([KV limits, 2026-10-08](https://developers.cloudflare.com/kv/platform/limits/)) | Per-app KV | 0 per org after B1, so unbounded. Without B1: **250 orgs** | 0 after B1. Without B1: 142 | 0 |
| **DO namespaces:** "Workers for Platforms do not have a limit for the number of Durable Object namespaces" (WfP limits). Objects per class unlimited ([DO limits, 2026-06-01](https://developers.cloudflare.com/durable-objects/platform/limits/)) | todo's `UserSyncDO` per install | Unbounded | Unbounded | Unbounded |
| **Regular Workers:** 500 per account; "If you need a higher Worker limit, use Workers for Platforms" ([Workers limits, 2026-10-12](https://developers.cloudflare.com/workers/platform/limits/)). DO classes: 500, same as the script limit (DO limits fn 1) | Platform tier only: gateway, deployer, egress, meter, marketing, redirect, `open-seo`, `open-seo-audit`, staging copies (about 10-20) | Unbounded (dispatch scripts do not count) | Unbounded | Unbounded |
| **Workflows:** scripts "500 (shared with Worker script limits)"; 50,000 concurrent running instances per account; 300 creations/s per account and 100/s per workflow; 2,000,000 queued; **100 `schedules` per account** ([Workflows limits, 2026-09-21](https://developers.cloudflare.com/workflows/reference/limits/)). "Workflows cannot be deployed to Workers for Platforms namespaces" (same page) | Platform-tier Workflows (OpenSEO audit) across all orgs | Not a count bound. Burst bound: ≤100 audit starts/s and ≤50,000 audits running platform-wide | same | same |
| **Cron Triggers:** 250 per account (Workers limits) | Platform Workers only. Dispatch apps use the gateway scheduler (A6), which needs 1-2 | Unbounded | Unbounded | Unbounded |
| **Gateway scheduler fan-out** (follows from A6): a <1 h cron gets 30 s of CPU (Workers limits, CPU table). Subrequests default to 10,000, configurable to 10M (same page). "A single request has a maximum of 32 Worker invocations" ([Service bindings, 2026-10-13](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)); whether a dispatch `fetch` counts is UNVERIFIED (R26) | RepoLens installs due on the same tick (`17 */6 * * *`) | Eager: 10,000 dispatches on one tick at 10k orgs. **If dispatch counts toward the 32, one invocation reaches only 31 apps**, so a Queue fan-out is mandatory | same | Only installed RepoLens copies |
| **Custom Domains:** 100 per zone. **Routes:** 1,000 per zone (Workers limits, "Routes and domains"). Custom Domains do not support wildcards ([Custom Domains, 2026-09-29](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)) | Hostnames. Scheme C uses one wildcard route on the content zone | Unbounded under scheme C. A Custom Domain per app (the self-host model) would cap the **whole platform at 100 apps** | same | same |
| **Cloudflare for SaaS:** 100 hostnames included, $0.10 per additional hostname, max 50,000 hostnames below Enterprise; wildcard custom hostnames Enterprise-only ([SaaS plans, 2026-08-14](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)). Non-Enterprise plans have an "API enforcement threshold" ([Quotas and billing, 2026-07-30](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/quotas-and-billing/)). The 2022 launch post gives the price as "$0.10 a month" ([blog, 2022](https://blog.cloudflare.com/waf-for-saas/)) | BYO domains only (H26, later) | 0 in v1 | 0 in v1 | 0 in v1. Later: 50,000 BYO hosts per account, $0.10/mo each after 100 |
| **Cloudflare API:** 1,200 requests / 5 min "per user/account token"; "applies cumulatively regardless of whether the request is made via the dashboard, API key, or API token"; once exceeded, "all API calls for the next five minutes will be blocked"; only Enterprise can raise it, through Support ([API rate limits, 2026-08-25](https://developers.cloudflare.com/fundamentals/api/reference/limits/); same table on WfP limits). D1 REST "is best suited for administrative use as the global Cloudflare API rate limit applies" ([D1 proxy tutorial, 2026-10-12](https://developers.cloudflare.com/d1/tutorials/build-an-api-to-access-d1/)). R2 REST: 1,200 / 5 min across the account ([R2 limits, 2026-06-08](https://developers.cloudflare.com/r2/platform/limits/)) | Sign-up provisioning rate, first-open installs, deploys, upgrade fan-out, takedowns, and D1 REST migrations, all sharing one budget per principal | **600 orgs/hour** at 100% of the budget (24 calls/org, §2.3) | 343 orgs/hour if org apps deploy the same hour | Not on the sign-up path; ~2,400 first opens/hour at 100% |
| **GraphQL Analytics:** 300 queries / 5 min per user, "applied in addition to the general rate limits" ([GraphQL limits, 2026-10-02](https://developers.cloudflare.com/analytics/graphql-api/limits/)). The account-based mode is also 300 / 5 min per account ([2026-08-25](https://developers.cloudflare.com/analytics/graphql-api/account-based-rate-limiting/)) | The usage poller (H16) | Per-org queries: 10k orgs need 167 minutes per sweep. **One grouped query per namespace per window** is the only design that scales | same | same |
| **D1 single writer:** "If your average query takes 1 ms, you can run at most 1,000 queries per second"; writes "can take several milliseconds"; overload returns "overloaded" (D1 limits FAQ) | Control-plane throughput: perimeter auth on every proxied request | **Today about 8,000-12,000 concurrently active orgs** (derivation in §2.4) | same | same |
| **Workers Logs:** 5 billion logs per account per day, then "a 1% head-based sample will be applied for the remainder of the day"; 256 KB of log data per request ([Workers Logs, 2026-10-12](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)) | Account-wide log fidelity. **One tenant can trip it for everyone** | Not a count bound. A Verified org with a public route can trip it, worked through in §2.5 | same | same |
| **Autumn Free:** "10,000 customers and entities" (`raw/autumn-billing-platform.md:439-447`, useautumn.com/pricing fetched 2026-10-15). Pro is $375/mo, unlimited | H13 as written creates one Autumn entity per installed app | **2,000 orgs** (1 customer + 4 entities) | 1,250 orgs (1 + 7) | ~5,000 orgs if entities are created only for apps that meter (§3) |
| Vars + secrets: 128 per Worker (Workers limits). Tags: 8 per script (WfP limits). Account API tokens: 500 (API limits) | Per-app secrets and tags; tokens only if we minted one per org (we do not) | Not a bound | same | same |

**What binds first.**

- Under the defaults as written, the first ceiling is Autumn Free at 2,000
  orgs.
- Next, the control-plane D1 throughput and size (about 6,600-12,000 orgs
  until C5 lands).
- Then D1 database count at 12,500 orgs.
- The API budget is what makes a launch spike or a release slow (hours, not
  days).
- Lazy installs move every count-type ceiling out by about 2.7×. They do not
  help the control-plane D1, which C5 fixes.

### 2.2 Per-org unit cost per month

Prices are from WfP pricing (2026-04-21), D1 pricing (2026-04-21), DO
pricing (2026-09-30), Workers pricing (2026-10-02) and Observability
pricing (2026-10-15). All are marginal costs, after the account's included
allowances:

- WfP $25/mo: 20M requests, 60M CPU-ms, 1,000 scripts.
- D1: 25B rows read, 50M rows written, 5 GB stored.
- DO: 1M requests, 400,000 GB-s, 5 GB-month of SQLite.
- Observability from 2026-12-01: 50 GB ingestion and 10 GB-month storage
  per billing cycle.

| Line item | Fact | Eager Free org (4 installs) | Lazy Free org (~1.5) | Verified org (eager 7 / lazy 4.5) |
|---|---|---|---|---|
| Dispatch scripts | $0.02 per additional script per month | $0.080 | $0.030 | $0.140 / $0.090 |
| D1 per-database fee | None: "D1 allows you to build applications with thousands of databases at no extra cost, as the pricing is based only on query and storage costs" (D1 limits FAQ) | $0 | $0 | $0 |
| D1 storage | Empty DB "approximately 12 KB"; $0.75/GB-mo above 5 GB (D1 pricing). Assume ~50 KB per migrated catalog DB (UNVERIFIED) | 0.2 MB → $0.00015 (and $0 until ~25,000 orgs fill the 5 GB) | $0.00006 | ≤$0.0003 |
| Migration writes | DDL counts as rows read/written (D1 pricing def. 3); a handful of rows per install | ~$0 | ~$0 | ~$0 |
| Idle DO (todo) | "Inactive objects receiving no requests do not incur any duration charges"; hibernation-eligible objects are not billed for duration (DO pricing). todo uses `acceptWebSocket` | $0 | $0 | $0 |
| Observability, idle org | No invocations, no log events | $0 | $0 | $0 |
| **Idle org total** | | **≈ $0.08** | **≈ $0.03** | **≈ $0.14 / $0.09** |
| Active org (example) | 5 members × 300 requests/day = 45,000 requests/mo, 10 ms CPU each, 2 log events/request at ~1 KB/event (all UNVERIFIED assumptions) | Requests $0.0135 + CPU $0.009 + logs $0.054 now ($0.60/M events) or ~$0.025 after 2026-12-01 ($0.25/GB plus $0.10/GB-mo). **≈ $0.05-$0.08 on top of idle** | same, for the apps actually used | similar |
| Platform-tier OpenSEO | No per-org Cloudflare resource; its Postgres/Hyperdrive cost is per query and outside this table | $0 fixed | $0 | $0 |
| Autumn | $0 within 10,000 units; then a **$375/mo step** (Pro) | 5 units | 1-2 units | 8 / 2-5 units |

At 10,000 Free orgs, script fees alone are:

- eager: (40,000 − 1,000) × $0.02 = **$780/mo**;
- lazy: (15,000 − 1,000) × $0.02 = **$280/mo**.

Neither is material next to Autumn Pro or one abuse incident. **Unit cost
is not the reason to choose lazy. Ceilings, API time and abuse are.**

### 2.3 API budget: provisioning rate and upgrade fan-out

Calls per fresh catalog install come from `raw/wfp-capabilities.md`
§2.3 and `raw/deploy-pipeline.md:423-435`:

1. `POST /d1/database`
2. `POST /d1/database/{id}/query` (one batch, migrations plus
   `d1_migrations` rows)
3. `POST .../assets-upload-session`
4. *b* × `POST /workers/assets/upload`
5. `PUT .../dispatch/namespaces/{ns}/scripts/{name}`
6. `GET .../bindings`

That is **5 + b calls; about 6 with b = 1**. The session response omits
files "recently uploaded" ([WfP static assets, 2026-10-12](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/)).
Whether that dedupe works across scripts in one namespace is UNVERIFIED
(R27). If it does, b = 0 after the first org.

Budget arithmetic: 1,200 calls per 5 min = **14,400 calls per hour** per
principal. "50%" below means half the budget is reserved for deploys,
takedowns, the poller (GraphQL counts too) and operators.

| Workload | Calls | Hours at 100% of budget | Hours at 50% |
|---|---|---|---|
| Eager sign-up, Free org (4 × 6) | 24/org → 600 orgs/h | n/a | 300 orgs/h. A 2,000-sign-up launch hour drains in ~6.7 h |
| Lazy first open (per app) | 6 | 2,400 opens/h | 1,200 opens/h |
| **Upgrade, one catalog app, 10k orgs, code only** (`PUT` with `keep_assets: true` + `GET` bindings; `keep_assets` per [Direct Upload, 2026-08-10](https://developers.cloudflare.com/workers/static-assets/direct-upload/)) | 2 × 10,000 = 20,000 | **1.4 h** | 2.8 h |
| … plus a migration (bookmark `GET` + `query`) | 4 × 10,000 = 40,000 | 2.8 h | 5.6 h |
| … plus changed assets (session + ≥1 bucket) | 6 × 10,000 = 60,000 | 4.2 h | 8.3 h |
| All four catalog apps, eager installs (40,000 scripts) | 6 × 40,000 = 240,000 | **16.7 h** | 33 h |
| All four catalog apps, lazy installs (~15,000 scripts) | 6 × 15,000 = 90,000 | 6.3 h | 12.5 h |

General formula: **hours = installs × calls per install ÷ 14,400 ÷ budget
share.**

Because a 429 blocks *every* call for five minutes (API rate limits page),
the deployer must pace itself from the `Ratelimit` header the API returns
on every response. It must never wait for a 429: one fan-out overrun would
also block a takedown. Whether two account-owned tokens get independent
1,200 budgets is not documented. The table says "per user/account token",
while the note says "per user ... cumulatively". This is R25. Ask
Cloudflare in the limit request rather than shard tokens to evade the
limit.

### 2.4 Control-plane D1 throughput

On `origin/main` every session-authenticated proxied request does:

- `auth.api.getSession()` (`apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts:116`);
  Better Auth's `cookieCache` is **disabled** (`src/auth/shared.ts:9-11`);
- `AppAccessRepository.hasAccessByUserAndAppSlug()`, uncached (`:148`);
- an org-context lookup, cached per isolate for 30 s
  (`src/server/organization/orgContext.ts:15-16`).

That is about **2-3 D1 queries per request**.

At ~1 ms per query (D1 limits FAQ; UNVERIFIED for our queries), the
ceiling is **about 330-500 proxied requests/s per platform**.

With an assumed load of 5 members × 300 requests/day and 10% of daily
traffic in the peak hour, one org peaks at 0.042 req/s. So:

- **today: ~8,000-12,000 concurrently active orgs**;
- **after C5** (`cookieCache` ~60 s plus an access cache), q drops to about
  0.05 and the D1 ceiling moves to roughly 20,000 req/s, beyond the scale in
  this brief.

The control plane's 10 GB size cap cannot be raised (§2.1). Measure bytes
per org early (R28).

### 2.5 Workers Logs as a shared fate

One request may write up to 256 KB of log data. At ~100 B per minimal
`console.log`, that is about 2,600 events per request (UNVERIFIED event
size). About 1.9M such requests trip the account-wide 5B/day threshold,
which is roughly 32 minutes at 1,000 req/s on one Verified public route.
After that every tenant's logs are sampled at 1% for the rest of the UTC
day.

The bill:

- **Today:** 5B events × $0.60/M ≈ **$3,000/day**.
- **From 2026-12-01:** 1,000 req/s × 256 KB is about 22 TB/day of ingestion,
  so about **$5,500/day** at $0.25/GB.

Both figures are UNVERIFIED (event size, and whether ingestion stops being
billed once sampling starts). D10's "logs off or 1% for Free/Verified"
therefore carries money, not just fidelity. The deploy service must write
`observability` per plan, and the poller must watch log events per script.

### 2.6 Time to first open for a lazy install

| Step | Calls | Documented fact | Latency |
|---|---|---|---|
| Perimeter: catalog host with no `apps` row → entitlement (plan, verified email) → interstitial | 0 | n/a | ms (new code) |
| `AppDeployer` DO lease per `{orgId}:{appId}` (H10) | 0 | DO soft limit 1,000 req/s per object (DO limits) | ms |
| D1 create | 1 | Control-plane endpoints "still require access to Cloudflare's core data centers" ([D1 REST latency changelog, 2025-05-29](https://developers.cloudflare.com/changelog/post/2025-05-30-d1-rest-api-latency/)) | **UNVERIFIED** |
| Migrate (one batch) | 1 | `/query` is authenticated at the edge, 50-500 ms faster (same changelog); a batch must finish within 30 s (D1 limits fn 4) | **UNVERIFIED** |
| Assets session + buckets (runs in parallel with the D1 steps) | 1 + b | JWT valid 1 h; empty `buckets` → skip uploads (WfP static assets) | **UNVERIFIED** |
| Script `PUT` | 1 | "first-time uploads of User Workers are now deployed synchronously. A 200 OK response guarantees the script is fully provisioned" ([changelog, 2025-02-20](https://developers.cloudflare.com/changelog/post/2025-02-20-synchronous-uploads/)); startup must fit in 1 s (Workers limits) | **UNVERIFIED** |
| `GET` bindings (A4 deep-equal check) | 1 | n/a | **UNVERIFIED** |
| Registry insert, LRU invalidation, redirect | 0 | n/a | ms |

- **Critical path:** max(D1 create → migrate, assets) → `PUT` → `GET`.
- **With a warm pool:** a pool of pre-created, pre-migrated D1 databases per
  catalog app reduces the critical path to (claim ∥ assets) → `PUT` →
  `GET`, which is 2-3 sequential calls.
- **Proposed budget:** p50 ≤ 5 s and p95 ≤ 10 s with a progress
  interstitial. If the pool path misses that, add prefetch: start the
  install when a member opens the launcher or hovers the tile.
- **Measurement (add to H0, UNVERIFIED until run):** from a deployer Worker
  in the scratch account (not a laptop), run 50 sequential and 50
  concurrent (10 at a time) fresh installs of the built todo bundle, with
  and without a pool D1. Record per-step wall time, p50/p95, and the
  `Ratelimit` header after each call. Then delete everything with the
  `org-` tag.

---

## 3. Recommendation

**Default: lazy, per app, on first open, for dispatch-tier catalog apps.**

1. **Nothing at sign-up.** Sign-up creates the org, the membership and the
   Autumn customer only. This follows T11/S12 and fits Q8 (no personal org
   for invitees).
2. **Install on first open** by a member of an email-verified org entitled
   to the app. The perimeter routes a `{app}-{orgKey}` host with no `apps`
   row to an install interstitial. The `AppDeployer` job runs the six
   calls. The `apps` row goes `provisioning → active`, the browser follows
   the job's SSE stream, then redirects.
   - The launcher lists catalog apps from `catalog_apps` and the plan, not
     from `apps` rows.
   - OpenSEO on the platform tier needs only an install row, so it is
     instant.
3. **Warm pool:** N pre-migrated D1 databases per catalog app (start with
   N = 25). The deployer cron refills the pool, and every release with a
   migration also migrates the pool. Pool DBs use opaque names; the ledger
   maps them by UUID.
4. **`CfApiBudget` DO in the deployer:** one token bucket per Cloudflare
   principal, fed by the `Ratelimit` header. Priority lanes: takedown >
   interactive install > deploy > upgrade fan-out > poller. It never sends a
   call that would 429.
5. **Upgrade fan-out touches installed apps only.** Use `keep_assets: true`
   when the asset manifest hash is unchanged (2 calls per install).
   Releases ship only through canary waves (H17).
6. **Autumn entities only for apps that meter**, created on the first
   metered call by `OrgWallet`, not at install. todo, workout and RepoLens
   never become entities, which keeps a Free org at 1-2 Autumn units.
7. **Scheduler:** H15 always fans out through a Queue, ≤25 dispatches per
   consumer invocation, until R26 shows dispatch is exempt from the
   32-invocation cap. Add per-org minute jitter for hourly-or-slower
   catalog crons.
8. **No reclaim in v1.** Installs keep their D1 even if unused. Revisit
   when D1 use passes 70% of the granted limit (founder question D13).

**Why not eager:**

- 2.7× fewer orgs per account under the D1 count and Autumn ceilings.
- Every sign-up spends ~24 API calls, so a launch spike queues for hours
  and competes with takedowns.
- Every release fans out to copies nobody opened (16.7 h versus 6.3 h at
  10k orgs).
- A bot that verifies an email turns straight into 4 databases.

**What lazy costs:**

- About 1.5-2 engineer-days over H17: interstitial 0.5 d, pool 1 d,
  trigger and launcher 0.25-0.5 d.
- About 1 day for the budget governor in H10.
- A one-time wait of a few seconds per app per org. It is UNVERIFIED until
  the H0 measurement.

**Cost to change later: cheap.** Eager install is a per-app flag
(`catalog_apps.auto_install`) that runs the same job at sign-up for new
orgs. Moving from eager to lazy only stops creating new installs; existing
installs stay.

**The bigger lever, noted for later and not recommended now:** catalog
apps as Dynamic Workers with DO-facet state.

- No per-org script and no `PUT`.
- Billed "$0.002 per Dynamic Worker per day" only on days the app runs,
  after 1,000 unique Dynamic Workers per month ([Dynamic Workers pricing, 2026-06-11](https://developers.cloudflare.com/dynamic-workers/pricing/)).
- It would mean rewriting the D1-backed catalog apps onto DO-facet SQLite
  (wfp report, Dynamic Workers section). Revisit if first-open latency or
  the per-script count becomes the problem.

---

## 4. Exact text changes to README.md

**§3, new section C10, inserted after C9 (line 475 block):**

> **C10. Tenant ceilings, turned into org counts.** Per org: Free = 4
> dispatch scripts + 4 D1 (todo, chef, workout, RepoLens; OpenSEO is
> platform tier, zero per-org resources); Verified = 7 + 7. Eager, the
> first ceilings are Autumn Free (10,000 customers + entities → 2,000 orgs
> if every install is an entity), the control-plane D1 (about 330-500
> proxied req/s today with `cookieCache` off and access uncached → ~8,000-
> 12,000 active orgs; 10 GB cannot be raised, so audit rows must leave it,
> C5), then D1 databases (50,000/account → 12,500 orgs; raisable to
> millions by form). WfP scripts are unlimited ($0.02/script/month after
> 1,000), DO namespaces are unlimited in WfP, KV is 0 per org after B1
> (else 250 orgs), regular Workers (500) and cron triggers (250) bind only
> the platform tier, Custom Domains (100/zone) bind nothing under one
> wildcard route, Cloudflare for SaaS caps BYO at 50,000 hostnames ($0.10
> each after 100). Rates: the API allows 1,200 calls / 5 min per user
> principal and a 429 blocks every call for 5 min, so eager sign-up
> provisioning tops out at ~600 orgs/hour and one code-only catalog
> release to 10k orgs takes ~1.4 h (2 calls/install; 4.2 h with a
> migration and changed assets; 16.7 h for all four apps installed
> eagerly). GraphQL is 300 queries / 5 min on top of that: the poller
> must query per namespace, never per org. Workers Logs drop to 1% for
> the whole account after 5B events/day, and one public tenant route can
> reach that in about half an hour. Unit cost of an idle Free org: ~$0.08/month
> eager, ~$0.03 lazy, dominated by script fees; an active org adds
> ~$0.05-$0.08. Smallest change: lazy catalog installs with a warm D1 pool
> (D2, H17), a `CfApiBudget` governor in the deployer (H10), Autumn
> entities only for metering apps (H13), Queue fan-out in the scheduler
> (H15), per-plan `observability` forced by the deployer (H10, D10), and
> the D1 limit increases filed at account creation (D7). Source:
> `raw/r2-unit-economics-and-limits.md`.

**D2 (line 501), replace the "Default:" through "Cost to change" sentences
with:**

> Default: two tiers: shared `tier='platform'` for OpenSEO-type SaaS apps
> already keyed by `organization_id` (no per-org Cloudflare resources);
> per-org dispatch for todo/chef/workout/RepoLens, forks and org apps.
> Dispatch-tier catalog apps install **lazily, per app, the first time a
> member of a verified org opens them**: the perimeter shows an install
> interstitial for a catalog host with no `apps` row and the deployer runs
> the install (about six Cloudflare API calls; a warm pool of pre-migrated
> D1 per catalog app takes create and migrate off the wait). Nothing is
> created at sign-up. An idle Free org costs ~$0.03/month lazy vs ~$0.08
> eager, and lazy fits about 2.7× more orgs under the D1 and Autumn
> ceilings (C10). Phase 1 ships single-Worker dispatch apps; OpenSEO joins
> on the platform tier in phase 2. Cost to change: moving an app between
> tiers is a data migration per org (moderate); lazy ↔ eager is a per-app
> flag (`catalog_apps.auto_install`) that affects only new orgs (cheap).

**D7 (line 567), replace the "Why:" ceilings list and the "Default:"
sentence:**

> Why: ceilings are per account (D1 50,000 databases and 1 TB; KV 1,000;
> regular Workers 500; cron triggers 250). The API allows 1,200 requests per
> 5 minutes per user principal, counted across all of that user's tokens
> and the dashboard. A 429 blocks every call for 5 minutes. Only Enterprise
> can raise it, through Support. See C10 for org counts. ... Default: a new
> account used only for hosted, WfP bought now, and at account creation the
> Developer Platform Limit Increase Request Form filed for **D1 databases
> → 250,000** and **D1 account storage → 5 TB** (no KV request: B1 removes
> per-app KV; ask about the API rate limit in the same form and plan for
> 1,200 regardless). Record `cf_account_id` per org and resource from day
> one so sharding later is a data change. Shard when the API budget runs
> >50% for a week or D1 passes 70% of the granted limit.

**H17 (line 745):** replace "auto-install flags" with:

> lazy install on first open (perimeter interstitial on a catalog host
> with no `apps` row → `AppDeployer` install → SSE → redirect; `apps` row
> `provisioning → active`; launcher lists `catalog_apps` by plan);
> warm pool of pre-migrated D1 per catalog app (deployer cron refills;
> every release migrates the pool); `catalog_apps.auto_install` (default
> false); upgrade fan-out over installed apps only, paced by
> `CfApiBudget`, `keep_assets: true` when the asset manifest hash is
> unchanged

Change the size from **4 to 5.5**.

**H10 (line 738):** append the following to "Contains" and change the size
from **6 to 7**:

> `CfApiBudget` DO: one token bucket per Cloudflare principal fed by the
> `Ratelimit` response header, priority lanes takedown > interactive
> install > deploy > fan-out > poller, never sends a call that would 429;
> `observability` forced per plan (Free/Verified: invocation logs only or
> `head_sampling_rate` ≤ 0.01).

**H13 (line 741):** replace "`entities.create/delete` on install/tombstone"
with:

> `entities.create` on an app's first metered call (from `OrgWallet`),
> `entities.delete` on tombstone; alert at 8,000 Autumn customers +
> entities.

**H15 (line 743):** replace "Queue fan-out when the due set is large" with:

> fan-out always through a Queue, ≤25 dispatches per consumer invocation
> (a request may invoke at most 32 Workers; whether dispatch counts is
> R26); per-org minute jitter for hourly-or-slower catalog schedules

**H16 (line 744):** after "usage poller (deployer cron) over
`workersInvocationsAdaptive` and `durableObjectsPeriodicGroups` per
script", insert:

> (one GraphQL query per namespace per window grouped by `scriptName`;
> GraphQL allows 300 queries / 5 min on top of the API budget) plus
> Workers Logs events per script

**H0 (line 718):** append the following and change the size from **1.5 to
2**:

> 50 fresh todo installs from a deployer Worker with per-step timings
> (p50/p95, with and without a pool D1); asset-upload dedupe across two
> scripts in one namespace; whether two account-owned tokens have
> independent 1,200/5 min budgets (read `Ratelimit`); whether
> `DISPATCHER.get().fetch` counts toward the 32-invocation limit (one
> request dispatching to 40 scripts); control-plane D1 bytes per org (seed
> 100 synthetic orgs, read `file_size`)

**"Defaults we will take" (line 652), add three bullets:**

> - Catalog installs on the dispatch tier are lazy (first open) with a
>   warm D1 pool; nothing is provisioned at sign-up.
> - The deployer owns the Cloudflare API budget (`CfApiBudget`); nothing
>   else calls the Cloudflare REST API in production.
> - Autumn app entities exist only for apps that meter.

**§6, replace R17 (line 788):**

> | R17 | D1 databases (50,000) and account storage (1 TB) can be raised in
> time | D1 limits fn 1-2: by request, "millions to tens-of-millions"; no
> SLA on the form | File both at account creation | Lazy installs + pool
> already give ~33,000 Free orgs at 50,000; shard by `cf_account_id` |

**§6, add these rows:**

> | R24 | Lazy first-open install fits p95 ≤ 10 s | unverified (no
> documented D1-create or `PUT` latency) | H0 timing run | Prefetch on
> launcher open; if still slow, eager for one "starter" app via
> `auto_install` |
> | R25 | Account-owned tokens have independent 1,200/5 min budgets | API
> limits page says "per user/account token" and "per user ...
> cumulatively" | Two tokens in parallel, read `Ratelimit` | One budget
> for everything; `CfApiBudget` priorities matter more |
> | R26 | Dispatch `fetch` counts toward the 32-Worker-invocations-per-request cap | undocumented | One request dispatching to 40 scripts | If not, the scheduler can dispatch in-process up to the subrequest limit |
> | R27 | Asset uploads dedupe across scripts in one namespace | "recently uploaded" files omitted; scope unstated | Two scripts, same manifest | b = 0 after the first org; otherwise ~1 extra call per install |
> | R28 | Control-plane bytes per org and per-request query time | estimates only | Seed 100 orgs; read `file_size` and `meta.duration` | Audit/ledger off D1 sooner (C5); per-org gateway shards |

**§7 Appendix, add these rows:**

> | "the 500-script count ... favor[s] the shared tier" (A1 line 219, R2) |
> qualified | WfP user scripts are unlimited (WfP limits, 2026-10-13);
> 500 binds only regular Workers and the scripts that hold Workflows. The
> shared tier still wins on account-wide Workflow names, 100 Workflow
> `schedules` per account, and per-org data migration (r2-unit-economics) |
> | "API 1,200/5 min/token" (D7) | qualified | Per user principal,
> cumulative across that user's tokens and the dashboard; a 429 blocks all
> calls for 5 min; raisable only for Enterprise (API rate limits,
> 2026-08-25) (r2-unit-economics) |
> | "File KV and D1 increases at launch" (D7, R17) | qualified | KV
> needs no increase once B1 removes per-app KV; file D1 count and storage
> at account creation, not launch (r2-unit-economics) |

---

## 5. New founder decisions

**D13. Catalog app provisioning: create each org's copies at sign-up, or
the first time someone opens each app? Do we ever reclaim unused copies?**

- **Why it matters:** this sets four things:
  - how many orgs fit in one Cloudflare account (12,500 vs ~33,000 at the
    default D1 limit);
  - how long a launch spike or a release takes (hours of API budget);
  - how much a bot that passes email verification can consume;
  - whether a new user waits a few seconds the first time they open an app.
- **Options:**
  - (a) eager at sign-up;
  - (b) lazy on first open, with a warm D1 pool;
  - (c) prefetch all four on the first verified sign-in.
  - Reclaim sub-options: never; delete never-written installs after 30
    days; archive idle installs.
- **Default:** (b), with a p95 ≤ 10 s budget to confirm in H0. No reclaim in
  v1; revisit at 70% of the D1 grant.
- **Cost to change:** cheap. It is a per-app flag and affects only new
  orgs. Reclaiming installs that hold data later is a policy promise, so
  decide before launch copy mentions it.

**D14. When the Autumn Free cap (10,000 customers + entities) nears, pay
for Autumn Pro or keep apps out of Autumn?**

- **Why it matters:** with app entities created at install, the cap arrives
  at 2,000 Free orgs. With entities only for metering apps, it arrives
  around 5,000 orgs. Pro is $375/mo with unlimited units.
- **Default:** entities only for metering apps (H13 change above). Move to
  Pro at 8,000 units; that is cheaper than restructuring per-app
  attribution.
- **Cost to change:** moderate. Per-app `usage_limits` live on entities.

---

## 6. UNVERIFIED items and the live check that settles each

| # | Item | Live check (scratch account unless noted) |
|---|---|---|
| U1 | Latency of D1 create, migrate batch, assets session, first `PUT`, `GET` bindings; the p50/p95 first-open budget | H0: 50 sequential + 50 concurrent (×10) todo installs from a deployer Worker, with and without a pool D1; log per-step wall time |
| U2 | Asset dedupe across scripts in one namespace (b = 0 after the first org) | Upload the same asset manifest to two new scripts; check that the second session returns empty `buckets` |
| U3 | Whether account-owned tokens have separate 1,200/5 min budgets | Two account tokens issuing calls in parallel; read the `Ratelimit` header on each |
| U4 | Whether a dispatch `fetch` counts toward the 32-invocation cap | A gateway request dispatching sequentially to 40 user scripts; watch for the exception at 33 |
| U5 | Control-plane bytes per org (~50 KB static, ~1.5 MB with 30 days of audit) and per-query time (~1 ms) | Seed 100 synthetic orgs with a realistic MCP audit; read `GET /d1/database/{id}` `file_size` and `meta.duration` |
| U6 | Migrated catalog DB size (~50 KB) and average tenant DB size (4 MB) | Create and migrate each catalog DB and read `file_size`; sample real orgs after launch |
| U7 | Usage assumptions: 1.5 of 4 catalog apps opened per Free org; 5 members × 300 requests/day; 10% of daily traffic in the peak hour | Product analytics over the first 100 orgs |
| U8 | Workers Logs event size (~100 B minimal, ~1 KB typical) and whether ingestion past 5B/day is billed at 1% | Emit known logs from a test Worker; read Billable Usage after 2026-12-01 |
| U9 | Whether the 1,000 included WfP scripts are counted at peak or as script-months | Read the first WfP invoice line (with R18) |
| U10 | Whether a gateway → user Worker chain bills against WfP's 20M pool or Workers Paid's 10M | Same invoice |
| U11 | Whether the limit form will raise the API rate limit for a non-Enterprise account, and the turnaround on D1 increases | File at account creation; record the response time in `live-checks.md` |
| U12 | Cloudflare for SaaS $0.10 is per month (docs say "per additional hostname"; the 2022 blog says "a month") | First invoice once H26 ships |
