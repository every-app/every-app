# DRAFT IN PROGRESS (lead sections written; group sections being merged)

## L1. Every App today: the baseline we are comparing against

- **Apps already declare a third-party dependency and the gateway already enforces it.** `apps/chef/everyapp.config.ts` declares `providers: ["openai"]`. [code]
- `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts` [code]:
  1. reads the caller's identity from the service binding's `props` (`organizationId`, `appId`, `workerName`), which the app cannot forge;
  2. checks it against the registry (app exists, `status === "active"`, identity matches);
  3. refuses with `provider_not_allowed` unless `app.manifest.providers?.includes(provider)`;
  4. attributes the call to the signed-in user when an identity JWT is present, otherwise to the app;
  5. proxies with the gateway-held key under the manifest's `ai` policy.
- `apps/every-app-gateway/src/server/ai-proxy.ts` [code] already encodes the rule a shared credential needs. The comment reads: "The one key is shared by every app in every organization ... any other endpoint would let one app read another's data or start expensive jobs. Apps get inference only ... More needs both the operator (AI_PROXY_EXTRA_ROUTES) and the app's manifest (`ai.routes`)". And: "an app's own `ai.routes` never widens what the shared key can do by itself." The manifest can also pin a model allowlist (`ai.models`).
- Roadmap [docs: `docs/research/2026-10-platform-review/ROADMAP.md`]:
  - "**Apps hold no keys.** AI, email and connections go through the gateway."
  - "Capabilities for apps: AI (via AI Gateway) · email · search · connections (Google, Slack)".
  - M4-8 "App capabilities v1: send email, web search; then Google connections" (10–15 days). M3-2 ToolBus (10–15 days).
  - **Naming clash:** M1-3 "Connections page for every member" means *MCP client tokens* (Claude Code/Cursor), while "connections (Google, Slack)" means *third-party accounts*. [inference] Pick two different nouns before building the hub.
- App store today: three real apps (todo, chef, workout tracker) installed with `npx gitpick … && npx everyapp app deploy`. [docs: README]

## L2. Cloudflare OS (update since 2026-10-04)

- Repo `cloudflare/cloudflare-os`: Apache-2.0, 11,371 stars, 1,364 forks, last push 2026-10-12 (was 10,775 stars on 10-04). [live: gh API]
- About 50 commits since 2026-10-03 [live: gh API commits]. The ones that matter here:
  - **Blueprints can now ship updates (#659, merged 2026-10-05).** "When you update a blueprint, people who have created gadgets from the old blueprint are now given the option to update it ... If local changes have been made since the blueprint was first instantiated, an agent is spawned to review the merge and fix any conflicts." Users can also switch to "some other user's customized version". Not automatic yet.
  - **New connections ("gatekeepers"):** GitLab (#531, 10-07), X (#721, 10-12). Event hooks for Gmail (#696), Google Chat (#681) and GitHub (#717, 10-12; repo webhooks, signature-checked, replay-protected, re-checks read access per delivery).
  - **Google Workspace writes with approval:** Docs/Sheets/Slides edits, tab and row changes, formatting (#699, #709, #714, #716, #723–#725).
  - **"Let the agent create new external resources" (#694, 10-09):** nothing is created at the provider until someone approves; "Accounts are per user", so the resource is created in the approver's account.
  - **Slack org-wide installs (#719, 10-10):** keeps "using the connecting user's token, never the bot token"; "Installation identity is not workspace authority."
  - **Native app sign-in handoff (#712, 10-11)**, referencing a TestFlight build.
- Bundled blueprints are only three "output formats": `workspace-docs`, `workspace-sheets`, `workspace-slides`. [live: gh API `packages/bundled-blueprints/blueprints`] There is no gallery of business apps; gadgets are agent-built.
- **Managed CF OS:** still a waitlist. The 2026-10-01 post says customers pick a custom domain, Access policies and AI Gateway, and decide "which systems it can reach"; it gives no price or date. [live: blog.cloudflare.com/managed-cloudflare-os/] Secondary coverage also finds no price or launch date. [press: rohitai.com]
- **Connection model (from prior review + new PRs):** admins configure one OAuth client per gatekeeper Worker. Each user connects their own account; shared gadgets make each viewer bind their own account (observers). Capabilities are per resource. Reads are logged; writes are queued for approval. CF OS consumes MCP but does not expose one. [prior report + live PRs]
- **Related Cloudflare news since 10-04:**
  - **Web Search API via AI Gateway (2026-10-02):** `env.AI.websearch()` binding or REST; partners Ceramic.ai, Exa, Linkup; "web search queries draw down from your AI Gateway credit balance"; BYOK supported; list pricing "without any additional markup". [live: blog.cloudflare.com/introducing-web-search-api/] This can back Every App's planned "web search" capability almost directly.
  - **EmDash CMS plugin registry (2026-09-28, MIT):** plugins "gain additional abilities only when they are declared by the plugin and approved by the site administrator"; each plugin runs as a Dynamic Worker; the registry is decentralized (AT Protocol, publisher-signed releases). [live: blog.cloudflare.com/emdash-cms-plugin-registry] Cloudflare's own template for an open, signed, capability-declaring app store.
  - **Deno joining Cloudflare (2026-10-09):** the goal is to "radically simplify self-hosting Workers and Durable Objects" by merging Deno's celld into workerd. [live: blog.cloudflare.com/deno-joins-cloudflare/] Over time this widens the "runs in your own infrastructure" story for Workers-based apps like Every App.

## L3. Executor v2 (placement only; another researcher covers updates)

- Releases continue: `executor@2.0.0-beta.9` … `beta.15` between 2026-10-06 and 2026-10-11. Repo: MIT, 4,160 stars. [live: gh API]
- Homepage today: "Everything you use, connected in one place."; "your agents' cloud"; "Each account is connected once through a secure sign-in link, so credentials stay out of chat and code. Connected accounts become available to every agent the user runs."; Cloud option: "Deploy your apps. We handle the hosting." No gallery or marketplace on the page. [live: executor.sh]
- Model (from prior review, v2 branch): apps declare "providers"; accounts are connected once and reused; personal vs shared accounts with per-member offers; "Management access does not grant use of the credentials"; credential handles swapped in by an egress Worker only for declared hosts; one `/mcp` endpoint with code mode and per-app grants; self-host is one Docker container; a "Publication / Public app installation" concept exists, but no curated catalog. [prior report]
- **The founder's read holds** [inference]: Executor is converging on "connect once + apps + one MCP endpoint", but its apps are small programs on Executor's runtime and data layer, hosted by Executor or in a Docker box, and there is no open-source catalog of real, maintained apps.

## L4. Big tech and other 2026 entrants

### Microsoft: Power Apps code apps and Copilot Managed Runtime (the closest structural analog to Every App)

- **Power Apps code apps** [live: learn.microsoft.com/power-apps/developer/code-apps/overview, updated 2026-09-23]:
  - Code-first React/Vue SPAs from VS Code, hosted in Power Platform.
  - "Access to Power Platform data sources and 1,500+ connectors, callable directly from JavaScript".
  - "Adherence to your organization's Managed Platform policies (app sharing limits, Conditional Access, Data Loss Prevention, and so on)". Table: "End-users see consent dialog for connector permissions"; "Data Loss policy enforcement during app launch".
  - End users need Power Apps Premium (or pay-as-you-go / App Pass).
- **How an app declares connections** [live: …/code-apps/how-to/connect-to-data, updated 2026-10-02]:
  - `pa app add data-source --connector <id> --connection-id <id>` generates typed `…Model.ts`/`…Service.ts` files.
  - Connection references: "Instead of binding your app directly to a user-specific connection, bind it to a reference. This approach makes the solution environment-aware and portable across Dev, Test, and Prod".
- **Copilot Managed Runtime (preview)** [live: learn.microsoft.com/microsoft-365/managed-apps/ (2026-09-25), …/admin/manage/apps/ (2026-10-07), …/managed-apps/developer/ (2026-09-29)]:
  - It "hosts Microsoft 365 line-of-business applications that automatically inherit organizational governance, security, and compliance controls from the moment they're created."
  - Three ways to build: chat in Copilot Cowork, makers in Copilot Studio, or "the Copilot Managed Runtime SDK and CLI" (`@microsoft/managed-apps`, `ms` CLI) "manually or with the coding agent plugin" (a Claude Code / GitHub Copilot plugin).
  - All three "inherit your tenant's default governance policy (approved connectors, sharing rules, content security policy)".
  - One user portal: `managedapps.cloud.microsoft`. Admins get an "App inventory", usage analytics, health and lifecycle in the M365 admin center.
  - Pricing: Power Apps Premium covers runtime. Otherwise, "Credits are charged each time an app launches and for each API call. Each API call consumes 0.1 credits." Building in Cowork or Copilot Studio also consumes Copilot Credits.
  - Repo `microsoft/managed-apps` (MIT, 25 stars, created 2026-05-15) holds one template (`vite8`) and the agent plugin. [live: gh API]
- **Shared connections need app-declared `allowedActions`** [code: `microsoft/managed-apps` `plugins/microsoft-managed-apps/shared/allowed-actions.md`, commit a069a3a, 2026-10-10]:
  - "A shared connection is exactly that — shared. The same connection can back several apps, and it carries whatever permissions the person who created it has. Left unrestricted, any app holding the reference could perform any operation that connection allows: an app that only needs to read a list could delete from it."
  - "A shared connection is limited to the operations the app declares in its config, and that limit is enforced **per app** by the Connectors infrastructure. Two apps sharing one connection get two independent policies".
  - "Enforcement lives in the **Connectors infrastructure**, not in the app ... APIHub runs every connector request through the runtime policy" and "app code never changes".
  - `ms app pack` / `ms app deploy` "fail the deploy" when a shared reference lacks `allowedActions`.
  - The agent skill `/list-connectors` shows connectors "blocked or allowed by your organization".
- **AI building:** Cowork's "App (Frontier)" skill can "generate a data schema in supported connectors and build an app with the data sources connected and ready to use". Shared apps run with each user's permissions. [live: learn.microsoft.com/microsoft-365/copilot/cowork/use-cowork, 2026-09-14] Message center MC1469329: Cowork rollout 2026-09-08 to 09-14; apps "follow existing connector, environment, data, security, compliance, and sharing policies". [press mirror: mc.merill.net] The older Power Apps "vibe" preview now says: "App building is now available in Copilot Cowork and will soon roll out to Microsoft Copilot Studio. We recommend using these experiences moving forward." [live: learn.microsoft.com/power-apps/vibe/overview, 2026-09-08]
- **MCP:** Dataverse MCP server GA 2025-12-15 for Copilot Studio, VS Code and Claude Desktop, per MC1187276 [press mirror]. Copilot Studio consumes MCP (GA) [press: Microsoft blog via search]. I found no single MCP endpoint that exposes a tenant's Managed Runtime apps to outside agents. [inference; not verified]

### OpenAI
- ChatGPT "connectors" were renamed "apps" on 2025-12-17. [press: stackone.com] In Business/Enterprise, only Admins/Owners publish custom MCP apps, and Enterprise/Edu can use RBAC to choose who can access each app. [help.openai.com via search snippet; the page returned 403 to direct fetch]
- **Workspace agents (2026-04-22):** "build once, share in your workspace", Codex-powered and cloud-run, on schedules, @-mentions or Slack triggers. "Admins control who can build, publish, and run agents; which connectors each can access" and which "write actions ... require human approval". Credit-priced after 2026-05-06. [press: theneuron.ai; openai.com returned 403]
- **Agent Builder is being wound down:** "Update on June 3, 2026: OpenAI is winding down the Agent Builder and Evals products. From November 30, 2026 onward, they will no longer be available". OpenAI recommends the Agents SDK or Workspace Agents. [openai.com/index/introducing-agentkit via search snippet; direct fetch 403] The Connector Registry (beta, Oct 2025) has no confirmed GA. [not verified]
- ChatGPT is a *client*: it consumes MCP and does not expose a workspace's agents to other agents. [inference]

### Anthropic (Claude)
- Org connectors [live: support.claude.com/en/articles/11176164]: "an Owner or Primary Owner needs to enable them for the organization"; "Enabling a connector makes it available to your team, but it doesn't automatically grant anyone access"; "Each person still needs to authenticate individually"; "Access permissions are enforced at the user level"; Owners "can limit which actions a connected service can take across your organization" (for example read-only).
- Org-wide authorization through the IdP [live: support.claude.com/en/articles/15537633, dated 2026-08-24, "generally available"]: "you authorize a connector once for your entire organization" and members inherit access on first login through IdP groups and roles (Okta at launch). Admins choose connectors per role, narrow permissions, and can require IdP-only connections.
- **Artifacts became small hosted apps that use the viewer's own connectors** [live: code.claude.com/docs/en/whats-new]:
  - Week 25 (June 15–19, 2026): "Artifacts: turn a session's output into a live, shareable page on claude.ai ... in beta on Team and Enterprise plans."
  - Week 29 (July 13–17, 2026): "a published artifact can pull live data and take actions through each viewer's own MCP connectors when they open the page", plus public share links and editor roles on Team/Enterprise.
  - Public artifacts cannot use connectors. [press: remio.ai]

### Google
- **Gemini Enterprise Agent Gallery** has "Made by Google", "From your organization" and "Your agents". Marketplace partner agents need admin approval. [live: docs.cloud.google.com/gemini/enterprise/docs/agent-gallery, updated 2026-10-09] Agent Designer GA 2026-01-12. [docs: release notes via search snippet]
- **Connectors:** admins set up data stores and OAuth apps once. Actions run under each user's own authorization; for ServiceNow, "the first time a user asks for a ServiceNow action, the assistant prompts that user to authorize their own ServiceNow account". "The mutative action toggle operates at the connector level" (all writes or none). [docs via search snippets of docs.cloud.google.com]
- Opal (mini-apps) is still experimental. [press] AppSheet was not re-checked.

### Salesforce, Atlassian, Dust (short)
- **Salesforce Named/External Credentials** are the most mature "declare and grant" model in enterprise software [docs via search snippets; help.salesforce.com and developer.salesforce.com blocked direct fetch]:
  - "A named principal applies the same credential ... for the entire org, while per-user authentication provides access control at the individual user level".
  - Access is granted by linking principals to permission sets: "the platform ensures that the user has the permission set before accessing the remote system."
  - Agentforce Vibes 2.0 (AI coding for Salesforce apps) went GA 2026-06-12 with platform-hosted MCP servers and per-tool permission controls. [docs via search snippet]
- **Atlassian Rovo MCP server GA (2026-02-04):** one way for "AWS, ChatGPT, Claude, Cursor" and others to reach Jira/Confluence. Admins pick which MCP clients may connect, with audit logs. [live: atlassian.com/blog/announcements/atlassian-rovo-mcp-ga] This is a "one MCP front door" to a workspace's data, not to apps.
- **Dust** (repo MIT, 1,484 stars [live: gh]):
  - For tools, admins choose "workspace credentials" (one admin authorizes for everyone who can use the tool) or "personal credentials" (each user authorizes on first use).
  - The Dust MCP server lets outside clients act as the Dust user via OAuth, and admins can disable it. [docs.dust.tt via search snippets]

## L5. Self-hosted app stores and open-source suites of real apps (the precedent for dimension 4)

| Project | What it is | Evidence [live unless noted] |
|---|---|---|
| **Frappe** (framework MIT 10.9k★; CRM AGPL 3.8k★; Helpdesk AGPL 3.4k★) | One framework, many maintained business apps sharing users, roles and permissions on one "site"; Frappe Cloud hosts them, or you self-host. | Frappe Cloud Marketplace: "Showing 372 apps". ERPNext 96.1k installs, Payments 31.5k, Insights 31.5k, CRM 39.8k. Only community MCP servers (e.g. `frappe-crm-mcp` 0.0.6) [press/search]. |
| **Odoo** (55k★, LGPL community + paid enterprise) | Integrated suite of business apps; Odoo 19 (Sept 2025) added AI agents. | 12M+ users [press]; core is "60+ integrated modules" [press]. Not re-verified. |
| **Cloudron** | Installs packaged OSS apps on your own server; one user directory; admins choose which apps each person can access. | "Thousands of organizations use Cloudron"; app store publishes "the latest releases within days and security fixes within 24h". No AI/MCP. |
| **Umbrel** | Home-server OS with an app store. | "over 300 apps in the Umbrel App Store" (repo description). |
| **Sandstorm** (2014–2017 company; now community) | Self-hosted app platform with an app market, strong per-document sandboxing and capability grants. | "almost no one has purchased Sandstorm for Work, despite hundreds of trials"; causes named: "As a product, Sandstorm is still alpha-quality" and "We underestimated, in classic fashion, the challenge of enterprise sales." (Kenton Varda, 2017-02-06) |
| **EmDash** (Cloudflare, MIT, 2026-09-28) | CMS with a decentralized, signed plugin registry; plugins declare abilities that admins approve. | See L2. |
| **Twenty** (58k★) | Open-source CRM "designed for AI". | A candidate "real app" for an app store; license not checked (GitHub shows NOASSERTION). |

[inference] Real, maintained apps clearly drive installs in this group: Frappe's own CRM, Helpdesk and ERP account for most installs, and Cloudron's paid value is *maintenance*, not the first install. The precedent is an app suite with shared identity plus a hosted option. AI app builders don't fit this pattern. Sandstorm shows that security and an app market don't sell on their own: it failed on product maturity and enterprise sales, not on the app model.

## G-A. Retool and Superblocks (merged from sub-research; spot-checked)

### Retool
- **Now:** homepage "Secure your vibe-coded apps", a prompt box, "Trusted by 10,000+ teams to generate production-ready AI applications", and a banner for the agent harness. [live: retool.com] Timeline:
  - New AI app builder producing React apps (beta, changelog 2026-05-28). [docs]
  - 2026-06-17 newsroom: governance for vibe-coded apps, imports from Lovable/Replit, building from Claude Code/Cursor via MCP. [live]
  - CLI public beta 2026-09-24.
  - "Centralized agent harness" early access 2026-10-06: tool calls go through "a gateway the company controls" and it "can be deployed on-prem to your own VPC". [live: retool.com/blog/introducing-agent-harness]
  - Assist (Oct 2025) is "deprecated". [docs]
- **Connections = Resources:**
  - "Resources are org-global." [docs] Each resource has three levels: **Use** ("Run queries against the resource from within apps"), **Edit** (queries) and **Own** ("edit the resource configuration"), granted to groups or folders, *per environment*. "There is no overall resource permission that acts as a default across environments." [docs: permissions/reference/permission-levels; resource-permissions]
  - On Free/Team, All Users get Own; on Business/Enterprise, admins control it. [docs]
  - OAuth is per user unless "**Share OAuth2.0 credentials between users**" is enabled. [docs: authentication/api]
  - Access policies (rows/columns per group) govern "every query Retool runs against the resource, including queries from apps, the query library, raw SQL, and agents". [docs]
- **Consumption:**
  - "Retool proxies all HTTP requests through the backend." Functions are server-side TypeScript. Secret config variables are "never exposed on the frontend". [docs]
  - The builder agent only uses resources the builder can Edit. Every write function must be approved before publish. [docs]
  - There is no per-app grant; access is per user or group. [inference from docs]
  - Agents need agent Use ∩ resource Use. A per-tool "Require user confirmation" setting is "separate from access control". Agent templates bind each tool to an existing resource at creation ("Apply to all tools that need this type of resource"). [docs]
- **MCP:**
  - One endpoint per instance, `https://<instance>/mcp`, with OAuth 2.0 (self-hosted needs ≥4.0.0). [live, verified: docs.retool.com/org-users/guides/mcp.md]
  - Scopes `mcp:read`/`mcp:write`/`mcp:admin`; "You cannot be granted a scope for more permissions than your Retool account permits." [live, verified: …/build/apps/reference/mcp-tools.md]
  - Tools cover app building, admin, and resources, including `retool_execute_resource_ts` ("Execute a TypeScript snippet against selected resources"). Workflows can only be listed, read or deleted, and there is **no tool that runs an app's own actions**. [verified]
  - Retool also consumes MCP: with OAuth, each user authenticates; with a bearer token, it's shared. [docs]
- **Templates:**
  - About 370 template pages. Each CTA is now "Generate this app in Retool", so a template is a prompt seed. [live: retool.com/templates/custom-crm]
  - "Real apps built in Retool" gallery: 17 demo apps on "demo data" with no install button. [live: retool.com/app-gallery]
  - The open-source Retool App Exchange stalled (~7 apps; last addition April 2023; last push 2024-10-10). [code: tryretool/retool-app-exchange]
- **Runs:** Retool Cloud; self-hosted Docker/Kubernetes on every tier (Team/Business capped at 100 users); "Retool-managed" in the customer's own AWS VPC (GA Oct 2025). [docs/live]
- **Pricing:**
  - Builder seats $10 (Team) / $50 (Business) per month annual; internal users $5 / $15.
  - AI credits; Agents billed per hour ("$50 of free agents usage", "up to 20 hours").
  - [live: retool.com/pricing; docs]
- **Open source:** no (deployment tooling only).

### Superblocks
- **Now:**
  - "Vibe Code Business Apps / Protect Your Data … AI Apps Never Access Business Systems Directly. Superblocks is your integration control layer — enforcing API and MCP authentication, inheriting access controls, abstracting secrets, and auditing every interaction." [live: superblocks.com]
  - Clark announced 2025-05-27 ($23M; $60M total raised). [live] Clark GA 2026-03-06; "We recommend building all new applications with Clark". [docs]
  - Superblocks 3.0 with AWS (VPC deployment, Bedrock, security agents) 2026-08-03. [live]
- **Connections = Integrations:**
  - "a reusable, centrally managed connection … provide connection details and authentication credentials once". [docs]
  - Roles: **Admin** (update credentials) vs **Developer** ("Use integrations in APIs"); new integrations default to "No access". [docs]
  - **Per-app availability**: "**All apps** … available across the organization to users who have access to it" or "**Specific apps** … only available to the apps you select". [live, verified]
  - "Sharing an integration with an app does not give that app's builders permission to build with that integration". [verified]
  - "A user does not need access to a specific integration in order to use the integration as an end-user of an application." [verified: docs.superblocks.com/admin/org-administration/resource-roles/manage-access.md]
  - Auth options: per-user OAuth, shared token, On-Behalf-Of token exchange (reuses the SSO token), client credentials.
  - Secrets "can only be referenced in integration forms … can't be referenced in any application code directly". [docs]
- **Consumption:**
  - Backend TypeScript APIs call `ctx.integrations.<name>`. `ctx.user` "can't be modified by the end user". [docs]
  - The data plane proxies requests; OAuth tokens are "never directly exposed to end-users". [docs]
  - Imports from Lovable/Replit/v0/Claude are rewritten so that "Hardcoded API keys and secrets" become "Credentials managed by the platform". [docs]
- **MCP:**
  - Admin MCP at `https://{tenant}.superblocks.com/mcp` with a personal bearer token (Enterprise): deploy apps, manage integrations, audit. [docs]
  - "Superblocks in Claude" (beta): build and publish apps from Claude.
  - No runtime tools for external agents.
- **Templates:** none; `/templates` returns 404. The on-ramp is prompt-first plus imports. [live]
- **Runs:** Cloud; **Hybrid** with a data plane ("On-Premise Agent") in the customer's VPC; **Cloud-Prem** with the whole platform in the customer's AWS. Hybrid caveats: Edit-environment data and OAuth tokens still go to Superblocks Cloud. [docs]
- **Pricing:** Teams $100/mo annual (100 "Governed Agent Units", 1 hosted app at +$10/app/mo, unlimited end users). Enterprise: a commit plus a monthly fee per published app. [live: superblocks.com/pricing]
- **Open source:** no.

## DRAFT (b) evidence so far
| Platform | What the front door emphasizes | Templates / store | Evidence of adoption effect |
|---|---|---|---|
| Retool | Prompt box ("Write a prompt, use @ to include data") | ~370 template pages → "Generate this app in Retool"; 17-app demo gallery; OSS App Exchange stalled | None published |
| Superblocks | Prompt box + imports | None (404) | Customer counts of AI-built apps (Cvent "100+") |
| Microsoft CMR / code apps | Chat (Cowork), maker (Copilot Studio), CLI + coding agent | 1 template (`vite8`); 7 samples + 2 templates for code apps | n/a |
| Cloudflare OS | Agent chat builds gadgets | 3 bundled "output formats"; blueprints shareable and (since 10-05) updatable with agent merge | "thousands of organizations" (OSS, unverified) |
| Executor v2 | Agent writes apps via MCP | Publish/copy snapshots; "no public version catalog"; updates "coming later" | n/a |
| Frappe | App installs onto a site | 372 marketplace apps | ERPNext 96.1k installs, CRM 39.8k, Insights 31.5k |
| Cloudron / Umbrel | App store installs | Umbrel "over 300 apps"; Cloudron updates "within days … security fixes within 24h" | "Thousands of organizations use Cloudron" |
