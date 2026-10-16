# MCP, OAuth and the ToolBus under many tenants

Research for the hosted (everyapp.com) tier, 2026-10-15. Scope: the gateway's
OAuth authorization server and `/mcp` connector, the ToolBus (`packages/toolbus`
and `apps/every-app-gateway/src/server/toolbus`), app-host `/mcp`, personal
access tokens (PATs), the `mcp_tool_calls` audit, and what a hosted "your agent"
needs. Paths are relative to the worktree root unless absolute. "Gateway" means
`apps/every-app-gateway`.

## TL;DR

- **The org is already carried end to end.** Consent picks one org and checks
  membership. The connection row has a non-null `organization_id`. Token props
  hold `{connectionId, userId, organizationId}`, and every `/mcp` request
  re-reads the row, the live membership and the ban state. Catalog queries
  filter by org and by `user_app_access`. The identity minted for each tool
  call carries `org_id`, and audit rows carry `organization_id` with an
  `(org, created_at)` index. One AS and one resource can serve every org
  without a schema change.
- **What breaks with many tenants is the shared, per-install budgets and
  checks:**
  - DCR's 200-a-day cap is global, so one anonymous actor can block every
    tenant's Cursor users for a day.
  - The per-IP limiter on `/oauth/token` counts server-side clients
    (claude.ai, ChatGPT) by egress address.
  - The own-domain refusal covers only the gateway host. The v2 plan puts
    apps on a separate `everyapp.host` domain, which it would miss.
  - Connecting a client to a second org silently revokes the first. This is
    deliberate and covered by a test, but wrong for hosted users who belong to
    a personal org and a team org.
  - The audit table, its 90-day global retention and its 20,000-rows-an-hour
    prune all live in the one shared D1 database.
- **There is no in-gateway agent today.** There is no Agents SDK dependency, no
  Durable Object (DO) and no chat code in the gateway or packages. Only some
  hooks are reserved: the `"agent"` identity channel (`packages/sdk/src/internal/protocol.ts:39`),
  the comment "approvals and an in-gateway agent later" (`packages/toolbus/src/execute.ts:3-4`),
  and an unused `org_blocked` policy branch (`packages/toolbus/src/policy.ts:27-31`).
  The ToolBus is already built so an agent can call `listTools(view)` and
  `executeToolCall(view, call, deps)` in-process, with no HTTP or MCP hop.
  OpenSEO's Sam (`agents` 0.22, `@cloudflare/think` 0.17) is a working template
  in the founder's own code.
- **Smallest credible plan:** about 4.5 engineer-days of tenancy hardening
  (domains, supersede, budgets, SDK org pin, D1 load), 6 days for an
  in-gateway agent DO, and 5 to 6 days for per-org audit, policy and PAT
  controls. It splits into 8 to 10 small PRs (section 3).

---

## 1. What exists today

### 1.1 The request paths

| Path | Served by | Notes |
|---|---|---|
| Host routing | `apps/every-app-gateway/src/server.ts:166-180` (gateway host), `:182-263` (app hosts) | `/mcp`, `/mcp/*` and OAuth paths are diverted before TanStack (`server.ts:108-122`) |
| `/mcp` (gateway) | `src/server/mcp-auth/routes.ts:130-139`: OAuth resource server, or PAT-only when OAuth is off (`routes.ts:82-101`) | `/mcp/*` is a hard 404 (`routes.ts:111-113`) |
| `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/oauth/token`, `/oauth/register`, `/oauth/authorize`, `/oauth/consent/decision` | `routes.ts:142-165` | `/oauth/consent` is a TanStack page (`routes.ts:161-162`) |
| AS + RS construction | `src/server/mcp-auth/config.ts:124-197`, cached per isolate by `(issuer, ttl, dcr)` (`config.ts:199-239`) | `resources: [resource]` with resource = `${issuer}/mcp` (`config.ts:129-132`) |
| Caller resolution | `src/server/mcp-auth/validate.ts:86-120` (PAT), `:129-188` (OAuth), `:196-250` (validator) | Nothing cached (`validate.ts:9-12`) |
| Gateway ToolBus surface | `src/server/toolbus/gateway-mcp.ts:48-129` | Reads catalogs from D1 only (`gateway-mcp.ts:60-66`) |
| App-host `/mcp` | `src/server/toolbus/app-host-mcp.ts:119-185`, wired as the perimeter's `interceptMcp` (`server.ts:251`) | PAT or same-origin session only |
| ToolBus runtime (one per isolate) | `src/server/toolbus/runtime.ts:71-101` | `invokeApp` goes through `getAppFetcher` (`runtime.ts:81-88`), which already takes a `dispatch` tier (a stub today: `packages/perimeter/src/getAppFetcher.ts:52-56`) |
| Hourly housekeeping | `server.ts:269-275` → `src/server/mcp-auth/maintenance.ts:124-158`; cron `17 * * * *` (`cloudflare.config.ts:116`) | |

### 1.2 Where the org is already carried

| Layer | What carries the org | Reference |
|---|---|---|
| Consent page | Lists the user's memberships and, per org, the apps they can use. The default is the session's active org. | `src/server/mcp-auth/consent.ts:72-96`, `:149-153` |
| Consent decision | Checks membership and role in the chosen org. "Selected" app ids must be usable apps in that org, checked before the consent handle is spent. | `src/server/mcp-auth/authorize.ts:216-242` |
| Connection row | `mcp_connections.organization_id NOT NULL` with an FK cascade. App choices go in `mcp_connection_apps`. | `src/db/mcp.schema.ts:81-136` |
| Token props | `{v:1, kind:"oauth", connectionId, userId, organizationId}`. Grant metadata also holds `organizationId`. | `authorize.ts:297-318`, `validate.ts:31-37` |
| Per-request re-check | The row must be active, and the props' user and org must match the row. A missing role, or a membership newer than the connection, revokes it as `member_removed`. A ban refuses. | `validate.ts:133-155`; query `src/server/repositories/McpConnectionRepository.ts:152-186` |
| Refresh | `tokenExchangeCallback` re-runs the same check. `invalid_grant` revokes the grant. | `config.ts:151-172` |
| Catalog visibility | Active apps of `principal.organizationId`, joined to `user_app_access` (user and org), narrowed to the connection's apps or the PAT's app | `src/server/repositories/AppToolRepository.ts:177-204`, `:218-286` |
| Tool-call identity | A fresh JWT per call with `orgId`, `aud = app.appId`, `chan:"mcp"`, `act`, explicit `mcp:*` scopes, and a `tc` claim | `packages/toolbus/src/execute.ts:212-226` |
| Audit | `mcp_tool_calls.organization_id` with indexes `(org, created_at)`, `(credential, created_at)` and `(created_at)` | `src/db/mcp.schema.ts:144-185` |
| Member removal / deactivation | Revokes the rows in that org (or all of them) and the grants whose metadata names that org | `src/server/services/McpConnectionService.ts:279-298` |

Conclusion: **one AS and one protected resource for all orgs works as built.**
The token never asserts more than ids, and the org boundary is enforced by D1
queries on every request. The residual risk is that tenant isolation is "query
correctness in one shared D1", not storage separation. Tests exist for
granting only the user's own orgs and for revoking only the removed org
(`src/server/mcp-auth/gateway-mcp.e2e.sqlite.test.ts:1868`, `:2156`).
There is no explicit test that a user in two orgs never sees org B's tools
through an org A connection. It is cheap to add one.

### 1.3 What assumes one install

| Assumption | Where | Why it matters hosted |
|---|---|---|
| **Connecting the same client to another org supersedes the first connection.** `supersedeEarlier` filters by user and client but not by org. A test pins this as intended. | `McpConnectionRepository.ts:106-136` (filter at `:113-119`); `McpConnectionService.ts:199-241`; test comment `gateway-mcp.e2e.sqlite.test.ts:2172-2173` | Hosted users typically hold a personal org plus invited orgs (RFC-0001). Today a Claude Code or claude.ai installation can serve one org at a time, and connecting it to a second org silently kills the first. The library's own replacement is off (`revokeExistingGrants: false`, `authorize.ts:316-317`), so this is purely our choice. |
| **DCR budget "per gateway":** 200 a day across everyone, plus 20 a day per address and 5 a minute per isolate | `src/server/mcp-auth/registration-limit.ts:26-30`, key `oauth-register:gateway:<day>` at `:114` | Registration is anonymous, so the org can't be known. One actor with ten addresses spends the global 200 and blocks every tenant's DCR-only clients (Cursor, Gemini CLI, MCP Inspector) until UTC midnight. The cap exists to protect the Free plan's 1,000 KV writes a day (`registration-limit.ts:4-7`). A hosted platform on Workers Paid pays $5 per million writes (KV pricing, updated 2026-04-21). |
| **Credential rate limits per client IP**, counted per Cloudflare location: 60 a minute on `/oauth/register` and `/oauth/token` | `src/server/auth-rate-limit.ts:46`, `:170-178`; bindings at `cloudflare.config.ts:141` | claude.ai holds tokens and refreshes them from Anthropic's servers. Anthropic documents its outbound MCP traffic as coming from `160.79.104.0/21`. Hosted, every claude.ai user's hourly refresh (access token TTL 1 h, `config.ts:39`) is counted against a small pool of addresses. Whether it bites depends on how Anthropic spreads egress, so this is a plausible risk, not yet a measured one. The token endpoint needs no brute-force limiter of this shape, because codes and refresh tokens are high-entropy. |
| **Own-domain refusal covers only the issuer host and its subdomains** | `src/server/mcp-auth/own-domain.ts:25-35`, used at `authorize.ts:96`, `:117`, `consent.ts:128-134`, `routes.ts:207-211` | Apps live under `APP_BASE_DOMAIN` (`src/server/app-hosts.ts:26-44`), which "is the gateway's own host for now" (`app-hosts.ts:8-10`). The v2 hosted sketch puts apps on `{app}-{tenant}.everyapp.host`, a different registrable domain (`docs/architecture-v2-recommendation.md` §2.6). A tenant app on `everyapp.host` could then serve a Client ID Metadata Document (CIMD) through a public route. `global_fetch_strictly_public` routes the fetch back through the front door to us (`own-domain.ts:7-12`), and the consent page would show "verified: evil-acme.everyapp.host". A tenant redirect URI there would also pass. TODO.md:38 tracks this as "only theoretical today". Hosted makes it real. |
| **Audit retention is global** (`MCP_AUDIT_RETENTION_DAYS`, default 90). The prune deletes at most 20 × 1,000 rows a run (sized for the Free plan's 50 D1 queries per invocation). | `maintenance.ts:22-41`, `:128-133`; `src/server/repositories/McpToolCallRepository.ts:6-13`, `:45-67` | That caps deletion at 480k rows a day for the whole platform, with one retention for every plan. Rows have no FK by design (`mcp.schema.ts:139-143`), so a deleted org's trail stays until it ages out. |
| **OAuth KV sweep: 50 records an hour** | `maintenance.ts:34`, `:84-87` | KV TTLs do the real expiry; the sweep is defense in depth (library `PurgeOptions`, `oauth-provider.d.ts:1765-1801`). Hosted it would take months to finish one sweep. Low priority. |
| **`MCP_ALLOWED_ORIGINS`: one list for the whole gateway** | `src/server/toolbus/gateway-mcp.ts:29-46`, `packages/toolbus/src/http.ts:250-268` | Harmless hosted. AI apps call from servers, and only browser MCP clients (Inspector direct mode) need it. Keep it empty. No per-org setting is needed. |
| **Kill switches `MCP_OAUTH_ENABLED` / `MCP_DCR_ENABLED`: one value for the whole gateway** | `src/server/oauth-flag.ts:43-54` | Fine as platform operator switches. Orgs need their own policy instead (section 2.5). |
| **No rate limit or quota on `/mcp` or tool calls** | Nothing between `routes.ts:135-138` and `executeToolCall` | Each `tools/call` invokes a tenant Worker and writes D1. Hosted needs abuse caps and a metering hook. |
| **All MCP state on one D1:** about 6 statements per `tools/call` | `validate.ts:134` (connection + membership join), `:166-169` (a `touchLastUsed` UPDATE runs on every request even when it writes nothing, `McpConnectionRepository.ts:236-252`), `AppToolRepository.ts:228-264` (a 2-statement batch that re-reads every tool row and JSON schema), `gateway-mcp.ts:87-93` → `AppToolRepository.ts:369` (on POST), `runtime.ts:57-68` (audit insert) | D1 is single-threaded per database: about 1,000 queries a second at 1 ms each, and it is shared with the control plane and the perimeter (D1 limits, updated 2026-04-21). Stateless MCP means `initialize`, `tools/list` and every `tools/call` each pay the full cost (`http.ts:1-8`). |

### 1.4 Agent / chat: what exists

- **No agent runtime.** No `agents`, `@cloudflare/ai-chat`, `@cloudflare/think`,
  `AIChatAgent`, `routeAgentRequest` or `McpAgent` anywhere outside
  `node_modules` (grep over `apps/` and `packages/`). The gateway config
  declares no Durable Object bindings (`cloudflare.config.ts:123-179`).
  "chat" in the gateway only means the OpenAI `/v1/chat/completions` route of
  the AI proxy (`src/server/ai-proxy.ts:41`, `:52`).
- **Design-only:** `docs/architecture-v2-overview.md` §1 draws a "Gateway AI agent
  (chat in home shell)" next to MCP clients feeding one ToolBus, and says "the
  agent is just another MCP-shaped client". `docs/architecture-v2-recommendation.md`
  §2.4 adds `chan=agent`, the same audit log, and inline confirmation for writes.
  Its sketched `tool_grants` (`channel 'mcp'|'agent'`) and `audit_log` tables
  were never built. `mcp_connections` and `mcp_tool_calls` replaced them.
- **Reserved hooks that exist in code:**
  - `IdentityChannel = "web" | "api" | "mcp" | "agent"` (`packages/sdk/src/internal/protocol.ts:39`).
    The SDK's tools endpoint, however, **refuses anything but `chan:"mcp"` with a `tc` claim**
    (`packages/sdk/src/server/toolsEndpoint.ts:246-252`). An agent that goes through
    `executeToolCall` mints `chan:"mcp"` anyway (`execute.ts:222`), so it
    works without an SDK change. Only the actor would differ.
  - `executeToolCall` is "the one path every tool call takes … (approvals and an
    in-gateway agent later)" (`packages/toolbus/src/execute.ts:1-16`). It and
    `listTools` are exported (`packages/toolbus/src/index.ts:19-24`, `:41`).
  - `McpPrincipal.credential.kind` is `"pat" | "session" | "dev" | "oauth"`
    (`packages/toolbus/src/types.ts:53-57`). There is no `"agent"` yet, and `actorFor`
    falls back to the user id (`execute.ts:76-85`).
  - `evaluateToolPolicy(tool, principal, org?)` already has `org_blocked`, but no
    caller passes `org` (`policy.ts:25-38`; callers `execute.ts:152`,
    `server.ts:76`, `builtins.ts:28`).
- **Prior art in the founder's code:** OpenSEO's Sam is a DO chat agent:
  `SamChatAgent extends Think` (`/Users/bensenescu/workspaces/open-seo/src/server/features/sam/SamChatAgent.ts:1`, `:127`),
  routed with `routeAgentRequest` and an auth gate in
  `onBeforeConnect`/`onBeforeRequest` (`/Users/bensenescu/workspaces/open-seo/src/server.ts:104-126`).
  It declares a SQLite DO migration (`/Users/bensenescu/workspaces/open-seo/wrangler.jsonc:40-71`),
  builds its tools in-process from the same handlers its MCP server uses
  (`samChatTools.ts:1-60`), and meters LLM spend into Autumn in $0.05 chunks
  (`SamChatAgent.ts:57-63`, `:336`, `:434`). Package pins: `agents` 0.22.0,
  `@cloudflare/think` 0.17.0, `ai` ^6 (`open-seo/package.json:82`, `:96-97`).

### 1.5 App-host `/mcp` and PATs

- An app host's `/mcp` is served from that app's snapshot (`app-host-mcp.ts:119-185`).
  The perimeter has already authenticated a PAT or a same-origin session and
  confirmed access. It offers **no OAuth** (`config.ts:7-11`; security-model
  "Agent Tools (MCP)"), so claude.ai cannot use it. Claude Code with an
  `Authorization` header can. The URL is per-org by construction, because the
  hostname encodes the org (`app-hosts.ts:4-14`).
- Sessions on app hosts must act under the app's org:
  `session.orgId !== app.organizationId` is refused
  (`src/perimeter/betterAuthAuthenticator.ts:133-136`). The session org comes
  from Better Auth's single `activeOrganizationId` (`:116-122`). A hosted user
  in two orgs therefore can't use org B's app (or its `/mcp` via session) while
  their active org is A. This is a perimeter issue. It is noted here because it
  shapes app-host `/mcp` hosted.
- PATs: `user_access_tokens` has non-null `organization_id` and an optional
  `app_row_id` (composite FK to the app in the same org)
  (`src/db/user-tokens.schema.ts:13-54`). Any org member can mint one for their
  active org (`src/serverFunctions/userTokens.ts:16-28`). Defaults are scope
  `*` (`src/server/services/UserPatService.ts:47-49`), which means MCP
  read & write (`validate.ts:77-83`), and 90 days
  (`UserPatService.ts:18`). The hash is an HMAC with `BETTER_AUTH_SECRET`
  (`UserPatService.ts:107`). Each use re-checks live membership and ban
  (`validate.ts:94-99`). There is no org-level PAT policy and no admin view of
  members' PATs or MCP connections. Users see their own connections across all
  orgs (`src/serverFunctions/mcpConnections.ts:11-16`;
  `routes/_app/settings/connections.tsx`).

### 1.6 Audit

- One row per `tools/call`, allowed or blocked, on either surface. It never
  holds arguments or results: only a keyed digest (HMAC with
  `BETTER_AUTH_SECRET`, context `every-app-gateway:mcp-args:v1`) and a byte
  count (`runtime.ts:22-69`; `packages/toolbus/src/digest.ts:14-38`). It is
  written in `waitUntil` after the response (`runtime.ts:57-68`) and mirrored
  as an `mcp.tool_call` log line (`runtime.ts:38-56`).
- There is no UI or API that reads it. "An 'Agent activity' page over the
  `mcp_tool_calls` audit table" is an open TODO (`TODO.md:29`).

---

## 2. What the hosted tier needs

### 2.1 One authorization server for all orgs: keep one resource, and make a connection mean "one org"

**Keep:** issuer `https://everyapp.com` and one resource `https://everyapp.com/mcp`.
Consent picks the org, as today.

Why not per-org connector URLs (`/o/<org>/mcp` or `<org>.everyapp.com/mcp`)?
`@cloudflare/workers-oauth-provider` 1.2.3 fixes the protected-resource
registry at construction ("The registry is fixed at construction … and
`validateToken()` rejects for a resource that is not listed",
`apps/every-app-gateway/node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.d.ts:1165-1172`).
Per-org resources would mean one AS instance per org sharing `/oauth/token`
(refreshes would land on an instance that doesn't list the grant's resource),
listing every org at startup, or an upstream change (a resource resolver
callback). Claude also requires the resource to equal the URL the user typed
(`config.ts:7-9`), so per-org URLs only help once the library supports them.

**Change:** make supersede org-scoped. Then the same client installation can
hold one connection per org, and re-consenting to the same org still replaces
the earlier one. It is a one-predicate change in
`McpConnectionRepository.supersedeEarlier` (`:113-119`) and the grant matcher in
`McpConnectionService.supersedeEarlier` (`:213-220`, which already has
`grant.metadata.organizationId`), plus flipping the test at
`gateway-mcp.e2e.sqlite.test.ts:2156-2215`. Whether a given client lets a user
add the same URL twice is the client's business. Claude Code does: two `claude
mcp add` names, one URL. Whether claude.ai's connector UI does is unverified
(section 5).

**Don't** build multi-org connections (one token spanning several orgs) for v1.
Tool names would collide (`todo_create_todo` exists in both orgs,
`packages/toolbus/src/names.ts:25-27`), the per-request principal has one
`organizationId` (`types.ts:41-59`), and the minted identity has one `org_id`.
It is a real feature with a real cost, so it is listed under founder
questions.

### 2.2 Platform domains, not "the gateway's domain"

`onGatewayDomain(value, issuer)` becomes `onPlatformDomain(value)`. It refuses
the issuer host and its subdomains, `APP_BASE_DOMAIN` and its subdomains, and
any extra platform domains (`PLATFORM_DOMAINS`, for example `everyapp.host`
and preview domains). It is used at the same four call sites. Tenant **custom
domains** (Cloudflare for SaaS) should *not* be refused. A tenant that proves
control of `tools.acme.com` is exactly who CIMD says may vouch for that
domain, and the consent page shows it.

### 2.3 Budgets that hold for N tenants

- **DCR:** make the caps configurable (`MCP_DCR_DAILY_LIMIT`,
  `MCP_DCR_DAILY_LIMIT_PER_ADDRESS`), with hosted defaults of about 20,000 a
  day globally and 20 per address. Writes cost $5 per million on Paid. Keep
  the per-isolate limiter and the fail-closed D1 read
  (`registration-limit.ts:100-141`). CIMD clients (claude.ai, ChatGPT, Claude
  Code, VS Code, Codex; `config.ts:13-17`) never touch this budget.
- **`/oauth/token`:** drop it from the IP limiter (`auth-rate-limit.ts:46`), or
  key it by `client_id` plus address so a server-side client's users don't
  share one bucket. Keep `/oauth/register` under the IP limiter.
- **`/mcp` and tool calls:** add a Workers Rate Limiting binding keyed
  `mcp:conn:<connectionId>` (abuse) and a quota check keyed by org (plan) at
  the top of `serveGatewayMcp` and `serveAppHostMcp`. The binding is
  per-location and allows 10 or 60 second windows only (rate-limit docs,
  updated 2026-10-12). That is fine for abuse caps but not for billing, so
  billing goes through the metering ledger (other researchers' subsystem) from
  the audit hook (2.8).

### 2.4 D1 load: the MCP path must stop re-reading immutable data

- Catalogs are content-addressed: tool rows are tied to `catalog_hash`
  (`AppToolRepository.ts:136-139`, `:274-281`). Split `findVisibleCatalogs`
  into (a) a live query for reachable `(appRowId, catalogHash)` pairs, which
  keeps access and revocation live, and (b) tools fetched once per isolate per
  `(appRowId, catalogHash)` and cached forever. A hash change is a cache miss
  by construction. This removes the heaviest read from every request without
  weakening "revocation applies on the next request" (`validate.ts:9-12`).
- `touchLastUsed`: skip the UPDATE when `lastUsedAt` (already read at
  `McpConnectionRepository.ts:162`) is less than 10 minutes old. Today it runs
  every request and relies on its WHERE clause.
- Audit inserts: batch them through a Queue consumer, or move them per org
  (2.8). Read replication (Sessions API) is possible later for the catalog
  reads. Writes still go to the primary (read-replication docs, updated
  2026-08-10), and revocation checks should read from the primary.

### 2.5 Org policy for AI connections (the enterprise controls)

Per-org settings, read along with the connection on each request (the row
join already touches `organizations`, `McpConnectionRepository.ts:171-175`):

- `ai_connections: "on" | "off"`. Off blocks consent and `/mcp` for that org.
  Wire it through the existing `org_blocked` branch (`policy.ts:31`) or refuse
  before the view is built.
- `max_access: "write" | "read"`, applied as a cap in `resolveOauthCaller`
  (`validate.ts:157-164`).
- `allowed_clients`: an optional list of CIMD domains, enforced at consent
  (`authorize.ts:244-271`, where `details.clientDomain` is known) and on each
  request (`clientDomain` is on the row). An allowlist excludes unverified DCR
  clients unless DCR is explicitly allowed.
- `pat_max_days`, `pats: on/off`, and a default PAT scope (2.7).
- Admin pages: list and revoke members' MCP connections and PATs. The
  repositories have per-user and per-org indexes already
  (`mcp.schema.ts:111-118`, `user-tokens.schema.ts:48-49`).

### 2.6 "Users sign up for an agent": what a hosted agent needs

Nothing exists, so this is a build. The design follows the v2 docs ("just
another client of the ToolBus") and OpenSEO's Sam. The recommended v1 is an
**agent Durable Object inside the gateway Worker**. The alternative, an agent
as a first-party app over a new tools broker, is in 3.13 and is the right
long-term home once the broker exists.

1. **Runtime:** `EveryAgent extends Think` (or `AIChatAgent` from
   `@cloudflare/ai-chat`: a SQLite-backed DO with a WebSocket client and a
   `useAgentChat` React hook; Agents docs, updated 2026-09-15). One DO per
   `(org, user)`, named `${organizationId}:${userId}`, so chat history is
   private to the user within the org. Declare it in the gateway's
   `cloudflare.config.ts` with a SQLite class. ADR-0001 keeps one codebase, so
   self-host gets the agent as well.
2. **Route and auth:** `/agents/*` on the gateway host through
   `routeAgentRequest`, with `onBeforeConnect`/`onBeforeRequest` checking:
   - a Better Auth session;
   - that the DO name equals the session's `activeOrganizationId:userId`;
   - for the WebSocket upgrade, that `Origin` is exactly the gateway origin.

   The last check matters because the control-plane guard only checks unsafe
   methods (`src/server/control-plane-guard.ts:26`, `:9-17`), and a WebSocket
   upgrade is a GET. A sibling app page is same-site, carries the cookie, and
   could otherwise open the socket (cross-site WebSocket hijacking).
3. **Delegation:** an "agent connection". It reuses `mcp_connections` with
   `client_id = "everyapp:agent"`, a fixed `client_name`, `app_scope`/`access`
   chosen on a first-run consent sheet, and sentinel values in the non-null
   redirect columns, or makes those columns nullable (no backcompat needed).
   Each turn and each scheduled run resolves the principal with the same
   `findActiveWithMembership` re-check (`validate.ts:129-188`). Revocation,
   member removal, bans and "selected apps" then work unchanged, and the agent
   appears and can be revoked on `/settings/connections`. Background runs (DO
   alarms) need no live session.
4. **Tools:** expose `toolBusDeps()` from `runtime.ts`, which is today only
   inside `createToolBusHttp` (`runtime.ts:71-101`). Build the view with
   `gatewaySurfaceView(principal, apps)` (`packages/toolbus/src/view.ts:57-78`).
   Map `listTools(view)` to AI SDK `tool({ inputSchema: jsonSchema(...) })`,
   and run each with `executeToolCall(view, {name, arguments}, deps)`.
   Policy, argument validation, the 30 s deadline, catalog-drift resync and
   audit all come for free (`execute.ts:91-275`). Add credential kind
   `"agent"` (`types.ts:54`) and `actorFor` → `agent:<connectionId>`
   (`execute.ts:76-85`). Keep `chan:"mcp"` so the SDK's check
   (`toolsEndpoint.ts:246`) passes, or widen it to `mcp|agent` in the same PR,
   since there is no backcompat to keep.
5. **LLM through the broker:** call `handleAuthenticatedAiProxyRequest`
   in-process (`src/server/ai-proxy.ts`, invoked today from
   `src/server/app-gateway-entrypoint.ts:131-138`) with
   `caller = {organizationId, appId: "everyapp"}`. `everyapp` is the reserved
   built-in app id (`packages/toolbus/src/builtins.ts:14`). The agent's tokens
   then go through the same usage tap (`src/server/ai-usage.ts`) and the same
   future meter as any app. "Metered like any app" is satisfied by using the
   same function, not a parallel path.
6. **Approvals:** destructive tools are hidden from every caller today
   (`policy.ts:33-35`; TODO "Approvals by browser link"). A chat UI with the
   user present is the easiest place to add inline confirmation for write and
   destructive tools. This is phase 2 and does not block v1.
7. **What not to do:** don't make the agent an OAuth client of our own `/mcp`.
   Its client id would sit on the platform domain, which own-domain refuses by
   design (`own-domain.ts:1-13`). It would also add a self-fetch through the
   front door for no gain.

### 2.7 App-host `/mcp` and PATs per org

- App-host `/mcp` is already per-org: hostname means org, and the perimeter
  enforces session or PAT org = app org (`betterAuthAuthenticator.ts:133-152`).
  Keep it as the power-user path (PAT in Claude Code, or same-origin
  in-app tool calls). It needs no OAuth hosted. The multi-org session issue in
  1.5 belongs to the perimeter or org-context work.
- PATs hosted:
  - Keep them bound to one org (already the case).
  - Add org policy: max lifetime, on/off, and whether `*` is allowed. Change
    the default scope for tokens made from the "connect an AI app" flow to
    `mcp:read` or `mcp:write` instead of `*`. `*` also opens every app route
    (security-model "Agent Tools (MCP)").
  - Add an admin view and revoke.

### 2.8 Audit per org

- **Now (D1):**
  - Per-org retention: add `organizations.audit_retention_days` (or derive it
    from plan), and prune per retention tier.
  - Raise the prune budget for Paid. D1 allows 1,000 queries per invocation
    on Paid against the 50 the current constant assumes
    (`McpToolCallRepository.ts:8-13`; D1 limits).
  - Add an index `(organization_id, user_id, created_at)` for "my activity".
  - Build the TODO's activity page: admins see the org, members see their own.
  - Delete an org's rows when the org is deleted (today rows outlive
    everything by design).
- **Scale ceiling:** about 500 B per row with its three indexes (an estimate).
  The 10 GB D1 cap (D1 limits) then holds about 20M rows, shared with the rest
  of the gateway. At 90-day retention that is about 220k calls a day, before
  the 480k-a-day prune cap. Past that, move the audit to per-org storage. A
  per-org SQLite DO can double as the org's usage ledger, or use a dedicated
  audit D1. Analytics Engine is a poor fit: it samples, and its retention is
  fixed at three months (AE limits, updated 2026-04-23).
- **Metering hook:** `auditToolCall` (`runtime.ts:36-69`) already sees org,
  user, app, tool, outcome and duration for every call on every surface (and
  for the agent, once 2.6 lands). That is the one place to emit a usage event
  for tool calls if they are ever metered.

---

## 3. Gaps and the smallest change that closes each

Sizes are engineer-days for one person working with agents.

| # | Gap | Where | Smallest fix | Size |
|---|---|---|---|---|
| 1 | Own-domain refusal misses `APP_BASE_DOMAIN`/`everyapp.host`, so a tenant app could pose as a "verified" client or redirect target | `src/server/mcp-auth/own-domain.ts:25-35` and 4 call sites; `TODO.md:38` | `onPlatformDomain()` = issuer host ∪ `APP_BASE_DOMAIN` ∪ `PLATFORM_DOMAINS`, subdomains included. Custom domains allowed. Tests for each call site. | 0.5 |
| 2 | Connecting a client to a 2nd org revokes the 1st | `McpConnectionRepository.ts:113-119`; `McpConnectionService.ts:213-220`; test `gateway-mcp.e2e.sqlite.test.ts:2156-2215` | Add `organizationId` to both supersede predicates. Flip the test. Add a "two orgs, two connections, disjoint tools" test. | 0.5 |
| 3 | DCR global cap is a cross-tenant DoS | `src/server/mcp-auth/registration-limit.ts:26-30`, `:114` | Env-configurable caps with hosted defaults (about 20k a day globally, 20 per address) | 0.5 |
| 4 | Token endpoint is counted per client IP; server-side clients share addresses | `src/server/auth-rate-limit.ts:46`, `:170-178` | Remove `/oauth/token` from the IP limiter, or key it by `client_id`+IP | 0.25 |
| 5 | No abuse cap or quota on `/mcp` and tool calls | `src/server/mcp-auth/routes.ts:135-138`, `src/server/toolbus/app-host-mcp.ts:119` | Rate Limiting binding keyed by connection or PAT; plan-quota hook in `auditToolCall`/view build | 0.5 |
| 6 | Every `/mcp` request re-reads all tool rows and JSON schemas, and always runs an UPDATE | `AppToolRepository.ts:218-286`; `validate.ts:166-169` | Per-isolate cache of tools by `(appRowId, catalogHash)`. Skip `touchLastUsed` when fresh. Batch audit inserts via a Queue. | 1.5 |
| 7 | Tool-call identity isn't tenant-pinned (`aud = appId`); the SDK ignores `EVERY_APP_ORG_ID` | `packages/toolbus/src/execute.ts:219`; `packages/sdk/src/server/toolsEndpoint.ts:236-252`; deploy sets the var at `packages/cli/src/commands/app/deploy/deployApp.ts:392` | The SDK refuses identities whose `org_id` differs from `EVERY_APP_ORG_ID` when set. This is defense in depth for per-org Workers that share an app id (ADR-0001 §6). | 0.5 |
| 8 | Audit has one retention, a Free-plan prune budget, no reader, and outlives deleted orgs | `maintenance.ts:22-41`; `McpToolCallRepository.ts:6-13`; `TODO.md:29` | Per-org retention column and tiered prune. Paid-sized prune. `(org,user,created)` index. Activity page (admin: org; member: own). Purge on org delete. | 3 |
| 9 | Orgs can't govern AI access | `policy.ts:25-38` (unused `org` arg); `authorize.ts:216-271`; `validate.ts:157-164` | Org settings `ai_connections`, `max_access` and `allowed_clients`, enforced at consent and on each request. Admin list/revoke of members' connections and PATs. | 2.5 |
| 10 | PAT defaults too broad for hosted (`*`, any member, 90 days) | `UserPatService.ts:18`, `:47-49`; `serverFunctions/userTokens.ts:16-28` | Org policy (`pats`, `pat_max_days`). Default `mcp:*` scopes in the AI-app flow. | 0.5 |
| 11 | No in-gateway agent | none (hooks: `protocol.ts:39`, `execute.ts:3-4`, `types.ts:54`) | Agent DO in the gateway (2.6): `toolBusDeps()` refactor + `"agent"` credential (0.5), DO + route + Origin check + agent connection (2), LLM through `handleAuthenticatedAiProxyRequest` with usage tap (1.5), chat UI in the home shell + first-run consent (2) | 6 |
| 12 | Signed-out OAuth flow goes to sign-in only; a brand-new hosted user from claude.ai needs sign-up → personal org → consent; a new org with no apps gets a connector with only built-ins | `authorize.ts:124-128`; `view.ts:39-41` | Send to sign-up with the same `redirect`, once open sign-up exists (onboarding subsystem). Preinstall catalog apps so the first connection has tools. | 0.5 (after onboarding) |
| 13 | Long term: other apps' agents (OpenSEO's Sam) can't use ToolBus tools; the agent can't be forked by orgs | `src/server/app-gateway-entrypoint.ts` (routes only `/api/ai/<provider>`) | A `tools` broker capability on the AppGateway entrypoint: `POST /api/tools/list|call` with a manifest capability approved by an admin, a per-user agent connection row (client = app row), and principal credential `"app"`. Then move the agent into a first-party app. | 3 |
| 14 | Audit storage ceiling on shared D1 (about 20M rows) | `mcp.schema.ts:144-185` | Move rows to a per-org SQLite DO (shared with the usage ledger) or a dedicated audit D1 | 3 (phase 2) |
| 15 | OAuth KV sweep takes months hosted | `maintenance.ts:34`, `:84-87` | Loop `purgeExpiredData` until about 800 KV operations per run, or run it from a Queue | 0.25 |

### Suggested PR order

1. **Tenancy hardening** (gaps 1, 2, 3, 4, 7): about 2.25 days. No schema
   change except tests. Merge first, because each is a hosted correctness or
   security bug.
2. **MCP path efficiency** (gaps 6, 15): about 1.75 days.
3. **Agent v1** (gap 11): 4 PRs, about 6 days. The first PR (`toolBusDeps()`,
   the `"agent"` credential, `actorFor`, audit `credential_kind`) is useful on
   its own.
4. **Org governance** (gaps 9, 10, 5): about 3.5 days. One migration adds the
   org settings columns.
5. **Audit per org** (gap 8): about 3 days.
6. Later: tools broker and agent-as-app (13), per-org audit storage (14).

---

## 4. Open questions only the founder can answer

1. **Does one AI connection mean one org, or all of a user's orgs?**
   - *Why it matters:* this decides tool naming, principal shape and consent
     UX. A personal-plus-team user wants both in claude.ai.
   - *Default:* one org per connection, and allow parallel connections to
     different orgs (gap 2). Revisit multi-org with org-prefixed tool names
     only if users ask.
2. **Should the agent live in the gateway or be an app?**
   - *Why it matters:* in-gateway is the fastest path, and self-host gets it
     too. As an app it is least-privilege, forkable per org, and forces the
     tools broker that OpenSEO's Sam would also use.
   - *Default:* in-gateway DO for v1 (6 days). Extract to a first-party app
     once the tools broker (gap 13) ships.
3. **Is the agent per user or per org?**
   - *Why it matters:* this decides DO naming, privacy of chat history, and
     whether teammates share memory and context.
   - *Default:* per user within an org (`${orgId}:${userId}`). Add shared org
     memory later as a tool, not shared transcripts.
4. **Is the agent itself free, or metered?**
   - *Why it matters:* the agent spends platform LLM money on every turn, and
     "metered like any app" needs a price.
   - *Default:* meter the agent's LLM tokens as app `everyapp` under the
     org's credits, the same way OpenSEO meters Sam.
5. **Keep dynamic client registration (DCR) on in hosted?**
   - *Why it matters:* Cursor, Gemini CLI and MCP Inspector need DCR. It is
     anonymous KV writes, and its name shown to users is unverified.
   - *Default:* on, with hosted-sized caps (gap 3). Orgs can turn off
     unverified clients via `allowed_clients`.
6. **Audit retention and visibility per plan?**
   - *Why it matters:* this decides the storage ceiling, the plan
     differentiator, and GDPR deletion.
   - *Default:* 30 days free and 90 paid. Admins see the whole org, members
     see their own. Delete with the org.
7. **Are MCP tool calls ever billed by themselves?**
   - *Why it matters:* this decides whether `auditToolCall` must write to the
     usage ledger synchronously and reliably, or only count for abuse caps.
   - *Default:* not billed. Count them for quotas, and bill the underlying
     metered providers (LLM, DataForSEO) that apps call through the broker.
8. **Does app-host `/mcp` survive in hosted?**
   - *Why it matters:* it is a second MCP surface per app to secure and
     document. claude.ai can't use it (no OAuth).
   - *Default:* keep it (PAT and session only). It costs nothing extra and
     serves Claude Code and in-app tool calls.
9. **May org admins see and revoke members' AI connections and PATs, and
   restrict which AI apps connect?**
   - *Why it matters:* this decides the privacy-versus-control stance for
     teams.
   - *Default:* yes to list and revoke. An optional allowlist of verified
     client domains, off by default.

## 5. Load-bearing claims (if wrong, the design changes)

1. **`@cloudflare/workers-oauth-provider` 1.2.3 cannot add protected resources
   after construction.** Source: `oauth-provider.d.ts:1165-1172` in the
   gateway's `node_modules`. If a later version adds a resource resolver,
   per-org connector URLs become cheap and question 1 changes. (Critical.)
2. **One D1 database is single-threaded and capped at 10 GB, and all tenants'
   MCP traffic and audit share the gateway's D1.** Source: D1 limits (updated
   2026-04-21); `src/db/mcp.schema.ts`. This drives gaps 6, 8 and 14. If
   hosted moves to per-org D1 databases for gateway state, the audit and load
   gaps shrink. (Critical.)
3. **claude.ai's server-side requests come from Anthropic's
   `160.79.104.0/21`, and the Rate Limiting binding counts per location per
   key.** Sources: Anthropic IP addresses page; Cloudflare rate-limit binding
   docs (updated 2026-10-12). The risk to `/oauth/token` depends on egress
   spread, so it is plausible, not measured. (Not critical: the fix is
   0.25 day either way.)
4. **The Agents SDK chat agents are SQLite-backed Durable Objects with a
   WebSocket client, and the pattern already runs in OpenSEO** (`agents`
   0.22.0, `@cloudflare/think` 0.17.0). Source: Cloudflare Agents chat docs
   (updated 2026-09-15); `open-seo/package.json`. If the agent instead runs as
   an org app on Workers for Platforms, check whether DOs work in dispatch
   namespaces. The WfP limits page (updated 2026-10-13) mentions DO namespaces
   without stating that user Workers can use them.

Also assumed and unverified: claude.ai lets a user add two custom connectors
with the same URL (relevant to gap 2's benefit on claude.ai; Claude Code
supports it via distinct server names).

## 6. Sources

Codebase (worktree `/Users/bensenescu/.t3/worktrees/private-every-app/t3-afce8c8f`):
`apps/every-app-gateway/src/server/mcp-auth/*`,
`apps/every-app-gateway/src/server/toolbus/*`, `packages/toolbus/src/*`,
`apps/every-app-gateway/src/db/mcp.schema.ts`,
`apps/every-app-gateway/src/db/rate-limit.schema.ts`,
`apps/every-app-gateway/src/db/user-tokens.schema.ts`,
`apps/every-app-gateway/src/server/auth-rate-limit.ts`,
`apps/every-app-gateway/src/server/repositories/{McpConnectionRepository,McpToolCallRepository,AppToolRepository}.ts`,
`apps/every-app-gateway/src/server/services/{McpConnectionService,UserPatService}.ts`,
`apps/every-app-gateway/src/server.ts`, `apps/every-app-gateway/cloudflare.config.ts`,
`apps/every-app-gateway/src/server/app-hosts.ts`,
`apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts`,
`apps/every-app-gateway/src/server/control-plane-guard.ts`,
`packages/sdk/src/internal/protocol.ts`, `packages/sdk/src/server/toolsEndpoint.ts`,
`packages/perimeter/src/getAppFetcher.ts`, `docs/security-model.md` ("Agent
Tools (MCP)", "Connected AI apps (OAuth)"), `docs/architecture-v2-overview.md`
§1–3, `docs/architecture-v2-recommendation.md` §2.4, §2.6, `adr/ADR-0001-*`,
`TODO.md`, `apps/every-app-gateway/node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.d.ts`
(1.2.3). OpenSEO: `/Users/bensenescu/workspaces/open-seo/src/server/features/sam/SamChatAgent.ts`,
`samChatTools.ts`, `src/server.ts`, `wrangler.jsonc`, `package.json`.

Web (fetched 2026-10-15):
- Cloudflare D1 limits, updated 2026-04-21: https://developers.cloudflare.com/d1/platform/limits/
- Cloudflare D1 read replication, updated 2026-08-10: https://developers.cloudflare.com/d1/best-practices/read-replication/
- Workers Rate Limiting binding, updated 2026-10-12: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Workers KV limits, updated 2026-10-08: https://developers.cloudflare.com/kv/platform/limits/
- Workers KV pricing, updated 2026-04-21: https://developers.cloudflare.com/kv/platform/pricing/
- Workers Analytics Engine limits, updated 2026-04-23: https://developers.cloudflare.com/analytics/analytics-engine/limits/
- Agents SDK chat agents, updated 2026-09-15: https://developers.cloudflare.com/agents/api-reference/chat-agents/
- Workers for Platforms limits, updated 2026-10-13: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/
- Anthropic IP addresses (outbound for MCP tool calls: `160.79.104.0/21`): https://platform.claude.com/docs/en/api/ip-addresses
- Anthropic, building custom connectors via remote MCP (connections originate from Anthropic's servers): https://support.anthropic.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers
