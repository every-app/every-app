# The app-facing broker: what apps may call through the gateway

Research report for the hosted tier, 2026-10-15. Scope: the `AppGateway`
service-binding surface (AI proxy today, integrations and metered APIs next),
generalized into one broker with manifest-declared capabilities, grants,
secret injection and per-org/app/user metering. Code refs are to this
worktree (`main` at `e1d9d3c6`) unless a branch is named. Web sources are
listed in section 8, with the "last updated" dates the pages showed when I
opened them on 2026-10-15. Section map against the brief's outline:
1 = what exists, 2 = what hosted needs, 3–5 = design, gaps and the
smallest PR, 6 = founder questions, 7 = load-bearing claims, 8 = sources.

## TL;DR

- **The pieces mostly exist.** There is an unforgeable caller identity
  (service-binding `props` checked against the registry), a manifest-declared
  allowlist, secret injection, header stripping, a route lockdown, and a
  stream tap that reads usage. What's missing: provider packs, a grant
  table, a cost figure, a feature label, a ledger and a credit check. All of
  it is OpenAI-only and logs usage without storing it.
- **Keep HTTP over the binding for proxied traffic, and add a few RPC
  methods** for things that have no HTTP request (app-defined meters,
  holds, grant introspection). Every provider SDK takes a `fetch`, and RPC
  would only re-wrap the same `Request`.
- **One generic proxy, per-provider packs.** A pack sets the upstream
  origin, how the credential is injected, a route policy (including hazards
  that come from sharing one account across tenants), how the model is read,
  a cost parser (head, tail or price table), and an optional hold estimate.
  The GitHub POC's proxy and grant math fold in as the `github` pack.
- **Grants go in a gateway D1 table** that generalizes the POC's
  `app_integration_grants`. Catalog apps get implicit grants from their
  reviewed manifest. Org apps get pending rows at deploy that an admin
  approves.
- **Metering:** write a `usage_events` ledger row per call, with the raw
  provider cost in USD, how that cost was computed, the app-supplied feature,
  and the attribution (verified, asserted or app). Apply markup at billing,
  not in the ledger. Pre-checks go through a per-org wallet Durable Object
  later. The first PR only logs.
- **WfP reachability is the biggest unknown.** `everyAppWorker()` builds a
  static service binding with `props`. Nothing in the WfP docs confirms that
  a dispatch-namespace user Worker may bind a Worker outside the namespace,
  and the public OpenAPI upload schema for `service` bindings lists
  `entrypoint` but no `props`. The documented alternative, an RPC stub passed
  through dispatch props, is request-scoped. It cannot serve Durable Objects,
  Workflows or crons, and that's where OpenSEO makes its paid calls. Spike
  this before anything else.
- **Smallest PR:** an OpenRouter pack in `ai-proxy.ts`, cost extracted from
  `usage.cost`, an `x-everyapp-feature` header, user attribution and
  `costUsd` in the usage log line, and SDK `createGatewayFetch({ provider,
  feature, request? })`. About 1–1.5 engineer-days, with no migration.

---

## 1. What exists today

### 1.1 The binding and the caller's identity

| Piece | Where | What it does |
|---|---|---|
| Binding built into every deployed app | `packages/sdk/src/cloudflare/worker.ts:311-320` | `EVERY_APP_GATEWAY = { type: "worker", worker: "every-app-gateway", exportName: "AppGateway", props: { organizationId, appId, workerName } }`, from `.everyapp/deploy.json` (production only; dev has no binding, `worker.ts:324-328`). Binding type at `worker.ts:95-100`; constants at `worker.ts:249-250`. |
| Entrypoint | `apps/every-app-gateway/src/server.ts:151-164` | `class AppGateway extends WorkerEntrypoint<Env, AppCallerProps>` with only `fetch()`, which delegates to `handleAppGatewayRequest` with `this.ctx.props`. |
| Props parsing | `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts:160-180` | Requires non-empty `organizationId`, a kebab `appId` and a `workerName`; otherwise 401 `missing_caller_identity`. |
| Registry check | `app-gateway-entrypoint.ts:74-113`, cache `:208-228` | Looks up the app by (org, app). It must exist, be `active`, and match all three props. Per-isolate cache: 30 s for hits, 5 s for misses (`:9-11`). |
| Deploy-time guard | `packages/cli/src/lib/app/policy.ts:127-137` | The only `worker` binding an app may ship is `EVERY_APP_GATEWAY` → `every-app-gateway`/`AppGateway`. It **does not check `props`** (grep finds no `props` in `policy.ts`). That's fine for self-host, where the deployer already has account access (ADR-0003). |
| Platform guarantee | developers.cloudflare.com/workers/runtime-apis/context | "`ctx.props` can only be set by someone who has permission to edit and deploy the worker to which it is being delivered." |

On self-host, anyone who can deploy can claim to be any app in the account,
because nothing ties props to the Worker that uses them. The integrations
research already flags this as an open spike
(`git show research/app-integrations:docs/research/2026-10-integrations-hub/raw/build-patterns.md`,
line 851). On hosted, the platform builds every binding, so tenants can't
forge props. That holds only if the hosted deploy path refuses
tenant-supplied `worker`/`service` bindings and injects its own (gap G10).

### 1.2 What counts as a "grant" today

- `providers: string[]` in the manifest (`packages/perimeter/src/manifest/manifest.ts:110-122`, field at `:173-174`) **is** the grant. The entrypoint refuses any provider not listed, with 403 `provider_not_allowed` (`app-gateway-entrypoint.ts:114-120`). It is self-asserted: whoever deploys writes the manifest, and no approval step exists.
- `ai: { models?, routes? }` (`manifest.ts:136-148`) narrows inference to listed models. `routes` adds OpenAI paths beyond inference, but only inside the operator's `AI_PROXY_EXTRA_ROUTES` ceiling (`ai-proxy.ts:203-220`). The route regex is OpenAI-shaped (`/^\/v1(\/[a-z0-9_-]+)+$/`, `manifest.ts:129-134`), and `ai` applies to every provider at once.
- The manifest snapshot lives in `apps.manifest` (`apps/every-app-gateway/src/db/apps.schema.ts:43-45`) and is written at upload by `markDeployed` (`apps/every-app-gateway/src/server/services/AppRegistrationService.ts:562-579`). That's the natural hook for recording grant requests, and the POC already uses it (§1.6).
- `scopes` (`manifest.ts:57-76`, `:175-176`) is the closest existing "id → human label" record shape. Feature labels can copy it.

### 1.3 The AI proxy (`apps/every-app-gateway/src/server/ai-proxy.ts`)

- **OpenAI only, with one shared key.** `OPENAI_PROVIDER`/`OPENAI_UPSTREAM_BASE_URL` (`:6-7`). Any other provider gets 404 (`:94-96`). The key comes from `env.OPENAI_API_KEY` (`:98-100`, `:127`), which is a gateway secret (`apps/every-app-gateway/src/env.d.ts:66`, `cloudflare.config.ts:27-29`, CLI allowlist `packages/cli/src/lib/gateway/secretsFile.ts:11-31`).
- **Route lockdown because the key is shared across tenants.** Only POST to nine inference paths is allowed (`:31-49`). The comment explains that files, batches and stored completions are account-wide, so allowing them would let one app read another app's data. Extra paths need both the operator and the manifest (`:203-220`). `store: false` is forced on responses and chat completions (`:51-52`, `:267-270`).
- **Model allowlist** on inference routes; the gateway reads `model` from JSON or multipart (`:134-146`, `:227-277`).
- **Header hygiene:** strips the app's `authorization`, identity and public markers, cookies, hop-by-hop and forwarding headers (`:8-29`, `:318-322`), then injects `Bearer <key>` (`:125-127`).
- **Upstream failure** logs only the message, never the request, which carries the key (`:158-174`). The upstream request carries `request.signal` (`:153`), so a client abort cancels upstream.

### 1.4 Usage today: tokens in a log line

- `tapUsage` passes the body through and keeps the last 16 KB. On `flush` it regexes token fields (`apps/every-app-gateway/src/server/ai-usage.ts:11-34`, `:40-59`).
- `logUsage` emits `ai.proxy.usage` with provider, org, app, route, model, status, `x-request-id` and `{input, output, total}` (`ai-proxy.ts:176-190`). Nothing is stored. There's no cost, no feature label, and **no user id on the usage line**. The user id is logged once at request time, in a separate `ai.proxy.request` line (`app-gateway-entrypoint.ts:122-131`).
- **User attribution:** the app may forward the 120-second identity JWT it received (`IDENTITY_TTL_SECONDS = 120`, `packages/sdk/src/internal/protocol.ts:22-23`). The gateway verifies audience, issuer and org; if anything fails it falls back silently to app attribution (`app-gateway-entrypoint.ts:230-260`). The JWT carries `chan`, `act`, `scopes` and, on MCP tool calls, `tc` (`protocol.ts:79-84`), which can link spend to the `mcp_tool_calls` audit row (`apps/every-app-gateway/src/db/mcp.schema.ts:144-189`).

Defects that matter for billing:

1. **Metering can be bypassed.** OpenAI chat completions report usage in a stream only when the app sets `stream_options.include_usage` (see the module comment, `ai-usage.ts:4-6`). An app that leaves it out runs unmetered.
2. **Aborted streams are lost.** `onDone` runs only in `flush()` (`ai-usage.ts:54-56`), so a client that stops reading produces no usage line. OpenRouter still bills the tokens generated so far.
3. **Tail-only scanning misses head-reported usage.** Anthropic sends `input_tokens` in `message_start` at the head of the stream; the final `message_delta` carries only cumulative `output_tokens` (platform.claude.com streaming docs). DataForSEO puts its top-level `cost` near the head of the JSON envelope.
4. **Cached tokens are dropped.** `USAGE_FIELDS` ignores `cached_tokens` (`ai-usage.ts:13-19`), so pricing from a price table would overcharge prompt-cached calls.

### 1.5 SDK: `createGatewayFetch` (`packages/sdk/src/server/gatewayFetch.ts`)

- Rewrites the target to `http://every-app-gateway.internal<path>` on the binding, drops `authorization`, and forwards the inbound identity header (`:48-65`).
- `request` is required (`:17-21`). That doesn't fit Durable Objects, Workflows or crons, where nobody's request is in flight.
- The dev fallback is OpenAI-only: `OPENAI_API_KEY` from `.dev.vars` when `EVERYAPP_DEV` is set (`:32-35`, `:67-70`, `:90-111`).
- Today's only consumer is Chef: `providers: ["openai"]` (`apps/chef/everyapp.config.ts`), with `baseURL: "https://every-app-gateway.invalid/api/ai/openai/v1"` and `fetch: createGatewayFetch({ env, request })` (`apps/chef/src/routes/api/chat.ts:162-166`).
- Tests: `gatewayFetch.test.ts` covers binding preference, dev fallback, production-shape refusal, streaming bodies and abort. `app-gateway-entrypoint.test.ts` (310 lines) covers the props/registry matrix, provider allowlist, key injection, and JWT attribution with fallback. `ai-proxy.test.ts` (367 lines) covers route lockdown, operator ceiling, `store:false`, the model allowlist, failure logging, and the usage log line, asserting the prompt never appears (`:343-366`).

### 1.6 The GitHub POC (`poc/github-integration`, PR #281, not on `main`)

`git diff $(git merge-base main poc/github-integration) poc/github-integration --stat`:
37 files, +5,989.

| Piece | Path (on the branch) | Reuse for the broker |
|---|---|---|
| Path dispatch | `app-gateway-entrypoint.ts`: an `/api/integrations/` prefix skips the provider check and calls `handleIntegrationRequest` after the same caller check | Becomes the generic "pack lookup by provider id" |
| Manifest `integrations.github: { as: "org", access, permissions, background, why }` | `packages/perimeter/src/manifest/manifest.ts` (+55) | Becomes the per-pack request schema |
| Grant table | `apps/every-app-gateway/src/db/integrations.schema.ts:88-115`, `drizzle/0033_integrations.sql` | `app_integration_grants(org, app_slug, provider, request JSON, approved JSON, status, requested_at, decided_by, decided_at)`. Generalize it as-is |
| Grant math | `src/server/integrations/grants.ts` | `covers()`, `effectiveGrant(request, approved)` (request ∩ approval), `statusForRequest()` (narrower applies at once, broader goes back to pending, an identical re-request stays denied). Reuse as a generic function over pack-defined "dimensions" |
| Recording requests at deploy | `AppRegistrationService.markDeployed` calls `IntegrationService.syncAppRequests`; `AppRepository.tombstone` deletes grants | Same hook for every capability |
| Proxy flow | `src/server/integrations/proxy.ts:119-301` | Ordered checks: declared → approved → person present unless `background` → method allowed by access (read-only agents: `chan:"mcp"` without `mcp:write`) → URL pinned to the provider origin (`:184-191`), `redirect: "manual"` → token minted and cached → `set-cookie` stripped (`:294-296`) → `integration.call` log line. That's the broker pipeline minus metering |
| Encryption | `src/server/integrations/crypto.ts` | Per-org HKDF from `BETTER_AUTH_SECRET`, AES-GCM with the org id as AAD. The file itself says to replace it with envelope encryption |
| SDK | `packages/sdk/src/server/integrationFetch.ts` | Takes the **real provider URL** and refuses other origins (`:73-79`). `request` is optional (`:26-33`). Dev token comes from `.dev.vars`. A better ergonomic base than Chef's fake `.invalid` baseURL |

### 1.7 Where the prior design docs disagree with code or with Cloudflare

- `docs/architecture-v2-overview.md:46-55` and `:148-150` put "LLM key injection" and "per-app spend metering" in a WfP **outbound Worker**. That doesn't hold up:
  - Outbound Workers "do not intercept fetch requests made from Durable Objects" (WfP outbound-workers doc, updated 2026-04-21). OpenSEO's agent runs in a DO (`open-seo/src/server/features/sam/SamChatAgent.ts`).
  - The outbound Worker knows the caller only from parameters the dispatcher passes per `DISPATCHER.get()`, so crons and other non-dispatched invocations carry no context.
  - Key injection already lives in `AppGateway`, which is authenticated by props.
  
  Keep outbound Workers as a deny-by-default **egress firewall** for org apps, not as the broker.
- ADR-0001 §5 (`adr/ADR-0001-hosted-vs-self-hosted-topology.md:30-33`) says hosted uses one platform-owned provider key. Correct, but the shared key makes the route lockdown in `ai-proxy.ts:31-49` a **cross-tenant** control in hosted. Today it only separates apps of one owner. In hosted, `AI_PROXY_EXTRA_ROUTES` must be ignored (gap G8).
- ADR-0001 §6 says hosted app Workers are single-tenant per org. OpenSEO is multi-tenant: one Worker, Autumn customers keyed by org (`open-seo/src/server/billing/subscription.ts:34`). It also needs Workflows, which Cloudflare's Workflows limits page (updated 2026-09-21) says "cannot be deployed to Workers for Platforms namespaces". The WfP bindings page (updated 2026-09-16) lists Workflows as a binding user Workers can have, which contradicts that. If the Workflows page is right, catalog apps like OpenSEO run as regular Workers in the platform account, and one Worker serves many orgs. Static props then identify the app but not the org (gap G11).
- `TODO.md:36-37` lists "AI Gateway routing" and "Metered billing at the gateway (deferred)". On AI Gateway: its spend limits are "a best-effort estimation", "eventually consistent", capped at 20 rules per gateway and 5 metadata entries per request, and Unified Billing is capped at 200 requests per 60 s per gateway (AI Gateway spend-limits and limits docs, updated 2026-09-30 and 2026-09-24). It can't serve as the ledger or the per-org limiter. At most it's an optional upstream hop for logs and caching.

### 1.8 OpenSEO, the first app whose billing moves to the gateway

Read at `/Users/bensenescu/workspaces/open-seo` (`847c8854`):

- **DataForSEO, reserve then settle.** `meter(customer, fetcher, estimateRawUsd, defaultFeature)` (`src/server/lib/dataforseo/client.ts:80-93`) wraps every endpoint. `meterDataforseoCalls` holds credits (`reserveUsageCredits`), runs the call, reads `billing.costUsd` from the envelope, and settles (`client.ts:296-394`). Holds are `autumn.check({ lock: { lockId, expiresAt } })` with a 30-minute TTL (`subscription.ts:209-298`); settlement is `autumn.balances.finalize({ action: "confirm", overrideValue })` (`subscription.ts:436-470`). Cost comes from DataForSEO's `cost` field (`src/server/lib/dataforseo/envelope.ts:53-59`). Estimates live in `pricing.ts`.
- **LLM (SAM over OpenRouter), postpaid.** Before each turn, `checkUsageCreditsDepleted` gates the turn (`SamChatAgent.ts:336-349`). Each step's cost, `providerMetadata.openrouter.usage.cost` (`src/server/lib/chatAgent.ts:26-36`), is summed and billed in chunks with `trackUsageCreditSpend` (`SamChatAgent.ts:398-446`, `subscription.ts:560-620`). It's chunked because a DO killed mid-turn once leaked about $160/day of unbilled spend (`SamChatAgent.ts:139-146`).
- **One pricing formula.** Credits = ceil(rawUsd × 1.28 × 1000) (`src/shared/billing.ts:17-18`, `:57-70`). The same markup applies to LLM spend through `applyBillingMarkupUsd`.
- **Feature labels.** `CreditFeature` = keyword_research | domain_overview | backlinks | site_audit | rank_tracking | ai_citations | ai_prompt_responses | local_seo | agent (`src/shared/billing-credit-features.ts:1-26`), derived from the DataForSEO path or passed per call.
- **Paid calls come from background contexts:** the SAM Durable Object, `RankCheckWorkflow`/`SiteAuditWorkflow` (`src/server/workflows/`), and a `scheduled` handler in `src/server.ts`. It also calls DataForSEO **task** endpoints (`task_post`, then `task_get/{id}`: `src/server/lib/dataforseo/business.ts:204-276`) and the free account endpoint `/v3/appendix/user_data` (`appendix.ts:30-43`).

---

## 2. What the hosted tier needs from the broker

| # | Requirement | Why (anchor) |
|---|---|---|
| R1 | Declare capabilities in the manifest per provider (AI, integration, metered API), each with provider-specific narrowing | Generalizes `providers` + `ai` (`manifest.ts:173-178`) and the POC's `integrations` |
| R2 | A grant per (org, app, provider) with an approval state, a source (catalog, admin, deployer) and limits | The founder: "the gateway authorizes the app's access to certain secrets when the app is created"; "usage limits per app" |
| R3 | Every call checked: caller, grant, route policy, model, method, and credit pre-check where needed | Today: caller + `providers` + routes (`app-gateway-entrypoint.ts:89-120`, `ai-proxy.ts:108-146`) |
| R4 | Secret injected by a pack; the app never sees it | Today OpenAI only (`ai-proxy.ts:127`); POC GitHub tokens (`proxy.ts:258-263`) |
| R5 | Metering per org/app/user with a raw USD cost, a cost source, a feature label and a model | Founder: "meters any usage at the app level"; OpenSEO billing moves to the gateway |
| R6 | Metering that apps can't bypass: forced usage reporting, aborted-stream handling, idempotent ledger writes | Defects 1–2 in §1.4 |
| R7 | Cross-tenant safety on shared platform accounts (OpenAI files/batches, OpenRouter account endpoints, DataForSEO task lists) | `ai-proxy.ts:31-38` reasoning, now applied across tenants |
| R8 | Reachable from org apps on WfP **and** catalog apps, including DOs, Workflows and crons | OpenSEO's paid calls (§1.8) |
| R9 | Same code in self-host: a no-op billing port, the operator's own keys, auto-approval for admin deployers | ADR-0001 "policy-driven, not forked"; `GATEWAY_DEPLOYMENT_MODE` exists (`env.d.ts:18`, `deploy-token-auth.ts:55`) |
| R10 | Local dev: a direct-to-provider fallback with the developer's own keys, per provider | `gatewayFetch.ts:32-35`, POC `EVERYAPP_DEV_GITHUB_TOKEN` |

---

## 3. Proposed design

### 3.1 Vocabulary

- **Provider pack:** gateway code describing one upstream (`openai`, `openrouter`, `anthropic`, `dataforseo`, `github`, …).
- **Capability request:** the app's manifest entry for a pack.
- **Grant:** the approved form of a request, plus limits, per (org, app, provider).
- **Usage event:** one ledger row per billable upstream call, or per app-reported meter.
- **Billing port:** reserve/settle/track behind an interface. Self-host: no-op. Hosted: Autumn behind a per-org wallet DO.

### 3.2 Manifest shape

Replace `providers` + `ai` with one map keyed by pack id. Each pack owns the
zod schema for its entry, so the perimeter package's schema becomes
`z.record(ProviderNameSchema, z.unknown())` and each pack validates its
own entry. No backcompat (prototype rule).

```ts
// everyapp.config.ts
capabilities: {
  openrouter: { models: ["openai/gpt-5.6-luna", "minimax/minimax-m3"], why: "SAM agent" },
  dataforseo: { apis: ["serp", "dataforseo_labs", "backlinks", "business_data"], why: "SEO data" },
  github:     { as: "org", access: "read", permissions: ["contents", "metadata"], why: "Repo stats" },
},
// Feature labels the app may send; shown on usage and billing pages.
meters: {
  keyword_research: "Keyword research",
  agent: "SAM agent",
},
```

- `meters` copies the `scopes` record shape (`manifest.ts:57-76`). The id pattern `^[a-z0-9][a-z0-9:_-]{0,63}$` is reused. An undeclared label is recorded but flagged, so it doesn't break the call.
- Strict and tolerant schemas stay as today (`manifest.ts:29-33`, `:247-252`).

### 3.3 Provider packs

```ts
interface ProviderPack<Req> {
  id: string;                                  // "openrouter"
  kind: "ai" | "integration" | "metered_api";
  requestSchema: z.ZodType<Req>;               // manifest entry
  origin: string;                              // "https://openrouter.ai"; the upstream URL must stay on it
  upstreamPath(appPath: string): string | null;// "/v1/chat/completions" -> "/api/v1/chat/completions"
  credential(ctx): Promise<Credential>;        // platform secret | per-org key | minted token
  inject(headers: Headers, cred: Credential): void; // Bearer, Basic, x-api-key…
  allow(method, path, grant: EffectiveGrant): Decision;          // route policy
  rewriteBody?(path, body, ctx): object;       // store:false, stream_options.include_usage, user
  model?(path, body): string | null;
  cost: CostParser;                            // see below
  metering: "postpaid" | "hold";               // LLMs postpaid; DataForSEO holds
  estimateUsd?(req, appHint?: number): number; // hold size (app hint clamped)
  hazards?: { recordRefs?(resp): string[]; ownsRef?(path): string | null }; // task-id ownership
}

type CostParser =
  | { from: "tail"; parse(tail: string): Usage }          // OpenRouter usage.cost; OpenAI tokens
  | { from: "head+tail"; parse(head: string, tail: string): Usage } // Anthropic
  | { from: "head"; parse(head: string): Usage }          // DataForSEO top-level cost
  | { from: "none" };                                     // GitHub (count calls only)
interface Usage { costUsd?: number; costSource: "provider" | "price_table" | "none";
                  tokens?: { input; cachedInput; output; reasoning }; units?: number; ref?: string }
```

The first five packs:

| Pack | Upstream and auth | Route policy (what the shared account forces) | Cost |
|---|---|---|---|
| `openai` | `https://api.openai.com`, `Bearer OPENAI_API_KEY` | Today's `INFERENCE_ROUTES`, POST only (`ai-proxy.ts:39-49`). Extra routes only on self-host via `AI_PROXY_EXTRA_ROUTES`; **ignored when `GATEWAY_DEPLOYMENT_MODE=hosted`**. Force `store:false` and, for streamed chat completions, `stream_options.include_usage: true` | Tokens (input, cached, output, reasoning) from the tail × a versioned price table in gateway code. `costSource: "price_table"` |
| `openrouter` | `https://openrouter.ai/api`, `Bearer OPENROUTER_API_KEY` (later a per-org sub-key) | Allow POST `/v1/chat/completions`, `/v1/responses` and other inference paths confirmed against OpenRouter's reference; GET `/v1/models`. **Deny** `/v1/credits`, `/v1/key`, `/v1/keys*` (account and key management) and `/v1/generation` (looks up any generation on the platform account by id) | `usage.cost` is "always included automatically in every response", in the last SSE message for streams. `costSource: "provider"`. The generation id (`gen-…`) is kept as `ref` for reconciliation through `GET /api/v1/generation?id=`, which returns `total_cost` "in USD" |
| `anthropic` | `https://api.anthropic.com`, `x-api-key` + `anthropic-version` | POST `/v1/messages`, `/v1/messages/count_tokens` | `input_tokens` and cache tokens from the `message_start` head, cumulative `output_tokens` from the last `message_delta` tail, × price table |
| `dataforseo` | `https://api.dataforseo.com`, `Basic base64(login:password)` | Allow the manifest's `apis` modules (path segment after `/v3/`). **Deny** `tasks_ready`, `id_list` and `/v3/appendix/user_data`, which expose the whole platform account's tasks, balance and price list. Allow `task_get/{id}` only for ids this org/app received from its own `task_post` (`hazards.recordRefs`/`ownsRef`) | Top-level `cost` ("total tasks cost, USD"), parsed from the head (bounded buffer). `metering: "hold"`. The estimate is an app hint clamped by pack bounds, replacing OpenSEO's `pricing.ts` holds |
| `github` | Installation token minted per org account (POC `proxy.ts:211-239`) | POC rules: host pin, read/write by method, read-only agents, `redirect: "manual"`, `set-cookie` stripped | `from: "none"`. Calls are counted for audit, not billed |

### 3.4 Grants: where they live and who approves

**Table** (gateway D1; the migration follows `0032` and whatever the CLI
PRs add). It generalizes the POC table, with the same unique key
(org, app_slug, provider):

```
app_grants(
  id, organization_id, app_slug, provider,
  request    JSON   -- the live manifest entry
  approved   JSON   -- last approved entry, or null
  status     'pending' | 'approved' | 'denied' | 'revoked'
  source     'catalog' | 'admin' | 'deployer'
  limits     JSON   -- { monthlyUsd?, perUserMonthlyUsd?, ratePerMin? }
  requested_at, decided_by, decided_at
)
```

- `effectiveGrant` and `statusForRequest` come over from `grants.ts`. Each pack supplies a "covers" function for its own dimensions: models for AI, `apis` for DataForSEO, permissions and access for GitHub.
- **Catalog apps:** an implicit grant. The reviewed catalog manifest is the approval, so no row exists unless an admin overrides (disable a provider, set a cap). This matches "users sign up … and can then use all of the apps" with no approval screen per app. Usage still bills the org's credits.
- **Org apps:** `markDeployed` (`AppRegistrationService.ts:562-579`) records pending rows, as the POC does. The deploy succeeds, and calls fail with 403 `capability_not_approved` plus a link (POC `proxy.ts:150-161`). An admin who deploys can approve inline (integration design, decision 3).
- **Self-host:** same tables. AI providers auto-approve when the deployer is an admin, which keeps today's "`providers: ["openai"]` just works".
- **Check per call:** a per-isolate cache like `callerCache` (`app-gateway-entrypoint.ts:55-58`). Revocation then lags at most about 30 s, inside the existing 120 s identity window.

### 3.5 The call pipeline

```
App (fetch over EVERY_APP_GATEWAY)
  │  /v1/<provider>/<upstream path>     headers: x-everyapp-feature, x-everyapp-on-behalf-of?,
  │                                              x-everyapp-org? (catalog only), x-everyapp-estimate-usd?
  ▼
AppGateway.fetch
  1 caller      props → registry, active, all three ids match            (exists)
  2 tenant      org = props.organizationId; for catalog apps: identity JWT org_id,
                else x-everyapp-org if the org has the app installed      (new, G11)
  3 attribution verified JWT (≤120 s) | asserted on-behalf-of (member check) | app
  4 pack        lookup by provider id; 404 if unknown
  5 grant       effectiveGrant(request, approved) or implicit catalog grant; 403 if none
  6 policy      pack.allow(method, path, grant); model allowlist; hazards.ownsRef
  7 limits      per-app/user caps from grant.limits (ledger sums, cached)
  8 pre-check   billing.reserve(org, estimate) for hold packs; balance > 0 for postpaid
  9 forward     strip app auth/identity/cookies/x-everyapp-*; pack.inject; redirect: manual
 10 tap         head buffer (≤8 KB) + tail buffer (16 KB) through a TransformStream
 11 settle      on flush: pack.cost → usage event → ctx.waitUntil(ledger write; billing.settle)
                on abort: event with costSource "pending" and ref → reconcile job
```

Steps 1, 4–6, 9 and part of 10 exist in `ai-proxy.ts` and the POC proxy.
`ctx.waitUntil` has to be threaded from `AppGateway` (`server.ts:156-163`)
into the handler, because a D1 write in `flush()` can outlive the
response.

### 3.6 Metering

**Ledger row (`usage_events`)**: id (ULID), created_at, organization_id,
app_slug, user_id, attribution (`verified` | `asserted` | `agent` | `app`),
tool_call_id (from the JWT `tc` claim), provider, feature, model, route,
status, tokens JSON, units, cost_usd (raw, **before markup**), cost_source,
price_version, ref (generation or task id), hold_id, billed_at.
`mcp_tool_calls` (`mcp.schema.ts:144-189`) is the precedent: no foreign
keys, indexes on org and time, pruned by the hourly cron
(`server.ts:269-275`).

**Two-phase hook:**

- *Sync pre-check (step 8).* `BillingPort.reserve({ org, app, feature, estimateUsd })`. Hosted implementation: a per-org `OrgWallet` Durable Object. It's single-threaded, so concurrent holds can't overdraw. It keeps a balance mirrored from Autumn, the open holds, and the per-app and per-user month-to-date totals for caps. It flushes deductions to Autumn in batches. That moves OpenSEO's lock and finalize dance (`subscription.ts:240-298`, `:436-470`) out of every app. Postpaid packs only check `balance > 0`, which is SAM's rule (`SamChatAgent.ts:336-349`).
- *Async post-call (step 11).* `BillingPort.settle(hold, costUsd)` for hold packs, `track(costUsd)` for postpaid. Both are idempotent on the usage event id. Markup comes from config per provider (OpenSEO: 1.28×, `billing.ts:18`), so the ledger stays in provider dollars.
- *Self-host:* `NoopBillingPort`. The ledger still records usage, which gives the "AI usage by app" admin page for free.

**What the first PR does:** none of the two-phase hook. It adds `costUsd`,
`costSource`, `feature`, `userId`, `attribution` and `ref` to the existing
`ai.proxy.usage` log line. The line has the ledger row's shape, so PR 2
only adds the writer.

### 3.7 Binding and RPC shape

**Recommendation: keep `fetch()` for all proxied traffic and add RPC methods only where no upstream request exists.**

- Every provider SDK (OpenAI, `@openrouter/ai-sdk-provider`, Anthropic, Octokit) accepts a `fetch`, and the body must stream both ways. Workers RPC can carry `Request`, `Response` and byte streams (workers/runtime-apis/rpc). So `gateway.ai.fetch(req)` is possible, but it would wrap the same `Request` in another call shape and buy nothing. Dispatching on a provider id in the path is the same as dispatching on a method name.
- Unify the path to `/v1/<provider>/<upstream path>`. Provider ids are unique, so `/api/ai/…` versus `/api/integrations/…` (POC) is an unneeded split.
- **RPC methods on `AppGateway`.** These share `this.ctx.props` and the step 1–3 checks:
  - `meter({ feature, units?, costUsd?, ref?, onBehalfOf? })`: app-defined usage with no upstream call.
  - `reserve({ feature, estimateUsd })` and `settle(holdId, { costUsd })`: for an app that wraps several calls in one hold, such as a rank-check batch.
  - `capabilities()`: the app's effective grants and their status, so an app can render "ask your admin to approve OpenRouter".
  
  Flat methods keep the stub typed without `RpcTarget` getters. The SDK groups them (`gateway(env).billing.reserve(...)`).
- **SDK:** one `brokerFetch({ env, provider, request?, feature?, onBehalfOf? })`. It takes real provider URLs (POC `integrationFetch` style), refuses other origins, and has a per-provider dev fallback (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `EVERYAPP_DEV_<PROVIDER>_*` in `.dev.vars`). It replaces `createGatewayFetch` and `integrationFetch`. `request` is optional, for DOs, Workflows and crons.

### 3.8 How a WfP user Worker reaches the broker

| Option | Status (docs, 2026-10-15) | Serves DO/Workflow/cron? | User attribution | Notes |
|---|---|---|---|---|
| **A. Static service binding with `props`** (what `everyAppWorker()` builds) | **Unconfirmed.** The WfP bindings page (updated 2026-09-16) lists storage, queues, workflows, containers, VPC and analytics, but not service bindings, and points to dispatch props "to provide a request-scoped platform capability". The OpenAPI schema for `PUT …/dispatch/namespaces/{ns}/scripts/{name}` has a `service` binding with `service`, `environment` and `entrypoint`, but **no `props`**; the same is true of the regular script and versions uploads. The cf config docs do document `props` on worker bindings. | Yes (it's in `env`) | JWT forwarding (≤120 s) or asserted | The path we have. Spike: upload a namespace script with `{type:"service", service:"every-app-gateway", entrypoint:"AppGateway", props:{…}}` and check that `ctx.props` arrives |
| **B. Dispatch-props capability** | **Documented.** The dispatcher does `ctx.exports.AppGateway({ props })` and passes it in `DISPATCHER.get(name, { props: { EVERY_APP_GATEWAY: stub } })`; the user Worker reads `this.ctx.props.EVERY_APP_GATEWAY`. "Valid only during the request that received it." | **No** | **Verified per request:** the dispatcher already authenticated the session, so it can bake `userId` into the stub props with no JWT needed | The gateway compat date is `2025-09-02` (`cloudflare.config.ts:97`); `ctx.exports` is default only from `2025-11-17`, so add `enable_ctx_exports` or bump the date |
| **C. Public HTTPS + per-app broker token** | Always works | Yes | Asserted or app | Uses the existing `app_tokens` table (`apps.schema.ts:127+`). The app holds a broker credential, not a provider secret, so a leak exposes only that app's grants and can be revoked. Use it only if A fails |
| D. Outbound Worker | Doesn't see DO fetches; only knows dispatcher-passed params | No | Dispatcher params | Egress firewall only (§1.7) |

**Recommendation:** run the A spike first, half a day. If A works, it's the
transport, and B is an add-on that gives verified per-request user ids for
user-initiated work. If A fails, use B for request work and C for
background. Whichever wins, the hosted deploy API builds the binding
server-side from the registry row and refuses any tenant `worker` or
`service` binding (gap G10). The SDK hides which transport it got:
`brokerFetch` checks `ctx.props.EVERY_APP_GATEWAY` first, then
`env.EVERY_APP_GATEWAY`.

### 3.9 Multi-tenant catalog apps (OpenSEO)

`props.organizationId` (`worker.ts:315-319`) assumes one Worker per org.
For a catalog app that serves every org from one Worker:

- Props become `{ appId, workerName, trust: "catalog" }` with no org.
- Per call, the org comes from the verified identity JWT's `org_id` when one is forwarded. Otherwise it comes from `x-everyapp-org`, which is honored only for `trust: "catalog"` callers and only for an org with the app installed (an implicit grant row, or no denial).
- This trusts our own code to name the org in background work. The ledger records `org_source: "jwt" | "asserted"` so it can be audited.

---

## 4. Gaps and the smallest change that closes each

| # | Gap | Where | Smallest fix | Days |
|---|---|---|---|---|
| G1 | OpenAI only; provider hardcoded | `ai-proxy.ts:6-7`, `:94-100`, `:279-300` | A `PACKS` table with `openai` and `openrouter`: origin, path map, secret name, inference routes, body rewrite | 1 |
| G2 | No cost figure | `ai-usage.ts:13-34` | Per-pack cost parsers: OpenRouter `"cost"` from the tail; OpenAI price table with cached tokens; Anthropic head+tail; DataForSEO head | 1.5 |
| G3 | Usage only logged; no user id on the usage line; nothing stored | `ai-proxy.ts:176-190`, `app-gateway-entrypoint.ts:122-131` | Pass `userId` and attribution into `caller`. Add a `usage_events` table, written via `ctx.waitUntil` threaded from `server.ts:156-163` | 1 |
| G4 | No feature label | none | `x-everyapp-feature` header (validated with the `ScopeIdSchema` regex, stripped before upstream); manifest `meters` | 0.5 |
| G5 | Grants are the self-asserted `providers` list | `manifest.ts:173-174`, `app-gateway-entrypoint.ts:114-120` | Generalize POC `app_integration_grants` into `app_grants` + `syncAppRequests` in `markDeployed`; implicit catalog grants; Admin → Apps approval UI (POC `routes/admin/integrations.tsx`) | 3 |
| G6 | Metering can be bypassed | `ai-proxy.ts:267-270`, `ai-usage.ts:54-56` | Force `stream_options.include_usage` on streamed chat completions; on abort, write a `pending` event with the generation id and reconcile via OpenRouter `/generation` | 1 |
| G7 | No credit pre-check or holds | none | `BillingPort`; `OrgWallet` DO with Autumn check/track/finalize; `NoopBillingPort` for self-host | 3 |
| G8 | Cross-tenant hazards on shared platform accounts | `ai-proxy.ts:54-62`, `:193-220` | In hosted mode, ignore `AI_PROXY_EXTRA_ROUTES`; OpenRouter denies `/credits`, `/key(s)`, `/generation`; DataForSEO denies `tasks_ready`, `id_list`, `user_data`; task-id ownership table | 1.5 |
| G9 | WfP reachability unverified | `worker.ts:311-320`; WfP docs | Spike option A; if it fails, B (`enable_ctx_exports` + stub in `DISPATCHER.get`) plus C (broker token) | 0.5 + 2 |
| G10 | The hosted deploy must own the gateway binding | `policy.ts:127-137` checks only name, worker and export | The hosted deploy API drops tenant `worker`/`service` bindings and injects `{service, entrypoint, props}` from the registry row | 0.5 |
| G11 | A multi-tenant catalog app can't name the org in static props | `worker.ts:315-319`, ADR-0001 §6 | `trust: "catalog"` props; org from the JWT or `x-everyapp-org` checked against installs | 2 |
| G12 | User attribution ends after 120 s (DO turns, Workflows) | `protocol.ts:22-23`, `app-gateway-entrypoint.ts:230-260` | `x-everyapp-on-behalf-of` (membership-checked, recorded as `asserted`); verified ids from option B props | 1 |
| G13 | Two SDK fetches; `request` required; OpenAI-only dev fallback | `gatewayFetch.ts:17-21`, `:90-111`; POC `integrationFetch.ts` | One `brokerFetch` with real URLs, optional `request`, per-provider dev keys | 1 |
| G14 | One shared OpenRouter key: no per-org hard ceiling if metering fails | none | OpenRouter management key creates per-org keys with `limit` and `limit_reset`; store them encrypted (POC `crypto.ts`, moved to envelope encryption) | 2 |
| G15 | No per-org fairness on shared upstream rate limits | none | Rate-limit by (org, provider) using `rate_limit_counters` (`drizzle/0031_rate_limit_counters.sql`) or the Workers rate-limit binding | 1 |
| G16 | The GitHub POC is off `main` with its own prefix and table | branch `poc/github-integration` | Rebase it as the `github` pack on `app_grants` and `usage_events` | 2 |

### Reusable as-is, refactor, new

- **As-is:** `parseCallerProps` and `resolveCallerApp` (caller check and cache); `resolveAttribution`; the header strip list; `isSafeUpstreamPath`; streaming body handling (`duplex: "half"`, `signal`); the `tapUsage` TransformStream skeleton; the POC's `grants.ts` math and `statusForRequest`; the `markDeployed` hook; the POC SDK origin check; `logEvent`'s redaction (`packages/perimeter/src/log.ts:46-57`); the `mcp_tool_calls` retention pattern.
- **Refactor:** `ai-proxy.ts` into a generic proxy plus packs; `ai-usage.ts` into head and tail taps with pack parsers; manifest `providers` + `ai` + `integrations` into `capabilities`; `createGatewayFetch` + `integrationFetch` into `brokerFetch`; `AppCallerProps` gains `trust`; `handleAppGatewayRequest` gains `waitUntil` and `billing` deps.
- **New:** `app_grants`, `usage_events`, `broker_refs` (task ids), the `OrgWallet` DO, `BillingPort`, the RPC methods `meter`/`reserve`/`settle`/`capabilities`, the hosted deploy-API binding injection, and the admin usage and approval pages.

---

## 5. The smallest PR: OpenRouter end to end with metering logged (not billed)

**Goal:** a deployed app with `providers: ["openrouter"]` calls OpenRouter
through `EVERY_APP_GATEWAY`. The gateway injects `OPENROUTER_API_KEY`,
enforces routes and `ai.models`, and emits one `ai.proxy.usage` line with
`costUsd`, `feature`, `userId` and `attribution`. No migration, no
manifest schema change (`providers` already accepts any kebab id,
`manifest.ts:110-122`), and no billing.

| File | Change |
|---|---|
| `apps/every-app-gateway/src/server/ai-proxy.ts` | Replace the `OPENAI_*` constants with `PACKS: Record<"openai" \| "openrouter", { upstreamBase, secret, inferenceRoutes, deniedPrefixes?, rewrite? }>`. OpenRouter: base `https://openrouter.ai/api`, secret `OPENROUTER_API_KEY`, inference POST `/v1/chat/completions` and `/v1/responses` (more after checking OpenRouter's reference), no `store` rewrite. OpenAI keeps everything it has and adds `stream_options.include_usage` when `stream: true` on `/v1/chat/completions` (G6, one line in `prepareBody`). `AI_PROXY_EXTRA_ROUTES` applies to `openai` only and is ignored when `GATEWAY_DEPLOYMENT_MODE === "hosted"`. Add `x-everyapp-feature` to `STRIPPED_PROXY_HEADERS`. Extend `caller` with `userId?`, `attribution` and `feature?`, and log them with `costUsd`, `costSource` and `ref` |
| `apps/every-app-gateway/src/server/ai-usage.ts` | `extractUsage` also reads the last `"cost":<number>` (exact key, so `upstream_inference_cost` doesn't match), `cached_tokens`, `reasoning_tokens`, and a `"id":"gen-…"` ref; returns `{ input, output, total, cachedInput?, costUsd? }` |
| `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts` | Add `OPENROUTER_API_KEY` to `AppGatewayEnv` (`:19-24`). Validate the `x-everyapp-feature` header (`^[a-z0-9][a-z0-9:_-]{0,63}$`, otherwise drop it and warn). Pass `user?.id`, `attribution` and `feature` into `handleAuthenticatedAiProxyRequest` (`:133-140`) |
| `apps/every-app-gateway/src/env.d.ts`, `cloudflare.config.ts` `OPTIONAL_SECRETS`, `packages/cli/src/lib/gateway/secretsFile.ts` `SETTABLE_GATEWAY_SECRETS` | Declare `OPENROUTER_API_KEY` so `everyapp gateway secret set OPENROUTER_API_KEY` works and dev passes it through |
| `packages/sdk/src/server/gatewayFetch.ts` | `createGatewayFetch({ env, request?, provider = "openai", feature? })`. `request` becomes optional. `feature` sets `x-everyapp-feature`. Dev fallback by provider: `OPENROUTER_API_KEY` → `https://openrouter.ai/api` + the path after `/api/ai/openrouter` |
| `packages/sdk/src/env.d.ts` | Add `OPENROUTER_API_KEY?` (dev only) |
| Tests | `ai-proxy.test.ts`: OpenRouter URL mapping and key injection; 403 on `/v1/credits`, `/v1/keys` and `/v1/generation`; `ai.models` enforced; streamed and JSON usage lines carry `costUsd` and never the prompt; `include_usage` forced on OpenAI streams; extra routes ignored in hosted mode. `ai-usage.test.ts`: cost and ref extraction from a final OpenRouter SSE chunk. `app-gateway-entrypoint.test.ts`: `openrouter` refused unless listed; the usage line has `userId` when a JWT verifies; a bad feature is dropped. `gatewayFetch.test.ts`: feature header, optional request, OpenRouter dev fallback |

**Manual end-to-end check:**

1. `everyapp gateway secret set OPENROUTER_API_KEY`.
2. Add `"openrouter"` to Chef's `providers`, plus a route that uses `@openrouter/ai-sdk-provider` with `baseURL: "https://every-app-gateway.invalid/api/ai/openrouter/v1"` and `fetch: createGatewayFetch({ env, request, provider: "openrouter", feature: "chat" })`. The provider package documents `baseURL` and `fetch` options; check this when wiring it.
3. Deploy, chat once, and check the gateway's Workers Logs for `ai.proxy.usage` with `costUsd > 0`.

**Out of scope:** the ledger table, grants, billing, the `capabilities`
manifest key and the WfP transport.

**Size:** 1–1.5 engineer-days. The `secretsFile.ts` edit may conflict
with the CLI PRs in flight (#286-#293), so land it after them or keep it
to that one line.

### PR series after that (the long-term broker)

1. **Ledger.** `usage_events` table, written via `waitUntil`; hourly-cron retention; an Admin → Usage page listing by app, feature and user. (1.5 d)
2. **WfP transport spike** (option A), with fallback B/C if needed. Its result decides PR 6. (0.5–2.5 d)
3. **Packs and `capabilities` manifest.** Generic proxy; `openai`, `openrouter` and `anthropic` packs; `/v1/<provider>/…` path; `brokerFetch`; drop `providers`, `ai` and `createGatewayFetch` (no backcompat). (2.5 d)
4. **Grants.** `app_grants`, `syncAppRequests`, implicit catalog grants, approval UI, `capabilities()` RPC. (3 d)
5. **Billing port and wallet.** `OrgWallet` DO, Autumn reserve/settle/track, per-app and per-user caps, markup config, the `meter`/`reserve`/`settle` RPC methods. (3 d)
6. **Hosted transport.** Deploy-API binding injection (G10); catalog trust and org assertion (G11); dispatch-props user attribution (G12). (2–3 d)
7. **DataForSEO pack**, with task-ref ownership and head cost. OpenSEO drops `DATAFORSEO_*` and its Autumn calls and switches to `brokerFetch` with `feature`. (2.5 d)
8. **GitHub pack** rebased from the POC on grants and the ledger. (2 d)
9. **Hardening.** Per-org OpenRouter keys with limits (G14); per-org rate limits (G15); abort reconciliation (G6). (3 d)

---

## 6. Open questions for the founder

1. **In hosted, is OpenRouter the only AI vendor, or do apps also call OpenAI and Anthropic directly?**
   - *Why it matters:* OpenRouter reports cost per response. Direct vendors need price tables we keep current, plus head+tail stream parsing for Anthropic.
   - *Default:* OpenRouter only in hosted v1. `openai` and `anthropic` packs stay for self-host, where the operator's own key and the tokens-only log are enough.
2. **Do catalog apps get implicit grants, with no approval screen?**
   - *Why it matters:* it decides whether signing up gives "all the apps" at once, or whether every org admin clicks through capability consents first.
   - *Default:* implicit grants from the reviewed catalog manifest. Admins can disable a capability or cap it per app afterwards.
3. **Who approves an org app's paid capabilities, and can the deployer approve their own?**
   - *Why it matters:* org apps are untrusted code spending the org's credits and sending data to third parties.
   - *Default:* the deploy records pending grants; a deployer who is an org admin may approve inline (CLI prompt or deploy API flag); a non-admin deploy waits for an admin.
4. **One credit pool per org for all apps, or separate budgets per app?**
   - *Why it matters:* it shapes the Autumn model. OpenSEO today has a single `usage_credits` pool (`billing.ts:13-16`).
   - *Default:* one pool per org (Autumn customer = org), optional per-app monthly caps in `app_grants.limits`, and spend broken down by app and feature.
5. **What markup, and does it differ by provider?**
   - *Why it matters:* the ledger stores raw cost, so markup becomes billing config.
   - *Default:* 1.28× for all providers, matching OpenSEO (`billing.ts:18`, applied to both DataForSEO and LLM spend), configurable per provider.
6. **Overdraft policy at zero credits.**
   - *Why it matters:* LLM costs are unknown up front, so an in-flight call can overdraw.
   - *Default:* block new calls at a balance of 0 or less; let in-flight calls finish and overdraw (SAM's rule); hold estimates for DataForSEO.
7. **Do catalog apps run as one multi-tenant Worker each, or one Worker per org?**
   - *Why it matters:* it decides whether props can name the org, and whether OpenSEO's Workflows can run at all (the Workflows docs say WfP isn't supported).
   - *Default:* catalog apps are multi-tenant regular Workers, trusted to assert the org in background work. Org apps are single-tenant WfP user Workers.
8. **Are per-user limits a v1 requirement, or is per-user usage reporting enough?**
   - *Why it matters:* verified per-user attribution is only reliable for request-scoped calls (120 s JWT, or dispatch props). Enforcing per-user caps on background work needs asserted ids.
   - *Default:* report per user, enforce per app.
9. **Should agent (MCP) traffic be able to spend?**
   - *Why it matters:* a read-only MCP connection can still trigger paid DataForSEO or LLM calls through app tools.
   - *Default:* yes, attributed as `agent` with the tool call id. Add per-connection spend caps once the ledger exists.
10. **Who sees usage?**
    - *Why it matters:* per-user spend is sensitive inside an org.
    - *Default:* admins see everything; members see their own usage.

---

## 7. Load-bearing claims

| Claim | Source | If wrong |
|---|---|---|
| A WfP user Worker may carry a `service` binding, with `entrypoint` and `props`, to a regular Worker outside its namespace | Unconfirmed. The OpenAPI WfP upload schema has `service` with `entrypoint` and no `props`; the WfP bindings doc (2026-09-16) doesn't mention service bindings; cf config docs document `props` on worker bindings | Org apps need option B (request-scoped) plus C (broker token) for background work. Critical |
| Dispatch-props RPC stubs are valid only during the request that received them | WfP dynamic-dispatch doc ("Workers rejects the cross-request I/O") | If they were longer-lived, B alone could serve background work |
| `ctx.props` can only be set by someone who can deploy the receiving Worker, so tenants can't forge props when the platform builds the binding | workers/runtime-apis/context | The whole caller-identity model needs a signature. Critical |
| OpenRouter includes `usage.cost` in every response (final SSE chunk), and generation `total_cost` is USD | openrouter.ai/docs usage-accounting and get-a-generation pages | OpenRouter would need a price table too |
| Workflows cannot be deployed to WfP namespaces | Workflows limits doc (2026-09-21); contradicted by the WfP bindings doc (2026-09-16) | Catalog apps with Workflows could run in WfP per org, and multi-tenant catalog trust (G11) would be optional |
| Outbound Workers don't intercept DO fetches | WfP outbound-workers doc (2026-04-21) | An outbound Worker could be considered for injection |
| DataForSEO's top-level `cost` is "total tasks cost, USD" | docs.dataforseo.com/v3/appendix/errors | The DataForSEO pack needs a price table |
| AI Gateway spend limits are best-effort, 20 rules per gateway; Unified Billing is 200 req/60 s per gateway | AI Gateway spend-limits (2026-09-30) and limits (2026-09-24) docs | AI Gateway could take over limiting |
| Anthropic streams put `input_tokens` in `message_start` and cumulative `output_tokens` in `message_delta` | platform.claude.com streaming docs | A tail-only parser would do |
| OpenRouter management keys create keys with `limit` and `limit_reset` | openrouter.ai/docs provisioning-api-keys | G14 needs another backstop |

## 8. Sources (opened 2026-10-15)

- Cloudflare, Workers for Platforms bindings (updated 2026-09-16): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/
- Cloudflare, WfP dynamic dispatch, "Pass data and capabilities per request": https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/
- Cloudflare, WfP outbound Workers (updated 2026-04-21): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/
- Cloudflare, How WfP works (updated 2026-04-21): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/
- Cloudflare, WfP limits (updated 2026-10-13): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/
- Cloudflare API OpenAPI spec, `PUT /accounts/{account_id}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}`, `service` binding schema (queried through the Cloudflare API MCP search, 2026-10-15)
- Cloudflare, Multipart upload metadata (updated 2026-07-03): https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
- Cloudflare, Context: `ctx.props`, `ctx.exports` (updated 2026-10-12): https://developers.cloudflare.com/workers/runtime-apis/context/
- Cloudflare, Compatibility flags, `enable_ctx_exports` (default 2025-11-17): https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- Cloudflare, Workers RPC (streams, Request/Response, stub lifetime): https://developers.cloudflare.com/workers/runtime-apis/rpc/
- Cloudflare, Service bindings RPC (updated 2026-08-03): https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/
- Cloudflare, cf config `bindings.worker({ props })`: https://developers.cloudflare.com/cf/projects/cloudflare-config/
- Cloudflare, Workflows limits (updated 2026-09-21): https://developers.cloudflare.com/workflows/reference/limits/
- Cloudflare, AI Gateway spend limits (updated 2026-09-30): https://developers.cloudflare.com/ai-gateway/features/spend-limits/
- Cloudflare, AI Gateway limits (updated 2026-09-24): https://developers.cloudflare.com/ai-gateway/reference/limits/
- OpenRouter, usage accounting: https://openrouter.ai/docs/use-cases/usage-accounting
- OpenRouter, get a generation: https://openrouter.ai/docs/api-reference/get-a-generation
- OpenRouter, API limits and key limits: https://openrouter.ai/docs/api-reference/limits
- OpenRouter, provisioning API keys: https://openrouter.ai/docs/features/provisioning-api-keys
- DataForSEO, response structure and errors: https://docs.dataforseo.com/v3/appendix/errors/
- Anthropic, streaming messages: https://platform.claude.com/docs/en/build-with-claude/streaming
- Repo: `git show research/app-integrations:docs/research/2026-10-integrations-hub/app-integrations.md`; `…/raw/build-patterns.md` lines 22, 483-495, 851; branch `poc/github-integration` (commits `82de01fa`, `2905c34e`, `885a4a05`)
- OpenSEO checkout `/Users/bensenescu/workspaces/open-seo` at `847c8854`
