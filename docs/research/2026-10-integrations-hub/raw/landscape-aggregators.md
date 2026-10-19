# Landscape: integration aggregators for agents (open source first), October 2026

- **Researched:** 2026-10-12. Training data was treated as stale. Everything was re-checked live (web pages, GitHub API, public registry APIs) unless labeled otherwise.
- **Question:** who aggregates many third-party integrations for agents (one place to connect accounts, managed auth, one MCP/SDK surface)? Which parts can Every App reuse, and which mechanisms should it copy?
- **Out of scope here:** Executor and Composio are covered in `raw/executor-update.md` and `raw/composio.md`. They appear below only for comparison.
- **Labels:**
  - **[live]** a page fetched today (URL given).
  - **[code]** read in source today via the GitHub API or a shallow clone (repo and path given).
  - **[docs]** vendor docs, fetched today.
  - **[api]** a public, unauthenticated API queried today.
  - **[probe]** a public OAuth metadata document (RFC 9728/8414) read today with no token.
  - **[sub]** gathered today by a helper research agent that fetched the pages live; I spot-checked some of these.
  - **[inference]** my reasoning.
- **GitHub numbers** (stars, license, last commit on the default branch) come from `gh api repos/<owner>/<repo>` on 2026-10-12.
- **Limits of this pass:**
  - The shared web-search budget ran out partway through. After that, only direct page fetches and the GitHub API were used, so a few "is it still alive?" checks rest on GitHub activity and the vendor's own homepage, not on news coverage.
  - Nothing was installed, built, run, signed up for, or posted to.
- **Scratch data** (not committed): `/tmp/everyapp-research-2/`. It holds the Nango `providers.yaml`, a dump of the official MCP Registry (42,522 latest server entries), the integrations.sh catalog, and a Docker MCP registry clone.

## TL;DR

1. **There is no MIT, Workers-native integration hub to embed.**
   - The serious open hubs are source-available with use restrictions: Nango (ELv2), n8n (Sustainable Use License), Metorial (FSL), Pipedream components (non-compete license).
   - Or they are heavy multi-service platforms: Activepieces (MIT core), Nango, Metorial.
   - Several were abandoned or pivoted in 2026: ACI.dev became a services lab, Klavis moved to RL environments, Pica's open edition is unmaintained, Toolhouse pivoted, and Composio's Rube shut down.
   - Every OSS MCP gateway (Obot, ContextForge, ToolHive, agentgateway, Microsoft, Docker, MCPJungle, MetaMCP) is a long-running Go, Python, Rust, .NET or Node server, usually with Postgres or Redis. None runs on Workers. [code][live]
2. **Consolidation:**
   - **Workday owns Pipedream.** The deal closed in Workday's fiscal year ending 2026-01-31. [live SEC]
   - **Arcade bought Smithery** (2026-08-05), and Arcade's prebuilt toolkits are now proprietary on PyPI. [live]
   - Pica rebranded to **One**. Metorial relicensed to FSL.
3. **The 2026 convergence is "one MCP endpoint + a few meta-tools + per-user connections + in-band connect links".**
   - Nango (agent sessions), One (3 tools), Activepieces, Gram, Klavis, Docker, Cloudflare portals, Zapier, StackOne, Merge and Composio all ship some form of `search → describe → execute`.
   - This is commodity. Every App's planned search mode is table stakes, not a differentiator. [code][live]
4. **Vendor-hosted MCP servers plus MCP-to-MCP OAuth are the cheapest broad coverage, but the most important vendors gate which clients may connect.**
   - The 2026-07-28 MCP spec says "Dynamic Client Registration is deprecated" and prefers **CIMD**, where the client ID is an HTTPS URL. [live]
   - I read the public OAuth metadata of ~45 official MCP endpoints today. [probe]
   - **Open + CIMD** (zero registration for a self-hosted gateway): Linear, Notion, Atlassian (v2), Sentry, Airtable, monday, Canva, Cloudflare, Granola, Zendesk.
   - **DCR only:** Stripe, Supabase, Neon, ClickUp, Calendly, Zapier, PayPal, Intercom.
   - **Gated DCR** (allowlisted clients only): Figma, Vercel, Square, Dropbox.
   - **Pre-registered client required:** Slack, GitHub, Asana, HubSpot, Box, Zoom, Microsoft (Entra), and **Google**.
     - Google's new Workspace MCP servers (Gmail, Drive, Docs, Sheets, Slides, Calendar, Chat, People) are a **Developer Preview** behind your own OAuth client. [live]
   - See §5.
5. **The best MIT building blocks:**
   - the MCP TS SDK client (CIMD/DCR);
   - Better Auth's `linkSocial` / `getAccessToken`, already in the gateway, with 36 built-in providers including Google, GitHub, Slack, Linear, Notion, Atlassian, Microsoft and Salesforce;
   - `oauth4webapi`;
   - Cloudflare's `codemode`;
   - the **integrations.sh** catalog (MIT, 5,572 surfaces with credential facts, runs on Workers);
   - Activepieces' piece definitions (MIT; per-action `classification: READ | SEARCH | WRITE | DESTRUCTIVE`);
   - Ampersand's MIT OAuth endpoint table.
   - **Don't ship Nango's ELv2 `providers.yaml`**, even though it is the richest OAuth catalog (1,048 providers). [code]
6. **Design references to copy:**
   - **Nango agent sessions:** tag selectors must resolve to exactly one connection per integration, or creation fails. Plus `nango_create_connection` and a proxy that is off by default.
   - **Activepieces' hosted OAuth broker for self-hosted installs:** `/claim` and `/refresh`; tokens stay local.
   - **One's consent screen** that scopes connections, actions and levels, and echoes `access` back to the agent.
   - **WorkOS Relay's** "402 + `authorization_url`" plus `connection_owner: user | organization`.
   - **Gram's** single consent for all upstream grants and its annotation-based rules.
   - **Pipedream's** in-result connect link.
7. **Google is the hard case for a central broker, and the easy case for a company platform.**
   - Apps "only used by people in your Google Workspace … organization" need no OAuth verification. [live]
   - So a customer-owned "Internal" Google client avoids CASA, while an Every App-run broker would carry verification, quota and trust.
8. **Still differentiated:**
   - org-structured governance (org vs user connections, per-app consent, admins can only tighten, approvals);
   - triggers for agents (no MCP standard);
   - trustworthy action quality;
   - **apps on top of connections** (only Executor v2 and Every App);
   - **tokens staying in the customer's own cloud account.**

---

## 1. What changed in 2026 (acquisitions, pivots, relicensing, shutdowns)

| Product | Change | When | Evidence |
|---|---|---|---|
| **Pipedream** | Acquired by **Workday**. Signed 2025-11-19, and Workday reported it closed in its fiscal year ending 2026-01-31. The product still runs under the Pipedream brand, with Workday shown only as a customer logo on pipedream.com. | Closed by 2026-01-31 | [live] Workday FY26 Q4 release (SEC 8-K Ex. 99.1, 2026-02-24): "Workday closed the acquisition of Pipedream…", https://www.sec.gov/Archives/edgar/data/1327811/000132781126000010/wday-01312026x991.htm ; Pipedream's announcement https://pipedream.com/blog/pipedream-to-be-acquired-by-workday/ (seen in search results, not fetched) |
| **Pica → "One"** | Rebranded to **One** ("The trust layer for AI agents", withone.ai). The GitHub org moved `picahq` → `withoneai`. The GPL-3.0 "Pica Community Edition" repo says it "is no longer actively maintained". The product is now a hosted platform. | Rebrand in 2026 (`withoneai/cli` created 2026-02-13; CE notice 2026-02-20) | [live] https://withone.ai/ ; [code] `withoneai/pica` README |
| **ACI.dev (Aipolabs)** | **Pivoted away.** aci.dev now sells "Outcome Automation as a Service" for professional and financial-services firms, as fixed-scope 8–12-week engagements. The open-source `aipotheosis-labs/aci` repo has had only dependency bumps since 2026-04-24 (last commit 2026-05-28). Its MCP-gateway follow-up `gate22` was last pushed 2025-12-12. | H1 2026 | [live] https://www.aci.dev/ ; [code] commit log |
| **Klavis AI** | **Shifting focus** to RL/post-training data. The homepage leads with "Long-horizon coding data for frontier post-training" and "Realistic tool-use data". The pricing page says "Klavis AI provides live environments for training AI agents". The Strata/MCP docs are still online, but the `Klavis-AI/klavis` repo was last committed 2026-06-01. | 2026 | [live] https://www.klavis.ai/ , https://www.klavis.ai/pricing ; [code] |
| **Metorial** | **Relicensed** the integrations repo from Apache-2.0 (2025-10-30) to **FSL-1.1-ALv2** (2026-07-02, "Move over v2 integrations"). The platform repo was already FSL. It now positions itself as an "identity and access layer for AI agents" (YC F25). | 2026-07-02 | [code] `metorial/metorial` LICENSE history |
| **Nango** | Deprecated its "Connection MCP" in favor of **agent sessions** (scoped, expiring MCP endpoints with search/execute meta-tools). It added **MCP Auth**, which brokers OAuth to vendor MCP servers through static clients, DCR or CIMD. | Docs dated 2026-07-15 → 2026-10-06 | [code] `NangoHQ/nango` `docs/guides/agent-sessions.mdx`, `docs/guides/auth/mcp-auth.mdx` |
| **Speakeasy Gram** | Repositioned from "MCP server builder" to an "AI control plane" (observe, secure, connect, distribute). Code is AGPL-3.0, and pricing is enterprise-only. | 2026 | [code] `speakeasy-api/gram` README; [live] https://www.speakeasy.com/pricing |
| **Microsoft MCP Gateway** | The main branch now **requires MCP `2026-07-28` clients**: stateless, with no legacy init or sessions. | 2026 | [code] `microsoft/mcp-gateway` README |
| **MetaMCP** | The maintainer warns of maintenance delays. A community fork exists, and there has been no release since 2025-12-19. | 2026 | [code] README |
| **Cloudflare MCP server portals** | GA on 2026-09-24. Static OAuth clients for upstreams without DCR arrived 2026-07-31. Code Mode policies arrived 2026-07-30. | 2026-09-24 | `docs/research/2026-10-platform-review/raw/cf-agents-mcp-ai.md` §4 |
| **MCP spec 2026-07-28** | Stateless core. Separately, **Dynamic Client Registration (DCR) is marked deprecated in favor of Client ID Metadata Documents (CIMD)** (spec PR #2858). The earliest removal date for DCR is 2027-07-28. Registration order is pre-registered → CIMD → DCR → ask the user. | 2026-07-28 | [live] https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration ; [code] `modelcontextprotocol/typescript-sdk` `packages/client/CHANGELOG.md` (#2729, #2286) |
| **Official MCP Registry** | Still labeled **"preview"** (breaking changes or data resets possible). Growth exploded: 42,522 servers at latest version, 13,405 of them last published in September 2026 alone. | Ongoing | [api] https://registry.modelcontextprotocol.io/v0.1/servers ; [code] `modelcontextprotocol/registry` `docs/modelcontextprotocol-io/faq.mdx` |
| **integrations.sh** (new) | An MIT-licensed catalog of 5,572 "surfaces" (MCP, OpenAPI, GraphQL, CLI) with structured credential facts. It runs on Cloudflare Workers and is published by UsefulSoftwareCo, the company behind Executor. | Repo created 2026-05-11 | [code] `UsefulSoftwareCo/integrations`; [api] https://integrations.sh/api.json |
| **Archestra** (new-ish) | AGPL + enterprise "enterprise AI platform" with an MCP gateway (OAuth + on-behalf-of), a private registry and guardrails. 4.4k stars, very active. | 2025-07 → now | [code] `archestra-ai/archestra` |
| **Smithery** | **Acquired by Arcade.dev.** The co-founder joined Arcade and the product continues. The CLI now lives at `arcadeai-labs/smithery-cli` (AGPL-3.0). | 2026-08-05 | [live] https://www.arcade.dev/blog/smithery-joins-arcade/ ; [code] |
| **Arcade.dev** | $60M Series A (2026-06-12). Private Registry (2026-10-07). Prebuilt toolkits are under a **proprietary** license on PyPI. | 2026 | [sub]; [live] PyPI JSON for `arcade-gmail`, `arcade-slack` |
| **Rube (Composio)** | **Discontinued**; users sent to "Composio For You". | 2026-05-16 | [live] https://www.rube.app/ |
| **Toolhouse** | Pivoted to "AI workers". Developer SDK dormant since 2025-03. | 2026 | [sub] |
| **Pipedream Conduit** (new) | Employee MCP gateway in early access. Per-person or per-group grants, self-hostable Docker image. | 2026 | [live] https://pipedream.com/conduit |
| **Auth0 / Okta** | Auth for MCP GA (2026-05-21). Token Vault organization support around May. Okta Agent SSO (Cross App Access) GA 2026-08-24, "included in core Okta SSO at no additional cost". | 2026 | [sub]; Agent SSO [live] https://www.okta.com/newsroom/press-releases/okta-brings-first-class-identity-to-ai-agents-with-agent-sso/ |
| **superglue** | Pivoted to ERP-implementation agents. Relicensed GPL-3.0 → FSL. | 2025-11-28 | [sub]; [code] LICENSE |
| **Vendor MCP servers** | Google launched Workspace MCP servers (Gmail, Drive, Docs, Sheets, Slides, Calendar, Chat, People) as a **Developer Preview** that needs your own OAuth client. Slack's MCP server (announced 2026-02-17) accepts only registered Slack apps. Microsoft Graph and Work IQ MCP servers are in preview behind Entra app registration. Vercel, Figma, Square and Dropbox gate their DCR behind client allowlists. | 2026 | [live] https://developers.google.com/workspace/guides/configure-mcp-servers ; [sub] §5 |

---

## 2. Open-source and source-available products

GitHub snapshot for every repo examined, taken 2026-10-12 [code]:

| Repo | Stars | License | Last default-branch commit | Latest release |
|---|---:|---|---|---|
| NangoHQ/nango | 12,617 | **ELv2** (whole repo, incl. `providers.yaml`) | 2026-10-12 | v0.71.12 (2026-10-02) |
| activepieces/activepieces | 25,023 | **MIT** outside `packages/ee` + `server/api/src/app/ee` (commercial) | 2026-10-12 | 0.92.3 (2026-10-12) |
| n8n-io/n8n | 207,133 | **Sustainable Use License** (+ `.ee.` files commercial) | 2026-10-12 | stable (2026-10-12) |
| aipotheosis-labs/aci | 4,908 | Apache-2.0 | 2026-05-28 (deps only) | v0.0.1-beta.3 (2024-12) |
| Klavis-AI/klavis | 5,808 | Apache-2.0 | 2026-06-01 | ts-v2.20.0 (2026-01-29) |
| withoneai/pica (ex picahq/pica) | 1,486 | **GPL-3.0** | 2026-08-19 (CI only) | 1.59.0 (2025-07-16) |
| withoneai/mcp · withoneai/cli · withoneai/connect | 11 · 414 · 3 | MIT · none · GPL-3.0 | 2026-09/10 | — |
| ArcadeAI/arcade-mcp | 1,049 | MIT | 2026-10-09 | — |
| metorial/metorial · metorial/metorial-platform | 3,364 · 220 | **FSL-1.1-ALv2** | 2026-10-11 · 2026-10-12 | — |
| obot-platform/obot | 1,102 | MIT | 2026-10-12 | v0.26.3 (2026-10-08) |
| IBM/mcp-context-forge | 4,605 | Apache-2.0 | 2026-10-12 | v1.0.11 (2026-09-28); v1.0.0 was 2026-05-01 |
| docker/mcp-gateway | 1,595 | MIT | 2026-09-16 | v0.44.1 (2026-09-23) |
| docker/mcp-registry | 571 | MIT | 2026-09-16 (pushed 2026-10-12) | — |
| microsoft/mcp-gateway | 874 | MIT | 2026-10-02 | — |
| agentgateway/agentgateway (Linux Foundation) | 5,296 | Apache-2.0 | 2026-10-12 | v1.6.0 (2026-10-02) |
| stacklok/toolhive | 2,274 | Apache-2.0 | 2026-10-12 | v0.52.0 (2026-10-12) |
| mcpjungle/MCPJungle | 1,294 | **MPL-2.0** | 2026-08-02 | 0.4.6 (2026-08-02) |
| speakeasy-api/gram | 273 | **AGPL-3.0** | 2026-10-12 | server@2.22.0 (2026-10-12) |
| PipedreamHQ/pipedream | 11,729 | **Pipedream Source Available License 1.0** | 2026-10-09 | — |
| windmill-labs/windmill | 18,164 | **AGPLv3** backend/frontend; Apache-2.0 clients; proprietary EE | 2026-10-12 | v1.830.0 (2026-10-09) |
| metatool-ai/metamcp | 2,703 | MIT | 2026-06-22 | v2.4.22 (2025-12-19) |
| modelcontextprotocol/registry | 7,344 | Apache-2.0 (MIT legacy contributions) | 2026-10-11 | v1.8.1 (2026-08-06) |
| APIs-guru/openapi-directory | 4,574 | **CC0-1.0** | 2026-04-20 | — |
| UsefulSoftwareCo/integrations (integrations.sh) | 604 | MIT | 2026-10-12 | — |
| archestra-ai/archestra | 4,371 | **AGPL-3.0** + Archestra Enterprise License | 2026-10-12 | platform-v1.4.0-rc.37 |
| superglue-ai/superglue | 2,066 | **FSL-1.1-Apache-2.0** | 2026-08-19 | — |
| amp-labs/connectors (Ampersand) | 75 | MIT | 2026-10-09 | — |
| 1mcp-app/agent · AmoyLab/Unla · TheLunarCompany/lunar (MCPX) · lasso-security/mcp-gateway | 514 · 2,239 · 504 · 395 | Apache-2.0 · MIT · MIT · MIT | 2026-10-12 · 2026-08-27 · 2026-10-12 · 2026-01-22 | — |
| *(comparison)* ComposioHQ/composio · UsefulSoftwareCo/executor | 30,509 · 4,160 | MIT · MIT | 2026-10-12 · 2026-10-12 | executor@2.0.0-beta.15 (2026-10-11) |
| *(building blocks)* cloudflare/agents · better-auth/better-auth · panva/oauth4webapi · pilcrowonpaper/arctic | 5,815 · 30,273 · 786 · 1,717 | MIT ×4 | 2026-10-12 · 2026-10-12 · 2026-10-01 · 2026-08-08 | agents@0.28.0 · v1.7.7 · v3.8.8 · v3.7.0 (2025-05) |

The products split into three groups:

- **Integration hubs.** Each ships its own catalog of SaaS actions plus managed OAuth: Nango, Activepieces, n8n, Pipedream, Metorial, One/Pica, Klavis, ACI, Arcade.
- **MCP gateways.** They put existing MCP servers behind one endpoint with policy: Obot, ContextForge, Docker, Microsoft, agentgateway, ToolHive, MCPJungle, MetaMCP, Gram, Archestra.
- **Catalogs.** See §4.

The founder's idea needs a little of both of the first two groups: a catalog with managed per-user auth, **and** a gateway with policy and audit.

### 2.1 Nango — the strongest open(-ish) auth + tool layer

- **What:** an "Integrations for your products & agents" platform. It does managed auth for 1,000+ APIs, a proxy, code "functions" (actions, syncs, webhooks, triggers), and an MCP surface for agents. [live] https://nango.dev/
- **License and self-host:**
  - The whole repo, including `packages/providers/providers.yaml`, is **Elastic License 2.0**. ELv2 bans offering it "as a hosted or managed service" and bans circumventing license keys. [code] `LICENSE`
  - Free self-hosting is `docker-compose` and covers **Auth + Proxy only**. It has no tool calls, MCP server, syncs, webhooks, triggers, RBAC or audit trail. [code] `docs/guides/platform/self-hosting/self-hosting.mdx` ("Feature availability")
  - The full product self-hosts only on Enterprise, through BYOC (Nango operates it in your AWS, GCP or Azure) or Helm. It needs 5 Node services, Postgres, Redis, ElasticSearch/OpenSearch and S3/GCS/Azure object storage. [code] same file and `self-managed.mdx`
- **Integrations:**
  - `providers.yaml` has **1,048 provider entries**. By auth mode: 348 API_KEY, 307 OAUTH2, 106 OAUTH2_CC, 101 BASIC, 68 TWO_STEP, **34 MCP_OAUTH2 + 3 MCP_OAUTH2_GENERIC**, and a few others. [code]
  - The homepage claims "7,000+ reusable templates". [live]
- **Auth model:**
  - A "Connect UI" session for each end user creates a *connection*.
  - Connections carry **tags** (e.g. `organization_id`, `user_id`), so one connection can be per-user or org-wide.
  - Nango refreshes tokens, and the docs mention Redis "token refresh locks". [code] self-hosting doc
  - Whether you can bring your own OAuth client depends on the provider; `setup_guide_url` links "how to register your own … OAuth app". [code] `providers.yaml`
- **MCP Auth (new):** Nango can broker OAuth **to vendor-hosted MCP servers**.
  - Client registration modes: `static` (you register a client), `dynamic` (Nango does DCR), or `cimd` (Nango publishes a Client ID Metadata Document). A self-hosted Nango needs a public `https://` `NANGO_SERVER_URL` for CIMD.
  - A generic MCP provider prompts the user for any MCP server URL. It only works with DCR or CIMD servers. [code] `docs/guides/auth/mcp-auth.mdx`
  - In the catalog, 30 MCP providers are `dynamic`, 4 are `static` (Asana, HubSpot, Slack, Vercel), and 3 are other. [code] `providers.yaml`
- **Agent interface: agent sessions** (`POST /sessions`):
  - A session returns `mcp_url` + `session_token`.
  - **Tenant:** tag selectors (OR of ANDs, up to 10 entries) that must resolve to **exactly one connection per integration**, otherwise creation fails with `ambiguous_connections`. You can also pin a specific connection (`pinned`).
  - **Toolset:** per-integration `allow`/`deny`.
  - **Pinned tools:** listed directly. Everything else is searchable but unlisted.
  - **Meta-tools:** `nango_tool_search`, `nango_execute`, `nango_proxy` (off by default, because it bypasses allow/deny) and `nango_create_connection` (off by default; returns a connect link).
  - `expires_in` runs from 60 s up to 15 d (the default). Sessions are immutable, and `DELETE` revokes them.
  - [code] `docs/guides/agent-sessions.mdx`
- **Governance:** API-key scopes (e.g. `environment:agent_sessions:write`), RBAC, audit trail and logs (paid). There are no per-call human approvals in the session docs. [code]
- **Triggers:** yes: webhooks, triggers and syncs, through functions (paid). [live]
- **Pricing:**
  - Free: 10 connections, 10 compute-hours/month.
  - Pay-as-you-go: $50/month in credits; $0.29/connection, $0.72/compute-hour, $0.50/GB egress.
  - Enterprise: self-hosting/BYOC.
  - [live] https://nango.dev/pricing
- **Direction:** agent-first. One scoped MCP per agent run, MCP-to-MCP auth brokering, and tag-based tenancy.

### 2.2 Activepieces — the best MIT-licensed catalog of actions

- **What:** an open-source automation platform (flows, agents, tables) whose pieces double as **"~400 MCP servers"**. Every project also gets **one built-in MCP server**. [live] https://www.activepieces.com/mcp
- **License and self-host:**
  - MIT everywhere except `packages/ee/` and `packages/server/api/src/app/ee/`. EE covers global connections, OAuth-app overrides, audit logs, SCIM, managed authn, embedding and the agent module. [code] `LICENSE`, directory listing
  - Self-host with Docker, Postgres or embedded **PGlite**, and Redis or in-process `MEMORY`. [code] `docs/install/reference/environment-variables.mdx`
- **Integrations:** ~765 pieces (737 community + 27 core directories). [code] [live]
- **Auth model:**
  - Per-project "connections".
  - **Global connections** are shared across projects, can be included by default, and carry permissions. They need the Team plan or higher. [code] `docs/admin-guide/guides/global-connections.mdx`
  - **Self-hosted instances can use Activepieces-owned OAuth apps through a hosted broker.** It is on by default (`AP_CLOUD_AUTH_ENABLED=true`). See §8.2 for the full mechanism. [code]
  - Admins can override with their own client (EE). [code] `manage-oauth2.mdx`
- **Agent interface:** one OAuth-protected MCP endpoint per project. It works under a reverse-proxy sub-path and advertises PRM/AS metadata.
  - Tool categories can be toggled per project.
  - The core loop is **discover → inspect → execute**: `ap_search_actions` / `ap_search_triggers` (semantic search through pgvector + OpenAI embeddings, falling back to keyword search, with `mode` in every response), then `ap_get_piece_props`, then `ap_run_action` (1 credit) or `ap_build_flow`.
  - [code] `docs/mcp/overview.mdx`, `tool-search.mdx`, `tools.mdx`
- **Governance:**
  - Every new action must declare `classification: READ | SEARCH | WRITE | DESTRUCTIVE`, `audience: human | ai | both` and `aiMetadata: {description, idempotent}`. [code] `docs/build-pieces/piece-reference/ai-metadata.mdx`
  - MCP activity view. [code] `app/mcp/activity`
  - Audit logs on Ultimate/Enterprise. [live] pricing
  - No per-call human approval was found in the MCP docs.
- **Triggers:** yes, piece triggers (webhook and polling) start flows.
- **Pricing:** Free $0 (1,000 credits); Plus $20/month; Team $200/month (SSO, global connections); Ultimate custom (audit logs, SCIM); Embed from $36k/year. [live] https://www.activepieces.com/pricing
- **Runtime fit:**
  - `pieces-common` now uses a fetch-based HTTP client, and `pieces-framework` depends only on `zod`, `ai`, `semver` and `core-utils`. [code]
  - Many pieces pull Node SDKs: Gmail uses `@googleapis/*` + `nodemailer` + `mailparser`, Slack uses `@slack/web-api`, HubSpot uses `@hubspot/api-client`. [code] piece `package.json`
  - So running pieces unmodified on Workers would work for some and not others. [inference]

### 2.3 n8n — huge, but fair-code and workflow-shaped

- **What:** workflow automation with 400+ integrations. Its **instance-level MCP server** lets clients search workflows, run MCP-enabled workflows, build and edit workflows and data tables, and (from 2.34) manage agents. [docs] https://docs.n8n.io/advanced-ai/accessing-n8n-mcp-server/
- **License and self-host:** **Sustainable Use License**, which allows only "internal business purposes or … non-commercial or personal use" and paid redistribution is barred. Business/Enterprise features need a license key that "pings the license server daily". [code] `LICENSE.md`; [live] https://n8n.io/pricing/
- **Auth model:**
  - Credentials belong to users or projects.
  - Sharing works on all Cloud plans, but on self-hosted only on Business and Enterprise. [docs] https://docs.n8n.io/credentials/credential-sharing/
  - **Managed OAuth exists only on n8n Cloud and only for some Google nodes.** "Managed OAuth2 isn't available for self-hosted n8n users." [docs] https://docs.n8n.io/integrations/builtin/credentials/google/oauth-single-service/
- **Agent interface:**
  - MCP over OAuth or a personal token.
  - Workflows are opted in one by one (project/folder bulk toggles from 2.24; auto-expose from 2.36, off by default).
  - All connected clients see all enabled workflows; there is no per-client scoping.
  - [docs]
- **Governance:** user-scoped visibility and callback-URL allowlists (2.33). No approval step was described. [docs]
- **Pricing:** Starter €20, Pro €50, Business €667 (self-hosted), Enterprise custom, all billed annually. [live]
- **Takeaway:** n8n exposes *workflows* as tools, not raw SaaS actions. The SUL rules out embedding its code in an MIT product. [inference]

### 2.4 Pipedream (now Workday) — biggest catalog; the components are source-available

- **What:** Connect gives developers managed auth for **3,000+ APIs**, **10,000+ prebuilt tools and triggers**, a proxy and a remote MCP server. It claims 1M+ connected accounts. [live] https://pipedream.com/connect
- **License:**
  - The component registry is under the **Pipedream Source Available License 1.0**. It excludes "any commercial use … that competes with the Software or any other Pipedream products or services". [code] `LICENSE`
  - The repo has **3,401 app directories** under `components/`. Each `*.app.mjs` defines `propDefinitions`, and auth comes from Pipedream's runtime (`this.$auth…`), so there are no OAuth client configs in the repo. [code]
- **Auth model:**
  - Pipedream-hosted OAuth clients, or BYO.
  - Accounts are scoped by your `external_user_id`, and Pipedream refreshes tokens.
  - Users connect through a **Connect Link** (`pd.tokens.create`) or the browser SDK.
  - [live]
- **Agent interface:**
  - `https://remote.mcp.pipedream.net/v3`. You authenticate with a client-credentials token and send `x-pd-project-id`, `x-pd-environment`, `x-pd-external-user-id` and `x-pd-app-slug` headers.
  - There is one MCP server per app.
  - **If the account is missing, the tool result carries a connect URL**.
  - Errors are `isError:true` results with an `attribution` field.
  - [docs] https://pipedream.com/docs/connect/mcp/developers
  - The v3 endpoint's metadata also advertises OAuth with DCR (AS `mcp.pipedream.com`), so MCP clients can connect interactively too. [probe]
- **Triggers:** yes. Deployed triggers push events to a webhook. [live]
- **Pricing:**
  - Free covers development only.
  - Startup is $99/month billed annually, or about $150 monthly. It includes 100 external users, then **$2/user/month**, plus 10,000 credits, then $0.012/credit (1 credit = 30 s of compute).
  - Business is custom.
  - [live] https://pipedream.com/pricing (the page text was garbled, so confirm the monthly figure)

### 2.5 One (formerly Pica) — three meta-tools and scoped consent; hosted now

- **What:** "The trust layer for AI agents". It claims "959+ platforms" and "129,313+ verified tools". The MCP README says "700+". [live] https://withone.ai/ ; [code] `withoneai/mcp`
- **License:**
  - The legacy core (`withoneai/pica`) is GPL-3.0 and unmaintained.
  - `@withone/mcp` is MIT.
  - `withoneai/connect` (a drop-in OAuth flow for builders) is GPL-3.0.
  - The CLI repo has no license.
  - The platform itself is hosted and closed.
  - Its "knowledge" (verified tool docs) is published under a custom "One Knowledge License". [live]
- **Agent interface:**
  - **Three MCP tools no matter how many apps:** `list_one_integrations`, `find_one_actions` and `execute_one_action`. `find_one_actions` takes several `{platform, intent}` requests in one call and returns the chosen action plus alternatives, with documentation and digests.
  - Remote server: `https://mcp.withone.ai/mcp`. It uses OAuth with a **consent screen that scopes connections, actions and permission levels (read/write/admin)**, and it echoes the grant back as each connection's `access` field.
  - [code] `withoneai/mcp` README
- **Governance:** per-agent/app/action scopes, 403 for out-of-scope calls, one-click revoke, an audit trail, and "SOC 2 audit in progress". No approvals are mentioned. [live]
- **Pricing:** free for users; Connect is free for builders; revenue comes from enterprise, hosted agents and rate limits. [live]

### 2.6 Metorial — ambitious, but now FSL

- **What:** an "Open-source identity and access layer for AI agents" with **1,200+ integrations** (MCP, CLI, API), scoped permissions per agent, team and environment, and audit of "which agent acted with whose credentials". [code] README
- **License and self-host:**
  - **FSL-1.1-ALv2.** It bans "Competing Use" and converts to Apache-2.0 two years after each release.
  - Self-hosting runs on Docker Compose with Bun + Go services, **Postgres, MongoDB, Redis, Meilisearch, MinIO, OpenSearch and etcd**. [code] `metorial-platform/self-hosting.md`
  - Integrations are "slates": TypeScript packages deployed to AWS Lambda, with a 900 s maximum. [code] `slate.schema.json`
- **Integration format** (worth reading): `SlateTool.create(spec, {key, description, tags:{destructive, readOnly}}).input(zod).output(zod).handleInvocation(...)`. The auth declares its scopes with a human title and description each. [code] `integrations/linear/src/*`
- **Pricing:** Dev $0 (500k tool calls/month, up to 10 provider integrations, no production); Scale $250/month (2.5M calls); Enterprise custom with on-prem. [live] https://metorial.com/pricing

### 2.7 Klavis (Strata) and ACI.dev — both pivoted; read them as references, don't adopt them

- **Klavis Strata:** a single MCP server with progressive discovery. [live] https://www.klavis.ai/docs/concepts/strata
  - Meta-tools: `discover_server_categories_or_actions`, `get_category_actions`, `get_action_details`, `execute_action`, `search_documentation` and `handle_auth_failure` (intents `get_auth_url` / `save_auth_data`).
  - The repo has 109 MCP server directories, is Apache-2.0, and was last committed 2026-06-01.
  - The company's focus is now RL environments (§1).
- **ACI.dev:** 600+ tools, Apache-2.0, with a "unified MCP server" that does dynamic tool discovery. It is dormant (§1).

### 2.8 Arcade.dev — OSS framework, closed engine

- `arcade-mcp` (MIT) is a Python framework for MCP servers.
  - `@app.tool(requires_auth=GitHub(scopes=["repo"]))` declares per-tool OAuth needs. The engine prompts the user with a URL, stores and refreshes tokens, and injects the token per call. "The client and the LLM never see the token."
  - It ships 23 provider helper classes plus a generic `OAuth2`.
  - It "powers the 7,500+ prebuilt tools across 81 MCP servers at Arcade.dev". [code] `ArcadeAI/arcade-mcp` README
- The Arcade Engine itself (auth, hosted gateway) is a commercial product. See §3.

### 2.9 MCP gateways (aggregate MCP servers; little or no SaaS catalog)

| Gateway | Stack and deploy | Aggregation and discovery | Upstream auth | Policy and audit | Notes |
|---|---|---|---|---|---|
| **Obot** (MIT) | Go; Docker (dev) / Kubernetes (prod); Postgres | Composite MCP servers from selected tools; Git-backed MCP + Skills catalogs exposed through the **standard MCP Registry API** | "MCP OAuth, user and shared credentials, and Kubernetes secret bindings" | Access by user / IdP group; MCP and webhook filters can inspect, reject or modify calls; correlated audit logs; on-device "Obot Sentry" hooks for Claude Code, Codex, Cursor and VS Code | Also an LLM gateway and hosted sandboxes. [code] README |
| **IBM ContextForge** (Apache-2.0) | Python; PyPI/Docker; Redis federation; K8s | Federates MCP, A2A, REST and gRPC; REST→MCP adapter; virtual servers | "user-scoped OAuth tokens" plus an `X-Upstream-Authorization` passthrough | 40+ plugins; OTel; admin UI | v1.0.0 2026-05-01, v1.0.11 2026-09-28. [code] |
| **Docker MCP Gateway + Toolkit + Catalog** (MIT) | Go CLI plugin; Docker Desktop 4.50+ or CE | Profiles; per-tool allowlists; **dynamic MCP** meta-tools `mcp-find`, `mcp-add`, `mcp-config-set`, `mcp-remove`, `mcp-exec`, `code-mode` (experimental) | Desktop secret store; built-in OAuth flows for catalog entries | Call tracing; signed images with SBOMs | Catalog has 328 servers (77 remote, 42 with OAuth). [code] [docs] https://docs.docker.com/ai/mcp-catalog-and-toolkit/dynamic-mcp/ |
| **Microsoft MCP Gateway** (MIT) | .NET; Kubernetes; Redis or Cosmos | Adapters (one per server) + "tool gateway router" `/mcp` | Entra ID app roles | RBAC | **2026-07-28-only, stateless.** Agents/sessions preview on Foundry. [code] |
| **agentgateway** (Apache-2.0, Linux Foundation) | Rust proxy; standalone YAML or K8s Gateway API | MCP federation, OpenAPI→MCP, A2A, LLM gateway | JWT, API keys, OAuth | **CEL** RBAC; guardrails; rate limits; OTel | v1.6.0 2026-10-02. [code] |
| **ToolHive** (Apache-2.0, Stacklok) | Go; containers per server; K8s operator; desktop app | Registry server (syncs the official registry); **vMCP** aggregation, composite workflows, optimizer, Starlark "code mode" | Embedded authorization server; **RFC 8693 token exchange** for backend APIs | Audit logging; OTel | Stacklok Enterprise is the upsell. [code] `cmd/vmcp/README.md`; [docs] https://docs.stacklok.com/toolhive/guides-vmcp/ |
| **MCPJungle** (MPL-2.0) | Go; SQLite or Postgres | One endpoint; "tool groups" | Per-server config | ACLs in "enterprise" mode | Small; release 0.4.6 2026-08-02. [code] |
| **MetaMCP** (MIT) | Node; Docker + Postgres | Namespaces → endpoints; middleware; tool overrides | API keys | — | Maintenance slowed. [code] |
| **Gram** (AGPL-3.0, Speakeasy) | Go + Temporal; hosted SaaS | Gateway endpoints with meta-tools `list_servers`, `describe_server`, `describe_tools`, `execute_tool` | **One consent screen collects every upstream grant**; a token for one member is never forwarded to another | "Team Access" rules by **tool annotation** ("Block destructive tools" covers tools added later) | [live] https://www.speakeasy.com/docs/ai-control-plane/mcp-gateway/gateway-endpoints |
| **Archestra** (AGPL-3.0 + EE) | TypeScript; K8s | MCP registry, gateway, orchestrator, chat | OAuth + On-Behalf-Of | Guardrails; OTel | [code] README |

None of these runs on Cloudflare Workers. They need containers, Kubernetes, Python, Go, Rust or .NET, plus Postgres or Redis. [inference from the stacks above]

All the OSS gateways are free to self-host. I confirmed one enterprise upsell: ToolHive's README links "Stacklok Enterprise" [code]. Paid editions for the others were not checked. None of them ship a SaaS action catalog or managed OAuth apps. They assume you bring MCP servers, and they handle auth *to* those servers through DCR, CIMD, static clients or token exchange.

### 2.10 Windmill resource types (brief)

- `backend/oauth_connect.json` defines **31 OAuth providers**. Each has `auth_url`, `token_url`, default `scopes` and **labeled `scope_options`** (e.g. Gmail: "Send mail only", "Read and search mail", "Draft and send mail"). [code]
- Resource types sync daily from hub.windmill.dev. [code] `windmill-common/src/hub_resource_types.rs`
- The backend is AGPLv3, so read it for UX ideas but don't copy code. [inference]

## 3. Commercial products

A helper agent gathered most of this section live today. I re-fetched the most surprising claims myself and marked them [live]: Arcade acquiring Smithery, Rube's shutdown, Pipedream Conduit, Arcade toolkit licenses on PyPI, WorkOS Pipes, and some repo licenses. Everything else is [sub], meaning it was fetched live by the helper but not re-checked by me.

| Product | What | Integrations | Auth model | Agent interface | Governance | Triggers | Pricing | 2026 status |
|---|---|---|---|---|---|---|---|---|
| **Zapier MCP** | Hosted MCP over Zapier actions | 9,000+ apps; 30,000+ actions (another page says "66,000+ triggers and actions") | Zapier holds credentials. Connections belong to the signed-in Zapier account, not your end users. | One endpoint (`mcp.zapier.com/api/v1/connect`). "Agentic" mode has 16 meta-tools (`discover_zapier_actions`, `enable_zapier_action`, `execute_zapier_read_action` / `_write_action`…). | App/action allowlists; history log | Not via MCP | Every plan; **2 tasks per tool call** | Built for one person's agent, not multi-tenant embedding. Docs advise "each user their own server and token"; auth is OAuth (the default) or a long-lived connection token [live https://docs.zapier.com/mcp/overview/how-connections-work] |
| **Merge Agent Handler** | Per-user tool gateway | 190+ connectors | Per "Registered User" via Merge Link; group-shared credentials; BYO OAuth app for branding | MCP URL per Tool Pack × user: "The URL selects; the key authorizes." Meta-tools `search_tools`, `request_tool_access`. | DLP (allow/redact/block), audit, SCIM | Not documented | Free $0 (2,000 credits); Pro **$1,000/mo** (25,000 credits); Enterprise adds on-prem and SIEM streaming [live https://www.merge.dev/pricing/agent-handler] | In the Microsoft Agent Store [sub] |
| **Paragon ActionKit** | Embedded integrations API + MCP for SaaS products | 130+ integrations / "1000+ actions" | Your OAuth apps through the Connect Portal; users identified by a JWT you sign; "User-Configured OAuth" lets a customer bring their own client | REST + hosted MCP; self-hostable `paragon-mcp` (README says MIT, package.json says ISC) | Event logs; SSO/RBAC | Yes; ActionKit Triggers beta 2026-05-06 | Not published | [sub]; repo [code] |
| **StackOne** | Integration gateway for agents | 540+ connectors / 33,000+ actions | Managed auth per linked account; recommends your own OAuth app before production | `mcp.stackone.com/mcp`. Consent picks accounts and can narrow to single actions (1 h tokens, 90-day grant). Search/Execute pair, with an admin setting of allowed, user's choice, or enforced. | Per-action/field/user permissions; audit; prompt-injection scanning (`@stackone/defender`, Apache-2.0, 0.9.0, 2026-10-10 [live npm]) | "Agent Webhooks" | Free (1k credits/seat); Team $600/mo | [sub] |
| **Membrane** (ex-Integration.app) | Integration infrastructure with AI-built connectors | Claims 100,000+ | Tenant JWT; platform refreshes and reconnects | API, CLI, Skills, MCP, SDK | Logs, alerts | Events (webhook or polling) | Not published | Self-host via Docker/Helm; auth-proxy consent added 2026-09-01 [sub] |
| **Smithery** | Registry + hosting + Connect | 26,325+ servers listed. Registry API `totalCount` = 19,776 [api]. | Smithery-run OAuth apps; **write-only credentials**; connection states `connected \| auth_required \| input_required \| error` with `setupUrl` | Connect REST; namespace MCP URL (`mcp.smithery.run/{namespace}`); CLI | Scoped tokens (TTL ≤ 24 h; a child token can never exceed its parent) | Preview: signed webhooks, subscriptions that expire unless renewed | Unclear | **Acquired by Arcade, 2026-08-05** [live https://www.arcade.dev/blog/smithery-joins-arcade/]. The CLI moved to `arcadeai-labs/smithery-cli` (AGPL-3.0) [code]. |
| **Glama** | Registry + hosting + MCP gateway | 97,619 servers; 30,026 remote connectors | Gateway-managed OAuth 2.1 with refresh | Gateway endpoint per deployment | Full JSON-RPC logs, per-tool access, **alerts when tool definitions change** | No | Tiered; hosting metered | Cites a 2026 scan in which 52% of 2,181 remote endpoints were dead [sub] |
| **Toolhouse** | Now "AI workers" (email/Slack/Teams) | 1,000+ or 5,000+ (the page disagrees with itself) | Not documented | Workers; MCP to extend | Spend cap | — | $5 per 1,000 requests | **Pivoted.** Developer SDK dormant: last release 2025-03-06 [sub] |
| **WorkOS Pipes** | Managed OAuth tokens + proxy | 300+ | **Bring your own OAuth credentials.** Per-user by default; org-shared via `connection_owner: "organization"`; refresh; `missingScopes` | `getAccessToken`, widget, **Relay** (WorkOS calls the API; missing connection → **402 + `authorization_url`**), Pipes MCP template (MIT) | Human-approved, provider-scoped grants in the MCP template; "Airlock" verdicts (allowed / needs approval / denied), early access | No | Not published | Pipes MCP shipped 2026-03-19 [live https://workos.com/docs/pipes] |
| **Auth0 for AI Agents** (Okta) | Token Vault + CIBA + FGA + Auth for MCP | 34 providers | Per-user connected accounts; organization support around May 2026; RFC 8693 token exchange; "does not create a shared organization account" | SDKs; Auth for MCP (GA 2026-05-21) | **CIBA async approval** with rich authorization requests (Guardian push); FGA; audit | — | AI add-on = +50% of base plan [sub] | Token Vault: per-user only, "does not create a shared organization account"; three token-exchange types (refresh, access, privileged worker JWT) [live https://auth0.com/ai/docs/intro/token-vault] |
| **Okta Cross App Access / Agent SSO** | IdP-issued grants (ID-JAG) for agent → app | Partners incl. Slack, Notion, Linear | ID-JAG via token exchange, then JWT-bearer grant; MCP "Enterprise-Managed Authorization" (SEP-990) | MCP TS SDK has `CrossAppAccessProvider` | IdP policy | — | Agent SSO "included in core Okta SSO at no additional cost" | Agent SSO GA **2026-08-24**. Cross App Access is "the official Enterprise-Managed Authorization extension for the Model Context Protocol". Prebuilt partners include Claude, Asana, Atlassian, Canva, Figma, Granola, Linear, Notion, Slack and Supabase [live https://www.okta.com/newsroom/press-releases/okta-brings-first-class-identity-to-ai-agents-with-agent-sso/] |
| **Cloudflare MCP portals** | Zero Trust MCP aggregator | Your servers, ≤80 per portal | Access login; per-server OAuth (DCR or manual client); per-user or admin credential | One `/mcp`; Code Mode search/execute | Access policies, allowlists, aliases, logs, DLP | — | Cloudflare One free < 50 users, then $7/user/mo | GA 2026-09-24 (see `cf-agents-mcp-ai.md` §4) |
| **Arcade.dev** | Agent action runtime + MCP gateways | 8,000+ tools (7,500+ across 81 servers in the docs) | Arcade's own OAuth apps are "for development and single-tenant use". Production needs your own apps plus a custom **user verifier**. | Gateways at `api.arcade.dev/mcp/{slug}`; user via Arcade Auth, your OIDC IdP, or an `Arcade-User-ID` header | **Contextual-access hooks** (access/pre/post; any deny stops the call; 5 s default timeout; each hook fails open or closed); audit; Private Registry (2026-10-07) | None found | Free 2k calls + 2k auths; Team $25/mo + $0.01/call + $0.10/auth | $60M Series A (2026-06-12); acquired Smithery. **Prebuilt toolkits are proprietary:** `arcade-gmail` 4.2.0 and `arcade-slack` 2.5.1 carry "Proprietary - Arcade Software License Agreement v1.0" on PyPI, while `arcade-mcp-server` and `arcade-tdk` are MIT [live PyPI]. Engine self-hosts via Helm on Enterprise. [sub] |

**Brief checks** [sub unless marked]:

- **Scalekit AgentKit:** 500+ connectors, per-user virtual MCP URLs, triggers. Free tier; Growth $99/mo.
- **Descope Agentic Identity Hub:** connections vault, RFC 8693 brokering, MCP auth with DCR/CIMD, ID-JAG.
- **Stytch Connected Apps:** inbound only. "Stytch has joined Twilio."
- **Truto:** 850+ integrations; any integration becomes an MCP server, scoped by method, tag and TTL.
- **Unified.to:** 1,310+ integrations; per-connection MCP; Grow $750/mo.
- **Apideck MCP:** 200+ connectors; dynamic mode with `list_tools` / `describe_tool` / `execute_tool` / `list_scopes`; MIT repo.
- **Airbyte:** agent SDK and hosted MCP. `airbyte-agent-connectors` now redirects to `airbyte-agent-sdk` (ELv2).
- **superglue:** pivoted to ERP-implementation agents. Relicensed GPL-3.0 → FSL on 2025-11-28.
- **Anon:** pivoted to enterprise agents.
- **Rube (Composio):** **discontinued 2026-05-16**. Users are sent to "Composio For You". [live https://www.rube.app/]

**New 2026 commercial entrants worth knowing:**

- **Pipedream Conduit** (early access): an employee-facing MCP gateway. 3,000+ connectors plus any MCP/OpenAPI/GraphQL you bring; grants per workspace, group or person; IdP provisioning; audit log; **a single Docker image to self-host, or managed cloud**. The page doesn't mention Workday. [live https://pipedream.com/conduit]
- **Runlayer:** enterprise MCP control plane. $30M Series A on 2026-06-24.
- **Keycard:** per-request short-lived credentials under Cedar policies, plus ID-JAG.
- **MCP Manager:** joined Usercentrics on 2026-01-14.

## 4. Catalogs and registries usable as data for an Every App connector catalog

| Source | License of the data/code | Size (2026-10-12) | What a record gives you | How to get it | Fit for Every App |
|---|---|---|---|---|---|
| **Official MCP Registry** | Registry code Apache-2.0 (older contributions MIT). Entries are publisher metadata, and no data license is stated. | **42,522** servers at latest version: 27,112 have `remotes`, 16,987 have `packages`, 519 are deprecated. Only 15,707 sit under verified domain namespaces; 26,815 are `io.github.*`. 13,405 were last published in Sep 2026. | name, description, version, `remotes[]` (URL, transport, optional `headers` for API keys on 4,637 servers), `packages[]`. **No OAuth metadata:** clients discover auth at runtime through PRM. | `GET https://registry.modelcontextprotocol.io/v0.1/servers?version=latest&limit=100&cursor=…`, no auth needed [api] | Good for **finding official vendor endpoints by namespace** (e.g. `com.notion/mcp`, `app.linear/linear`, `com.atlassian/atlassian-mcp-server`, `com.stripe/mcp`, `io.github.github/github-mcp-server`). Too noisy to show users unfiltered. Still "preview" [code: `docs/modelcontextprotocol-io/faq.mdx`]. |
| **integrations.sh** (UsefulSoftwareCo) | **MIT** (repo) | 5,572 surfaces across 3,300+ domains: 3,529 OpenAPI, 1,323 MCP, 604 CLI, 116 GraphQL. Feeds include apis-guru (2,067), the OpenAI (663) and Claude (121 + 101 shared) connector directories, and 94 curated entries. [api] | Per domain: surfaces, plus **`credentials` defined once and bound per surface** with mechanics (header name, scheme, "well-known" = MCP OAuth), setup prose, `generateUrl`, and a provenance tag of **`detected` (machine signal) or `discovered` (LLM read the docs)**. It detected CIMD on Linear's MCP. | `GET https://integrations.sh/api.json` (2.8 MB envelope), `GET /api/{domain}/surface`, `GET /api/{domain}/detect`, plus an MCP server (`detect`, `discover`) [api] | **Best permissively licensed seed for "how do I authenticate to X".** It runs on Cloudflare Workers itself. Treat `discovered` facts as hints. The same company makes Executor, which uses this catalog for Quick Add (see `raw/executor-update.md`). |
| **Nango `providers.yaml`** | **ELv2** | 1,048 providers, of which **37 are MCP OAuth providers**, each marked `client_registration: dynamic \| static`. | `authorization_url`, `token_url`, scope separators, `authorization_params`, `token_params`, `refresh_params`, `disable_pkce`, `token_request_auth_method`, `proxy.base_url`, retry and rate-limit headers, pagination, webhook routing, `setup_guide_url`. | Raw file in the repo [code] | The richest OAuth catalog. The license makes it unusable as an embedded MIT asset [inference: needs legal review]. Use it to cross-check your own entries. |
| **Activepieces pieces** | **MIT** (non-EE) | ~765 pieces | Per piece: `PieceAuth.OAuth2({authUrl, tokenUrl, scope[]})`, actions and triggers with zod-like props, plus agent metadata (`classification`, `audience`, `aiMetadata`) | npm `@activepieces/piece-*` or the repo [code] | Best MIT source of **action definitions plus risk metadata**. |
| **Ampersand `connectors`** | **MIT** (Go) | ~382 provider files | `AuthURL`, `TokenURL`, `BaseURL`, grant type, token-response metadata fields, post-auth metadata (e.g. Slack `teamId`), and support flags (read/write/proxy/subscribe) | Repo `providers/*.go` [code] | An MIT-clean OAuth endpoint table. You would need to extract it from Go source. |
| **Docker MCP registry** | **MIT** | 328 servers: 77 remote, 42 with an `oauth:` block | `type: remote`, `remote.url`, `oauth.provider`, `config.secrets`, `run.allowHosts` | Repo `servers/*/server.yaml` [code] | A small curated list of remote MCP URLs. OAuth is handled by the gateway's own flow, which includes DCR registration. Tokens live in Docker Desktop's Secrets Engine, the OS credential helper (CE), or `docker pass` [code: `docker/mcp-gateway` `pkg/oauth/mode.go`, `dcr_registration.go`]. So the `oauth:` blocks don't carry over to other tools. |
| **Smithery registry** | Proprietary service | 19,776 servers (`totalCount`) | qualifiedName, `remote`, `isDeployed`, `verified`, `useCount` | `GET https://registry.smithery.ai/servers?pageSize=…`, no auth needed for listing [api] | Popularity signal (`useCount`). Many entries are Smithery-hosted wrappers. |
| **APIs.guru openapi-directory** | **CC0-1.0** | 2,529 APIs, 3,992 specs, 108,837 endpoints [api] `https://api.apis.guru/v2/metrics.json` | OpenAPI specs | API or repo | Long-tail OpenAPI. The last commit was 2026-04-20, so updates are slowing. |
| **Pipedream components** | **Source-available, non-compete** | 3,401 app dirs | Actions and sources (triggers) in JS, with no OAuth client configs | Repo | Read-only reference. |
| **Windmill `oauth_connect.json`** | **AGPLv3** | 31 providers | URLs, default scopes, **labeled scope options** | Repo | UX reference only. |
| **Metorial integrations ("slates")** | **FSL-1.1-ALv2** | 1,000+ packages | TS tools with `tags:{destructive, readOnly}`, scopes with titles | Repo | Reference only until each release converts to Apache-2.0 two years later. |

**Takeaway [inference]:** there is no single permissively licensed catalog that has OAuth endpoints, scopes, *and* agent-ready actions. The MIT-clean combination is:

- integrations.sh for "what surfaces exist and how to authenticate";
- Ampersand and Activepieces for OAuth endpoints, scopes and actions;
- the official MCP Registry for vendor MCP URLs.

Hand-verify the ~30 providers that matter most.

## 5. Vendor-hosted official remote MCP servers, and how a gateway authenticates to them

**What the spec says now** [live https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration]:

- Clients SHOULD try registration methods in this order: (1) pre-registered client info, (2) **CIMD** if the AS sets `client_id_metadata_document_supported`, (3) DCR as a fallback, (4) ask the user.
- The page says: "**Dynamic Client Registration is deprecated.** New implementations should use Client ID Metadata Documents instead."
- CIMD client IDs "are portable across authorization servers … No re-registration is needed."

**Method:**

- **[probe]:** on 2026-10-12 I read each server's public OAuth metadata with no token, recording whether the AS advertises a `registration_endpoint` (DCR) and `client_id_metadata_document_supported` (CIMD). Two steps:
  1. RFC 9728 protected-resource metadata.
  2. The AS's RFC 8414 / OIDC metadata.
  - Script: `/tmp/everyapp-research-2/scripts/probe_mcp_auth.py`.
- **[sub]:** a helper agent read each vendor's docs live today for status, restrictions and doc URLs. I re-checked Google Workspace myself [live].
- Cross-checks: integrations.sh's machine-detected signals (with dates), Nango's `client_registration` field, and the official MCP Registry.
- **Caveat:** advertising DCR doesn't mean a vendor accepts *any* client. Several gate DCR behind an allowlist (see the "gated" column).

| Vendor | Endpoint | DCR | CIMD | Gated / pre-registered client? | Status and restrictions [sub unless marked] | Docs |
|---|---|---|---|---|---|---|
| **Linear** | `mcp.linear.app/mcp` (`/mcp/readonly` too) | yes | **yes** | open | Launched 2025-05-01. API key or OAuth token as Bearer. Okta-managed auth optional. | https://linear.app/docs/mcp |
| **Notion** | `mcp.notion.com/mcp` | yes | **yes** | open | OAuth only; no non-interactive auth yet. Workspace owners manage clients. | https://developers.notion.com/docs/get-started-with-mcp |
| **Atlassian Rovo** (Jira, JSM, Confluence, Bitbucket, Loom) | `mcp.atlassian.com/v2/mcp` | yes | **yes** (v2 only) | open, but admin domain/IP allowlists | v1 moves to v2 tools on 2027-03-01. API token or service-account key if the admin enables it. Some calls use Rovo credits. v2 exposes `discover` / `execute` meta-tools by default. | https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/ |
| **Sentry** | `mcp.sentry.dev/mcp` | yes | **yes** | open | Org- and project-scoped URLs. | https://mcp.sentry.dev |
| **Airtable** | `mcp.airtable.com/mcp` | yes | **yes** | open; Enterprise admins may need to allowlist | All plans; PAT also accepted. | https://support.airtable.com/docs/using-the-airtable-mcp-server |
| **monday.com** | `mcp.monday.com/mcp` | yes | **yes** | install the "monday MCP" marketplace app | — | https://monday.com/w/mcp |
| **Canva** | `mcp.canva.com/mcp` | yes | **yes** | open [probe] | Help page returned 403 to the fetcher. | — |
| **Cloudflare** | `mcp.cloudflare.com/mcp` (product servers `*.mcp.cloudflare.com` set CIMD `false`) | yes | **yes** (main) | open | Supports the 2026-07-28 spec. The main server is **Code Mode**: `search`, `execute`, `docs`, "~1,000 tokens vs ~1.17M". | https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/ |
| **Granola** | `mcp.granola.ai/mcp` | yes | **yes** | open [probe] | — | — |
| **Zendesk** | `mcp.zendesk.com/mcp` | **no** | **yes** | **CIMD-only** public client [probe] | No public doc found. | — |
| **Stripe** | `mcp.stripe.com` | yes (public clients) | no | admin on/off switch | Or an Agent API key as Bearer: only Agent-tagged keys accepted from 2026-10-31. Human approval for refunds and payouts. Generic `stripe_api_search` / `details` / `read` / `write` tools. | https://docs.stripe.com/mcp |
| **Supabase, Neon** | `mcp.supabase.com/mcp`, `mcp.neon.tech/mcp` | yes | no | open | Supabase: PAT for CI, read-only and per-project modes, "not for end users". Neon: "development and testing only"; SSE retired 2026-10-01. | https://supabase.com/docs/guides/getting-started/mcp ; https://neon.com/docs/ai/neon-mcp-server |
| **Intercom** | `mcp.intercom.com/mcp` (+ EU) | yes | no | **redirect-URI allowlist** (Claude and Cursor already allowed) | API token also accepted. | https://developers.intercom.com/docs/guides/mcp |
| **ClickUp, Calendly** | `mcp.clickup.com/mcp`, `mcp.calendly.com` | yes | no | open | ClickUp: OAuth only, daily caps by plan (100–25,000). Calendly: clients needing a pre-registered ID "will not work". | https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server ; https://developer.calendly.com/docs/mcp |
| **Zapier** | `mcp.zapier.com/api/v1/connect` | yes | no | open | Or a per-server token. 2 tasks per call. | https://docs.zapier.com/mcp/overview/how-connections-work [live] |
| **PayPal, Webflow, Miro, Attio** | `mcp.paypal.com/mcp`, `mcp.webflow.com/mcp`, `mcp.miro.com`, `mcp.attio.com/mcp` | yes | PayPal and Webflow: `false` | open [probe] | — | https://developer.paypal.com/tools/mcp-server/ |
| **Figma** | `mcp.figma.com/mcp` | advertised | no | **gated:** only clients in the Figma MCP Catalog (waitlist) | Call limits by seat type. | https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/ |
| **Vercel** | `mcp.vercel.com` | advertised | no | **gated:** only reviewed and approved clients (14 listed) | Public beta 2025-08-04. Nango marks it `static`. | https://vercel.com/docs/agent-resources/vercel-mcp |
| **Square** | `mcp.squareup.com/mcp` | advertised | `false` | **gated:** client allowlist | Beta; production data only. | https://developer.squareup.com/docs/mcp |
| **Dropbox** | `mcp.dropbox.com/mcp` (+ Dash) | advertised | no | **gated:** DCR only for trusted clients (Claude, ChatGPT/Codex, Cursor); others need their own Dropbox app | Beta (page dated 2026-09-30). | https://help.dropbox.com/integrations/connect-dropbox-mcp-server |
| **Salesforce** | `api.salesforce.com/platform/mcp/v1/…` | advertised by `login.salesforce.com` [probe] | no | **unverified.** Salesforce DCR historically needs an initial access token [inference]. | The endpoint answers 401; scope `mcp_api`; the docs returned 403 to the fetcher. | — |
| **Slack** | `mcp.slack.com/mcp` | **no** | no | **pre-registered:** a registered Slack app with a hard-coded app ID. Only directory-published or internal apps; admin approval. | Announced 2026-02-17. "Slack MCP and Skills Plugin" 2026-07-31. | https://docs.slack.dev/ai/mcp-server |
| **GitHub** | `api.githubcopilot.com/mcp/` | **no** | no | **pre-registered.** OAuth only works in hosts GitHub registered (VS Code, Visual Studio, JetBrains, Xcode, Eclipse, Cursor). Otherwise a PAT. Orgs restricting OAuth apps must approve each host. | GA 2025-09-04. Copilot Business/Enterprise need the "MCP servers in Copilot" policy. | https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server |
| **Asana** | `mcp.asana.com/v2/mcp` | **no** | no | **pre-registered:** register an "MCP app"; "DCR is not supported". Enterprise+ admins allow or block each client. | V1 (`/sse`, DCR) deprecated. | https://developers.asana.com/docs/integrating-with-asanas-mcp-server |
| **HubSpot** | `mcp.hubspot.com` | **no** | no | **pre-registered:** create an "MCP connector" for a client ID and secret. PKCE required. | Some tools only work in Claude, ChatGPT or Gemini. | https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server |
| **Box, Zoom** | `mcp.box.com`, `mcp.zoom.us/mcp/{zoom,meeting,chat,docs,…}/streamable` | **no** | no | **pre-registered.** Box: an admin creates the client and enables MCP. | — | https://developer.box.com/guides/box-mcp/remote/ |
| **Google Workspace** | `{gmail,drive,docs,sheets,slides,calendar,chat}mcp.googleapis.com/mcp/v1`, `people.googleapis.com/mcp/v1` | **no** | no | **pre-registered:** your own OAuth client ("Web application") in a Cloud project, plus enabling the APIs *and* the "MCP" services | **Developer Preview: needs the Workspace Developer Preview Program** (page updated 2026-10-09). Per-product read and write scopes. | https://developers.google.com/workspace/guides/configure-mcp-servers [live] |
| **Google Cloud** | `{service}.googleapis.com/mcp` (~70 services) | **no** | **no** (Google says it supports neither) | OAuth client, ADC bearer token, or API key | Mostly GA. | https://docs.cloud.google.com/mcp/authenticate-mcp |
| **Microsoft** | Graph/Entra: `mcp.svc.cloud.microsoft/enterprise`; Work IQ (Mail, Calendar, Teams, SharePoint, Word): `agent365.svc.cloud.microsoft/…`; Dataverse; Azure DevOps | **no** (Entra) [probe] | no | **pre-registered:** Entra app registration + consent. Work IQ needs an M365 Copilot license and admin allow. | Graph and Work IQ are preview. The Graph server is read-only. | https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview |
| **Shopify** | No remote Admin-API server. Per-shop commerce servers only. `setup.shopify.com/mcp` is **CIMD-only** [probe]; its purpose wasn't verified. | — | — | — | — | https://shopify.dev/docs/apps/build/storefront-mcp |

**Registry coverage** [api + sub]: the official MCP Registry has vendor-published remote entries for GitHub, Linear, Notion, Atlassian, Stripe, Sentry, Neon, Supabase, Airtable, Figma, Canva, monday, PayPal, Cloudflare, Vercel, Zapier, Zoom, Google Cloud and Microsoft Work IQ. It has **none** for Slack, Asana, HubSpot, Intercom, ClickUp, Box, Dropbox, Square, Salesforce, Zendesk, Calendly or Shopify. So the Registry alone can't drive a vendor catalog.

**What this means [inference]:**

- **Open + CIMD** (Linear, Notion, Atlassian, Sentry, Airtable, monday, Canva, Cloudflare, Granola, Zendesk): a self-hosted gateway can connect with **zero registration**. It serves `https://<gateway>/…/client.json` as its client ID.
- **Open + DCR only** (Stripe, Supabase, Neon, ClickUp, Calendly, Zapier, PayPal, Intercom…): works today. DCR is deprecated, with removal no earlier than 2027-07-28.
- **Gated DCR** (Figma, Vercel, Square, Dropbox) and **pre-registered** (Slack, GitHub, Asana, HubSpot, Box, Zoom, Google, Microsoft): these vendors decide which *clients* may connect.
  - A self-hosted Every App can't get onto Figma's or Vercel's allowlist as thousands of separate clients.
  - With CIMD, all installs could share one recognizable client-ID *domain pattern*, but allowlists today are per client ID.
  - Practical paths: each customer registers its own app (fine for Slack "internal apps", Google "internal" clients, Entra app registrations, Box admin clients); Every App runs a broker app (the Activepieces model; it must then pass each vendor's review); or the customer uses an aggregator.
- **These gated and pre-registered vendors are the ones a company platform needs most** (Slack, Google, Microsoft, GitHub, HubSpot). That is the real cost of the integration-hub idea. It is also why managed OAuth apps are a paid feature at Composio and Pipedream, and why Arcade says its own apps are "for development and single-tenant use" only.
- Okta's Cross App Access (§8 item 31) is the emerging enterprise answer for Slack, Asana, Atlassian, Linear and Notion in Okta shops.
- **Vendors are shipping meta-tools and code mode themselves:** Cloudflare (Code Mode), Atlassian v2 (`discover` / `execute`), Stripe (generic API tools), Microsoft Graph (raw read-only queries). So a ToolBus that proxies vendor MCP servers should **not** re-expand their tools. Pass the vendor's own meta-tools through, namespaced.

## 6. (a) Comparison table

### Integration hubs (catalog + managed auth + agent surface)

| Product | License / self-host | Runs on | Integrations | Auth (managed app? per-user/org?) | Agent interface | Governance | Triggers | Price entry point | ★ / last commit | 2026 status |
|---|---|---|---|---|---|---|---|---|---|---|
| **Nango** | ELv2. Free self-host = auth + proxy only. Enterprise = BYOC or Helm. | Node ×5 + Postgres + Redis + ES + S3 | 1,048 providers (37 MCP) | Connect UI; tags make connections per-user or org; refresh with locks; MCP Auth (static/DCR/CIMD) | Agent sessions → per-session MCP; `nango_tool_search` / `execute` / `proxy` / `create_connection` | API-key scopes, RBAC, audit (paid); toolset allow/deny | Yes (webhooks, syncs) | Free (10 conns); $50/mo PAYG | 12.6k / 2026-10-12 | Agent-first pivot |
| **Activepieces** | MIT core + commercial EE. Docker; Postgres or PGlite; Redis or memory. | Node | ~765 pieces | Connections per project; **Global Connections** (Team+); hosted OAuth broker for self-host; BYO client (EE) | Per-project OAuth MCP; search → props → run; categories toggle | `classification` / `audience` metadata; audit logs (Ultimate+) | Yes (piece triggers) | Free; $20; $200 | 25.0k / 2026-10-12 | Strong, MCP-centric |
| **n8n** | Sustainable Use License | Node + DB | 400+ | Credentials per user or project; sharing on self-host needs Business+; managed OAuth on Cloud only (some Google) | Instance MCP: workflows as tools; OAuth or PAT | User-scoped; callback allowlist; no approvals described | Yes | €20/mo | 207k / 2026-10-12 | MCP grows each release |
| **Pipedream Connect** (Workday) | SaaS; components source-available (non-compete) | SaaS | 3,000+ APIs, 10k+ tools | Hosted OAuth clients or BYO; `external_user_id`; Connect Links | Remote MCP per app (`remote.mcp.pipedream.net/v3`), headers; in-result connect URL; proxy | Not documented on MCP page | Yes (deployed triggers) | Startup $99/mo + $2/user | 11.7k / 2026-10-09 | Owned by Workday since FY26 |
| **One (ex-Pica)** | Hosted. Old core GPL-3.0, unmaintained. | SaaS | 700–959 platforms (claims vary) | Managed; grants, not credentials | Remote MCP with **3 tools**; OAuth consent scopes connections, actions and levels | Per-agent/app/action scopes; revoke; audit | Webhooks page exists | Free for users | 1.5k (CE) | Rebranded 2026 |
| **Metorial** | FSL-1.1-ALv2. Docker Compose (8 stores). | Bun + Go + Lambda | 1,200+ | OAuth, keys, service accounts; reuse across projects and people | MCP, CLI, API, SDK sessions | RBAC, SSO, scoped permissions, audit | Slates support triggers | Dev $0; Scale $250 | 3.4k / 2026-10-11 | Relicensed 2026-07 |
| **Arcade** | `arcade-mcp` MIT; engine commercial (§3) | Python tools; SaaS engine | 81 MCP servers / 7,500+ tools | `requires_auth=Provider(scopes)`; engine stores and refreshes; URL challenge | MCP servers + SDKs | See §3 | — | See §3 | 1.0k / 2026-10-09 | Active |
| **Klavis Strata** | Apache-2.0 | Python/TS + SaaS | 100+ servers ("with OAuth support") | OAuth handled by Klavis (SaaS); `handle_auth_failure` meta-tool | 6 progressive meta-tools | — | — | — | 5.8k / 2026-06-01 | Pivoted to RL environments |
| **ACI.dev** | Apache-2.0 | Python + Postgres | 600+ tools | "Multi-tenant Authentication: built-in OAuth flows and secrets management for both developers and end-users" [code README] | Unified MCP (separate `aci-mcp` repo); dynamic discovery | "granular permissions" | — | — | 4.9k / 2026-05-28 | Pivoted to services |
| *(comparison)* **Composio** | MIT SDK; SaaS platform | SaaS | 1,603 toolkits (`toolkits.json`) | Managed or BYO; PRIVATE/SHARED accounts | Sessions + MCP + search | See `raw/composio.md` | Yes | See `raw/composio.md` | 30.5k | See `raw/composio.md` |
| *(comparison)* **Executor** | MIT; Docker self-host (v2) | Workers (v1 cloud) | integrations.sh-backed | Accounts via apps | Code mode + search/invoke | Per-tool approvals | Yes (v2) | Free / $15 per member | 4.2k | See `raw/executor-update.md` |

### MCP gateways (aggregate servers you bring; little or no SaaS catalog)

| Product | License | Runs on | Upstream auth | Discovery | Policy and audit | ★ / last commit |
|---|---|---|---|---|---|---|
| Obot | MIT | Go; Docker/K8s | MCP OAuth; user and shared creds; K8s secrets | Composite servers; Git-backed catalogs; MCP Registry API | Group ACLs; filters; audit; device hooks | 1.1k / 2026-10-12 |
| IBM ContextForge | Apache-2.0 | Python; Redis; K8s | User-scoped OAuth tokens; header passthrough | Virtual servers; REST/gRPC→MCP | 40+ plugins; OTel | 4.6k / 2026-10-12 |
| Docker MCP Gateway | MIT | Go; Docker | Desktop secrets; OAuth flows | Profiles; `mcp-find` / `mcp-add` / `code-mode` | Tool allowlists; tracing; signed images | 1.6k / 2026-09-16 |
| Microsoft MCP Gateway | MIT | .NET; K8s | Entra ID roles | Adapters + tool router | RBAC; stateless 2026-07-28 | 0.9k / 2026-10-02 |
| agentgateway (LF) | Apache-2.0 | Rust | JWT, API keys, OAuth | Federation; OpenAPI→MCP | CEL RBAC; guardrails | 5.3k / 2026-10-12 |
| ToolHive | Apache-2.0 | Go; containers; K8s | Embedded AS; RFC 8693 exchange | vMCP; optimizer; Starlark code mode | Audit; OTel | 2.3k / 2026-10-12 |
| MCPJungle | MPL-2.0 | Go; SQLite/Postgres | Per server | Tool groups | ACLs (enterprise mode) | 1.3k / 2026-08-02 |
| MetaMCP | MIT | Node; Postgres | API keys | Namespaces; middleware | — | 2.7k / 2026-06-22 |
| Gram (Speakeasy) | AGPL-3.0 | Go + Temporal; SaaS | One consent for all upstream grants | `list_servers` → `describe_tools` → `execute_tool` | Annotation-based team rules; threat detection; logs | 0.3k / 2026-10-12 |
| Archestra | AGPL-3.0 + EE | TS; K8s | OAuth + On-Behalf-Of | Private registry | Guardrails; OTel | 4.4k / 2026-10-12 |
| Cloudflare MCP portals | Proprietary (Cloudflare One) | Cloudflare | Per-user upstream OAuth or admin credential; static clients | `portal_query_tools` / `portal_execute`; code mode policies | Access; Gateway DLP; Logpush (Enterprise) | GA 2026-09-24 |

### Commercial hubs and auth layers

See the table in §3. In one line each:

- **Integration hubs:** Zapier MCP (biggest catalog, single-user), Merge Agent Handler and StackOne (per-user enterprise gateways), Paragon and Membrane (embedded, for SaaS vendors), Pipedream Connect and Conduit, Arcade + Smithery.
- **Auth layers without a catalog:** WorkOS Pipes, Auth0 Token Vault, Okta Cross App Access, Scalekit, Descope.
- **Pivoted away:** Toolhouse, Rube, ACI, Klavis.

## 7. (b) Best open-source building blocks for Every App

**License key for an MIT project:**
- **MIT/Apache-2.0/CC0:** embed freely; keep the notices.
- **MPL-2.0:** file-level copyleft. Fine to run as a separate service; changes to MPL files must be shared.
- **AGPL/GPL:** embedding forces Every App's distributed or network-served combination under (A)GPL. Not compatible with staying MIT.
- **SUL (n8n), ELv2 (Nango), FSL (Metorial, superglue), Pipedream SAL:** source-available with use restrictions (internal use only, no managed service, no competing use). They can't be relicensed as MIT, and "integration hub" is exactly the competing use they forbid.
- **BSL:** none of the products here use BSL today.

**Can it run on Workers?** Only libraries and data can. Every *platform* in this report needs Node or Python or Go or Rust or .NET services, plus Postgres, Redis or other stores. The exceptions are Executor v1's Cloudflare host and integrations.sh, which are Workers apps. [inference from §2]

### 7.1 Embed (MIT/Apache, Workers-compatible)

| Block | What it gives Every App | License | Workers? | Notes |
|---|---|---|---|---|
| **`@modelcontextprotocol/client`** (MCP TS SDK) | The gateway acts as an **MCP client** to vendor-hosted servers (Linear, Notion, Sentry, Atlassian, Stripe…). Its OAuth uses **CIMD** (`clientMetadataUrl`) when the AS advertises `client_id_metadata_document_supported`, and falls back to DCR. It also ships Cross-App Access helpers. | Apache-2.0/MIT | Yes [inference: the same SDK family already ran in workerd in the platform-review spike] | [code] `packages/client/src/client/auth.ts` L1309-1332. DCR is marked deprecated in favor of CIMD (spec PR #2858), with removal no earlier than 2027-07-28 [code: `packages/client/CHANGELOG.md`]. |
| **`@cloudflare/workers-oauth-provider`** | Already the plan for `/mcp`. | MIT | Yes | `impl/mcp-design.md` |
| **Better Auth `linkSocial` + `getAccessToken` + `refreshToken`** | Per-user connections for ~36 built-in providers, including **Google, GitHub, Slack, Linear, Notion, Atlassian, Microsoft Entra ID, Salesforce, Zoom, Dropbox, Figma, Vercel** [code: `packages/core/src/social-providers/`]. "If the token has expired, Better Auth refreshes it before returning it." [docs] Optional `account.encryptOAuthTokens` (default `false`) [code: `packages/core/src/types/init-options.ts`]. | MIT | Yes (already in the gateway) | Caveats: sign-in accounts and data connections share one table. It has no org-shared connections. Custom `refreshAccessToken` isn't supported for Generic OAuth providers [docs]. Probably better as a reference than as *the* connection store [inference]. |
| **`oauth4webapi`** (panva) | A low-level OAuth/OIDC client for any JS runtime: PKCE, refresh, DCR, DPoP | MIT | Yes | v3.8.8 (2026-09-05) |
| **`arctic`** | Provider presets (60+) | MIT | Yes | Last release v3.7.0 (2025-05), so it moves slowly. |
| **`@cloudflare/codemode`** | One `code` tool over many tools | MIT | Yes (DO facets) | Covered in `2026-10-platform-review/raw/cf-agents-mcp-ai.md` §2.4 |
| **integrations.sh catalog** | Seed data: MCP endpoints, auth kind, credential setup prose, provenance | MIT | It *is* a Worker | §4 |
| **Activepieces pieces (non-EE)** | Action definitions and **risk metadata** for ~765 apps; OAuth URLs and scopes | MIT | Partly: `pieces-common` is fetch-based, but popular pieces depend on `@googleapis/*`, `nodemailer` and `@slack/web-api` [code] | Use as data, or port the top-N actions [inference] |
| **Ampersand `connectors`** | OAuth endpoint table for ~382 providers | MIT | Data | Go source |
| **Docker MCP registry, APIs.guru** | Curated remote-MCP list; OpenAPI long tail | MIT; CC0 | Data | §4 |

### 7.2 Interoperate with, don't embed

| Product | How Every App would use it | Why not embed |
|---|---|---|
| Vendor-hosted remote MCP servers (§5) | **Upstreams behind ToolBus.** The gateway holds per-user (or per-org) tokens in D1 and namespaces the tools. | Nothing to embed. This is the cheapest broad coverage [inference]. |
| Nango (Cloud or Enterprise) | An optional "bring your Nango" backend: call its proxy or agent-session MCP with tag selectors such as `org_id`/`user_id`. | ELv2; free self-host is Auth+Proxy only and needs Docker + Postgres + Redis |
| Pipedream Connect, Composio, Arcade, Zapier MCP, Merge Agent Handler, Paragon ActionKit, StackOne, One (§3) | Optional upstream MCP servers ("bring your own aggregator"), with the org's API key stored in the gateway | Proprietary SaaS. Per-user or per-call pricing. Tokens live in the vendor's cloud. |
| Activepieces / n8n deployments | A customer can run them next to Every App, and n8n's instance MCP or Activepieces' project MCP plugs in as a ToolBus upstream. | They are platforms, not libraries. n8n is SUL. |
| Obot, ContextForge, ToolHive, agentgateway, MS MCP Gateway, Docker, Cloudflare MCP portals | Enterprises can put **Every App's `/mcp` behind their gateway** as one upstream. | Not Workers. Wrong layer. |

### 7.3 Read for ideas only

Gram (AGPL), Windmill (AGPL), Archestra (AGPL + EE), Pica CE and One Connect (GPL-3.0), Metorial and superglue (FSL), n8n (SUL), Nango (ELv2) and Pipedream components (SAL).

## 8. (c) Best design references (specific mechanisms to copy)

### 8.1 Connections and tenancy

1. **Nango agent sessions: tenant selectors that must resolve to exactly one connection per integration.**
   - A session's tenant is an OR of tag-AND selectors (≤10). You can also pin a connection ID.
   - If two connections match one integration, creation **fails** with `ambiguous_connections` and lists the candidates. It never guesses.
   - An integration with no match shows up as `connected:false`, and its calls return an error that tells the agent what to do next.
   - This handles "my Gmail, but the org's Salesforce" cleanly.
   - https://github.com/NangoHQ/nango/blob/master/docs/guides/agent-sessions.mdx [code]
   - **Copy as:** an Every App MCP connection (the `mcp_connections` row in `impl/mcp-design.md`) resolves each integration to exactly one credential, either user-owned or org-owned, at consent time.
2. **Org-shared vs per-user credentials as an explicit, visible choice.**
   - Activepieces "Global Connections": an admin creates one connection, picks which projects get it, and sets whether new projects get it by default.
     - https://github.com/activepieces/activepieces/blob/main/docs/admin-guide/guides/global-connections.mdx [code]
   - Cloudflare portals: "Require user auth" (per-user upstream OAuth) vs an admin credential shared by everyone.
     - `2026-10-platform-review/raw/cf-agents-mcp-ai.md` §4.2
   - The trade-off to show in the UI: a shared credential loses per-user identity at the upstream.
3. **Label each connection with the account it is.** Activepieces' `getConnectionIdentifier` renders "<user> (<workspace>)" for Slack.
   - https://github.com/activepieces/activepieces/blob/main/packages/pieces/community/slack/src/lib/auth.ts [code]

### 8.2 Getting auth from users and vendors

4. **Hosted OAuth broker for self-hosted installs (Activepieces "cloud OAuth2").**
   - The self-hosted UI fetches public client IDs from `https://secrets.activepieces.com/apps`.
   - It opens the provider's consent screen with `redirect_uri = https://secrets.activepieces.com/redirect`.
   - The server posts `{code, codeVerifier, clientId, tokenUrl, pieceName, edition}` to `/claim`. The broker exchanges the code with its client secret and returns tokens, which are stored **on the self-hosted instance**.
   - Refresh goes through `/refresh`.
   - It is on by default (`AP_CLOUD_AUTH_ENABLED=true`), and admins can override with their own client.
   - Code:
     - https://github.com/activepieces/activepieces/blob/main/packages/server/api/src/app/app-connection/app-connection-service/oauth2/services/cloud-oauth2-service.ts
     - https://github.com/activepieces/activepieces/blob/main/packages/web/src/features/connections/utils/oauth2-utils.ts
     - [code]
   - **This is the only open-source example found of "self-hosted, yet zero-setup OAuth".**
   - Costs [inference]:
     - The broker sees tokens at claim and refresh time.
     - It shares rate limits across all installs.
     - It puts the vendor's name on consent screens.
     - It makes the vendor carry Google restricted-scope verification.
5. **Per-provider client-registration mode for MCP OAuth: `static | dynamic | cimd`.**
   - Nango records this per provider (`client_registration` in `providers.yaml`).
   - It publishes a CIMD document from its own public URL, and falls back to a static client where the vendor demands one. As of today that is Asana, HubSpot, Slack and Vercel in Nango's catalog.
   - https://github.com/NangoHQ/nango/blob/master/docs/guides/auth/mcp-auth.mdx [code]
   - **Copy as:** each self-hosted gateway publishes its own CIMD at `https://<gateway>/…/client.json`, so vendors that accept CIMD need no per-customer registration.
6. **Google "Internal" apps skip verification.**
   - "The app is only used by people in your Google Workspace or Cloud Identity organization": no verification is needed, provided the Cloud project is owned by the org and the consent screen is set to internal.
   - Admin-trusted apps are also exempt.
   - https://support.google.com/cloud/answer/13464323 [live]
   - For a company-internal platform, a BYO Google client created in the customer's own org avoids the CASA/annual re-verification that restricted Gmail scopes require for public apps (https://support.google.com/cloud/answer/13463073 [live]).
7. **In-band connect links.** When a tool needs an account the user hasn't connected, the agent gets a link to hand the user, not a dead end:
   - Pipedream puts a Connect URL in the tool result. https://pipedream.com/docs/connect/mcp/developers [docs]
   - Nango has `nango_create_connection`, which returns `connect_url` with an expiry and auto-tags the new connection so later sessions find it. [code]
   - Klavis has `handle_auth_failure` (`get_auth_url`). https://www.klavis.ai/docs/concepts/strata [live]
8. **One consent screen for many upstream grants.** Gram's gateway collects every member's upstream OAuth grant on one screen, and never forwards a token minted for one member to another. https://www.speakeasy.com/docs/ai-control-plane/mcp-gateway/gateway-endpoints [live]
9. **Scoped consent echoed back to the agent.**
   - One's remote MCP consent screen lets the user pick connections, actions and permission level (read/write/admin).
   - `list_one_integrations` then returns each connection's `access`, so the agent knows what it may run without trial and error.
   - https://github.com/withoneai/mcp [code]
10. **Human-readable scope choices.** Windmill shows Gmail scopes as "Send mail only / Read and search mail / Draft and send mail". https://github.com/windmill-labs/windmill/blob/main/backend/oauth_connect.json [code]

### 8.3 Tool metadata and policy

11. **Per-action agent metadata, required in the catalog format.** Activepieces requires every new action to declare:
    - `classification: READ | SEARCH | WRITE | DESTRUCTIVE`;
    - `audience: human | ai | both` (raw-HTTP escape hatches default to `human`);
    - `aiMetadata: {description (when to pick me over siblings), idempotent}`.
    - https://github.com/activepieces/activepieces/blob/main/docs/build-pieces/piece-reference/ai-metadata.mdx [code]
    - This maps closely onto ToolBus's planned `risk: read | write | destructive`: SEARCH folds into read.
12. **Policy by annotation, not by tool name.** Gram's "Block destructive tools" rule also covers tools added later. [live] Cloudflare WriteGuard's tiers are similar (`READ_ONLY`, `MINIMAL_IMPACT`, `CONTAINED_WRITE`, `CRITICAL`). `cf-agents-mcp-ai.md` §3

### 8.4 Agent discovery surface

13. **Search that admits "nothing fits" and reports degraded mode.**
    - Activepieces ranks semantically with a relevance threshold, so an empty result means nothing fits.
    - It falls back to keyword search when no embedding model is configured, and returns `mode: semantic | keyword` in every response.
    - https://github.com/activepieces/activepieces/blob/main/docs/mcp/tool-search.mdx [code]
    - Executor's lexical scorer is the D1-friendly alternative (`ref-executor.md` item 3).
14. **Batch intent resolution.** One's `find_one_actions` takes many `{platform, intent}` pairs plus an overall `task` in one call, and returns the pick, a substitute and alternatives for each. [code]
15. **Pinned vs searchable tools.**
    - Nango lists only meta-tools and pinned tools in `tools/list`, paginated 50 at a time. Everything else is callable but found through search.
    - The proxy escape hatch is **off by default**, because it bypasses allow/deny lists.
    - [code] agent-sessions doc
16. **Session-scoped additions.** Docker's `mcp-add` adds a server for the current session only; it isn't saved to the profile. https://docs.docker.com/ai/mcp-catalog-and-toolkit/dynamic-mcp/ [docs]

### 8.5 Credential catalog and errors

17. **Provenance on every catalog fact.**
    - integrations.sh tags each fact `detected` (re-checkable machine signal, e.g. `client-id-metadata-document`, `mcp:initialize`, with `verifiedAt`) or `discovered` (read from docs, with evidence URLs).
    - It defines credentials once and binds them per surface with exact mechanics (`in: header`, `headerName`, `scheme`).
    - https://integrations.sh/api/linear.app/surface [api]; https://github.com/UsefulSoftwareCo/integrations [code]
18. **Error attribution.** Pipedream's failed tool calls carry an `attribution` field saying where the failure came from (upstream API vs platform). [docs]

### 8.6 From commercial products (fetched live by the helper agent [sub]; the WorkOS docs were re-checked by me [live])

19. **"Needs auth" is its own status, not a 401.** WorkOS Relay returns **402 with an `authorization_url`** when the user hasn't connected the account. Plain token calls return `{"active": false}`. Relay is meant for agents and untrusted runtimes; the token never enters your environment. https://workos.com/docs/pipes/relay
    - Every App's version: the gateway proxy already injects the OpenAI key. Extend it the same way: apps call `gateway → provider` and never hold a token. A missing connection returns a typed error that carries a connect URL [inference].
20. **Explicit connection owner, no silent fallback.** WorkOS Pipes takes `connection_owner: "organization"` vs per-user (the default), and reports `missingScopes`. https://workos.com/docs/pipes
21. **User verifier after OAuth.** This stops a forwarded connect link from attaching an account to the wrong user. https://docs.arcade.dev/en/build/user-facing-agents/secure-auth-production ; https://docs.scalekit.com/agentkit/user-verification.md
22. **Connection states with a setup URL:** `connected | auth_required | input_required | error` with `setupUrl`. Credentials are write-only. https://smithery.ai/docs/use/connect
23. **Narrowable, short-lived tokens.** A child token can never exceed its parent, and TTL is ≤ 24 h. https://smithery.ai/docs/use/token-scoping.md
24. **Per-user MCP URLs: "the URL selects, the key authorizes".** https://docs.merge.dev/merge-agent-handler/implementation-guides/mcp-integration
25. **Approval patterns:**
    - WorkOS's MCP template uses provider-scoped grants that expire after minutes, with read and write approved separately, plus single-use grants for one exact request. https://github.com/workos/pipes-mcp (MIT)
    - Auth0 uses CIBA with a rich authorization request describing the exact action. https://auth0.com/ai/docs/intro/asynchronous-authorization
    - Airlock returns a three-way verdict: allowed, needs approval, denied. https://workos.com/airlock
26. **Policy hooks that each fail open or closed.** Arcade's hooks: any deny stops the call, with a default 5 s timeout. https://docs.arcade.dev/en/operate/governance/contextual-access/how-hooks-work
27. **An admin knob for context mode.** StackOne's Search/Execute is allowed, user's choice, or enforced (https://docs.stackone.com/optimize/advanced-tool-search). Cloudflare portals' Code Mode policy is `off | opt_in | default_on | enforced`.
28. **Alert when an upstream changes its tool definitions** (rug-pull defense). https://glama.ai/mcp/gateway
29. **Triggers as expiring subscriptions with signed webhooks** (Standard Webhooks). https://smithery.ai/docs/build/triggers.md
30. **Customer-supplied OAuth app.** Each customer can bring its own client. https://docs.useparagon.com/resources/user-configured-oauth.md
    - This matters for self-hosted Every App, where each org can own its Google client (see item 6) [inference].
31. **Cross App Access (ID-JAG), also called "Enterprise-Managed Authorization" for MCP.**
    - The company's IdP (Okta) issues the grant, so users don't click through an OAuth consent screen per app. Admins decide centrally.
    - Okta made it GA on 2026-08-24, with prebuilt partners including Slack, Asana, Atlassian, Linear, Notion, Figma and Canva.
    - The MCP TS SDK client already ships the helpers (`requestJwtAuthorizationGrant` / `exchangeJwtAuthGrant`).
    - Sources: https://oauth.net/cross-app-access/ ; [live] Okta release above.
    - [inference] This is the likely enterprise path to the "pre-registered client" vendors in §5, Slack included. It is worth a later spike.

## 9. (d) Patterns that recur, and what is commoditized vs still differentiated

### 9.1 Recurring patterns (seen in 4+ products)

| Pattern | Who does it | Notes |
|---|---|---|
| **Small fixed meta-tool surface** (search → describe → execute) instead of N tools | Nango (`nango_tool_search` / `nango_execute`), One (3 tools), Activepieces (`ap_search_actions` / `ap_get_piece_props` / `ap_run_action`), Gram (4), Klavis Strata (6), Docker (`mcp-find` / `mcp-exec`), Cloudflare portals (`portal_query_tools` / `portal_execute`), Executor, Composio | Commoditized. The variation is in search quality (semantic, lexical, LLM-picked), batch intents, and whether schemas come back with search results. |
| **Opaque end-user ID supplied by the developer** | Pipedream `external_user_id`, Composio `user_id`, Nango connection tags | Commoditized. |
| **Connect link, hosted or in-band** | Pipedream Connect Link + in-result URL, Nango Connect UI + `nango_create_connection`, Klavis `handle_auth_failure`, Arcade's auth URL challenge, Composio | Commoditized. In-band links during agent calls are the 2026 addition. |
| **Managed OAuth app by default, BYO client for branding, quotas and scopes** | Pipedream, Composio, Activepieces, n8n Cloud (Google only), Arcade, Nango (per provider) | Commoditized, but fragile: managed apps share quotas and get withdrawn (Composio dropped 12 apps on 2025-12-09; see `raw/composio.md`). |
| **Per-user vs shared/org connections** | Nango tags, Activepieces Global Connections, Cloudflare portals (user auth vs admin credential), n8n credential sharing, Composio PRIVATE/SHARED | Every product does it differently. This matters most for *company* platforms. |
| **MCP-to-MCP auth brokering** (connect to vendor MCP servers via DCR, CIMD or a static client) | Nango MCP Auth, Cloudflare portals (static clients since 2026-07-31), Composio (`DCR_OAUTH`, `CIMD_OAUTH`), Executor Quick Add, Obot, ContextForge | New in 2026, commoditizing fast. CIMD is replacing DCR: DCR is marked deprecated, with removal no earlier than 2027-07-28. |
| **Tool risk metadata driving policy** | Activepieces `classification`, Metorial `tags.destructive/readOnly`, Gram annotation rules, Cloudflare WriteGuard tiers, Executor v2 per-tool approvals | Metadata is common. **Human approval UX is rare**: none of the OSS hubs here document per-call approvals (Executor v2 and some commercial products do; see §3). |
| **Scoped, expiring agent sessions** | Nango agent sessions (60 s–15 d, immutable), Composio sessions, Microsoft gateway sessions (preview) | Versus long-lived OAuth grants (One, Cloudflare portals, Every App's plan). Both have a place: sessions for server-side agents, grants for chat clients. |
| **Per-call audit log** | Nango, Activepieces (paid), Obot, ToolHive, ContextForge, Metorial, One, Gram | Commoditized, but usually a paid tier. |
| **Triggers/webhooks into agents** | Pipedream (deployed triggers), Nango (webhooks, syncs), Composio, Activepieces/n8n (flow triggers) | **Not** commoditized for agents. MCP has no standard trigger primitive, so every product rolls its own [inference]. |
| **Code mode** | Cloudflare `codemode` and portals, Docker (experimental), ToolHive (Starlark), Executor, Composio workbench | Spreading. Cloudflare's version runs natively on Workers. |

### 9.2 Commoditized (don't compete on these)

- Catalog size claims (1,000–3,000 "APIs", 10k–130k "tools").
- Managed OAuth for the top ~100 apps, and token refresh.
- An MCP endpoint, search/execute meta-tools and connect links.
- Basic audit logs.
- MCP gateway features: aggregation, namespacing, allowlists, OTel. Ten-plus OSS gateways do them, all Kubernetes- or container-centric.

### 9.3 Still differentiated

- **Trustworthy actions.**
  - Verified, maintained action knowledge (One's "verified tools", Activepieces' agent metadata).
  - Least-privilege scopes per tool (Composio's `recommendScopes`).
  - Error attribution.
- **Governance that matches a company's structure.**
  - Org vs user credentials.
  - Per-app and per-tool consent.
  - Admins can only tighten.
  - Approvals delivered out of band.
  - These are rarely all present together.
- **Self-hosted *and* zero-setup OAuth.** Among the open-source products checked, only Activepieces' broker does this. The others are SaaS-only or require your own client when self-hosted. Pipedream Conduit's self-hostable image may change that; its OAuth model when self-hosted wasn't documented on the page.
- **Triggers for agents at scale.**
- **Apps on top of connections.** Executor v2 and Every App. Nobody else in this list ships full apps that reuse the hub's connections.
- **Where the data lives.** Nearly every hub keeps tokens in its own cloud (Composio says owning the client "does not move the token store"; see `raw/composio.md`). Every App keeps them in the customer's Cloudflare account, which is a real differentiator for the "private company apps" buyer [inference].

## 10. What this means for Every App [inference throughout, built on the evidence above]

1. **Don't embed an integration platform. Build a thin "Connections" layer into the gateway.**
   - Every serious open-source hub is either license-restricted (Nango ELv2, n8n SUL, Metorial FSL, Pipedream SAL) or a heavy multi-service platform (Activepieces, Nango, Metorial).
   - None runs on Workers.
   - What Every App needs is a small set of D1 tables plus OAuth plumbing on Workers:
     - `connections` (owner = user | org, provider, scopes, encrypted tokens, account label);
     - `connection_grants` (which apps and which MCP connections may use them);
     - a provider table.
2. **Get the broadest coverage first by acting as an MCP *client* to vendor-hosted MCP servers.**
   - Use CIMD first: each gateway publishes its own client metadata document, so no per-customer registration is needed.
   - Fall back to DCR.
   - Use a pre-registered client where the vendor requires one: Slack, HubSpot, Asana, GitHub, Box, Zoom, Microsoft and Google.
   - Expect gated vendors (Figma, Vercel, Square, Dropbox) to be unreachable without their approval. See §5.
   - Snapshot the upstream tools into the ToolBus catalog and namespace them, the same way app tools are planned.
   - Where a vendor already exposes meta-tools or code mode (Atlassian v2 `discover`/`execute`, Cloudflare Code Mode, Stripe's generic API tools), pass those through namespaced. Don't re-expand them.
   - Nango's MCP Auth and Cloudflare portals show this works. The MCP TS SDK client already implements it.
3. **For the pre-registered-client vendors (Google Workspace first), default to a customer-owned OAuth client.**
   - The same Google token works against the REST APIs today.
   - It also works against Google's own Workspace MCP endpoints (`gmailmcp.googleapis.com/mcp/v1` and the rest) once they leave Developer Preview.
   - Google exempts *internal* apps from verification, so an org's own Google Cloud project is the right default for a private company platform.
   - Keep an Activepieces-style hosted OAuth broker as an *optional* later convenience, and be clear that the broker sees tokens and carries verification and quota.
4. **Extend the existing provider-hoisting pattern instead of inventing a new one.**
   - Today apps declare `providers:["openai"]` and the gateway injects the key. Generalize that to `providers:[{id:"google", scopes:["gmail.readonly"]}]`, with the gateway proxy injecting the user's or org's token. This is the WorkOS Relay model.
   - App Workers never hold third-party tokens.
   - A missing connection returns a typed "needs connection" error with a connect URL, not a 401.
5. **Make the owner of every connection explicit, and resolve exactly one connection per integration per grant.**
   - Use Nango's `ambiguous_connections` rule, WorkOS's `connection_owner`, and Activepieces' Global Connections as the models.
   - Show the account label, e.g. "ben@acme.com (Acme workspace)".
6. **Adopt per-tool metadata now.**
   - Fields: `risk` (`read | write | destructive`, matching Activepieces' classification), `audience`, and an agent-facing description that says when to pick the tool, plus `idempotent`.
   - Apply it to app tools *and* imported upstream tools. Unannotated upstream tools default to "write".
7. **Meta-tools for large catalogs are commodity.**
   - Ship `search` (lexical in D1, with a `mode` field), `describe` and `execute`.
   - Add a `connect` meta-tool that returns a connect link, like Nango's `nango_create_connection`.
   - Keep any raw-proxy escape hatch off by default, because it bypasses allowlists.
8. **Seed the catalog from MIT/CC0 sources only:** integrations.sh, the official MCP Registry (official namespaces only), Ampersand and Activepieces OAuth endpoints, and APIs.guru. Hand-verify the top ~30. Don't ship Nango's ELv2 `providers.yaml`.
9. **Allow "bring your own aggregator" as just another upstream.**
   - A Composio, Pipedream, Zapier, Arcade or Nango MCP endpoint, plus an org API key, becomes one more ToolBus upstream. That gives the long tail without Every App owning it.
   - Conversely, let enterprises put Every App's `/mcp` behind Cloudflare portals, Obot, ToolHive or Runlayer.
10. **Defer triggers.** No standard exists, and it is the most infrastructure-heavy piece. When needed, copy the "subscription that expires unless renewed + signed Standard Webhooks" shape (Smithery) and deliver events into app Workers through the gateway.
11. **Where Every App can differentiate:**
    - tokens stay in the customer's own Cloudflare account;
    - connections are reused by full apps, not just agents;
    - org-structured governance: per-app consent, admins can only tighten, approvals by browser link.

---

## 11. Sources (most important first)

1. Nango agent sessions (tenant selectors, toolsets, meta-tools, connect-link tool): https://github.com/NangoHQ/nango/blob/master/docs/guides/agent-sessions.mdx [code]
2. Nango MCP Auth (static, DCR or CIMD per provider) and `providers.yaml`: https://github.com/NangoHQ/nango/blob/master/docs/guides/auth/mcp-auth.mdx , https://github.com/NangoHQ/nango/blob/master/packages/providers/providers.yaml [code]
3. Nango self-hosting feature matrix (free = auth + proxy only): https://github.com/NangoHQ/nango/blob/master/docs/guides/platform/self-hosting/self-hosting.mdx [code]
4. Activepieces AI metadata, tool search, MCP tools: https://github.com/activepieces/activepieces/blob/main/docs/build-pieces/piece-reference/ai-metadata.mdx , https://github.com/activepieces/activepieces/blob/main/docs/mcp/tool-search.mdx , https://github.com/activepieces/activepieces/blob/main/docs/mcp/tools.mdx [code]
5. Activepieces hosted OAuth broker for self-hosted installs: https://github.com/activepieces/activepieces/blob/main/packages/server/api/src/app/app-connection/app-connection-service/oauth2/services/cloud-oauth2-service.ts [code]
6. integrations.sh (MIT catalog with credential facts): https://github.com/UsefulSoftwareCo/integrations , https://integrations.sh/api.json , https://integrations.sh/api/linear.app/surface [code][api]
7. Official MCP Registry API and FAQ: https://registry.modelcontextprotocol.io/v0.1/servers , https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/faq.mdx [api][code]
8. MCP TS SDK client CIMD/DCR logic and the 2026-07-28 DCR deprecation note: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/src/client/auth.ts , https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/CHANGELOG.md [code]
9. MCP 2026-07-28 client registration (CIMD preferred; "Dynamic Client Registration is deprecated"): https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration [live]
10. Vendor MCP auth docs: Google Workspace MCP (Developer Preview) https://developers.google.com/workspace/guides/configure-mcp-servers [live]; Slack https://docs.slack.dev/ai/mcp-server ; GitHub https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server ; Asana https://developers.asana.com/docs/integrating-with-asanas-mcp-server ; Vercel https://vercel.com/docs/agent-resources/vercel-mcp [sub]. Live OAuth-metadata probe script: `/tmp/everyapp-research-2/scripts/probe_mcp_auth.py` [probe]
11. One (ex-Pica) MCP: three tools and scoped consent: https://github.com/withoneai/mcp ; https://withone.ai/ [code][live]
12. Workday closes Pipedream (FY26 Q4 release): https://www.sec.gov/Archives/edgar/data/1327811/000132781126000010/wday-01312026x991.htm [live]
13. Pipedream Connect MCP for developers: https://pipedream.com/docs/connect/mcp/developers ; pricing https://pipedream.com/pricing ; Conduit https://pipedream.com/conduit [live]
14. Arcade acquires Smithery: https://www.arcade.dev/blog/smithery-joins-arcade/ [live]
15. WorkOS Pipes and Relay (402 + `authorization_url`, `connection_owner`): https://workos.com/docs/pipes [live]
16. Gram gateway meta-tools and single consent: https://www.speakeasy.com/docs/ai-control-plane/mcp-gateway/gateway-endpoints [live]
17. Google: when OAuth verification is not needed (internal apps): https://support.google.com/cloud/answer/13464323 [live]
18. Klavis Strata meta-tools: https://www.klavis.ai/docs/concepts/strata [live]
19. Docker dynamic MCP: https://docs.docker.com/ai/mcp-catalog-and-toolkit/dynamic-mcp/ [docs]
20. n8n instance-level MCP: https://docs.n8n.io/advanced-ai/accessing-n8n-mcp-server/ [docs]
21. ACI pivot: https://www.aci.dev/ ; Klavis focus: https://www.klavis.ai/ [live]
22. Metorial license history and self-hosting: https://github.com/metorial/metorial/commits/main/LICENSE , https://github.com/metorial/metorial-platform/blob/dev/self-hosting.md [code]
23. Cloudflare MCP portals (prior pass): `docs/research/2026-10-platform-review/raw/cf-agents-mcp-ai.md` §4
24. Composio and Executor deep reads (other researchers): `raw/composio.md`, `raw/executor-update.md`
