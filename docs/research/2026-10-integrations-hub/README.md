# Integration hub research — October 2026

Date: 2026-10-12 · Builds on the October platform review (the Oct 4–5 review, including the Executor and Cloudflare OS deep reads and the ToolBus design). That review isn't kept in the repo: what it decided shipped in #267–#274 and is tracked in `TODO.md`, so the raw reports' citations of `../2026-10-platform-review/` are historical.

**The question.** What can Every App learn from Executor and Composio, and from other products that gather many integrations behind one agent interface? Should the gateway be an integration hub by default, with internal apps built on top? Is Executor heading the same way, minus an app store?

| File | What it is |
|---|---|
| [`app-integrations.md`](./app-integrations.md) | **The design (2026-10-14):** integrations the gateway holds once, that apps request and the gateway grants, mapped onto the code on `main`. Its 2026-10-18 note says what changed since |
| [`raw/executor-update.md`](./raw/executor-update.md) | What changed at Executor since the Oct 4 deep read, and a test of the founder's hypothesis |
| [`raw/composio.md`](./raw/composio.md) | Composio deep dive: data model, meta-tools, auth, governance, breach, pricing, open-source status |
| [`raw/landscape-aggregators.md`](./raw/landscape-aggregators.md) | Open-source and commercial integration hubs, MCP gateways, catalogs, and which vendor MCP servers need no client registration |
| [`raw/landscape-internal-app-platforms.md`](./raw/landscape-internal-app-platforms.md) | Platforms where an org connects tools once and many apps and agents reuse them (Retool, Windmill, Lovable, Vercel, Zapier, n8n, Glean, Microsoft, Cloudflare OS, …) |
| [`raw/build-patterns.md`](./raw/build-patterns.md) | How to build this on Cloudflare: client behavior with many tools, MCP spec, the OAuth client problem, data model, flows, risks |

The raw reports are evidence. This page is the synthesis. Labels in the raw reports: **[live]** fetched 2026-10-12, **[code]** read in source, **[docs]** vendor docs, **[inference]** reasoning.

---

## TL;DR

1. **Executor is heading where you think, but with two corrections.**
   - On 2026-10-11 its homepage changed to "Everything you use, connected in one place. Then build whatever you need on top."
   - **Correction 1: it does host apps.** They run on Executor's own runtime (Dynamic Workers in its cloud, or its Docker image). Its site says app pages and saved data "are available locally", while "Cloud app pages and hosted app data are still in development."
   - **Correction 2: it does have an app gallery.** executor.sh/apps lists community apps: "Anyone can publish one", "Community apps aren't reviewed by Executor", and installing means making a copy. Copies don't receive updates yet.
   - **What it doesn't have:** curated, maintained apps; apps that run in the customer's own cloud account (v2 dropped its Cloudflare self-host for Docker); and a company-first model (it pitches "personal software"; new apps default to "Only me").
2. **"Connect once, reuse everywhere" is now table stakes, not a moat.**
   - Lovable, Vercel Connect, Replit, Zapier, n8n, Windmill, Glean, Composio, Pipedream and Executor all have it in some form. So do most AI app builders, as of 2025–26.
   - "One MCP endpoint plus search/describe/execute meta-tools" is equally common.
   - The gateway needs both, but neither is the reason to pick Every App.
3. **Nobody has the full combination.** That combination is: org-wide connections, one MCP front door, AI-built apps, a store of real *maintained* apps, everything inside the customer's own cloud account, and open source (§4).
   - Executor and Cloudflare OS come closest. Each misses two or three of these.
4. **Self-hosting is an advantage for integrations, not a handicap.**
   - Google exempts "Internal" Workspace apps from verification (and the CASA assessment restricted Gmail/Drive scopes need). Slack's 2025 rate-limit cuts don't touch internal apps. Single-tenant Microsoft apps skip publisher verification.
   - Composio's May 2026 breach shows the cost of one central token vault. The attacker "gained a foothold in an internal agentic tool used to monitor our infrastructure"; about 0.3% of active connections leaked, including 5,001 GitHub connections. Each customer's tokens in its own Cloudflare account is a real selling point.
5. **Build a thin "Connections" layer into the gateway. Don't embed or buy one.**
   - Every serious open-source hub is license-restricted (Nango ELv2, n8n SUL, Metorial FSL, Pipedream SAL) or a multi-service Node/Postgres/Redis platform. None runs on Workers.
   - Composio holds every token and won't export them.
6. **The app store is the differentiator, if store apps declare the connections they need, bind to the org's existing connections on install, and keep getting updates.**
   - Elsewhere, templates are copies that drop their connections (Lovable remix, Base44 public templates) or never update (Executor, Retool, Appsmith, Budibase).
   - Cloudflare OS added template updates (with an agent merge) on Oct 5. Windmill added installable bundles with connection stubs in July. Watch both.

---

## 1. Executor: what changed and what to learn

**Status** [live, code — `raw/executor-update.md`]
- **v2 is the default for new sign-ups** (since Oct 8) but still a beta. npm `latest` is 1.6.10, and v2 ships as `2.0.0-beta.15` (Oct 11). Most users are still on v1.
- **Repo:** MIT, ~4,160 stars. YC lists a team size of 1.
- **Pricing:** Free (3 members, unlimited integrations), Team $15 per member per month, Enterprise (audit logs, SSO/SCIM, self-host). Executor moved to per-seat pricing after execution caps blocked a paying customer mid-workload (Oct 4 read).
- **The Composio comparison is now on its homepage:** "Both connect your accounts. With Executor you can also bring your own integrations, change how any tool works, and build apps on top of them."

**How v2 works underneath** [code]
- **Every integration is an app.** An account is saved only by completing an app's connection request.
  - **One-click "Quick Add":** works only for remote MCP servers that need no sign-in or advertise OAuth that Executor can discover (from the integrations.sh catalog of ~5,572 entries). It generates and deploys a wrapper app.
  - **Everything else:** gets a copyable "Set up with your agent" prompt, and the user's coding agent writes the app. That includes Gmail, Calendar and Microsoft Graph (OpenAPI), GraphQL, and MCP servers that take API keys.
- **Sharing one account across apps is fragile.** A provider's ID is a hash of its whole definition, so two apps share an account only if they declare it identically.
- **The MCP endpoint is code mode only** (`skills`, `execute`, `resume`). v1's search-and-invoke mode isn't in v2 yet; there's an open request for it.

**Worth copying**
- **The three-step story, made company-shaped:** connect your company's tools once; agents use them through one URL; install real apps on top or have your agent build one.
- **Quick Add for any remote MCP URL, stored as a gateway connection rather than an app.** Treat tools with no annotations as writes, which is stricter than Executor.
- **The account model:**
  - personal vs shared accounts;
  - per-person account choice;
  - "scoped connections" (named MCP URLs limited to chosen apps and tools);
  - "a login is not an account";
  - "management access ≠ use of the credential".
- **Agent-first onboarding:**
  - a "Set up with your agent" prompt;
  - per-assistant connect guides that wait until a real MCP connection arrives;
  - `llms.txt` and agent skills;
  - the management API exposed as tools, so an agent can set Executor itself up.
- **Approvals** (from the Oct 4 read):
  - browser-link approvals;
  - durable, single-use pending-approval records;
  - prompts tagged as policy prompts vs upstream prompts.

**Where Every App is ahead or can be**
- Curated apps that keep getting updates.
- Full TanStack Start apps with their own D1/KV/Durable Objects, in the customer's own Cloudflare account, with no per-seat vendor fee.
- One canonical, gateway-owned definition per provider, so every app reuses the same connection.
- Org-wide apps and per-app access by default.
- An audit row per call for everyone; Executor sells that as an Enterprise feature.
- A Cloudflare-native self-host.

---

## 2. Composio: what to take and what to avoid

**What it is** [live, docs, code — `raw/composio.md`]
- A hosted "action layer" for agents: 1,603 toolkits, 60,611 tools and 671 triggers in its public catalog.
- **Setup reality:** only 123 toolkits have a Composio-managed OAuth app (zero setup). Most others need a pasted API key or your own OAuth client.
- **Open source:** only the client SDKs and CLI are MIT (~30.5k stars). The backend is closed; self-hosting is an Enterprise Kubernetes deal.
- **Pricing:** 100K tool calls a month free, then $0.0003 per call; $0.003 per trigger event.
- **Rough 2026:**
  - the breach (disclosed May 2026);
  - X suspended its shared X/Twitter app for 173 hours (Feb);
  - a ~36-hour trigger outage (Apr);
  - its consumer app Rube shut down (2026-05-16);
  - frequent breaking SDK changes.
- **No apps or internal-tools layer.**

**Take**
- **Two objects:**
  - an *auth config* (how a provider authenticates: whose OAuth client, which scopes);
  - a *connected account* (one grant, with a status and a label).
- **Private by default.** A shared connection needs an explicit access list and is never picked silently.
- **Meta-tools:**
  - search returns full schemas, known pitfalls and connection status in one call;
  - batch execution;
  - a "manage connections" tool that returns a connect link;
  - a sandbox for results over ~20k characters, so huge payloads don't flood the model.
- **Four risk tags:** read-only, create, update, destructive.
- **Connect links** that are single-use, expire in about 10 minutes, and are bound to the signed-in user. Composio only added protection against someone else completing a link in July 2026.
- **The post-breach vault design, from day one:** envelope encryption, tokens never returned by any API, hashed keys.

**Avoid**
- A central multi-tenant vault.
- Shared vendor-owned OAuth apps as the default (they fail for everyone at once, and Google's restricted scopes break them).
- Tokens you can't export: leaving Composio means every user reconnects.
- Approvals as an afterthought: still experimental in Composio's SDKs.
- Logging call payloads by default.

**Verdict:** don't build on Composio. At most, accept it (or Pipedream, Zapier, Arcade) as one more upstream MCP server for long-tail apps, with Every App's own policy, approvals and audit in front.

---

## 3. The wider landscape

**Moves this year** [live — `raw/landscape-aggregators.md`, `raw/landscape-internal-app-platforms.md`]
- **Workday owns Pipedream.** Pipedream is shutting down Workflows (Mar 31, 2027) to be "the integration layer for AI agents". It also launched **Conduit**, a closed, self-hostable MCP gateway with workspace or per-user credentials and per-group grants.
- **Arcade bought Smithery.**
- **Pivots and shutdowns:**
  - Pica became One;
  - ACI.dev became a consulting shop;
  - Klavis sells AI training environments;
  - Toolhouse pivoted;
  - Rube shut down;
  - Metorial relicensed to FSL.

**Worth knowing**

| Product | What it is | Why it matters to Every App |
|---|---|---|
| **Pipedream Conduit** | Closed, self-hostable MCP gateway (pre-1.0) | Closest to "ToolBus + connections". Workspace or per-user credentials, an "allow personal override" toggle, a write-only secrets API, grants checked on every list and call. Hosts no apps. |
| **Nango** (ELv2) | Auth + proxy + agent sessions, 1,048 providers | Sessions resolve *exactly one* connection per integration and fail with `ambiguous_connections` rather than guess. Publishes a CIMD document for upstream MCP servers. |
| **Activepieces** (MIT core) | Automation platform, ~765 pieces | "Global Connections" assigned to projects by admins. Every action tagged READ/SEARCH/WRITE/DESTRUCTIVE. The only open-source example of zero-setup OAuth for self-hosters (a hosted broker that never stores tokens). |
| **n8n** (fair-code) | Workflows, 207k stars | One instance-level MCP server. Per-user "end-user credentials". A per-credential "allowed HTTP domains" setting so a token can't be sent elsewhere. |
| **Windmill** (AGPL; OAuth code closed) | Scripts, flows, apps | Org-wide typed "resources", an OAuth MCP gateway, and since July 2026 Hub "projects" whose connection stubs the installer binds to existing resources. The closest to "store apps that declare connections". |
| **Zapier MCP** | 9,000+ apps | Meta-tools by default ("agentic mode"); one-tool-per-action is opt-in. Enterprise "managed apps": only admins create connections for chosen apps. |
| **Glean** | Enterprise search and agents | Explicit auth modes per tool (admin-shared, per-user, API key, client credentials), an MCP gateway, and it can run in the customer's own GCP/AWS/Azure account. Closed and enterprise-only. |
| **Lovable, Vercel Connect, Replit** | AI app builders | "Connect once at the workspace, link to many apps" shipped in all three in 2025–26. Lovable proxies through a connector gateway; Vercel hands out short-lived tokens tied to the deployment's identity. |
| **Microsoft Copilot Managed Runtime** (preview) | Code-first internal apps that inherit tenant governance | The closest design to Every App's. A shared connection "is limited to the operations the app declares in its config … enforced **per app**", and deploys fail without that declaration. |
| **Cloudflare OS** (Apache-2.0) | Agent workspace with "gatekeepers" per service | Per-user connections with approvals for writes. Templates for agent-built "gadgets" can now be updated (Oct 5). It consumes MCP but exposes none, which is the gap ToolBus fills. The managed version is still a waitlist. |
| **Obot, Docker MCP Gateway, ContextForge, agentgateway, ToolHive** | Open-source MCP gateways | All container- or Kubernetes-based. Use them for interop (an enterprise puts Every App's `/mcp` behind its gateway), not for embedding. |

**Commoditized now** (don't compete on these): catalog size, managed OAuth for the top ~100 apps, an MCP endpoint, search/execute meta-tools, connect links, basic audit logs.

**Still differentiated:**
- Governance shaped like a company: org vs personal connections, per-app consent, admins can only tighten, approvals.
- Triggers for agents (MCP has no standard).
- Trustworthy, maintained actions.
- **Full apps built on the same connections.**
- **Tokens staying in the customer's own cloud.**

---

## 4. Where Every App sits

Y = yes, P = partial, N = no. Sources are the raw reports.

| Product | Org-wide connections hub | One MCP front door | AI-built hosted apps | Store of real, maintained apps | Runs in customer's cloud account | Open source |
|---|---|---|---|---|---|---|
| Executor v2 | Y (accounts via apps) | Y | P (cloud pages "in development") | N (unreviewed copies) | P (Docker, not Cloudflare) | Y (MIT) |
| Composio | Y (shared connections new in 2026) | Y | N | N | P (Enterprise) | P (SDKs only) |
| Pipedream Conduit | P (early access) | Y | N | N | P (self-host image) | N |
| Windmill | Y | Y | Y | P (20 bundles, since Jul 2026) | Y | P (AGPL; OAuth closed) |
| n8n | Y | Y (workflows as tools) | P | P (13k community templates) | Y | P (fair-code) |
| Glean | Y | Y | P (HTML artifacts) | P | Y | N |
| Lovable / Vercel / Replit | Y | P (build-time or per-app MCP) | Y | P (copies) | N | N |
| Cloudflare OS | Y (per-user) | N (consumes MCP only) | Y (gadgets) | P (templates updatable since Oct 5) | Y | Y (Apache-2.0) |
| **Every App (planned)** | **planned** | **planned (ToolBus)** | **Y (coding agents)** | **Y (3 apps today)** | **Y** | **Y (MIT)** |

**Positioning line** [inference]: *Connect your company's tools once. Every agent uses them through one URL. Install real apps on top, or have your agent build one. All in your own Cloudflare account, open source.*

---

## 5. What to build into the gateway

All [inference] built on the evidence; details and SQL are in `raw/build-patterns.md` §9.

1. **"Integrations" (third-party accounts) as first-class gateway objects.**
   - They are neither apps nor Better Auth accounts. In Better Auth 1.7.7 a linked account becomes a sign-in method, has no org scope, and refreshes with no lock.
   - **Tables:** `provider_clients` (this install's OAuth apps), `connections` (owner = user or org, label, scopes, encrypted tokens, status) and `connection_grants` (which members, roles and apps may use one, read or write).
   - **Rights:** use, manage and reveal are separate rights. Nobody can read a token back through any API.
   - **Encryption:** envelope encryption, with the key-encryption key in a Worker secret and per-org data keys in D1.
   - **Refresh:** one Durable Object per connection serializes token refresh. GitHub, Slack, Linear, Atlassian and Notion rotate refresh tokens, and GitHub's are single-use.
2. **Three ways in, zero-setup first.**
   - **(a) Vendor-hosted MCP servers via CIMD/DCR.** No OAuth app needed: Linear, Notion, Sentry, Stripe, Cloudflare, Atlassian (after an org-admin allowlist), Airtable, Supabase and others advertise it. **Spike this first.** Nobody has yet tested that these vendors accept an arbitrary self-hosted gateway domain.
   - **(b) Guided "bring your own internal app":**
     - GitHub App manifest flow (about one click);
     - Slack app manifest;
     - a Google Workspace *Internal* client wizard (skips verification);
     - single-tenant Microsoft later.
   - **(c) API keys.**
   - **Defer** a hosted OAuth broker. If it ever exists, make it opt-in and never broker Google restricted scopes.
   - **Treat upstream tools as untrusted:** pin and diff their catalogs, quarantine changes, and treat unannotated tools as writes.
3. **ToolBus serves app tools and integration tools side by side.**
   - The consent screen picks apps *and* integrations.
   - Tool names carry their prefix (`gmail_search_threads`, `crm_create_deal`), because many clients see only names.
   - Two modes per grant: flat tools for small grants, search meta-tools by default for big ones. Code mode comes later.
   - A missing account returns a connect link in the tool result, upgraded to URL elicitation where the client supports it. Claude Code supports it; claude.ai doesn't yet (`anthropics/claude-ai-mcp#153`).
4. **Apps declare integrations the way they declare `providers` today, and never hold tokens.** Sketch:

   ```ts
   // everyapp.config.ts
   providers: ["openai"],                                              // today
   connections: [
     { provider: "google", scopes: ["gmail.readonly"], as: "user" },   // each user's own Gmail
     { provider: "slack", access: "write", as: "org" },                // the org's Slack app
   ],
   ```

   - **How apps call:** through the existing props-authenticated `AppGateway` binding, e.g. `everyApp.connections.fetch("github", { as: "user" })` handed to Octokit as its `fetch`.
   - **What the gateway checks on each call:**
     - the manifest declares the provider;
     - an admin approved the app's grant;
     - the URL is one of the provider's API hosts;
     - read vs write fits the grant;
     - the request follows no redirects (`redirect:"manual"`).
   - **Agent read-only carries through:** if the request came from an agent with read-only consent, writes are refused even inside app code.
   - **Raw tokens:** handed out only as an audited, admin-approved escape hatch. This replaces M4-8's "Google token vending first".
   - This is the same rule Microsoft enforces: per-app allowed actions on a shared connection.
5. **Make the app store the wedge.**
   - Store apps declare connections.
   - Installing binds them to the org's existing connections, or asks someone to connect.
   - Apps keep receiving updates.
   - Pair each store app with "describe a variation" for the agent.
   - Evidence:
     - On Frappe's 372-app marketplace, its own maintained apps lead installs (ERPNext 96k, CRM 40k).
     - Notion reported 51M template duplications in one year (2023).
     - ToolJet and NocoBase moved to "start from a working app, then customize with AI" this year.
     - No vendor publishes template-to-retention data.
6. **Safety defaults for the "lethal trifecta".** A hub that connects Gmail, GitHub and Slack gives one agent private data, untrusted content and a way to send it out. So:
   - new connections are read-only for agents;
   - outbound sends require approval once M3-6 lands;
   - untrusted third-party content is labeled;
   - every call writes an audit row.
7. **Agent-first onboarding:**
   - a "Set up with your agent" prompt;
   - per-client connect pages that confirm a real connection;
   - `llms.txt`;
   - `everyapp_*` management tools, so an agent can set up the gateway.
8. **Later:**
   - triggers (provider webhook → one ingest route → Queue → app Workers, idempotent);
   - code mode on Dynamic Workers;
   - Microsoft 365;
   - an OpenAPI long tail;
   - "bring your own aggregator" (a Composio/Pipedream/Zapier MCP URL as one upstream).

Small win: Cloudflare's Web Search API via AI Gateway (2026-10-02, `env.AI.websearch()`) can back the planned "web search" capability almost as is.

---

## 6. Changes to the current roadmap

| Roadmap item | Change |
|---|---|
| M1-3 "Connections page" (MCP client tokens) and M4-8 "connections (Google, Slack)" | **Naming clash.** Pick two nouns now, e.g. "Integrations" (third-party accounts the gateway holds) and "Agent access" (MCP clients and tokens). Rename the planned `mcp_connections` table to `mcp_grants` before it ships. |
| M3-3 consent screen | Pick apps **and** integrations, read-only vs read-write. |
| M3-4 policy | New connections read-only for agents; unannotated upstream tools are writes; outbound-send tools need approval. |
| M3-7 search meta-tools | Default for big grants (from about 25 visible tools), not only above 40. Add an integrations/connect tool. |
| M4-8 capabilities | Becomes "Integrations v1", proxy-first, built alongside ToolBus rather than after it. Email and web search stay. Google token vending becomes the audited escape hatch. |
| App store | Manifest `connections`, bind on install, and an update channel for store apps. |
| New spike (1–2 days) | Can a throwaway self-hosted gateway connect to Linear/Notion/Sentry/Stripe/Atlassian MCP via CIMD? This decides how much of the hub is zero-setup. |

Rough size [inference]: Integrations v1 (tables, encryption, refresh lock, settings/admin pages, connect flow, 4–6 providers, app proxy) is on the order of the ToolBus work itself: weeks, not days.

---

## 7. Decisions for the founder

1. **Company-first, or also personal?** Executor chose "personal software". Recommendation: company-first; a person is an org of one.
2. **Own OAuth clients only (plus CIMD vendors) at launch?** Recommendation: yes. A hosted broker later, opt-in, never for Google restricted scopes.
3. **Do integrations ship with ToolBus or right after?** Shipping together makes the one-connector story complete, but the November ToolBus date slips.
4. **Names:** "Integrations" vs "Agent access" (or others), and whether "Gateway" itself gets renamed (open question from the platform review).
5. **Long tail:** should "bring your own aggregator" (Composio, Pipedream, Zapier MCP as upstreams) be a supported path, or left to Quick Add of any MCP URL?

## 8. Not verified

- Whether vendors that advertise CIMD/DCR accept an arbitrary self-hosted domain in practice.
- How claude.ai, Desktop and ChatGPT behave at runtime with URL elicitation.
- Google CASA cost.
- Whether vendor-MCP tokens also work on the vendor's REST API (the design assumes not).
- Exact count of Executor gallery listings (the page renders client-side; the agent counted 15 through the API).
- Several Composio governance details: what its enterprise "human-in-the-loop review policies" actually are.
- Pipedream Conduit's license.
