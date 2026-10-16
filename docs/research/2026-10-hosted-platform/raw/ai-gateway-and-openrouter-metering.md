# Metering and capping AI usage per organization and per app (Cloudflare AI Gateway + OpenRouter)

Researcher report for the hosted-platform spec, 2026-10-15. Question: when the
platform holds the provider keys, how does the gateway meter and cap AI spend
per organization and per app, and which system is the source of truth for cost?

How this was checked (all on 2026-10-15):

- Cloudflare: the docs (docs MCP and developers.cloudflare.com), the Cloudflare
  OpenAPI schema (the `PUT /ai-gateway/gateways/{id}` body), and the AI Gateway
  GraphQL schema, introspected read-only on the founder's account. One test
  query ran too.
- OpenRouter: the docs and API reference.
- Autumn: the API reference.
- Code: this worktree, plus OpenSEO at `/Users/bensenescu/workspaces/open-seo`.

Nothing was changed in any account.

## TL;DR

- **Today.** The gateway proxies OpenAI only, with one shared key. It logs
  token counts and bills nothing. Its usage tap has holes:
  - streamed chat completions that don't ask for usage report nothing;
  - aborted streams log nothing;
  - cache tokens are ignored.
  - It also forwards any `cf-aig-*` header an app sends. That doesn't matter
    today, but becomes a security hole once traffic goes through AI Gateway.
- **AI Gateway spend limits can't be the per-org or per-app hard cap.** Four
  reasons:
  - One rule gives every `{org, app}` bucket the *same* dollar limit (metadata
    `partition` mode). Different limits per plan would need one rule per value,
    and a gateway holds at most 20 rules.
  - Limits are time windows, not a prepaid wallet.
  - They're eventually consistent: cost is recorded after the request finishes.
  - They only count models whose pricing AI Gateway knows, on responses that
    carry token counts.

  They make a good **backstop** that catches our own bugs.
- **Recommendation: three layers, plus reconciliation.**
  1. **Gate (milliseconds, the only hard cap).** A per-organization Durable
     Object in the gateway (`OrgMeter`). It reserves an estimated cost before
     forwarding a request, settles the real cost when the stream ends, and
     refuses the next request as soon as the org's wallet or an app's budget is
     spent.
  2. **Provider-side backstops (eventually consistent).** AI Gateway
     spend-limit rules partitioned by `{org, app}` metadata, and OpenRouter
     per-key `limit`s with a daily reset. Both are uniform ceilings.
  3. **Truth.** Autumn, fed from `OrgMeter`'s outbox with
     `Idempotency-Key: <requestId>`.
  4. **Reconciliation.** Daily, against AI Gateway GraphQL `sum { cost }`
     grouped by `metadataValue(key: "org")`, and against OpenRouter per-key
     usage.
- **Where the real cost comes from:**
  - **OpenRouter:** the response's `usage.cost`. It's now included on every
    response, including the last SSE chunk, without opting in.
  - **AI Gateway providers (OpenAI, Anthropic, Google, Workers AI):**
    - *Final:* AI Gateway's per-request log `cost`, found by `cf-aig-log-id` or
      by our own `cf-aig-event-id`.
    - *Provisional:* our price table at stream end.
    - GraphQL analytics only reconcile. The dataset is adaptive (it has a
      `sampleInterval` dimension).
- **Simplest hosted v1: OpenRouter is the one metered LLM upstream for hosted
  apps.** OpenSEO already uses it, and every response carries its cost, so no
  price table is needed except for reservation estimates. Bring in AI Gateway
  (through the gateway Worker's `AI` binding) for Workers AI, for providers
  OpenRouter doesn't cover, and for observability.
- **Two security musts before any AI Gateway routing:**
  - Strip every `cf-aig-*` header the app sends. Otherwise an app can:
    - set `cf-aig-custom-cost` to 0;
    - pick a stored key with `cf-aig-byok-alias`;
    - share cache entries across tenants with `cf-aig-cache-key`;
    - turn payload logging back on.
  - Never give a hosted user Worker an `ai` binding. AI Gateway calls made
    through a binding are "pre-authenticated within the associated account".

---

## 1. What exists today

### 1.1 The gateway's AI proxy (OpenAI only, metered by log line)

| What | Where | Notes |
|---|---|---|
| One provider, one shared key | `apps/every-app-gateway/src/server/ai-proxy.ts:6-7`, `:94-100`, `:125-127` | `provider !== "openai"` returns 404. The gateway sets `authorization: Bearer ${env.OPENAI_API_KEY}`. The key is a plain gateway secret (`apps/every-app-gateway/cloudflare.config.ts:28`). |
| Inference-only allowlist | `ai-proxy.ts:39-49`, `:207-220` | Other OpenAI paths need both the operator's `AI_PROXY_EXTRA_ROUTES` and the manifest's `ai.routes`. |
| `store: false` forced | `ai-proxy.ts:51-52`, `:267-270` | OpenAI keeps stored completions account-wide. |
| Model allowlist | `ai-proxy.ts:132-146` | From the manifest's `ai.models`. Only enforced on inference routes. |
| Headers stripped before upstream | `ai-proxy.ts:8-29`, `:318-322` | Strips identity, cookie and hop-by-hop headers. **Not stripped:** `cf-aig-*`, `x-api-key`, `openai-organization`, `openai-project`. |
| Usage tap | `ai-proxy.ts:176-190`, `apps/every-app-gateway/src/server/ai-usage.ts:21-58` | Keeps the last 16 KB of the body and pulls `input/prompt/output/completion/total_tokens` out with a regex. Emits a log line (`logEvent("ai.proxy.usage", …)`). **No cost, no ledger, no limit.** |
| Caller identity | `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts:13-17`, `:64-140` | `AppCallerProps {organizationId, appId, workerName}` come from service-binding props and are checked against the registry, with a 30 s cache (`:9-11`, `:208-228`). The manifest's `providers` must list the provider (`:114-120`). User attribution comes from the verified identity JWT (`:230-260`). |
| Binding props come from the deploy, not from the app | `packages/sdk/src/cloudflare/worker.ts:311-320`; entrypoint `apps/every-app-gateway/src/server.ts:152-164` | Props an app can't forge: that's the attribution primitive metering needs. |
| App side | `packages/sdk/src/server/gatewayFetch.ts:3-5`, `:28-71`, `:90-111` | `createGatewayFetch` is OpenAI-shaped and hardcodes `/api/ai/openai`. |
| Manifest | `packages/perimeter/src/manifest/manifest.ts:110-123`, `:127-148`, `:173-178` | `providers: string[]`, plus `ai: { models?, routes? }`. One shared model list, not one per provider. |
| Gateway bindings | `apps/every-app-gateway/cloudflare.config.ts:124-165` | D1, KV, email, three rate-limit bindings (`:141-152`). **No `AI` binding, no Durable Object.** |
| Open TODOs | `TODO.md:36-37` | "AI Gateway routing" and "Metered billing at the gateway (deferred)". |

Three holes in today's tap matter as soon as it bills:

1. **Streamed chat completions report no usage** unless the app sends
   `stream_options.include_usage` (`ai-usage.ts:4-6` documents this).
   `prepareBody` (`ai-proxy.ts:227-277`) already rewrites the JSON body, but
   doesn't force that option. AI Gateway has the same blind spot: "Cost metrics
   are only available for endpoints where the models return token data"
   (Costs doc).
2. **Aborted streams log nothing.** `tapUsage` only reports in the
   TransformStream `flush()` (`ai-usage.ts:54-56`), which never runs when the
   consumer cancels.
3. **The regex ignores cache and reasoning token details and reads only a
   16 KB tail.** OpenAI cached input, Anthropic `cache_creation_input_tokens`
   and `cache_read_input_tokens`, and an Anthropic `message_start` that holds
   input tokens can all fall outside it. A price table fed from this would
   misprice cached traffic.

### 1.2 What the design history says

- ADR-0001: "Hosted provider credentials are platform-managed for v1: Gateway
  uses a platform-owned provider API key … BYO provider keys are explicitly
  deferred" (`adr/ADR-0001-hosted-vs-self-hosted-topology.md:30-33`).
- RFC-0001: "Platform-managed provider credential injection at gateway. Usage
  metering dimensions include org/app/token for billing", followed by
  "Phase 2: Org-level metering and plan enforcement"
  (`adr/RFC-0001-org-rearchitecture-phase-1.md:79-82`, `:92-94`).
- Architecture v2 puts "LLM key injection" and "per-app spend metering" in the
  Workers for Platforms **outbound worker**
  (`docs/architecture-v2-overview.md:52-56`;
  `docs/architecture-v2-recommendation.md:51`). It plans hosted metering "via
  per-script GraphQL analytics + tags" (`docs/architecture-v2-recommendation.md:73`).
  §9 disagrees with both for AI.
- The self-host docs tell operators "there is no hard spending cap"
  (`landing-page/content/docs/how-it-works/gateway.mdx:68`). That's no longer
  true for AI traffic routed through AI Gateway (spend limits, 2026-06-05).

### 1.3 OpenSEO, the first app whose billing moves to the gateway

- **OpenRouter direct, with the app's own key.** The SAM agent reads
  `OPENROUTER_API_KEY` (`src/server/features/sam/SamChatAgent.ts:198-204`).
  The model is `openai/gpt-5.6-luna` (`src/server/lib/openrouter.ts:8`), built
  with `usage: { include: true }` (`openrouter.ts:47`, `:58`). OpenRouter now
  documents that flag as a deprecated no-op.
- **Cost comes from OpenRouter's response.** `openRouterCostUsd` reads
  `providerMetadata.openrouter.usage.cost` (`src/server/lib/chatAgent.ts:33-36`)
  on every agent step (`SamChatAgent.ts:398-402`).
- **Metering is chunked to Autumn.** Spend accumulates per step and is tracked
  once it passes `SAM_BILLING_CHUNK_USD = 0.05`
  (`SamChatAgent.ts:57-64`, `:407-449`). It's metered per step because "the
  Sep 2026 recovery loop burned ~$160/day of OpenRouter spend that never
  reached onChatResponse" (`SamChatAgent.ts:139-147`). That loss is exactly
  what gateway-side metering removes.
- **A credit gate runs before each turn**, with a second read before it refuses
  (`SamChatAgent.ts:326-347`).
- **DataForSEO uses holds.** `holdCredits` → `check({ lock })` with a 30-minute
  TTL, then `finalizeHold` (`src/server/billing/subscription.ts:207-290`,
  `:436`).
- **Pricing:** 1,000 credits per USD and a 1.28x markup
  (`src/shared/billing.ts:17-18`).
- **Retries:** "track() has no idempotency key", so only 429s are retried
  (`src/server/billing/autumn.ts:65-80`). §2.3 shows Autumn's current track API
  takes an `Idempotency-Key` header.

### 1.4 The founder's Cloudflare account (read-only check)

`GET /ai-gateway/gateways` shows three gateways, all with
`authentication: true`, `collect_logs: true` and `byok_only: false`:

- `moltworker`, created 2026-01-29;
- `default`, created 2026-04-24;
- `cloudflareos-ai`, created 2026-09-14.

None has `spend_limits` set. `GET /ai-gateway/logging-state` returns
`{"platform":"legacy","migration_available":false}`.

So this account is on **Legacy Logs**, where the Logs API and the binding's
`getLog()` work today. A brand-new account for the hosted platform would be on
Workers Logs (§2.1.7). Whether `getLog()` works there is unverified.

---

## 2. External reality, October 2026

### 2.1 Cloudflare AI Gateway

#### 2.1.1 How to call it

| Path | Auth | Fits Every App? |
|---|---|---|
| **REST API** (2026-05-21): `POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run`, `/ai/v1/chat/completions`, `/ai/v1/responses`, `/ai/v1/messages`. Model names look like `openai/gpt-…`, `anthropic/claude-…`, `@cf/…`. Pick the gateway with `cf-aig-gateway-id`; otherwise it uses the account's `default` gateway. | Cloudflare API token with **Workers AI Read**. A token with only AI Gateway permission gets `401` (REST API doc). | For outside callers. Not for the gateway Worker, which would have to hold an account-wide token. |
| **Provider-native endpoints**: `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}/…`. Slugs include `openai`, `anthropic`, `google-ai-studio`, `vertex`, `openrouter`, `workersai`, `groq`, `grok`, `deepseek`, `mistral` and others (providers index). | `cf-aig-authorization: Bearer <token>`. "AI Gateway Read, Run, and Edit cannot be limited to a single gateway", and a Run token "can send requests through every gateway in the account, including gateways that use stored provider keys" (Authentication doc). | Workable, but the gateway would hold an account-wide token. |
| **Worker `AI` binding**: `env.AI.run(model, input, { gateway: { id, metadata, collectLog, skipCache, … } })`, and `env.AI.gateway(id).run({ provider, endpoint, headers, query }, { gateway, extraHeaders })` for universal provider-native calls, plus `getLog`, `patchLog`, `getUrl`, `aiGatewayLogId`. Types are in `landing-page/worker-configuration.d.ts:9436-9548`. | "Requests made through an AI Gateway binding from a Worker are pre-authenticated within the associated account" (Authentication doc). The same doc suggests "a Worker-side AI Gateway binding" for isolating tenants. | **Recommended** for the gateway Worker. Limit: "AI Gateway's universal request carries JSON only. A multipart body … throws a TypeError" (Agents AI SDK doc). That rules out audio and image uploads (`ai-proxy.ts:43-48`). |

Streaming passes straight through: the universal `run()` returns the raw
provider `Response`, and the Agents SDK model providers stream over it (Agents
models doc). Responses carry `cf-aig-log-id` (glossary). Other
response-header features: `cf-aig-cache-status`, `cf-aig-step`, `cf-aig-dlp`.

#### 2.1.2 Credentials: Unified Billing, BYOK, `byok_only`

- **Unified Billing:**
  - Prepaid Cloudflare credits pay for third-party models. "A 5% fee is applied
    to all credits purchased … Inference pricing from providers is passed
    through with no markup."
  - The balance can go negative and is charged monthly.
  - Auto top-up is available. ZDR routing applies only to Unified Billing.
  - (Unified Billing doc.)
- **Unified Billing rate limit:** "200 requests per 60 seconds per gateway",
  returning `429`. "This limit does not apply to requests that use your own
  provider keys (BYOK)." Limits can be raised through a form (Limits doc).
  - For a multi-tenant agent product this is the binding constraint. One SAM
    turn can make up to 40 model calls (`SamChatAgent.ts:384-393`).
- **Credential precedence:**
  1. a provider key on the request;
  2. the BYOK key stored under the `default` alias;
  3. Unified Billing.

  On the binding and `/ai/v1/*` paths, only the `default` alias is consulted.
  `cf-aig-byok-alias` selects other aliases only on provider-native passthrough
  (Unified Billing and BYOK docs).
- **BYOK** keys live in Secrets Store under the name
  `{gateway_id}_{provider_slug}_{alias}`. The gateway update body has a
  `store_id` (OpenAPI).
- **`byok_only`** (2026-09-14, "Require provider credentials"): third-party
  requests with no applicable credentials get `400` instead of silently using
  Unified Billing. `cf-aig-no-wholesale: true` sets the same per request.
  Workers AI is unaffected (changelog; Unified Billing doc).
- Cloudflare model-catalog example responses carry
  `"gatewayMetadata": { "keySource": "Unified" }`, so the body says which
  credential paid (e.g. `developers.cloudflare.com/ai/models/openai/gpt-5/`).

#### 2.1.3 Spend limits (2026-06-05; docs updated 2026-09-30)

- **Behaviour:**
  - "Before sending a request to the provider, AI Gateway evaluates all
    applicable spend limit rules at once. If any individual rule is over
    budget, the request is blocked with a `429`."
  - "Spend limits are eventually consistent. The current request's cost is
    recorded after completion, so a burst of concurrent requests can briefly
    exceed the limit."
  - They apply to "Unified Billing requests and BYOK requests for models with
    known pricing".
  - Cost tracking is "a best-effort estimation".
  - "A maximum of 20 spend limit rules can be configured per gateway."
  - When a limit is hit, you choose block (the default) or a Dynamic Route
    fallback to a cheaper model.
  - The docs give no propagation-latency figure and no body for the `429`.
- **Rule schema** (OpenAPI, `PUT /accounts/{account_id}/ai-gateway/gateways/{id}`):

```text
spend_limits: { enabled: boolean, rules: [ {
  id: /^[a-zA-Z0-9_-]+$/, enabled: boolean,
  limitType: "cost", limit: number > 0, window: integer > 0,
  technique: "fixed" | "sliding" (default "sliding"),
  metadata?: { [key]: { mode: "partition" } | { mode: "filter", values: string[] } },
  model?:    { mode: "filter", values: string[] },
  provider?: { mode: "filter", values: string[] }
} ] (maxItems 20) }
```

- **`window`'s unit isn't documented.** `rate_limiting_interval` is in seconds,
  and the dashboard offers "daily, weekly, monthly" (Features page). Assume
  seconds and verify.
- **Docs and API disagree on provider and model.** The docs table shows them
  split by value, but the API only accepts `filter` for them. Metadata
  `partition` is the mode we need anyway.
- **Several partition keys in one rule give one bucket per combination** (docs
  dimension table). So `{ org: partition, app: partition }` is a per-`{org, app}`
  budget. Every bucket gets the **same** `limit`.
- An org-specific limit needs a `filter` rule naming that org. That takes one
  of the 20 rules, so per-plan or per-customer budgets can't be expressed.
- There is also a deprecated account-level `/ai-gateway/billing/spending-limit`
  (OpenAPI).

#### 2.1.4 Custom metadata, custom costs, rate limiting

- **Metadata:**
  - At most "five custom metadata entries per request"; extras are dropped.
  - Values are strings, numbers or booleans.
  - `cf.*` keys are reserved and stripped. `cf.user_id` is added only behind
    Access on a custom domain.
  - The docs say nothing about forgery, so the gateway Worker must build the
    header itself (Custom metadata doc).
- **Custom costs:** `cf-aig-custom-cost: {"per_token_in","per_token_out","per_cache_read_token","per_cache_write_token"}`.
  - "Override the default or public model costs."
  - Cache hits always cost 0.
  - Only applies "to requests that pass tokens in their response".
  - Cache-token rates added 2026-09-09.
- **Rate limiting is gateway-wide only:** "This rate limiting behavior will be
  uniformly applied to all requests for that gateway" (Rate limiting doc). For
  per-app request rates, use the Workers Rate Limiting binding the gateway
  already uses (`cloudflare.config.ts:141-152`).

#### 2.1.5 Analytics (GraphQL)

Introspected on 2026-10-15. The dataset is `aiGatewayRequestsAdaptiveGroups`:

- **Dimensions** include `gateway`, `provider`, `model`, `cost`, `tokensIn`,
  `tokensOut`, `cacheReadTokens`, `cacheWriteTokens`, `cached`, `wholesale`
  (Unified Billing), `rateLimited`, `statusCode`, `metadataKey`,
  `metadataValue`, `metadataKeys`, `metadataValues`, `metadataUserId`,
  `userAgent` and `sampleInterval`.
- **`sum { … }`** includes `cost`, `tokensIn`, `tokensOut`, `cachedRequests`
  and `erroredRequests`.
- **Filters** include `metadataKeys_has` and `metadataValues_has`.
- `metadataValue` takes an argument: a query without `key` fails with
  `argument "key" is required`. With it, it groups: a test query using
  `org: metadataValue(key: "org")` ran (no rows, since nothing on this account
  sends that key).
- "Adaptive" plus `sampleInterval` means the numbers can be sampled. Use them
  for reconciliation and dashboards, never as the ledger.

#### 2.1.6 Logs

- **What's logged:** prompt, response, provider, status, tokens, **cost**,
  duration and user agent.
- **Payload off:** `cf-aig-collect-log-payload: false` (2026-03-17) skips the
  bodies but still logs "token counts, model, provider, status code, cost, and
  duration". `cf-aig-collect-log: false` skips the whole entry (Logging doc).
- **Logs API:** `GET /ai-gateway/gateways/{gw}/logs` filters on `event_id`,
  `metadata.key`, `metadata.value`, `cost` and `wholesale`. The detail endpoint
  returns `cost`, `custom_cost`, `tokens_in`, `tokens_out` and `metadata`
  (OpenAPI).
- **Our own correlation id:** `cf-aig-event-id` sets one, so a log can be found
  by our request id.

#### 2.1.7 Log platform change (2026-09-24)

Customers whose first gateway is created on or after 2026-09-24 "follow Workers
Logs pricing and retention". Older ones keep Legacy Logs, which "provides an AI
Gateway dashboard viewer and Logs API" (Legacy Logs and Limits docs). The docs
don't say whether `getLog()` and the Logs API work on the new platform.

#### 2.1.8 Latency

Cloudflare publishes no overhead figure. Edgee's benchmark (2026-08-05/06,
43 GCP regions; Edgee is a competitor) measured AI Gateway adding about 37 ms
time-to-first-token on GPT-5.4 and about 26 ms on claude-sonnet-4-6 compared
with a direct call (edgee.ai).

### 2.2 OpenRouter

- **Usage accounting.**
  - "Full usage details are now always included automatically in every
    response." `usage: { include: true }` and
    `stream_options: { include_usage: true }` "have no effect".
  - When streaming, usage "is included in the last SSE message".
  - Fields: `prompt_tokens`, `completion_tokens`, `total_tokens`, `cost`,
    `cost_details.upstream_inference_cost`,
    `completion_tokens_details.reasoning_tokens`, and
    `prompt_tokens_details.{cached_tokens, cache_write_tokens, audio_tokens}`.
  - `upstream_inference_cost` is non-zero only for BYOK (usage-accounting
    cookbook).
  - Pricing is in USD: "the base currency is US dollars" (FAQ).
- **Generation lookup.** `GET https://openrouter.ai/api/v1/generation?id=gen-…`
  returns `total_cost`, `usage`, `upstream_inference_cost`, `cache_discount`,
  `cancelled`, `streamed`, `is_byok`, the native token counts, `provider_name`,
  `provider_responses` (fallback attempts), `request_id` and `external_user`
  (API reference). That's the fallback for aborted streams.
- **Management (provisioning) keys.**
  - They can't call completions. They're account-wide, and an expiry is
    recommended.
  - `POST /api/v1/keys` takes `name` (required), `limit` (USD),
    `limit_reset` (`daily`, `weekly`, `monthly` or `null`, resetting at midnight
    UTC), `include_byok_in_limit`, `expires_at` (ISO 8601 with seconds),
    `workspace_id`, `creator_user_id` and `external { user, api_key }`.
  - It returns `{ data: { hash, limit, limit_remaining, usage, usage_daily, … }, key }`,
    and "`key` is shown only in this response".
  - Also: `GET /api/v1/keys` (100 per page, `offset`),
    `GET|PATCH|DELETE /api/v1/keys/{hash}` (PATCH can set `disabled`).
- **Key limits are enforced up front.**
  - A key over its limit gets HTTP 402 with
    `metadata.limit_source: "openrouter_key_limit"`.
  - OpenRouter also tracks an in-flight budget (`"openrouter_in_flight_budget"`
    with `Retry-After`, and `weight_exceeds_budget` for a single over-budget
    request). So OpenRouter reserves against in-flight spend; it doesn't only
    deduct after the fact (Limits doc).
- **Guardrails (model allowlist per key).**
  - `POST /api/v1/guardrails` takes `name`, `limit_usd` and `reset_interval`
    (sent together), `allowed_models`, `allowed_providers`, `ignored_models`,
    `ignored_providers`, `enforce_zdr_{anthropic,google,openai,xai,other}`,
    `allowed_data_regions` and `include_byok_in_budgets`.
  - A guardrail "enforces nothing until it is assigned". Each key holds at most
    one guardrail, assigned with `bulkAssignKeys`.
  - Allowlists intersect, and the stricter limit wins.
  - Violations return HTTP 403 (Guardrails guide and API reference). The
    official blog once said 402/404, so the code must handle both.
- **Fees.**
  - "OpenRouter charges a 5.5% ($0.80 minimum) fee when you purchase credits";
    crypto is 5%.
  - BYOK has "$25,000 per month with no BYOK fee" on pay-as-you-go, then 5% of
    list price.
  - Unused credits may expire after a year (FAQ).
- **Aborting a stream** "immediately stops model processing and billing" only
  on supported providers. OpenAI, Anthropic, xAI, DeepSeek and others are
  supported; Google, Bedrock, Groq, Mistral and others aren't. Otherwise "you
  will be billed for the complete response" (Streaming doc).

### 2.3 Autumn facts the ledger depends on

- **`POST /v1/balances.track`** takes `customer_id`, `feature_id` or
  `event_name`, `value`, `entity_id`, `properties`, `timestamp`,
  `overage_behavior` (`cap`, the default, or `overflow`) and `async`.
  - `async` defaults to `true`, which returns 202 with `balance: null`.
  - **Idempotency goes in an `Idempotency-Key` header, and a retry with the
    same key gets 409** (Track API reference). That contradicts
    `open-seo/src/server/billing/autumn.ts:65`.
- **Locks** (`check` with `lock`, then `balances.finalize` with `confirm` or
  `release`) can be held at most 24 hours (Balance locking doc).
- **Entities** are sub-accounts with their own balances. Usage at the customer
  level is "also deducted from the first-created entity". The docs say nothing
  about a per-entity cap separate from the customer pool (Feature entities doc).
  So Autumn entities aren't a clean way to cap per app inside one org pool.

---

## 3. What the hosted tier needs

1. **Attribution an app can't forge**, on every metered call: `{org, app}`,
   plus `user` and channel when known.
   - Self-host already has it: service-binding props
     (`worker.ts:311-320` → `app-gateway-entrypoint.ts:160-180`).
   - Hosted (Workers for Platforms) needs the equivalent. The dispatch Worker
     passes a capability stub, `ctx.exports.AppGateway({ props })`, through the
     user Worker's `props`. Per the WfP Dynamic Dispatch doc, "the user Worker
     cannot read them directly".
2. **One real cost per request, per provider**, recorded once even with
   retries, aborts and evictions.
3. **A hard cap that bites within seconds**, on both the org's prepaid wallet
   and an optional budget per app (or per member).
4. **A billing ledger** (Autumn) that gets every usage event exactly once,
   tolerates Autumn outages, and turns cost into credits with the markup.
5. **Provider-side ceilings that hold even if our code is wrong.** OpenSEO's
   $160/day loss is the precedent (`SamChatAgent.ts:143-145`).
6. **No prompt storage** in our Cloudflare account. Metadata only.
7. **The same code in self-host:** the meter and usage page work, budgets are
   optional, and there's no Autumn.

---

## 4. Recommended metering architecture

### 4.1 Shape

```
 App Worker (service binding / WfP stub; props = {org, app, worker})
   │  POST http://every-app-gateway.internal/api/ai/<provider>/...
   ▼
 Gateway: AppGateway entrypoint
   1 caller check (registry, active, provider granted, model allowed)       [exists]
   2 normalize body: model allowlist, clamp max output, force usage on      [new]
   3 OrgMeter.reserve({app, requestId, estUsd})  ── refuse → 402            [new, DO]
   4 upstream:
       openrouter → fetch(openrouter.ai, per-org/app key)                   [new]
       openai|anthropic|google|@cf → env.AI.gateway("everyapp").run(...)    [new]
         with cf-aig-metadata {org, app, user, chan}, cf-aig-event-id=requestId,
         cf-aig-collect-log-payload:false, skip cache, 1 attempt
   5 stream back through a tap that parses usage/cost per provider          [extend]
   6 waitUntil(OrgMeter.settle({requestId, costUsd, status}))               [new]
   ▼
 OrgMeter DO (one per org, SQLite)
   wallet mirror · per-app caps · holds · usage events (outbox)
   alarm → Autumn balances.track (Idempotency-Key=requestId), refresh wallet,
           expire holds → reconcile by provider record
   ▼
 Autumn (plans, wallet, invoices)  ← webhooks (top-ups) → OrgMeter
 Backstops: AIG spend_limits {org,app} partition · OpenRouter key limit/day
 Reconcile (daily cron): AIG GraphQL sum(cost) by org/app · OpenRouter key usage
```

### 4.2 Where the real cost comes from

| Upstream | Provisional (at stream end, sets the gate) | Final (the ledger) | Reconcile against | Our cost per $1 of list price |
|---|---|---|---|---|
| OpenRouter (direct) | Response `usage.cost`; for streams, the last SSE chunk | The same value. If the stream aborted: `GET /api/v1/generation?id=` → `total_cost`, `cancelled` | Per-key `usage_daily` (`GET /api/v1/keys/{hash}`) | 1.055 (5.5% fee on credits) |
| OpenAI / Anthropic / Google via AI Gateway, **Unified Billing** | Our price table × parsed usage, cache-aware | AI Gateway log `cost` for the request: `getLog(cf-aig-log-id)`, or the Logs API filtered by `event_id = requestId`. Assumes Cloudflare deducts what it logs (unverified, §8). | GraphQL `sum { cost }` by `metadataValue(key)`, `wholesale = 1`; monthly invoice | 1.05 (5% fee on credits) |
| Same providers via AI Gateway, **BYOK** (platform keys in Secrets Store) | Price table × parsed usage | Price table, or AI Gateway log cost (both estimates) | Provider invoices, monthly | 1.00 (AI Gateway has no fee) |
| Workers AI through AI Gateway | AI Gateway cost (neurons) | AI Gateway log cost | GraphQL | depends on `workers_ai_billing_mode` |

Why not use the GraphQL figure: it's adaptive (it has a `sampleInterval`
dimension) and aggregated, so it can't charge one request. Why not trust our
price table forever: providers price cache reads, cache writes, long-context
tiers and service tiers differently, and AI Gateway already "accounts for these
differences and prevents double-counting" (Custom costs doc). Recommendation:
the table sets the gate; the AI Gateway log cost, or OpenRouter's `cost`, is
what Autumn charges.

### 4.3 Can AI Gateway spend limits be the hard cap, with Autumn as billing truth?

**No.** They should be the backstop.

| Requirement | AI Gateway spend limits | Verdict |
|---|---|---|
| Different budget per org plan or per admin setting | One `limit` per rule. `partition` gives every org the same number. Per-org values need a `filter` rule each, max 20 per gateway. | Fails |
| Prepaid wallet ("stop at 0 credits until top-up") | Time `window` + `fixed`/`sliding` only | Fails |
| Stops within seconds | Checked before the request, but cost recorded after it, so concurrent requests overshoot | Partly |
| Counts all traffic | Only "models with known pricing", and only responses with token data. OpenRouter called direct isn't counted. Whether it's counted through AI Gateway's `openrouter` provider is unverified. | Fails for OpenRouter |
| An error the app can understand | `429`, the same status as rate limits and the Unified Billing ceiling. No documented body. | Weak |
| Protects us from our own bugs | Yes: an independent ceiling outside our code | **Good backstop** |

Same verdict for OpenRouter per-key `limit`s. They're enforced up front and
include in-flight reservations, which makes them tighter than AI Gateway's. But
one limit per key has to be PATCHed on every plan change or top-up to track a
wallet, so use them as a per-(org, app) daily ceiling, not the wallet.

And Autumn isn't the right per-request gate either:

- every LLM call would add a network round trip to Autumn;
- `track` is asynchronous by default (202, `balance: null`);
- locks top out at 24 hours.

OpenSEO already treats Autumn as the ledger and gates per turn, with chunking
(`SamChatAgent.ts:57-64`).

### 4.4 Request lifecycle, concretely

**(a) The app calls the gateway.** The OpenSEO example below is a sketch:
`createGatewayFetch` must first become provider-generic, gap G11.

```ts
// open-seo: src/server/lib/openrouter.ts (after the move)
const openrouter = createOpenRouter({
  apiKey: "gateway-injected",                       // the app never holds a key
  baseURL: "http://every-app-gateway.internal/api/ai/openrouter/api/v1",
  fetch: createGatewayFetch({ env, provider: "openrouter" }),
});
```

**(b) Normalize and reserve** in the gateway's `AppGateway` handler, after the
existing caller checks (`app-gateway-entrypoint.ts:72-131`):

```ts
const requestId = `req_${crypto.randomUUID()}`;
// chat completions: force usage so the stream reports it (AIG prices only responses with tokens)
if (body.stream && path.endsWith("/chat/completions")) body.stream_options = { include_usage: true };
body.max_tokens = Math.min(body.max_tokens ?? catalog.defaultMaxOut(model), catalog.maxOut(model));
const estUsd = catalog.inUsd(model) * Math.ceil(rawBytes / 4) + catalog.outUsd(model) * body.max_tokens;

const meter = env.ORG_METER.get(env.ORG_METER.idFromName(caller.organizationId));
const hold = await meter.reserve({ appId: caller.appId, requestId, estUsd });
if (!hold.ok) {
  return Response.json(
    { error: "AI budget exhausted", code: hold.code /* org_credits_exhausted | app_budget_exhausted */,
      app: caller.appId, resetsAt: hold.resetsAt ?? null },
    { status: 402 },
  );
}
```

**(c1) Upstream through AI Gateway.** Provider-native, JSON only, using the
binding:

```ts
const res = await env.AI.gateway("everyapp").run({
  provider: "anthropic",
  endpoint: "v1/messages",                       // the path after the provider slug; check per provider
  headers: {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    // Built from service-binding props; the app's own cf-aig-* headers were stripped.
    "cf-aig-metadata": JSON.stringify({ org: caller.organizationId, app: caller.appId,
                                        user: user?.id ?? "-", chan: user ? "web" : "app" }),
    "cf-aig-event-id": requestId,                 // find the log by our id later
    "cf-aig-collect-log-payload": "false",        // never store prompts or outputs
    "cf-aig-skip-cache": "true",                  // no cross-tenant cache, no $0 cache hits
    "cf-aig-max-attempts": "1",                   // retries stay explicit and visible to the meter
  },
  query: body,
});
const aigLogId = res.headers.get("cf-aig-log-id");
```

**(c2) Upstream to OpenRouter**, directly:

```ts
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${await keys.openrouter(caller)}`, "content-type": "application/json",
             "x-title": "Every App" },
  body: JSON.stringify(body),
  signal: request.signal,
});
```

The last chunks of an OpenRouter stream. The `usage` object is verbatim from
the OpenRouter usage-accounting cookbook; its numbers are the doc's own
example:

```text
data: {"id":"gen-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: {"object":"chat.completion.chunk","usage":{"completion_tokens":2,"completion_tokens_details":{"reasoning_tokens":0},"cost":0.95,"cost_details":{"upstream_inference_cost":19},"prompt_tokens":194,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":100,"audio_tokens":0},"total_tokens":196}}
data: [DONE]
```

The tap records `id` (`gen-…`) from the first chunk, so an aborted stream can
be settled from `GET /api/v1/generation?id=gen-…` (`total_cost`, `cancelled`).

**(d) Settle**, off the critical path:

```ts
return new Response(
  tapUsage(res.body!, {
    onUsage: (u) => ctx.waitUntil(meter.settle({ requestId, status: "ok", costUsd: u.costUsd,   // OpenRouter: u.cost
                                                 provisional: u.costUsd === undefined, usage: u, aigLogId })),
    onCancel: (partial) => ctx.waitUntil(meter.settle({ requestId, status: "aborted", partial, aigLogId })),
  }),
  res,
);
```

**(e) `OrgMeter`** (a sketch). Everything is keyed by `requestId`, so a replay
is harmless:

```ts
export class OrgMeter extends DurableObject {
  // SQLite: wallet(credits, refreshed_at) · app_caps(app_id, cap_usd, period) · spent(app_id, period_start, usd)
  //         holds(request_id PK, app_id, usd, expires_at) · events(request_id PK, app_id, provider, model,
  //         cost_usd, credits, status, aig_log_id, gen_id, flushed_at)
  reserve({ appId, requestId, estUsd }) {
    const inflight = this.sumHolds();
    if (this.walletUsd() - inflight - estUsd < -OVERDRAFT_USD) return { ok: false, code: "org_credits_exhausted" };
    const cap = this.cap(appId);
    if (cap && this.spent(appId) + this.sumHolds(appId) + estUsd > cap.usd)
      return { ok: false, code: "app_budget_exhausted", resetsAt: cap.periodEnd };
    this.sql`INSERT INTO holds VALUES (${requestId}, ${appId}, ${estUsd}, ${Date.now() + 15 * 60_000})`;
    return { ok: true };
  }
  settle({ requestId, costUsd, status }) {
    // INSERT OR IGNORE events → delete hold → spent += cost*markup → wallet -= credits → setAlarm(now+2s)
  }
  async alarm() {
    // 1 flush unflushed events to Autumn (Idempotency-Key = request_id; 409 = already applied)
    // 2 expired holds → look up the provider record (AIG log by event_id / OpenRouter generation) → settle
    // 3 refresh wallet from Autumn if stale or near zero
  }
}
```

**(f) The ledger write to Autumn.** One event per request, or one aggregate per
(org, app, minute) whose idempotency key is the window id.

```bash
curl -X POST https://api.useautumn.com/v1/balances.track \
  -H "Authorization: Bearer $AUTUMN_SECRET_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: req_3f1c…" \
  -d '{"customer_id":"<orgId>","feature_id":"llm_usage","value":37,
       "properties":{"app":"openseo","provider":"openrouter","model":"openai/gpt-5.6-luna",
                     "cost_usd":0.02891,"request_id":"req_3f1c…"},
       "overage_behavior":"overflow","async":false}'
# value = ceil(0.02891 USD × 1.28 markup × 1000 credits/USD) = 37
```

**(g) Backstops**, configured as code. This is a single `PUT`; the fields the
schema requires are included:

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai-gateway/gateways/everyapp" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"authentication":true,"collect_logs":true,"cache_ttl":0,"cache_invalidate_on_update":false,
       "rate_limiting_interval":null,"rate_limiting_limit":null,"rate_limiting_technique":null,
       "retry_max_attempts":1,"byok_only":true,
       "spend_limits":{"enabled":true,"rules":[
         {"id":"org_app_day","limitType":"cost","limit":25,"window":86400,"technique":"sliding",
          "metadata":{"org":{"mode":"partition"},"app":{"mode":"partition"}}},
         {"id":"org_day","limitType":"cost","limit":100,"window":86400,"technique":"sliding",
          "metadata":{"org":{"mode":"partition"}}},
         {"id":"all_day","limitType":"cost","limit":1000,"window":86400,"technique":"fixed"}]}}'
```

Set `byok_only` to `false` if we choose Unified Billing (question Q1).

The OpenRouter keys, phase 2:

```bash
curl -X POST https://openrouter.ai/api/v1/keys -H "Authorization: Bearer $OPENROUTER_MANAGEMENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"org_8f3k2:openseo","limit":20,"limit_reset":"daily","include_byok_in_limit":false,
       "expires_at":"2027-10-15T00:00:00Z"}'
# 201 {"data":{"hash":"f01d…","limit":20,"limit_remaining":20,"limit_reset":"daily","usage_daily":0,…},"key":"sk-or-v1-…"}

curl -X POST https://openrouter.ai/api/v1/guardrails -H "Authorization: Bearer $OPENROUTER_MANAGEMENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"app:openseo","allowed_models":["openai/gpt-5.6-luna","minimax/minimax-m3"],"enforce_zdr_openai":true}'
# then bulkAssignKeys(guardrail, [hash]); the path is in OpenRouter's Guardrails API reference
```

**(h) Daily reconciliation** from the gateway's existing hourly cron
(`17 * * * *`, `TODO.md`):

```graphql
query ($tag: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $tag }) {
    aiGatewayRequestsAdaptiveGroups(limit: 10000,
      filter: { gateway: "everyapp", datetime_geq: $start, datetime_lt: $end }) {
      count
      sum { cost tokensIn tokensOut }
      dimensions { provider model wholesale org: metadataValue(key: "org") app: metadataValue(key: "app") }
    }
  } }
}
```

Compare each `{org, app}` with `OrgMeter`'s `events`. Alert on more than 2%
drift. Never auto-correct from sampled data.

### 4.5 Making a per-app budget stop within seconds

- **Reserve, then settle, inside one per-org Durable Object.** A DO is
  single-threaded, so the request after the one that exhausts the budget is
  refused in the same millisecond. Nothing depends on log or analytics lag.
- **Overshoot is bounded.** It's at most (concurrent in-flight requests) ×
  (actual − estimate). Clamping `max_tokens` (step b) bounds each estimate.
- **Waiting on Autumn doesn't delay the cutoff.** The DO lowers its own wallet
  copy on every settle. Autumn's view catches up through the outbox. Top-ups
  reach the DO through Autumn's webhook (OpenSEO already verifies Autumn
  webhooks with Svix: `src/server/billing/svix.ts`, `autumn-webhook.ts`), with a
  pull from Autumn as a fallback when the copy is stale or near zero.
- **Provider-side ceilings** (AI Gateway rule `org_app_day`, the OpenRouter key
  limit) catch whatever slips past us, within their consistency windows.
- **Per member, later:** the same DO, keyed by the `user` metadata the gateway
  already resolves (`app-gateway-entrypoint.ts:230-260`).

### 4.6 Failure modes

| Failure | Today | Risk | Mitigation |
|---|---|---|---|
| Ledger lags (Autumn `track` async by default; AI Gateway spend limits eventually consistent; GraphQL delayed and sampled) | No ledger | Spend runs past zero while the views catch up | The DO is the gate; Autumn is the record; GraphQL is reconciliation only |
| Stream aborted by the client | `flush()` never runs, so nothing is logged (`ai-usage.ts:54-56`) | Unbilled usage. On OpenRouter providers that don't support cancellation, the full response is billed to us (Streaming doc). | Add `cancel()` to the tap → settle as `aborted` with partial counts → an alarm settles from the provider record (OpenRouter generation by `gen-` id; AI Gateway log by `event_id`) |
| Worker evicted between response and settle | n/a | A hold leaks | Holds carry a TTL; the alarm reconciles expired holds the same way |
| Retries double-count | n/a | (a) App SDK retries are separate upstream calls, and billing each is correct. (b) AI Gateway retries (`cf-aig-max-attempts`) and OpenRouter fallbacks run inside one request. (c) Our own `settle` and Autumn calls get replayed. | (a) a new `requestId` each time; (b) set AI Gateway to one attempt; OpenRouter bills one generation (`provider_responses` lists the attempts); (c) `INSERT OR IGNORE` on `requestId`, and Autumn `Idempotency-Key` with 409 treated as success |
| Stream without usage (chat completions without `include_usage`) | Logs `usage: null` | Unbilled; AI Gateway records no cost, so spend limits are blind too | Force `stream_options.include_usage` in `prepareBody` |
| Cache tokens mispriced | Regex ignores them (`ai-usage.ts:13-19`) | Over- or under-billing | Parsers per provider. The final cost comes from AI Gateway or OpenRouter. |
| Model with no known price | n/a | AI Gateway spend limits ignore it; our estimate is wrong | Deny by default: only catalog models, and only within the manifest's `ai.models` |
| AI Gateway cache hit | Caching off by default (TTL 0) | $0 cost but billable to the customer; cross-tenant response reuse | Gateway `cache_ttl: 0`, strip app cache headers, send `cf-aig-skip-cache` |
| App-forged gateway headers | `cf-aig-*` passes through (`ai-proxy.ts:8-29`) | `cf-aig-custom-cost` set to 0, `cf-aig-byok-alias`, `cf-aig-cache-key` poisoning, payload logging turned on | Strip by prefix `cf-aig-`, plus `x-api-key`, `openai-organization` and `openai-project` |
| Unified Billing ceiling (200 requests per 60 s per gateway) | n/a | `429` across every tenant | BYOK with `byok_only`, or ask for a higher limit before launch |
| Three different `429`s (AI Gateway spend limit, Unified Billing ceiling, provider) | Passed through raw | The app can't tell budget from rate limit | Our gate returns `402` with `code`. Upstream `429` is mapped to `upstream_rate_limited`. |
| Multipart routes (audio, image edits) | Proxied directly (`ai-proxy.ts:240-251`) | Universal `run()` takes JSON only; priced per second or per image | Hosted v1 excludes them, or they go direct with their own price rows |
| Log platform | Legacy here | A new hosted account gets Workers Logs, and `getLog()` there is unverified | Check before choosing the account (§8) |

### 4.7 Latency budget per call

| Step | Cost |
|---|---|
| App → gateway (service binding / RPC) | about 0, same-machine RPC |
| `OrgMeter.reserve` | One DO round trip. Fast when the DO sits near the org's traffic; one inter-region round trip when it doesn't. |
| AI Gateway hop | about 26-37 ms extra time-to-first-token (Edgee, Aug 2026) |
| `settle` | Off the critical path (`waitUntil`) |

If `reserve` shows up in p50, a later optimization: the DO grants each isolate
a short spend lease (e.g. $0.50 for 10 s), so most calls skip the round trip.
The cost is a known, bounded overshoot.

### 4.8 The hosted identity carrier (for the Workers for Platforms researcher)

The WfP-native match for `EVERY_APP_GATEWAY` with props is a capability stub,
`ctx.exports.AppGateway({ props: { organizationId, appId, workerName } })`,
passed in the user Worker's `props` (Dynamic Dispatch doc). The catch: "An RPC
stub passed through dynamic dispatch props is valid only during the request that
received it". So cron, alarm and Workflow code in a hosted app, like OpenSEO's
SAM Durable Object, needs a second carrier: outbound-Worker `parameters`, or an
app credential checked against `app_tokens`
(`apps/every-app-gateway/src/db/apps.schema.ts:128`). Either way, the gateway
derives `cf-aig-metadata` from that carrier and never from the request.

---

## 5. Gaps and the smallest change that closes each

| # | Gap | Where | Smallest fix | Days |
|---|---|---|---|---|
| G1 | Streamed chat completions report no usage | `ai-proxy.ts:267-276` | When `stream` is on, set `stream_options.include_usage = true`. Clamp max output on inference routes. | 0.5 |
| G2 | Aborts skip metering | `ai-usage.ts:40-58` | Add a `cancel()` callback that reports partial counts and status `aborted` | 0.5 |
| G3 | Usage parser can't price anything | `ai-usage.ts:9-34` | Parsers per provider (OpenAI Chat and Responses, Anthropic Messages, OpenRouter `cost`) with cache and reasoning tokens, and the `gen-` id | 1 |
| G4 | `cf-aig-*` and provider routing headers pass through | `ai-proxy.ts:8-29` | Strip by prefix `cf-aig-`, plus `x-api-key`, `openai-organization` and `openai-project` | 0.25 |
| G5 | OpenAI is the only provider | `ai-proxy.ts:6-7`, `:94-100`; `app-gateway-entrypoint.ts:194-206` | A provider registry `{ openai, openrouter, anthropic, workers-ai }` → upstream (direct, or AI Gateway binding), allowed routes, parser | 2 |
| G6 | No `AI` binding, no AI Gateway configured | `apps/every-app-gateway/cloudflare.config.ts:124-165` | Add the `AI` binding. Setup creates gateway `everyapp` through the API (§4.4 g). | 1 |
| G7 | Nothing enforces a budget | new: `apps/every-app-gateway/src/server/metering/OrgMeter.ts` | A per-org DO: `reserve`, `settle`, outbox, alarm | 3 |
| G8 | No ledger | new, ported from `open-seo/src/server/billing/autumn.ts` and `subscription.ts:560` | Outbox → Autumn `balances.track` with `Idempotency-Key`; webhook for top-ups and plan changes | 2 |
| G9 | No price catalog or markup in the gateway (each app has its own, e.g. `open-seo/src/shared/billing.ts:17-18`) | new: model catalog in D1 or JSON | Model → provider, $/token (in, out, cache read, cache write), max output, markup, credits per USD. OpenRouter rows synced from its models API. | 1 |
| G10 | No approval step for providers, no budget per app | `manifest.ts:173-178`; admin Apps UI | An approval record for `providers` (the founder's "request permission"), an `app_ai_budgets` table, an admin page | 1.5 |
| G11 | SDK fetch only speaks OpenAI | `packages/sdk/src/server/gatewayFetch.ts:3-5`, `:90-111` | `createGatewayFetch({ env, provider, request? })` with per-provider path prefixes. Make `request` optional for Durable Object and background callers. | 0.5 |
| G12 | Hosted user Workers could spend our account directly | the hosted deploy API (not built) | Refuse an `ai` binding in user Worker metadata. Outbound Worker denies `api.openai.com`, `api.anthropic.com`, `openrouter.ai` and `gateway.ai.cloudflare.com`. | 0.5 |
| G13 | No reconciliation | the gateway cron | Daily GraphQL and OpenRouter-key comparison against `OrgMeter` events; alert on drift | 1 |
| G14 | One OpenRouter key shared by everyone | new | Phase 2: a key per (org, app) through the management API, stored encrypted in D1; a guardrail per app from `ai.models`; revoke = `PATCH disabled` | 2 |
| G15 | OpenSEO meters and bills itself | `SamChatAgent.ts:198-204`, `:398-449`; `openrouter.ts:47`, `:58` | Point the OpenRouter SDK at the gateway. Delete in-app LLM tracking in the same PR to avoid double billing. | 1.5 |
| G16 | No usage view | gateway admin UI | A per-app and per-org usage page reading `OrgMeter` | 1 |

**Suggested PR order** (stacked):

1. G4 + G1 + G2 + G3: make today's tap correct, still log-only.
2. G5 + G11: the `openrouter` provider end to end, still log-only.
3. G9 + G7: the catalog and `OrgMeter`, enforcing the gate (self-host: caps
   optional).
4. G8: the Autumn ledger (hosted mode only).
5. G15: OpenSEO through the gateway.
6. G6: AI Gateway binding for OpenAI, Anthropic and Workers AI, with backstop
   rules.
7. G10 + G16: approvals, budgets per app, usage UI.
8. G13, G14, G12 alongside the hosted deploy API.

---

## 6. Open questions only the founder can answer

1. **Q1. For providers routed through AI Gateway, use Unified Billing
   (Cloudflare's credentials) or BYOK (our own OpenAI and Anthropic accounts in
   Secrets Store) with `byok_only`?**
   - *Why it matters.* Unified Billing: one bill and no provider accounts, but
     a 5% fee and a ceiling of 200 requests per 60 s per gateway. With Unified
     Billing, Cloudflare's log cost is probably what we pay; with BYOK it's an
     estimate.
   - *Default.* Hosted v1 sends metered LLM traffic through OpenRouter. AI
     Gateway uses Unified Billing for Workers AI and the occasional
     OpenAI-native app. File the rate-limit increase before launch. Switch to
     BYOK with `byok_only: true` once volume is real.
2. **Q2. When the wallet runs low, refuse a request whose estimate exceeds the
   balance, or allow a bounded overdraft?**
   - *Why it matters.* Strict reservations refuse cheap requests near zero.
     OpenSEO's 16k output and 160k context per step reserves dollars per call.
   - *Default.* Allow requests while the balance is above 0. Overdraft is
     capped at one request's estimate. Autumn `overage_behavior: "overflow"`.
3. **Q3. One credit pool per org shared by all apps, or a plan per app?**
   - *Why it matters.* It decides whether Autumn entities are needed and how
     budgets per app work.
   - *Default.* One org pool (OpenSEO's `usage_credits` model). Apps are only a
     reporting dimension in Autumn (`properties.app`). Admins can set optional
     monthly caps per app, enforced by `OrgMeter`.
4. **Q4. Markup policy?**
   - *Why it matters.* Our cost per $1 is 1.055 (OpenRouter), 1.05 (Unified
     Billing) or 1.00 (BYOK). OpenSEO uses 1.28x for DataForSEO and "the usual
     markup" for LLMs.
   - *Default.* One platform markup per provider class, held in the gateway
     catalog: 1.28x at 1,000 credits per USD, the same as OpenSEO, so users see
     one rate.
5. **Q5. Do non-LLM metered providers (DataForSEO) also move to the gateway
   meter, and when?**
   - *Why it matters.* The founder's example ("for OpenSEO all billing and
     metering happens at the gateway") includes DataForSEO, which needs
     cost-reporting and hold semantics.
   - *Default.* Yes, after LLMs. Same `OrgMeter`, with a "metered provider"
     type whose cost comes from the provider's response.
6. **Q6. Separate Cloudflare account for hosted?**
   - *Why it matters.* A new account gets Workers Logs (2026-09-24 cutover),
     its own 20-gateway limit and its own Unified Billing balance. The
     founder's account is on Legacy Logs, where `getLog()` works.
   - *Default.* A separate account. Confirm `getLog()` on Workers Logs before
     relying on AI Gateway log cost as the final figure; until then, the
     provisional figure is the ledger figure for AI Gateway providers.
7. **Q7. Store prompts or outputs anywhere?**
   - *Why it matters.* Privacy and trust for org data. Debugging needs payloads
     sometimes.
   - *Default.* Never. Metadata-only logs (`cf-aig-collect-log-payload: false`).
     Opt-in per org later.
8. **Q8. In self-host mode, does the meter enforce budgets?**
   - *Why it matters.* The operator pays their own provider. Budgets protect
     against runaway agents.
   - *Default.* The meter and usage page are on. Budgets are optional per app.
     No Autumn.

---

## 7. Where the prior design docs no longer match the code or Cloudflare

- **Outbound-worker key injection** (`docs/architecture-v2-recommendation.md:51`,
  `docs/architecture-v2-overview.md:52-56`).
  - Recommend instead: keep the explicit broker on the `AppGateway` binding
    (`app-gateway-entrypoint.ts`). It already has identity, provider and model
    allowlists, and it works the same in self-host.
  - In hosted, the outbound Worker should only *deny* direct provider egress.
    Transparent injection there would mean parsing arbitrary provider calls
    with no manifest context.
- **"Metering via per-script GraphQL analytics + tags"**
  (`docs/architecture-v2-recommendation.md:73`). Fine for CPU and request
  counts. For AI the GraphQL dataset is adaptive (`sampleInterval`), so it can
  reconcile but not bill.
- **"Usage metering dimensions include org/app/token"**
  (`adr/RFC-0001-org-rearchitecture-phase-1.md:82`). With five metadata entries
  per request, use `org`, `app`, `user` and `chan`. The token adds nothing to
  billing.
- **"no hard spending cap"**
  (`landing-page/content/docs/how-it-works/gateway.mdx:68`). Still true for the
  Workers bill. For AI routed through an AI Gateway with spend limits, the
  gateway can now return `429` past a budget.
- **"track() has no idempotency key"** (`open-seo/src/server/billing/autumn.ts:65`).
  The Autumn Track API reference documents an `Idempotency-Key` header, with
  409 on replay. Verify on the SDK version OpenSEO pins.
- **`usage: { include: true }`** (`open-seo/src/server/lib/openrouter.ts:47`,
  `:58`). OpenRouter now documents it as a no-op. Harmless.

---

## 8. Load-bearing claims (if wrong, the design changes)

| Claim | Source | Critical? |
|---|---|---|
| AI Gateway spend limits check before the request but record cost after it (eventually consistent). Max 20 rules per gateway. Metadata `partition` gives each `{org, app}` its own bucket, all with **one** limit. | Spend limits doc (updated 2026-09-30); OpenAPI `spend_limits` schema | Yes. If limits could vary per value, AI Gateway could be the per-plan cap. |
| Unified Billing is capped at 200 requests per 60 s per gateway; BYOK is exempt; the limit can be raised. | AI Gateway Limits doc (updated 2026-09-24) | Yes. Decides Unified Billing vs BYOK for multi-tenant traffic. |
| OpenRouter returns `usage.cost` in USD on every response, including the last SSE chunk, without opting in. | OpenRouter usage-accounting cookbook | Yes. It makes OpenRouter the price-table-free metered upstream. |
| A Worker's `AI` binding is pre-authenticated for the whole account, so any Worker in the account with an `ai` binding can spend our credits and stored keys. | AI Gateway Authentication doc | Yes. Hosted user Workers must never get one. |
| Under Unified Billing, the per-request `cost` in AI Gateway logs equals what Cloudflare deducts. | Inferred ("pass-through pricing", invoices per model); not stated | No. Without it, the provisional figure is final and reconciliation uses the invoice. |
| `window` in spend-limit rules is in seconds. | Inferred from `rate_limiting_interval`; undocumented | No. One test PUT settles it. |
| `getLog()` and the Logs API work for accounts on the Workers Logs platform (first gateway on or after 2026-09-24). | Not documented; Legacy Logs doc mentions the API only for legacy accounts | Medium. Decides whether a new hosted account can use AI Gateway's cost as final. |
| AI Gateway doesn't price OpenRouter models proxied through its `openrouter` provider ("known pricing" only). | Inferred; the OpenRouter provider page says nothing about cost | No. It decides whether AI Gateway backstops cover OpenRouter traffic. |
| Autumn `balances.track` accepts `Idempotency-Key` (409 on replay). | Autumn Track API reference | Medium. Without it, the outbox must dedupe by aggregate window. |
| A WfP capability stub passed in `props` lasts only for its request. | WfP Dynamic Dispatch doc | Medium. Background AI calls in hosted apps need another carrier. |

---

## 9. Sources

Cloudflare (accessed 2026-10-15):
- Spend limits: https://developers.cloudflare.com/ai-gateway/features/spend-limits/ ; changelog 2026-06-05: https://developers.cloudflare.com/changelog/post/2026-06-05-spend-limits/
- Unified Billing: https://developers.cloudflare.com/ai-gateway/features/unified-billing/ ; `byok_only` changelog 2026-09-14: https://developers.cloudflare.com/changelog/post/2026-09-14-require-provider-credentials/
- REST API: https://developers.cloudflare.com/ai-gateway/usage/rest-api/ ; changelog 2026-05-21: https://developers.cloudflare.com/changelog/post/2026-05-21-rest-api/
- Worker binding methods: https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/
- Universal endpoint (binding `gateway().run`): https://developers.cloudflare.com/ai-gateway/usage/universal/
- Agents models (gateway `run()` transport) and AI SDK limitations (JSON only): https://developers.cloudflare.com/agents/models/ , https://developers.cloudflare.com/agents/models/ai-sdk/
- BYOK: https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/
- Authentication: https://developers.cloudflare.com/ai-gateway/configuration/authentication/
- Custom metadata: https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/
- Custom costs: https://developers.cloudflare.com/ai-gateway/configuration/custom-costs/ ; cache-token changelog 2026-09-09: https://developers.cloudflare.com/changelog/post/2026-09-09-custom-cache-token-costs/
- Costs: https://developers.cloudflare.com/ai-gateway/observability/costs/
- Rate limiting: https://developers.cloudflare.com/ai-gateway/features/rate-limiting/
- Logging (payload header): https://developers.cloudflare.com/ai-gateway/observability/logging/ ; changelog 2026-03-17: https://developers.cloudflare.com/changelog/post/2026-03-17-collect-log-payload-header/
- Legacy Logs: https://developers.cloudflare.com/ai-gateway/observability/logging/legacy-logs/
- Limits: https://developers.cloudflare.com/ai-gateway/reference/limits/
- Pricing: https://developers.cloudflare.com/ai-gateway/reference/pricing/
- Analytics (GraphQL): https://developers.cloudflare.com/ai-gateway/observability/analytics/
- Providers index: https://developers.cloudflare.com/ai-gateway/usage/providers/ ; OpenRouter provider: https://developers.cloudflare.com/ai-gateway/usage/providers/openrouter/ ; Anthropic provider: https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/
- Glossary (`cf-aig-log-id`, `cf-aig-event-id`): https://developers.cloudflare.com/ai-gateway/glossary/
- Manage gateway (default gateway settings): https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/
- Dynamic routing (Budget Limit node): https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/
- Model catalog (`gatewayMetadata.keySource`): https://developers.cloudflare.com/ai/models/openai/gpt-5/
- WfP dynamic dispatch (props, capabilities, outbound parameters): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/
- Cloudflare OpenAPI: `PUT /accounts/{account_id}/ai-gateway/gateways/{id}` (`spend_limits`, `byok_only`, `store_id`, `retry_*`); `GET …/logs` filters (`event_id`, `metadata.key`, `metadata.value`). Read with the Cloudflare API MCP `search` tool.
- GraphQL schema: `AccountAiGatewayRequestsAdaptiveGroupsDimensions`, `…Sum` and `…Filter_InputObject`, introspected 2026-10-15 on the founder's account (read-only).

OpenRouter (accessed 2026-10-15):
- Usage accounting: https://openrouter.ai/docs/use-cases/usage-accounting and https://openrouter.ai/docs/cookbook/administration/usage-accounting.md
- Management keys guide: https://openrouter.ai/docs/features/provisioning-api-keys
- Create key API: https://openrouter.ai/docs/api/api-reference/api-keys/create-a-new-api-key.md
- Get generation API: https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation.md
- Limits (402 `openrouter_key_limit`, in-flight budget): https://openrouter.ai/docs/api/reference/limits
- Guardrails guide: https://openrouter.ai/docs/guides/features/guardrails ; create API: https://openrouter.ai/docs/api/api-reference/guardrails/create-a-guardrail.md ; SDK operations: https://openrouter.ai/docs/client-sdks/typescript/sdks/guardrails/README.md
- FAQ (fees, BYOK allowance, USD): https://openrouter.ai/docs/faq.md
- Streaming cancellation: https://openrouter.ai/docs/api/reference/streaming
- Third-party note on the July 2026 BYOK change: https://www.truefoundry.com/blog/openrouter-byok-explained-cheaper-often-faster-and-changing

Autumn (accessed 2026-10-15):
- Track: https://docs.useautumn.com/api-reference/core/track.md
- Balance locking: https://docs.useautumn.com/documentation/customers/balance-locking.md
- Feature entities: https://docs.useautumn.com/documentation/customers/feature-entities.md

Latency:
- Edgee, "I benchmarked six AI Gateways, including ours" (2026-08): https://www.edgee.ai/blog/posts/i-benchmarked-six-ai-gateways-including-ours
- ComputeSDK AI Gateway benchmark (2026-08-21; dominated by model latency): https://www.computesdk.com/benchmarks/ai-gateway/cloudflare-ai-gateway
