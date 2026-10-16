# OpenSEO as the first app billed by the gateway

Researcher: OpenSEO fit. Date: 2026-10-15.
Inputs: OpenSEO at `/Users/bensenescu/workspaces/open-seo` (HEAD `847c8854`, read-only), this worktree (`e1d9d3c6`), OpenSEO's live Autumn catalog (read through the Autumn MCP, `live` env, 2026-10-15, read-only), and dated Cloudflare / Autumn / DataForSEO / OpenRouter docs (§6).

OpenSEO paths are relative to the OpenSEO repo. Every App paths are relative to this worktree.

## TL;DR

- **OpenSEO's billing is about 5,600 lines of code, tests and docs**, but it all goes through two narrow seams. Every DataForSEO charge goes through `meterDataforseoCalls` (`src/server/lib/dataforseo/client.ts:297-378`). Every LLM charge goes through `SamChatAgent.recordSpend` (`src/server/features/sam/SamChatAgent.ts:407-452`). The 23 feature files that call `createDataforseoClient` don't need to change. The port is mostly a change of transport: send DataForSEO and OpenRouter through the gateway and stop metering in the app.
- **Today, every metered call waits on at least two Autumn round trips.** The hold (`check` with a `lock`) runs before the call. The settle (`balances.finalize`) and a PostHog flush run before the response returns (`client.ts:320-377`, `posthog.ts:74`). Each Autumn call has a 10 s client timeout (`src/server/billing/autumn.ts:18`). The 2026-07-06 incident was these calls holding isolates open (`autumn.ts:23-28`, `subscription.ts:24-30`).
- **Recommended gateway design: one Wallet Durable Object per org, holding a local credit ledger.** Holds and settles are atomic in the DO. Autumn becomes the system of record that the wallet syncs with in the background: an outbox of `track` calls with an idempotency key, refreshed by webhooks and alarms. An app request then waits on at most one DO round trip and never on Autumn. The 2026-07 spec rejected "serialize each org in a DO" (`docs/maintainers/specs/0002-…:51`), but its concern was serializing provider calls. The wallet serializes only ledger updates, which take microseconds.
- **Blocker for the assumed hosted shape:** Cloudflare's Workflows limits page (updated 2026-09-21) says "Workflows cannot be deployed to Workers for Platforms namespaces". OpenSEO depends on two Workflows: the site audit, which lives in a separate audit Worker, and rank checks. A per-org OpenSEO on Workers for Platforms (WfP) can't run today. The gateway billing design works for both deployment shapes. The founder has to pick the shape (§4, Q4).
- **The port branch `t3/port-openseo-to-gateway` is empty.** It points at `2b37ad17` (2026-10-14), which is already on `main`. Both `git log main..t3/port-openseo-to-gateway` and `git diff --stat main...t3/port-openseo-to-gateway` print nothing.
- **OpenSEO-side PR: about 5–7 engineer-days with agents.** It adds an `everyapp` mode next to the current ones and doesn't remove them, because app.openseo.so has paying customers on Autumn today. Deleting the roughly 5.6k lines of Autumn code is a second PR of about 1 day, once those customers have moved.

---

## 1. What exists today

### 1.1 OpenSEO's live Autumn catalog (read 2026-10-15)

Read from Autumn org "Ben Senescu's Org", env `live`, through `getCurrentOrganization`, `listFeatures` and `listPlans`. Nothing was written.

| Plan id | Price | Grants | Notes |
|---|---|---|---|
| `onboarding_plan` | none | `managed_service_access`; 500 `usage_credits`, one-off | **`auto_enable: true`**: this is the default, not `free_plan` |
| `free_plan` | none | `managed_service_access`; 500 `usage_credits`, one-off | `auto_enable: false` |
| `base-plan` v4 | $10/mo | `managed_service_access`, `paid_plan`; 10,000 `usage_credits`/month | `overage_allowed` on `usage_credits` with an absolute `overage_limit: 500` |
| `yc-plan` | $50/mo | same flags; 50,000/month | promo codes at checkout (`src/shared/billing.ts:36-39`) |
| `friends_and_family_2` | none | same flags; 20,000/month | grants `paid_plan` with no price (`lifecycle-events.ts:6-11`) |
| `credit-top-up` (add-on) | $1 per 1,000 `topup_credits`, prepaid, `max_purchase: 100` | one-off `topup_credits` | the UI sells $10–$99 (`src/routes/_app/billing.tsx:305-322`) |

Features: `managed_service_access` and `paid_plan` are boolean. `seo_data_usage` and `llm_usage` are metered. `usage_credits` and `topup_credits` are credit systems, and each maps both metered features at 1 credit per unit.

### 1.2 (a) Inventory of every billing touchpoint

"Hot" means the user's request waits on it.

| # | Touchpoint | Where (OpenSEO) | What it does | Autumn/vendor calls | Hot? |
|---|---|---|---|---|---|
| 1 | Autumn client | `src/server/billing/autumn.ts:4-63` | Lazily loads `autumn-js`, 10 s client timeout, 2.5 s retry window for gates (incident 2026-07-06) | — | — |
| 2 | Retry policy for writes | `autumn.ts:65-86` | Retries `track`, lock checks and `finalize` on 429 only. The comment says `track` "has no idempotency key". | — | — |
| 3 | Make sure the customer exists | `subscription.ts:24-64`; called from `client.ts:312`, `AuditService.ts:47`, `rendering-billing.ts:45`, `server.ts:95-100` (SAM socket) | Autumn customer id = org id. A KV flag cached for 24 h skips `customers.getOrCreate` | `customers.getOrCreate` on a KV miss | yes |
| 4 | Entitlement: paid plan | `subscription.ts:68-89` (`customerHasPaidPlan`, optional re-check after 300 ms) | Gates rank checks (`RankTrackingService.ts:425-432`), AI Visibility (`src/serverFunctions/ai-search.ts:18-25`), scheduled rank checks (`scheduledRankChecks.ts:49-58`, memoized per tick), the audit tier (`AuditService.ts:37-58`) | `check(paid_plan)` | yes |
| 5 | Entitlement: managed access | `subscription.ts:91-98` | Turns away orgs with no plan; used only by audits (`AuditService.ts:48-54`) | `check(managed_service_access)` | yes |
| 6 | Balance read | `subscription.ts:103-146` | Monthly plus top-up. Throws when the monthly balance comes back empty (a customer was locked out on 2026-07-20) | 2–3× `check` | yes |
| 7 | Out-of-credits gate (SAM) | `subscription.ts:160-206`; `SamChatAgent.ts:327-350` | Gate per turn. Re-checks against the customer object before refusing | 2–3 `check` + `customers.getOrCreate` | yes, every turn |
| 8 | Credit hold | `subscription.ts:208-297` (`holdCredits`, 30-minute TTL) | `check({requiredBalance, lock})`. Retries a broken read once, treats 409 `lock_already_exists` as success | `check` with a lock | yes |
| 9 | Batch reservation | `subscription.ts:299-415` (`reserveUsageCredits`) | Places each call on monthly, then top-up, at most one hold per pool. Emits a `usage:credits_gate_refused` event and throws `INSUFFICIENT_CREDITS` | 1–4 lock checks | yes |
| 10 | Settle | `subscription.ts:430-538` (`finalizeHold`, `settleUsageCredits`) | Confirms at the real cost or releases. Retries once. Never throws. Logs undershoot | `balances.finalize`, PostHog | **yes**: awaited before the data returns (`client.ts:350-377`) |
| 11 | After-the-fact deduction (LLM) | `subscription.ts:552-626` (`trackUsageCreditSpend`) | Splits the cost across monthly and top-up from a balance the caller read earlier. Two `track` calls | `track` ×1–2 | no (SAM chains it) |
| 12 | DataForSEO metering seam | `src/server/lib/dataforseo/client.ts:80-93` (`meter`), `95-283` (client), `297-378` (`meterDataforseoCalls`) | Estimate, hold, call, settle. Hosted mode only (`304-310`). `waitUntil` keeps the settle alive if the client disconnects (`368-376`) | via 3, 9, 10 | yes |
| 13 | Where cost is read | `src/server/lib/dataforseo/envelope.ts:12-20, 55-113` | `{path, cost}` comes from `tasks[0]`. A charged task that failed still bills (`envelope.ts:29-51`; `client.ts:333-346`) | — | — |
| 14 | Price table for estimates | `src/server/lib/dataforseo/pricing.ts` (291 lines) | Upper-bound raw USD per endpoint. Required at compile time by `meter()` | — | — |
| 15 | Free collection | `src/server/lib/dataforseo/index.ts:25-35` | `task_get` and categories are unmetered (charged at `task_post`) | — | — |
| 16 | Cost formula and markup | `src/shared/billing.ts:15-18, 41-70` | 1,000 credits = $1. Markup 1.28× (`SEO_DATA_COST_MARKUP`). `creditsForProviderUsd = ceil(round5(raw*1.28)*1000)` per call. **The same markup applies to LLM spend** (`subscription.ts:568-569`) and to rendering (`src/shared/audit-rendering.ts:22-26`) | — | — |
| 17 | Feature labels | `src/shared/billing-credit-features.ts:1-78` | 9 `CreditFeature`s. Maps a DataForSEO path to a feature. Labels for the usage UI | — | — |
| 18 | Rendering hold (site audit) | `src/server/lib/audit/rendering-billing.ts:39-162` | Worst-case hold before the audit (TTL 24 h minus 1 min, Autumn's maximum), split across monthly and top-up. Settled at Browser Rendering ($0.09/h) plus Context.dev ($0.0025 per credit) costs (`audit-rendering.ts:9-26`) | lock checks, `finalize` | yes at start |
| 19 | Rank-check preflight | `src/server/workflows/RankCheckWorkflow.ts:103-124` | Not atomic: `check` both pools, compare with the estimate (`src/shared/rank-tracking.ts`) | 2× `check` | Workflow |
| 20 | LLM metering (SAM) | `SamChatAgent.ts:64` (`SAM_BILLING_CHUNK_USD = 0.05`), `398-452`, `506-509`; `src/server/lib/chatAgent.ts:29-36` (`providerMetadata.openrouter.usage.cost`); `src/server/lib/openrouter.ts:29-61` | Adds up spend per step and sends `track` in chunks of $0.05. Compaction cost is included too (`SamChatAgent.ts:237-245`). **SAM has been hidden in the UI since 2026-10-01** (`db8bde17`) | `track` | no |
| 21 | Client plan and balance | `src/client/features/billing/useCreditBalance.ts`, `HostedPlanGate.tsx`, `plan-detection.ts`, `FreePlanBanner.tsx`; `src/routes/__root.tsx:144-149` (one `AutumnProvider`, "~1s getOrCreateCustomer") | `autumn-js/react` `useCustomer` goes through `/api/autumn/*` | `customers.getOrCreate` | page load |
| 22 | Autumn proxy route | `src/routes/api/autumn/$.ts:9-101` | `autumnHandler` with `identify` = org id. Writes are owner-only (`14-20`, `73-85`) | any | — |
| 23 | Checkout, portal, top-up | `src/routes/_app/billing.tsx:112-120, 279, 333-347`; `_authenticated.subscribe.tsx:180`; `_authenticated.yc.tsx:99`; `_app/billing_.fix-payment.tsx:118`; Stripe parameters in `shared/billing.ts:24-39`; offers in `plan-offers.ts` | `attach` (base, YC, top-up with `featureQuantities`), `openCustomerPortal`, polling after checkout (`route-state.ts:22-77`) | `attach`, portal | user action |
| 24 | Usage breakdown UI | `src/serverFunctions/billing.ts:58-144`; `BillingUsageChart.tsx`, `BillingFeatureBreakdown.tsx`, `useBillingUsageEvents.ts` | Raw `POST /v1/events.list` with pages of 1,000, retries on 429. Groups by the `creditFeature` property | `events.list` (5 rps per customer) | page load |
| 25 | MCP balance | `src/server/mcp/tools/whoami.ts:12-54`; `mcp/output-schemas.ts:21-22` (`creditsCharged/Remaining`); credit estimates in tool descriptions (`mcp/tools/research-keywords.ts:40,63,115`); instruction about the billing link (`mcp/server.ts:173`) | Two `check` calls | 2× `check` | MCP call |
| 26 | Webhook | `src/server/billing/autumn-webhook.ts:8-96`, `svix.ts`; routed at `src/server.ts:157-158` | `billing.updated` syncs the status, then Dub | `customers.getOrCreate` | — |
| 27 | Status mirror | `customer-status-sync.ts:12-71`, `customer-status-model.ts`, table `billing_customer_status` (`src/db/billing.schema.ts:5`, `src/db/pg/billing.schema.ts:8`). Its only other reader is `scripts/paying-customer-onboarding-answers.sql:15` | Snapshot used to compare against the previous state | — | — |
| 28 | Lifecycle emails | `lifecycle-events.ts:32-82`, `loops-sync.ts:25-107`, `loops-contact-properties.ts`; `specs/0015-…`, `docs/maintainers/billing-lifecycle-emails.md`, `scripts/backfill-billing-lifecycle-events.mts` | `subscription_started`, `payment_failed`, `subscription_canceled` go to Loops, idempotent, owners only | Loops | — |
| 29 | Referrals (Dub) | `src/server/referrals/dub.ts:8-289`, `dub-sale.ts`; daily sweep at `src/server.ts:207-214` | Lead at signup, org pin in KV, sales from Autumn invoices | `customers.get(expand invoices)`, Dub | — |
| 30 | GDPR erasure | `docs/maintainers/runbooks/gdpr-erasure.md:5-6, 72-73`; `scripts/erase-user-data.ts`; `src/server/gdpr/storage-erasure.ts:4-7` (Dub KV pins) | Deletes the Autumn customer and the linked Stripe customer, the Loops contact, PostHog data | Autumn, Stripe | — |
| 31 | Analytics | `src/server/lib/posthog.ts:49-75` (hosted only, **awaits `client.shutdown()`**) | `usage:credits_consume`, `usage:credits_gate_refused`, `billing:*` | PostHog | yes (inside settle) |
| 32 | Errors | `src/shared/error-codes.ts:6-7`; `src/server/lib/http-errors.ts:14-15` (402); `src/client/lib/error-messages.ts:8-11` | `PAYMENT_REQUIRED`, `INSUFFICIENT_CREDITS` | — | — |
| 33 | Deploy and secrets | `deploy/alchemy/alchemy.run.ts:266-291` (`AUTUMN_SECRET_KEY`, `AUTUMN_WEBHOOK_SECRET`, `DUB_API_KEY`, `LOOPS_*`, `POSTHOG_*`), `:403-404` (the audit Worker gets `AUTUMN_SECRET_KEY` for metering) | — | — | — |
| 34 | Permissions | `src/lib/org-permissions.ts:17,29` (`billing: ["manage"]`) | Owner-only billing | — | — |

Sizes: `src/server/billing/*` (14 files, about 1,800 lines with tests), client billing (19 files, about 1,000), routes (about 1,200), Dub (about 420), rendering billing (162), plus specs, runbooks and scripts. Total **about 5,600 lines** (`wc -l` of the files above).

### 1.3 One metered DataForSEO call today (hosted)

```
app request
 ├─ KV.get autumn:customer-ensured:<org>          (subscription.ts:39)  [miss → Autumn getOrCreate]
 ├─ Autumn check{lock} on usage_credits           (subscription.ts:267-279) [+300 ms + 1 retry on broken read]
 │    └─ refused → partial monthly hold → top-up hold (×2)  (subscription.ts:355-384)
 ├─ DataForSEO fetch (60 s budget, 2 retries on 5xx for reads)   (core.ts:11-18, 64-150)
 ├─ Autumn balances.finalize (+250 ms + 1 retry)  (subscription.ts:436-470)   ← still on the response path
 ├─ PostHog capture + await shutdown()            (posthog.ts:62-75)          ← still on the response path
 └─ response
```

That is at least two sequential Autumn round trips and one PostHog flush per metered call, on top of the provider call. Each Autumn call can take up to 10 s before the SDK gives up (`autumn.ts:13-18`). The rank-check batch shares holds only because holding and settling every call "sent up to 40 Autumn requests per rank check batch, and enough of them hit the SDK's timeout to drop charges" (`client.ts:291-295`; spec `0002…:46`). A local ledger makes that workaround unnecessary.

### 1.4 How hosted and self-host are switched today

- `AUTH_MODE` is one of `cloudflare_access` (the fail-closed default), `local_noauth` or `hosted` (`src/lib/auth-mode.ts:3-43`). The client reads the value baked in at build time (`isHostedClientAuthMode`, `:36-43`) and the server reads `env.AUTH_MODE` (`src/server/lib/runtime-env.ts:40-42`). Requests resolve through `src/middleware/ensure-user/resolve.ts:11-22`.
- `hosted` controls about five separate things at once, across 52 files. (1) Better Auth signup, verification, invitations and org switching. (2) Autumn billing and plan gates. (3) The markup shown on estimates (`shared/billing.ts:49-59`). (4) PostHog (`posthog.ts:55`). (5) The OAuth provider and Dub crons (`server.ts:195-215`).
- Self-host modes share one workspace. Everyone Cloudflare Access admits works in one org as `owner` (`src/middleware/ensure-user/delegated.ts:80-99`). That is the model a per-org Every App instance needs.
- Database: D1 by default. Postgres through Hyperdrive is used only in prod (`wrangler.jsonc:130-141`, `deploy/alchemy/alchemy.run.ts:124-149, 330-340, 365`).

### 1.5 OpenSEO's runtime shape

| Piece | Where |
|---|---|
| App Worker `open-seo` (TanStack Start, assets, smart placement, `cpuMs: 300000`) | `wrangler.jsonc`, `alchemy.run.ts:426-526` |
| Separate audit Worker `open-seo-audit`: `SiteAuditWorkflow`, the `AuditScratchpad` DO, `BROWSER`. Split out because of OOM | `wrangler.jsonc:22-33, 53-62`; `alchemy.run.ts:367-424` |
| Workflows: `site-audit-workflow` (bound to the audit Worker), `rank-check-workflow` | `wrangler.jsonc:22-39` |
| DO: `SamChatAgent` (SQLite) | `wrangler.jsonc:45-52` |
| Crons: `*/5` (rank checks + stale-audit reconcile), `17 3 * * *` (OAuth KV purge + Dub sweep) | `wrangler.jsonc:95-99`; `server.ts:188-235` |
| KV ×2 (`KV`, `OAUTH_KV`), D1, R2, rate limit `MCP_RATE_LIMIT` | `wrangler.jsonc:109-129, 143-148`; `alchemy.run.ts:484-487` |
| Its own MCP server with an OAuth provider and API keys | `src/server/mcp/*`, `OAUTH_KV` |

### 1.6 What the Every App gateway offers today

- `AppGateway` (`apps/every-app-gateway/src/server.ts:152-164`) is a `WorkerEntrypoint` with only `fetch`. It reads the caller from `props {organizationId, appId, workerName}`. The SDK sets those props (`packages/sdk/src/cloudflare/worker.ts:311-319`). The gateway checks the caller against the registry and refuses providers the manifest doesn't list (`app-gateway-entrypoint.ts:72-120`). It reads an optional user identity JWT for attribution (`:230-260`). Paths are limited to `/api/ai/<provider>` (`:194-206`).
- The AI proxy serves **OpenAI only**, with one shared key (`ai-proxy.ts:94-100`). It reads token counts from the tail of the stream and logs them (`ai-usage.ts:22-59`, `ai-proxy.ts:176-190`). It does no billing, doesn't read `cost`, and has no holds.
- Manifest `resources` cover only `d1`, `kv`, `durableObjects` and `workflows` (`packages/perimeter/src/manifest/manifest.ts:34-50`). Manifest `providers` and `ai` exist (`:110-148, 174-178`). There is nothing for billing.
- `everyAppWorker()` supports D1, KV, DOs, Workflows, crons and secrets (`packages/sdk/src/cloudflare/worker.ts:11-61, 330-411`). It doesn't support R2, Browser Rendering, Hyperdrive, rate limits or a second Worker.
- Gateway schema: no billing tables (`apps/every-app-gateway/src/db/*.schema.ts`). Gateway bindings: D1, KV and rate limits, no DOs (`apps/every-app-gateway/cloudflare.config.ts:125-151`).
- `TODO.md:36-37`: "AI Gateway routing", "Metered billing at the gateway (deferred)".
- The gateway UI moved to OpenSEO's shadcn design system on 2026-10-15 (`2c309fe4`, #283). OpenSEO's billing components can move to the gateway with almost no restyling.
- Port branch: `t3/port-openseo-to-gateway` = `2b37ad17` (2026-10-14), already on `main`. **No commits and no diff.** (I didn't inspect the uncommitted state of its worktree.)

### 1.7 Where the brief, earlier docs and comments disagree with code or live config

1. **Features.** The brief says OpenSEO bills "over two metered features (`seo_data_usage`, `llm_usage`)". Those exist in Autumn but the code never sends them. It locks and tracks the credit systems `usage_credits` and `topup_credits` directly (`subscription.ts:271-276, 589-615`). The comment at `subscription.ts:101-102` is misleading. Usage per feature comes from the `creditFeature` event property (`BillingFeatureBreakdown.tsx`), not from Autumn features. The gateway should model app features as event attributes, not as Autumn features.
2. **Default plan.** Code comments say "the free plan is the Autumn default" (`shared/billing.ts:9-11`, `subscription.ts:128-129`). Live, `onboarding_plan` is `auto_enable`, not `free_plan`. The grants are the same.
3. **Overage.** "base $10/mo with overage" is right, but overage is capped at 500 credits (`billing_controls.spend_limits`). A gateway wallet must mirror that cap, or a paid org could never use the overage that Autumn allows.
4. **Markup scope.** The brief puts the 1.28× markup on DataForSEO. The code applies it to all provider spend: DataForSEO, OpenRouter (`subscription.ts:568-569`) and rendering (`audit-rendering.ts:22-26`).
5. **Idempotency.** `autumn.ts:65` says `track()` "has no idempotency key". Autumn's track reference now documents an `Idempotency-Key` header ("Retries with the same key are rejected with a 409"). That makes an asynchronous outbox that retries safely possible. To verify (§5).
6. **DO objection.** Spec 0002 (`docs/maintainers/specs/0002-…:51`) rejects a DO per org because it "slows legitimate parallel work". That applies to a DO that wraps the provider call. A ledger DO that only does hold and settle doesn't delay parallel provider calls.
7. **Hosted shape.** The brief (Terms) and ADR-0001 §6 assume each catalog app runs on WfP, one per org. Workflows don't support WfP (§5, claim 1), and OpenSEO needs two.
8. **Outbound Worker caveats** (`docs/architecture-v2-overview.md:148-150, 164`). Still true as of 2026-04-21: outbound Workers don't see fetches from Durable Objects. New finding: with an outbound Worker on, user Workers can't use `connect()` either. That matters for Postgres or Hyperdrive in hosted apps, and SAM is a DO.

---

## 2. What the hosted tier needs

### 2.1 Principles (from the founder's vision plus OpenSEO's incident history)

1. The app never holds provider keys or billing keys. In everyapp mode, OpenSEO has no `DATAFORSEO_API_KEY`, `OPENROUTER_API_KEY`, `AUTUMN_*`, `LOOPS_*` or `DUB_*`.
2. Every charge happens at the gateway, priced by the gateway: provider and markup in the gateway's provider pack, with the app's feature as a label.
3. **No app request waits on Autumn.** The hot path costs at most one DO round trip.
4. Atomic holds stay. Spec 0002's guarantee, "the sum of in-flight holds can never exceed the balance", carries over.
5. Self-hosted Every App uses the same app code. The gateway proxies with the operator's keys and doesn't meter.

### 2.2 (b) The smallest gateway API that lets OpenSEO delete its billing

Every call goes over the existing `EVERY_APP_GATEWAY` binding as **HTTP**, not JS RPC. The proxy paths have to be fetch so vendor SDKs (`createOpenRouter({fetch, baseURL})`) and OpenSEO's own `fetch` transport work unchanged. Using HTTP for the billing calls too keeps one transport that a WfP outbound Worker could intercept, if that is how hosted ends up wiring it (claim 2). The SDK wraps the calls.

**A. Metered provider proxy: DataForSEO** (a new provider pack next to `ai-proxy.ts`)

```
POST http://every-app-gateway.internal/api/providers/dataforseo/v3/<path>
x-everyapp-identity: <user JWT, forwarded as createGatewayFetch does; optional>
x-everyapp-hold-usd: 0.0215        # raw-USD upper bound from OpenSEO's pricing.ts (required)
x-everyapp-feature: keyword_research
x-everyapp-provider-env: sandbox   # optional: sandbox.dataforseo.com, charge 0 (previews)
→ 402 {code:"insufficient_credits", requiredCredits, availableCredits, billingUrl}
→ upstream status/body streamed; x-everyapp-credits-charged: <n>
```

The gateway does this:
1. Checks the caller exactly as `app-gateway-entrypoint.ts:72-120` does, with `providers` including `"dataforseo"`.
2. Holds `ceil(round5(holdUsd × 1.28) × 1000)` credits in the org's Wallet DO. This is OpenSEO's `creditsForProviderUsd` formula moved to the gateway, so estimates and charges stay the same as today.
3. Removes the app's auth headers and adds `Authorization: Basic <platform key>` (today `core.ts:69-71`).
4. Reads the head of the stream for the top-level `"cost"` field. DataForSEO documents it as "total tasks cost, USD". It is 0 on `task_get`, so free collection stays free with no endpoint list, unlike `index.ts:25-35`. The head is read the same way `ai-usage.ts:40-59` reads the tail, so multi-MB Lighthouse bodies aren't buffered.
5. Settles at that cost once it is parsed. Nothing is charged when there is no cost (transport error, 5xx, timeout), the same as today (`core.ts:82-90`, `client.ts:333-335`). A charged task that failed is billed, because its `cost` is greater than 0 (`client.ts:336-346`).
6. Never waits on Autumn.

The app keeps `pricing.ts` (provider knowledge) and the path-to-feature map. It loses holds, settles, markup and keys.

**B. Metered AI proxy: OpenRouter** (extends the existing `/api/ai/<provider>` path)

```
POST /api/ai/openrouter/api/v1/chat/completions
x-everyapp-hold-usd: 0.50   # optional; the pack has a default ceiling per request
x-everyapp-feature: agent
```

The model allowlist comes from manifest `ai.models` (`ai-proxy.ts:132-146`). The gateway adds the platform key and holds the ceiling. `tapUsage` is extended to pull `"cost"` out of the tail. OpenRouter "always" includes usage now, "in the last SSE message". The settle uses that cost. If the cost is missing, the gateway looks the request up by OpenRouter generation id inside `waitUntil`. SAM's change is a single line: `createOpenRouter({ apiKey: "everyapp", baseURL: "http://every-app-gateway.internal/api/ai/openrouter/api/v1", fetch })` (`@openrouter/ai-sdk-provider@2.9.0` supports `baseURL` and `fetch`). That deletes `SamChatAgent.ts:64, 139-149, 327-350, 398-452, 506-509` and `trackUsageCreditSpend`.

**C. Billing calls for costs the app computes itself** (site-audit rendering, anything without a proxy)

```
GET  /api/billing/status
  → { plan:{id,name,paid}, credits:{available,monthly,topup,overageLeft},
      rates:{dataforseo:{creditsPerUsd:1280}, openrouter:{…}}, low:boolean, billingUrl, asOf }
POST /api/billing/holds        {credits|usd, provider?, feature, ttlMs?, key}  → {holdId} | 402
POST /api/billing/holds/:id/settle {credits|usd, meta?}   (idempotent; safe in waitUntil)
POST /api/billing/holds/:id/release
POST /api/billing/track        {credits|usd, provider?, feature, key, meta?}  (after the fact; no gate)
```

- `status` replaces `customerHasPaidPlan` / `customerHasManagedAccess` (#4, #5), the balance reads (#6), the rank preflight (#19) and `whoami` (#25). `rates` lets the UI and MCP descriptions show the same credit numbers without knowing the markup.
- `holds` and `settle` replace `rendering-billing.ts` (#18), with no 24-hour cap.
- `track` covers costs the app measures itself: Browser Rendering minutes, Context.dev credits. Gateway-authored packs should do the pricing wherever the gateway can proxy the call.

**D. Billing UI and webhooks rendered by the gateway**

- `https://<gateway>/billing` shows the plan, balance (monthly and top-up), upgrade, portal, top-ups ($10–$99), fix-payment and the YC promo page. Writes are owner-only, which ports `routes/api/autumn/$.ts:14-20, 73-85`. It also shows **usage over the last 30 days by app, feature and person**, read from the gateway's own `usage_events` table in D1 instead of Autumn's `events.list` (#24), which allows 5 requests per second per customer. The components port from `src/client/features/billing/*` and `routes/_app/billing*.tsx`.
- Apps link to `billingUrl` (`?app=openseo&return=<url>`). OpenSEO's MCP instruction already shares "the billing link from that error" (`mcp/server.ts:173`).
- `POST https://<gateway>/api/webhooks/autumn` verifies svix (port `svix.ts`) and refreshes the wallet. It also runs lifecycle emails over the gateway's email transport (port `lifecycle-events.ts` + `customer-status-model.ts`, moving `billing_customer_status` into the gateway D1).

**E. Manifest additions**

```ts
providers: ["dataforseo", "openrouter"],          // existing field, new names
ai: { models: ["openai/gpt-5.6-luna"] },          // existing
billing: { features: { keyword_research: "Keyword Research", site_audit: "Site Audit", agent: "SAM Agent", /* … */ } }
```

The `billing.features` labels replace `CREDIT_FEATURE_LABELS` (`billing-credit-features.ts:12-26`) on the gateway's usage page. A label the manifest doesn't declare shows as "Other", as today.

### 2.3 (c) What must be synchronous, and the latency budget

**Wallet DO**: one per org (`WALLET.idFromName(orgId)`) in the gateway Worker. It stores this in SQLite:
- pools: `usage_credits` remaining, reset time and overage left; `topup_credits` remaining;
- active holds: id, credits per pool, app, feature, expiry;
- an outbox of settled usage not yet sent to Autumn;
- the Autumn snapshot (plan, flags) and `syncedAt`.

| Operation | Sync on the app path? | Who pays the latency | Budget |
|---|---|---|---|
| Caller check + manifest grant | yes | gateway (registry cache, `app-gateway-entrypoint.ts:208-228`) | ~0 (cached 30 s) |
| `hold` (proxy or explicit) | **yes**: the atomic gate | 1 DO round trip + 1 SQLite write | target p99 ≤ 50 ms when the DO is in the same region; cross-region adds one RTT (DOs don't move, see §6). Hard timeout 1.5 s, then **fail closed** with 503 `billing_unavailable` (retryable). Money doesn't fail open. |
| Provider call | yes | provider | unchanged |
| `settle` | **no** | gateway `waitUntil` once the cost is parsed (head for DataForSEO, tail for OpenRouter) | 0 on the response path. Today it is about 1 Autumn RTT plus a PostHog flush. |
| `status` / entitlements | yes where a gate needs it | 1 DO round trip (or a 30 s isolate cache for non-money UI) | ≤ 50 ms |
| Autumn `track` (outbox flush) | no | DO alarm, batched, `Idempotency-Key = holdId:pool` | — |
| Refresh from Autumn | no, except one case | alarm (every few minutes while the org is active) and the `billing.updated` webhook | — |
| Refresh before a refusal | **only when the wallet would refuse** | 1 Autumn `customers.get`, 1.5 s timeout; on timeout, refuse on local state | Same idea as OpenSEO's "confirm before refusing" (`subscription.ts:148-206`), but only on the rare refusal path |
| PostHog, lifecycle emails, `usage_events` write | no | alarm or Queue | — |
| Checkout, portal | user action on the gateway billing page | Autumn `attach` | never on an app request |

Behaviour when something fails:
- **Autumn down:** apps are unaffected. The wallet keeps gating on local state and the outbox grows. New top-ups and plan changes show up when Autumn recovers.
- **How far the wallet can drift from Autumn:** usage not yet flushed plus grants not yet seen. The first is the same overspend bound as today's holds. The second only causes false refusals, and the pre-refusal refresh handles those.
- **Isolate dies mid-call:** the hold expires at its TTL and is released. That matches `HOLD_TTL_MS` (`subscription.ts:208-210`), except the gateway, not the app, now keeps the settle alive with `waitUntil`.
- **Overdraft:** a settle above its hold may take a pool negative, down to the plan's `overage_limit` (500 on base-plan). Once a pool is negative, new holds are refused.
- **Per-app caps** (the founder's "later: usage limits per app") are a cheap local check in the same DO. They need no Autumn entities.

### 2.4 (d) What OpenSEO keeps, and what changes to run behind the gateway

**Keeps:**
- all product schema and data (projects, audits, rank tracking, reports, SAM sessions);
- `pricing.ts` (estimates become the hold hint);
- the DataForSEO path-to-feature map (sent as a header);
- the DataForSEO section fetchers, envelope and status ladder (`envelope.ts:215-278`, `core.ts`);
- the `BillingCustomerContext` type, used in 24 files. Rename it `ActorContext`; it is just user, org and project;
- the `PAYMENT_REQUIRED` / `INSUFFICIENT_CREDITS` error codes, mapped from the gateway's 402;
- the plan-tier limits on audits (`audit-capacity.ts`), keyed on `status().plan.paid`. Crawling isn't metered, so those limits still bound cost the platform pays for.

**Changes:**

| Concern | Today | Behind the gateway | Smallest change |
|---|---|---|---|
| Identity | `AUTH_MODE` hosted / access / noauth | New `everyapp` mode: verify `x-everyapp-identity` (RS256, pinned `kid`, `aud = EVERYAPP_APP_ID`, `iss`, keys from `EVERYAPP_IDENTITY_PUBLIC_KEYS`). Map `org_id` to the org, `org_role` to role, using the shared-workspace pattern of `delegated.ts:83-99` | Add a branch in `resolve.ts` plus a vendored verifier of about 100 lines (`jose`). Publishing is paused (memory note 2026-10-13), so don't depend on `@every-app/sdk` from npm |
| What "hosted" means | One flag for auth, billing, analytics and markup | Billing becomes its own capability: `billing = autumn \| gateway \| none`, where gateway = the `EVERY_APP_GATEWAY` binding is present | A `getBillingMode()` helper. `isHostedServerAuthMode()` call sites that mean billing switch to it. Hosted-only auth UI already turns off in non-hosted modes |
| DataForSEO transport | `fetch(api.dataforseo.com)` with Basic auth (`core.ts:64-150`) | `env.EVERY_APP_GATEWAY.fetch(/api/providers/dataforseo/…)` with `x-everyapp-hold-usd` and `x-everyapp-feature`. Turn off `meterDataforseoCalls`' hosted branch in this mode (`client.ts:304-310`) | About 60 lines in `core.ts` and `client.ts`. The 23 caller files don't change |
| LLM (SAM) | OpenRouter key, gate and chunked `track` | `createOpenRouter({baseURL, fetch})` pointed at the gateway. Delete the gate and the metering | About 120 lines removed from `SamChatAgent.ts` |
| Plan and credit gates | Autumn `check` | `status()` | `AuditService.ts:37-58`, `RankTrackingService.ts:425-432`, `scheduledRankChecks.ts:49-58`, `ai-search.ts:18-25`, `RankCheckWorkflow.ts:103-124`, `whoami.ts` |
| Rendering hold | Autumn locks | `holds` + `settle` | Change the bodies of `rendering-billing.ts` |
| Billing UI | `autumn-js/react`, `/api/autumn/*`, `/billing`, `/subscribe`, `/yc`, `/billing/fix-payment` | Redirect to `billingUrl`. The banner reads `status()` through a server fn | Gate routes on the billing mode. Swap `useCreditBalance` for a `status` query |
| Webhooks | `/api/autumn/webhook` | Moves to the gateway | Unmounted in everyapp mode |
| Lifecycle emails, Loops, Dub, `billing_customer_status` | In app | At the gateway, or dropped (Q7, Q8) | Unused in everyapp mode |
| GDPR | The runbook deletes Autumn and Stripe | The gateway deletes the Autumn and Stripe customer for an org. OpenSEO keeps its HMAC storage-erasure endpoint (`shared/gdpr-erasure.ts:5`) for app-local state | — |
| Database | D1 by default; prod Postgres through Hyperdrive | **D1** per instance (manifest `resources.d1`). Hyperdrive isn't in the manifest, and an outbound Worker turns off `connect()` | `DATABASE_PROVIDER=d1`. The Drizzle D1 and PG schemas are kept in sync by `src/db/schema-parity.test.ts` (see `src/db/schema.ts:30`) |
| Audit Worker | A second Worker with the Workflow, DO and Browser; bound cross-script | The manifest has one Worker per app and no cross-script Workflow binding | Self-host: support a companion Worker in the platform (§3 G9), or merge it back, which risks the OOM that caused the split (`wrangler.jsonc:24-27`). Hosted WfP: **blocked** (Workflows) |
| Workflows | 2 | Self-host Every App supports app Workflows (`acad8b29`, #282; named `<worker>--<binding>`) | Hosted WfP: **blocked** |
| Crons | `*/5`, daily | The SDK supports `crons`. In everyapp mode the daily job (OAuth purge and Dub) has nothing left to do, so one cron remains | Hosted: the 250-crons-per-account cap (non-WfP) and WfP cron support (unverified) favour a scheduler in the gateway |
| DO | `SamChatAgent`, `AuditScratchpad` | Manifest `durableObjects`. WfP supports DO namespaces | — |
| R2, Browser Rendering, rate limit | bound | Not in the manifest | Add `r2` and `browser` to the manifest. `MCP_RATE_LIMIT` and `OAUTH_KV` aren't needed: the gateway owns MCP |
| MCP | Its own `/mcp` with OAuth and API keys | The gateway strips `Authorization`, so expose the tools through the ToolBus (`/__everyapp/tools/list|call`, `apps/every-app-gateway/src/server/toolbus/*`) | Separate, larger PR (about 80 tools, already in a registry) |
| Secrets | 15+ | Only `CONTEXT_API_KEY` stays, unless Context.dev becomes a provider pack. PostHog is optional | — |

**Deployment shape (needs the founder: §4, Q4):**
- **Per-org instance** (ADR-0001 §6). Each org gets its own app Worker, audit Worker, D1, R2, KV, 2 Workflows and DOs. Under a normal Workers account that is capped at 500 Workers and 250 cron triggers per account (Workers limits, 2026-10-12): about 125 orgs at 2 crons each. On WfP it is **blocked**, because Workflows don't support WfP namespaces. It works today on **self-host** Every App, apart from G9.
- **Shared catalog instance.** One multi-tenant OpenSEO (what app.openseo.so is today: one Worker, every org, Postgres) runs as a normal Worker in the platform account and is called through the gateway. Workflows, crons and Hyperdrive keep working. The cost is that the gateway can't take the org from `props`. It charges the org in the forwarded identity JWT, which `resolveAttribution` already checks (`app-gateway-entrypoint.ts:230-260`). Background work (crons, Workflows) settles against the `holdId` taken during the user's request. Scheduled rank checks need a **background grant**: a catalog app may charge orgs that installed it, checked against the install rows. Catalog apps are code we ship, so that trust is acceptable. Org forks of OpenSEO still need the per-org shape.

### 2.5 (e) Estimate of the OpenSEO-side PR

This assumes the gateway side (§3 G1–G6) exists, or a fake of it for tests. The PR is **additive**: app.openseo.so keeps `AUTH_MODE=hosted` with Autumn until the founder decides how its customers move (Q1).

| Step | Files | Size |
|---|---|---|
| 1. `everyapp` mode: verifier, `resolve.ts` branch, role mapping, both-or-neither boot guard, `getBillingMode()` | `src/lib/auth-mode.ts`, `src/middleware/ensure-user/{resolve,everyapp}.ts`, `src/server/lib/runtime-env.ts` | 1 d |
| 2. DataForSEO through the gateway: transport in `core.ts`, hold and feature headers from `client.ts` `meter()`, map 402 to `INSUFFICIENT_CREDITS`, sandbox env | `src/server/lib/dataforseo/{core,client}.ts` | 1 d |
| 3. SAM through the gateway: `openrouter.ts` `baseURL`/`fetch`; delete the gate and metering in this mode | `src/server/lib/openrouter.ts`, `SamChatAgent.ts` | 0.5 d |
| 4. Gates through `status()`: server gates, rank preflight, `whoami`, client banner and plan gate as a server fn, billing routes redirect to `billingUrl` | about 12 files | 1 d |
| 5. Rendering holds through gateway holds | `rendering-billing.ts` | 0.5 d |
| 6. `everyapp.config.ts` (id, resources, providers, ai, billing.features, crons) and deploy wiring for the chosen shape | new | 0.5–1 d (more if G9 is needed) |
| 7. Tests: verifier with minted JWTs (the matrix in the porting skill), a fake gateway for the proxy and 402, an e2e boot in everyapp mode | `*.test.ts` | 1–1.5 d |
| **Total** | | **≈5.5–6.5 d** |
| Follow-up: delete Autumn mode (`src/server/billing/*`, `/api/autumn/*`, the `autumn-js` dependency, Dub, Loops sync, billing routes and components, specs 0002 and 0015, the backfill script, `billing_customer_status` migration) | about 70 files, about 5.6k lines | 1 d, after Q1 |
| Separate: MCP tools through the ToolBus | `src/server/mcp/*` | 2–3 d (outside billing) |

---

## 3. Gaps, and the smallest change that closes each

| # | Gap | Where | Smallest change | Size (days) |
|---|---|---|---|---|
| G1 | No ledger or holds at the gateway | `apps/every-app-gateway` (no DO today) | `Wallet` DO per org (pools, holds, outbox, alarm), plus a DO binding and migration in `cloudflare.config.ts` | 3 |
| G2 | No Autumn integration at the gateway | new `server/billing/autumn.ts` | Port OpenSEO's lazy client. Outbox flush with `Idempotency-Key`. Refresh with `customers.get`. Customer created at org creation | 1 |
| G3 | AI proxy is OpenAI-only and doesn't bill | `ai-proxy.ts:94-100`, `ai-usage.ts:22-34` | Make provider packs (upstream, key, cost extractor), add OpenRouter, extract `cost` from the tail, hold and settle | 1.5 |
| G4 | No proxy for non-AI providers | `app-gateway-entrypoint.ts:194-206` (only `/api/ai/*`) | `/api/providers/<pack>/*` with a DataForSEO pack: Basic auth, cost read from the head, sandbox host | 2 |
| G5 | No billing endpoints | `AppGateway` (`server.ts:152-164`) | `/api/billing/{status,holds,settle,release,track}` behind the same caller check, plus SDK `gatewayBilling({env,request})` | 1.5 |
| G6 | No billing UI or webhook at the gateway | gateway routes | `/billing` (port OpenSEO's components, now on the same design system), `/api/webhooks/autumn` (svix), `usage_events` D1 table | 3 |
| G7 | Manifest can't declare billing features | `manifest.ts:148-178` | `billing.features` labels. Allow `dataforseo` and `openrouter` in `providers` | 0.5 |
| G8 | Lifecycle emails, referrals, GDPR are app-local | OpenSEO `src/server/billing/*`, `referrals/*`, runbook | Port the three lifecycle events to the gateway's email. Delete the Autumn and Stripe customer on org deletion. Dub: drop for the proof of concept | 1.5 |
| G9 | Manifest and deploy can't express R2, Browser, a companion Worker, or a Workflow bound to another Worker | `manifest.ts:34-50`, `packages/sdk/src/cloudflare/worker.ts:75-113`, CLI `deployApp.ts` | Add `resources.r2` and `resources.browser`, plus `workers: [{name, main}]` for companion Workers with Workflow and DO bindings between them | 2–3 |
| G10 | Hosted (WfP) can't run Workflows; WfP cron support unverified | Cloudflare platform | Decide the shape (Q4). For catalog apps, use a shared instance in the platform account plus JWT org attribution and background grants | 1.5 |
| G11 | A shared catalog instance can't name the org through `props` | `app-gateway-entrypoint.ts:103-113` | Charge `identity.org_id` after checking the JWT (already done at `:242-249`), plus a hold-id capability and install-scoped background grants | (in G10) |
| G12 | OpenSEO has no `everyapp` mode | OpenSEO `resolve.ts`, `auth-mode.ts` | §2.5 steps 1–7 | 5.5–6.5 |

---

## 4. Open questions only the founder can answer

1. **Do app.openseo.so's paying customers move to hosted Every App, and when?** This decides whether OpenSEO deletes Autumn or keeps two billing modes, and how Autumn customers (keyed by OpenSEO org id) and their Stripe subscriptions move. **Default:** build the `everyapp` mode alongside the current ones now. Keep openseo.so on Autumn until hosted Every App can take its domain. Then migrate customers (same Autumn org, new customer ids = Every App org ids) and delete Autumn mode.
2. **One wallet per org across all apps, or plans per app?** This decides whether "OpenSEO Base Plan" survives or becomes an Every App plan, and what the billing page shows. **Default:** one org wallet. The current catalog (`usage_credits` and `topup_credits`, onboarding, base, YC and top-up) becomes Every App's catalog. Apps show up as rows in "usage by app".
3. **Who sets prices?** One markup per provider set by the gateway (1.28× today on every provider), or can apps add their own margin? This decides whether app developers can be paid. **Default:** set per provider pack by the gateway, 1.28×. Apps can't set prices in v1.
4. **Hosted OpenSEO: one shared catalog instance or one instance per org?** Workflows can't run on WfP, so per-org hosted OpenSEO is blocked today. The shared shape needs JWT-based org attribution. **Default:** a shared catalog instance (normal Workers in the platform account) for catalog apps that are already multi-tenant. One per org only for forks and internal apps, and only for apps without Workflows until Cloudflare supports them.
5. **What do free orgs get?** 500 one-off credits per org (onboarding_plan), and do the paid gates (rank tracking, AI Visibility, audit size) stay? This decides abuse limits on unmetered compute (crawls) and conversion. **Default:** keep 500 per org. Expose one `paid` flag in `status`, and keep OpenSEO's gates keyed on it.
6. **Does the wallet allow overage?** base-plan allows 500 credits of overage in Autumn. **Default:** yes, mirror the `overage_limit` of each plan in the wallet.
7. **Referrals (Dub).** Keep at the Every App level, or drop? **Default:** drop for the proof of concept. Rebuild at the gateway if referral revenue matters.
8. **Lifecycle emails.** Loops, or the gateway's own email? **Default:** the gateway's email transport, same three events and the same rules about when to say nothing (`lifecycle-events.ts:28-31`).
9. **SAM is hidden (2026-10-01). Build the OpenRouter pack now?** **Default:** yes. It is the founder's own example ("apps request permission to use OpenRouter"), and SAM then comes back already metered.
10. **Does self-host Every App meter at all?** **Default:** no wallet on self-host. Providers are proxied with the operator's keys and usage is logged, consistent with ADR-0003's self-host authority.

---

## 5. Load-bearing claims

1. **Workflows can't be deployed to Workers for Platforms namespaces.** Workflows limits page, last updated 2026-09-21. *If wrong:* a per-org OpenSEO on WfP becomes possible, and Q4's default flips. **Critical.**
2. **A WfP user Worker can't get a service binding with `props` to the gateway entrypoint.** Unverified. A Cloudflare blog post says service bindings don't carry over to WfP user Workers. The documented trusted channel is outbound-Worker `parameters`, which don't see fetches from DOs or `connect()`. *If wrong (bindings work):* hosted keeps the self-host transport unchanged. *If right:* hosted billing has to go through the outbound Worker or the dispatcher, and SAM's DO fetches need another path. **Critical.**
3. **Autumn `track` accepts an `Idempotency-Key` header** (Autumn track reference). *If wrong:* the wallet's outbox needs its own dedup ledger, or must call `track` exactly once (`autumn.ts:65-73` says replays double-charge). Not critical to the design.
4. **DataForSEO's top-level `cost` is the billed amount and is 0 on `task_get`**, and **OpenRouter's final usage chunk always carries `cost`.** From the DataForSEO `task_get` docs and OpenRouter's usage-accounting page. *If wrong:* the proxies need endpoint lists or a price table at the gateway. Critical for G3 and G4. Also to verify: `cost` sits in the first few KB of large (Lighthouse) responses, so the head read works.
5. Also relied on: Autumn's default rate limits are 10k/s per customer for check and track, **25 rps per organization for "all other endpoints"**, and 5 rps per customer for events. If `balances.finalize` counts as "other", a shared gateway making Autumn calls on the hot path would hit a ceiling across all orgs. That is one more reason to keep Autumn off the path. A DO doesn't move once created ("Durable Objects do not currently change locations after they are created"), so the hold latency depends on where the org first used the wallet.

---

## 6. Sources

Code (OpenSEO, HEAD `847c8854`):
- `src/server/billing/{autumn,subscription,customer-status-sync,customer-status-model,lifecycle-events,loops-sync,loops-contact-properties,autumn-webhook,svix}.ts`
- `src/shared/{billing,billing-credit-features,audit-rendering,rank-tracking,gdpr-erasure,error-codes}.ts`
- `src/server/lib/dataforseo/{client,core,envelope,pricing,index}.ts`
- `src/server/features/sam/SamChatAgent.ts`, `src/server/lib/{openrouter,chatAgent,posthog,runtime-env}.ts`
- `src/serverFunctions/{billing,ai-search}.ts`, `src/routes/_app/{billing,billing_.fix-payment}.tsx`, `src/routes/_authenticated.{subscribe,yc}.tsx`, `src/routes/api/autumn/$.ts`, `src/routes/__root.tsx`
- `src/client/features/billing/*`
- `src/server/mcp/{server,tools/whoami,tools/research-keywords,output-schemas}.ts`
- `src/server/lib/audit/rendering-billing.ts`, `src/server/features/audit/services/AuditService.ts`, `src/server/features/rank-tracking/services/{RankTrackingService,scheduledRankChecks}.ts`, `src/server/workflows/RankCheckWorkflow.ts`
- `src/server/referrals/dub.ts`, `src/server/gdpr/storage-erasure.ts`, `docs/maintainers/runbooks/gdpr-erasure.md`
- `src/lib/auth-mode.ts`, `src/middleware/ensure-user/{resolve,delegated}.ts`, `src/server.ts`
- `wrangler.jsonc`, `deploy/alchemy/alchemy.run.ts`
- `docs/maintainers/specs/0002-hosted-dataforseo-metering-with-autumn.md`

Code (Every App, `e1d9d3c6`):
- `apps/every-app-gateway/src/server.ts`, `src/server/{app-gateway-entrypoint,ai-proxy,ai-usage}.ts`, `cloudflare.config.ts`, `src/server/toolbus/*`
- `packages/sdk/src/server/gatewayFetch.ts`, `packages/sdk/src/cloudflare/worker.ts`, `packages/perimeter/src/manifest/manifest.ts`
- `adr/ADR-0001-hosted-vs-self-hosted-topology.md`, `adr/RFC-0001-org-rearchitecture-phase-1.md`, `docs/architecture-v2-overview.md`, `TODO.md`
- `git show research/app-integrations:docs/research/2026-10-integrations-hub/app-integrations.md`
- Port branch: `git log --oneline main..t3/port-openseo-to-gateway` (empty), `git diff --stat main...t3/port-openseo-to-gateway` (empty)

Live config:
- Autumn MCP `getCurrentOrganization` / `listFeatures` / `listPlans`, org "Ben Senescu's Org", env `live`, read 2026-10-15.

Web:
- Cloudflare Workflows limits ("Workflows cannot be deployed to Workers for Platforms namespaces"), updated 2026-09-21: https://developers.cloudflare.com/workflows/reference/limits/
- Cloudflare WfP outbound Workers (parameters; no interception of DO fetches; `connect()` disabled), updated 2026-04-21: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/
- Cloudflare WfP limits (unlimited scripts, DO namespaces, no gradual deployments), 2026: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/
- How WfP works (bindings: "KV, D1, R2, and other"), updated 2026-04-21: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/
- Cloudflare Workers limits (500 Workers, 250 cron triggers per paid account), updated 2026-10-12: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare D1 limits (50,000 DBs per paid account, 10 GB), updated 2026-04-21: https://developers.cloudflare.com/d1/platform/limits/
- Cloudflare DO data location (created near the first `get()`, doesn't move), updated 2026-06-26: https://developers.cloudflare.com/durable-objects/reference/data-location/
- Autumn track (`Idempotency-Key` header, negative values, `entity_id`): https://docs.useautumn.com/api-reference/core/track
- Autumn check (`lock`, `required_balance`, `send_event`): https://docs.useautumn.com/api-reference/core/check
- Autumn rate limits (10k/s per customer for check and track; 25/s per org for other endpoints; 5/s per customer for events): https://docs.useautumn.com/documentation/rate-limits
- DataForSEO `task_get` (top-level `cost` = "total tasks cost, USD"; `task_get` free): https://docs.dataforseo.com/v3/serp/google/organic/task_get/regular/
- OpenRouter usage accounting (usage always included; cost in the last SSE message; `usage.include` deprecated): https://openrouter.ai/docs/use-cases/usage-accounting
