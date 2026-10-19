# Which integrations to build first, and what code we can reuse

Date: 2026-10-12 · Companion to [`README.md`](./README.md). License and contents were checked with the GitHub API today; popularity orderings were fetched live from composio.dev/toolkits, zapier.com/apps and n8n.io/integrations.

## 1. Can we reuse open-source integration code?

**Yes, a lot of it. But no permissively licensed project gives us drop-in integrations for Workers.** We'll still write a thin "provider pack" per integration, porting API code and tool definitions from the sources below.

### Safe to copy into an MIT project

| Source | License (checked 2026-10-12) | What's there | How to use it |
|---|---|---|---|
| **cloudflare/cloudflare-os** "gatekeepers" | Apache-2.0 · 11.4k★ · active | Workers-native integrations for **Google** (Drive, Gmail, Calendar, Sheets, Docs, Slides, Chat, BigQuery), **Slack**, **GitHub**, GitLab, Linear, Notion, Confluence, X, Supabase, Cloudflare. No Node dependencies; plain `fetch` with auth retry. `gatekeeper-kit` has an OAuth client, single-flight refresh, connect pages, credential expiry and a hook-delivery queue. | **Best source of Workers-ready API code.** Lift the API layers (`drive-api.ts`, `calendar-api.ts`, `slack-api.ts`, `github-api.ts`, `auth-retry.ts`) and kit primitives. The tool layer is tied to CF OS's capability model (Cap'n Web RPC, observers), so rewrite that part in our `defineTools()` shape. Keep the Apache-2.0 license text and mark changed files. |
| **activepieces/activepieces** pieces | MIT for everything outside `packages/ee` and `…/app/ee` · 25k★ · active | 737 community pieces, including Gmail (36 actions, 5 triggers), Google Calendar (25/7), Google Sheets (~60/5), Google Drive (triggers + actions), Slack (~80/14), Discord (~60/2), GitHub (~18), Notion (~37/4), HubSpot, Jira, Microsoft Outlook/Teams/OneDrive/Excel, Linear, Airtable, Stripe, Telegram. | **Best catalog of which actions to offer**, with descriptions, input schemas, AI-oriented variants and triggers. Most Google/Slack pieces call Node SDKs (`@googleapis/*`, `google-auth-library`, `@slack/web-api`, `nodemailer`), so port the logic to `fetch`. Discord's piece already uses the fetch-based HTTP client and ports quickly. |
| **UsefulSoftwareCo/executor** (v1, `main`) | MIT · 4.2k★ | TypeScript generators that turn **Google Discovery documents** and **Microsoft Graph** OpenAPI into tools (`packages/plugins/openapi/src/providers/google/discovery.ts`, `…/microsoft/{graph,presets,slices}.ts`). Also OAuth discovery and MCP proxy plugins. | The long tail for Google and Microsoft: generate read tools from the specs instead of hand-writing them. Later phase. |
| **googleworkspace/cli** (`gws`) | Apache-2.0 · 31k★ | Google Workspace CLI built from Discovery docs, plus **95 agent skills** (`SKILL.md`): gmail-triage, calendar-agenda, meeting-prep, standup-report, weekly-digest, email-to-task and about 50 "recipes". | Reuse the skills as agent guidance served next to our Google tools (how-to docs behind a skills tool). The Rust code itself isn't Workers-usable. |
| **github/github-mcp-server** | MIT · 33.6k★ | GitHub's official MCP server (Go). The same tools are hosted at `api.githubcopilot.com/mcp/`. | Don't port. **Proxy the hosted server** with the customer's GitHub App token. Use the repo as a reference for tool names and read-only/lockdown headers. |
| **taylorwilsdon/google_workspace_mcp** | MIT · 3.3k★ · active | Well-maintained Python MCP server for Gmail, Drive, Docs, Sheets, Calendar, Chat, Forms, Slides, Tasks. | Reference for tool design and scopes. Python, so not copyable to Workers. |
| **discord/cloudflare-sample-app** | MIT | Official Discord sample: slash-command interactions on Cloudflare Workers (signature verification, routing). | Template for Discord interactions/webhooks on Workers. |
| **makenotion/notion-mcp-server**, **stripe/ai** | MIT | Official MCP servers and toolkits. | Prefer the vendors' hosted MCP servers; read these for reference. |
| Catalog data: **UsefulSoftwareCo/integrations** (integrations.sh), **amp-labs/connectors**, APIs.guru, Better Auth social providers | MIT / MIT / CC0 / MIT | OAuth endpoints, scopes, auth kinds, MCP endpoints for hundreds to thousands of providers. | Seed provider configs and the "Quick Add" catalog. |
| Klavis-AI/klavis, aipotheosis-labs/aci | Apache-2.0 | 100+ MCP servers (Klavis) and 600+ JSON tool definitions (ACI). Both companies pivoted; repos stale since mid-2026; mostly Python. | Reference only. |

### Don't copy

n8n nodes (Sustainable Use License), Nango's `providers.yaml` (ELv2), Pipedream components (source-available, no competing use), Windmill, Gram and Archestra (AGPL), Metorial (FSL), Pica CE (GPL). Composio's tool definitions live on its closed backend; only its SDK is MIT.

### The realistic split

| Kind of integration | Example | Work for us |
|---|---|---|
| Vendor runs an official remote MCP server that lets any client register itself | Linear, Notion, Sentry, Stripe, Atlassian (after admin allowlist), Airtable, Supabase, Cloudflare | **None per vendor** once the gateway's generic upstream-MCP client exists (Quick Add). Needs the CIMD spike to confirm. |
| Vendor runs an official MCP server but needs a registered app | GitHub (GitHub App), Slack (internal app) | A setup flow (GitHub App manifest, Slack app manifest) plus proxying their hosted server. Small. |
| No usable hosted MCP | Google Workspace (its MCP is Developer Preview), Discord, Telegram, Microsoft 365 | A provider pack with curated tools, ported from Cloudflare OS / Activepieces. Medium to large. |

## 2. Demand signals (live, 2026-10-12)

| Rank | Composio "Popularity" | Zapier "Popular apps" | n8n "Sort: Popularity" |
|---|---|---|---|
| 1 | Gmail | Google Sheets | Google Sheets |
| 2 | Google Calendar | Gmail | AI Agent (built-in) |
| 3 | Google Drive | Slack | HTTP Request (built-in) |
| 4 | Outlook | Google Calendar | Gmail |
| 5 | Twitter/X | Google Drive | OpenAI |
| 6 | Google Sheets | HubSpot | Slack |
| 7 | Supabase | Facebook Lead Ads | Telegram |
| 8 | Notion | Google Forms | Google Gemini |
| 9 | Slack | Notion | Anthropic |
| 10 | Airtable | Mailchimp | Airtable |
| 11–30 (selected) | Google Docs, HubSpot, Asana, Linear (#19), **GitHub (#20)**, Teams, Salesforce, Jira, search tools (Firecrawl, Tavily, Exa, Serpapi) | Stripe, Outlook, Calendly, Airtable, Google Docs, Salesforce, monday.com | Google Drive (#11), Excel 365, Notion, Supabase, **Discord (#16)**, Postgres, **GitHub (#22)**, Google Calendar (#23), HubSpot |

Reading:
- Google Workspace dominates all three lists.
- Slack is top 10 everywhere.
- Notion and Airtable recur.
- Outlook/Microsoft matters for Microsoft shops.
- GitHub ranks lower on these lists, which skew to no-code and marketing users. It matters more for Every App's engineering audience.
- Discord and Telegram show up only on n8n, where personal and community automations are common. Every App's personal-software users look more like n8n's.

## 3. Recommended order

Sizes are rough guesses with coding agents, assuming the Connections core (tables, encryption, refresh lock, connect flow, settings pages) already exists.

### Wave 1: build first

1. **Google Workspace: one pack, one OAuth client, staged scopes.**
   - **Why:** #1 demand everywhere.
   - **First slice:**
     - Drive: search, read, export Docs and Sheets as text.
     - Calendar: agenda, free/busy, create event.
     - Sheets: read, append.
     - Gmail: search, read, create draft.
   - **Sending:** Gmail send comes later and requires approval. Drafts-only is a strong safe default.
   - **Setup:**
     - Companies: guided wizard for an *Internal* client in the customer's Google Cloud project. No Google verification, even for restricted Gmail/Drive scopes.
     - Personal @gmail.com installs: an *External* app set to "In production". Users see Google's unverified-app warning, and there's a 100-user lifetime cap. Never leave it in Testing, where refresh tokens expire after 7 days.
   - **Port from:** Cloudflare OS `gatekeeper-google` (API layer); Activepieces Gmail/Calendar/Sheets/Drive (action catalog); `gws` skills (agent guidance).
   - **Size:** L (about 1.5–3 weeks).
2. **Slack.**
   - **Why:** top 10 everywhere, and the hub of company chat-ops.
   - **Setup:** a prefilled internal-app manifest link. Internal apps skip Slack review and its 2025 rate-limit cuts.
   - **First slice:** search messages, read channel or thread, post message, DM (posting to channels needs approval once approvals exist).
   - **Later:** events (mentions, DMs) as triggers.
   - **Option:** proxy Slack's hosted MCP server (allowed for internal apps) instead of curated tools.
   - **Port from:** Cloudflare OS `gatekeeper-slack`; Activepieces Slack.
   - **Size:** M (about 3–6 days).
3. **GitHub.**
   - **Why:** Every App's users are engineers, and it's cheap.
   - **Setup:** a GitHub App created by the manifest flow (about one click; an org owner installs it).
   - **Tools:** proxy GitHub's hosted MCP server, read-only by default.
   - **Later:** webhooks for triggers (one app-level URL).
   - **Size:** S–M (about 2–4 days).
4. **Quick Add for vendor MCP servers.**
   - **Why:** it covers Notion, Linear, Atlassian (Jira/Confluence), Airtable, Supabase, Sentry, Stripe and Cloudflare with no per-vendor code.
   - **What it involves:** the generic upstream-MCP client (CIMD first, then DCR), catalog pinning and diffing, and treating unannotated tools as writes.
   - **Prerequisite:** the 1–2 day CIMD spike decides whether this works with zero setup.
   - **Size:** M, once.

### Wave 2: cheap wins for personal and community use

5. **Discord.**
   - **Setup:** a bot token (the customer creates an application in Discord's developer portal and invites the bot). Discord user OAuth can't read server messages, so the integration is a bot.
   - **Tools:** list channels, read recent messages, post, reply in thread.
   - **Triggers:** interactions via the Discord Workers sample.
   - **Message Content intent:** privileged, but a bot in fewer than 100 servers can turn it on without review.
   - **Port from:** the Activepieces Discord piece (already fetch-based). Discord has no official MCP server; community servers share one bot identity.
   - **Size:** S (about 2–3 days).
6. **Telegram.**
   - **Setup:** a bot token from BotFather.
   - **Why:** #7 on n8n; good for personal assistants.
   - **Size:** S.

### Wave 3: when customers ask

7. **Microsoft 365** (Outlook, Teams, OneDrive/SharePoint, Excel).
   - **Setup:** a single-tenant Entra app.
   - **Tools:** generated from Executor's MIT Graph slices plus curated tools ported from Activepieces.
   - **Size:** L.
   - **When:** the first Microsoft-shop customer.
8. **CRM: HubSpot, then Salesforce.**
   - **When:** the app store gets a CRM or sales app.
   - **Setup:** HubSpot's hosted MCP needs a registered client.
9. **Long tail.** Executor-style generators for Google Discovery and Microsoft Graph, and "bring your own aggregator" (a Composio/Pipedream/Zapier MCP URL as one upstream).

### Built-ins that agents use as much as integrations

- **Web search:** Cloudflare Web Search API via AI Gateway (`env.AI.websearch()`, 2026-10-02). Composio's popular list includes Firecrawl, Tavily, Exa and Serpapi.
- **Email sending:** already planned.
- **Fetch/scrape a URL.**
- **The org's own Every App apps** through ToolBus.

## 4. What a "provider pack" contains

So effort is comparable across integrations, each pack is:
- auth config (OAuth URLs, scopes split into read/write, or token paste);
- a setup flow (manifest link, console checklist, or CIMD);
- an identity lookup for the account label;
- API hosts for the app egress proxy;
- 8–20 curated tools with risk tags (read / write / destructive) and agent-oriented descriptions;
- revoke;
- later, triggers.

Cloudflare OS and Activepieces cover most of the API code and tool lists. Our own work is the setup UX, the risk tagging, and fitting tools into ToolBus.
