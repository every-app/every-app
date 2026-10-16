# Comparables: how other platforms solve what hosted Every App needs

Researched 2026-10-15. Scope: the founder's "like Cloudflare OS, but much easier" target, and what Cloudflare OS, Cloudflare VibeSDK, Val Town, Replit, Vercel, Supabase, Shopify, Slack (plus GitHub Apps), Zapier/Pipedream/Composio, OpenRouter and the ChatGPT/Claude app surfaces do about six things: per-app capability grants and the approval screens, usage metering and per-app budgets, secrets isolation, developer deploy flows, org/team models, and pricing.

Labels: **[live]** fetched today (URL in §6). **[code]** read in source at a named path. **[prior]** taken from the integrations research on branch `research/app-integrations` (fetched 2026-10-12), not re-fetched. **[inference]** my reasoning.

Integration brokering (Composio, Pipedream, Nango, WorkOS and others) already has a 763-line landscape report and a 728-line Composio report on that branch (`docs/research/2026-10-integrations-hub/raw/landscape-aggregators.md`, `raw/composio.md`). This report doesn't redo them. It takes from them only what changes once Every App is a **hosted, multi-tenant** service: who holds the vault, who pays, and what gets metered.

---

## 0. Summary

1. **"Cloudflare OS" is a real product.** It is Cloudflare's open-source (Apache-2.0) agent workspace. v2 was announced 2026-08-05, and a managed version opened a waitlist on 2026-10-01 with no price or date. Its model:
   - Each company runs its own instance.
   - Cloudflare Access controls who gets in.
   - Apps are per-user, agent-built "gadgets" in Dynamic Workers with outbound networking off.
   - "Gatekeeper" Workers hold credentials and hand out typed capability bindings.
   - Every inference goes through AI Gateway, which has budgets.
   - It isn't multi-tenant SaaS and has no billing of its own. One optional flow bills AI to the user's own Cloudflare account through OAuth.

   "Much easier" for Every App means: no Cloudflare account, no OAuth clients to set up, shared multi-user org apps instead of per-user gadget copies, and one `/mcp` for outside agents. Cloudflare OS consumes MCP but doesn't expose one [prior].
2. **The founder's broker is the industry's 2026 shape.** Vercel (Connect plus AI Gateway budgets), Replit (AI Integrations billed per app), Cloudflare OS (gatekeepers plus AI Gateway) and Shopify (App Pricing meters) each built one piece of "the app never holds the key, the platform meters per app". None does all of it for hosted internal apps.
3. **Cloudflare already ships the hosted version of Every App's caller-identity seam.** Since the 2026-09-16 docs, Workers for Platforms (WfP) lets the dispatch Worker pass an RPC capability stub to a user Worker through `props` (`ctx.exports.X({props})`). The design docs still assume an outbound Worker that injects keys (`docs/architecture-v2-recommendation.md:51`, `:73`). The capability stub fits the existing `AppGateway` entrypoint far better, and outbound Workers still don't see fetches from Durable Objects.
4. **Budgets should live in Every App's gateway, not in AI Gateway.** Vercel's stacked budgets are the template: team, project, key and user scopes, a default per scope, checked before each request, HTTP 402 `quota_for_entity_exceeded`. Cloudflare AI Gateway spend limits are capped at 20 rules per gateway and are eventually consistent, so they can't hold thousands of orgs × apps with custom caps.
5. **The biggest gap against comparables is self-approval.** Today the deployer's manifest *is* the grant (`app-gateway-entrypoint.ts:114`), and ToolBus trusts each app's own risk labels (`packages/toolbus/src/policy.ts:2`). Every comparable with third-party apps keeps the approved grant apart from the developer's request: Slack, GitHub Apps, Shopify, Claude connectors. Hosted catalog apps need that split.

---

## 1. What exists today (Every App, with file refs)

| Capability | Today | Where |
|---|---|---|
| Caller identity for the broker | Unforgeable service-binding `props` `{organizationId, appId, workerName}`, checked against the registry row (registered, active, same org/app/Worker) | `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts:13-17, 89-113`; props set at build in `packages/sdk/src/cloudflare/worker.ts:311-320` |
| Grant to use a provider | The manifest's `providers` list, written by whoever deploys. There is no approval record. | `app-gateway-entrypoint.ts:114-120`; schema `packages/perimeter/src/manifest/manifest.ts:117-122, 173-174` |
| Ceiling on a shared credential | Inference routes only. Extra routes need **both** the operator (`AI_PROXY_EXTRA_ROUTES`) and the manifest (`ai.routes`). There is a model allowlist (`ai.models`). | `apps/every-app-gateway/src/server/ai-proxy.ts:31-49, 132-146, 203-220`; `manifest.ts:136-148` |
| Providers | OpenAI only, one platform key shared by every app in every org | `ai-proxy.ts:94-100, 125-127` |
| User attribution | The app forwards the inbound 120 s identity JWT, and the gateway verifies it with `aud = appId` and a matching org | `packages/sdk/src/server/gatewayFetch.ts:48-65`; `app-gateway-entrypoint.ts:230-260` |
| Metering | Token usage is read off the tail of the response stream and **logged** (`ai.proxy.usage`). Nothing is priced, budgeted or billed. | `ai-proxy.ts:176-190`; `ai-usage.ts:1-59` |
| App-to-gateway transport in hosted | The `dispatch` tier throws "not supported yet" | `packages/perimeter/src/getAppFetcher.ts:52-56` |
| Tool risk | "An app's declared risk is trusted as the default (the app is the organization's own code)". Destructive tools are hidden; write tools are hidden from read-only callers. | `packages/toolbus/src/policy.ts:1-11, 30-37`; stored in `app_tools.risk`, `apps/every-app-gateway/src/db/mcp.schema.ts:55-56` |
| Audit | `mcp_tool_calls`: org, user, credential, app, tool, risk, decision, outcome, args digest | `mcp.schema.ts:144-190` |
| Orgs | Better Auth orgs, invite-only sign-up, `allowUserToCreateOrganization: false` | `apps/every-app-gateway/src/auth/config.ts:83-96, 315` |
| First real metered app | OpenSEO bills through Autumn: `check({lock})` holds, `balances.finalize`, `track`, a 1.28× markup on DataForSEO cost, and OpenRouter agent spend metered in $0.05 chunks | `/Users/bensenescu/workspaces/open-seo/src/shared/billing.ts:17-18, 50-58`; `src/server/billing/autumn.ts:58-72`; `src/server/features/sam/SamChatAgent.ts:57-64, 139-147` |
| Integrations design | Declare in the manifest → admin approves → call through the binding → gateway injects the token. Broader requests go pending; narrower ones apply at once. | `git show research/app-integrations:docs/research/2026-10-integrations-hub/app-integrations.md` (§"Granting and using", flow B) |

**Where the code or current Cloudflare contradicts the design docs:**

- **Risk labels.** `docs/architecture-v2-overview.md:88-91` and `:206-207` say tool risk is "operator-set, never app-supplied hints" and that the manifest "only *proposes*". The code trusts the app's label (`policy.ts:1-3`). That holds while every app is the org's own code. It stops holding once a hosted org installs a catalog app it didn't write.
- **Key injection.** `docs/architecture-v2-recommendation.md:26, 51, 73` plan "outbound worker + LLM gateway" key injection and `dispatcher.get(name, {}, {limits, outbound})`. Two facts cut against that:
  - Cloudflare's WfP docs (updated 2026-09-16) now recommend passing a **capability** (an RPC stub to a `WorkerEntrypoint` in the dispatch Worker) through `props` for "request-scoped platform capability" [live]. That is exactly what `AppGateway` already is.
  - Outbound Workers still "do not intercept fetch requests made from" Durable Objects (docs updated 2026-04-21) [live]. So key injection at the outbound Worker can't be the main path; it can only be a backstop egress allowlist.
- **Metering source.** The recommendation says "Metering via per-script GraphQL analytics + tags" (`:73`). That covers compute only. AI and provider spend must be metered at the broker, where the gateway already sees model, tokens and caller (`ai-proxy.ts:176-185`).
- **Why app-side metering isn't enough.** OpenSEO's own comment records that a September 2026 recovery loop "burned ~$160/day of OpenRouter spend that never reached onChatResponse" (`SamChatAgent.ts:143-145`). Metering inside the app, at the end of a turn, loses money when the isolate dies. Metering at the gateway, on the stream, doesn't.

---

## 2. What "Cloudflare OS" is in 2026

**It's a real product.** Facts [live unless marked]:

- **Repo.** `cloudflare/cloudflare-os`: Apache-2.0, 11,427 stars, last push 2026-10-16 (gh API).
- **Announcements.** The v2 launch post is dated 2026-08-05, authored by Phillip Jones and Dan Carter (blog.cloudflare.com/cloudflare-os). The README says "As of the August 2026 release, Cloudflare OS v2 is very capable, but still has many rough edges."
- **Managed version.** Announced as a waitlist on 2026-10-01 (blog.cloudflare.com/managed-cloudflare-os): "Just tell us what custom domain you want to use, what Cloudflare Access policies apply, and which AI Gateway to connect." The post gives no price, date or region list.
- **Positioning.** "Any organization can deploy it, connect it to internal systems, and make it their own." The README calls it "_Your Company_ OS".

### Its model

| Concern | Cloudflare OS |
|---|---|
| Apps | Each app ("gadget") is a full-stack program: "client code, server code, an API, and durable state". The README says "every user runs their own copy of the productivity apps they use". Apps are agent-built, "private by default, but can be shared like documents". |
| Isolation | Server code: "runs in a Dynamic Worker with global outbound networking disabled". Each app's Durable Object Facet "gives the app its own SQLite database". Client: a sandboxed iframe that talks to its server only over Cap'n Web RPC via `postMessage()`. |
| Capabilities | "Each agent, and each Gadget, by default has access to nothing." Access arrives as typed bindings: "`env.PROJECT` is a capability representing permission to use a specific resource under a specific policy." Humans introduce resources; agents can ask for introductions. |
| Credentials | Gatekeepers are per-service Workers that handle OAuth and hold the credential: "The credential remains completely isolated from the agent and any generated code." |
| Approvals | Gatekeepers "mediate anything with an externally visible side effect", e.g. "require approval before merging a pull request". The agent isn't blocked: the gatekeeper "will simulate the outcome locally", and approvals happen later, "in bulk, or one-by-one" (README). |
| Information flow | "Cloudflare OS records every resource agents observe … A read of sensitive data can prevent the agent from writing data to certain sources." |
| Identity | "Cloudflare Access controls who can enter Cloudflare OS." Inside the instance there is no org model; it's one company per instance. |
| AI and spend | "Every inference call runs through Cloudflare AI Gateway." "Administrators can see where inference spend is going, set budgets and rate limits." "Every request is attributed to the person, team, or workspace that made it." |
| Billing | No billing of its own. The optional flow in `docs/ai-gateway-billing.md` (last commit 2026-10-13) gives each user 100 free LLM calls per UTC day on the platform's gateway. After that it routes inference "through the user's own account so usage bills their Cloudflare credits", via the Cloudflare gatekeeper's OAuth token (scopes `aig.read aig.run aig.write …`). The doc's words: "the platform never holds money" [code]. |
| Sharing and forking | Blueprints: "An app instantiated from a blueprint contains the original app's code. But it does not contain its SQLite data, conversation history, credentials, or connected resources." Blueprint updates with an agent-run merge landed in #659 on 2026-10-05 [prior]. |
| Agents from outside | It consumes MCP and exposes none [prior]. |

### What "like Cloudflare OS, but much easier" maps to [inference]

- **Keep:**
  - "access to nothing" by default;
  - credentials held by a per-service broker;
  - typed capabilities;
  - approval of side effects;
  - AI through one metered choke point;
  - forks that carry code but no data, credentials or grants.
- **Make easier:**
  - No Cloudflare account to own. Cloudflare OS needs one per company, plus Access setup, plus an OAuth client per gatekeeper; its README says obtaining these credentials is hard.
  - Sign up on everyapp.com and get an org.
  - Platform-held provider keys, so there's no BYOK chore.
  - Catalog apps that work on install.
- **Differ on purpose:**
  - Every App apps are shared, multi-user org apps (TanStack Start + D1, deployed from a repo), not a per-user copy of an agent-built gadget.
  - Outside agents reach them through the gateway's one `/mcp`.

---

## 3. Platform by platform: only what transfers

### 3.1 Cloudflare VibeSDK (open source, MIT, 5,407 stars, last push 2026-09-22) [code at commit `9da158d`, 2026-09-07]

- **Per-app isolation.** Every generated app is uploaded to one dispatch namespace (`vibesdk-default-namespace`, `wrangler.jsonc:85, 219`).
  - The platform Worker dispatches by name and fails closed when no app row owns the deployment (`worker/index.ts:170-176, 202-204`).
  - Private apps take an owner-preview token on the subdomain (`worker/index.ts:178-199`).
  - The blog (2025-09-23): "they are all isolated from one another by default" [live]. The deploy path sets no outbound Worker, no custom limits and no tags (`worker/services/sandbox/sandboxSdkClient.ts:1858-1900`).
- **How generated apps get AI.** They get a **bearer token in env**, not a binding:
  - `CF_AI_BASE_URL` plus `CF_AI_API_KEY`, an HS256 JWT `{appId, userId, type:"app-proxy"}` that expires after 3 hours (`worker/services/aigateway-proxy/controller.ts:341-363`), written into `.dev.vars` (`worker/agents/services/implementations/DeploymentManager.ts:560-571`).
  - The proxy checks the JWT and that the app's owner matches, then allows OpenAI-compatible inference paths only (`controller.ts:19-25, 187-197`).
  - It clamps `max_tokens` to 16,384 "so a single call cannot exhaust the platform budget" (`controller.ts:15, 239-246`).
  - It tags each request with `cf-aig-metadata {appId, userId, source}` for AI Gateway reporting (`controller.ts:282-288`).
- **Metering.** A count, not dollars: 200 LLM calls per user per calendar UTC day, held in a Durable Object counter (`worker/services/rate-limit/config.ts:87-95`). BYOK users are excluded (`excludeBYOKUsers: true`). Three app creations per day.
- **Secrets.** A per-user vault Durable Object whose master key is derived client-side and lives only for a session ("DB dump = useless encrypted blobs", `worker/services/secrets/UserSecretsStore.ts:1-11`). Strong for BYOK keys a human types in. Useless for background app calls, because the vault is locked when nobody is signed in [inference].
- **Deploy and export.** Build in a sandbox, then upload to the namespace. Apps can be exported "to their own Cloudflare account and GitHub repo" (blog) [live].
- **Transferable:** the abuse caps on a shared key (body size, message count, `max_tokens` clamp), AI Gateway metadata tagging, and fail-closed dispatch.
- **Not transferable:** the env-held bearer token (anti-pattern A1).

### 3.2 Val Town [live]

- **Secrets.** Env vars are per val and set only in settings or by API; `Deno.env.set` is a no-op. Changes "are picked up by your val on the very next HTTP request — no redeploy needed." Organizations get **environment groups** linked to chosen vals. Public vals show variable *names* but not values. A remixer runs the code with their own values (docs.val.town/reference/environment-variables, environment-groups).
- **Access.** Code visibility and app (HTTP) access are separate settings. App access defaults to "Anyone with the URL"; "Restricted" needs a Business org. Val Town Access offers team-, person- or email-domain-only viewing with **bypass tokens** (`X-Val-Town-Access` header) for webhooks.
- **Platform AI without keys.** `std/openai` gives vals OpenAI access "without needing to acquire API keys".
  - Limit: "We limit each user to 100 requests per (UTC calendar) day."
  - Free users get the small models. Pro users get 10 requests a day to bigger models, after which requests silently drop to `gpt-5.6-luna`.
  - BYOK lifts the limits (page updated 2026-10-13).
- **Pricing.** Free / Pro $21/mo / Business from $167/mo / Enterprise. Plans are capped by runs per day (100k, 1M, 5M) and include Townie AI credit ($10, $100). No per-seat price is listed.
- **Transferable:**
  - env groups (org-level shared secrets linked to chosen apps);
  - secrets that take effect without a redeploy;
  - names visible, values never;
  - webhook bypass tokens for private apps. Every App's equivalent is the manifest's public routes.

### 3.3 Replit [live]

- **AI without keys, billed per app.** "Replit manages the provider credentials and bills you at the public API price. Your usage is billed to your Replit credits and appears on your usage page, broken down by Existing Replit App."
  - Providers: OpenAI, Anthropic, Google, Grok and OpenRouter.
  - When Agent adds AI to an existing app it shows a consent dialog ("Approve" / "Dismiss" for your own key).
  - Plan rules: off on Starter; on for Core; **off by default on Pro/Enterprise, where org admins enable it**.
  - Source: docs.replit.com/replitai/replit-ai-integrations, updated 2026-10-02.
- **Spend controls** (docs.replit.com/billing/managing-spend):
  - Usage limits block "usage-based services … until the next billing cycle or until you increase the limit", plus a separate "service shutdown limit".
  - Org budgets go in $500 increments.
  - Enterprise **per-user overrides**: "Per-user overrides always take precedence over group and workspace defaults", and a member falls back to "the most specific group or workspace limit".
  - Admins can block all Replit-managed AI integrations org-wide.
- **Isolation.** "Every individual, organization, and enterprise customer receives a dedicated, single-tenant GCP project for their published apps … compute resources, secrets, and storage are fully isolated."
- **Pricing.** Core $20/mo ($18 billed annually) includes $20 of usage; Pro $100 includes $100. Credit packs ($100–$1,000) expire after 6 months.
- **Transferable:**
  - per-app usage breakdown of platform-billed AI;
  - an org admin switch for platform-managed AI;
  - a budget hierarchy (workspace → group → member, most specific wins);
  - "platform fee includes equal usage credit".

### 3.4 Vercel [live]

- **AI Gateway budgets** (vercel.com/docs/ai-gateway/observability-and-spend/budgets, updated 2026-09-10). This is the closest existing design to per-app budgets at a gateway:
  - Four scopes: team, **project** ("what one project's deployments spend, through their OIDC tokens"), API key, user.
  - "Budgets stack … A request has to pass every budget in scope."
  - **Default budgets** per scope: "Each covered resource gets its own allowance … It never overrides a custom budget."
  - Exceeding one returns HTTP **402** with `type: quota_for_entity_exceeded` and a message naming the scope, its spend and its limit.
  - Refresh periods: daily, weekly, monthly or none (UTC).
  - Alerts at 50/75/100%.
  - A budget is "a soft cap": checked at request start, so the crossing request completes.
  - BYOK spend isn't counted.
- **AI Gateway pricing** (updated 2026-09-08): "no markup and no platform fee on tokens", BYOK included. Add-ons (custom reporting, team-wide allowlists, ZDR) are priced per 1,000 requests.
- **Vercel Connect** (GA 2026-08-25). A connection broker that gives code short-lived tokens:
  - The caller proves itself with the deployment's OIDC token, whose claims name team, project and environment.
  - Connect checks those claims against **project links** on the connector, then returns `ClientNotLinkedToProjectError` or `ClientNotEnabledForEnvironmentError`.
  - Refresh tokens never reach code.
  - Subjects are `app` or `user`.
  - Pricing: $3 per 1,000 token requests on Pro.
- **Marketplace native integrations billing** (updated 2026-08-28). Vercel is merchant of record for partner services:
  - The partner reports interim usage ("at least once a day, ideally once per hour"; display only, running totals) and then submits an invoice.
  - Billing is installation-level or resource-level, with line items that can be flat, usage-based or tiered.
  - Vercel handles tax, retries payment up to 9 times, and marks invoices overdue after 15 days. It advises partners to "degrade service or pause fulfillment (for example, stop issuing tokens)" rather than delete data.
  - **But provisioned secrets are written into the customer's project env vars**, with optional prefixes.
- **Pricing.** Pro is $20/mo with "$20 included credit", plus $20 per developer seat; viewer seats are listed as "Unlimited". New teams get a default $200 on-demand budget, with an optional hard pause at 100%.
- **Transferable:**
  - stacked budgets with per-scope defaults and a 402 that names the scope;
  - project links (a per-app grant checked against a platform-attested identity);
  - interim usage display separate from invoicing.
- **Not transferable:** marketplace secrets copied into app env (anti-pattern A1).

### 3.5 Supabase [live]

- **Secrets are project-wide.** Edge Function secrets are set per project, and every function in it gets the defaults injected: `SUPABASE_URL`, `SUPABASE_DB_URL`, `SUPABASE_SECRET_KEYS`, and the legacy `SUPABASE_SERVICE_ROLE_KEY`. Setting secrets needs the Owner or Administrator role. The `SUPABASE_` prefix is reserved. New secrets are read "immediately, so you don't need to redeploy".
- **Supabase for Platforms:**
  - The platform creates one project per customer in an org it owns (`POST /v1/projects`).
  - **Claim flow** (`GET /v1/oauth/authorize/project-claim`): "transferring the project from your org to your user's org while you continue to retain access … through an OAuth integration."
- **Transferable:**
  - reserved env prefix (Every App already has one: `worker.ts:248`);
  - the **claim flow** as a model for "graduate from hosted to self-host".
- **Not transferable:** an ambient high-privilege key in every function (anti-pattern A1).

### 3.6 Shopify [live]

- **Legacy Billing API.** `appSubscriptionCreate` with a `cappedAmount`: "the maximum that a merchant is billed for during the 30-day billing cycle." Merchants approve the plan at a confirmation URL. A 90% webhook warns them (`APP_SUBSCRIPTIONS_APPROACHING_CAPPED_AMOUNT`). A usage charge that would exceed the cap is rejected with "Total price exceeds balance remaining" (community answer quoting the GraphQL docs).
- **Shopify App Pricing** (changelog 2026-05-12) replaced it:
  - The Billing API is now "legacy".
  - Developers define meters in the Partner Dashboard, up to 5 per plan, priced fixed, graduated or volume.
  - Apps send events to the App Events API with an `event_handle` and an `idempotency_key` ("Idempotency is enforced permanently").
  - Shopify aggregates, invoices and supports negative corrections. Merchants see a billing card in admin.
  - "Usage-based pricing accounts for over 60% of revenue from top-earning apps."
- **Two caveats:**
  - "The App Events API always returns a `202` … There is no synchronous billing error response."
  - "Shopify App Pricing doesn't use capped amounts for usage-based pricing."
- **Transferable:**
  - app-declared meters with platform-owned prices and invoicing;
  - permanent idempotency keys on usage events;
  - the capped amount plus merchant approval plus a 90% warning, as the per-app budget UX (Shopify dropped it, but it fits internal apps better);
  - a billing card per app.

### 3.7 Slack and GitHub Apps (the approval model) [live]

- **Slack:**
  - Apps declare `oauth_config.scopes.bot` and `.user` in a manifest (up to 255 each).
  - With "Approve apps" on, members request and admins approve per workspace. The `app_requested` event carries the requesting user, team, scopes and `previous_resolution`.
  - Admins can grant a subset of scopes; optional scopes can be left out.
  - On Enterprise Grid, an app approved at org level "will need to be re-approved at the org level upon any scope changes", and adding scopes needs a reinstall.
- **GitHub Apps:** when an app asks for more, "Updated permissions won't take effect on an installation or user authorization until the new permissions are approved." Owners get an email. **Removals take effect immediately.**
- **Transferable:**
  - The grant is a separate record, and requests and approvals both live there.
  - A broader request goes pending while **the old grant keeps working**.
  - Narrowing applies at once.
  - Approvers can grant a subset.
  - Notify approvers.

### 3.8 Zapier, Pipedream, Composio (connection brokering) [prior, plus one live pricing check from that research]

- **Models.** Composio separates an *auth config* (how a provider authenticates) from a *connected account* (one grant: status lifecycle, PRIVATE or SHARED). Pipedream uses an opaque `external_user_id`. Zapier MCP charges "2 tasks per tool call" and connections belong to the signed-in Zapier account.
- **Composio breach (disclosed 2026-05-21).** 5,001 GitHub connections and 5,241 API keys exposed. The attack path ran through "an internal agentic tool used to monitor our infrastructure". Afterwards Composio "replaced single-key encryption with envelope encryption and an independently rotated key-encryption key". Tokens can't be exported. Logs keep tool arguments and results for up to a year unless you pay for ZDR. Pricing: 100k calls/month free, then $0.0003 per call.
- **Why it matters for hosted.** The integrations research counted "tokens staying in the customer's own Cloudflare account" as Every App's differentiator. **Hosted Every App gives that up.** It becomes a central multi-tenant vault, the same shape as Composio. That makes anti-pattern A2 and pattern P11 (an exit to self-host) load-bearing for trust [inference].

### 3.9 OpenAI (ChatGPT plugins, formerly the Apps SDK) and Anthropic (Claude connectors) [live]

- **OpenAI plugins.** `developers.openai.com/apps-sdk` now 301-redirects to `/plugins` ("Build and publish plugins with skills, MCP servers, and optional UI").
  - Tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) "help ChatGPT and Codex choose appropriate confirmation and safety behavior. They do not replace authorization, validation, or confirmation in your server."
  - **No platform metering of plugin usage.** Monetization is "external checkout", approved only for physical goods.
  - ChatGPT sends `_meta["openai/subject"]`, an "Anonymized user id sent to MCP servers for the purposes of rate limiting and identification", plus `openai/organization`.
  - Workspace admins publish plugins to chosen workspace roles.
  - Per-tenant MCP URLs are supported as a **Template MCP Server URL** (`https://{workspace}.example.com/mcp`), but "only … for trusted developers with whom we have an established relationship".
- **Claude connectors** (support.claude.com/en/articles/11176164):
  - Owners enable a connector, but "Each person still needs to authenticate individually".
  - Owners set **Always allow / Needs approval / Blocked** per tool category (read-only versus write/delete) or per tool, and "individual users can't override it".
  - "Restricting actions in Claude never grants more access than the source system permits—it only narrows it."
  - Org-wide authorization through the IdP went GA on 2026-08-24 [prior].
- **MCP Apps** (interactive `ui://` resources), co-authored by Anthropic and OpenAI, is reported stable since 2026-01-26 and supported in Claude and ChatGPT [secondary, not verified at source]. OpenAI's plugin docs reference `_meta.ui.resourceUri`.
- **Transferable:**
  - a three-way per-tool policy that only narrows;
  - annotations treated as hints, never authority;
  - agent hosts that don't meter, so the gateway has to;
  - a template MCP URL per org once Every App has a trusted relationship.

### 3.10 Upstream metering primitives Every App could lean on [live]

- **OpenRouter provisioning keys.**
  - `POST /api/v1/keys` (needs a management key) creates keys with `limit`, `limit_reset` (example: "daily … at midnight UTC") and `include_byok_in_limit`.
  - Each key reports `usage`, `usage_daily/weekly/monthly` and `limit_remaining`.
  - The stated use case is SaaS: "Automatically create unique API keys for each customer instance".
  - Fees, from third-party sources: 5.5% on credit purchases, no inference markup.
- **Cloudflare AI Gateway spend limits** (changelog 2026-06-05):
  - Dollar budgets over fixed or rolling windows, scoped by model, provider or custom metadata.
  - "Split by value" gives "Each distinct value … its own independent budget bucket".
  - Limits: "up to 20 rules per gateway"; "Spend limits are eventually consistent"; 429 on breach.
  - BYOK is counted for models with known pricing.
- **Cloudflare AI Gateway Unified Billing.** A 5% fee on credits, provider prices "with no markup". HTTP providers: OpenAI, Anthropic, Google AI Studio and Vertex, xAI, Groq. **OpenRouter isn't listed.**
- **Cloudflare self-managed OAuth clients** (changelog 2026-06-03). Any account can register an OAuth app. Clients start private to the account; public needs a verified domain. Example given: Wrangler deploying "Workers into that account". This is what makes Cloudflare OS's "bill AI to the user's own Cloudflare credits" possible, and would make the same possible for Every App.

---

## 4. Patterns worth adopting (12)

Each pattern: what it is, who does it, why it fits Every App, and what it looks like in the manifest and gateway. The code sketches are illustrative, not final API.

### P1. Hand apps a capability stub from the dispatcher, never a key or token in env

- **Who:** Cloudflare WfP dynamic dispatch props, where a capability "exposes specific methods that the user Worker can call, while the underlying data, credentials, and resources remain in the dispatch Worker" (docs 2026-09-16). Also Cloudflare OS (`env.PROJECT`) and Vercel Connect (platform-attested OIDC identity checked against project links).
- **Why it fits:** Every App already uses this model for self-host. `props` on a service binding are set by the platform and can't be forged by the app (`worker.ts:311-320`, checked at `app-gateway-entrypoint.ts:103-113`). WfP keeps the same model for hosted without an outbound Worker or env tokens.
- **What it looks like:**
  ```ts
  // gateway, in getAppFetcher's 'dispatch' branch (packages/perimeter/src/getAppFetcher.ts:52)
  const gateway = ctx.exports.AppGateway({ props: { organizationId, appId, workerName } });
  return env.DISPATCHER.get(workerName, {
    props: { EVERYAPP_GATEWAY: gateway, identity /* the 120 s JWT */ },
  }, { limits: { cpuMs, subRequests } });
  ```
  `createGatewayFetch` (`gatewayFetch.ts:28`) prefers `ctx.props.EVERYAPP_GATEWAY` and falls back to `env.EVERY_APP_GATEWAY` for self-host. `AppGateway` code doesn't change.
- **Open issue:** crons, queues and Workflow steps in a user Worker aren't dispatched, so they get no props. See §9, claim 2.

### P2. The grant is its own record; the manifest only asks

- **Who:** Slack (scopes requested, admin approves, subset allowed, re-approval on scope change), GitHub Apps ("Updated permissions won't take effect … until the new permissions are approved"; removals immediate), Shopify (merchant approves the plan and cap), Claude connectors (owner enables, each person authenticates).
- **Why it fits:** today `providers` is self-approved by whoever deploys (`app-gateway-entrypoint.ts:114`). Fine for an org's own code on self-host. Wrong for a hosted org installing OpenSEO from the catalog. The integrations design already specifies this flow for third-party integrations (flow B); apply it to providers and meters too.
- **What it looks like:**
  ```ts
  // everyapp.config.ts
  providers: { openrouter: { why: "Sam, the SEO agent", models: ["anthropic/claude-*"] } },
  meters:    { seo_data: { unit: "usd", why: "DataForSEO lookups" } },
  ```
  - New table `app_grants(org_id, app_row_id, kind: provider|integration|meter, name, spec_json, status: pending|approved|denied, requested_by, approved_by, approved_at)`.
  - Deploy diff: broader → pending (the old grant still serves), narrower → applied at once.
  - `AppGateway` checks `app_grants`, not `manifest.providers`.
  - An admin deploying their own org app can approve in the CLI prompt (decision 3 in the integrations design).

### P3. Ceilings that can only narrow: platform → org → app → user

- **Who:** Claude connectors (Always allow / Needs approval / Blocked; "never grants more access than the source system permits"), Microsoft Managed Runtime `allowedActions` enforced per app by the connector infrastructure [prior], Replit (org admins can block all managed AI integrations). Every App's own `AI_PROXY_EXTRA_ROUTES` ∩ `ai.routes` (`ai-proxy.ts:203-220`).
- **Why it fits:** the code already has a two-level ceiling for OpenAI routes. Hosted needs a third level, the org admin, sitting between the platform and the app.
- **What it looks like:**
  - `org_policies(org_id, provider, allowed_models_json, blocked, tool_risk_overrides_json)`.
  - Effective policy = platform catalog ∩ org policy ∩ approved grant ∩ manifest request.
  - For ToolBus, an org override per tool (`allow | needs_approval | blocked`) that can only tighten the app's declared risk, which fixes the `policy.ts:2` trust gap for catalog apps.

### P4. Stacked budgets with defaults per scope, checked at the broker before each call

- **Who:**
  - Vercel AI Gateway: team, project, key and user scopes; defaults; 402 `quota_for_entity_exceeded`; alerts at 50/75/100.
  - Replit: workspace → group → member, most specific wins; org budgets.
  - Cloudflare AI Gateway: split-by-value buckets.
  - Shopify legacy: a cap per app per 30 days.
- **Why it fits:** the founder wants "usage limits per app" at the gateway. Every App's natural scopes are **org, app, user, app×user**. The gateway already knows all four on every call (`props` plus the verified identity JWT, `app-gateway-entrypoint.ts:122-131`).
- **What it looks like:**
  - `budgets(org_id, scope: org|app|user|app_user, scope_id, limit_usd, period: day|week|month|none, alert_pcts)`, plus one default row per scope.
  - A per-org Durable Object holds running spend, so one org's counters are serialized and other orgs are untouched.
  - Before an upstream call the gateway checks every budget in scope. On breach: `402 {code:"budget_exceeded", scope:"app", app:"openseo", spentUsd, limitUsd, resetsAt, raiseUrl}`.
- **Decision for the founder:** hard or soft cap (Q3). Vercel's soft cap lets the crossing request finish. P5 makes a hard cap possible.

### P5. Reserve, then settle (holds) for every metered call

- **Who:**
  - OpenSEO today: Autumn `check({lock})`, then `balances.finalize` (`autumn.ts:58-72`).
  - Shopify legacy: rejects a usage charge that would exceed the cap.
  - VibeSDK: clamps `max_tokens` so one call's worst case is bounded (`controller.ts:239-246`).
  - Counter-examples (why holds matter): Cloudflare AI Gateway limits are "eventually consistent" and Vercel budgets are "a soft cap".
- **Why it fits:** DataForSEO calls are expensive and quoted up front; LLM calls have a computable worst case (`max_tokens` × price). The gateway is the only place that can hold against the org's balance *and* the app's budget at once.
- **What it looks like:**
  - Inside the AI proxy, automatically: estimate = input tokens (from body length) + `max_tokens` × model price → `reserve` → stream → `settle` with actual usage from `tapUsage` (`ai-usage.ts:40-59`). If no usage arrives, settle at the reserved amount.
  - For app-defined meters, the app calls `gateway.meter.reserve("seo_data", {estimateUsd})` → `{holdId}`, then `gateway.meter.settle(holdId, {actualUsd})`. Unsettled holds expire and charge the estimate.

### P6. Apps declare meters; the platform owns price, balance and invoice

- **Who:**
  - Shopify App Pricing: meters defined in the dashboard, App Events API with a permanent `idempotency_key`, platform aggregates and invoices, negative corrections.
  - Vercel Marketplace: partner reports usage, Vercel invoices, collects and handles tax.
  - Replit: per-app breakdown of platform-billed AI.
- **Why it fits:** the founder's "for OpenSEO all billing and metering happens at the gateway instead of in the app". OpenSEO already prices DataForSEO as raw cost × 1.28 (`billing.ts:18, 50-58`). Moving that multiplication and the Autumn calls into the gateway makes OpenSEO a pure meter emitter, and makes every other app billable the same way.
- **What it looks like:**
  - Manifest `meters` (P2).
  - The app sends `gateway.meter.record("seo_data", { valueUsd, idempotencyKey })` over the binding, or uses the reserve/settle pair from P5.
  - The gateway multiplies by a per-catalog-app markup (`catalog_prices(app_slug, meter, markup)`), deducts from the org's credit pool, and writes `usage_events(org, app, user, channel, meter|provider, model, raw_usd, billed_usd, idempotency_key UNIQUE)`.
  - It shows "Usage by app" (Replit-style).
  - The app never imports Autumn.

### P7. Platform-held provider keys by default; BYOK as a per-org opt-out

- **Who:** Replit AI Integrations ("Replit managed", public API price, per-app usage, admin switch), Val Town `std/openai` (no key, 100 requests/day), Vercel AI Gateway (zero markup, BYOK optional), Cloudflare OS (platform gateway first, then the user's own credits).
- **Why it fits:** ADR-0001 already decided "platform-owned provider key" for hosted v1 (`adr/ADR-0001-hosted-vs-self-hosted-topology.md`, decision 5). The comparables show the extra pieces that make it usable:
  - the provider list beyond OpenAI (the founder names OpenRouter, and OpenSEO's agent uses it, `SamChatAgent.ts:36`);
  - "Platform-managed" labelling;
  - a per-org kill switch.
- **What it looks like:**
  - Provider packs in the gateway (`openai`, `openrouter`, `anthropic`, later `dataforseo` as a non-LLM provider), each with a route allowlist like `INFERENCE_ROUTES` (`ai-proxy.ts:39-49`).
  - `org_provider_settings(org, provider, mode: platform|byok|off, byok_secret_ref)`.
  - Budgets (P4) apply in both modes. The credit pool (P6) is charged only in `platform` mode.

### P8. One upstream sub-key per org×app where the provider can enforce limits itself

- **Who:** OpenRouter provisioning keys (`limit`, `limit_reset`, per-key usage; use case "unique API keys for each customer instance"), Vercel AI Gateway API-key budgets with expiration ("cap a contractor or experiment key in both dimensions").
- **Why it fits:** defense in depth. If the gateway's counter lags (P4/P5 bugs, an isolate killed mid-stream, OpenSEO's $160/day incident), the provider still stops at the cap. It also gives exact per-app reconciliation from the provider's own numbers.
- **What it looks like:**
  - On approving a `providers.openrouter` grant, the gateway calls `POST /api/v1/keys {name: "<org>/<app>", limit: <app budget × 1.1>, limit_reset}`.
  - It stores the key encrypted under the org's data key and injects it per call. It disables the key on revoke or uninstall, and reconciles `usage_monthly` against `usage_events` nightly.

### P9. "Pay with your Cloudflare account" for AI (and the bridge to self-host)

- **Who:** Cloudflare OS: 100 free calls a day, then "routed through the user's own account so usage bills their Cloudflare credits … the platform never holds money" (`docs/ai-gateway-billing.md`). VibeSDK: users with a connected Cloudflare account and gateway (`excludeCloudflareConnected`). Enabled by Cloudflare's self-managed OAuth clients (2026-06-03).
- **Why it fits:**
  - Every App's users already skew Cloudflare-native.
  - It removes Every App from the money path for AI, so there's no markup and no float.
  - The same OAuth grant is the first step of P11 (move the org to its own account).
- **What it looks like:**
  - `org_provider_settings.mode = "cloudflare_account"`; the AI proxy routes through the org's own AI Gateway with its OAuth token.
  - Shown on the billing page as "AI billed to your Cloudflare account; app meters billed by Every App".
  - Limit: Unified Billing doesn't list OpenRouter, so this works for OpenAI, Anthropic, Google, xAI and Groq only.

### P10. Typed "you need X" errors with the URL that fixes it

- **Who:**
  - Vercel: 402 naming the exceeded scope; Connect's `ClientNotLinkedToProjectError`, `UserAuthorizationRequiredError`.
  - WorkOS Relay: 402 plus `authorization_url` [prior].
  - Cloudflare OS: "blocked, with a prompt to connect" or "to add credits".
  - OpenSEO's MCP instructions already tell agents to "share the billing link from that error".
- **Why it fits:** hosted adds new reasons a broker call fails: grant pending, budget hit, out of credits, account not connected. Apps and agents both need to show a fix, not a 403.
- **What it looks like:** extend `AppGatewayErrorCode` (`app-gateway-entrypoint.ts:34-42`) with:
  - `grant_pending {approveUrl}`
  - `budget_exceeded {scope, resetsAt, raiseUrl}`
  - `out_of_credits {billingUrl}`
  - `needs_account {connectUrl}`

  The SDK raises them as typed errors. ToolBus passes them through to MCP clients as tool errors with the URL.

### P11. Forks carry code, never data, credentials or grants; and hosted orgs can leave

- **Who:**
  - Cloudflare OS blueprints (no SQLite data, credentials or connected resources; updates by agent merge).
  - Val Town remix (the remixer supplies their own env).
  - VibeSDK export to your own account.
  - Supabase's claim flow (the project moves to the user's org while the platform keeps OAuth access).
- **Why it fits:**
  - The founder wants "customizations/forks of a repo" hosted. A fork must start with zero grants and re-request them (P2).
  - Hosted Every App becomes a central vault (A2). A documented exit to self-host is the strongest answer to "why trust you with our tokens" [inference].
- **What it looks like:**
  - `everyapp fork <catalog-app>` creates a new app row with `forked_from` and an empty grant set; the redeploy diff produces pending requests.
  - Later, "Move this org to my Cloudflare account": export D1 databases, registry rows and grants. Re-encrypt secrets for the new gateway. Integration tokens may need re-consent, because hosted provider clients differ from self-hosted ones.

### P12. Agents don't meter; the gateway attributes every agent-driven call

- **Who:** OpenAI: no plugin metering; monetization is external checkout; it sends an anonymized `openai/subject` "for the purposes of rate limiting". Claude connectors: per-user auth, no metering. Cloudflare OS attributes every inference "to the person, team, or workspace".
- **Why it fits:** with one `/mcp` for all apps, a lot of hosted spend will be agent-initiated (OpenSEO's Sam, Claude calling OpenSEO tools). Nobody upstream will tell Every App who caused it.
- **What it looks like:**
  - Every metered event carries `channel` (`web | mcp | agent`) and the tool-call id (`tc` claim, already in the identity JWT per the integrations design, and `mcp_tool_calls.id`, `mcp.schema.ts:146-147`).
  - Budgets can target `channel = mcp`, e.g. "agents may spend $5/day per user in OpenSEO".
  - Later, register a template MCP URL `https://{org}.everyapp.com/mcp` with OpenAI once Every App qualifies as a trusted developer.

---

## 5. Anti-patterns to avoid (5)

**A1. Long-lived platform credentials in app env.**
- VibeSDK gives generated apps a 3-hour HS256 bearer token as `CF_AI_API_KEY` in `.dev.vars` (`DeploymentManager.ts:560-571`). Anything that reads env or logs can replay it until it expires.
- Vercel Marketplace writes provisioned resource secrets into the customer project's env vars.
- Supabase injects `SUPABASE_SECRET_KEYS` and the legacy `service_role` key into every Edge Function in a project.
- Every App's binding-plus-props model avoids all three. Hosted mustn't regress to "give the WfP script an `EVERYAPP_TOKEN` secret" for convenience (see P1, and the background-invocation gap in §9, claim 2). App-own secrets (`worker.ts:53-61`) stay allowed, but platform credentials never ride in env.

**A2. One multi-tenant vault behind one key.**
- Composio's 2026-05-21 breach (5,001 GitHub connections, 5,241 API keys) came in through an internal agentic monitoring tool. Its fix was envelope encryption with "an independently rotated key-encryption key".
- Hosted Every App will hold every org's provider grants and integration tokens.
- Minimum bar:
  - a data key per org, wrapped by a KEK kept away from the signing key and the platform's Cloudflare token (already sketched at `docs/architecture-v2-recommendation.md:73`);
  - no API that returns a token (the integrations design: "No API returns a token");
  - no agentic tooling with vault read access;
  - narrow upstream tokens where possible (GitHub installation tokens; P8 sub-keys);
  - the exit path in P11.

**A3. Async-only billing with no synchronous gate.**
- Shopify's App Events API "always returns a `202` … There is no synchronous billing error response".
- Cloudflare AI Gateway limits are "eventually consistent".
- Vercel's budgets are "a soft cap".
- All fine for invoicing. None can stop an expensive DataForSEO batch or a runaway agent loop before it spends.
- Every App needs P5 holds on the hot path and can use async aggregation only for invoices.
- Related caution: Shopify App Pricing *removed* capped amounts for usage plans. For internal apps, where an admin wants a hard ceiling per app, don't copy that removal.

**A4. Budgets counted in calls instead of dollars.**
- VibeSDK: 200 LLM calls per user per day (`rate-limit/config.ts:87-95`).
- Val Town: 100 requests per day.
- Cloudflare OS: 100 free calls per day.
- A small-model call and a frontier-model call differ in cost by two orders of magnitude, so a call quota is either too loose or too tight.
- Use dollars (tokens × price table, plus raw cost for app meters) for budgets and credits. Keep call counts only as anti-abuse rate limits.

**A5. Self-approval: the deployer's manifest (or the app's own labels) as the grant.**
- Current Every App: `app-gateway-entrypoint.ts:114` checks only `manifest.providers`, and `policy.ts:2` trusts declared tool risk.
- Retool grants resource use per user or group with no per-app grant at all [prior].
- This works on self-host, where the deployer is the org's admin. In hosted, catalog apps (and forks of them) are written by someone else. The installing org's admin must approve providers, meters and integrations, and must be able to override tool risk (P2, P3).

**Pricing caution (secondary sources, not a full anti-pattern):** third-party reviews report Replit users' bills jumping "from a predictable $20 to over $350 in a single day" under effort-based Agent pricing (banani.co, eesel.ai). Whatever Every App charges, show per-app spend live and default to a budget, as Vercel does with its $200 on-demand default.

---

## 6. Pricing structures observed

| Platform | Platform fee | Included usage | Usage pricing | Seats | Source date |
|---|---|---|---|---|---|
| Vercel Pro | $20/mo | $20 credit | AI Gateway: list price, **0% markup**, incl. BYOK; Connect $3/1k token requests | $20 per developer seat; viewers "Unlimited" | 2026-09 / 2026-08-25 |
| Replit | Core $20 ($18 annual), Pro $100 | Equal to the fee ($20 / $100) | AI Integrations "at the public API price"; credit packs, 6-month expiry | Pro: up to 15 collaborators; Enterprise custom | 2026-10-02 |
| Val Town | Pro $21, Business from $167 | Runs/day caps; $10 / $100 Townie credit | `std/openai` free but capped at 100 req/day | No seat price listed | 2026-10 |
| Cloudflare | WfP $25/mo (20M req, 60M CPU-ms, 1,000 scripts, +$0.02/script) | — | AI Gateway Unified Billing: **5% fee on credit purchase**, 0% on inference | — | 2026-06 / 2026-09 |
| OpenRouter | — | — | 5.5% on credit purchase, 0% on inference; BYOK 5% over an allowance (third-party sources) | — | 2026 (secondary) |
| Composio | — | 100k calls/month | $0.0003 per call | — | 2026-08-15 [prior] |
| Shopify apps | App-defined | App-defined | Usage-based is ">60% of revenue from top-earning apps" | — | 2026-05-12 |
| **OpenSEO today** | $10/mo base; $50 YC | 10k credits ($10) | **1.28× markup** on DataForSEO; top-ups $1 per 1,000 credits | — | `billing.ts:17-18` |

**Observations [inference]:**
- The 2026 norm for infrastructure is a **platform fee that includes an equal usage credit, with usage passed through at list price**. Margin, where there is any, comes from a small fee on credit purchases (5–5.5%), not a per-token markup.
- Application vendors (OpenSEO, Shopify apps) mark up their own cost of goods.
- Hosted Every App sits in both camps. It's infrastructure for org apps, and the merchant for catalog apps like OpenSEO. That points to two price layers:
  - **pass-through** for providers that org apps call (AI at list price, plus maybe a credit fee);
  - **per-meter prices set per catalog app** (OpenSEO's 1.28×) for catalog apps.
- Per-seat pricing shows up only for *builders* (Vercel developer seats); viewers are free everywhere it's specified.

---

## 7. Gaps and the smallest change that closes each

| # | Gap | Where | Smallest fix | Days |
|---|---|---|---|---|
| G1 | Grants are self-approved from the manifest | `app-gateway-entrypoint.ts:114`; registration in `apps/every-app-gateway/src/server/services/AppRegistrationService.ts` | `app_grants` table. Deploy diff → pending/approved. Approve in Admin → Apps (and a CLI prompt for admins). The broker reads grants. (P2) | 2–3 |
| G2 | No budgets | gateway | Per-org Durable Object counter; `budgets` table with per-scope defaults; check in `AppGateway` before upstream; 402 `budget_exceeded`. (P4) | 3–4 |
| G3 | Usage logged, not priced or stored | `ai-proxy.ts:176-190` | Model price table, `usage_events` table (or Analytics Engine plus a D1 rollup), "Usage by app" page. (P6, P12) | 2 |
| G4 | No holds; end-of-stream only | `ai-proxy.ts`, `ai-usage.ts` | `reserve` on the `max_tokens` worst case before the call, `settle` in `tapUsage`'s `onDone`; default-settle at the estimate when usage is missing. (P5) | 2 |
| G5 | Only OpenAI, one key | `ai-proxy.ts:94-127` | Provider packs: `openrouter` first, then `anthropic`. Per-pack route allowlist and usage parser. (P7) | 2–3 |
| G6 | Non-AI app meters (DataForSEO) bill inside the app via Autumn | OpenSEO `src/server/billing/*` | Manifest `meters`; `AppGateway` RPC `meter.reserve/settle/record` with idempotency; the gateway alone talks to the billing backend; OpenSEO PR swaps its `autumn.*` calls for `gateway.meter.*`. (P6) | 3–4 (+2 OpenSEO) |
| G7 | Hosted caller identity: `dispatch` tier unimplemented | `getAppFetcher.ts:52-56`; SDK `gatewayFetch.ts:28` | Pass `ctx.exports.AppGateway({props})` in dispatch `props`; SDK prefers `ctx.props`. Background invocations need a separate decision (claim 2). (P1) | 2–3 |
| G8 | Tool risk trusts the app | `packages/toolbus/src/policy.ts:1-37` | `app_tool_overrides(org, app, tool, policy: allow\|needs_approval\|blocked)` that can only tighten; Admin UI per catalog app. (P3) | 1–2 |
| G9 | Errors don't carry a fix | `app-gateway-entrypoint.ts:34-42` | New codes with `approveUrl`, `raiseUrl`, `billingUrl`, `connectUrl`; SDK error classes; ToolBus passthrough. (P10) | 1 |
| G10 | Upstream has no hard stop | — | OpenRouter per-org×app provisioning keys created at grant approval and disabled on revoke; nightly reconcile. (P8) | 1–2 |
| G11 | Hosted orgs can't self-serve | `auth/config.ts:83-96, 315` | Hosted mode: personal org on sign-up, as RFC-0001 already decided (`adr/RFC-0001-org-rearchitecture-phase-1.md`, "Onboarding Model"). | 1–2 |
| G12 | No exit from hosted | — | Write the export format down now: D1 dumps, registry rows, grants. Build "move to my Cloudflare account" later on Cloudflare OAuth. (P9, P11) | 1 (spec) |

---

## 8. Open questions only the founder can answer

1. **Who sets the price of a catalog app's meters, and does anyone but Every App get paid?** Today OpenSEO's markup is 1.28×.
   - Why it matters: it decides whether `catalog_prices` is an Every App table, or a field publishers set with payouts (marketplace mechanics like Vercel's invoicing).
   - Recommended default: Every App sets per-meter prices for its own catalog apps; no third-party publishers or payouts in v1.
2. **Pricing structure: a platform fee with an equal usage credit, per-seat, or pure usage?**
   - Why it matters: it sets the Autumn plan shape, the free tier, and whether budgets default on.
   - Recommended default: a Vercel/Replit-style org plan ($X/mo including $X of credits), AI passed through at list price, catalog-app meters at their own prices, no per-seat charge for members. Revisit seats for builders later.
3. **Are per-app budgets hard stops or soft alerts by default, and what's the default per-app cap?**
   - Why it matters: a hard stop needs holds (P5) on every call. A soft cap is simpler but lets a runaway loop like OpenSEO's $160/day keep going.
   - Recommended default: hard stop at the broker; a default per-app monthly budget equal to the plan's included credit; alerts at 50/75/100%.
4. **Who approves grants for org apps an admin deploys themselves?**
   - Why it matters: friction versus safety. Slack and GitHub always ask an installer; self-host today never asks.
   - Recommended default: an admin deploying their own org app approves in the CLI prompt. Catalog apps and forks always ask in the UI. Members can request but not approve.
5. **BYOK in hosted v1?** ADR-0001 deferred it.
   - Why it matters: BYOK takes Every App out of the money path for heavy users, but adds a vault entry per org per provider.
   - Recommended default: keep BYOK deferred except P9 ("pay with your Cloudflare account"), which stores an OAuth grant, not a raw key, and doubles as the self-host bridge.
6. **Should a hosted org be able to leave for self-host with its data?**
   - Why it matters: it's the trust answer to a central vault (A2) and shapes the data model now (exportable registry, grants, D1).
   - Recommended default: yes as a stated promise, spec the export format now, build it after billing.
7. **Does "like Cloudflare OS" include per-user, agent-built gadgets?**
   - Why it matters: Cloudflare OS's core unit is a private per-user app copy. Every App's is a shared org app. Supporting both doubles the runtime model.
   - Recommended default: no. Borrow the capability and approval model and the "fork carries code only" rule; agents build org apps through the CLI, not per-user gadgets.
8. **Free tier: a call quota or a dollar credit?**
   - Why it matters: call quotas (Cloudflare OS 100/day, Val Town 100/day) are simple but mis-price models (A4).
   - Recommended default: a one-off dollar credit per new org, matching OpenSEO's free plan of 500 one-off credits ($0.50). Raise it to something useful, e.g. $5.

---

## 9. Load-bearing claims (if wrong, the design changes)

1. **WfP dispatch can pass an RPC capability stub to a user Worker via `props`**, so the `AppGateway` entrypoint carries over to hosted unchanged. Source: developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/ ("Give access to specific platform functions"), updated 2026-09-16. *Critical.*
2. **Cron, queue and Workflow invocations of a WfP user Worker don't go through the dispatcher, so they get no capability props.** Background broker calls then need another path: an upload-time service binding with fixed `props` to the gateway, if WfP allows one, or an outbound Worker with per-script parameters. *Unverified.* The WfP bindings page lists KV, D1, R2, Queues, Workflows and DOs, and says nothing about service bindings from user Workers to account Workers. *Critical.* Verify before building P1.
3. **Outbound Workers don't intercept fetches from Durable Objects** (docs updated 2026-04-21), so key injection at the outbound Worker can't be the main credential path.
4. **Cloudflare AI Gateway spend limits can't serve as the per-org/per-app budget engine.** They allow up to 20 rules per gateway; split-by-value gives every value the *same* limit; they are eventually consistent. Source: developers.cloudflare.com/ai-gateway/features/spend-limits/. If Cloudflare adds per-value overrides and strong consistency, P4 could move into AI Gateway.
5. **OpenRouter provisioning keys enforce per-key dollar limits server-side** (openrouter.ai/docs/features/provisioning-api-keys). P8 depends on it.
6. **Cloudflare self-managed OAuth clients let any account register an app** that acts on a user's account (changelog 2026-06-03). Public visibility needs a verified domain. P9 and the self-host exit depend on it, as does whether `aig.run`-style scopes are grantable to third parties (Cloudflare OS's billing doc uses them).
7. **Cloudflare OS has no multi-tenant SaaS offering or published pricing.** The managed version is a per-company deployment on a waitlist (blog 2026-10-01). If Cloudflare launches a multi-tenant "Cloudflare OS for teams" with billing, the competitive framing changes.
8. **Hosted Every App will hold every org's tokens centrally**, the Composio shape. That follows from the founder's vision rather than an outside source, but it reverses the integrations research's main differentiator ("tokens staying in the customer's own Cloudflare account").

---

## 10. Sources

Every App code and docs (this worktree unless noted):
- `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts`, `ai-proxy.ts`, `ai-usage.ts`; `apps/every-app-gateway/src/db/mcp.schema.ts`, `apps.schema.ts`; `apps/every-app-gateway/src/auth/config.ts`
- `packages/perimeter/src/manifest/manifest.ts`, `getAppFetcher.ts`, `registry.ts`; `packages/sdk/src/server/gatewayFetch.ts`; `packages/sdk/src/cloudflare/worker.ts`; `packages/toolbus/src/policy.ts`
- `adr/ADR-0001-hosted-vs-self-hosted-topology.md`; `adr/RFC-0001-org-rearchitecture-phase-1.md`; `docs/architecture-v2-overview.md`; `docs/architecture-v2-recommendation.md`; `docs/cli-redesign.md:132`
- Branch `research/app-integrations`: `docs/research/2026-10-integrations-hub/app-integrations.md`, `raw/landscape-internal-app-platforms.md`, `raw/landscape-aggregators.md`, `raw/composio.md` (fetched 2026-10-12)
- OpenSEO (`/Users/bensenescu/workspaces/open-seo`): `src/shared/billing.ts`, `src/server/billing/autumn.ts`, `src/server/features/sam/SamChatAgent.ts`

Cloudflare OS:
- https://blog.cloudflare.com/cloudflare-os/ (2026-08-05)
- https://blog.cloudflare.com/managed-cloudflare-os/ (2026-10-01)
- https://github.com/cloudflare/cloudflare-os (README; gh API 2026-10-15)
- https://github.com/cloudflare/cloudflare-os/blob/main/docs/ai-gateway-billing.md (last commit 2026-10-13)

Cloudflare platform:
- https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/ (updated 2026-09-16)
- https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/ (updated 2026-09-16)
- https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/ (updated 2026-04-21)
- https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/ (updated 2026-04-21)
- https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/tags/ (updated 2026-04-21)
- https://developers.cloudflare.com/cloudflare-for-platforms/llms-full.txt (WfP pricing table)
- https://developers.cloudflare.com/ai-gateway/features/spend-limits/ ; https://developers.cloudflare.com/changelog/post/2026-06-05-spend-limits/
- https://developers.cloudflare.com/ai-gateway/features/unified-billing/
- https://developers.cloudflare.com/changelog/post/2026-06-03-public-oauth-clients/

Cloudflare VibeSDK:
- https://github.com/cloudflare/vibesdk (commit `9da158d`, 2026-09-07): `worker/services/aigateway-proxy/controller.ts`, `worker/services/rate-limit/config.ts`, `worker/services/secrets/UserSecretsStore.ts`, `worker/agents/services/implementations/DeploymentManager.ts`, `worker/services/sandbox/sandboxSdkClient.ts`, `worker/index.ts`, `wrangler.jsonc`
- https://blog.cloudflare.com/deploy-your-own-ai-vibe-coding-platform/ (2025-09-23)

Val Town:
- https://docs.val.town/reference/environment-variables/ ; https://docs.val.town/reference/environment-groups/ ; https://docs.val.town/reference/permissions/ ; https://docs.val.town/std/openai/ (updated 2026-10-13) ; https://www.val.town/pricing
- Val Town Access page: https://valdottown--019fed48ea2d709ab2892f173f5563dd.web.val.run/access

Replit:
- https://docs.replit.com/replitai/replit-ai-integrations (updated 2026-10-02) ; https://docs.replit.com/billing/managing-spend ; https://replit.com/pricing ; https://docs.replit.com/cloud-services/deployments/about-deployments
- Secondary, for bill-shock reports: https://www.banani.co/blog/replit-pricing ; https://www.eesel.ai/blog/replit-pricing

Vercel:
- https://vercel.com/docs/ai-gateway/observability-and-spend/budgets (2026-09-10) ; https://vercel.com/docs/ai-gateway/pricing (2026-09-08)
- https://vercel.com/docs/connect/concepts/authentication (2026-09-18) ; https://vercel.com/changelog/vercel-connect-ga (2026-08-25)
- https://vercel.com/docs/integrations/create-integration/marketplace-api (2026-09-17) ; https://vercel.com/docs/integrations/create-integration/billing (2026-08-28) ; https://vercel.com/pricing

Supabase:
- https://supabase.com/docs/guides/functions/secrets ; https://supabase.com/docs/guides/integrations/supabase-for-platforms (claim flow) ; https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration

Shopify:
- https://shopify.dev/changelog/posts/shopify-app-pricing-charge-for-usage-recurring-subscriptions-or-both (2026-05-12) ; https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing ; https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/setup-usage-charges ; https://shopify.dev/docs/apps/launch/billing/subscription-billing/create-usage-based-subscriptions ; https://community.shopify.com/t/create-usage-charge-above-the-capped-amount-value/144544

Slack and GitHub:
- https://docs.slack.dev/admins/managing-app-approvals ; https://docs.slack.dev/reference/methods/admin.apps.approve ; https://docs.slack.dev/reference/app-manifest/
- https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration

OpenAI and Anthropic:
- https://developers.openai.com/plugins/llms-full.txt (fetched 2026-10-15; `/apps-sdk` redirects to `/plugins`)
- https://support.claude.com/en/articles/11176164
- MCP Apps, secondary: https://tanstack.com/ai/latest/docs/mcp/apps ; https://www.morphllm.com/mcp-apps

OpenRouter:
- https://openrouter.ai/docs/features/provisioning-api-keys
- Fees, secondary: https://www.truefoundry.com/blog/openrouter-pricing

Autumn (for mapping per-app balances):
- https://docs.useautumn.com/documentation/modelling-pricing/sub-entity-balances ; https://docs.useautumn.com/documentation/modelling-pricing/sub-entity-plans
