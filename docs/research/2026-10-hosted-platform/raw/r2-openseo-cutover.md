# Moving app.openseo.so onto hosted Every App: the cutover plan

Round-2 gap report, 2026-10-15. Inputs:
- `BRIEF.md` and `README.md` (D2, D5, D7, H13, H17, H18, H26, §4 and §5).
- `raw/openseo-fit.md` (all of it).
- `raw/autumn-billing-platform.md` (§1.3, §1.4.a, c-e, §2.2, §2.4-2.5).
- `raw/hostnames-certs-cookies.md` (§1.8, §3.3, §4, §8).
- The OpenSEO repo at `/Users/bensenescu/workspaces/open-seo` (HEAD `847c8854`, read only).
- Every App `origin/main` (`72170b10`, which includes #284-#294).
- The founder's Cloudflare account, read only on 2026-10-15.
- Dated docs from DataForSEO, Autumn, Google and Cloudflare (§2.7).

I wrote nothing to Autumn, Cloudflare or the OpenSEO database.

OpenSEO paths are relative to the OpenSEO repo. Every App paths are relative to this worktree, or `origin/main:` when the merged code is cited.

---

## 1. The question

H18 says how OpenSEO's billing code moves to the gateway. Nothing in the README says how the live product at `app.openseo.so` gets onto hosted Every App. That move involves real users, paying Stripe subscriptions, MCP connections listed in Claude's connector directory, and audits that are running at the moment of the switch. The open sub-questions:

- **(a) Identity.** Import OpenSEO's users, orgs, memberships and sessions into the gateway's D1? Bridge the two accounts at sign-in? Or let OpenSEO keep its own auth and match the gateway's identity JWT by email?
- **(b) Autumn customer ids.** D5 says to keep OpenSEO's org ids. `openseo-fit.md` Q1 says new customer ids should be Every App org ids. Which rule wins, which Autumn steps follow, and what happens to `check({lock})` holds and `topup_credits` at the moment of cutover?
- **(c) Domain.** `app.openseo.so` must keep working. Options: a BYO domain on the gateway, a redirect to per-org hosts, or OpenSEO keeping its own perimeter for now.
- **(d) DataForSEO.** All orgs will share one platform account. What are its limits, how do we keep orgs from starving each other, and what runs in previews?
- **(e) PRs.** The ordered PR list across both repos, with sizes and a rollback point for each.
- **(f) Founder decisions.** A refined D5, and whether existing customers move at all during the prototype.

---

## 2. Findings

### 2.1 The identity data maps almost 1:1, and password hashes are portable

**Schemas.**
- OpenSEO prod uses Postgres through Hyperdrive. Its Better Auth tables are `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` and `apikey` (`src/db/pg/better-auth-schema.ts:15-200`).
- The gateway's D1 has the same Better Auth tables under plural names (`origin/main:apps/every-app-gateway/src/db/auth.schema.ts:10-159`). Column names and meanings match.

**Differences that matter:**

| Table | OpenSEO | Gateway | What the import does |
|---|---|---|---|
| user | `analytics_opted_out`, `last_active_organization_id` (`better-auth-schema.ts:26-30`) | `role`, `banned`, `ban_reason`, `ban_expires`, `status` (`auth.schema.ts:25-29`) | `last_active_organization_id` goes to the column H3 adds. `analytics_opted_out` stays in OpenSEO (it is an app preference). Gateway-only columns take their defaults. |
| account | Non-unique `(account_id, provider_id)`. A partial unique index on Google *data grants* (`provider_id IN ('google-search-console','google-analytics')`, `:82-86`) | Unique `(provider_id, account_id)` (`auth.schema.ts:83-86`) | Import only `credential` and `google` rows. GSC and GA4 grants are OpenSEO product data and stay in OpenSEO. |
| account tokens | `encryptOAuthTokens: true`, keyed from OpenSEO's `BETTER_AUTH_SECRET` (`src/lib/auth-config.ts:31-35`) | different secret | Null `access_token`, `refresh_token` and `id_token` on imported Google rows. Sign-in never reads them. |
| member | unique `(organization_id, user_id)` (`:140-143`) | no unique yet (H3 adds one) | Copy as is. Roles are `owner`, `admin` and `member` on both sides (`src/lib/org-permissions.ts`; `origin/main:.../server/org-roles.ts`). |
| timestamps | `timestamptz` | `integer` ms | Convert in the import script. |

**Password hashes are byte-compatible.**
- OpenSEO runs `better-auth@1.6.22` (`package.json:99`). The gateway runs `1.7.7` (`apps/every-app-gateway/package.json`).
- Both resolve `@better-auth/utils@0.4.2`: OpenSEO's lockfile, and the 1.7.7 `package.json:466` dependency.
- That package hashes with scrypt N=16384, r=16, p=1, dkLen=64, over the NFKC-normalised password with a 16-byte hex salt. It stores `"<salt-hex>:<key-hex>"` and uses no secret or pepper (`node_modules/.pnpm/@better-auth+utils@0.4.2/.../dist/password.node.mjs:3-8, 30-34`; the 0.5.0 copy in the gateway's tree has the same constants).
- A credential `account.password` row copied verbatim therefore verifies on the gateway. **Verified from code.**

**Google sign-in after import.**
- In 1.7.7, a Google sign-in whose `(provider_id, account_id)` already exists signs in directly. Otherwise it links implicitly when Google says the email is verified *and* the local user has `email_verified = true` (`requireLocalEmailVerified` defaults to true; `better-auth/dist/oauth2/link-account.mjs:136-139`).
- Import `email_verified` as is. Import Google rows with `account_id` (the Google `sub`).
- This also covers OpenSEO users whose linked Google email differs from their account email. OpenSEO allows that (`auth-config.ts:36-40`).
- Google documents `sub` as "unique among all Google Accounts and never reused" (developers.google.com/identity/openid-connect/openid-connect, fetched 2026-10-15). It does not say whether `sub` is the same across OAuth clients. That is UNVERIFIED, and it only matters if the gateway uses a different Google client.

**Sessions should not be imported.**
- The browser holds OpenSEO's session cookie for host `app.openseo.so`. The cookie value is the token plus an HMAC under OpenSEO's `BETTER_AUTH_SECRET`.
- The gateway session lives on `app.everyapp.com`, and app hosts get per-host `__Host-` cookies (H8). No browser will ever present the old cookie to a host that could use it.
- Everyone signs in once. Passwords and Google work unchanged. Pending invitations survive if imported, because H9 auto-accepts pending invitations by email at sign-in.

**OpenSEO's data is keyed to these ids, which is why ids must be kept.**
- Product tables reference `user.id` and `organization.id` by foreign key: `projects`, GSC and GA4 connections, SAM sessions and more (`src/db/pg/app.schema.ts:34-39, 63-65, 360-362, 423-425`; `gsc.schema.ts:20-22`; `ga4.schema.ts:16-18`; `sam.schema.ts:22-24`).
- OpenSEO's MCP credentials carry the same ids. OAuth grant props hold `userId` and `organizationId` (`src/server/mcp/context.ts:11-13, 49-51`). API keys use `referenceId = userId` (`src/server/mcp/api-key-auth.ts:104`).
- If gateway ids equal OpenSEO ids, none of this moves. If they differ, every one of those rows, every OAuth grant in `OAUTH_KV` and every `oseo_` key would need rewriting.

**In `everyapp` mode OpenSEO still needs local identity rows.**
- They are foreign-key targets.
- Its `apikey` plugin needs them too, and so does the GSC/GA token encryption, which keeps using OpenSEO's own `BETTER_AUTH_SECRET`.
- OpenSEO already has the right pattern: `ensureUserRecord` upserts a user row from an externally authenticated identity (`src/middleware/ensure-user/delegated.ts:22-56`). In `everyapp` mode, OpenSEO upserts shadow `user`, `organization` and `member` rows from the gateway JWT. Authorization uses the JWT's `org_id` and `org_role`, never the shadow member table.
- The JWT carries only `email`, `org_id`, `org_role`, `chan`, `act`, `scopes` and `jti` (`origin/main:packages/sdk/src/internal/protocol.ts:80-91`). No display name and no org name. OpenSEO falls back to the email local part, as `delegated.ts:18-20` does, unless H18 adds `name` and `org_name` claims.

### 2.2 The three identity options compared

| | (a1) Import into the gateway D1 with the same ids | (a2) Sign in once at openseo.so and link to an Every App account | (a3) OpenSEO keeps its own auth and trusts the gateway JWT by email |
|---|---|---|---|
| User effort | Sign in once with the same password or Google | Sign in twice, then a link step | none at first |
| OpenSEO data rewrite | none (ids kept) | Map table or rewrite of user and org foreign keys | none |
| Long-term state | One identity system | Two auth systems forever, plus a mapping table | Two identity systems. Email is the join key (email changes, reuse, unverified addresses) |
| Fits "gateway is the one door" | yes | partly | no: OpenSEO stays its own door |
| Size | ~2 d tooling (C1) | ~4 d (link flow on both sides, mapping, edge cases) | ~1 d, then permanent drift |

(a1) wins. (a2) is worth having only for users who already have a separate Every App account, and at prototype scale those can be handled by hand (§3.1).

### 2.3 Autumn: one customer-id rule settles both D5 and Q1

**What OpenSEO does today.**
- The Autumn customer id is the org id, and the email is the first user's (`src/server/billing/subscription.ts:31-49`).
- The Every App design sets the customer id to `organizations.id` (README H13, `autumn-billing-platform.md` §2.2).

**The rule.** "Autumn customer id = gateway `organizations.id`, always", with identity import keeping OpenSEO's org ids.
- Under that rule D5 ("create Every App orgs with OpenSEO's org ids") and Q1 ("new customer ids = Every App org ids") say the same thing.
- They conflict only if an OpenSEO org were re-created in the gateway with a fresh id. This plan forbids that.

**Facts that settle the Autumn mechanics:**

- **Customer ids can change.** `customers.update` takes `new_customer_id` ("New ID for the customer"). Source: https://docs.useautumn.com/api-reference/customers/updateCustomer (the `.md` export, fetched 2026-10-15, body field `new_customer_id`). The docs don't say whether a rename keeps the Stripe link, subscriptions, balances, outstanding locks, entities and event history. UNVERIFIED. Don't rely on it except for a rare manual merge.
- **`billing.import` is the wrong tool here.** It "image[s] a customer into Autumn for live migration. Read-only against processors": it adopts existing Stripe subscriptions into Autumn plans (`customer_id`, `processors[]`, `billables[]` with `link.subscription_id`, `plan`, `balances[]`, `dry_run`). Sources: https://docs.useautumn.com/api-reference/billing/import, and the concierge CSV path at https://docs.useautumn.com/documentation/getting-started/migration (both fetched 2026-10-15). Our customers are already in Autumn, in the same org and the same Stripe account.
- **Multiple webhooks per environment are supported.** `webhooks.list` "lists every webhook in the environment", and `webhooks.create` lets you choose the id (https://docs.useautumn.com/llms.txt index → api-reference/webhooks/*, fetched 2026-10-15). The gateway's `/api/billing/autumn` endpoint can run next to OpenSEO's `/api/autumn/webhook` (`src/server.ts:157`) during the switch.
- **Plan versions grandfather existing customers.** Editing a plan that has customers "will create a new version" and applies it only to new purchases. Existing customers stay on the old version until migrated, and a migration carries usage over (https://docs.useautumn.com/documentation/customers/versioning, fetched 2026-10-15).
  - So adding the `apps` entity feature to plans (H13) does not reach today's base-plan v4 and yc-plan subscribers without a migration.
  - Whether `entities.create` fails when the customer's plan lacks `apps` is README R11 and still UNVERIFIED.
  - **Consequence: don't create entities at cutover.** Attribute usage through `properties.app` and enforce per-app caps in the `OrgWallet`, as `openseo-fit.md` §2.3 already allows.
- **The sandbox is Stripe's sandbox.** "Every new Autumn org gets a Stripe Connect sandbox account" (https://docs.useautumn.com/documentation/concepts/stripe, fetched 2026-10-15).
  - D5 builds the Every App catalog in sandbox `everyapp`. If hosted sign-ups open while the gateway bills through that sandbox, anyone can "buy" credits with a Stripe test card, while the gateway pays DataForSEO and OpenRouter with live keys.
  - This is a real-money hole that D5 doesn't mention. That test cards succeed in Autumn's sandbox checkout is UNVERIFIED, but it is how Stripe sandboxes work.

**The two credit pools.**
- OpenSEO tracks and locks the *credit systems* `usage_credits` and `topup_credits` directly. It never tracks the metered features (`openseo-fit.md` §1.7.1).
- Both credit systems map the same metered features (`seo_data_usage`→1, `llm_usage`→1; `autumn-billing-platform.md` §1.3).
- H13's "track the metered feature, fold top-ups into one credit feature" therefore can't work while any customer still holds `topup_credits`. With two credit systems over one metered feature, Autumn's choice of which pool to draw is undocumented (UNVERIFIED).
- The wallet has to keep OpenSEO's rule: monthly `usage_credits` first, then `topup_credits`, tracked by credit-system id (`subscription.ts:299-415`). Do that until no customer holds `topup_credits`.

### 2.4 What is in flight at the moment of cutover

| In flight | Where it lives | Lifetime | What the cutover must do |
|---|---|---|---|
| DataForSEO batch holds (`dfs_<org>_<uuid>`) | Autumn locks taken by `holdCredits` (`subscription.ts:259-279`) | 30 min TTL (`HOLD_TTL_MS`, `:208-210`). Settled in the request or in `waitUntil` (`dataforseo/client.ts:320-377`) | Nothing. The old code settles them. A lock left behind expires and is released with no charge, so we eat at most one request's provider cost per org. |
| Site-audit rendering holds (`render_<org>_<uuid>`) | Autumn locks whose ids travel in the `SiteAuditWorkflow` payload (`SiteAuditWorkflow.ts:49, 156-162`; `rendering-billing.ts:39-91`) | Up to 24 h minus 1 min (`rendering-billing.ts:25`) | Keep a legacy settle path. If a payload carries Autumn lock ids, finalize them through Autumn. Keep `AUTUMN_SECRET_KEY` on the audit Worker until the last such lock has expired (≥24 h). Only then delete Autumn mode. |
| Rank-check Workflow steps | DataForSEO calls inside steps, each with its own 30-min hold | minutes | A step that re-runs on new code (UNVERIFIED whether running instances pick up new code) goes through the gateway pack. The old lock expires unconfirmed: no double charge, at most one duplicate provider call. |
| Autumn balance | Autumn | n/a | The wallet's first snapshot reads `remaining`. Whether that figure is already net of outstanding locks is UNVERIFIED. If it is, the wallet is briefly conservative. Lock expiry and finalize send no webhook, so H13's 60 s active-org refresh catches the release. |
| `topup_credits` balances | Autumn | until spent | Nothing moves. The wallet treats them as a second pool. The top-up add-on gets a new version that grants one-off `usage_credits`, so new purchases land in the main pool, old balances drain, and grandfathering keeps old purchases intact. |
| SAM's chunked `track` | `SamChatAgent.ts:64, 398-452` | < $0.05 per session | Accept the loss. SAM has been hidden since 2026-10-01 (`db8bde17`). |
| Lifecycle-email state | `billing_customer_status` in OpenSEO Postgres (`src/db/pg/billing.schema.ts:8-21`) | permanent | Copy the rows into the gateway's table at import. Without a stored row the sync sends no email (`customer-status-sync.ts:23-26`), so skipping the copy is safe, but then the first real `payment_failed` after cutover goes unannounced. |

### 2.5 The domain, MCP, OAuth callbacks and Cloudflare accounts

**One account holds everything today** (Cloudflare API read, 2026-10-15). The account is "Bensenescu@gmail.com's Account" (`23bc28f0…`).
- Zones: `openseo.so` (Enterprise) and every `everyapp.*` zone.
- `app.openseo.so` and `www.app.openseo.so` are Workers Custom Domains on the `open-seo` Worker (`deploy/alchemy/alchemy.run.ts:429`).
- Also in that account: the `open-seo-audit` Worker, the Workflows `site-audit-workflow` and `rank-check-workflow` (account-scoped names, `alchemy.run.ts:502-522`), the R2 bucket `open-seo`, KV `every-super-seo` and `OAUTH_KV`, and Hyperdrive `openseo` pointing at PlanetScale Postgres (`alchemy.run.ts:74-80, 128-150`).

**Zone hold.** `openseo.so` has an active zone hold: `{"hold": true, "include_subdomains": false}`. Cloudflare's SaaS provider guides say a hold blocks custom-hostname activation for the domain, and only "Also prevent Subdomains" blocks a subdomain (https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/provider-guides/kinsta/, fetched 2026-10-15). With `include_subdomains: false`, an `app.openseo.so` custom hostname should activate. UNVERIFIED until tried.

**Service bindings are same-account only.** "The name of the target Worker … This Worker must be on your Cloudflare account" (https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/, updated 2026-10-13).
- H17's platform tier (gateway → catalog Worker over a service binding; catalog Worker → `AppGateway` broker with props) therefore requires OpenSEO's production Worker to sit in the **same account as the hosted gateway**.
- D7's default is a *new* hosted-only account. So moving existing customers either moves OpenSEO's production resources into that account, or changes D7, or replaces the binding with cross-account HTTPS plus a bearer credential (the weak option C in README A2).
- `raw/r2-unit-economics-and-limits.md:69` already lists `open-seo` and `open-seo-audit` among the hosted account's platform Workers. That assumes the move.

**Cross-account custom hostnames (O2O).** If OpenSEO moves to the hosted account and `openseo.so` stays in the founder's account:
- `app.openseo.so` becomes a proxied CNAME to the hosted content zone's SaaS target. That is O2O: "settings configured in your Cloudflare zone will be applied to the traffic first", and the provider sees `cf-connecting-o2o: 1` (https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/how-it-works/, fetched 2026-10-15).
- A `*/*` route is recommended because O2O affects which route pattern matches (WfP hostname routing, updated 2026-09-24).
- Zero downtime: pre-validate the hostname and certificate (TXT), then flip the CNAME (https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/, fetched 2026-10-15).
- The existing Workers Custom Domain on `app.openseo.so` must be removed first. A Worker on the customer zone that matches the hostname "may block or interfere" (O2O product compatibility, updated 2026-09-08).

**MCP is a distribution channel bound to this URL.**
- OpenSEO's plugins for Claude, Cursor and Codex point at `https://app.openseo.so/mcp` (`plugins/openseo/.mcp.json:1-8`). OpenSEO went through Claude directory review recently (`e0a58757`).
- That endpoint is OpenSEO's own OAuth authorization server (`openSeoOAuthProvider`, `src/server.ts:161`) with grants in `OAUTH_KV`, plus `oseo_` API keys in Postgres.
- The hosted perimeter strips `Authorization` and refuses OAuth tokens on app hosts (README C4/H4; `hostnames-certs-cookies.md` §5).
- Moving OpenSEO's tools to Every App's `/mcp` (ToolBus) means every connected client re-authenticates, the plugins and the directory listing change, and existing `oseo_` keys stop working.
- Keeping `app.openseo.so/mcp` alive means the gateway must pass those machine paths, with `Authorization`, to OpenSEO's own OAuth server and API keys. With the same ids and the same `OAUTH_KV`/Postgres, every existing connection keeps working.

**Google OAuth needs a fixed callback host.**
- GSC and GA4 connections build `redirect_uri` from the request's public origin (`src/server/features/google/googleOAuth.ts:60, 68, 97-101`).
- Google requires an exact match ("The value must exactly match one of the authorized redirect URIs"), and "Redirect URIs cannot contain … Wildcard characters ('*')" (https://developers.google.com/identity/protocols/oauth2/web-server, fetched 2026-10-15).
- Per-org hosts (`openseo-<orgKey>.<content>`, the default in `hostnames-certs-cookies.md` Q5) therefore can't each be a redirect URI. One fixed host must take the callback and relay to the org host.
- `app.openseo.so` is already registered and verified for these sensitive scopes. Adding new domains to a verified Google app may trigger re-verification (UNVERIFIED). Using `app.openseo.so` as the relay avoids the question.

**What app.openseo.so actually serves.**
- It is one host for every org. The org comes from the session's active org and the switcher (`src/middleware/ensure-user/hosted.ts:25-71`).
- The hosted perimeter takes the org from the host (H3) and binds the per-host cookie to it (H8).
- Serving the OpenSEO UI on `app.openseo.so` for many orgs would need a second org-resolution mode in the perimeter.
- A launcher is cheaper. `app.openseo.so/<path>` 302s to `openseo-<orgKey>.<content>/<path>`, picking the org that owns the project in the path, or else the user's last-active org that has OpenSEO installed. Only the machine paths stay on `app.openseo.so`.

### 2.6 DataForSEO: one platform account

**Limits.** From the DataForSEO help center, "Rate Limits and Request Limits", page marked "Updated 15.10.2026" (https://dataforseo.com/help-center/rate-limits-and-request-limits, fetched 2026-10-15):

| Limit | Value | Which OpenSEO calls hit it |
|---|---|---|
| General | **10,000 requests/min** ("The general rate limit for DataForSEO API is 10,000 requests per minute"). The sandbox page still says 2,000/min (https://docs.dataforseo.com/v3/appendix/sandbox/, undated). Treat 2,000 as the conservative figure. | everything. Never the binding limit in practice. |
| Simultaneous requests, database-backed APIs | **30**: "Content Analysis, DataForSEO Trends, DataForSEO Labs, Backlinks, AI Optimization, and OnPage APIs". The LLM Scraper (ChatGPT, Gemini) is exempt at 10,000/min | Labs (13 call sites), Backlinks (summary, referring_domains, history, domain_pages_summary, backlinks), AI Optimization `llm_mentions` and `*/llm_responses`, OnPage Lighthouse (`src/server/lib/dataforseo/{labs,backlinks,ai,lighthouse}.ts`). **This is the binding limit.** |
| Live Google Ads (Keyword Data) | **12 requests/min** | `keywords_data/google_ads/search_volume/live` and `keywords_for_keywords/live` (`src/server/lib/dataforseo/google-ads.ts:64, 87`), on the keyword-research path. **The tightest limit, and it is shared by every org.** |
| Live Google Trends | 250 tasks/min across all DataForSEO users | not used |
| `appendix/user_data` | 6/min | ops script only (`scripts/dataforseo-account-usage.ts`). The pack denies it (README C3). |
| `tasks_ready` | 20/min | denied by the pack (README C3) |

The page does not say whether limits apply per account or per login, which HTTP status or error code a concurrency refusal returns, or whether rate-limit headers are sent. All three are UNVERIFIED.

**Fan-out per user action is small.** For example, the backlinks overview runs `summary` and `history` in parallel (`src/server/features/backlinks/services/backlinksServiceData.ts:122-134`), and the prompt explorer runs one call per model (`promptExplorer.ts:63`). So 30 slots serve roughly 8-15 simultaneous user actions across *all* orgs. Today that is shared only among OpenSEO's own orgs. On hosted Every App it is shared with every org and every app that gets the `dataforseo` grant.

**Sandbox.** `sandbox.dataforseo.com/v3/...` is "completely free for any registered user", returns "dummy data" with the production structure, and is reached by swapping the host only (https://docs.dataforseo.com/v3/appendix/sandbox/, fetched 2026-10-15). The page gives explicit instructions for Labs, Backlinks and Business Data, and says "any DataForSEO API". AI Optimization and Lighthouse are not named (UNVERIFIED). Whether the sandbox takes the same credentials isn't stated (UNVERIFIED).

**One shared balance.** DataForSEO is prepaid. If the platform balance hits zero, every org's calls fail together. The `OrgWallet` caps each org's spend in credits, but nothing watches the provider balance.

### 2.7 Sources (web, all fetched 2026-10-15)

- DataForSEO rate limits (page updated 15.10.2026): https://dataforseo.com/help-center/rate-limits-and-request-limits and https://dataforseo.com/help-center/rate-limits-and-request-limits/amp
- DataForSEO sandbox (undated): https://docs.dataforseo.com/v3/appendix/sandbox/
- Google OAuth web server flow, redirect URI rules: https://developers.google.com/identity/protocols/oauth2/web-server
- Google OpenID Connect, `sub` claim: https://developers.google.com/identity/openid-connect/openid-connect
- Autumn update customer (`new_customer_id`): https://docs.useautumn.com/api-reference/customers/updateCustomer
- Autumn `billing.import`: https://docs.useautumn.com/api-reference/billing/import
- Autumn migration guide: https://docs.useautumn.com/documentation/getting-started/migration
- Autumn plan versioning: https://docs.useautumn.com/documentation/customers/versioning
- Autumn feature entities: https://docs.useautumn.com/documentation/customers/feature-entities
- Autumn Stripe concepts (default sandbox): https://docs.useautumn.com/documentation/concepts/stripe
- Autumn webhooks API (list, create, sync): https://docs.useautumn.com/llms.txt → api-reference/webhooks/*
- Cloudflare service bindings (updated 2026-10-13): https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
- Cloudflare O2O: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/how-it-works/; product compatibility (updated 2026-09-08): https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/product-compatibility/
- Cloudflare hostname validation, migrating a hostname: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/
- Cloudflare WfP hostname routing, O2O (updated 2026-09-24): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/hostname-routing/
- Cloudflare zone holds and SaaS (provider guide): https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/provider-guides/kinsta/
- Live reads, Cloudflare API, 2026-10-15: `GET /zones`, `GET /zones/a0268cc2…/hold`, `GET /accounts/23bc28f0…/workers/domains?zone_name=openseo.so`

---

## 3. Recommendation

### 3.0 In one paragraph

- **During the prototype, existing app.openseo.so customers don't move.** Hosted Every App gets OpenSEO as a catalog app on a *second deployment* of the same code, in the hosted account, with its own throwaway database. Only new Every App sign-ups use it.
- **The real cutover is a separate, single-window milestone.** It happens after hosted is stable, and it:
  - imports OpenSEO's Better Auth identities into the gateway with the **same ids**;
  - keeps the **Autumn customer id = org id**, so no Autumn customer writes are needed;
  - leaves `topup_credits` as a second wallet pool that drains;
  - settles in-flight Autumn locks through a 24-hour legacy path;
  - moves OpenSEO's production Worker into the hosted account;
  - turns `app.openseo.so` into a gateway "catalog home host": the UI redirects to per-org hosts, and `/mcp`, OAuth and Google callback paths stay at the same URLs.
- Rollback stays lossless until Autumn mode is deleted 24 h later, because ids, the Postgres database and Autumn customers are shared by both modes.

### 3.1 (a) Identity: import with the same ids (a1)

- **Scope.**
  - Import `user`, `organization`, `member`, pending `invitation`, and `account` rows where `provider_id IN ('credential','google')` with Google tokens nulled.
  - Don't import `session`, `verification` or `apikey`. The `oseo_` keys stay in OpenSEO and keep working on `app.openseo.so/mcp`.
  - Don't import the GSC/GA `account` rows.
- **Gateway-side rows per imported org:**
  - `organization_keys`: a random-suffix key, per H9.
  - `organization_platform` and `billing_customers` with `autumn_customer_id = organizations.id`.
  - An OpenSEO install row in `apps` (`tier='platform'`, `catalog_app_id='openseo'`, per H17).
  - Copied `billing_customer_status` snapshots.
- **Collision rule.** OpenSEO ids win. Hosted prototype data is disposable (founder memory: `thecomeup.cc` is disposable, no backcompat). Either import before hosted sign-up opens to strangers, or wipe hosted prototype users whose emails collide. If a merge must be kept, rewrite the gateway-side rows of the prototype user (members, PATs, `mcp_connections`) onto the OpenSEO id. That set is small.
- **OpenSEO in `everyapp` mode:**
  - Upserts shadow `user`, `organization` and `member` rows from the JWT, the `delegated.ts` pattern.
  - Hides team management (invite, transfer ownership, members), because the gateway owns it.
  - Keeps `BETTER_AUTH_SECRET` as the key for GSC/GA token encryption and the `apikey` plugin.
- **Cost to change later.** Low before cutover. After cutover, going back to OpenSEO-owned auth means exporting gateway users back out: same ids, so about 1 d.

### 3.2 (b) Autumn: one rule, and no customer writes at cutover

**The rule (D5, refined).**
- **Autumn customer id = gateway `organizations.id`, always.**
- New Every App orgs, including people who first meet OpenSEO through Every App, get fresh ids and fresh customers through H9/H13's `customers.get_or_create`.
- Imported OpenSEO orgs keep their ids, so their Autumn customer, Stripe customer, subscriptions and balances carry over untouched.
- Never rename customers. `new_customer_id` exists but its side effects are unverified. Never use `billing.import`: it adopts outside Stripe subscriptions, and ours are already in Autumn.

**Autumn steps, in order:**

1. **Before cutover.**
   - Create the gateway webhook in the live env next to OpenSEO's. Both receive `billing.updated`. The gateway's handler only refreshes wallets for orgs it has imported.
   - Rename the display names (`base-plan` → "Every App Pro"). **Keep the plan ids**, so no subscription is re-attached.
   - Publish a new version of `credit-top-up` that grants one-off `usage_credits`. Grandfathering leaves old purchases alone.
2. **At cutover.**
   - Prewarm an `OrgWallet` snapshot for every imported org (`customers.get`, under the 10k req/s per-customer limit).
   - Don't create entities.
3. **24 h after cutover.**
   - Delete OpenSEO's webhook and its Autumn mode.
4. **Later.**
   - Add the `apps` feature with a plan-version migration, then create entities.
   - Optionally move residual `topup_credits` into one-off `usage_credits` with an idempotent `balances.create` per customer. Or just let them drain.

**H13 changes that follow from this:**
- The wallet tracks the **credit-system ids** with two pools (`usage_credits`, then `topup_credits`) until the last `topup_credits` balance is gone.
- Feature attribution goes in `properties`.
- Entity creation is deferred.

**In-flight holds and top-ups:** as in §2.4. Legacy settle for Autumn locks for 24 h. No balance moves.

**Sandbox safety (new; it belongs in D5).** While Every App bills through the Autumn sandbox, hosted sign-ups are invite-only, or the gateway's provider packs point at provider sandboxes (DataForSEO sandbox; an OpenRouter key with a $5 daily `limit`). Live provider keys go together with live Autumn.

**Cost to change later.** The id rule is free while no one has moved. After cutover, any other rule means a per-customer rename (`new_customer_id`) and an audit of the Stripe links.

### 3.3 (c) Domain: OpenSEO keeps its own perimeter until cutover; then app.openseo.so becomes a gateway "catalog home host"

**Until cutover.** `app.openseo.so` stays exactly as it is: OpenSEO's own auth, Autumn billing and MCP. That is option (c3).
- One addition: `app.openseo.so` hosts a tiny **OAuth callback relay** for the Every App deployment.
- The Every App OpenSEO starts the GSC/GA flow with `redirect_uri=https://app.openseo.so/api/gsc/oauth/callback` and `state=<orgKey>.<nonce>`.
- `app.openseo.so` sees an Every App state prefix and 302s, with code and state, to `openseo-<orgKey>.<content>/api/gsc/oauth/callback`.
- There the Every App deployment validates the single-use state it stored, as today (`googleOAuth.ts:193-305`). The relay never sees tokens.
- That keeps Google's verified redirect URI and domain unchanged.

**At cutover.** `app.openseo.so` is attached to the hosted gateway as a `catalog_home` hostname for the `openseo` catalog app. It is not org-bound.
- **Machine paths pass through to the OpenSEO platform Worker with `Authorization` intact.** This is allowed only for `trust: catalog` apps. The paths are `/mcp`, `/.well-known/oauth-*`, `/authorize`, `/token`, `/register`, `/oauth/*`, `/api/gsc/oauth/callback` and `/api/ga4/oauth/callback`.
  - OpenSEO's OAuth server and `oseo_` keys keep authenticating them.
  - OpenSEO's `/authorize` consent page reads the user from the gateway identity, through the handoff on `app.openseo.so`, instead of its own Better Auth session.
- **Every other path 302s to `openseo-<orgKey>.<content>/<path>`.**
  - The org is the one that owns the project in the path (an RPC to OpenSEO), or the user's last-active org with OpenSEO installed.
  - `www.app.openseo.so` does the same.
- **How the hostname attaches** depends on D14 (§5):
  - If the hosted gateway lives in the same account as the `openseo.so` zone (D14 b, or the zone moves): a Workers Custom Domain on the gateway Worker.
  - Otherwise (D14 a, the default): one Cloudflare for SaaS custom hostname on the content zone, created by ops through the API, with TXT pre-validation and an O2O CNAME flip. This is **"H26-lite"**: no self-serve UI and no `app_hostnames` CRUD for orgs.
  - So **H26 in full is not a prerequisite. H26-lite is**, under the default account choice.

**Rejected options:**
- Serving the multi-org UI on `app.openseo.so` behind the perimeter. That needs a second org-resolution mode against H3 and H8.
- A bare redirect of all of `app.openseo.so` to per-org hosts. That breaks `/mcp`, OAuth and Google callbacks.

**Cost to change later.** Machine paths and the launcher are about 2 d of gateway code. Dropping `app.openseo.so` later means a plugin and directory update plus client re-auth (cheap in code, costly in user churn).

### 3.4 (d) DataForSEO: one account per environment, a fairness gate at the gateway, and sandbox by default

- **Accounts.**
  - During coexistence, hosted Every App uses a **separate DataForSEO login**. Every App prototype traffic then can't take app.openseo.so's paying customers' 30 slots or 12/min Google Ads budget.
  - At cutover, both move to one platform login: OpenSEO's existing account, with its prepaid balance.
  - Ask DataForSEO support whether limits are per account or per login, and for higher concurrency and Google Ads limits.
- **Fairness gate** (a new part of H18, +1.5 d): a `ProviderGate` Durable Object per pack limit class, global, one per platform.
  - `dfs:db_live`: a semaphore of 30 for Labs, Backlinks, AI Optimization (minus the LLM scraper), OnPage/Lighthouse, Content Analysis and Trends. A per-org cap of 10 in-flight. Leases carry a 120 s TTL so a dead isolate can't leak a slot.
  - `dfs:google_ads_live`: a 12/min token bucket with a per-org cap of 4/min. An org may borrow idle tokens.
  - A short queue (≤2 s), then 429 `provider_busy` with `Retry-After`.
  - Map DataForSEO's own concurrency refusal to the same error.
  - The gate is one extra Durable Object round trip on calls that take seconds anyway.
  - Per-org money stays in `OrgWallet`. The gate only shares capacity.
- **Previews and sandbox.**
  - Preview scripts and any org on a sandbox billing env go to `sandbox.dataforseo.com` with charge 0, already in H18.
  - In the prototype that is the default for the whole Every App deployment until live Autumn (§3.2).
- **Balance watch.** A gateway cron reads `appendix/user_data` every 10 min (the limit is 6/min) with the operator key, alerts below a threshold, and turns on a pack-wide 503 `provider_unavailable` at zero. That way the wallet never takes money for calls the provider will refuse.
- **Google Ads at scale.** 12/min platform-wide is the first ceiling hosted will hit. Later, move `search_volume` to the Standard method (`task_post`, 100 tasks per POST under the general limit) with a gateway-side poll. Not needed for the cutover.

### 3.5 (e) Ordered PR list (EA = every-app repo, OS = open-seo repo)

#### Stage P: prototype, new Every App sign-ups only. Existing customers are untouched.

| # | Repo | PR | Contains | Depends on | Size | Rollback point |
|---|---|---|---|---|---|---|
| P1 | EA | H13 delta: two-pool wallet, sandbox safety | Wallet tracks `usage_credits` then `topup_credits` by credit-system id with `properties.{app,feature,provider}`. Entities deferred. Live provider keys require live Autumn: otherwise provider packs run in sandbox mode, or sign-up is invite-only (`platformPolicy`) | H13 | +0.5 | Revert. `NoopBillingPort` |
| P2 | EA | H18 delta: `ProviderGate`, DataForSEO env, balance watch | §3.4 gate. `DATAFORSEO_ENV=sandbox` default until live Autumn. Separate login secret for hosted. `user_data` cron and alert | H18 | +1.5 | Gate off by flag (pack still proxies) |
| P3 | OS | H18 OpenSEO delta: shadow identity, team UI off, callback relay | `everyapp` mode upserts shadow user/org/member rows from the JWT (authorization from claims only). Team, invite and ownership UI hidden in `everyapp`. MCP off in the `everyapp` deployment. `app.openseo.so` relays GSC/GA callbacks whose `state` carries an Every App org key | H18 OS part | +1 | Revert. app.openseo.so is unaffected (mode-gated) |
| P4 | OS | `everyapp` deploy stage | Alchemy stage `everyapp` in the hosted account: `open-seo` and `open-seo-audit` Workers with `DATABASE_PROVIDER=d1`, a new R2 bucket, Workflows (new account, so names don't collide), Browser, crons, service binding to `every-app-gateway`/`AppGateway` with props. No `AUTUMN_*`, `DATAFORSEO_*`, `OPENROUTER_*`, `LOOPS_*` or `DUB_*` secrets | P3, H17 | 1 | Delete the stage. Nothing is shared with prod |
| P5 | EA | Catalog row and auto-install of OpenSEO for new orgs | `catalog_apps` row, auto-install flag (H17) | H17, P4 | 0.25 | Flag off |

#### Stage C: cutover of existing customers (only after D13 says go)

Gates before C6:
- Phase 1-2 tier-0 PRs shipped (README §5 "first outside org"), plus H8, H13 live, and H19 (portal, fix-payment, top-ups, YC promo).
- The wallet has run on **live** Autumn for Every App orgs for ≥4 weeks with daily reconciliation inside 2%.
- D14 decided.

| # | Repo | PR | Contains | Depends on | Size | Rollback point |
|---|---|---|---|---|---|---|
| C1 | OS + EA | Identity export and import | OS `scripts/export-identity.ts` (NDJSON of the §3.1 scope, read-only against prod). EA `scripts/import-openseo.ts` produces chunked D1 SQL with `INSERT … ON CONFLICT DO NOTHING`, an `import_batch` tag, a dry-run diff (counts, email and slug collisions, unique-index violations), `organization_keys`/`organization_platform`/`billing_customers`/`apps` install rows, and `billing_customer_status` copy. Rehearse against a PlanetScale branch and a scratch D1 | H7, H17 | 2 | `DELETE … WHERE import_batch=?` (lossless until imported users sign in on the gateway) |
| C2 | OS | Cutover-safe billing | `getBillingMode()` per deployment. Audit Workflow settles payload Autumn locks through Autumn and gateway holds through the gateway. `AUTUMN_SECRET_KEY` kept on the audit Worker. Webhook handler unchanged | H18 OS | 0.5 | Revert |
| C3 | OS | MCP and OAuth in `everyapp` mode | `/authorize` consent from the gateway identity. `oseo_` keys and `OAUTH_KV` grants unchanged (same ids). Tool calls bill through the pack with `x-everyapp-org` from token props, checked against installs (H17) | C2, H17 | 1.5 | Revert |
| C4 | EA | Catalog home host | `app_hostnames.kind='catalog_home'`. Machine-path passthrough with `Authorization` for `trust:catalog` only. Launcher 302 with a project→org RPC. Reserved `__Host-everyapp_*` cookies still stripped. Tests | H8, H17 | 2 | Remove the hostname row (traffic falls back to the old Worker if DNS is reverted) |
| C5 | OS + ops | Move OpenSEO prod into the hosted account (if D14 = a) | Hyperdrive in the hosted account (same PlanetScale). R2 `open-seo` copy (Lighthouse payloads `lighthouse.ts:105`; cache prefix may be dropped). `OAUTH_KV` bulk copy (list/get/put). `every-super-seo` KV dropped (caches, Dub pins). Workflows drained (no new audits 1 h before; `reconcileStaleAudits` reaps). `SamChatAgent` storage abandoned (SAM hidden). `AuditScratchpad` disposable by design (`wrangler.jsonc:77-82`). Alchemy `hosted-prod` stage re-pointed. Old resources retained (`RemovalPolicy.retain`) | D14 | 2.5 + drain | Old account resources intact. Point DNS back |
| C6 | EA (ops) | H26-lite (if D14 = a) | Content zone SaaS-enabled, originless fallback, `*/*` route, one custom hostname `app.openseo.so` (+ `www`) with TXT pre-validation, zone-hold check | H8 | 1 | Delete the custom hostname. Restore the Workers Custom Domain |
| C7 | runbook | **Cutover window (~1 h)** | (1) Email users 7 days and 1 day ahead ("sign in once; same password or Google"). (2) Freeze sign-ups on `app.openseo.so`. (3) Delta export and import (C1). (4) Prewarm wallets. (5) Gateway webhook live (created earlier). (6) Deploy OpenSEO `everyapp` mode to prod. (7) Flip `app.openseo.so` (Custom Domain removal + CNAME, or Custom Domain on the gateway). (8) Smoke tests: password sign-in, Google sign-in, MCP OAuth refresh with an old grant, an `oseo_` key, a GSC callback, a DataForSEO call with a hold and settle, a running audit settling an old lock, a portal link, a top-up | C1-C6 | 0.5 prep | **Lossless until C8**: DNS back, redeploy `AUTH_MODE=hosted`. Same Postgres, same ids, same Autumn customers. Let the wallet outbox flush first (alarm) so no usage is left unsent |
| C8 | OS | Delete Autumn mode | ≥24 h after C7 (after the last `render_` lock expired). The ~5.6k lines listed in `openseo-fit.md` §2.5, `AUTUMN_*` secrets removed, OpenSEO's Autumn webhook deleted | C7 + 24 h | 1 | Point of no return for one-command rollback (a revert restores it, ~0.5 d) |
| C9 | EA | Billing cleanup (later) | `apps` feature by plan-version migration, then entities. Optional `topup_credits` fold. Org-level `usage_limits` | C8 | 1 | Revert |

**Totals.** Stage P is about 4.25 d on top of H13/H17/H18. Stage C is about 11 d, plus a drain window and the email lead time. Lanes: C1 ∥ C2-C3 ∥ C4 ∥ C5-C6, then C7.

### 3.6 Recommended default, and what it costs to change

**Default:**
- Prototype: new sign-ups only (Stage P).
- Cutover: one window after the gates, with the same ids, the same Autumn customers, the catalog home host on `app.openseo.so`, and OpenSEO prod moved into the hosted account.

**If the founder wants existing customers moved in the prototype,** do Stage C now. That is about 11 d, plus H8, H19 and live Autumn pulled forward. The risk is moving revenue onto a system the prototype rules allow us to break.

**If OpenSEO should never share an account with tenants:** D14 (c), cross-account HTTPS with a catalog bearer credential. About +2 d. The broker trusts a secret instead of binding props.

---

## 4. Exact README.md changes

**§4 D5.** Replace the whole entry with:

> **D5. Reuse the existing Autumn org; one customer-id rule; no live provider keys on a sandbox wallet.**
> Why: the live org owns the Stripe connection, OpenSEO's paying customers and the wallet unit. Autumn customer ids are what join Every App orgs to Stripe.
> Default:
> - Reuse "Ben Senescu's Org", and build the Every App catalog in sandbox `everyapp`.
> - **Autumn customer id = gateway `organizations.id`, always.** OpenSEO orgs keep their ids when they are imported (D13), so their customers, subscriptions and balances carry over with no Autumn writes. Never rename customers (`new_customer_id` exists, but its side effects are unverified). `billing.import` is not used.
> - At cutover, keep plan ids (`base-plan` is renamed "Every App Pro"). The top-up add-on gets a new version granting one-off `usage_credits`. The wallet keeps `topup_credits` as a second pool until it drains. No entities until a plan-version migration adds `apps`.
> - **While the wallet bills through the Autumn sandbox (a Stripe sandbox that accepts test cards), hosted sign-up is invite-only, or provider packs run against provider sandboxes.**
> - Keep openseo.so on Autumn until the cutover (D13), then delete OpenSEO's billing 24 h later. Turn on Stripe Tax at hosted launch, USD only.
>
> Cost to change later: free before any customer moves. After that, a per-customer rename and a Stripe-link audit.

**§4 D7.** Append:

> OpenSEO interaction: service bindings work only within one account, so the platform tier (H17) needs OpenSEO's production Worker in the hosted account. A new account means moving OpenSEO's Worker, Workflows, R2, `OAUTH_KV` and Hyperdrive at cutover (H31), and attaching `app.openseo.so` as one SaaS custom hostname (H32), because `openseo.so` stays in the founder's account. See D14.

**§4 D2.** Replace "OpenSEO joins on the platform tier in phase 2" with:

> OpenSEO joins on the platform tier in phase 2 as a second deployment in the hosted account with its own D1, for new Every App sign-ups only. app.openseo.so customers move only at the cutover (D13, §5 Phase 3).

**§4.** Add new entries D13 and D14, worded as in §5 of this report. Renumber if another round-2 report claims these numbers.

**§4 "Defaults we will take".**
- Replace "BYO custom domains not in v1 (`*/*` route + Cloudflare for SaaS later)." with:
  > BYO custom domains not in v1. Exception: `app.openseo.so` is attached by ops as a `catalog_home` host at the OpenSEO cutover. It is a Workers Custom Domain when the zone is in the hosted account, otherwise one SaaS custom hostname (H32). It passes only `/mcp`, OAuth and third-party callback paths to OpenSEO with `Authorization`, and redirects the UI to per-org hosts.
- Replace "(fold `topup_credits` into `usage_credits`)" with:
  > (new top-ups land in `usage_credits`; `topup_credits` stays a second wallet pool, tracked by credit-system id, until no customer holds it)
- Add a new bullet:
  > DataForSEO capacity is shared through a global `ProviderGate` DO: 30 concurrent for DB-backed live APIs with ≤10 per org, live Google Ads 12/min with ≤4 per org and idle borrowing, 429 `provider_busy`. Hosted uses its own DataForSEO login until the OpenSEO cutover. Fixed third-party OAuth redirect URIs for catalog apps live on the app's home host (`app.openseo.so`), which relays to the org host.

**§5 H13, "Contains".**
- Replace "`entities.create/delete` on install/tombstone" with:
  > `entities.create/delete` on install/tombstone only after a plan-version migration grants `apps` (attribution through `properties.app` until then)
- Add:
  > Two-pool tracking (`usage_credits`, then `topup_credits`) by credit-system id. Live provider keys only with live Autumn (`platformPolicy`).

**§5 H18.**
- Gateway side, append:
  > `ProviderGate` DO for DataForSEO (above); `DATAFORSEO_ENV` sandbox default until live Autumn; separate hosted DataForSEO login; `user_data` balance-watch cron with a pack-wide 503 at zero.
- OpenSEO side, append:
  > Shadow user/org/member rows upserted from the JWT (authorization from claims only); team, invite and ownership UI hidden in `everyapp` mode; MCP off in the Every App deployment; GSC/GA callbacks relayed through `app.openseo.so` by `state` prefix; `everyapp` alchemy stage in the hosted account with D1.
- Size becomes "5.5 gateway + 7 OpenSEO (+1 deploy stage)".

**§5 H26.** Append:

> Not a cutover prerequisite. The OpenSEO cutover needs only H32 (one ops-created hostname).

**§5.** Add a new table after Phase 2, "Phase 3: OpenSEO cutover (only when D13 says go)". Rows H27-H34 = C1-C9 of this report (C7 is a runbook, not a PR):

| # | Title | Size |
|---|---|---|
| H27 | Identity export/import | 2 |
| H28 | Cutover-safe billing (OpenSEO) | 0.5 |
| H29 | MCP and OAuth in `everyapp` mode (OpenSEO) | 1.5 |
| H30 | Catalog home host | 2 |
| H31 | Move OpenSEO prod into the hosted account | 2.5 |
| H32 | H26-lite | 1 |
| H33 | Delete Autumn mode (OpenSEO) | 1 |
| H34 | Billing cleanup | 1 |

The runbook goes in a footnote. Use the dependencies and rollback columns from §3.5.

**§5 "Totals".** Append:

> Phase 3 (OpenSEO cutover) is about 11 d plus a drain window, and runs only after the tier-0 set, H8, H19 and ≥4 weeks of the wallet on live Autumn.

**§3 Tier B.** Add:

> **B9. The OpenSEO cutover was unspecified.** Identity, Autumn ids, in-flight holds, the domain, MCP continuity, Google OAuth callbacks and the account move are now covered in `raw/r2-openseo-cutover.md`. Smallest change: Stage P now, Phase 3 later.

**§6.** Add rows:

| # | Risk | Status | Live check | If it goes wrong |
|---|---|---|---|---|
| R24 | Autumn sandbox checkout accepts Stripe test cards, so live provider spend can be "paid" with test money | Docs: sandbox = Stripe Connect sandbox | Sandbox attach of Pro with `4242…` | Invite-only or provider sandboxes until live Autumn (D5) |
| R25 | `customers.update.new_customer_id` keeps Stripe, subscriptions, balances, locks, entities and events | undocumented | Rename a sandbox customer that has a paid plan and a lock | Never rename (default already) |
| R26 | Autumn `remaining` is net of outstanding locks; lock expiry sends no webhook | undocumented | Lock 100 in sandbox, read the customer, let it expire | Wallet refresh cadence covers it |
| R27 | DataForSEO limits per account vs per login; concurrency error code | not stated | Ask support; two logins in parallel | Fairness gate per login |
| R28 | Running Workflow instances pick up newly deployed code | unverified | Sleep an instance, deploy a no-op change, log the version | Legacy settle path covers both |
| R29 | An `app.openseo.so` custom hostname activates under the zone hold (`include_subdomains:false`) | likely | Create with TXT pre-validation | Release the hold briefly, or move the zone |
| R30 | Adding Every App domains to OpenSEO's verified Google OAuth client triggers re-verification | unverified | Google Cloud console | Keep all redirect URIs on `app.openseo.so` (default) |

**§7 Appendix.** Add rows:

1. "D5 (keep OpenSEO org ids) vs openseo-fit Q1 (new ids = Every App org ids)": *resolved*. With import keeping ids, both say "customer id = gateway org id". (this report)
2. "Autumn customer id is immutable": *refuted*. `customers.update` has `new_customer_id`; its side effects are unverified. (this report)
3. "Track the metered feature and fold top-ups into one credit feature" (H13, defaults): *qualified*. Both credit systems map the same metered features, so the wallet tracks credit-system ids with two pools until `topup_credits` drains. (this report)
4. "Catalog apps get per-org hostnames" (hostnames Q5): *qualified*. Google OAuth needs exact, wildcard-free redirect URIs, so catalog apps with third-party OAuth keep one fixed callback host (the app's home host) that relays to the org host. (this report)

---

## 5. New founder decisions

**D13. Do app.openseo.so's existing customers move onto hosted Every App during the prototype, or only new sign-ups?**

Why it matters:
- Moving puts paying customers, Stripe subscriptions and a directory-listed MCP connector on a system the prototype rules allow us to break.
- Not moving means a person can hold two OpenSEO accounts and two wallets for a while.

Options:
- (a) New sign-ups only, cutover later in one window.
- (b) Cut over now.
- (c) Never: OpenSEO stays standalone and Every App only lists it.

**Default: (a).** The cutover runs after the tier-0 set, H8 and H19, plus ≥4 weeks of the wallet on live Autumn.

Sub-defaults:
- The cutover moves everyone in one window, not per org.
- `app.openseo.so` becomes a catalog home host (launcher + MCP + callbacks).
- Users sign in once.

Cost to change later: (a)→(b) means pulling about 11 d of Phase 3 and its prerequisites forward. (a)→(c) costs nothing.

**D14. After the cutover, which Cloudflare account runs OpenSEO production?**

Why it matters: service bindings are same-account only. The `openseo.so` zone, OpenSEO's Workflows, R2, `OAUTH_KV` and Hyperdrive all live in the founder's account today. D7 puts hosted in a new account.

Options:
- (a) Move OpenSEO prod into the hosted account. `openseo.so` stays, and `app.openseo.so` becomes one SaaS custom hostname (H31 + H32, about 3.5 d). OpenSEO then shares fate with tenant code.
- (b) Make the founder's existing account the hosted account (D7 flips). A Workers Custom Domain suffices, but tenant code then shares an account with every other project and zone.
- (c) Keep OpenSEO in its own account and reach it over HTTPS with a rotated catalog bearer credential in both directions (about +2 d; weaker broker identity).

**Default: (a).**

Cost to change later: each account move is about 2.5 d plus a Workflow drain. (a)→(c) adds the credential path.

**D5 (refined; replaces the README entry, §4 above).** Two questions for the founder:
- The customer-id rule. Default: org id, always; never rename.
- Whether hosted sign-up may open to strangers while billing runs in the Autumn sandbox. Default: no. Invite-only, or provider sandboxes, until live Autumn.

---

## 6. UNVERIFIED items and the live check that settles each

| # | Item | Live check |
|---|---|---|
| U1 | DataForSEO limits apply per account or per login; the HTTP status and error code for "too many simultaneous requests"; whether rate-limit headers are sent | Email DataForSEO support. Then fire 35 parallel Labs live calls from one login and record the 31st response |
| U2 | DataForSEO's general limit is 10,000/min (help center, 15.10.2026) vs 2,000/min (sandbox page) | Ask support, or read `X-RateLimit-*` headers if present on a live call |
| U3 | DataForSEO sandbox accepts the production credentials and serves AI Optimization `llm_responses` and OnPage Lighthouse | One call to each against `sandbox.dataforseo.com` with the prod login |
| U4 | `customers.update({new_customer_id})` keeps the Stripe link, subscriptions, balances, locks, entities and events | Sandbox: a customer with `base-plan`, one lock and one entity; rename; `customers.get` with expand; finalize the lock |
| U5 | Autumn `remaining` excludes amounts held by outstanding locks, and lock expiry or finalize sends no webhook | Sandbox: `check` with a lock of 100, `customers.get`, wait for expiry, watch the webhook log (`searchRequestLogs`) |
| U6 | The Autumn sandbox checkout succeeds with Stripe test cards | Sandbox `billing.attach` of a paid plan, paying with `4242 4242 4242 4242` |
| U7 | `entities.create` fails or overages when the customer's plan lacks the `apps` feature (README R11) | Sandbox: create an entity for an `onboarding_plan` customer |
| U8 | Autumn draws from `usage_credits` or `topup_credits` when tracking the shared metered feature `seo_data_usage` | Sandbox: a customer with both balances; `track` `seo_data_usage` 10; read both |
| U9 | A running Workflow instance resumes on newly deployed code | Scratch Worker: an instance with `step.sleep(2m)` that logs a version constant after the sleep; deploy a new constant during the sleep |
| U10 | The Google `sub` is the same across OAuth clients and projects | Sign in with one Google account through two OAuth clients in different projects; compare `sub`. (Mitigated anyway by implicit linking on verified email, `link-account.mjs:136-139`) |
| U11 | Adding redirect URIs or domains to OpenSEO's verified Google OAuth client triggers re-verification of sensitive scopes | Google Cloud console, OAuth consent screen, or Google support. Avoided by the default (relay on `app.openseo.so`) |
| U12 | An `app.openseo.so` custom hostname on another account's SaaS zone activates under `hold:true, include_subdomains:false` | Create the hostname with TXT pre-validation on a scratch SaaS zone; read `status` |
| U13 | An Enterprise zone (`openseo.so`) can move between accounts, and what that does to the contract | Ask the Cloudflare account team (only if D14 prefers moving the zone) |
| U14 | OpenSEO prod sizes: user, org and member counts, Google-only users, unverified users, paying customers by plan, customers with `topup_credits > 0`, R2 `open-seo` bucket size, `OAUTH_KV` key count | Read-only SQL on a PlanetScale branch (`select count(*) …` per table; `count(*) filter (where email_verified = false)`), Autumn `listCustomers` aggregated by plan (counts only), R2 bucket metrics, KV list count |
| U15 | `OAUTH_KV` values from `@cloudflare/workers-oauth-provider` stay valid after a key-by-key copy to another account's namespace | Copy one grant and one client record to a scratch namespace bound to a scratch OpenSEO; refresh a token |
| U16 | O2O traffic for `app.openseo.so` reaches the gateway's `*/*` route with `cf-connecting-o2o: 1`, and nothing on the `openseo.so` zone intercepts it once the Workers Custom Domain is removed | Scratch subdomain on `openseo.so` CNAMEd to the scratch SaaS zone; curl and log headers |
| U17 | Better Auth 1.7.7 accepts the imported 1.6.22 rows (`account.password` hashes, Google `account_id`) with no data migration | Verified from code (`@better-auth/utils@0.4.2` in both trees). Confirm with one rehearsal sign-in on a scratch hosted D1 after C1 |
