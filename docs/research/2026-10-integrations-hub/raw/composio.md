# Composio: what an agent integration hub looks like, and what Every App should copy

- Researched: 2026-10-12 (today). Training data was treated as stale; every product claim below was checked live unless marked otherwise.
- Subject: Composio (https://composio.dev, docs https://docs.composio.dev, GitHub org `ComposioHQ`).
- Why: the founder wants the Every App gateway to be an integration hub by default (connect Gmail/Slack/GitHub/Linear once; agents use them through one MCP endpoint; internal apps reuse the same connections). Composio is the best-known hosted version of that idea.
- Labels: **[live]** fetched today (URL given), **[docs]** Composio's own docs, fetched today, **[code]** read in source (path, line, SHA), **[inference]** my reasoning.
- Primary source: the full docs dump `https://docs.composio.dev/llms-full.txt` (1.58 MB, fetched 2026-10-12), plus individual pages, the dated changelog, and the API reference. A local copy is at `/tmp/everyapp-research-2/docs-fetch/` (not committed).
- Prior research this builds on (not redone): `docs/research/2026-10-platform-review/ROADMAP.md` (ToolBus plan) and `raw/ref-executor.md` (Executor deep read).

## Read this first

1. **What Composio is.** A hosted "managed action layer" for agents: SDKs and an MCP endpoint in front of a closed backend that stores users' OAuth tokens, runs ~60,000 pre-built tools, delivers triggers, and offers a Python sandbox. Catalog: 1,603 toolkits / 60,611 tools / 671 triggers — but only **123 toolkits have zero-setup Composio-managed OAuth**; 75% are API-key-only. $29M raised (Lightspeed Series A, Jul 2025); customers include Glean, Zoom, AWS Quick, Pelago Health. [docs; code; live]
2. **2026 has been rough.** A **credential breach disclosed 2026-05-21** (5,001 GitHub connections and 5,241 API keys exposed; the path ran through an internal agentic monitoring tool into "malicious tool definitions"), a ~36 h trigger outage in April whose events were lost, X suspending Composio's shared app, Rube (its consumer app) shut down on 2026-05-16, and a pricing reset on 2026-08-15. Some customers (Mintlify, Hyperagent) dropped it. [live]
3. **Data model worth copying.** *Auth config* (how a provider authenticates: Composio's shared OAuth app or your own client, scopes) vs *connected account* (one person's grant, with a status lifecycle, alias, and PRIVATE vs SHARED-with-ACL). Identity is a developer-supplied `user_id`. B2B guidance distinguishes member-owned from workspace-owned connections. [docs]
4. **Agent interface.** One session = one user's scoped tool policy. Agents see six meta tools — `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_GET_TOOL_SCHEMAS`, `COMPOSIO_MANAGE_CONNECTIONS`, `COMPOSIO_MULTI_EXECUTE_TOOL` (≤ 50 parallel), `COMPOSIO_REMOTE_WORKBENCH`, `COMPOSIO_REMOTE_BASH_TOOL` — plus opt-in `COMPOSIO_WAIT_FOR_CONNECTIONS` and `COMPOSIO_SUBMIT_FEEDBACK`. Search returns plans, pitfalls, schemas, connection status and the current time; responses over ~20k characters are offloaded to the sandbox. Every tool carries one of four behavior tags (read-only / create / update / destructive). No published accuracy evals since a 2024 function-calling blog. [docs; code]
5. **In-chat auth.** The agent hands the user a hosted Connect Link (10-minute expiry). Composio only added an (opt-in) defense against OAuth session fixation in July 2026. [docs]
6. **Governance is thin and recent.** Per-session allow/deny lists and tag filters, scoped API keys, IP allowlists. Approvals are only now arriving: experimental `require_approval` / `permissions` session settings delivered as MCP elicitation prompts, with SDK support released **today (2026-10-12)** — the SDKs raise an "input required" error but can't submit answers yet. Logs keep tool arguments and results for up to a year unless you pay for Zero Data Retention. SOC 2 Type II; US-only cloud; self-hosting is an enterprise Kubernetes deal. [docs; live]
7. **Open source.** The MIT repo (30.5k stars) is only the client: SDKs, provider adapters, CLI, docs. The backend (Apollo, Thermos, Mercury, Temporal, a vector store) is closed. SDK telemetry is on by default. The TypeScript SDK runs on Workers (no file helpers there), and there is no Cloudflare Agents SDK adapter. [code]
8. **Pricing.** Tool calls and delivered trigger events: 100K calls/month free, then $0.0003 per call ($0.0005 on Composio's shared apps), $0.003 per trigger event; IP allowlist, ZDR and BAA are per-call surcharges. Cheap for internal tools; cost isn't the issue. [live]
9. **Main weaknesses.** One multi-tenant vault = one big blast radius; shared OAuth apps fail for everyone at once; consent screens say "Composio" unless you bring your own client (and then Google verification/CASA is yours while Composio still holds the tokens); **tokens can't be exported**; constant breaking changes; broad default scopes; an undocumented per-IP 429 that hits Cloudflare Workers egress (#4207). [live; docs]
10. **"Apps on top" is open territory.** Composio has no apps, internal-tools or workflow product, and its developer platform and its staff-facing "For You" product don't even share connections. Every App's thesis — connect once at the gateway; agents *and* internal apps reuse it — fills exactly that gap.
11. **Recommendation** [inference]: build the hub into the gateway on Cloudflare primitives (option b): bring-your-own OAuth clients per org (a Google Workspace "Internal" client needs no Google verification), connect links bound to the gateway session, proxy-fetch for apps, provider events via Queues, ToolBus meta tools shaped like Composio's, and breadth from vendors' own MCP servers. Offer Composio only as an opt-in long-tail adapter (option a). Don't adopt an open-source engine wholesale (option c): the good ones are ELv2/source-available or the wrong runtime. Details in section 10.

---

## 1. What Composio is today (October 2026)

### 1.1 Positioning, in their words

| Where | Line |
|---|---|
| Homepage H1 + subhead [live: https://composio.dev] | "Give your AI secure access to 1,500+ apps in minutes" / "Connect Claude, ChatGPT, Hermes, or your own harness to almost any app. Then watch it go from chatting to doing." |
| Homepage meta description [live] | "Just-in-time tool calls, secure delegated auth, sandboxed environments, and parallel execution across 1,500+ apps." |
| Homepage section [live] | "Composio turns your AI into a doer. Composio sits between your AI and your apps, turning your requests into actions." |
| Enterprise page [live: /enterprise, via sub-research] | "Composio is the managed action layer for enterprise AI agents." |
| MCP Gateway page [live: /mcp-gateway] | "The secure MCP gateway for enterprise AI agents" — "a centralized security and control layer between AI agents and the MCP servers they call." |
| Developers page [live: /developers, via sub-research] | "Agent Infrastructure for Tool Execution" |
| Docs [docs: llms-full.txt header] | "Composio powers 1,600+ toolkits, tool search, context management, authentication, and a sandboxed workbench to help you build AI agents that turn intent into action." |
| LinkedIn [live, via sub-research] | "Building skills layer for AI Agents" |
| Series A post, Jul 2025 [live: /blog/series-a] | "We raised $29M to build skills that evolve with your agents" |

The story has moved from "tools for agents" (2024) to "skills that improve" (2025) to "managed action layer / governed MCP gateway" for enterprises plus a consumer MCP ("For You") in 2026.

### 1.2 Size claims (they disagree with each other)

| Claim | Where |
|---|---|
| 1,214 toolkits ("Showing 1–30 of 1214"); "20,000+ tools" | composio.dev/toolkits [live, via sub-research] |
| 1,603 toolkits; 60,611 tools; 671 triggers | docs catalog and the `toolkits.json` in the MIT repo [docs; code, computed] |
| "1,500+ apps" | homepage, pricing, MCP Gateway [live] |
| "1,600+ toolkits" / "1000+ toolkits" / "500+ apps" | llms.txt / GitHub repo and most docs pages / the `COMPOSIO_SEARCH_TOOLS` description [docs] |
| "10k+ tools" | Tool Router beta post, Oct 2025 [live] |
| Of 1,603 toolkits, 123 have Composio-managed OAuth; 1,203 are API-key-only | computed from `toolkits.json` (section 6.4) |
| Usage: "100M+ times a week" (homepage, per sub-research; not in the raw HTML I fetched); "over 100 million tool calls a month" and "200,000 developers" (Forbes India, 2026-01-22); "Users on Composio: 50,000+" (MCP Gateway page) | mixed [live]/[3p] |

### 1.3 Customers, money, team [live unless noted; via the company sub-research, spot-checked]

- **Customers** named on composio.dev: Glean (Composio is its actions layer for Agent Builder), Zoom (Zoom Mate), AWS ("AWS Quick embeds the Composio SDK in its own runtime"), Pelago Health (an internal Slack agent "Archie"; "160 Composio-powered agents"), Browser Use, Spinnable, Jam; older case studies include 11x, Slashy, Assista AI. Homepage logos also show Google, Wix, Emergent, Hostinger, Arizona State University, ClickFunnels.
- **Funding**: $25M Series A led by Lightspeed, announced 2025-07-22, $29M total (Elevation Capital, Together Fund and angels including Guillermo Rauch and Dharmesh Shah) [3p: PR Newswire]. No 2026 round found (search budget ran out; not conclusive).
- **Team**: founders Soham Ganatra (CEO) and Karan Vaidya; founded 2023; HQ San Francisco plus Bangalore. Headcount "about 25" (Forbes India, Jan 2026) vs 93 people on LinkedIn; 30 open roles on Ashby, heavily enterprise (AEs, solutions architects, forward-deployed engineers).

### 1.4 Product lines

| Product | What it is | Status |
|---|---|---|
| **Platform** (SDK + REST) | Sessions (ex Tool Router), auth configs, connected accounts, triggers, proxy execute, custom tools, Custom MCP | Main developer product |
| **Composio For You / Connect** | Consumer and staff MCP at `https://connect.composio.dev/mcp`, CLI (`curl -fsSL https://composio.dev/install`), plugins for Claude Code, Codex, Cursor, ChatGPT, Grok, Hermes, OpenClaw | Replaced Rube |
| **Rube** | Consumer "universal MCP" app with a marketplace, community "Recipes" (schedulable automations) and Rube Chat; Pro was $25/mo | **Discontinued 2026-05-16** ("Rube was discontinued on May 16, 2026. All payments have been refunded.") [live: https://www.rube.app]; signups stopped 04-09, chat ended 04-20 |
| **MCP Gateway** (Enterprise) | Org/team/user policies, action-level rules, access requests and approvals, SSO (SAML/OIDC) + SCIM, audit with 7 days–1 year retention, Cloud / your VPC / self-hosted | Sold via demo |
| **Instant Tools** ("Composio Instant", 2026-10-08) | 100+ paid tools on Composio-owned provider accounts, paid from a prepaid balance at 0% markup | New |
| **Skills** | Usage-derived playbooks returned inside tool search; plus the `awesome-claude-skills` repo (76,948 stars) | Ongoing |
| **Agent Orchestrator** | Open-sourced 2026-02-25; now lives at `OrchestratorInc/agent-orchestrator` (Apache-2.0, 13,109 stars) | Possibly spun out [inference] |
| **Composio Bench**, "Agents @ Work" stats | Model evaluation on knowledge work; public usage stats | Marketing/research |

**No "apps", workflow builder or internal-tools product exists.** Recipes died with Rube; there is no scheduler. [live/docs]

### 1.5 2026 timeline (the parts that matter for Every App)

| Date | Event | Source |
|---|---|---|
| 2025-12-15 | Tool Router GA | changelog |
| 2026-01-29 | SDK 0.6.0: Cloudflare Workers support | changelog |
| 2026-02-09→16 | X suspended Composio's shared app (173 h incident); 2026-02-12 managed Twitter credentials removed | status page, changelog |
| 2026-03-11/13 | Polling floor 1 → 15 min on managed auth | changelog |
| 2026-03-23 | Custom tools and toolkits (experimental) | changelog |
| 2026-03-25 | Legacy `mcp.composio.dev` endpoint removed | changelog |
| 2026-04-08/09 | API v3.1 (latest tool versions by default); multi-account + aliases | changelog |
| 2026-04-17 | Logs and usage metering APIs | changelog |
| 2026-04-22/24 | Token redaction for managed apps; `/link` required for managed OAuth; proxy same-domain rule | changelog |
| 2026-04-28→30 | ~53 min API degradation; **~36 h webhook-trigger outage, ~700 customers, events "not queued by the platform and… not recoverable"** | [live: https://composio.dev/blog/incident-report-april-28] |
| 2026-05-16 | Rube shut down | rube.app |
| **2026-05-21** | **Security incident disclosed** (see 8.1) | blog |
| 2026-06-04 | IP allowlists, scoped keys, token redaction for all apps, v1/v2 APIs return 410 | changelog |
| 2026-06-26/27 | Sessions first-class in both SDKs | changelog |
| 2026-07-30 | Callback identity verification (OAuth session fixation fix) | changelog |
| 2026-08-15 | New pricing | /pricing |
| 2026-08-28 | Scoped keys split session management vs execution | changelog |
| 2026-09-14 | Shared connections launch post | blog |
| 2026-09-24/29 | Saved session configs; Instant sessions; ZDR becomes a paid add-on | changelog |
| 2026-10-08 | Composio Instant | blog |
| 2026-10-12 | SDKs surface approval "input requests" from experimental `require_approval` session settings; they can't answer them yet; session executions no longer retried | changelog |

---

## 2. Data model and auth

### 2.1 The objects

| Object | What it is | ID | Scope |
|---|---|---|---|
| Organization | Top-level account; members and projects. Admins vs members (and viewers in For You). | `org_…` | — |
| Project | Isolation boundary. Owns API keys, auth configs, connected accounts, sessions, triggers, one webhook subscription, white-label branding. "Data from one project is not visible to another." | `proj_…` | org |
| Project API key | Server secret. Can be **scoped** (Session management vs Session tool execution vs Proxy execute vs Tools read…), with **per-key IP allowlist**. | `ak_…` | project |
| Toolkit | One app/service (`gmail`, `github`). Has auth schemes, tools, triggers, a **date-based version** (`20261010_00`). | slug | global catalog |
| Tool | One action, `{TOOLKIT}_{ACTION}` (e.g. `GMAIL_SEND_EMAIL`), with input and output JSON Schema and behavior tags. | slug | global catalog |
| Auth config | "A blueprint for how a toolkit authenticates": scheme, scopes, and either Composio's managed OAuth app or your own client ID/secret. | `ac_…` | project |
| User | Just a string `user_id` you choose. "Composio stores connections under that ID." | your ID | project |
| Connected account | One user's grant for one toolkit (tokens or key), created through one auth config. PRIVATE (default) or SHARED with an ACL. Can carry an alias. | `ca_…` | project + user |
| Session (ex "Tool Router") | Runtime context for one user's agent run: tool policy, auth-config and account pins, MCP endpoint, sandbox. Persists, never expires. | `trs_…` | project + user |
| Trigger instance | One event subscription on one connected account. | `ti_…` | project + user |
| Webhook subscription | The one outbound URL per project that receives all trigger and lifecycle events. | — | project |

Sources: [docs] https://docs.composio.dev/reference/glossary, https://docs.composio.dev/docs/how-composio-works, https://docs.composio.dev/docs/authentication, https://docs.composio.dev/docs/migration-guide/new-sdk (nano-ID prefixes).

**Renames to know** (old terms still appear in errors, blogs and Reddit threads) [docs: llms-full.txt "Terminology Migration"]: entity ID → `user_id`; actions → tools; apps → toolkits; integration → auth config; connection → connected account; ToolSet → provider; Tool Router → sessions; workbench → sandbox; Premium Tools → Instant Tools.

### 2.2 Auth configs: Composio-managed OAuth app vs bring-your-own client

- **Two types** [docs: https://docs.composio.dev/docs/authentication/programmatic-auth-configs]:
  - `use_composio_managed_auth`: Composio owns the OAuth app, client secret and redirect URI. Zero setup.
  - `use_custom_auth`: you supply `client_id`, `client_secret`, optional `scopes`, and register Composio's callback `https://backend.composio.dev/api/v3/toolkits/auth/callback` (some toolkits still use the legacy `…/api/v1/auth-apps/add`).
- **Auth schemes** [code: `ts/packages/core/src/types/authConfigs.types.ts:9-25` @8b07933]: `OAUTH1`, `OAUTH2`, `S2S_OAUTH2`, `DCR_OAUTH`, `CIMD_OAUTH`, `API_KEY`, `BEARER_TOKEN`, `BASIC`, `BASIC_WITH_JWT`, `SERVICE_ACCOUNT` (GitHub-App-style `application_id`/`installation_id`/`private_key`), `GOOGLE_SERVICE_ACCOUNT`, `SAML`, `BILLCOM_AUTH`, `CALCOM_AUTH`, `NO_AUTH`. In the public catalog, 1,293 of 1,603 toolkits support `API_KEY` and only 220 support `OAUTH2` (section 6.4).
- **Precedence when a session needs an account** [docs: https://docs.composio.dev/docs/configuring-sessions#precedence]: (1) pinned `connectedAccounts`, (2) pinned `authConfigs` (find or create a connection on it), (3) an auth config already created for the toolkit, (4) a new auth config using managed auth, (5) error if the toolkit has no managed scheme. With several accounts, "the most recently connected one" wins.
- **Why you'd bring your own client** — Composio's own list [docs: https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app]:
  - Consent screen: "Users will see 'Composio wants to access your account' during OAuth. Fine for internal tools, prototypes, and development."
  - Custom scopes.
  - Rate limits: "Managed apps share quota across all Composio users. Your own app gets a dedicated quota."
  - Polling triggers: "Managed auth enforces a 15-minute minimum polling interval."
  - Custom instances (private Salesforce subdomain, regional hosts).
- **Owning the client does not move the tokens.** "In Composio Cloud, Composio still stores and uses the resulting connected-account tokens. Owning the OAuth app does not move the token store into your infrastructure." [docs: https://docs.composio.dev/docs/security/token-custody]
- **Switching managed → custom does not migrate users.** Existing connected accounts stay tied to the auth config that created them; users must re-authenticate (or you import credentials where supported). [docs: white-labeling page, "Switching from Composio-managed to your own OAuth app"]
- **Managed apps are not guaranteed to stay available.** Composio withdrew managed credentials for 12 apps on 2025-12-09 (Auth0, Blackbaud, BoldSign, Deel, Front, GoToWebinar, PagerDuty, Pipedrive, Shopify, Strava, SurveyMonkey, Webex) and for Twitter on 2026-02-12 ("your Twitter integrations will no longer work until you configure your own credentials"). [live: https://docs.composio.dev/docs/changelog/2025/12/09, https://docs.composio.dev/docs/changelog/2026/02/12]
- **Shared blast radius of managed apps** — Composio's own words when it started redacting managed tokens: "A single OAuth application backs every team on a Composio-managed default integration… If a provider throttles, restricts, or suspends that app in response to misuse of one of its credentials, the integration becomes unavailable for every team on the default at once." [live: https://docs.composio.dev/docs/changelog/2026/04/22]
- **Scopes** [docs: https://docs.composio.dev/docs/authentication/controlling-scopes]: sensible defaults per toolkit; override with a comma-separated `scopes` string on the auth config (managed or custom). Experimental `toolkits.recommendScopes(toolkit, {tools})` returns least-privilege scope sets per tool; `POST /tools/scopes/required` gives the scopes one tool needs. Scope changes apply to new connections only.
- **Google** [docs: https://docs.composio.dev/kb/guide/platform-google-oauth, https://docs.composio.dev/toolkits/gmail]: adding sensitive/restricted scopes beyond what the managed app already has produces Google's "App is blocked" screen; the fix is "create a customer-owned Google OAuth app and complete Google's required verification". The Gmail FAQ also notes Google's ~50-refresh-tokens-per-account limit and the shared quota on the managed app.
  - [inference] So Google verification is Composio's burden only for the scopes its managed app already holds; anything more is the customer's, including Google's rule that "Apps requesting restricted scopes data need to complete 're-verification' annually" [live: https://support.google.com/cloud/answer/13463073].
- **Default scopes are broad, not least-privilege** [code: `docs/public/data/toolkits.json` @8b07933, `authConfigDetails[].fields.auth_config_creation.optional[name=scopes].default`]:

| Toolkit | Default scope string |
|---|---|
| Gmail | `https://mail.google.com/` (full mailbox — a Google *restricted* scope) plus ~10 People API read scopes |
| Google Drive | `https://www.googleapis.com/auth/drive` (full Drive — restricted) |
| GitHub | `repo,user,gist,notifications,project,workflow,codespace` |
| Slack | ~50 user scopes, including `search:read.private`, `im:history`, `users:write`, `chat:write` |
| Outlook | `Mail.ReadWrite, Mail.Send, Calendars.ReadWrite(.Shared), Contacts.ReadWrite, Chat.ReadWrite, …, offline_access` |

  [inference] One broad grant per toolkit is what lets 60k tools "just work", but it is the opposite of least privilege. If the managed Google apps use these defaults, Composio has passed Google's restricted-scope review for them; I could not confirm which scopes the managed apps actually request.
- **Microsoft** [docs: https://docs.composio.dev/kb/guide/platform-microsoft-oauth]: tenant admin consent may be required for the managed app or yours; `offline_access` must be requested for refresh tokens.
- **White-labeling has four layers** [docs: https://docs.composio.dev/docs/authentication/white-labeling-authentication]:

| Where Composio's brand shows | Fix |
|---|---|
| Hosted Connect Link page | Upload logo/title and theme per project (one brand per project; per-customer branding needs one project per customer) |
| Provider consent screen ("Composio wants to access your account") and "Secured by Composio" badge | Your own OAuth app |
| `backend.composio.dev` in the address bar during the redirect | A 302 proxy on your domain that forwards the callback to Composio |
| Composio-hosted success page | Pass `callbackUrl` |

### 2.3 Connected accounts and the connection flow

- **Connect Link** (launched 2025-09-15) [live: https://docs.composio.dev/docs/changelog/2025/09/15]: `connectedAccounts.link(userId, authConfigId)` or `session.authorize(toolkit)` returns `https://connect.composio.dev/link/ln_…`. The hosted page handles OAuth, API-key forms and extra fields (subdomains, regions). After success it redirects to your `callbackUrl` with `status` and `connected_account_id`. `waitForConnection()` polls (default 60 s).
  - Links expire after **10 minutes**; abandoned `INITIALIZING`/`INITIATED` accounts auto-expire (since 2025-12-03).
  - Since 2026-05-08 (new orgs) / 2026-07-03 (all), managed OAuth connections **must** go through `/link` so the end user sees Composio's consent step; the older direct-create endpoint returns 400 for that case. [live: https://docs.composio.dev/docs/changelog/2026/04/24]
- **Status lifecycle** [docs: https://docs.composio.dev/kb/guide/platform-connected-accounts; code: `types/connectedAccounts.types.ts:8-16`]: `INITIALIZING` → `INITIATED` → `ACTIVE` → `EXPIRED` (read `statusReason`) / `FAILED` / `INACTIVE` (disabled) / `REVOKED` (revoked at the provider). "Connection status describes a lifecycle, not credential validity."
- **Token refresh**: automatic for OAuth on Composio-created connections. Refresh failures (revoked grant, admin policy, rotating-token chain broken, changed client secret) end in `EXPIRED`; the fix is a new Connect Link. The old `/refresh` endpoint is deprecated. Composio emits a connection-expiry event to your webhook (since 2026-02-06). [docs + changelog index]
- **Callback identity verification** (opt-in, 2026-07-30) [docs: https://docs.composio.dev/reference/api-reference/connected-accounts#callback-identity-verification]: Composio names the attack: "someone starts a connection under their own user, copies the authorization URL before consenting, and gets a different person to finish it… This is OAuth session fixation." With a verifier URL set, Composio redirects the returning browser to your server with a single-use `session_uri`; your server posts it plus the signed-in `user_id` to `complete_auth`; mismatch → `FAILED`.
- **Identity of the connected account**: Composio auto-fills `state.val.displayName` (e.g. the Gmail address). It warns that an alias or `user_id` "doesn't prove which account connected"; for policy (e.g. "only @acme.com mailboxes") call the provider's current-user endpoint through Proxy Execute and disable non-matching connections. [docs: manually-authenticating page; example https://docs.composio.dev/examples/restrict-gmail-domain]
- **Multiple accounts per user per toolkit** (2026-04-09) [docs: https://docs.composio.dev/docs/authentication/managing-multiple-connected-accounts]: off by default (one account per toolkit per session; most recent wins). `multiAccount: { enable, maxAccountsPerToolkit (2–10, default 5), requireExplicitSelection }`. Aliases (`work-gmail`) are unique per user+toolkit; the agent passes `account` (ID or alias) on execute. Direct API needs `allowMultiple: true` to create a second active connection on the same auth config.
- **API key / bearer / basic** [docs: https://docs.composio.dev/docs/authentication/importing-existing-connections]: `connectedAccounts.initiate(userId, authConfigId, { config: AuthScheme.APIKey({...}) })` is immediately `ACTIVE`. Importing an OAuth **bearer token** works for any OAuth2/S2S toolkit, but "Composio won't handle OAuth refresh" — you PATCH new tokens in. Field names are toolkit-specific (`generic_api_key`, `bearer_token`, …).
- **Revoke**: `POST /connected_accounts/{id}/revoke` revokes the grant at the provider where supported (2026-05-12).
- **Shared vs per-user connections** [docs: https://docs.composio.dev/docs/extending-sessions/shared-connections, https://docs.composio.dev/docs/b2b-agents]:
  - Default `PRIVATE`: only the owning `user_id`.
  - `SHARED` (experimental, 2026-05): ACL `{ allowAllUsers, allowedUserIds, notAllowedUserIds }`, deny wins, deny-by-default. **Never resolved implicitly** — a session must pin it by `ca_` ID; at most one SHARED connection per toolkit per session. Errors are raised at session creation, not mid-run.
  - B2B guidance: choose per connection whether it is **member-owned** (`user_id = "org_42:user_7"`) or **workspace-owned** (`user_id = "org_42:integration"`); "Do not reuse a real member's identity, because the connection should survive membership changes." Your app, not Composio, decides which members may drive a workspace-owned connection.
  - Worked example (Slack bot): the Slack connection is SHARED (bot posts as the workspace), while each user's GitHub is PRIVATE, so "Alice's session has *her* GitHub connection but *the workspace's* Slack connection." [docs: https://docs.composio.dev/examples/general-agent-with-pi]
- **Instant Tools** (renamed from Premium Tools, 2026-09) [docs: https://docs.composio.dev/docs/instant-tools]: some tools (Firecrawl, Exa…) can run on **Composio's own provider accounts**, charged to a prepaid balance. Resolution order: user's own connection → shared connection → Instant account. Excludes tools exposing account history; no arbitrary proxy. Balance exhaustion → HTTP 402, checked asynchronously ("not a strict spending cap"). This is the same idea as Every App's hoisted OpenAI key.
- **Two worlds inside one org** [docs: https://docs.composio.dev/kb/guide/consumer-project-boundaries-and-auth-selection]: "Platform" developer projects (your app's users) and one hidden **consumer project** behind "Composio For You"/Connect (your staff's own connections, used from Claude/ChatGPT/Cursor). Auth configs and connections do not cross between them. In For You, "connected accounts belong to the member who authorized them"; teammates do not share them by default; viewers cannot invoke tools.

### 2.4 Credential storage, custody, retention, deployment

- **Encryption**: "Connected-account credentials, auth configs, and API keys are encrypted at rest using AES-256-GCM", TLS in transit. [docs: https://docs.composio.dev/docs/security/overview] After the May 2026 breach (section 8.1) Composio "replaced single-key encryption with envelope encryption and an independently rotated key-encryption key", and API keys and session keys are now "stored only as hashes" [live: https://composio.dev/blog/composio-may-2026-security-incident, updated 2026-09-16]. Detail: "A key-encryption key wraps a per-project key, and the key-encryption key lives in AWS KMS and rotates on its own schedule… During execution, the credential is decrypted for that call… The execution runtime exists only for the call and retains no credential afterward." [live: https://composio.dev/blog/two-questions-every-security-review-asks-us, 2026-09-09]
- **Tokens are not exportable.** Since April–June 2026, connected-account API responses redact tokens for managed **and** custom auth configs: "Reading connected-account state is not a supported token-export workflow"; "If you need this for some special case please reach out to support." To act on an account you go through tool execution or **Proxy Execute** (Composio injects the credential). [docs: token-custody page; live: https://docs.composio.dev/docs/changelog/2026/04/22, https://docs.composio.dev/docs/changelog/2026/06/04] → [inference] leaving Composio means re-consenting every user unless support exports tokens.
- **Proxy Execute guardrails** [docs: https://docs.composio.dev/docs/extending-sessions/proxy-execute]: endpoint must resolve to the same scheme and registrable domain (eTLD+1) as the account's base URL; requires an opt-in API-key capability; never auto-retried; 250 MB payload cap; binary responses come back as a presigned URL.
- **Payload retention** [docs: https://docs.composio.dev/docs/security/data-retention]: tool execution and trigger logs, **including request arguments and response data by default**, are kept **up to one year**. Staged files: presigned URL 1 h by default (configurable to 24 h), objects deleted after 24 h. Sandbox `/mnt/files` deleted after 24 h; other sandbox state cleared after ~12 h idle.
- **The enterprise MCP Gateway product says the opposite by default**: "Minimal data retention. Tool-call payloads are never stored. Audit records hold metadata only, with a retention window you configure. 7 days to 1 year." [live: https://composio.dev/mcp-gateway, raw HTML grep] [inference] Consistent with Enterprise projects starting with ZDR on; the developer platform default is still "store payloads, up to a year".
- **Zero Data Retention** (renamed from "Don't store data", 2026-09-29) [docs: https://docs.composio.dev/docs/security/zero-data-retention]: paid add-on (usage-priced), included on Enterprise. Not covered even with ZDR on: **managed OAuth apps (except Enterprise)**, Instant tools' upstream providers, trigger payload processing, the sandbox (on by default), staged files, cached search queries. Audit metadata and telemetry are always stored.
- **Compliance** [docs]: SOC 2 Type II (Trust Center https://trust.composio.dev); "Composio is not FedRAMP authorized"; standard plans "do not guarantee end-to-end zero data retention or zero training" — contractual terms need the Enterprise track. The enterprise MCP Gateway page also claims "SOC 2 Type II and ISO 27001 certified" [live: https://composio.dev/mcp-gateway].
- **Deployment options** [docs: token-custody page]:

| Option | Credential boundary | Availability |
|---|---|---|
| Composio Cloud | Composio stores credentials and executes calls | Default |
| Private VPC | Inside a private network; key ownership "must be specified in the deployment design" | Enterprise |
| Self-hosted | "Runs Composio in your environment" | Enterprise, Helm chart (KB mentions an "Apollo" service, S3/IRSA, ArgoCD) [docs: https://docs.composio.dev/kb/guide/platform-self-hosted-helm] |
| Customer-managed keys | "A proxy in your cloud handles credential plaintext under keys in your KMS" (AWS KMS, GCP KMS, Vault Transit); Composio keeps the control plane | Set up with the Composio team |

- **Data residency**: "Composio Cloud runs in the United States. For EU residency, use a self-hosted deployment in an EU region." [live: https://composio.dev/blog/two-questions-every-security-review-asks-us] The docs offer no region choice (only per-toolkit regional API hosts such as PostHog EU or Zoho regions).

---

## 3. Agent interface

### 3.1 SDKs and provider adapters

- Python `composio`, TypeScript `@composio/core` (ESM-only, Node ≥ 22.22.3; `@composio/slim` is a smaller build). Cloudflare Workers support since SDK 0.6.0 (2026-01-29: Web Crypto instead of `node:crypto`; file auto-upload/download initially off on Workers). There is an official Workers example. [live: https://docs.composio.dev/docs/changelog/2026/01/29, https://docs.composio.dev/examples/cloudflare-workers]
- Provider packages "follow the framework, not the model vendor" [docs]: OpenAI (Chat Completions and Responses), OpenAI Agents, Anthropic, Claude Agent SDK, Vercel AI SDK, Google (Gemini, ADK), LangChain/LangGraph, LlamaIndex, CrewAI, AutoGen, Mastra, Pi, Eve, TypeSafe, and a Cloudflare helper; plus a custom-provider interface. (Full package list from code: section 6.)
- Two ways to give tools to an agent: **native tools** via a provider (`session.tools()`, executes through `session.execute()`), or **MCP** (`session.mcp.url` + `session.mcp.headers`). Only native tools support SDK modifiers and in-process custom tools.

### 3.2 Sessions (the product formerly called Tool Router)

History [live: changelog]: experimental Tool Router 2025-09-26 → beta blog 2025-10-01 ("the official way to build on top of Rube"; "a `toolRouter` with 10k+ tools") [live: https://composio.dev/blog/introducing-tool-router-(beta)] → GA 2025-12-15 → renamed "sessions" and made first-class June 2026 (SDK 0.13/0.17) → session configs, Instant, approvals Sept–Oct 2026.

What a session pins (create body, `POST /api/v3.1/tool_router/session`) [docs: https://docs.composio.dev/reference/api-reference/tool-router/postToolRouterSession, https://docs.composio.dev/docs/configuring-sessions]:

| Setting | What it does |
|---|---|
| `user_id` | Whose connections and logs |
| `toolkits` | `{enable:[…]}` allowlist or `{disable:[…]}` denylist. `{enable: []}` = no app toolkits; omitted = whole catalog. Enforced before connection lookup. |
| `tools` | Per-toolkit `enable`/`disable` lists or per-toolkit tag rules. Typo'd slugs fail creation. |
| `tags` | Behavior filters: every tool has at least one of `readOnlyHint`, `createHint`, `updateHint`, `destructiveHint` (MCP's `idempotentHint`/`openWorldHint` also accepted). For MCP-backed toolkits, Composio classifies tools into these at sync time. |
| `auth_configs` / `connected_accounts` | Pin which OAuth app / which account per toolkit (exact pin, no fallback). Unpinned = live lookup, including accounts connected after the session was created. |
| `manage_connections` | In-chat auth on/off, `callback_url`, `enable_wait_for_connections`, `enable_connection_removal` |
| `multi_account` | See 2.3 |
| `workbench` / `sandbox` | On by default. `enable_tool_execution`, `enable_proxy_execution`, `auto_offload_threshold` (default 20k characters), `sandbox_size` (1–8 vCPU) |
| `proxy_execute` | Raw authenticated HTTP from the agent (off unless enabled) |
| `preload.tools` | Put known tools straight into the tool list ("generally fewer than 20"); `"all"` capped at 1,000 and needs a positive allowlist |
| `session_preset: DIRECT_TOOLS` | No meta tools; a classic fixed-tool MCP server |
| `instant` | Allow/deny paid Instant tools |
| `experimental.permissions` | Per-tool approval prompts via MCP elicitation (see 5.1) |
| `experimental.link_url_overwrite` | Serve Connect Links from your own host |
| `experimental.fast_mode` | Faster, lower-quality search |
| `experimental.submit_feedback` | Adds `COMPOSIO_SUBMIT_FEEDBACK` so the agent can report empty/wrong/failed tool results |
| `experimental.session_config_id` | Apply a saved, named policy (`sc_…`) built in the dashboard |

Sessions persist and never expire; reuse with `composio.use(id)`. `session.update()` patches in place (maps replace, not merge; `null` clears a block and can **widen** access), keeps a **config history**, and supports optimistic concurrency with `expectedConfigVersion` (409 on conflict). [docs: configuring-sessions page]

### 3.3 The meta tools (exact slugs, verified)

Session meta tools [docs: https://docs.composio.dev/toolkits/meta-tools and the six per-tool pages, fetched 2026-10-12]. The docs warn: "We do not guarantee backward compatibility for parameter names or response shapes."

| Slug | Tags | Key inputs | Key outputs |
|---|---|---|---|
| `COMPOSIO_SEARCH_TOOLS` | `important`, `openWorldHint`, `readOnlyHint` | `queries[]` of `{use_case, known_fields}` ("Split independent app/API actions into separate queries, including hidden prerequisites. Each query returns 4-6 tools"; keep personal identifiers out of `use_case`); `session {id \| generate_id}`; `model`; `search_strategy: auto \| tool_search` (bypass cached plans) | per query: `primary_tool_slugs`, `related_tool_slugs`, `reasoning`, `task_difficulty`, optional `recommended_plan_steps`, `known_pitfalls`, `reference_workbench_snippets`; plus de-duplicated `tool_schemas`, `toolkit_connection_statuses` (with `has_active_connection`, `current_user_info`, `account_type` PRIVATE/SHARED), `time_info` (UTC now), `session.instructions`, `next_steps_guidance` |
| `COMPOSIO_GET_TOOL_SCHEMAS` | `readOnlyHint` | `tool_slugs[]` ("never invent"), `include: input_schema \| output_schema` | `tool_schemas`, `not_found`, `suggestions` (up to 3 similar slugs each) |
| `COMPOSIO_MANAGE_CONNECTIONS` | `openWorldHint`, `destructiveHint` | `toolkits[]`, `reinitiate_all` | per-toolkit result incl. Connect Link, counts of active/initiated/failed |
| `COMPOSIO_MULTI_EXECUTE_TOOL` | `openWorldHint`, `destructiveHint`, `important` | `tools[]` of `{tool_slug, arguments}` (up to 50, "logically independent", run in parallel), `thought`, **`sync_response_to_workbench` (required)**, `current_step`, `current_step_metric` ("10/100 emails") | ordered `results[]` with per-item `error`, counts, `remote_file_info` when the full response was saved to a file, `next_steps` |
| `COMPOSIO_REMOTE_WORKBENCH` | `destructiveHint`, `openWorldHint` | `code_to_execute` (Python, persistent Jupyter, hard 180 s limit), `thought`, step fields | `stdout`/`stderr`/`results` with `*_file_path` when truncated |
| `COMPOSIO_REMOTE_BASH_TOOL` | `destructiveHint`, `openWorldHint` | `command` (180 s) | `stdout`/`stderr` with line counts and file paths when truncated |

Extras seen elsewhere: **`COMPOSIO_WAIT_FOR_CONNECTIONS`** (Composio Connect has 7 meta tools; in sessions it is opt-in via `enable_wait_for_connections`, "May not work reliably with GPT models") and **`COMPOSIO_SUBMIT_FEEDBACK`** (opt-in). [docs: https://docs.composio.dev/docs/composio-connect, create-session reference]. Meta tools only run inside a session; called through the old direct path they fail with "can only be called inside a tool-router session".

### 3.4 MCP surfaces

| Surface | URL / auth | Who it's for |
|---|---|---|
| Session MCP (current) | `session.mcp.url` + `session.mcp.headers` (`x-api-key` = **project API key**, or `x-user-api-key` = an org-wide user key) | Developers exposing one user's session to an MCP client. "Treat the exported config as a secret." |
| Composio Connect ("For You") | `https://connect.composio.dev/mcp`, OAuth in the client (Claude, ChatGPT, Cursor, Notion agents, Grok, n8n, VS Code…) or `x-consumer-api-key: ck_…` | Individuals and staff using their own connections; 7 meta tools. Optional "Enhanced Control" approvals via MCP elicitation. |
| Legacy per-toolkit MCP servers | `composio.mcp.create()` + `mcp.generate(userId)` → `mcp.composio.dev/...`; the old `mcp.composio.dev` endpoint was removed 2026-03-25 | Replaced by sessions (migration guide written June 2026) |

**MCP URL security history** (a lesson in itself) [live: changelog 2025-11-05, 2025-11-13, 2026-01-08, 2026-03-04, 2026-06-04]: early per-user MCP URLs worked as bearer capabilities — "Tool Router returns a pre-signed MCP URL" (Oct 2025 blog). Composio then (1) required `user_id`/`connected_account_id` in MCP URLs for new projects (Nov 2025; old URLs until 2026-01-15), (2) required an `x-api-key` header for new projects (Dec 2025; old projects until 2026-04-15), (3) made `require_mcp_api_key` default-on only for orgs created after 2026-03-05 ("Nothing changes for existing organizations"), and (4) by June 2026 required a key or bearer token on legacy MCP config routes.

### 3.5 In-chat authentication

- Default sessions include `COMPOSIO_MANAGE_CONNECTIONS`. When a tool needs an account, the agent gets "a branded authentication link" and shows it; "Credentials never pass through your app or the model, so it's safe to surface the link right in the chat." Connections then persist across sessions. [docs: https://docs.composio.dev/docs/authentication]
- You can intercept the link instead of letting the model print it: the Slack-bot example extracts the one-time URL from the tool result, **redacts it from the tool output**, DMs it privately, and resumes when the user approves. [docs: general-agent-with-pi example]
- `manageConnections: false` turns in-chat auth off for apps with their own integrations page; `session.authorize()` / `ensureConnected()` do it from code. [docs: manually-authenticating]

### 3.6 Fighting context bloat and improving tool-call accuracy

- **Meta tools instead of N tools** (above). Preload only a handful of known tools; `DIRECT_TOOLS` for narrow agents.
- **Search = lexical + LLM planning + cached plans.** Custom-tool descriptions are "Used for BM25 search matching" [docs: create-session reference]; search responses include LLM-style `reasoning`, `task_difficulty`, and "cached plan" fields, with `search_strategy: tool_search` to "bypass cached plans and run direct tool search". `fast_mode` trades quality for latency. [inference: hybrid BM25 + LLM planner; exact algorithm not documented]
- **Skills** [docs: https://docs.composio.dev/docs/skills]: "execution playbooks" (tools, order, pitfalls) that ride inside search results. "Composio derives skills from real usage across the platform rather than writing them by hand." No API to list them; no opt-out. [inference: this depends on cross-customer telemetry, which a self-hosted product cannot replicate except per org]
- **Agent-written tool descriptions.** Sample, `GMAIL_SEND_DRAFT`: "IMPORTANT: This action does NOT accept recipient parameters… Send is immediate and irreversible — confirm recipients and content before calling… Gmail enforces ~25 MB message size limit and daily send caps." `GMAIL_BATCH_DELETE_MESSAGES`: "Use GMAIL_MOVE_TO_TRASH instead when reversibility may be needed. Always obtain explicit user confirmation…". Descriptions carry pitfalls, alternatives, rate-limit advice and confirmation rules. Gmail = 63 tools, 2 triggers, version `20261010_00`. [docs: https://docs.composio.dev/toolkits/gmail]
- **Schema hygiene work in 2026** [live: changelog index]: shortened enum names (Jan), simplified optional-field schemas (Jan 30), typed responses for 75+ toolkits (Feb), tool consolidation (Mar 28), ~230 deprecated tools flagged across 70+ apps and 26 toolkits deprecated (Feb 23), linear-time regex for schema patterns and strict-mode fixes (Oct 12).
- **Published evals**: only an April 2024 blog on a 50-problem ClickUp function-calling benchmark (gpt-4-turbo; baseline stated as both 30% and 36%; ~78% after flattening params, system prompts and rewritten descriptions/names; adding few-shot call examples hurt) and its MIT repo (92 stars, last push 2024-07). I found **no published accuracy numbers for Tool Router/sessions**. [live: https://composio.dev/blog/gpt-4-function-calling-example, `gh api repos/ComposioHQ/Composio-Function-Calling-Benchmark`]

### 3.7 Large responses and files

- **Auto-offload**: responses above `auto_offload_threshold` (documented default 20k characters) are written to the session sandbox; `MULTI_EXECUTE` returns an inline preview plus `remote_file_info`. The agent can also set `sync_response_to_workbench` "predictively". [docs: create-session reference, meta-tool pages]
- **Remote sandbox** [docs: https://docs.composio.dev/docs/sandbox/remote]: persistent Jupyter per session with helpers `run_composio_tool`, `invoke_llm`, `upload_local_file`, `proxy_execute`, `web_search`, `smart_file_extract`; pandas/numpy/PyTorch preinstalled; auto-installs packages; "error correction" (fixes `result["apiKey"]` vs `api_key`; on Python syntax errors may send code to an LLM to repair). Tiers `standard` (1 vCPU/1 GB) to `xlarge` (8/8). "Sandboxes are not billed today… plans to begin billing… soon." Not covered by ZDR.
- **Local sandbox** (experimental): Composio hands you a Python helper module and env vars so code runs in your container, but the helper carries your project API key ("The sandbox is your security boundary"). [docs: https://docs.composio.dev/docs/sandbox/local]
- **Files**: tool inputs/outputs that are files go through Composio-staged S3 objects and presigned URLs; SDK auto upload/download (now with path allowlists and SSRF-safe URL fetching); `RemoteFile` downloads stop at 100 MiB. [docs + changelog 2026-04-24, 2026-07-30]

### 3.8 Using Composio *under* your own harness

Composio documents exactly the shape Every App would need if it used Composio as a backend [docs: https://docs.composio.dev/examples/harness-integration]: "Composio sits underneath your harness in four calls": list toolkits (`composio.toolkits.get()`), connect what the user picks (`session.authorize(slug)`), fetch raw schemas (`tools.getRawComposioTools`), execute by slug (`session.execute`). Create the session with `manageConnections: false` and the sandbox off; "Your planner, context window, approval gate, and traces stay the same." The trade-off they name: you give up search-time plans and skills.

---

## 4. Triggers, custom tools, versioning, modifiers

### 4.1 Triggers

- **Model** [docs: https://docs.composio.dev/docs/triggers]: a trigger **type** (e.g. `GITHUB_COMMIT_EVENT`, with a config schema and payload schema) is activated as a trigger **instance** (`ti_…`) on one connected account. Instances can be listed, disabled, enabled, deleted.
- **Realtime vs polling** is a property of the type: realtime (Slack, Asana, Notion, Outlook) = provider pushes to Composio; polling (Gmail, Google Calendar) = Composio checks "up to ~15 min on Composio-managed auth".
- **Polling floor change** [live: https://docs.composio.dev/docs/changelog/2026/03/11, /03/13]: default polling went from 1 min to 15 min with a 15-min minimum on managed auth (silent clamping from 2026-03-11, errors from 2026-04-15, existing customers kept 1-min until 2026-05-01). Reason: "Composio-managed OAuth apps share rate limits across all users. At scale, 1-minute polling causes rate limiting and service degradation." Custom OAuth apps can poll every 1 min. (The Gmail toolkit FAQ still says "poll roughly every minute" — a docs inconsistency.)
- **Delivery** [docs: https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events]: one webhook subscription per project; every event and lifecycle event (connection expiry, `composio.trigger.disabled`) goes there. Webhook URL must be public (no IP allowlisting: "Composio's outbound IPs are dynamic"). `subscribe()` over a Pusher WebSocket exists for local prototyping only.
- **Signing**: headers `webhook-id`, `webhook-timestamp`, `webhook-signature`; HMAC-SHA256 over `{id}.{timestamp}.{rawBody}`, base64, 300 s tolerance. [inference: this is the Standard Webhooks scheme]. Delivery is **at-least-once**; dedupe on `log_id`. [docs: KB triggers]
- **Payload envelope V3** (default for new orgs since 2026-02-15): `{id, type: "composio.trigger.message", metadata: {log_id, trigger_slug, trigger_id, connected_account_id, auth_config_id, user_id}, data, timestamp}`. V1/V2 still supported.
- **Bring-your-own OAuth app + realtime triggers** [docs: https://docs.composio.dev/docs/setting-up-triggers/custom-oauth-webhooks]: you register Composio's per-OAuth-app ingress URL (`/api/v3.1/webhook_ingress/{toolkit}/{we_…}/trigger_event`) in the provider's app and store the provider's signing secret in Composio. "A single OAuth app can serve at most one Composio project." Ingress verifies HMAC (Slack) / Ed25519 / shared tokens and handles verification challenges.
- **Scheduling**: there is no scheduler/cron product; examples use Vercel Cron or the host agent's timers, and tool descriptions say "No scheduling support; trigger at the desired UTC time externally." [docs grep]

### 4.2 Custom tools, custom toolkits, custom MCP, proxy

- **In-process custom tools** (experimental, 2026-03; session-scoped since June) [docs: https://docs.composio.dev/docs/extending-sessions/custom-tools-and-toolkits]: `experimental_createTool(slug, {inputParams: zod, execute(input, ctx)})`; exposed as `LOCAL_<SLUG>`; searchable alongside remote tools; `MULTI_EXECUTE` runs them in your process. `extendsToolkit: "gmail"` lets the tool use `ctx.proxyExecute()` with the user's Gmail connection without seeing tokens. They do **not** work over MCP or inside the remote sandbox.
- **Custom MCP toolkits** (experimental) [docs: https://docs.composio.dev/docs/extending-sessions/custom-mcp]: register any public HTTPS MCP server (no auth, API key header template, or DCR OAuth) as a project-scoped `CUSTOM_*` toolkit; Composio syncs tools (≤ 500), versions the sync (`20260728_00`), and classifies tools into the four behavior tags. `app_url` and auth scheme are immutable.
- **Proxy Execute**: see 2.4.

### 4.3 Toolkit and tool versioning

- Versions are date-based per toolkit (`YYYYMMDD_NN`; `00000000_00` = the frozen pin). [docs: notes for AI code generators]
- Direct execution has required an explicit version since Python 0.9.0 / TS 0.2.0 (Oct 2025): `toolkitVersions` map at init, per-call `version`, or `COMPOSIO_TOOLKIT_VERSION_<TOOLKIT>` env vars; `dangerouslySkipVersionCheck` exists "only for migration or debugging". [docs: https://docs.composio.dev/docs/migration-guide/toolkit-versioning]
- REST v3.1 (2026-04-08) defaults to `latest`; v3 stays on the pinned `00000000_00`. **Sessions always read the latest published version.** Trigger instances default to `latest`. [docs]

### 4.4 Modifiers

- `beforeExecute` (rewrite arguments), `afterExecute` (reshape results), `modifySchema` (change what the model sees), Python `@before_file_upload` (abort or rewrite uploads). Applied at execution time for chat-completion providers and at tool-fetch time for agentic frameworks. [docs: new-SDK migration guide, glossary]
- They "live in the SDK's execution path. Over MCP the client executes tools against the server and bypasses them." [docs: sessions-via-mcp]
- Composio's support KB recommends a `beforeExecute` modifier as the way to "add a human approval layer" on the platform. [docs: KB Outlook page]

---

## 5. Governance

### 5.1 What exists (as of 2026-10-12)

| Control | Status | Source |
|---|---|---|
| Org roles | Admin / member (For You adds viewer). Only admins toggle ZDR, delete org. No custom roles documented. | [docs] KB org-members, consumer-project |
| Project isolation | Yes; recommended per environment, or per customer for hard isolation/branding | [docs] b2b-agents |
| Scoped project API keys | Session management vs Session tool execution vs Proxy execute vs Tools read…; per-key IP allowlist | [docs] 2026-08-28, security overview |
| Per-session tool policy | toolkits/tools/tags allow/deny, saved Session configs (`sc_…`) | [docs] configuring-sessions |
| Behavior tags | `readOnlyHint` / `createHint` / `updateHint` / `destructiveHint` on every tool | [docs] |
| Approvals / HITL | **New and experimental.** `experimental.permissions` (`allow_all` / `ask_every_call` / `ask_once_per_session`, overrides per `toolSlug:connectedAccountId` with `always_allow`/`always_deny`/`ask_once`/`ask_always`), `require_approval` lists on toolkits/tools/tags, delivered by **MCP elicitation**; `no_elicitation_support_fallback: deny` by default. SDK 0.26/0.23 (2026-10-12) raises `ToolInputRequiredError` with `inputRequests` + opaque `requestState`, but "The SDKs do not submit answers yet." For You has "Enhanced Control" (needs elicitation-capable clients, else "Always Allow" or disable). The enterprise MCP Gateway page advertises "Access requests and approvals". | [docs] create-session reference; [live] changelog 2026-10-12; KB tool-router-sessions; composio.dev/mcp-gateway |
| Audit / logs | Per-tool-call execution logs with args/results (unless ZDR), retained up to 1 year; Logs API (pull, 100/page); usage metering API. "The endpoint does not provide a general API request or organization audit feed." SIEM = write your own poller. | [docs] logs reference, stream-logs-to-a-siem |
| Rate limits | Per org, shared by all endpoints: Hobby 2,000 req/min, Pro 10,000 req/min, Enterprise custom; plus per-IP limits; provider quotas separate | [docs] https://docs.composio.dev/reference/rate-limits (KB uses "Starter/Growth" names for the same numbers) |
| MFA | Dashboard MFA, admin-enforceable | [docs] |
| Webhook auth | Signed deliveries; 2FA ownership checks for triggers/proxy (`user_id` must match account) | [docs], changelog 2026-06-18, 2026-10-12 |
| Compliance | SOC 2 Type II; ISO 27001 (MCP gateway page); DPA, BAA linked; not FedRAMP | [docs], [live] |
| Enterprise | VPC, self-hosted Helm, customer-managed keys, ZDR included, SSO (SAML/OIDC) + SCIM (MCP gateway page), SLAs | [docs], [live] |

### 5.2 Enterprise and plan-gated controls [live: /pricing, /enterprise, /mcp-gateway; via the company sub-research, pricing spot-checked]

- **Roles**: Pro adds a "Read-only dashboard role"; the Enterprise page shows Admin / Developer / Agent / Read Only / No Delete; "Permissions are set administratively, per user and per role, down to the individual action."
- **API key scopes**: 12 permission areas, each No access / Read / Write / Read-and-write; "You pick a key's permissions when you create it, and they can't be changed afterward." [docs: https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions]
- **Identity**: SSO (SAML/OIDC: Okta, Entra ID, Google Workspace) and SCIM 2.0 — Enterprise only.
- **Compliance claims**: SOC 2 Type II everywhere; "ISO 27001:2022" only on marketing pages, not in the docs; BAA as a Pro per-call add-on or included in Enterprise; DPA self-serve on Pro; not FedRAMP. Trust Center (Vanta-hosted) did not render for us. Named assurance partners after the breach: AppSecure (pentest), Latacora (virtual CISO), IntrusionOps (incident response).
- **Security features sold per call on Pro**: IP allowlist +$0.0001, ZDR +$0.0001, BAA +$0.0003 per tool call (section 7). [inference] Governance is a revenue line, which is a reason Every App can differentiate by making these free defaults in a self-hosted product.

### 5.3 What Composio leaves to the developer

- "Require explicit user confirmation before destructive or externally visible actions… Enforce product authorization before creating or restoring the session." [docs: https://docs.composio.dev/docs/production-readiness]
- "Your backend must bind the signed-in user to the correct Composio `user_id`… A caller-supplied user ID is not proof of identity." [docs: token-custody page]
- In other words, on the developer platform Composio is the vault and executor; identity, authorization and (until this week) approvals are the customer's job. Every App's gateway already owns identity and per-app authorization, which is the part Composio cannot do for its customers.

---

## 6. Open source: what is open, what is closed

**Bottom line:** the open part is a well-maintained MIT client (SDKs, provider adapters, CLI, docs, Helm templates). Everything that makes Composio work — the credential vault, tool definitions and execution, search/planning, the sandbox, the MCP server, trigger infrastructure — is closed. Self-hosting exists only as a licensed enterprise Kubernetes install that pulls private images. There is no Cloudflare/Workers path for the backend.

Read at `ComposioHQ/composio@8b07933f85856c2efa62273369609732455ed787` (branch `next`, 2026-10-12), shallow clone at `/tmp/everyapp-research-2/composio/repo` (read only; nothing installed or run). Helm values read via the API and saved at `/tmp/everyapp-research-2/composio-helm/values.yaml`.

### 6.1 Repos [live: `gh api orgs/ComposioHQ/repos`, 2026-10-12]

ComposioHQ has only 16 public repos.

| Repo | Stars | License | Last push | What it is |
|---|---|---|---|---|
| `awesome-claude-skills` | 76,948 | none (no LICENSE file) | 2026-09-18 | Curated list of Claude skills (a marketing/distribution asset) |
| `composio` | 30,509 | MIT ("Copyright (c) 2025 Sampark Inc.") | 2026-10-12 | SDK monorepo: `ts/`, `python/`, `docs/`, CLI installer, `skills/composio` |
| `trustclaw` | 903 | MIT | 2026-07-10 | "Self-hostable" agent that still needs a cloud `COMPOSIO_API_KEY` |
| `helm-charts` | 3 | MIT | 2026-10-12 | Templates for the enterprise self-host (images are private) |
| `composio-base-py` | 3 | Apache-2.0 | 2026-08-19 | Generated Python HTTP client |
| plugins (`composio-plugin-cc`, `-openai`, `composio-mcp-plugin`), `logo-cdn`, `platform-imessage`, small misc | ≤ 18 | mostly MIT | 2026 | Distribution plugins and assets |

- Moved out of the org: `agent-orchestrator` → `OrchestratorInc/agent-orchestrator` (13,109 stars, Apache-2.0); `skills` → `composio-community/skills` (MIT). `open-rube`, `Rube`, `apollo`, `thermos`, `mercury`, `hermes`, `tool-router`, `composio-base-ts` all return 404. [live]
- **License metadata is inconsistent** [code]: the repo LICENSE is MIT, but every `@composio/*` npm `package.json` says `"license": "ISC"`, Python packaging says Apache, and `@composio/client` is Apache-2.0 with its source repo (`composio-base-ts`) not public.
- **Activity** [live]: ~1,251 commits on `next` since 2026-07-14 (bots included), 108 contributors, 49 open issues, 71 open PRs, 1,365 GitHub releases (changesets). `@composio/core` went 0.13.0 (2026-06-26) → 0.23.0 (2026-10-12): ten minor versions in about 15 weeks, several with breaking changes; a `1.0.0-beta.1` dist-tag also exists [live: https://registry.npmjs.org/@composio%2fcore].

### 6.2 Packages [code]

- npm: `@composio/core`, `@composio/slim`, `@composio/experimental`, `@composio/json-schema-to-zod`, `@composio/cli` (binary); providers `@composio/{openai, openai-agents, anthropic, claude-agent-sdk, google, langchain, llamaindex, mastra, vercel, cloudflare, typesafe}`; `EveProvider`/`PiProvider` in experimental.
- PyPI: `composio` plus `composio-{anthropic, autogen, claude-agent-sdk, crewai, gemini, google, google-adk, langchain, langgraph, llamaindex, openai, openai-agents, typesafe}` (all 0.26.0).
- **Cloudflare specifics**: `@composio/core` has `workerd` export conditions and Workers e2e tests (needs `nodejs_compat`). `@composio/cloudflare` only formats tools for **Workers AI** function calling. There is **no Cloudflare Agents SDK adapter**. The `Files` model throws "not supported in Cloudflare Workers" (`ts/packages/core/src/models/Files.workerd.ts:10`).
- **Telemetry is on by default**: `allowTracking` defaults to true; the SDK sends an init event and one event per instrumented method (name, duration, provider, host/version/platform) to `https://telemetry.composio.dev/v1/metrics/invocations`, errors to `/errors`; it also checks `registry.npmjs.org` for a newer version. Disable with `allowTracking: false` / `TELEMETRY_DISABLED=true` / `disableVersionCheck: true`. (`ts/packages/core/src/telemetry/Telemetry.ts:54-181`, `services/telemetry/TelemetryService.ts:4,41,56`, `utils/version.ts:42`)
- **Alternate backend**: `baseURL` option → `COMPOSIO_BASE_URL` env → `~/.composio/user_data.json` → `https://backend.composio.dev` (`ts/packages/core/src/utils/sdk.ts:410-414`). The Pusher key for `subscribe()` is overridable too. [inference] Built to point at self-hosted installs.

### 6.3 What the SDK code adds to the docs picture [code]

- Full auth-scheme enum (`types/authConfigs.types.ts:9-25`): `OAUTH1, OAUTH2, API_KEY, BASIC, BEARER_TOKEN, BILLCOM_AUTH, GOOGLE_SERVICE_ACCOUNT, NO_AUTH, BASIC_WITH_JWT, CALCOM_AUTH, SERVICE_ACCOUNT, SAML, DCR_OAUTH, CIMD_OAUTH, S2S_OAUTH2`. Custom auth configs can also carry a `proxyConfig {proxyUrl, proxyAuthKey}` and `toolAccessConfig`.
- Connected-account statuses (`types/connectedAccounts.types.ts:8-16`): `INITIALIZING, INITIATED, ACTIVE, FAILED, EXPIRED, INACTIVE, REVOKED`. `waitForConnection` polls every 1 s (60 s default) and treats FAILED/EXPIRED/REVOKED as terminal.
- `allowMultiple` is enforced **client-side only** (the SDK lists ACTIVE accounts and throws `ComposioMultipleConnectedAccountsError`) (`models/ConnectedAccounts.ts:222-239, 401-417`).
- The CLI's canonical meta-tool list (`ts/packages/cli/src/utils/meta-tool-slugs.ts:10-18`): `COMPOSIO_SEARCH_TOOLS, COMPOSIO_MULTI_EXECUTE_TOOL, COMPOSIO_MANAGE_CONNECTIONS, COMPOSIO_WAIT_FOR_CONNECTIONS, COMPOSIO_REMOTE_WORKBENCH, COMPOSIO_REMOTE_BASH_TOOL, COMPOSIO_GET_TOOL_SCHEMAS`. Full prompts live in `docs/public/data/meta-tools.json` (SEARCH: "Always call this tool first whenever a user mentions or implies an external app…"; GET_TOOL_SCHEMAS: "never guess or fabricate slugs").
- Session MCP URL: server-issued, session IDs `trs_…`; fixtures show `https://backend.composio.dev/api/v3/tool_router/session/{id}/mcp`. Headers are attached only if the MCP URL has the same origin as the API base (`lib/toolRouterMcp.ts:111-132`).
- Toolkit-version guard: `tools.execute` throws `ComposioToolVersionRequiredError` when the version resolves to `'latest'` unless `dangerouslySkipVersionCheck` — but provider-wrapped agent calls set that flag automatically (`models/Tools.ts:853, 921, 974-979`).
- Custom tools: schemas are sent to the backend for search indexing; execution is split locally/remotely inside `MULTI_EXECUTE` batches (`models/customToolExecution.ts:67-100`). `LOCAL_` and `COMPOSIO_` prefixes are reserved.
- Trigger `subscribe()` = Pusher channel `private-${projectId}_triggers` (`services/pusher/Pusher.ts:69, 226`). Webhook verification = Standard Webhooks (`v1,<base64>` HMAC-SHA256 over `id.timestamp.body`, 300 s tolerance; `models/Triggers.ts:82-84, 1158-1254`).

### 6.4 The catalog snapshot in the MIT repo [code, computed]

`docs/public/data/toolkits.json` (regenerated from the live API) contains names, descriptions, auth-field definitions and default scopes — but no input schemas — for:

| Measure | Count |
|---|---|
| Toolkits | **1,603** |
| Tools | **60,611** |
| Triggers | **671** |
| Toolkits with Composio-managed OAuth (`composioManagedAuthSchemes`) | **123** (122 OAuth2 + 1 OAuth1) |
| Toolkits supporting OAuth2 / S2S OAuth2 / DCR OAuth | 220 / 26 / 98 |
| Toolkits that are API-key-only | **1,203** (75%) |
| Toolkits that are wrappers of vendors' own remote MCP servers via `DCR_OAUTH` (slugs end in `_mcp`: `linear_mcp`, `notion_mcp`, `atlassian_mcp`, `datadog_mcp`, `cloudflare_mcp`, `monday_mcp`, `neon_mcp`, …) | 98 |
| Tools in a few big toolkits | GitHub 897, Outlook 316, HubSpot 282, Salesforce 239, Slack 170, Google Drive 105, Gmail 63, Notion 60, Google Calendar 50, Linear 48 |

[inference] Two implications: (1) the "connect once, zero setup" OAuth experience covers ~123 apps, not 1,600 — most of the catalog is "paste your API key"; (2) Composio itself increasingly wraps vendors' official MCP servers instead of hand-writing tools for them. Whether this generated catalog data is really MIT-licensed is unclear; do not copy it without a legal read.

### 6.5 The closed backend (from the enterprise Helm chart) [live: `ComposioHQ/helm-charts`]

| Service | Role |
|---|---|
| Apollo | Main API, OAuth callbacks, business logic (Prisma, Postgres, Redis) |
| Thermos | Tools management; a read-only Postgres "toolkit registry" image with toolkit/tool/trigger definitions |
| Mercury | Knative/Lambda service that executes OpenAPI-defined tools |
| Temporal | Workflows (auth refresh, triggers) |
| Weaviate or Turbopuffer | Vector store for tool search |
| Frontend | Dashboard |

Self-host requirements: Kubernetes with Knative, Postgres 17+, Redis, S3/Azure/GCS, and an OpenAI key ("required for Frontend, Mercury and Apollo"). Images come from a private ECR / Replicated registry gated behind "Request On-Prem Access". No docker-compose path. [live]

---

## 7. Pricing (new model since 2026-08-15)

Unit: **tool calls** and **delivered trigger events**, with small per-call surcharges for add-ons. "No per-seat pricing." Sessions and meta tools are free. [live: https://composio.dev/pricing, `/pricing.md`, fetched 2026-10-12]

| Meter | Hobby ($0) | Pro ($29/mo, includes $29 of usage; no rollover) | Enterprise |
|---|---|---|---|
| Tool calls (your own OAuth app, API key, or MCP) — "Each tool execution counts once. Meta tools such as tool search are free." | 100K/mo | then $0.0003 per call ($0.30 per 1K) | Custom |
| Trigger events — "Billed per event delivered to your webhook, not per poll." | 50K/mo | then $0.003 per event | Custom |
| Calls via Composio-managed OAuth apps | up to 20K of the 100K | $0.0005 per call | Custom |
| Trigger events via managed apps | up to 10K of the 50K | $0.005 per event | Custom |
| Connected accounts | unlimited on your own app; managed apps: first 1K free | managed apps: $0.10 one-time per extra connection | Custom |
| Team members | 3 | unlimited | unlimited |
| API rate limit | 2,000 req/min | 10,000 req/min | custom |

Add-ons (Hobby free allowance → Pro surcharge per tool call): shared-connection calls 1K → +$0.0003; direct execution outside a session 10K → +$0.0001; proxy execute 1K → +$0.0002; sandbox execution 10K → +$0.0001; IP allowlist +$0.0001; ZDR +$0.0001; BAA +$0.0003; "advanced white-labeling" (theming the connect page) +$0.30 per connection one-time. Enterprise includes SSO/SCIM, customer-managed keys, MSA/DPA/BAA, SLA. Instant tools are pass-through "with 0% markup" from a prepaid balance, plus the normal tool-call charge.

- **History** [archive via sub-research; third-party tracker]: 2025 plans were "Totally Free" (20K calls), "Ridiculously Cheap" $29 (200K), "Serious Business" $229 (2M), with connected accounts metered and log retention 14/30/90 days by tier. A tracker (usagepricing.com) counts at least 7 restructures since mid-2024, including a July 2026 announcement that was changed before the Aug 15 launch. Pre-Aug-15 customers are grandfathered only through 2026-12-31.
- **Worked examples [inference]**: 50 people × 20 tool calls per working day ≈ 22K calls/month — inside the 100K free calls on either plan. 500 people × 50 calls/day ≈ 550K calls/month ≈ (550K − 100K) × $0.0003 ≈ $135/month on own OAuth apps (about (550K − 20K) × $0.0005 ≈ $265 if every call used managed apps). Cost is not the problem for internal tools; custody, branding, lock-in and reliability are.
- [inference] The pricing nudges customers off managed apps (managed calls cost ~1.7x, managed triggers 1.7x) and into sessions (direct execution costs extra) — consistent with the shared-quota problems in section 8.

---

## 8. Weaknesses and criticisms

Access note: Reddit (403), X (unreachable) and G2 (403) could not be read, so community evidence comes from GitHub issues, Hacker News, status-page history, review sites and Composio's own disclosures. Competitor comparisons (Arcade, Nango, Scalekit) are marked **biased**. Items marked "spot-checked" I re-fetched myself; the rest come from the criticisms sub-research's live reads.

### 8.1 The May 2026 credential breach (the dominant fact)

- **What Composio says** [live, spot-checked: https://composio.dev/blog/composio-may-2026-security-incident, published 2026-05-21, updated 2026-09-16]: "In May 2026, an attacker accessed internal Composio systems and compromised customer credentials." The attacker, "brute-forcing many combinations of exploits using LLM generated attack patterns", gained "a foothold in an internal agentic tool used to monitor our infrastructure and report connector failures", used it "to obtain elevated access to the automated remediation systems that fix errors in our connectors", then "registered malicious tool definitions inside our sandboxed execution environment". Exposure: "about 0.3% of active connections, including 5,001 GitHub connections"; "5,241 Composio API keys as potentially exposed". All customers had to rotate API keys by May 23. "Our follow-up communication was too quiet."
- **Third parties**: Material Security (2026-06-03) puts the initial vector at "a compromised Gmail OAuth token belonging to a Composio employee", citing Composio's disclosure [live, spot-checked]. Mintlify "terminated our existing integrations with Composio" [live, spot-checked]; Hyperagent "immediately disabled all Composio-powered integrations" and moved to first-party integrations [live, spot-checked]. Cyera (2026-08-13) showed that before redaction, a single read-only API call with a leaked Composio key returned Gmail access and refresh tokens (date of test unclear).
- **Fallout** [live: status page via sub-research]: May 22–26 saw a 5h43m outage of all webhook/trigger deliveries (secret-rotation misconfiguration), ~32 h of a broken CLI, 15 h dashboard downtime; Connect MCP returned 401s for weeks for some users (#3485).
- **What changed afterwards**: tokens and client secrets no longer returned by the API, envelope encryption with a KMS-held key-encryption key, hashed API keys, scoped keys, IP allowlists, customer-managed keys, a rebuilt tool-building service, OIDC instead of shared static secrets.
- [inference] **Lessons for Every App**: (1) a multi-tenant token vault is a single high-value target — Every App's per-customer self-hosting is a real security argument, not just a privacy one; (2) the breach path ran through an *internal AI agent with write access to tool definitions* — exactly the kind of system Every App is building, so tool definitions and catalogs need provenance and review, not automated self-repair; (3) envelope encryption with per-org keys, hashed API keys, and "tokens never leave the gateway" should be day-one design.

### 8.2 Shared managed OAuth apps are a single point of failure

Evidence from Composio's own status page and changelog [live; spot-checked where noted]:
- 2025-09-29: "Google has temporarily restricted our default auth config" (spot-checked) — sensitive scopes unavailable ~21 h; advice: "For production environments, we strongly recommend using custom auth configurations."
- 2026-01-25: "GMAIL connections are being expired prematurely, and are failing to refresh the tokens." (spot-checked)
- 2026-02-09→16 (173 h): "X suspended Composio's app… due to platform policy enforcement. Users should use their own X developer credentials going forward." (spot-checked)
- 2026-06-10: Linear rate-limited Composio's token refreshes. 2026-08-22: rate limits on the managed QuickBooks app. 2026-10-02: "All instagram accounts connected before August 3 got expired." 2026-10-05→07: Discord Bot toolkit down 2+ days while Composio considered dropping managed Discord bot connections. (spot-checked in RSS)
- Managed credentials withdrawn for 12 apps (2025-12) and Twitter (2026-02); the polling floor raised to 15 minutes because managed apps "share rate limits across all users".
- Google Ads: the managed developer token is shared at "Basic access" with "no customer-facing shared-quota monitor" (#4020, #4169).

### 8.3 Reliability

- Status page claims 99.94–99.99% per component but lists ~52 incidents from Jun 2025 to Oct 2026 [live, via sub-research]. Users reported the status page under-reporting during the breach week (#3472).
- 2026-04-28→30: ~36 h webhook-trigger outage (Slack, Outlook, Notion, HubSpot) for ~700 customers; events "were not queued by the platform and are unfortunately not recoverable"; root cause a silently failing cleanup job [live, spot-checked].
- Gmail triggers broke twice in July 2026 ("a change we had already reverted was re-introduced by an automated sync") [spot-checked]; Connect MCP 502s for ~19% of users for ~8 h on 2026-10-06 [spot-checked].
- Connections that show ACTIVE but don't work: Twitter 403 "client-not-enrolled" (#4190), invalid API keys accepted as ACTIVE (#4120), `refresh()` flipping a working account to INITIATED (#1914); Composio's own KB says a Google connection is marked active even if the user unticked scopes.

### 8.4 Latency and overhead

- Extra hop by design: your app → Composio → provider, with payload logging by default. No independent latency benchmark found. **Biased**: Arcade claims 747,083 vs 7,426 tokens on its own Attio benchmark, no methodology.
- SDK cold-start ~3.9 s from a blocking npm version check plus a telemetry POST (#2970, fixed May 2026) [spot-checked]; MCP responses carried internal debug logs, "3-5x token bloat" and broken prompt caching (#2452, #3950, fixed).
- **Directly relevant to Every App**: "~40% of requests from Cloudflare Workers egress are 429d (code 10429, no rate-limit headers) while the org budget is untouched" (#4207, 2026-08-22). A maintainer confirmed "an additional rate limit that is independent of the documented per-organization budget"; "No fix for this report is deployed"; closed and redirected to email [live, spot-checked]. The June 4 changelog mentions per-IP limits; the rate-limit docs don't.

### 8.5 Consent branding and Google verification

- Docs: managed auth means users "see 'Composio wants to access your account'"; "In production, users should see your app name, not 'Composio.'" The "Secured by Composio" badge goes away only with your own OAuth app; theming the connect page costs $0.30 per connection on Pro.
- Bring your own Google client and the verification is yours: "you have to go through a third party agency for CASA. We do not provide anything as such from our side." — and Composio declined to share its own approved justification (#1887, 2025-09) [live, spot-checked]. Google requires annual CASA for apps that "store or transmit restricted scope data on servers". [inference] With a BYO Google client on Composio, tokens and (by default) Gmail payload logs sit on Composio's servers for up to a year, so the customer's CASA scope probably has to include Composio; the docs don't address this.
- Over-broad defaults are visible to end users: an HN user (2026-04-11) "noped out" when "Composio was asking for some concerning data (DOB, exact street address)" while linking Gmail — consistent with the People API scopes (`user.birthday.read`, `user.addresses.read`) in Gmail's default scope string (section 2.2).
- Managed-app gaps: `gmail.settings.basic` pending (#4062), some Google Super scopes unavailable, Zoom webinar scopes missing (#4253), Calendly auth configs "unconnectable" because the bundled app refuses derived scopes (#4392, open) [spot-checked].

### 8.6 Lock-in

- No token export (docs); import is one-way; enterprise-only self-host; users must re-authenticate to move between auth configs.
- Product shutdown precedent: Rube was shut down with ~5 weeks' notice and no automatic migration ("Why aren't you migrating my accounts automatically?" is in its FAQ) [live, spot-checked].
- **Biased**: Nango and Scalekit argue tool schemas and patterns get embedded in agent logic and can't be inspected or modified.

### 8.7 Cost and pricing volatility

- At least 7 pricing restructures since mid-2024 per a third-party tracker; a July 2026 announcement (reportedly $4 per 1K overage) was replaced before launch; grandfathering ends 2026-12-31 [live, via sub-research]. **Biased**: Nango quotes a customer seeing "more than 10 times the previous amount".
- Security and compliance features are per-call surcharges on Pro (section 7).

### 8.8 Other security history

- MCP URLs that worked without a user ID or API key until 2026-01-15 / 2026-04-15 for legacy projects (section 3.4).
- CVEs in the old Python SDK's local server/tools: CVE-2024-8954 "Authentication Bypass in composiohq/composio" (CVSS 3.0 vector AV:N/AC:L/PR:N/UI:N → 9.8), plus SSRF, eval injection, code injection and path traversal (CVE-2024-8952, -8953, -8955, -8864, -8865) and CVE-2025-56427 directory traversal (GHSA-3mwv-j45g-vp3w, CVSS 7.5, 2025-12-04) [live: OSV and GitHub advisory API, spot-checked]. Old codebase; the current SDKs are a rewrite.
- CLI file-upload path skipped the `.ssh`/`.aws`/`.env` denylist, allowing prompt-injection exfiltration; reported privately 2026-06-01 with no response, fixed 2026-07-06 after the reporter went public (#3746) [spot-checked dates].
- Duplicate side effects from SDK retries (an email sent twice, #3654); fixed by "never retry executions" (2026-10-12).

### 8.9 Developer experience

- Constant renames and paradigm shifts (section 10.2 item 8); SDKs still pre-1.0 with breaking changes as recently as today.
- Tool quality: 75 toolkits with "no supported actions" deprecated (Dec 2025); ~230 tools on deprecated upstream endpoints (Feb 2026); YouTube uploads never sent the video bytes from March to at least July 2026 (#2954/#3547); recurring LinkedIn 426 errors from a retired header in a pinned version (#4320).
- Support: stale-bot auto-closes (53 issues), an automated "Claude cannot reply back in a conversation" triage bot, an 8-week reply (#3485). Trustpilot: 4 reviews, all 1-star (tiny sample).
- Telemetry on by default in SDK and CLI (section 6.2).

### 8.10 Praise, for balance

- 30.5k GitHub stars; AWS Marketplace/G2 mirror 4.9/5 from 7 reviews ("connect Gmail and Drive within 30 minutes"); HN builders like it for "managed Google OAuth" and price; fixes often ship within days; competitors concede catalog breadth and low per-call price; the docs are unusually thorough and honest about limits (most of this report is sourced from them).

### 8.11 Ranked

| # | Criticism | Evidence strength |
|---|---|---|
| 1 | A central multi-tenant token vault is a big blast radius (May 2026 breach; customers left) | Very strong (primary disclosure, customer statements) |
| 2 | Shared managed OAuth apps fail for everyone at once (Google restriction, X suspension, quotas, withdrawals) | Very strong (status page, changelog) |
| 3 | Production still needs your own OAuth app, so you carry Google verification/CASA — while Composio holds the tokens | Strong (docs, #1887) |
| 4 | Lock-in: no token export, re-consent to leave, enterprise-only self-host, Rube shutdown | Strong (docs, changelog) |
| 5 | API/SDK churn and breaking changes | Strong (Composio's own changelog) |
| 6 | Uneven auto-generated tools and broad default scopes | Strong (issues, deprecations, catalog defaults) |
| 7 | Pricing volatility; security features as paid add-ons | Moderate–strong |
| 8 | Reliability/latency, including an undocumented per-IP limit hitting Cloudflare Workers | Moderate (incidents, #4207; no independent benchmark) |

---

## 9. "Integration hub + apps on top": how Composio thinks about it

- **There is no app builder, internal-tools product, workflow builder or scheduler.** "Recipes" (shareable, schedulable automations) existed only in Rube and died with it on 2026-05-16. The phrases "internal tool", "app builder" and "Retool" appear nowhere on the site or docs. [live/docs via sub-research; Rube spot-checked]
- **Customers do build internal agents on Composio connections**:
  - Pelago Health: an internal Slack agent "Archie" running in Pelago's own AWS, "160 Composio-powered agents"; Composio supplies "the logging and role-based access controls that Pelago's regulatory environment requires"; "Composio is really the guts and the plumbing of this platform." [live: /customers/pelago-health]
  - Spinnable ("AI employees"; "non-technical team members can shape and ship custom integrations on demand"), Glean Agent Builder, AWS Quick, Zoom Mate. [live]
  - The docs' own examples are internal-tool shaped: a team Slack bot that acts as each person but posts as the workspace bot, a white-labelled daily stand-up bot, "restrict Gmail connections to an email domain", three background agents coordinating on one Linear board. [docs]
- **AI app builders**: no partnerships or docs with Lovable, Replit, Bolt, v0, Create, Same or Base44. Emergent is only a homepage logo. Composio built an archived demo repo `composio-temp/lovable-for-ai-agents` (2025). [live via sub-research]
- **Distribution is through AI clients instead**: official plugins/connectors for Claude Code, Claude/Cowork, ChatGPT/Codex, Cursor, Grok, Hermes, OpenClaw, n8n, Notion agents, OpenAI Agent Builder, VS Code, Windsurf. [docs: composio-connect]
- **The two-world split is the gap.** Inside one Composio org, the developer "Platform" projects (where you build apps) and the consumer "For You" project (where staff connect apps for Claude/ChatGPT) do not share anything: "Developer-project auth configs and connected accounts are not available in the consumer project. Consumer-project connections are not available in the developer project." [docs: https://docs.composio.dev/kb/guide/consumer-project-boundaries-and-auth-selection] So an employee who connected Gmail for Claude via For You must connect again for an internal app built on the Platform, and For You connections "belong to the member who authorized them" (no org sharing by default).
- **Custom MCP** (experimental) lets a company register its own internal service's MCP server as a `CUSTOM_*` toolkit next to the SaaS toolkits — the closest Composio gets to "internal apps inside the hub", and it is tools-only.
- **Direction** [inference]: Composio is converging on (1) a governed enterprise MCP gateway ("Connect every AI agent to the tools your teams use through one secure, governed, and observable MCP gateway") — which overlaps Every App's ToolBus — and (2) a consumer MCP for individuals. The layer Every App targets — private internal apps with their own UI and data that reuse the org's connections and sit behind the same agent endpoint — is not something Composio offers; Executor v2 is the competitor moving there (see `2026-10-platform-review/raw/ref-executor.md`).

---

## 10. Lessons for Every App

Composio is really five products glued together. Every App should treat them separately, because its advantages and Composio's moat sit in different places:

| Layer | Composio | Every App today / planned | Who should win it |
|---|---|---|---|
| 1. Catalog (tool definitions for 1,603 APIs, 60,611 tools, agent-tuned descriptions, constant upkeep) | The moat, and the expensive part (230 tools deprecated in one sweep, Feb 2026) | None | Don't compete. Borrow breadth (vendor MCP servers, optional Composio adapter) |
| 2. Credential vault (OAuth clients, connect links, refresh, multi-account, sharing) | Strong, hosted, tokens not exportable | OpenAI key hoisting only | **Every App**: tokens in the customer's own Cloudflare account, branded internal OAuth clients |
| 3. Agent surface (sessions, meta tools, MCP, sandbox) | Mature | ToolBus planned (M3) | Copy the shapes; Every App adds first-party app tools |
| 4. Events (triggers) | Good, but 15-min polling floor on managed auth | None | **Every App**: provider webhooks → gateway → Queues → app Workers over service bindings |
| 5. Governance (policy, approvals, audit) | Approvals experimental, SDK support only from 2026-10-12; pull-only logs; payloads kept 1 year by default | Per-app consent, risk policy, per-call audit, browser approvals planned | **Every App** is already ahead for internal use |

### 10.1 Copy these

1. **Split "how a provider authenticates" from "one person's grant"** (auth config vs connected account). [inference] Two D1 tables:
   - `integration_clients` (org-scoped): provider, client ID, encrypted client secret, default scopes, redirect URI on the gateway origin, created by an org admin.
   - `connections`: `org_id`, `owner_kind` (`member` | `org`), `owner_id`, `provider`, `client_id` (the client that minted it — Composio's rule that a connection stays bound to its creating config is correct), provider identity (`email`/`login`, the analog of `displayName`), granted scopes, `status` (`initiated`/`active`/`expired`/`revoked`/`failed`) plus `status_reason`, `alias`, encrypted token blob, `last_refreshed_at`.
2. **Member-owned vs org-owned connections, and never use a shared one implicitly.** Copy Composio's B2B advice (org-owned connections live under an integration identity that "should survive membership changes"), its SHARED ACL (`allowAllUsers` / `allowedUserIds` / `notAllowedUserIds`, deny wins, deny by default), and its rule that a SHARED connection is used only when explicitly pinned. Example worth stealing: a Slack bot posts as the org (org connection) while every GitHub action runs as the person asking (member connection).
   - In Every App terms: an app's manifest says which providers it needs and whether it wants the **member's** connection, the **org's**, or either; an admin decides which apps may use an org connection.
   - Avoid Composio's silent "most recently connected account wins" when someone has two accounts; require an explicit choice (alias) once there is more than one.
3. **Connect links that agents can hand to users — but bound to the gateway session.** Composio's in-chat flow (`COMPOSIO_MANAGE_CONNECTIONS` returns a hosted link; the agent shows it; the run continues once the account is active) is the right UX. Every App can do it more safely than Composio because the gateway already owns the user's browser session:
   - The link is `https://<gateway>/connect/<request-id>`: single use, 10-minute TTL, requires gateway sign-in, and the callback activates the connection only if the signed-in user is the one who started it. That is exactly the OAuth session-fixation defense Composio added as an *opt-in* in July 2026.
   - Use the same "action required" page for connect, re-consent (scope upgrade), and approvals (M3-6), so agents learn one pattern.
   - Copy the Slack-bot trick: when the tool result carries a link, the host can redact it from the model transcript and deliver it privately.
4. **The meta-tool shapes, which are field-tested.** For ToolBus search mode (M3-7):
   - `search` takes several short `use_case` queries at once and returns tool schemas, **connection status per provider** (with a connect link when missing), and the current time.
   - `get_schemas` returns `not_found` plus up to 3 `suggestions` (models invent slugs; Composio's descriptions say "never invent" repeatedly).
   - `execute` accepts a batch of independent calls with per-item errors (Composio allows 50).
   - Optional `wait_for_connection` (Composio notes it "may not work reliably with GPT models"; the browser link plus retry is enough).
5. **Four behavior tags, not two.** `readOnlyHint` / `createHint` / `updateHint` / `destructiveHint` on every tool, with session filters by tag and per-provider overrides. "Create" (send an email, post a message) is externally visible and deserves its own approval default. This maps onto ToolBus's read/write/destructive policy with one extra bucket. Composio even classifies third-party MCP tools into these tags at sync time.
6. **Agent-oriented tool descriptions.** Write descriptions the way Composio's Gmail toolkit does: what it does, the common mistake, the safer alternative, reversibility, rate limits, and "confirm with the user before…". Put this in the `defineTools()` authoring guide and lint for it.
7. **Offload big results instead of stuffing context.** Composio writes responses over a threshold (default 20k characters) to session storage and returns a preview plus a handle. [inference] On Cloudflare: write the full result to R2 (24 h TTL), return a preview and a `result_id`, and offer `read_result(result_id, range | json_path)`. Leave a code sandbox (Composio's persistent Python workbench) for later; if needed, use Dynamic Workers "code mode" as Executor does.
8. **Proxy execute = the existing `providers: ["openai"]` hoist, generalized.** Apps call the gateway over the service binding (`/api/connections/<provider>/<path>`); the gateway resolves the right connection from the identity JWT and manifest, injects the token, and enforces Composio's guardrails: same registrable domain as the provider's base URL, an explicit capability, a size cap, and **no automatic retry** of non-idempotent calls (Composio learned this the hard way: "a retry after the upstream API already acted would repeat the write"). One audit row per call.
   - **Token vending vs proxy.** The current plan (TICKETS.md M4-8) is "`google.getAccessToken(scopes)`, returning short-lived tokens only. Token vending comes first; a full proxy broker comes later." Composio went the other way in 2026: it stopped returning tokens from its API (managed apps in April, all apps by June) and points everyone to Proxy Execute, because a leaked token escapes all policy and audit. [inference] Vending is acceptable for first-party apps the org built and deployed itself, but apps installed from the open-source store should get proxy-only access by default, with vending as an explicit admin grant per app and scope.
   - **Naming:** the roadmap's "Connections page" (M1-3) means MCP client tokens for agents. If third-party accounts are also called "connections", the UI will have two different things with one name. Composio's split ("connected accounts" for third-party grants) is worth copying; e.g. "Accounts" for Google/Slack grants and "Agent connections" for MCP clients.
9. **Saved, versioned policies.** Composio's "Session configs" are named policies; later edits don't change sessions already created; updates support `expectedConfigVersion` and keep a config history. That maps to ToolBus grants: snapshot the policy into the grant at consent time, keep a history, and use optimistic concurrency for admin edits.
10. **Approval vocabulary.** Composio's (experimental) `permissions` block is a good model: default `ask_every_call` / `ask_once_per_session` / `allow_all`, overrides keyed by **tool + connection** (`always_allow`, `always_deny`, `ask_once`, `ask_always`), and `no_elicitation_support_fallback: deny`. Every App's browser-link approvals cover clients without elicitation (claude.ai); keep "deny when we can't ask" as the default.
11. **Scope tooling.** Per-tool required scopes and least-privilege recommendations; "scope changes affect new connections only", so show a "reconnect to grant X" prompt. [inference] Let manifests declare per-provider scopes; the gateway requests the union with Google incremental authorization.
12. **Verify which account was connected.** Composio's `displayName` plus its "restrict Gmail to one domain" example. [inference] For internal tools, default to "a Google connection must belong to the org's Workspace domain".
13. **Copy Composio's post-breach vault design from day one, not after an incident.** Envelope encryption (a per-org data key wrapped by a key-encryption key held in Workers Secrets/Secrets Store, rotatable), decrypt only inside the request that uses the token, never return tokens or client secrets from any API, store PATs and API keys only as hashes, and offer provider-side revoke (not just delete) when an account is removed — Composio's FAQ: "Deleting a connection alone does not guarantee provider-side revocation." [live: breach post]
14. **Event delivery hygiene.** Standard Webhooks signing, at-least-once delivery with a stable event ID, connection-expired and trigger-disabled lifecycle events, and per-trigger-instance enable/disable. [inference] On Cloudflare this becomes: provider webhook → gateway (the only public Worker) → verify → Queue → app Worker over its service binding with an identity token. Apps never need a public webhook URL, which removes Composio's "your webhook must be public; our IPs are dynamic" problem.

### 10.2 Avoid these (Composio's scars)

1. **Never let a URL be the credential.** Composio's first MCP URLs were "pre-signed"; it then spent Nov 2025 → Jun 2026 adding `user_id`, then an API-key header, then default-on enforcement *only for orgs created after 2026-03-05*. ToolBus is OAuth from day one; keep it that way, including for any per-session or per-app URL.
2. **Don't make a vendor-owned shared OAuth app the default for a self-hosted product.** Composio's managed apps put "Composio" on the consent screen, share one provider quota across all customers (hence the 15-minute polling floor), share one blast radius if the provider suspends the app, are excluded from ZDR below Enterprise, and have been withdrawn for 13 apps. For Every App, a central Google client would also need either every gateway's redirect URI registered or a relay through Every App Inc. that sees codes and tokens, and Every App Inc. would carry Google's restricted-scope verification and annual re-verification. Instead:
   - Default to **bring-your-own client per org**, with setup wizards. Google: an **Internal** (Workspace-only) OAuth client needs no Google verification — "All users within your organization can access. Verification is not required." [live: https://developers.google.com/identity/protocols/oauth2/production-readiness/overview] — though Workspace admins may need to allow internal apps to use restricted Gmail/Drive scopes. GitHub: the App-manifest flow creates an app in about one click (POST a manifest to `github.com/organizations/<org>/settings/apps/new`, exchange the code within an hour) [live: GitHub docs]. Slack: app manifests.
   - The consent screen then says the company's own app name, which is exactly what internal tools want. (TICKETS.md M4-8 already notes the Internal-client route for self-hosters; Composio's history is the evidence for making it the default rather than a fallback.)
3. **Don't keep payloads by default.** Composio stores tool arguments and results for up to a year unless you buy ZDR. [inference] Store metadata, argument hashes and result sizes; make payload capture an explicit, short-TTL debug switch.
4. **Don't phone home by default.** Composio's SDK sends telemetry and checks npm for updates by default. An MIT, self-hosted product should keep telemetry opt-in.
5. **Don't put policy in client-side hooks.** Composio's modifiers and custom tools silently don't run over MCP. Enforce everything in the gateway, where every client path (MCP, app service binding, CLI) passes.
6. **Don't chase the catalog.** 60,611 tools is a maintenance business. Get breadth cheaply:
   - (i) Vendors' own remote MCP servers as a connection type, with OAuth via DCR/CIMD (Composio itself now wraps 98 of them: Linear, Notion, Atlassian, Datadog, Cloudflare, monday, Neon…).
   - (ii) A few first-party connectors where internal tools live (Google Workspace, Microsoft 365, Slack, GitHub).
   - (iii) Generic authenticated fetch for apps (item 10.1.8).
   - (iv) Optionally, Composio for the long tail (10.3).
7. **Don't depend on cross-customer learning.** Composio's "skills" are "derived from real usage across the platform". A self-hosted product can't, and shouldn't, pool customer traces. Ship curated per-connector guides in the repo (a `skills`/`guides` tool, as Executor does), optionally plus per-org learned pitfalls.
8. **Don't churn the contract.** In 12 months Composio renamed core concepts (entity→user, apps→toolkits, integrations→auth configs, Tool Router→sessions, workbench→sandbox, Premium→Instant), made toolkit versions mandatory for direct execution, changed MCP auth three times, retired an endpoint for managed OAuth, moved webhook payloads V1→V3, raised the polling floor from 1 to 15 minutes, started redacting tokens, and shipped ten `@composio/core` minor versions between late June and mid-October 2026. Every App's manifest, `defineTools()` and connection APIs are public contracts; version them and keep them stable.
9. **Avoid "clear = widen" APIs.** Composio's `session.update({toolkits: null})` restores the unrestricted default ("Clearing a policy can widen access"). Make empty mean "nothing allowed" and require an explicit "all".
10. **Don't give automation write access to tool definitions.** The May 2026 breach went from "an internal agentic tool used to monitor our infrastructure" to "automated remediation systems that fix errors in our connectors" to "malicious tool definitions inside our sandboxed execution environment". [inference] For Every App: tool catalogs come only from signed app deployments and reviewed connector releases; nothing at runtime (including the planned built-in gateway agent, M5-8) can register or edit tools.
11. **Don't default to broad scopes.** Composio's defaults (full Gmail, full Drive, `repo,user,…,workflow`, ~50 Slack user scopes) make every tool work but scare users ("concerning data (DOB, exact street address)") and widen the blast radius. Request the union of what installed apps and enabled tools actually declare, and upgrade incrementally.

### 10.3 Build, integrate, or adopt an open-source engine?

| | (a) Composio as an optional connector backend | (b) Build on Cloudflare primitives | (c) Adopt an open-source engine |
|---|---|---|---|
| Where tokens and payloads live | Composio Cloud, US only (payloads 1 year unless paid ZDR; managed apps not covered by ZDR below Enterprise; breached May 2026). Enterprise self-host is Kubernetes + Knative, not Cloudflare | Customer's own D1/Secrets Store | Depends on the engine; most need Node or Python plus Postgres/Redis |
| Fit with MIT + self-hosted-on-Workers | Client SDK is MIT and runs on Workers (`nodejs_compat`; no file helpers on workerd); backend closed; each customer needs a Composio account and key | Full | Poor: Nango is ELv2 (no managed-service use), Pipedream is source-available with a no-competing-use clause, n8n is "Sustainable Use", Metorial is FSL-1.1 (Apache only after 2 years). MIT/Apache options are partial: Activepieces pieces (MIT outside `ee/`, Node), ACI.dev (Apache-2.0, Python, last push 2026-05-28), Klavis (Apache-2.0, Python, last push 2026-06-01), Executor (MIT, TypeScript; its v2 now competes with Every App). [live: `gh api` licenses] |
| Breadth on day one | 1,603 toolkits, 671 triggers (but only 123 with zero-setup OAuth) | Small: a few first-party connectors plus vendor MCP servers | Medium to large catalogs, but in a foreign runtime |
| Consent-screen branding | "Composio" unless BYO client (tokens still at Composio) | The customer's own app name | Varies |
| Lock-in | High: tokens not exportable via API; leaving means re-consenting users | None | Medium |
| Cost to the customer | Free to 100K calls/month, then $0.0003/call ($0.0005 on managed apps), $0.003/trigger event, security add-ons per call (section 7) | Workers usage only | Infra for the engine |
| Running it from the gateway Worker | Works, but #4207: ~40% of requests from Workers egress hit an undocumented per-IP 429 (confirmed, no fix deployed as of 2026-09) | Native | Usually not possible |
| Maintenance for Every App | Low for connectors, but must track Composio's breaking changes | High for each first-party connector (OAuth quirks, refresh races, webhooks) | High (fork/port) |

**Recommendation [inference]:**
- **Default to (b).** Build the vault, connect links, proxy fetch, events and ToolBus on Cloudflare primitives. Use `@cloudflare/workers-oauth-provider` (MIT) for the MCP OAuth server and the Agents SDK MCP client (MIT) to reach vendor MCP servers.
- **Offer (a) as an opt-in "long-tail connectors" adapter** behind the same ToolBus interface: off by default, labelled "connections and call data are stored by Composio", using the customer's own Composio API key. Composio documents exactly this shape ("Integrate Composio into an existing harness"):
  - Map Every App identities to Composio `user_id`s (`<orgId>:<userId>` for member connections, `<orgId>:org` for org ones).
  - Create sessions with `manageConnections: false` and the sandbox off; list and execute tools by slug.
  - Run Every App's own policy, approval and audit before every `session.execute()`.
  - Never hand Composio's session MCP URL and headers to clients: they carry a project-wide API key.
- **Don't adopt (c) wholesale.** At most, mine Apache/MIT definitions (ACI.dev function specs, Activepieces pieces) for OAuth endpoints and tool shapes, after a license review.

### 10.4 How "apps on top" would reuse connections [inference]

```
 Claude / ChatGPT / Cursor ──OAuth──► https://<gateway>/mcp  (ToolBus: search · schemas · execute · connections)
                                            │
            ┌───────────────────────────────┼─────────────────────────────────┐
            │ app tools (defineTools)       │ connector tools                 │ events
            ▼                               ▼                                 ▼
   todo / chef / crm Workers     first-party (Google, Slack, GitHub)    provider webhooks / polling
   (service binding + JWT)       vendor MCP servers (Linear, Notion…)   → Queue → subscribed app Workers
            │                    optional Composio adapter
            └── apps call GET/POST /api/connections/<provider>/… over the binding; the gateway injects the user's
                or org's token per manifest + admin ACL, applies the same policy, writes the same audit row
```

- Manifest sketch: `connections: [{ provider: "google", scopes: ["gmail.readonly"], owner: "member" | "org" | "either", optional: true }]`, beside the existing `providers: ["openai"]` (which becomes a gateway-owned "org" connection — the same idea as Composio's Instant tools running on Composio's own accounts).
- A third owner kind is worth reserving: **agent**. Composio's docs show Atomic Bot giving each background agent its own connections ("the connected account belongs to that agent, not to the whole account") so an unattended agent never stops for auth and can only reach what was connected for it [docs: https://docs.composio.dev/examples/three-agents-one-board]. For Every App this maps to a service identity per scheduled agent or app job.
- Consent (ToolBus OAuth) shows apps **and** connections, read vs write.
- An app installed from the store asks for the org's Google client on first use; members then connect once, and every app and every agent reuses that connection.

Term mapping:

| Composio | Every App equivalent (proposed) |
|---|---|
| Organization / Project | Org (one gateway can host several orgs); a "project" is unnecessary because each customer runs its own gateway |
| `user_id` (free-form string) | Better Auth user ID, always derived server-side from the session or identity JWT — never caller-supplied |
| Auth config (managed / custom) | `integration_clients` (org's own OAuth client; optional gateway-owned keys for API-key providers like OpenAI) |
| Connected account (PRIVATE / SHARED + ACL) | Account connection owned by a member, the org, or an agent identity; org ones carry an app + member ACL |
| Session + session config | ToolBus OAuth grant (org + apps + read/write snapshot) and saved, versioned policies |
| Meta tools | `everyapp_search_tools` / `get_schemas` / `execute` / `connections` (M3-7) |
| Proxy Execute | App → gateway `/api/connections/<provider>/…` over the service binding |
| Instant tools | Gateway-owned provider keys (today's OpenAI hoist; email and search in M4-8) |
| Triggers + webhook subscription | Provider webhook/poll → gateway → Queue → subscribed app Worker |
| Custom MCP toolkit (`CUSTOM_*`) | App tools via `defineTools()`, plus vendor MCP servers as a connection type |

### 10.5 Open questions to spike

1. Proxying vendor MCP servers per user. Feasibility is not the question: the Agents SDK MCP client already runs the OAuth flow (`addMcpServer()` returns `state: "authenticating"` with an `authUrl`), and "OAuth tokens are securely stored in SQLite and persist across agent restarts" (Durable Object storage) [live: https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-client.md]. The questions are routing (one DO per member per org?), applying ToolBus policy and audit to proxied tools, and classifying third-party tools into read/create/update/destructive at sync time, as Composio does. This decides how much breadth comes for free.
2. Refresh-token races: rotate-on-use providers (Microsoft, some OAuth 2.1 servers) need single-flight refresh. A Durable Object per connection, or a D1 lease?
3. Token encryption key custody: Workers Secrets vs Secrets Store vs a per-org envelope key. How do backups and restores of D1 interact with rotation?
4. Google Workspace admin steps for Internal apps using restricted scopes ("Let Internal apps access restricted Google Workspace APIs"): how much can a setup wizard check automatically?
5. For the optional Composio adapter: does one Every App org need its own Composio project (branding, webhooks and ZDR are per project), and can the gateway call Composio reliably from Workers egress given #4207's undocumented per-IP 429s? Cost is not the blocker (section 7).

---

## Caveats and things not verified

- Reddit, X/Twitter and G2 were not reachable (403 / blocked), so community sentiment is under-sampled; GitHub issues, HN and status history stand in for it.
- I did not sign up or call the authenticated API, so live MCP URL formats, search quality, auto-offload behavior, whether multi-execute bills per inner tool, and actual latency are unverified.
- The Trust Center (Vanta) didn't render; ISO 27001 appears only on marketing pages. Which Google scopes Composio's managed Google apps actually request (vs the catalog's defaults) is inferred, though GitHub #1887 shows Composio obtained Google approval for restricted and sensitive scopes for its own app.
- Cyera's "a read-only call returned Gmail tokens" test date is unclear relative to the June 2026 redaction.
- Headcount (about 25 vs 93 on LinkedIn) and any 2026 funding are unconfirmed.
- Whether the generated catalog data in the MIT repo (`toolkits.json`, meta-tool prompts) is really MIT-licensed is unclear.
- Items labelled "via sub-research" were read live today by research sub-agents; the most load-bearing ones (breach post, pricing, Rube notice, April incident, data residency, #4207, #1887, status history, CVEs, Mintlify/Hyperagent statements, homepage copy, MCP Gateway page) were re-fetched and checked by me.

## Sources

Most important (all fetched 2026-10-12):

1. Docs dump (primary source for sections 2–5): https://docs.composio.dev/llms-full.txt (index: https://docs.composio.dev/llms-index.txt)
2. Meta tools reference: https://docs.composio.dev/toolkits/meta-tools (and `/search_tools`, `/multi_execute_tool`, `/manage_connections`, `/get_tool_schemas`, `/remote_workbench`, `/remote_bash_tool`)
3. Session create API (all session settings incl. approvals): https://docs.composio.dev/reference/api-reference/tool-router/postToolRouterSession
4. Token custody, retention, ZDR: https://docs.composio.dev/docs/security/token-custody, https://docs.composio.dev/docs/security/data-retention, https://docs.composio.dev/docs/security/zero-data-retention
5. Auth: https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app, https://docs.composio.dev/docs/authentication/white-labeling-authentication, https://docs.composio.dev/docs/extending-sessions/shared-connections, https://docs.composio.dev/reference/api-reference/connected-accounts (callback identity verification)
6. Changelog: https://docs.composio.dev/docs/changelog (entries cited by date, e.g. https://docs.composio.dev/docs/changelog/2026/10/12)
7. Breach disclosure: https://composio.dev/blog/composio-may-2026-security-incident
8. Pricing: https://composio.dev/pricing (and `/pricing.md`)
9. MCP Gateway: https://composio.dev/mcp-gateway
10. Source: https://github.com/ComposioHQ/composio @ `8b07933f85856c2efa62273369609732455ed787`; Helm: https://github.com/ComposioHQ/helm-charts
11. Status history: https://status.composio.dev/history/1 … /6 and https://status.composio.dev/history.rss
12. Workers 429 issue: https://github.com/ComposioHQ/composio/issues/4207; CASA answer: https://github.com/ComposioHQ/composio/issues/1887

Other first-party: https://composio.dev, https://composio.dev/blog/introducing-tool-router-(beta), https://composio.dev/blog/incident-report-april-28, https://composio.dev/blog/two-questions-every-security-review-asks-us, https://composio.dev/blog/gpt-4-function-calling-example, https://www.rube.app, https://docs.composio.dev/docs/composio-connect, https://docs.composio.dev/docs/configuring-sessions, https://docs.composio.dev/docs/how-composio-works, https://docs.composio.dev/docs/sessions-via-mcp, https://docs.composio.dev/docs/sandbox/remote, https://docs.composio.dev/docs/instant-tools, https://docs.composio.dev/docs/skills, https://docs.composio.dev/docs/triggers, https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events, https://docs.composio.dev/docs/setting-up-triggers/custom-oauth-webhooks, https://docs.composio.dev/docs/extending-sessions/custom-tools-and-toolkits, https://docs.composio.dev/docs/extending-sessions/custom-mcp, https://docs.composio.dev/docs/extending-sessions/proxy-execute, https://docs.composio.dev/docs/b2b-agents, https://docs.composio.dev/examples/harness-integration, https://docs.composio.dev/examples/cloudflare-workers, https://docs.composio.dev/examples/general-agent-with-pi, https://docs.composio.dev/kb/guide/consumer-project-boundaries-and-auth-selection, https://docs.composio.dev/kb/guide/platform-self-hosted-helm, https://docs.composio.dev/reference/rate-limits, https://docs.composio.dev/toolkits/gmail, https://registry.npmjs.org/@composio%2fcore

Third party: https://material.security/resources/the-composio-breach-one-token-10242-doors, https://status.mintlify.com/incidents/01KSB1RZK85RJ71W4BYSDFGYH1, https://www.hyperagent.com/blog/composio-incident-response/, https://www.cyera.com/research/the-hidden-attack-surface-of-agentic-ai-securing-ai-agent-integration-platforms, https://usagepricing.com/blueprint/composio, https://news.ycombinator.com/item?id=47726969, https://api.osv.dev (CVE-2024-8954 etc.), PR Newswire Series A release, Forbes India profile (2026-01-22). Biased (competitors): https://www.arcade.dev/compare/arcade-vs-composio/, https://nango.dev/blog/composio-alternatives/, https://www.scalekit.com/blog/composio-alternatives

Google and Cloudflare: https://developers.google.com/identity/protocols/oauth2/production-readiness/overview ("Verification is not required" for Internal apps), https://support.google.com/cloud/answer/13463073 (annual re-verification for restricted scopes), https://support.google.com/cloud/answer/15549945 (Internal audience; restricted Workspace scopes may need admin configuration), https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest, https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-client.md

Licenses of alternative engines (`gh api`, 2026-10-12): NangoHQ/nango (ELv2), activepieces/activepieces (MIT outside `ee/`), PipedreamHQ/pipedream (Pipedream Source Available License), n8n-io/n8n (Sustainable Use License), metorial/metorial (FSL-1.1-ALv2), aipotheosis-labs/aci (Apache-2.0), Klavis-AI/klavis (Apache-2.0), ArcadeAI/arcade-mcp (MIT), UsefulSoftwareCo/executor (MIT), obot-platform/obot (MIT), IBM/mcp-context-forge (Apache-2.0), cloudflare/workers-oauth-provider (MIT), cloudflare/agents (MIT).

Local working copies (not committed, read only): `/tmp/everyapp-research-2/docs-fetch/` (docs dump, changelog entries, meta-tool pages), `/tmp/everyapp-research-2/composio/repo` (shallow clone), `/tmp/everyapp-research-2/composio-helm/values.yaml`, `/tmp/everyapp-research-2/site/` (raw page captures).
