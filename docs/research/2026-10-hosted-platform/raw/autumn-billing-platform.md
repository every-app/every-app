# Autumn as the billing engine for hosted Every App

Researcher report, 2026-10-15. Scope: Autumn (useautumn.com) as the billing engine for a multi-tenant
Every App where the customer is an organization, usage comes from many apps through the gateway, and
apps may later sell their own plans. Read-only: I did not write to Autumn. The Autumn calls I made were
`getAgentRules`, `getCurrentOrganization`, `listPlans` (all versions, archived included) and
`listFeatures`, plus the MCP doc resources `autumn://docs/{concepts,catalog,billing,logs}`. The
external facts come from docs.useautumn.com (fetched 2026-10-15), the published `autumn-js@1.5.1`
bundle (published 2026-10-15), and Autumn's open-source server
(github.com/useautumn/autumn @ `832d03fb`, 2026-10-15T19:16Z).

## TL;DR

- **Autumn can model hosted Every App without a workaround.** The customer is the Every App
  organization. The wallet is one org-level credit system. Each installed app is an Autumn **entity**,
  which carries attribution, a per-app hard cap (`usage_limits` on the entity) and, later, its own
  per-app plans (an entity-scoped `billing.attach`). An org can hold an Every App plan and an app's
  plan at the same time, through plan `group`s or entity-scoped plans.
- **Credit cost can be dynamic, as OpenSEO does today.** You track `value = computed credits` against
  a metered feature whose `credit_cost` is 1 (1 credit = $0.001). Autumn's `ai_credit_system` and
  `trackTokens` would split the wallet in two, so don't use them.
- **OpenSEO's comment "track() has no idempotency key" is out of date.** Every Autumn API route
  accepts an `Idempotency-Key` header. A duplicate within 24h returns 409, and a retryable failure
  releases the key. The route-wide middleware dates from 2026-01. `batch_track` items take a per-item
  `idempotency_key` (24h).
- **Two API changes the gateway must plan for:**
  - On **API 2.5.0 (2026-10-12), `track` is asynchronous by default** (it returns 202 with
    `balance: null`).
  - **`autumn-js@1.5.1` pins API 2.6.0, while OpenSEO's `autumn-js@1.2.33` pins 2.3.0.**
- **Don't put Autumn on the request path.** OpenSEO's two incidents (2026-07-06: retries on the hot
  path; 2026-07-20: a stale or empty balance locked out a paying customer) argue against it. The plan:
  - One **`OrgWallet` Durable Object per organization** is the only place that spends.
  - It authorizes from a local snapshot and ledger, settles real cost after the response stream ends,
    and flushes chunked, idempotent `track` calls to Autumn from an alarm.
  - Autumn locks (`check({lock})` and `balances.finalize`) are then not needed.
  - Autumn's own "edge cache" does the same job but runs in AWS or GCP and is in private preview.
- **Reuse the existing Autumn org ("Ben Senescu's Org", live).** It already owns OpenSEO's paying
  customers, the Stripe products and the wallet unit. Prototype in a **named sandbox**.
  - Every App plans go in a new `platform` group.
  - Migrated OpenSEO orgs keep their org ids, so their Autumn and Stripe customers carry over untouched.
- **Autumn has no marketplace or revenue-share primitive.**
  - Its Platform API (private preview) creates a separate Autumn org and Stripe connection per tenant,
    which makes the tenant the merchant of record. There's no application fee.
  - Paying third-party developers while Every App stays merchant of record needs Stripe Connect
    "separate charges and transfers".

---

## 1. What exists today

### 1.1 Every App gateway (this worktree)

| What | Where | Notes |
|---|---|---|
| App-to-gateway entrypoint | `apps/every-app-gateway/src/server.ts:151-164` (`AppGateway extends WorkerEntrypoint`, `props` = `{organizationId, appId, workerName}`) | The only place an app can spend platform money today. |
| Caller authorization | `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts:72-120` (registry lookup, a 30s in-isolate caller cache at `:9-11, :208-228`, active status, identity match, manifest `providers` allowlist at `:114-120`) | The meter hook goes after `:120`. |
| User attribution | `app-gateway-entrypoint.ts:122-131, :230-260` (verifies the identity JWT, `aud = appId`, org must match) | Gives a `userId` for usage properties (not billing). |
| AI proxy | `apps/every-app-gateway/src/server/ai-proxy.ts:94-100` (OpenAI only), `:127` (one shared `OPENAI_API_KEY`), `:158-174` (upstream fetch), `:176-190` (usage logged via `tapUsage`, **not billed**) | The settle point is `logUsage`, `:176-190`. |
| Usage extraction | `apps/every-app-gateway/src/server/ai-usage.ts:22-34` (regex for token fields only), `:40-59` (stream tap, 16 KB tail) | Doesn't read cost. OpenRouter's `usage.cost` would need one more field. |
| Manifest | `packages/perimeter/src/manifest/manifest.ts:110-122` (`providers`), `:136-148` (`ai.models`, `ai.routes`), `:174-178` | No billing or budget fields yet. |
| Registry row | `apps/every-app-gateway/src/db/apps.schema.ts:15-80`: `id` (PK), `organization_id`, `app_slug` (unique per org, `:68-71`), `tier` (`'dispatch'` reserved for hosted, `:40-41`) | `apps.id` is a natural Autumn `entity_id`. |
| Orgs | `apps/every-app-gateway/src/db/auth.schema.ts:97-104` (Better Auth `organizations.id`); `src/auth/config.ts:310-334` (`allowUserToCreateOrganization: false`; hooks only for members) | No billing hook on org creation. |
| Bindings | `apps/every-app-gateway/cloudflare.config.ts:123-178`: D1 `DB`, `OAUTH_KV`, `EMAIL`, rate limiters, secrets; `OPTIONAL_SECRETS` at `:27-54` | **No Durable Object, no Autumn secrets.** |
| Open decisions | `TODO.md:36-37` ("AI Gateway routing", "Metered billing at the gateway (deferred)"); `adr/RFC-0001-org-rearchitecture-phase-1.md:79-94` (metering dimensions org/app/token; "Phase 2: Billing, Usage, Limits"); `adr/ADR-0001-hosted-vs-self-hosted-topology.md:29-33` (billing may be private hosted-only code; platform-managed keys in v1) | |
| Sketched hosted metering | `docs/architecture-v2-overview.md:49-56, :148-150` (the outbound worker does "per-app spend metering"; per-app and per-user spend caps); `docs/architecture-v2-recommendation.md:51, :73, :165` ("Metering via per-script GraphQL analytics + tags") | Sketch only. Autumn is never named. |

**Bottom line:** the gateway knows who is calling (org, app, user) and which provider is being called,
and reads tokens off the stream. It has no wallet, no cost model, no Autumn client, no Durable
Object and no billing UI.

### 1.2 OpenSEO's Autumn integration: the working reference (`/Users/bensenescu/workspaces/open-seo`, HEAD `847c8854`, 2026-10-01)

**Customer = organization.** `getOrCreateOrganizationCustomer` uses `customerId: organizationId`,
with confirmed existence cached in KV for 24h. That cache exists because of incident 2026-07-06
(`src/server/billing/subscription.ts:24-64`).

**The client is tuned after that incident** (`src/server/billing/autumn.ts:9-40`):
- `timeoutMs: 10_000`.
- The retry window is capped at 2.5s. The comment: "an 8s backoff window held the isolate open for
  seconds on every request and cascaded into region-wide congestion (incident 2026-07-06)".
- The SDK is lazy-loaded (about 450 kB).

**The idempotency belief this report corrects** (`autumn.ts:65-86`): "track() has no idempotency key,
so replaying a deduction ... would double-charge. Retry only 429s." Section 1.4.d shows the
`Idempotency-Key` header has existed since 2026-01.

**Wallet arithmetic:**
- 1,000 credits per USD and a 1.28x markup (`src/shared/billing.ts:17-18`).
- `creditsForProviderUsd = ceil(rawUsd × 1.28 × 1000)` per call (`billing.ts:61-70`).
- Feature and plan ids are at `billing.ts:4-16`.

**Holds for DataForSEO** (`subscription.ts:224-297, :311-415, :436-538`):
- `check({ requiredBalance, sendEvent: true, lock: { lockId, enabled, expiresAt: now + 30 min } })`,
  then `balances.finalize({ lockId, action: "confirm", overrideValue })` or `"release"`.
- The hold TTL is 30 min (`:208-210`).
- It reuses the `lockId` to detect a 409 `lock_already_exists`, and treats "Lock not found" on the
  second attempt as "landed" (`:417-470`).
- It holds on monthly `usage_credits` first, then `topup_credits`, and splits by hand.
- It batches per call group because "holding and settling per call sent up to 40 Autumn requests per
  rank check batch" (`src/server/lib/dataforseo/client.ts:286-360`).

**After-the-fact LLM spend:**
- `trackUsageCreditSpend` tracks a computed `value` against the credit-system features directly,
  monthly first, then top-up (`subscription.ts:552-626`).
- SAM batches spend into $0.05 chunks to cut Autumn calls (`src/server/features/sam/SamChatAgent.ts:64,
  :407-447`).
- Cost comes from OpenRouter's `usage.cost` (`src/server/lib/chatAgent.ts:33-36`).

**Defensive reads after incident 2026-07-20** (stale or empty balance locked a paying customer out):
- It retries an empty balance once, and throws rather than coercing an empty balance to 0
  (`subscription.ts:100-146`).
- It refuses only when `/check` and `customers.get` agree that the wallet is empty (`:148-206`).

**Billing UI and webhook:**
- `autumnHandler` (`autumn-js/fetch`) is mounted at `/api/autumn/*`. `identify` returns the org id,
  and only the owner may call write routes (`src/routes/api/autumn/$.ts:9-20, :33-53, :73-85`).
- The Svix-verified webhook re-syncs a status row on `billing.updated`
  (`src/server/billing/autumn-webhook.ts:19-84`, `customer-status-sync.ts:12-36`).
- Usage history is a raw `fetch` of `/v1/events.list` with 429 backoff
  (`src/serverFunctions/billing.ts:14-24, :87-144`).
- Checkout collects tax id and billing address, display only with no Stripe Tax
  (`src/shared/billing.ts:24-39`).

**Version:** `autumn-js` is `^1.2.33` (`package.json:98`). That bundle pins API version **2.3.0**.

### 1.3 Ben's Autumn org today (read live, 2026-10-15)

**Org:** "Ben Senescu's Org", slug `ben_senescu_61987334`, env `live`.

**Agent rules:** empty (`entity_rules.attach_to_entities: false`, `entity_feature_id: ""`,
`credit_rules.credit_feature_id: ""`, `notes: ""`).

**Features:**

| id | type | notes |
|---|---|---|
| `managed_service_access` | boolean | Floor for using the managed service |
| `paid_plan` | boolean | Gate for paid-only features |
| `llm_usage` | metered, consumable | Never tracked directly by OpenSEO (see below) |
| `seo_data_usage` | metered, consumable | Same |
| `usage_credits` | credit_system | schema: `seo_data_usage`→1, `llm_usage`→1 |
| `topup_credits` | credit_system | **Identical schema** to `usage_credits` |

**Plans.** No plan has a `group`, so all of them sit in the one default group.

| id | ver | price | grants | billing controls | notes |
|---|---|---|---|---|---|
| `onboarding_plan` | v1 | none | 500 `usage_credits` one-off, `managed_service_access` | none | **`auto_enable: true`**: the actual default. Created 2026-06-19. |
| `free_plan` | v1 | none | 500 one-off, `managed_service_access` | none | `auto_enable: false`. `billing.ts:9-11` calls this "now the Autumn Default", which is out of date. |
| `base-plan` | **v4 active** (v1 $10/10k, v2 $10/10k, v3 $20/20k inactive) | $10/mo | 10,000 `usage_credits`/mo, `paid_plan`, `managed_service_access` | `overage_allowed: usage_credits`; `spend_limits: overage_limit 500 (absolute), skip_overage_billing false` | See the overage note below. Created 2026-06-26. |
| `yc-plan` | v1 | $50/mo | 50,000/mo + flags | empty lists | Created 2026-09-21. |
| `friends_and_family_2` | v1 | none | 20,000/mo + flags | none | No Stripe product (never synced). |
| `friends_and_family` | v1 | none | same | none | **Archived.** |
| `credit-top-up` | v1, `add_on` | none | `topup_credits` prepaid one-off, $1 per 1,000, `max_purchase: 100` | none | |

**The base plan's "overage" is a free buffer, not billed overage.** The `usage_credits` item has
`price: null`. In Autumn's model, `overage_allowed` with no usage price is "permitted, not billed",
and the spend limit caps it ("the three overage knobs", `autumn://docs/concepts` → Billing Controls).
So base-plan v4 gives a **500-credit ($0.50) unbilled buffer**, not paid overage. The brief's
"base $10/mo 10k credits with overage" should read that way.

**OpenSEO tracks the credit systems directly, which Autumn's docs discourage.** It tracks and checks
`usage_credits` and `topup_credits` themselves, not the metered features under them (`llm_usage` and
`seo_data_usage` are never tracked). Autumn's docs say "you should interact with the underlying
features -- not the credit system itself"
(https://docs.useautumn.com/documentation/modelling-pricing/credit-systems). It works, but:
- **Feature attribution lives only in event `properties`.**
- **Two credit systems with the same schema plus a hand-written split are unnecessary.** Autumn
  stacks a monthly item and a one-off prepaid item on the **same** feature and spends the shorter
  interval first (catalog: "Balance stacking"; https://docs.useautumn.com/documentation/concepts/balances).

### 1.4 What Autumn can do, as of 2026-10-15

#### a. Customers and entities: can an entity be an app inside an org?

**Yes.** An entity is "a resource that lives under a parent customer". It can hold its own plan and
balances "while the parent customer pays"
(https://docs.useautumn.com/documentation/modelling-pricing/entity-plans).

How check and track scope works:
- Pass `entity_id` to `check` and `track`. "Entity-level check/track calls can use customer-level
  state plus matching entity-level state". Customer-level calls do **not** inherit entity state
  (`autumn://docs/concepts` → Customer and Entity).
- **An org-wide wallet with per-app attribution needs no entity plans.** Attach the plan to the
  customer and track with `entity_id`.

Creating entities:
- `entities.create` requires a `feature_id` (the entity's type), and creating one sends a usage
  event that increments that feature's count
  (https://docs.useautumn.com/api-reference/entities/createEntity,
  https://docs.useautumn.com/documentation/customers/feature-entities).
- So Every App needs a metered non-consumable `apps` feature. It can also serve as a plan limit, for
  example "3 apps on free".

Per-app controls, each settable on the entity (createEntity and updateEntity `billing_controls`):
- **`usage_limits`** are windowed hard caps (`day|week|month|year`, `anchor: billing_cycle|utc`,
  optional property `filter`). "An entity entry overrides the customer's for that feature". An
  entity-level limit "gets its own per-entity window and counter"
  (https://docs.useautumn.com/documentation/customers/billing-controls).
- **`spend_limits`** and **`overage_allowed`** are per entity. `auto_topups` are customer- and
  plan-level only.
- **New 2026-10-09: `billing_controls.balance_allocations`** on `customers.update` reserves a share of
  the customer's shared credits for each entity. Shares are "scaled proportionally to fit the pool",
  and "`check` returns each entity's spendable share" (changelog; field reference at
  https://docs.useautumn.com/api-reference/customers/updateCustomer).

Per-entity plans:
- `billing.attach({ customer_id, entity_id, plan_id })`. "Each entity's subscription is created
  separately in Stripe, with billing cycles synced to the parent customer" (catalog "Entity Plans").
- Trials on entities share subscription state.

Entities are single-level: there is no nesting. If both apps and users needed Autumn-side caps, only
one of them could be the entity. Per-user caps would have to live in the gateway.

Since API **2.4**, customer-level reads no longer fold in entity subscriptions and balances; read
entities separately (changelog, Sept 11 2026).

#### b. Features, credit systems, dynamic credit cost

Feature types: `boolean`, `metered` (consumable or not), `credit_system` and `ai_credit_system`.

`credit_schema` rows are **flat**, **graduated**, or (since 2026-09-11) priced by **dimensions**:
- A dimension matches event `properties` and can be scaled by multipliers.
- `check`, `track` and `finalize` "all price by the event's properties".
- Plans can override the rate card via `featureOverride`.

Sources: catalog "Rate cards and dimensions"; changelog Sept 11 and Sept 14 2026.

**Dynamic cost is supported in practice.** `track.value` is any number, so a feature with
`credit_cost: 1` and `value = ceil(usd × markup × 1000)` gives an exact computed charge. This is what
OpenSEO does. `check.required_balance` takes the same computed estimate.

`ai_credit_system` with `balances.track_tokens` prices tokens from models.dev plus a markup, in
dollars. It has **no `credit_schema`** (concepts), so non-token meters such as DataForSEO or compute
can't spend from it. Using it would split the org wallet in two. Gateway-computed cost is also more
accurate: OpenRouter returns `usage.cost` in every response, in the final SSE chunk for streams
(https://openrouter.ai/docs/use-cases/usage-accounting).

"Monetary credits" (1 credit = 1 cent, or here 1 credit = $0.001) is the documented way to make
credits represent money (catalog "Monetary credits").

#### c. `check` with a lock, then `balances.finalize`

Behavior:
- `check({ lock: { enabled: true, lock_id, expires_at } })` "atomically checks if the customer has
  enough balance and reserves it in a single call". "The held balance is guaranteed to be available —
  no other concurrent request can consume it".
- `expires_at` has a **maximum of 24 hours**. On expiry "the held balance is automatically released".
  If `lock_id` is omitted, Autumn generates one
  (https://docs.useautumn.com/documentation/customers/balance-locking).
- `balances.finalize({ lock_id, action: confirm|release, override_value, customer_id })`.
  `customer_id` is now **required** ("A lock of any other customer is not found",
  https://docs.useautumn.com/api-reference/balances/finalizeLock and `autumn-js@1.5.1`
  `FinalizeBalanceParams`). OpenSEO's 1.2.33 call sites don't pass it.
- `finalize` can answer **202**: "degraded service from a downstream provider, so the finalize request
  was allowed fail-open".
- Since Sept 2026, `lock.overage_behavior` is `reject` (default), `cap` or `overflow`, and "finalize
  reuses the behavior chosen here" (SDK 1.5.1 types; changelog Sept 11 2026).

Undocumented, but observed in OpenSEO's code (`subscription.ts:417-428`):
- A reused `lock_id` returns 409 `lock_already_exists`.
- A finalize for an expired or already-finalized lock returns 400 "Lock not found".
- There is no documented idempotency for finalize apart from the generic header (below).

#### d. `track` idempotency: OpenSEO's comment is out of date

- The docs (Billing Reliability) say: "All API requests support an `Idempotency-Key` header. If the
  same key is sent within 24 hours, the duplicate request is rejected with a 409". The `track` page
  shows the header example (https://docs.useautumn.com/documentation/customers/edge-cases,
  https://docs.useautumn.com/api-reference/core/track).
- The server code agrees:
  - `idempotencyMiddleware` claims the key on every API route.
  - The TTL defaults to 24h and is configurable per org and route group (`resolveIdempotencyTtl.ts`).
  - A non-409 4xx or 5xx **releases** the key so the client can retry; a duplicate is never released
    (`withIdempotencyKey.ts`).
  - The track lane also accepts a body `idempotency_key` and keeps queue-replay dedupe inside the
    deduction (`server/src/internal/balances/idempotency/README.md`).
- History of the middleware: "idempotency on attach" 2026-01-05, header added to accepted headers
  2026-01-05, key hashing 2026-02-03. Accept-time track claims were refactored 2026-08-04.
- `balances.batch_track` takes up to 1,000 items, each with an `idempotency_key` that "a second track
  with the same key within 24 hours is ignored"
  (https://docs.useautumn.com/api-reference/core/batchTrack).
  - **Partial-failure semantics:** if some items fail to enqueue it still returns 200 or 202 and logs
    server-side, and "clients should NOT retry". 503 means zero items were enqueued, which is safe
    to retry.
- **What this means for us:** a retry that reuses the same key is now safe for `track`, `check` with
  `send_event` or `lock`, and `finalize`. A 409 means "already applied".

#### e. `track` is asynchronous by default (a breaking change to plan around)

- On API **2.5.0 (changelog 2026-10-12)**, `balances.track` and `track_tokens` "queue usage by default
  and respond with 202 and `balance: null`". Pass `async: false` for the updated balance.
- `track` also takes `overage_behavior: cap` (default: "deducts only what fits, stopping at zero") or
  `overflow` ("the balance can go negative and usage limits do not clamp the deduction, though spend
  limits still apply").
- `timestamp` back-dates an event (track API reference).
- `autumn-js@1.5.1` defaults to `x-api-version` **2.6.0**; `autumn-js@1.2.33` defaults to **2.3.0**
  (grep of both bundles).
- **Pin the version explicitly** in any raw-fetch client.

#### f. Usage-based prices, overage, spend limits, usage limits

- Usage-based items bill in arrears past `included`, with optional tiers.
- Billing controls (plan > customer > entity precedence, most restrictive wins across plans) are:
  - `overage_allowed`: can usage pass zero at all.
  - `spend_limits.overage_limit`: how far past zero, absolute or as a % of allowance.
  - `skip_overage_billing`: accrue the overage but never invoice it.
  - `usage_limits`: windowed caps, independent of balance. On a credit system, "Autumn enforces the
    tightest" of the feature cap and the credit-system cap.
  - `usage_alerts`: notify only, never block.

  Sources: `autumn://docs/concepts` Billing Controls;
  https://docs.useautumn.com/documentation/customers/billing-controls.
- `threshold_billing: { threshold }` on a plan item (Sept 2026) "triggers a charge each time usage
  crosses the threshold". A failed threshold invoice marks the plan `past_due` and blocks usage
  (changelog Sept 11 2026). This is a useful risk control if Every App ever bills overage in arrears.

#### g. Prepaid top-ups and auto top-ups

- A one-off prepaid item, sold as an `add_on` plan or as an item on the main plan, stacks with
  monthly grants; monthly is spent first (catalog "One-off purchases", "Add-ons").
- `billing_controls.auto_topups` (customer- or plan-level): `{feature_id, threshold, quantity,
  purchase_limit}`.
  - Needs a one-off prepaid item for the feature and a saved card.
  - Repeated card failures suspend it and send `billing.auto_topup_failed`
    (catalog "Auto Top-Ups"; concepts).
  - The attempt limit defaults to 2 per 10 min (changelog Sept 11 2026).

#### h. Plan groups: can an org hold an Every App plan and an OpenSEO plan at once?

**Yes, in either of two ways:**
- **Groups:** "By default, attaching a plan replaces the customer's current plan in the same group.
  Use `group` when customers can have one active plan from each independent product line"
  (concepts → Plan). Each group can have its own `auto_enable` default ("one default per group").
- **Entity-scoped plans:** attach the app's plan to that app's entity (section 1.4.a).

Related:
- `billing.attach` accepts `remove_plan_ids`, and cross-group swaps have defined billing (changelog
  July 31 and Oct 9 2026).
- `newBillingSubscription: true` forces a separate Stripe subscription; by default Autumn merges into
  the existing one (SDK 1.5.1 `AttachParams`).

#### i. Stripe checkout, portal and invoices

- `billing.attach` returns a Stripe Checkout `payment_url` when a card is needed. It takes
  `checkout_session_params` passthrough, `redirect_mode`, `long_lived_checkout`, `invoice_mode`,
  discounts and `success_url` (SDK 1.5.1 `AttachParams`).
- `billing.open_customer_portal` takes `{customer_id, configuration_id, return_url}`
  (https://docs.useautumn.com/api-reference/billing/openCustomerPortal).
- Invoice endpoints (`invoices.list/create/finalize/void/pay/reissue/issue_credit_note`) were added in
  2026.
- Autumn creates Stripe products, prices and meters lazily; "Autumn is the source of truth for a
  customer's state" (https://docs.useautumn.com/documentation/concepts/stripe).
- `autumn-js/fetch`'s `autumnHandler` is the drop-in browser-facing proxy OpenSEO uses.

#### j. Webhooks

Delivered through Svix (`svix-id`, `svix-timestamp`, `svix-signature`). Events
(https://docs.useautumn.com/documentation/webhooks; event names from the SDK 1.5.1 bundle):
- `billing.updated`: `plan_changes[]` with `activated|scheduled|updated|expired`,
  `previous_attributes`, and `entity_id` on entity-scoped changes.
- `balances.limit_reached`: `limit_type: included|max_purchase|spend_limit`, plus `entity_id`.
- `balances.usage_alert_triggered`: the "balance low" signal, configured as usage alerts with
  `basis`.
- `billing.auto_topup_succeeded` and `billing.auto_topup_failed`.
- `invoice.finalized`.
- Legacy: `customer.products.updated`, `customer.threshold_reached`.

#### k. Multi-currency and tax

- Org currency defaults to `usd`. Changing it doesn't migrate existing subscriptions (Stripe concept
  page).
- Multi-currency pricing (`base_currency` plus `additional_currencies`; the customer's currency locks
  on first paid attach; `currency_mismatch` returns 400) needs the `multi_currency` org flag
  (changelog July 17 2026).
- **Tax:** "Automatic tax" calls Stripe Tax on every subscription, invoice and checkout. In invoice
  mode, a missing address returns 400 `customer_tax_location_missing`. `billing_details` accepts
  address, tax ids and exempt/reverse charge
  (https://docs.useautumn.com/documentation/customers/tax).
- OpenSEO collects tax ids and addresses but does not turn Stripe Tax on (`billing.ts:24-27`).

#### l. Rate limits, latency and failure behavior

Rate limits (https://docs.useautumn.com/documentation/rate-limits):

| Endpoint group | Limit | Scope |
|---|---|---|
| check, get customer | 10,000 req/s | per customer |
| track, balance updates | 10,000 req/s | per customer |
| attach and billing operations | 30 req/min | per customer |
| events list/aggregate | 5 req/s | per customer |
| list customers | 5 req/s | per org |
| **all other endpoints** (`entities.create`, `customers.update`, ...) | **25 req/s** | **per org** |
| `entities.list` | 10 req/s | per customer |

- `customers.get_or_create`, `customers.get` and `entities.get` "may briefly return 503 ... `check`
  and `track` are never shed this way".
- **Fail-open:**
  - The SDK returns `{allowed: true}` for `check` and drops `track` on 5xx, network errors or
    timeouts (https://docs.useautumn.com/documentation/fail-open).
  - The server itself may answer 202 fail-open on check, track and finalize when degraded.
  - OpenSEO found the SDK's fail-open for `check` returned `allowed: true, balance: null` and has to
    retry, then fail closed (`subscription.ts:229-238`).
- **Autumn's own fix for hot-path latency is the "Edge cache"** (private preview). It's a service in
  **your AWS or GCP account** (two machines plus SQS) that answers `check` and records `track`
  locally, syncs in the background, and makes the SDK fall back to Autumn after 1s
  (https://docs.useautumn.com/documentation/edge-cache). It doesn't run on Cloudflare, so for a
  Workers gateway it adds a cross-cloud hop. Pricing lists "dedicated cache infrastructure" on
  Scale (custom).
- **OpenSEO incident timeline:**
  - 2026-07-06: retries with a long backoff on `getOrCreate` and `check` in the hot path caused
    region-wide congestion. Fixed in commit `a337f0ac`, "bound Autumn retry window + cache customer
    existence off the hot path (#365)".
  - 2026-07-20: an inconsistent or stale balance read refused a paying customer
    (`subscription.ts:128-133, :148-158`).

#### m. Platform or marketplace model

- **Autumn has no revenue share, application fee or payout feature.**
- The **Platform API (private preview)** "manage[s] Autumn on behalf of your users". It:
  - creates an Autumn org per tenant with its own API keys;
  - connects the tenant's Stripe through Autumn OAuth, or "if you have your own Stripe Connect
    platform, simply pass us the Stripe account ID".

  Sources: https://docs.useautumn.com/api-reference/platform/overview, `update-stripe`,
  `create-organization`. No fee or split parameter exists.
- That makes **each developer the merchant of record, with a separate Autumn org**. For Every App,
  that would mean one wallet per developer per customer, the opposite of "one org wallet".
- If Every App stays merchant of record and pays developers, it must use **Stripe Connect separate
  charges and transfers**:
  - "You can also make a transfer with neither an associated charge nor a `transfer_group` ... when
    you must pay a provider but there's no associated customer payment".
  - Cross-border transfers are only supported among US, CA, UK, EEA and CH.
  - The platform balance bears Stripe fees, refunds and chargebacks
    (https://docs.stripe.com/connect/separate-charges-and-transfers).

#### n. What Autumn costs

Per https://useautumn.com/pricing (fetched 2026-10-15):

| Tier | Price | Includes |
|---|---|---|
| Free | $0 | 8K monthly billing volume, **10,000 customers and entities**, 10M API requests |
| Pro | $375/mo | 50K billing volume, 20M requests then $5 per 1M, unlimited customers and entities |
| Scale | custom | dedicated cache infrastructure |

Stripe Billing fees (0.7%) and processing fees still apply. **Entities count toward the free cap,
and the request count rewards batching.**

---

## 2. What the hosted tier needs

### 2.1 Requirements, mapped to the founder's vision

1. **One bill per organization** covering platform access, metered usage from every app, top-ups, and
   later per-app plans.
2. **The gateway meters everything:** apps never hold keys or call Autumn. That covers LLM via
   OpenRouter, data providers such as DataForSEO, and later integrations and WfP compute.
3. **Per-app limits**, so an untrusted org app can't drain the org's wallet. Later, per-app plans and
   paid third-party apps.
4. **App requests never block on Autumn**, and false refusals don't happen (both OpenSEO incidents).
5. **Exactly-once charging.** No double charges on retry, and bounded loss if the gateway crashes
   mid-stream.
6. **Self-host stays free of Autumn** (ADR-0001 policy flags: billing is hosted-only, possibly a
   private module).

### 2.2 Recommendation A: reuse the existing Autumn org, prototype in a named sandbox

**Why reuse ("Ben Senescu's Org"):**
- It owns the live Stripe connection, OpenSEO's paying customers (base-plan v2-v4, yc-plan) and
  the wallet unit (`usage_credits`, 1 credit = $0.001, with `llm_usage` and `seo_data_usage` already
  in the schema).
- The founder's end state puts all of OpenSEO's billing at the gateway. In that end state this *is*
  Every App's billing org, and OpenSEO's plans become one plan line in it.
- A new Autumn org would have to re-home OpenSEO's subscriptions:
  - either a second Stripe account;
  - or reconnecting the same one, and Autumn warns that reconnecting "existing Stripe IDs on your
    plans become invalid" (Stripe concept page);
  - or `billing.import` per customer.
- Plan `group`s and entity-scoped plans keep the two product lines apart (section 1.4.h).

**How to reuse it safely while Every App has no users:**
- **Build in a named sandbox** of this org (`atmn sandbox use everyapp`; catalog doc "Sandboxes and
  keys"), with the catalog as code (`autumn.config.ts` in this repo). Push to live with `atmn push -p`
  only at launch. The live env and its paying OpenSEO customers stay untouched until then.
- **Keep existing OpenSEO plans as they are** (default group). Every App plans go in a new
  `platform` group. App plans go in a group named after the app (`app_openseo`) or on the app entity.
- **Customer id = Every App `organizations.id`.** For OpenSEO orgs that move into Every App, create
  the Every App org **with the same id** as the OpenSEO org. Both use Better Auth org ids. The Autumn
  customer, Stripe customer, subscriptions and balances then carry over with zero billing migration.
- Set the org agent rules at cutover (`credit_feature_id: usage_credits`; a note that the customer is
  the Every App org id and the entity is the app's registry row id). These are writes, which I didn't
  make.

**Reasons for a new org instead:** a hard separation of Every App's prototype from a live revenue
business. Also, onboarding_plan's `auto_enable` in the default group would auto-attach OpenSEO's
500-credit plan to every new Every App customer. That's harmless if the wallet is shared on purpose,
and it can be removed by moving OpenSEO plans to a group at cutover.

### 2.3 Recommendation B: the feature and credit model

**One org wallet, in credits, across all apps.** Per-app attribution and caps come from entities. The
first unit of billing is the org. The catalog, in Autumn's display grammar:

```
Features: usage_credits (credit system — llm_usage 1, seo_data_usage 1, compute_usage 1, integration_usage 1)
          llm_usage, seo_data_usage, compute_usage, integration_usage (usage, resets)
          apps (held, not used up)  — entity type, one per installed app
          managed_service_access, paid_plan (on/off); later app-scoped flags e.g. openseo_pro (on/off)

platform group
  Every App Free (default)        500 usage credits one-off · 3 apps · managed_service_access
  Every App Pro  $10/month        10,000 usage credits/month · apps unlimited · paid_plan · managed_service_access
                                  (billing controls: usage alert at 80% and 100%; overage policy = founder Q2)
add-on
  Credit Top-Up                   usage credits one-off, $1 per 1,000 (prepaid)   ← retarget from topup_credits
app_openseo group (later; attached to the OpenSEO entity)
  OpenSEO Pro  $X/month           openseo_pro · optional entity-scoped usage credits
```

Choices and why:
- **1 credit = $0.001, value computed by the gateway.**
  - `credits = ceil(rawUsd × markup × 1000)` per upstream call. This is OpenSEO's formula, moved into
    the gateway (`billing.ts:61-70`).
  - OpenRouter supplies `rawUsd` (`usage.cost`); DataForSEO returns cost per task.
  - Track the **metered feature** (`llm_usage`, `seo_data_usage`, ...), not the credit system, so
    Autumn's analytics and invoice-credit lines attribute by feature. Put
    `{app, provider, model, user}` in `properties`.
- **One credit feature, not two.** Fold `topup_credits` into `usage_credits` with a one-off prepaid
  item. Autumn's deduction order already spends monthly before one-off.
- **Per-app control through entities.**
  - Create an entity for each installed app: `entity_id = apps.id`, `name = apps.name`,
    `feature_id = apps`.
  - Always track and check with `entity_id`.
  - Per-app caps are **entity `usage_limits`** on `usage_credits` (monthly window), set by the org
    admin.
  - Guaranteed shares, if wanted later, are **`balance_allocations`** (new 2026-10-09; treat it as
    beta).
  - Don't use pooled entity plans: the main plan is customer-level.
- **Per-app plans later are entity-scoped attaches.** Example: `openseo_pro` attached to the OpenSEO
  entity grants a boolean and, if wanted, app-only credits. The gateway hands entitlements to the app
  (new SDK surface; see the gaps table).
- **Don't use `ai_credit_system` or `trackTokens`:** they split the wallet (section 1.4.b).
- **Don't use Autumn locks on the hot path:** the wallet Durable Object (Recommendation C) is the
  single spender, so concurrency is solved locally.

### 2.4 Recommendation C: the gateway-side sequence per metered request

**Design:**
- One `OrgWallet` Durable Object per organization (`idFromName(orgId)`), SQLite-backed.
- It is the **only** code that spends from an org's Autumn wallet. Apps can't call Autumn, and
  OpenSEO's direct Autumn calls are deleted at cutover.
- A DO is single-threaded, so reserve and settle are atomic without Autumn locks.
- Per-object soft limit is 1,000 req/s
  (https://developers.cloudflare.com/durable-objects/platform/limits/).
- Alarms are at-least-once with 6 retries
  (https://developers.cloudflare.com/durable-objects/api/alarms/).

DO state (SQLite):
- `snapshot` holds `{remaining, overageHeadroom, perApp[entityId]: {limit, windowUsage, windowEndsAt},
  flags, fetchedAt}`.
- `holds` holds `{holdId, entityId, feature, credits, expiresAt}`.
- `outbox` holds `{rowId, entityId, feature, credits, ts, props, flushId|null}`.

```
App Worker ──service binding / dispatch──▶ AppGateway.fetch (gateway isolate, any colo)
 1  authorize caller, provider allowlist                         [existing: app-gateway-entrypoint.ts:72-120]
 2  if !hosted → forward unmetered                               [self-host unchanged]
 3  meter = METERS[provider]; estimate = meter.estimate(req)     [new: price table + 1.28x markup; flat
                                                                  default hold, e.g. 50 credits for LLM]
 4  r = await ORG_WALLET.get(orgId).reserve({entityId: app.id, feature: meter.feature,
                                              credits: estimate, holdId: requestId, ttlMs})
      DO:  ensureSnapshot()      — persisted; Autumn is called here only if this org has never been
                                   snapshotted (prewarmed at org creation)
           spendable = remaining + overageHeadroom − Σunflushed − Σholds
           appRoom   = perApp.limit − (perApp.windowUsage + Σunflushed(app) + Σholds(app))
           if estimate > min(spendable, appRoom):
               if snapshot older than 30s: refreshFromAutumn()   — deny path only, 2.5s budget
               if still short → {ok:false, reason, remaining}
           insert hold → {ok:true}
    !ok → 402 {code:"insufficient_credits"|"app_budget_exceeded", billingUrl}   ← no Autumn call
 5  upstream fetch with the injected key                         [existing: ai-proxy.ts:158-174]
 6  tapUsage onDone → actual = meter.actual(usage)               [extend ai-usage.ts:22-34 to read cost]
    ctx.waitUntil(wallet.settle({holdId, credits: actual, props}))
      DO:  delete hold; insert outbox row; remaining −= actual
           if Σunflushed(entity,feature) ≥ FLUSH_CREDITS (e.g. 50 = $0.05) or no alarm set:
               setAlarm(now + few seconds)
 7  DO alarm (off path):
      for each (entity, feature) with unflushed rows:
         flushId = persisted on the rows (so retries reuse it)
         POST /v1/balances.track
           headers: Authorization, x-api-version: 2.6.0, Idempotency-Key: `${orgId}:${flushId}`
           body: {customer_id: orgId, entity_id, feature_id, value: Σcredits, async: false,
                  overage_behavior: "overflow", timestamp: lastTs,
                  properties: {request_count, first_ts, last_ts, providers, models}}
           200 → delete rows; remaining = resp.balance.remaining − Σ(newer unflushed)
           409 (duplicate key) → already applied: delete rows, then check() to resync
           202 (degraded, accepted for replay) → delete rows, schedule a check() resync
           429/5xx/network → keep rows, reschedule with backoff (same key, so safe)
      sweep expired holds (released, logged — the upstream cost is eaten, as OpenSEO's HOLD_TTL does)
      if active and snapshot older than 60s → check({feature: usage_credits}) per active entity
         (check is "never shed")
      then setAlarm(next) or stop when idle
 8  Webhook /api/billing/autumn (Svix-verified, ported from OpenSEO autumn-webhook.ts + svix.ts):
      billing.updated, billing.auto_topup_succeeded/failed, balances.limit_reached,
      balances.usage_alert_triggered → ORG_WALLET.get(customer_id).refresh()
      (and notify org owners on alerts)
```

**Why each choice:**
- **Sync `track` with `async: false` per chunk.** The response balance is authoritative after the
  deduction, so the DO reconciles exactly without guessing what Autumn's queue has applied. API 2.5.0
  made async the default, so set it explicitly.
- **`overage_behavior: overflow`.** The gateway already let the work happen. The default `cap` would
  silently drop the part above zero or above a usage limit (a revenue leak). Spend limits still apply.
- **Chunking ($0.05) follows SAM's precedent** (`SamChatAgent.ts:64`). Autumn calls scale roughly
  with dollars spent (spend / $0.05) plus a max-age flush for slow trickles, not with requests. That
  matters against the 10M or 20M request quotas.
- **Per-request detail stays in the gateway** (Workers Analytics Engine or a D1 `usage_events`
  table), keyed by `requestId`, for audit and per-request UI. The scale path is
  `balances.batch_track` with per-request items and per-item `idempotency_key`s, at the cost of
  no balance in the response.
- **Autumn is still the ledger of record.** Balances, resets, top-ups, plan changes, invoices and
  analytics (`events.aggregate` with `group_by: "$entity_id"` for per-app charts) all stay in Autumn.
  The DO is a write-behind cache with a reservation layer.

**Failure modes:**

| Failure | Effect |
|---|---|
| Autumn down or slow | The allow path is unaffected. The outbox grows and retries with the same keys. Paid top-ups aren't visible until a refresh, so a deny-path refresh is attempted. |
| First request for a brand-new org | One blocking snapshot. Avoided by prewarming in the org-creation hook. |
| Gateway isolate dies mid-stream | The hold expires (TTL). That request's upstream cost isn't charged; bounded and logged. |
| DO evicted | SQLite persists the outbox and holds. |
| Duplicate settle (retried `waitUntil`) | An idempotent insert keyed by `holdId`. |
| Lost webhook | The 60s active reconcile. Svix also retries on non-2xx. |
| Overspend window | At most `FLUSH_CREDITS` plus concurrent holds above what Autumn knows. External *decreases* (an admin balance edit, a downgrade) apply on the next refresh. |

### 2.5 Off-path Autumn calls (lifecycle)

| When | Call |
|---|---|
| Org created (Better Auth org hook; `auth/config.ts:319-334` has the hook surface) | `customers.get_or_create({customer_id: org.id, name, email})`, then prewarm the DO. `auto_enable` attaches Free. |
| App installed or activated (registry write path) | `entities.create({customer_id, entity_id: apps.id, feature_id: "apps", name})`. "Other endpoints" are limited to 25 req/s per **org key**, so do it off-path with retry. |
| App deleted or tombstoned | `entities.delete` (or keep the entity for history). Reconcile the `apps` count. |
| Admin sets an app budget | `entities.update({billing_controls: {usage_limits: [{feature_id: "usage_credits", limit, interval: "month"}]}})`, then `DO.refresh()`. |
| Upgrade, top-up, auto top-up settings | `billing.attach` (checkout `payment_url`), `customers.update({billing_controls: {auto_topups}})`. Owner-only, through an `autumnHandler` mount on the control-plane host (port of OpenSEO `routes/api/autumn/$.ts`). |
| Manage card or invoices | `billing.open_customer_portal({customer_id, return_url})`. |
| Usage charts | `events.aggregate({customer_id, feature_id, group_by: "$entity_id", range})`. 5 req/s per customer, so cache it. |

---

## 3. Gaps and the smallest change that closes each

| # | Gap | Where | Smallest fix | Size (eng-days) |
|---|---|---|---|---|
| 1 | No Autumn catalog for Every App | Autumn org (sandbox) + new `autumn/autumn.config.ts` | `atmn init` in a named sandbox. Add `apps` and `compute_usage` features; `platform`-group Free and Pro plans; retarget the top-up to `usage_credits`; usage alerts at 80% and 100%. | 1 |
| 2 | No billing customer per org | `apps/every-app-gateway/src/auth/config.ts:310-334` | Hosted-only `afterCreateOrganization` hook: `customers.get_or_create(org.id)` with retry off-path, then prewarm `OrgWallet`. | 0.5 |
| 3 | Apps aren't Autumn entities | registry write path (perimeter registry rules per `docs/cli-redesign.md`; hosted deploy API) | `entities.create` and `entities.delete` keyed by `apps.id`, feature `apps`. | 0.5 |
| 4 | No wallet or reservation layer | new `apps/every-app-gateway/src/server/billing/org-wallet.ts` (DO) + binding in `cloudflare.config.ts:123-178` + export from `server.ts` | The `OrgWallet` DO from section 2.4: snapshot, holds, outbox, alarm flush, reconcile. Raw `fetch` client pinned to `x-api-version: 2.6.0`, no `autumn-js` in the gateway bundle. | 3 |
| 5 | The AI proxy doesn't price anything | `ai-usage.ts:22-34`, `ai-proxy.ts:94-100, :176-190` | Read OpenRouter `"cost"` from the tail; add a `METERS` price table (OpenRouter: pass-through cost × markup; OpenAI: token prices). The OpenRouter provider itself is the brokers researcher's PR. | 1 |
| 6 | No meter hook | `app-gateway-entrypoint.ts:120-140` | `reserve` before the upstream, `settle` in `tapUsage` `onDone` via `ctx.waitUntil`. 402 with `insufficient_credits` / `app_budget_exceeded` and a billing URL. A no-op when not hosted. | 1 |
| 7 | No Autumn webhook | new route on the gateway host (e.g. `/api/billing/autumn`) | Port `open-seo/src/server/billing/svix.ts` and `autumn-webhook.ts`; fan out to `DO.refresh()`; email owners on `usage_alert_triggered` and `auto_topup_failed`. | 0.5 |
| 8 | No billing UI | gateway control plane (shadcn UI from #283) | Port OpenSEO's `/api/autumn/*` handler with owner-only writes; Billing page (plan, balance, top-up, portal, per-app usage via `events.aggregate`, per-app budget editor). | 2 |
| 9 | Apps can't see entitlements (for later per-app plans) | `packages/sdk/src/server/gatewayFetch.ts`, `AppGateway` | A broker route `GET /api/billing/entitlements` returning the DO's flags for `(org, app)`, or entitlement claims in the identity JWT. | 1 |
| 10 | Autumn secrets not declared | `cloudflare.config.ts:27-54` | Add `AUTUMN_SECRET_KEY`, `AUTUMN_WEBHOOK_SECRET` (hosted only). | 0.1 |
| 11 | Per-user caps (from `docs/architecture-v2-overview.md:150`) | `OrgWallet` | Enforce locally in the DO, keyed on `userId` from `resolveAttribution`. Entities are already used for apps and can't nest. | 0.5 |
| 12 | WfP compute isn't metered | cron in the gateway | Per-script GraphQL analytics (the plan in `docs/architecture-v2-recommendation.md:73`) → `compute_usage` chunks through the same DO. | 2 |
| 13 | OpenSEO still bills itself | `open-seo/src/server/billing/*`, `src/server/lib/dataforseo/client.ts:286-360`, `SamChatAgent.ts:329-447` | At cutover, delete OpenSEO's Autumn client. DataForSEO and OpenRouter go through the gateway broker. Migrate `topup_credits` balances into one-off `usage_credits` grants. Create Every App orgs with OpenSEO's org ids. | 3-5 |
| 14 | Paying third-party developers | Stripe (Connect) + a payout job | Stripe Connect Express onboarding per developer. A monthly job: `events.aggregate` per entity × revenue share → `transfers.create`. | 5 (later) |
| 15 | Tax | Autumn settings | Turn on Automatic tax before selling outside the US. Checkout already collects the address (`billing.ts:28-32`). | 0.5 |

**Suggested PR order:** 10 + 1 → 4 → 5 + 6 → 2 + 3 → 7 → 8 → 9 / 11 → 12 → 13 → 14 / 15.
PRs 4 to 6 can merge behind `isHosted` with a fake Autumn (a `fetch` stub) and a DO unit test before
any sandbox keys exist.

---

## 4. Open questions only the founder can answer

1. **Same Autumn org or a new one?**
   - Why it matters: it decides whether OpenSEO's live customers and Stripe objects carry over without
     work, and how much prototype risk touches a live revenue business.
   - **Default:** reuse the org, build in a named sandbox, push to live only at launch (section 2.2).
2. **Prepaid only, or billed overage in arrears?**
   - Why it matters: it decides credit risk and the catalog shape (`overage_allowed`, a usage-priced
     item, `threshold_billing`). Today's base plan only has a free $0.50 buffer.
   - **Default:** prepaid credits, opt-in auto top-up, and a small free buffer like base-plan v4. No
     arrears overage in v1.
3. **Is OpenSEO's $10 Base plan the Every App platform plan,** with credits that work in every app,
   or an OpenSEO-only plan?
   - Why it matters: it decides whether the wallet is shared from day one and which group each plan
     sits in.
   - **Default:** yes, Base becomes "Every App Pro". OpenSEO-specific extras become an entity-scoped
     `app_openseo` plan later.
4. **Does app.openseo.so keep its own sign-up and billing, or do OpenSEO users become Every App orgs?**
   - Why it matters: it decides the customer-id plan and whether two wallets per person ever exist.
   - **Default:** migrate OpenSEO orgs into Every App with the same org ids. One wallet.
5. **Default budget for org-deployed (untrusted or forked) apps?**
   - Why it matters: it limits how much a malicious or buggy app can drain, which is the security
     goal in the vision.
   - **Default:** catalog apps uncapped. Org apps get a monthly entity `usage_limit` of 2,000 credits
     ($2) until an admin raises it.
6. **One markup for every provider, or per provider?**
   - Why it matters: it changes margin, and the meter table needs a source of truth.
   - **Default:** 1.28x everywhere (OpenSEO's current markup), as a per-provider table in the gateway.
7. **Merchant of record for third-party app plans, revenue share, and payout cadence?**
   - Why it matters: Autumn can't split revenue. Being merchant of record means Every App owns
     tax, refunds and disputes, plus Stripe Connect.
   - **Default:** Every App as merchant of record, Stripe Connect Express, monthly transfers, deferred
     until the first paid third-party app.
8. **Turn on Stripe Tax?**
   - Why it matters: EU and UK VAT obligations grow as Every App sells others' apps.
   - **Default:** turn it on at hosted launch. USD only (no `multi_currency`).
9. **Charge for WfP compute in credits, or include it in the plan?**
   - Why it matters: it decides whether a `compute_usage` meter ships in v1.
   - **Default:** include it with a fair-use cap in v1, and meter later from per-script analytics.
10. **Policy when Autumn is unreachable and an org has no snapshot** (its first request ever)?
    - Why it matters: it's the only case where the hot path can block or fail.
    - **Default:** allow a 200-credit ($0.20) unverified grace per org, flagged for reconcile.
11. **Free tier: 500 one-off credits** (today's onboarding_plan) **or a monthly free allowance?**
    - Why it matters: it shapes acquisition cost and abuse exposure (each sign-up is an org).
    - **Default:** 500 one-off, plus email verification before credits can be spent.
12. **Budget for Autumn itself:** stay on Free (10K customers and entities, 10M requests), or move to
    Pro at $375/mo?
    - Why it matters: entities are one per org per app, so they hit the cap sooner than customers.
    - **Default:** Free during the prototype. Move to Pro when customers plus entities pass about 8K.

---

## 5. Load-bearing claims (if wrong, the design changes)

1. **Tracking with `entity_id` spends the customer-level wallet when the entity has no grant of its
   own, and entity-level `usage_limits` cap that draw.**
   - Source: `autumn://docs/concepts` ("Entity-level check/track calls can use customer-level state
     plus matching entity-level state"); billing-controls doc ("An entity-level usage limit ... gets
     its own per-entity window").
   - Not stated: how deduction is ordered between an entity-scoped plan's grant and the customer pool.
   - If wrong: per-app caps move entirely into the DO, and Autumn sees only customer-level events
     with an `app` property. Critical.
2. **`Idempotency-Key` is honored on `balances.track` for 24h; a duplicate returns 409; retryable
   failures release the key.**
   - Source: https://docs.useautumn.com/documentation/customers/edge-cases and Autumn server
     `withIdempotencyKey.ts` / `resolveIdempotencyTtl.ts` at `832d03fb`.
   - If wrong: the flush needs value-reconciliation instead (read usage after each flush) and can't
     retry 5xx safely. Critical for exactly-once.
3. **With API ≥ 2.5.0, `track` is async unless `async: false`, and `async: false` returns the
   post-deduction balance.**
   - Source: changelog 2026-10-12; track API reference.
   - If wrong: the DO can't reconcile from the flush response and must rely on `check` reads plus a
     guard for in-flight amounts. Not critical.
4. **Autumn has no revenue-share or payout primitive. The Platform API makes each tenant its own
   merchant of record (separate Autumn org and Stripe).**
   - Source: https://docs.useautumn.com/api-reference/platform/overview and `update-stripe` (private
     preview; no fee fields).
   - If Autumn adds application fees on connected accounts, the marketplace could run through Autumn
     instead of separate Stripe transfers. Critical for the marketplace phase only.

Also worth checking, not load-bearing:
- whether `entities.create` fails when the customer's plan doesn't grant the entity's `feature_id`
  (the fix is to grant `apps` on every plan);
- whether entity ids must be unique per customer or per org (using `apps.id`, which is globally
  unique, avoids the question).

---

## 6. Sources

Autumn (fetched 2026-10-15 unless noted):
- MCP resources `autumn://docs/concepts`, `autumn://docs/catalog`, `autumn://docs/billing`,
  `autumn://docs/logs` (Autumn MCP server, read 2026-10-15).
- Live org reads: `getCurrentOrganization`, `getAgentRules`, `listPlans` (all_versions, include_archived),
  `listFeatures` (2026-10-15).
- https://docs.useautumn.com/llms.txt (index)
- https://docs.useautumn.com/documentation/rate-limits
- https://docs.useautumn.com/documentation/customers/balance-locking
- https://docs.useautumn.com/api-reference/balances/finalizeLock
- https://docs.useautumn.com/api-reference/core/track
- https://docs.useautumn.com/api-reference/core/batchTrack
- https://docs.useautumn.com/api-reference/core/check
- https://docs.useautumn.com/documentation/customers/edge-cases (Billing Reliability: `Idempotency-Key`)
- https://docs.useautumn.com/documentation/webhooks
- https://docs.useautumn.com/documentation/customers/tax
- https://docs.useautumn.com/documentation/concepts/stripe
- https://docs.useautumn.com/documentation/concepts/balances
- https://docs.useautumn.com/documentation/customers/billing-controls
- https://docs.useautumn.com/api-reference/customers/updateCustomer (`balance_allocations`)
- https://docs.useautumn.com/api-reference/entities/createEntity
- https://docs.useautumn.com/documentation/customers/feature-entities
- https://docs.useautumn.com/documentation/modelling-pricing/entity-plans
- https://docs.useautumn.com/documentation/modelling-pricing/credit-systems
- https://docs.useautumn.com/documentation/edge-cache
- https://docs.useautumn.com/documentation/fail-open
- https://docs.useautumn.com/api-reference/billing/openCustomerPortal
- https://docs.useautumn.com/api-reference/platform/overview,
  https://docs.useautumn.com/api-reference/platform/update-stripe,
  https://docs.useautumn.com/api-reference/platform/create-organization
- https://docs.useautumn.com/changelog/changelog (entries 2026-07-17 multi-currency; 2026-09-11 API
  2.4, lock `overage_behavior`, threshold billing, credit dimensions; 2026-09-14 rate cards;
  2026-10-09 balance allocations, automatic tax in invoice mode; 2026-10-12 API 2.5.0 async track)
- https://useautumn.com/pricing
- https://www.npmjs.com/package/autumn-js (1.5.1, modified 2026-10-15T19:19Z; bundle inspected: pins
  `x-api-version` 2.6.0, `TrackParams.async` default true, `batchTrack` item `idempotencyKey`,
  `FinalizeBalanceParams.customerId` required). OpenSEO's installed 1.2.33 pins 2.3.0.
- https://github.com/useautumn/autumn @ `832d03fb` (2026-10-15):
  `server/src/internal/balances/idempotency/README.md`,
  `server/src/internal/misc/idempotency/withIdempotencyKey.ts`,
  `server/src/internal/misc/idempotency/resolveIdempotencyTtl.ts`,
  `server/src/honoMiddlewares/idempotencyMiddleware.ts`, `packages/sdk/src/hooks/idempotencyKeyHook.ts`;
  commit history of the middleware (2026-01-05, 2026-02-03).

Other:
- https://docs.stripe.com/connect/separate-charges-and-transfers (fetched 2026-10-15)
- https://openrouter.ai/docs/use-cases/usage-accounting (fetched 2026-10-15)
- https://developers.cloudflare.com/durable-objects/api/alarms/ and
  https://developers.cloudflare.com/durable-objects/platform/limits/ (fetched 2026-10-15)

Code (paths as cited above):
- This worktree: `apps/every-app-gateway/src/server.ts`, `src/server/app-gateway-entrypoint.ts`,
  `src/server/ai-proxy.ts`, `src/server/ai-usage.ts`, `src/db/apps.schema.ts`, `src/db/auth.schema.ts`,
  `src/auth/config.ts`, `cloudflare.config.ts`, `packages/perimeter/src/manifest/manifest.ts`, `TODO.md`,
  `adr/ADR-0001-*.md`, `adr/RFC-0001-*.md`, `docs/architecture-v2-overview.md`,
  `docs/architecture-v2-recommendation.md`.
- OpenSEO (`/Users/bensenescu/workspaces/open-seo`, HEAD `847c8854`): `src/server/billing/autumn.ts`,
  `src/server/billing/subscription.ts`, `src/server/billing/autumn-webhook.ts`,
  `src/server/billing/customer-status-sync.ts`, `src/shared/billing.ts`,
  `src/server/lib/dataforseo/client.ts`, `src/server/features/sam/SamChatAgent.ts`,
  `src/server/lib/chatAgent.ts`, `src/routes/api/autumn/$.ts`, `src/serverFunctions/billing.ts`,
  `package.json`; commit `a337f0ac` (2026-07-06).
