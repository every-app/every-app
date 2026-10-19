# Executor update: what changed since 2026-10-04, and what it means for Every App

- Researched: 2026-10-12. Everything marked [live] was fetched on 2026-10-12.
- Baseline: `docs/research/2026-10-platform-review/raw/ref-executor.md`, the deep read from 2026-10-04 (v1 `main` @ `98d606b`, v2 @ `828a680`). This file does not repeat that read. It covers only what changed and the strategic questions.
- What I read:
  - **v2 branch** at `9c0f2eb` ("Export 2e44551", 2026-10-12 17:22 UTC). That is 306 commits after `828a680`. I diffed the two trees: 1,807 files changed (507 added, 1,255 modified, 45 deleted). Shallow clones: `/tmp/everyapp-research-2/executor-v2` (today) and `/tmp/everyapp-research-2/executor-v2-oct4` (`828a680`).
  - **main branch** (v1) at `6682324` (2026-10-12 02:40 UTC).
  - **Live pages:** executor.sh (`/`, `/pricing`, `/docs`, `/apps`, `/blog`, `/index.md`, `/llms.txt`, `/setup-prompt.md`, `/about-executor`, `/.well-known/agent-skills/index.json`).
  - **Live APIs:** `api.executor.sh/openapi.json` (130 operations); the public app registry (`api.executor.sh/api/registry/apps`, plus the source of 7 listings); the protected-resource metadata on `mcp.executor.sh` and `executor.sh`.
  - **Other sources:** `integrations.sh/api.json`; the npm registry and downloads API; the GitHub REST and GraphQL APIs; YC company and launch pages; HN via Algolia.
- Labels:
  - **[live]**: fetched today, with URL.
  - **[code]**: read in source at the SHAs above.
  - **[docs]**: vendor docs (repo `apps/docs/content` or executor.sh/docs).
  - **[inference]**: my own reasoning.
- Limits: I did not sign up or sign in anywhere. x.com returns HTTP 402 to unauthenticated fetches, so I saw X posts only as search snippets. I dated them from their status IDs (snowflake timestamps).

---

## TL;DR

1. **Executor now leads with "integration hub, then apps on top", the same idea as Every App's founder.** On **2026-10-11** the executor.sh tagline changed. [live, code: v2 export `9a64624`, `apps/marketing/src/content/site-copy.ts`]
   - Before: "Your agents' cloud."
   - After: **"Everything you use, connected in one place. Then build whatever you need on top."**
   - The same change added an FAQ:
     - "Is it like Composio? Both connect your accounts. With Executor you can also bring your own integrations, change how any tool works, and build apps on top of them."
     - "Is it still an MCP gateway? Yes. Connecting your tools and routing your agent to them is where it starts. Everything else is optional."
2. **v2 is now the default for new users, but it is still a beta.**
   - Since **2026-10-08**, sign-up, marketing and `/docs` on executor.sh are served by v2. [code: main PRs #2217, #2213]
   - v2 runs on `app.executor.sh`, `mcp.executor.sh` and `api.executor.sh`. `v2.executor.sh` now 308-redirects to executor.sh. [live]
   - npm `latest` is still `1.6.10`; v2 ships under the `beta` tag (`2.0.0-beta.15`, 2026-10-11). [live]
   - v1 still serves existing organizations: `executor.sh/mcp` is still v1's endpoint. [live]
   - On 2026-10-12, v1 organizations with one member on a free plan got a "Move to Executor v2" importer (#2266, #2269). [code]
3. **In v2, every integration is an app.** "Accounts are saved only by completing an app's connection request." The `accounts.add` API was removed. [code: `.changeset/accounts-connect-through-apps.md`]
   - The only no-code path is **MCP servers that work anonymously or advertise OAuth that can be discovered**. Quick Add (from the integrations.sh catalog, or from a URL) generates and deploys a wrapper app.
   - Everything else gets a copyable "Set up with your agent" prompt, and the user's own agent writes and deploys the app. "Everything else" includes OpenAPI services such as **Gmail, Google Calendar and Microsoft Graph**, GraphQL, and MCP servers that need an API key. [code: `packages/catalog/README.md`, `packages/ui/.../catalog.tsx`]
4. **The founder's hypothesis is half right.** Executor **does host apps**: Cloud runtime, SQL storage, private UIs, schedules, workflows, webhooks and events. It **does have a public app gallery** with publish and copy: executor.sh/apps has 15 listings from 10 publishers. The listings are unreviewed, and copies never update.
   - What Executor lacks is a curated catalog of complete apps that it maintains.
   - Its only first-party app is the built-in "Executor" management app. Three dogfood apps were also published from the `@executor` scope.
   - Apps are written by the user's own coding agent. "Executor runs no AI", and there is no done-for-you service.
5. **Reuse across apps happens at the account level, and it is fragile.**
   - A provider's ID is a hash of its whole definition, including name, labels and scopes. Two apps share an account only if they declare **identical** providers. [docs, code]
   - Apps cannot call other apps' tools yet. [code: v1-import note; docs "coming later"]
   - Executor's own X Reply Guard app says: "Its definition must stay identical to the one in the X DMs app so both select the same account." [live: registry source]
   - This is a concrete opening for Every App.
6. **Big runtime changes since Oct 4:**
   - App storage moved to **SQL migrations on Durable Object SQLite** (`apps@0.0.1-beta.38`, 2026-10-07). The 5,000-row, 1,000-row and 4 MiB limits are gone.
   - Per-person **profiles**.
   - **Members**, not only admins, can call tools.
   - **Events** that MCP clients such as ChatGPT can subscribe to.
   - **Operator-run ("first-party") OAuth clients** on Cloud: a GitHub App, plus Google and Slack clients.
   - **MCP session Durable Objects** on Cloud.
   - The v1-to-v2 importer.
7. **Traction:**
   - GitHub: 4,160 stars and 366 forks, up from about 4.1k and 349 on Oct 4.
   - npm: `executor` had 28,570 downloads in the week of Oct 5–11 (see caveats in §6).
   - v2 desktop builds are downloaded in the tens per release. v1.6.10's update feed has about 24k fetches.
   - The app registry has 15 apps.
   - The 65 testimonials are all from individuals on X. There are no named company customers.
   - The YC page says **team size 1**.
8. **Implication for Every App:** Executor is converging on the "gateway plus apps" story and is ahead on integration breadth and onboarding. Every App's opening has three parts:
   - Curated, maintained, real apps that teams install and update in their **own** Cloudflare account.
   - **Connections as first-class gateway objects.** Agents use them directly, and any app reuses them through one canonical declaration.
   - **Company-internal defaults:** org-wide apps, roles, per-app access, and an audit log for everyone. Executor's defaults are "personal software" and "Only me".

---

## Testing the founder's hypothesis

> "Executor seems to be moving there too, except they're not building and hosting the apps themselves — it's all custom internal apps instead of an open-source app store like ours."

| Part of the claim | Evidence | Verdict |
|---|---|---|
| Executor is moving toward "integration hub by default" | Oct 11 tagline "Everything you use, connected in one place. Then build whatever you need on top."; FAQ "Is it still an MCP gateway? Yes … Everything else is optional." [live] | **True**, and very recent (2026-10-11) |
| They don't **host** the apps | Cloud runs apps in Dynamic Workers with Durable Object SQLite and private UIs at `https://<app>.<org>.executor.website`. Local and desktop run them in workerd; self-host runs them in Docker. "Cloud: Deploy your apps. We handle the hosting." [live homepage; docs `author-an-app.mdx`] | **False.** Hosting apps is the core of v2. |
| They don't **build** the apps | Each org gets one default app, the "Executor" management app [code: `organization-defaults.ts`]. The `@executor` scope published 3 dogfood apps: an X DM cache, a spam filter for replies to @RhysSullivan, and a git.cafe PR viewer [live registry]. Apps are written by the user's coding agent, or generated by Quick Add for MCP servers. No curated business apps. | **Mostly true** |
| No open-source app store, "all custom internal apps" | A public gallery at executor.sh/apps: "Apps shared by people building with Executor. Browse the source and make your own copy." Publish and unpublish, scoped names `@<org>.executor.community/<name>`, "Make a copy" to install. 15 listings from 10 publishers. "Community apps aren't reviewed by Executor." Copies never receive updates. [live; API `appManagement.publish/copy`] | **Partly false.** A community store exists, but it is tiny, unreviewed, copy-only, and mostly integration wrappers and personal utilities. |

**Precise version of the claim [inference]:** Executor hosts apps on its own runtime and runs a small, unreviewed community gallery where you install by copying, with no updates. It does not ship or maintain a curated catalog of complete apps, and its apps never run in the customer's own cloud account.

---

## 1. What executor.sh says it is today

### 1.1 Homepage ([live] https://executor.sh/, fetched 2026-10-12)

- `<title>`: "Executor — Everything you use, connected in one place."
- Hero: "**Everything you use, connected in one place. Then build whatever you need on top.**"
- Subhead: "**Executor is your agents' cloud. All of your connectors, skills, automations, personal software, browser** (Coming soon)**, and computer** (Coming soon)**, all in one place.**"
- CTAs: "Get started" (→ `app.executor.sh/login?mode=signup`), "Build with your agent", and "Rather keep it on your machine? Desktop, CLI, or self-hosted".
- Section "Everything you use.": "Gmail, Calendar, GitHub, Linear, Stripe. Add an MCP server you already have, or ask your agent to write the tool. You connect each account once through a secure link, so credentials never end up in chat or in code."
- Section "Connected in one place.": "Add Executor to your agent once. Every account you connect is then available to every agent you use. Your agent does the thinking; Executor is where it reaches your tools, and where the things it builds keep running."
- Section "Then build whatever you need on top.": "Start with the tools a service already has. When something's missing, ask your agent to add it. Here's how one Gmail connection grows:" It then walks five steps:
  1. "Connect my Gmail."
  2. Undo send (workflow)
  3. Notes (storage, "the app's own SQLite database")
  4. Auto-archive (webhook)
  5. "Build me a Superhuman-style inbox" (UI)
- "What it is, and isn't":
  - "Is it an agent? No. Executor runs no AI. It extends the agent you already use, through one MCP server."
  - "Is it like Composio? Both connect your accounts. With Executor you can also bring your own integrations, change how any tool works, and build apps on top of them."
  - "Is it like n8n or Zapier? There's no flow builder. Your agent writes the automation as code, and Executor runs it on a schedule or when a webhook arrives."
  - "Is it still an MCP gateway? Yes. Connecting your tools and routing your agent to them is where it starts. Everything else is optional."
- "Run it where you want":
  - "Cloud: Deploy your apps. We handle the hosting."
  - "Desktop (Beta)"
  - "CLI: `npm i -g executor@beta`"
  - "Self-hosted"
- About: "**Deploying an app for your agent should be as simple as deploying a website. Executor is where your personal software lives.**"
- There is no mention of "internal tools", Retool or Zapier beyond the n8n/Zapier FAQ.
- **Date of the change [code]:** the tagline, the new three-part story and the Composio FAQ all landed in v2 export `9a64624` on **2026-10-11 06:28 UTC**. On Oct 4 the tagline was "Your agents' cloud." and the homepage story was apps-first ("Start with something useful… That's an Executor app.").
- **Inconsistent copy elsewhere:**
  - `/llms.txt` still says "The cloud for agent apps… Everything's an app." [live]
  - `/index.md` still says "Cloud app pages and hosted app data are still in development." [live] That line was already there on Oct 4, while the docs describe working Cloud UIs. I treat it as stale but could not verify behind sign-in.

### 1.2 Docs index ([live] https://executor.sh/docs; [docs] `apps/docs/content/index.mdx`)

- "Executor holds your **accounts** — the credentials for the services you already use — and connects them to **apps**. An app is a small program that turns those accounts into **tools**. People use those tools in the dashboard. Agents use them through one MCP endpoint."
- The "short version" steps were **reordered since Oct 4**:

  | Oct 4 | Now |
  |---|---|
  | 1. Connect an account | 1. **Add an app**: "Add one from the catalog, copy a public listing, or deploy your own source." |
  | 2. Add an app | 2. **Connect its accounts**: "On the app's Accounts tab…" |
  | 3. Use it | 3. Use it |

- Hosted: "sign in at app.executor.sh". On Oct 4 this said "v2.executor.sh… This is the beta origin."

### 1.3 Pricing ([live] https://executor.sh/pricing)

- Heading: "Start free, pay per member. Cloud is free for small teams. Team is one flat price per person. Enterprise is for orgs that need it on their own infrastructure with their own controls."
- **Free:** $0. "Up to 3 members", "Unlimited integrations".
- **Team:** "$15 / member / month". 14-day free trial; "Verified domains & join by team domain".
- **Enterprise:** Custom.
  - "Self-hosted or dedicated cloud deployment support"
  - "SSO / SAML & SCIM provisioning"
  - "**Audit logs for every tool call**"
  - "Dedicated support & onboarding"
  - "Security reviews, DPA & SOC 2 on request"
- **Change vs Oct 4:** the free tier's "100k executions/month" no longer appears. The v2 billing catalog meters only members and domain verification [code, Oct 4 read], so executions are effectively unlimited [inference].

### 1.4 Is v2 the default now?

| Surface | State on 2026-10-12 | Source |
|---|---|---|
| executor.sh marketing, `/docs`, `/apps`, `/blog`, `/pricing` | Served by v2, forwarded by v1's edge Worker | [code] main #2213, #2217 (merged 2026-10-08) |
| Sign-up | `app.executor.sh/login?mode=signup` (v2) | [live], [code] #2209/#2217 |
| `v2.executor.sh/` | 308 → `https://executor.sh/` | [live] |
| v2 hosts | `app.` (dashboard), `mcp.` (MCP), `api.` (API and app registry), `*.executor.website` (app UIs) | [code] `host-roles.ts`; [live] `https://mcp.executor.sh/.well-known/oauth-protected-resource/mcp` returns resource `https://mcp.executor.sh/mcp` with authorization server `https://executor.sh/api/auth` |
| `executor.sh/mcp` | **Still v1**: the authorization server is `https://signin.executor.sh` (WorkOS) | [live] |
| v1 dashboard | Still served on executor.sh to users with a v1 session cookie. New sign-ups whose email belongs to a v1 org "stay on v1". | [code] main #2213; v2 `contracts/onboarding.ts` (`OnboardingV1Workspace`) |
| v1 → v2 migration | "Move to Executor v2" sidebar link for orgs with one member on a free plan (#2266, 2026-10-12); a "now lives in Executor v2" notice (#2269). The importer maps integration → app, connection → personal account plus profile, policy → per-tool approvals in the app, toolkit → scoped MCP connection, and artifact → app source that needs a rewrite. | [code] main PRs; v2 `apps/hosted/cloud/src/implementation/v1-import/*` |
| npm `executor` | `latest: 1.6.10`, `beta: 2.0.0-beta.15` | [live] https://registry.npmjs.org/executor |
| Community PRs | "We're only taking PRs against the `v2` branch now… `main` is the older 1.x line." (Rhys, GitHub, 2026-10-11) | [live] PR #2248 comment |

**Answer:** v2 is the de facto product for new users and the public face of executor.sh. It is not GA on npm, and v1 still serves its existing (multi-member and paid) orgs.

### 1.5 Releases after beta.8, latest commits, README

| Release | Published (UTC) | Notes |
|---|---|---|
| `executor@2.0.0-beta.9` | 2026-10-06 | The release notes are packaging boilerplate (install, keys, macOS signing) with no feature list. |
| `beta.10` | 2026-10-07 | Same as beta.9. |
| `beta.11` | 2026-10-08 | Same as beta.9. |
| `beta.12` | 2026-10-09 | Same as beta.9. |
| `beta.13`, `beta.14` | 2026-10-10 | Same as beta.9. |
| `beta.15` | 2026-10-11 | New in the notes: a `curl -fsSL https://executor.sh/docs/install.sh \| sh` install with no Node needed, a single Bun-compiled executable, `executor upgrade [--rollback]`, a Homebrew formula (planned), and a patched Bun runtime. |

- [live] https://github.com/UsefulSoftwareCo/executor/releases
- Feature-level changes have to be read from the 40 `.changeset/*.md` files on v2. 30 of them are new since Oct 4 (see §4 and §7).
- **Latest commits:**
  - v2: `9c0f2eb` "Export 2e44551", 2026-10-12 17:22 UTC. That is 306 export commits since Oct 4, often 10–20 a day.
  - main: `6682324` "Test the moved-to-v2 notice (#2270)", 2026-10-12 02:40 UTC. main now carries only v1 maintenance and v2 hand-off work.
- **README:**
  - The main README is unchanged: "**Connect any agent to everything.** Executor is an open-source integration layer for AI agents…"
  - The GitHub repo description is still v1's: "The missing integration layer for AI agents…"
  - The v2 README (developer-facing, "executor-next") gained one paragraph on how public PRs to `v2` are ported into the private repo with `Public-PR:` trailers.
  - `CONTEXT.md` now defines the publisher scope as `<slug>.executor.community`. It also drops the line "Executor app-to-app package dependencies are deferred" from the definition of a public app installation.

---

## 2. Integrations vs apps in v2

### 2.1 The rule: no account exists outside an app

- "Accounts are saved only by completing an app's connection request. `accounts.add` (`POST /v1/accounts`) and `accounts.replaceCredentials` … are removed; products write the credentials of accounts they provision themselves through the host-only `managedAccounts`." [code: `.changeset/accounts-connect-through-apps.md`, new since Oct 4]
- Docs: "Every account is connected for an app." The global Accounts page "lists saved accounts and the apps that use them; it does not connect accounts or change their credentials." [docs `connect-an-account.mdx`, changed since Oct 4]
- The local dashboard's standalone "add account" route was deleted (`_dashboard._inventory.accounts.add.tsx`). [code]
- Agents call tools as `tools.<app-slug>.<tool>`, or `tools.<app-slug>.profiles["<profile-id>"].<tool>` for apps with accounts. [docs `apps-and-deployments.md`]
- **So:** a user cannot "just connect Linear" and have agents call it without an app. For Linear, the app is generated automatically (§2.2), so the user writes no code, but an app record, source and deployment still exist.

### 2.2 The ways to get an integration, and which need code

| Path | What happens | Code written by | Source |
|---|---|---|---|
| **Quick Add from the catalog** (MCP entry) | Executor checks the server live. It succeeds if "anonymous `initialize` and `tools/list` succeed, or the server rejects anonymous use and advertises OAuth that the SDK can discover". It then generates source (`mcpRouter`, approvals for `destructiveHint: true` tools, an `mcpHealth` account check) and deploys it. The user then connects an account on the app's Accounts tab. | Nobody (generated) | [code] `packages/catalog/README.md`, `packages/app-templates/src/implementation/mcp.ts` |
| **Connect a service by URL** ("Custom app") | Same check, MCP only (`CustomAppInput.kind: Literal("mcp")`) | Nobody | [code] `packages/catalog/src/contracts/imports.ts` |
| **Catalog entry that is not MCP** (OpenAPI, GraphQL), or MCP that needs an API key | The dashboard shows "**Set up with your agent**: Your agent reads this service's documentation, asks how you sign in, then writes and deploys the app in Executor." The copyable prompt starts "Help me add <Service> to Executor as an app…" | The user's agent | [code] `packages/ui/src/implementation/dashboard/catalog.tsx`, `agent-setup.tsx` |
| **Copy a public listing** | Copies the exact published commit into a new app with fresh Git history and auto-deploys it. Accounts and data are not copied. | The original author | [docs], [live API] `appManagement.copy` |
| **Write from source** | `executor apps create/deploy` (CLI) or management tools inside `execute` | The user's agent (or the user) | [docs `author-an-app.mdx`, `run/cli.mdx`] |
| **v1 import** | v1 OpenAPI and GraphQL integrations become **generated** apps (`openapiAppSource`, `graphqlAppSource`). This is the only place those generators are used. | Generated | [code] `v1-import/items.ts` |

- Doc/code mismatches I found [code vs docs]. Trust the code.
  - `author-an-app.mdx` says the "Custom app form does the same thing from a URL, for MCP, GraphQL and OpenAPI". The code accepts MCP only.
  - The app-authoring skill's `deploy.md` says "The local catalog imports OpenAPI". Local uses the same MCP-only `createCatalog`.
- **Quick-added app source** is ordinary code. Example: `@romeupcampos.executor.community/firecrawl` is 10 lines.

  ```ts
  export default defineApp({ accounts: {} }, async ({ signal, cache }) =>
    mcpOperations({ url: "https://mcp.firecrawl.dev/mcp", cache, signal }))
  ```

  With OAuth, the generated pattern is `accountRouter(accounts.x, account => withApprovals(mcpRouter({url, account, headers: {Authorization: "Bearer " + account.fields.access_token}}), tool => toolAnnotations(tool)?.destructiveHint === true ? always() : undefined))`. [live registry source of `@nibomo…/nibomo`; code]
- **Approval defaults for imported tools [code `integrations.md`]:**
  - "Helpers attach no approval."
  - The skill tells agents to require approval on OpenAPI and GraphQL mutations and on MCP tools with `destructiveHint: true`.
  - Quick-add MCP apps use the `destructiveHint` rule, so MCP tools without annotations run without approval.

### 2.3 How integrations.sh feeds onboarding

- **Feed** [live https://integrations.sh/api.json, `generatedAt` 2026-10-12T20:24Z]:
  - 5,572 entries (5,537 on Oct 5).
  - By kind: openapi 3,529, mcp 1,323, cli 604, graphql 116.
  - Declared auth on MCP entries: none 416, oauth 285, unknown 618, api_key 2, mixed 2.
  - Feeds: discovered 2,482, apis-guru 2,067, openai 792, claude 222, **curated 94**.
  - Curated entries by kind: 65 OpenAPI, 18 MCP, 6 CLI, 5 GraphQL. Curated examples: Gmail, Google Calendar/Drive/Docs/Sheets, Microsoft Graph, Linear, Slack, Notion, Stripe, Sentry, PostHog, GitHub.
  - The site says: "Every integration, in every format agents speak. 5,562 publicly-accessible integration specs across MCP, OpenAPI, and GraphQL." The repo `UsefulSoftwareCo/integrations` is MIT, with 604 stars, pushed 2026-10-12. [live]
- **How the Add app page uses it [code]:**
  - Hosted lists `[Executor management app, ...integrations.sh feed]` (`apps/hosted/server/src/implementation/catalog.ts`). It hides CLI entries (about 4,968 visible) and sorts curated first, then by popularity.
  - Quick Add works only for MCP entries that pass the live check (§2.2).
  - Examples:
    - **Gmail** exists only as OpenAPI (`integrations.sh/specs/google/google-gmail.json`), so it is agent-written.
    - **Linear** has an MCP entry with OAuth (`mcp.linear.app/mcp`), so it is Quick-Add-able.
    - **Slack** has an MCP entry with OAuth (`mcp.slack.com/mcp`). Slack offers no dynamic client registration, and Executor's Slack client is unlisted (below).
    - **GitHub** has an MCP entry with "mixed" auth (`api.githubcopilot.com/mcp/`) and an OpenAPI entry.
- **Catalog overrides:** PostHog's MCP is forced to `mode=tools` and Cloudflare's MCP to `codemode=false`, "Executor already provides code execution". [code `overrides.ts`]
- **Operator-run ("first-party") OAuth clients on v2 Cloud are new since Oct 4.** [code `apps/hosted/server/src/implementation/first-party-oauth.ts`; not present in the Oct 4 snapshot]
  - `github` is "v1's Executor.sh GitHub App". It is required on production ("Production (v2) requires the GitHub App's"). Its tokens go only to `api.github.com`, `uploads.github.com` and `api.githubcopilot.com`.
  - `google` is "Executor for Google". Its scope menu includes `https://mail.google.com/`, Calendar, Drive, Docs, Sheets, Meet and more: "the scope set submitted for the production app's review". It is "offered once both [settings] are set".
    - I could not verify whether it is live on Cloud.
    - executor.sh/about-executor and /google-workspace read like Google verification pages: "Executor is an integration platform and MCP gateway for AI agents…".
    - Branches named `casa-*` (2026-09-15) suggest a Google CASA assessment [inference].
  - `slack` is "Executor for Slack", **unlisted**: "Slack lets an app use MCP outside its own workspace only once it is published in the Slack Marketplace, so it signs in no new accounts, but reconnects and renews those it already holds."
  - Note that the shared app-authoring skill still tells agents to "Expect to need a user's client for Google, GitHub and Slack". That is true for local and self-host. [code]

### 2.4 Onboarding for a brand-new team on Cloud [code]

1. **Sign up** at `app.executor.sh/login?mode=signup`. Methods: Google, GitHub, optional "Sign in with ChatGPT" (new: `chatgpt-sign-in.ts`), email OTP, passkey, SSO.
2. `onboarding.prepare`:
   - Pending invitations come first.
   - Otherwise a **company lookup by verified email domain** suggests the team name and logo.
   - If the email belongs to a v1 org, the user is kept on v1. [`contracts/onboarding.ts`]
3. **Create team.** The org gets one default app, **"Executor"** (management tools generated from the Cloud OpenAPI). [`organization-defaults.ts`]
4. **"Connect your assistant"**:
   - The user picks Claude, ChatGPT, Cursor (an Executor plugin in the Cursor marketplace), Claude Code, Codex, Devin, Grok Bot, Grok, Muse or Other.
   - Each choice has a step guide.
   - The page **waits until a new MCP grant actually appears** before unlocking Next. [`apps/hosted/web/.../agent-setup.tsx`, `packages/ui/.../connect.tsx`]
5. **"Send your first prompt"**: "Use Executor, which I connected over MCP at <mcp.executor.sh/mcp>. If you cannot see its tools yet, connect to that server first. Read the docs to understand the product at <docs>, then help me get my first app set up."
6. **Dashboard → Apps → Add app.** The user Quick-Adds from the catalog, copies a setup prompt, connects an MCP URL, or finds a public package. There is **no "create blank app" button**: PR #2253 (open) says "there was no way to create an empty app from the dashboard without going through an agent".

**The MCP connection itself carries instructions.** On connect, "the server's MCP instructions introduce Executor to the agent. They are the Executor app's `executor` skill". That skill says:

> "Build an app when the user needs tools, data, a UI or automation that no existing app provides. For a known service, check Executor's catalog first: Quick Add on the Add app page installs published apps and remote MCP servers without code."

[docs `mcp.md`; code `packages/app-templates/executor/skills/executor/SKILL.md`, new since Oct 4]

---

## 3. App distribution: what exists today vs what is planned

| Capability | Status 2026-10-12 | Evidence |
|---|---|---|
| Public gallery | **Live** at https://executor.sh/apps (moved from v2.executor.sh/apps). "Apps shared by people building with Executor. Browse the source and make your own copy. Community apps aren't reviewed by Executor. Anyone can publish one. Read its source before you copy it: a copy runs with the accounts you connect to it." | [live]; component existed on Oct 4 [code] |
| Publication | Live. `POST …/apps/{app}/publication`: "Publish this Git commit as the current public app listing. package.json supplies a name under the organization's current scope, such as `@acme.executor.community/notes`." One current revision per package, so republishing replaces it. Unpublish is supported. **Admins** publish. Scopes follow the org's current slug and "never [are] claimed: a rename moves every listing to the new scope". | [live API]; [docs `organizations-and-access.md`]; [code `CONTEXT.md`, `publishers.ts`] |
| Install ("Make a copy") | Live. "Make an independent copy with fresh Git history… Public packages copy the reviewed published commit. Running and public copies deploy automatically. Accounts and app data are not copied." | [live API `appManagement.copy`] |
| Fork | "Fork" is a domain term ("A new app whose source and history start from another app and can change independently"). In the UI it appears as "Make a copy". There is no upstream link. | [code `CONTEXT.md`] |
| Updates for installed copies | **None.** "Republishing or unpublishing the original does not update or revoke your copy." Docs list "Automatic updates from another app or public package" under "What is coming later". | [docs `apps-and-deployments.md`] |
| Review or curation | **None.** No badges, verification or ratings. Every listing is shown as "Community app, not reviewed by Executor." | [live]; [code `apps-directory.tsx`] |
| Templates and starters | No template gallery. Agents get a **`live-inbox`** example (SQL migrations, query and mutation, React UI, live subscription) through `framework.describe`. The homepage "daily-brief" is illustrative code. Quick Add is the only template generator, and it is MCP-only. | [code `starter.md`] |
| First-party apps | The built-in "Executor" management app, auto-installed per org. `@executor.executor.community` published `x-dms` ("Encrypted cache of your X DMs"), `x-reply-guard` (hides spam replies to @RhysSullivan's posts) and `gitcafe-pulls` ("GitHub-style pull request pages for git.cafe repositories"). These are the founder's own utilities, not a product catalog. | [code]; [live registry] |
| Registry shared across hosts | Self-host and local read the Cloud registry by default (`EXECUTOR_REGISTRY_URL` default `https://api.executor.sh`; "Publishing reaches other executors within [5 minutes]"). Publishing is a Cloud organization feature. | [docs `run/self-host.mdx`]; [code `remote-registry.ts`] |
| Marketplace, payments, ratings | None. | — |
| Imports between app packages, app-to-app calls | Deferred. "Calling one app from another" is listed under "coming later". v1 artifacts import as source only, because "v2 apps cannot call other apps' tools yet". | [docs `author-an-app.mdx`]; [code v1-import] |

**Registry contents** [live `https://api.executor.sh/api/registry/apps`, 2026-10-12]: 15 listings, 10 publishers, 6 with an empty description. First publication was 2026-09-28.

| Published | Package | Description |
|---|---|---|
| 09-28 | `@romeupcampos…/firecrawl` | (none). A 10-line MCP wrapper. |
| 09-29 | `@krantideep95…/monzo`, `/trading-212`, `/truelayer` | Read-only banking and brokerage APIs (bring your own client or key) |
| 10-01 | `@carsten-a-meyer…/carbone` | (none) |
| 10-02 | `@executor…/x-dms` | Encrypted cache of X DMs |
| 10-05 | `@novmbrs…/cloudflare-api` | Cloudflare REST via `liveOpenapiRouter` plus `githubSkills` from `cloudflare/skills` |
| 10-06 | `@executor…/gitcafe-pulls` | PR pages for git.cafe |
| 10-07 | `@nibomo…/nibomo` | Wrapper for the Nibomo MCP (published from the vendor's own GitHub Action) |
| 10-08 | `@executor…/x-reply-guard` | (none) |
| 10-09 | `@kristoffer…/entur` | (none) |
| 10-09, 10-11 | `@denis-rha67…/executor`, `@giaky793…/executor` | (none). Likely test copies. |
| 10-12 | `@omora…/p3-stack`, `/plannotator-inbox-executor` | Skills and playbooks package for T3 Code; a shared Plannotator inbox |

**Who builds apps:**
- The **user's own coding agent**:
  - over MCP: `execute` plus the Executor app's management tools such as `apps.deploy` and `framework.release`;
  - or through the CLI: `executor apps login|create|source|commit|deploy|git|credential|framework|skills`.
  - Either way it follows the `app-authoring` skill. [docs, code]
- **Executor has no in-product agent** ("Executor runs no AI").
- **No staff build or "forward-deployed" offering** appears on the site, pricing or docs. Enterprise lists only "Dedicated support & onboarding". [live]

---

## 4. Hosting and runtime: changes since the Oct 4 read only

| Area | Oct 4 read | Now (2026-10-12) | Source |
|---|---|---|---|
| Hosts | `v2.executor.sh` | `app.executor.sh` (dashboard), `mcp.executor.sh/mcp`, `api.executor.sh` (API and registry), `executor.sh/git/...` (Git remotes); app UIs still at `https://<app>.<org>.executor.website` | [code `host-roles.ts`, `.changeset/hosted-domains-defaults.md`]; [live] |
| **App data** | Document DB (`defineDatabase`, `table`, `withIndex`). Reads bounded at "5,000 rows scanned, 1,000 returned, 4 MiB per invocation"; 1,000 writes per mutation. | **SQL**. `migrations/0001_*.sql` are applied at deploy in one transaction and are immutable once applied. Access is `ctx.sql.exec(...)` with transactions. "App SQL is Cloudflare's Durable Object SQLite on every host, local included." Limits: 100 bound values per statement, 100 KB per statement, 2 MB per row, 100 columns. "**There is no row budget.**" Old rows are kept in `_executor_legacy_rows`. Landed in `apps@0.0.1-beta.38` (2026-10-07). | [docs `author-an-app.mdx`]; [code `storage.md`]; [live npm] |
| App code shape | `queries:` and `mutations:` maps; `mcpOperations` / `openapiOperations` | `tools: router({...})` with nested routers; `mcpRouter`, `liveOpenapiRouter`, `graphqlRouter`, `stdioRouter`; `accountRouter` (one router per selected account); `withApprovals`. `package.json` must pin the exact `apps` version the host runs. | [docs] |
| Framework package | `apps@0.0.1-beta.0` was "being prepared" | The npm package `apps` (Rhys took over the old 2014 Heroku name) has had 73 betas since 2026-09-23 and is now at `0.0.1-beta.84` (2026-10-12). | [live npm] |
| Per-person accounts | "Coming later" | **Profiles shipped.** "A profile is one person's choice of accounts for an app… Each member sets up their own profiles. Managing an app does not grant use of somebody else's accounts. Every profile runs the app's active deployment and shares the app's stored data." | [docs `apps-and-deployments.md`] |
| Roles and MCP access | Running tools over MCP required admin or owner | **Members** create apps, connect accounts and use what is shared with them. "Using an app, including calling its tools through MCP, follows the app's audience": **Only me (default)**, Everyone, or Groups. Admins publish apps. "Managing does not grant use." | [docs `organizations-and-access.md`] |
| Events (new) | — | Apps declare `event({...})` and call `ctx.events.emit(...)` from mutations and webhooks. MCP clients subscribe ("such as ChatGPT watching for new issues"). Delivery is at least once with retries for about 4.5 h. Events are kept 3 days. Payloads are capped at 250 KiB and 100 events per invocation. | [code `events.md`, new] |
| App cache | — | Keys up to 8,192 bytes, entries up to 2,000,000 bytes, 7-day retention. Limit errors are now explicit. | [code changesets] |
| Deadlines | `execute` 5 min | `execute` 5 min, and "time spent waiting for your approval or input does not count". Workflow step defaults to 10 min. Webhook handler 45 s. Account check 15 s. | [docs `mcp.md`]; [code `storage.md`] |
| MCP serving on Cloud | (v2 Cloud details not covered) | **New MCP session Durable Objects.** Session records persist across eviction and deploys, but "Programs, approvals and held connections stay in memory and are lost as before." Session IDs are HMAC-signed so the gateway can route to the owning object. | [code `infrastructure/mcp-session*.ts`, `implementation/mcp-session-id.ts`, all new] |
| Self-host | `EXECUTOR_APP_WORKERS=32`; data Workers not counted | Default is 64 and now counts data Workers. Idle Workers unload after `EXECUTOR_APP_WORKER_IDLE_SECONDS=300`. The isolate collects garbage after each call. New optional CIMD (`EXECUTOR_OAUTH_CLIENT_METADATA_URL`). Registry default moved to `api.executor.sh`. | [docs `run/self-host.mdx`] |
| Self-host problems reported since Oct 4 | — | Memory grows to 5–10 GB with uptime (#2216); an idle container burns about 13% CPU and writes about 190 GiB/day once Motel hits its cap (#2194); 403s behind TLS-terminating proxies such as Railway (#2199, #2272); app discovery took 15–60 s (#2193, closed). | [live GitHub issues] |
| Runtime limitation seen in the wild | — | "Webhook handlers currently lose SQL writes made after an outbound fetch" (Executor's own x-reply-guard README) | [live registry source] |
| Cloud app pages | Assumed working | The docs and skills describe `appUi.location` returning `https://<app>.<org>.executor.website` on Cloud. The live `/index.md` still says "Cloud app pages and hosted app data are still in development" (stale since before Oct 4). **Not verified behind sign-in.** | [docs]; [live] |

---

## 5. Public statements on direction (Sep–Oct 2026)

| Date (UTC) | Where | Statement | Label |
|---|---|---|---|
| 2026-09-28 22:38 | X, @RhysSullivan (status 2104702337562657253) | "finally liking this descriptor of executor v2 but man it's a tough product to describe". Search snippets tie it to v2.executor.sh "Executor — Your agents' cloud." | [live search snippet; date decoded from the status ID; the post itself is unreachable (HTTP 402)] |
| 2026-10-08 | GitHub main PRs #2206–#2225 (Rhys) | Moved executor.sh sign-up, marketing and `/docs` to v2: "`/docs` on executor.sh is now v2's docs." | [live GitHub] |
| 2026-10-11 | executor.sh homepage (v2 export `9a64624`) | "Everything you use, connected in one place. Then build whatever you need on top." / "Is it like Composio?…" / "Is it like n8n or Zapier?…" / "Is it still an MCP gateway? Yes…" | [live]; [code] |
| 2026-10-11 | GitHub PR #2248 comment (Rhys) | "We're only taking PRs against the `v2` branch now, which is where Executor 2 is developed; `main` is the older 1.x line." | [live] |
| 2026-10-12 | GitHub PR #2278 comment (Rhys) | On choosing account sharing during setup: "Going to be implementing this one differently where you're moreso putting an account on the app". This suggests shared accounts attached to apps. | [live] |
| 2026-10-12 | GitHub PRs #2266/#2269 | v1 orgs are told: "<org> now lives in Executor v2", with feedback captured for "Keep using v1". | [live] |
| Context: 2026-08-04 | Launch YC | "One place to connect your agents to everything." "Connect your tools once and every agent has them, with permissions you control." "2,800+ GitHub stars, ~14k npm downloads/week, ~3,000 users on the local version." No mention of apps, internal tools, Composio, Zapier or Retool. | [live https://www.ycombinator.com/launches/SBH-executor-one-place-to-connect-your-agents-to-everything] |
| Context | YC company page | "The open source tool gateway". S26, San Francisco, **team size 1**, founder Rhys Sullivan (ex-Vercel, Microsoft, Raven, Epic). | [live https://www.ycombinator.com/companies/executor] |

- **Nothing found:**
  - no Launch HN, and no HN story about Executor in Sep–Oct (only passing comments) [live HN Algolia];
  - no blog posts since 2026-08-09 (the latest is "We're not using enough inference");
  - no Sep–Oct posts on rhys.dev;
  - no podcast in the window. The only podcast is Kent C. Dodds's "Primitives, agent UX, and Executor", 2026-04-30.
- The word "Retool" appears nowhere. "Internal tools" does not appear in Executor's copy. Its framing is "**personal software**".

---

## 6. Traction

| Metric | Value | Notes |
|---|---|---|
| GitHub stars and forks | **4,160 / 366** (2026-10-12) | About 4.1k / 349 on Oct 4. 2,800+ at the YC launch (2026-08-04). 3,982 per a third-party write-up in September. [live gh api] The stargazer list could not be read through the API (404), so there is no daily breakdown. |
| Open issues and PRs | 37 | 86 issues and PRs were created since Oct 4, with many external v2 contributors. [live] |
| npm `executor` downloads | **28,570** in Oct 5–11; 94,409 in Sep 12–Oct 11 | The daily series has npm artifacts: Oct 6 = 0, then Oct 7 = 14,490 (same pattern on Sep 15/16). The baseline is about 3k/day. Platform binaries are published as versions of the same package (for example `1.6.10-darwin-arm64`), so one install probably counts about twice [inference]. Compare "~14k/week" at the YC launch. [live api.npmjs.org] |
| v2 desktop downloads (GitHub release assets) | beta.9–15: 78–185 total asset downloads per release. The mac-arm64 DMG gets about 4–26 per release. | v1.6.10's `latest-mac.yml` was fetched 23,956 times and its DMG 720 times. **v1's installed base is still far larger than v2's local or desktop use.** Cloud usage is not visible. [live] |
| `apps` npm package | 76,504 in Oct 5–11 | Not a useful signal: the name mixes in the legacy Heroku package (`latest` 0.8.3) with the Executor betas. [live] |
| Public app registry | 15 apps from 10 publishers | [live] |
| Testimonials | 65 X quotes, all individuals (for example Malte Ubl, Aiden Bai, Nate Berkopec). **No named company customers or logos.** All praise the gateway ("one MCP for all my agents", multi-account, toolkits); none praise apps. Unchanged since Oct 4. | [live, code] |
| Team | 1 (YC page). External contributors send many v2 PRs. | [live] |
| Integrations registry | integrations.sh: 5,572 entries; repo has 604 stars and 45 forks | [live] |

---

## 7. New since Oct 4: agent interaction, approvals, credentials, self-host

**Agent interaction**
- **v2's MCP server offers code mode only.** The tools are `skills`, `execute` and `resume`. `resume` exists in model and browser approval modes; with native elicitation the `execute` call stays open.
  - The v1 "search and invoke" passthrough mode does **not** exist in v2. It was not there on Oct 4 either; the Oct 4 read's "both versions" applies only to code mode.
  - Open request #2198 (2026-10-07): "My harness already has codemode, and I dont want to do codemode-thru-codemode." [code `packages/mcp/src/contracts/*`; live issue]
- **MCP instructions are now the `executor` skill.** `skills({app, name})` reads per-app skills. [docs `mcp.md`]
- **`tools.search` is paginated** and returns the first line of each description plus the input type. `tools.search.describe({paths})` returns full signatures. [docs]
- **Published skills:** `https://executor.sh/.well-known/agent-skills/index.json` lists `executor`, `code-mode` and `app-authoring`. Apps can ship `dynamicSkills` from GitHub, now including **private repos** (`githubSkills` with an account handle), or from well-known indexes. [live; code changesets]
- **Events** for MCP subscribers (§4). This pairs with OpenAI apps domain verification, served on `mcp.`, and the new "Sign in with ChatGPT". **ChatGPT is a first-class target.** [code]
- **Scoped connections are documented**: named MCP URLs with per-app profile and tool selection (all, read-only, or picked).
  - "The consent screen approves every app available to you. To give an agent less, connect it through a scoped connection instead."
  - New **Connected agents** list with revoke (`mcpConnections.agents`). [docs `mcp.md`; live API]
- **Feedback loop:** the `executor` skill tells agents to call `feedback.submit` "when Executor gets in your way… Before your final reply, check whether anything is worth reporting." [code]
- **CLI:**
  - `executor apps` (create, edit, deploy and install apps; login uses the device flow, with a new `/device` route); `executor upgrade [--rollback]`; `executor rotate-key`.
  - The install script needs no Node. Homebrew is planned.
  - Executor 1 commands print the v2 replacement. [docs `run/cli.mdx`; code]
- Supported assistant guides: Claude, ChatGPT, Cursor (marketplace plugin), Claude Code, Codex, Devin, Grok Bot, Grok, Muse, Other. [code]

**Approvals**
- A call refused by an app's policy now explains itself ("not to retry it unchanged…").
- The dashboard Tools tab shows the saved call and resumes it only after the user approves.
- Approval wait time is excluded from the 5-minute limit.
- Still listed as "coming later": "Remembering an approval" and "Resuming a program after the server restarts". [docs, changesets]

**Credentials**
- Accounts can only be created through an app (§2.1).
- Cloud runs operator ("first-party") OAuth clients (§2.3).
- New OAuth options: `previousRedirectUris`, `statePrefix` (for a proxy in front of a shared callback), `issuer`.
- Legacy clients are re-registered.
- `mcpHealth` checks accounts: an account is "healthy only when the server refuses the attempt without credentials".
- v1 #2190 "Restrict OAuth token destinations". [code]
- Provider identity is still a hash of the whole definition except `hosts`. "Changing any of them after users connect gives a new provider, and existing accounts no longer fit the slot." [code `accounts.md`]

**Self-host:** see §4 (memory and idle unload, CIMD, registry default, open resource and proxy bugs).

---

## Implications for Every App

### Is Executor moving to "integration gateway by default, internal apps on top"?

**Yes in its positioning (since 2026-10-11). Only partly in its mechanics.** [inference from the evidence above]

- **The front door is now the hub:** "Everything you use, connected in one place", "Is it still an MCP gateway? Yes", "Unlimited integrations" on Free, and a catalog of about 5k entries on Add app.
- **Underneath, the unit is still the app.** An integration is a generated or agent-written app. Accounts attach to apps. Apps cannot call each other. Account reuse depends on identical provider definitions. Executor's "gateway" is really "every connection is a tiny app".
- **It targets individuals and small teams, not company internal tools.**
  - The copy says "personal software".
  - The default app audience is "Only me".
  - Free covers 3 members.
  - All testimonials are from individual developers.
  - Enterprise features (SSO, SCIM, audit logs) are sales-led.

### How Executor differs from Every App

| Dimension | Executor v2 (2026-10-12) | Every App (current plus planned) |
|---|---|---|
| Front-door story | "Everything you use, connected in one place. Then build whatever you need on top." | Private company apps behind one gateway. Founder's new idea: integration hub by default. |
| Unit of integration | An app (generated for OAuth or anonymous MCP; agent-written otherwise) | Today: a gateway-hoisted provider (`providers: ["openai"]`). Planned: gateway capabilities (email, search, Google). |
| Reuse across apps | Same account only if provider definitions are byte-identical; no app-to-app calls | Gateway owns the credential; apps call the gateway over a service binding |
| Where apps run | Executor Cloud (Dynamic Workers plus DO SQLite), or Executor's Docker or desktop runtime | **Customer's own Cloudflare account**, as separate Workers |
| What an app is | A TypeScript program with tools, SQL, a React page, schedules, workflows, webhooks and events | Full TanStack Start web app with its own D1, KV and Durable Objects (SSR, multiple pages) |
| App catalog | Community gallery: 15 listings, unreviewed, copy-only, no updates | Open-source "app store" of real first-party apps (todo, chef, workout) deployed with `npx everyapp app deploy` |
| Who builds | User's coding agent (MCP or CLI); Quick Add for MCP | User's coding agent from a template, plus first-party apps |
| Agent surface | One `/mcp`, code mode only (`skills`/`execute`/`resume`); events | Planned ToolBus `/mcp` with search-mode meta-tools when there are more than 40 tools |
| Consent | Consent approves all apps; scoped connections narrow access | Planned consent screen that picks org, apps and read vs read-write |
| Approvals | Declared in app code; model, native or browser delivery | Planned risk policy (read, write, destructive) plus browser-link approvals |
| Audit | Enterprise line item; not in open-source code | Planned audit row per call, available to all |
| Self-host | Docker (PGlite and workerd); CF self-host dropped in v2 | Cloudflare-native in the customer's account ($5/mo Workers Paid) |
| Price | Free up to 3 members; $15 per member per month | Open source; customer pays Cloudflare |

### Where Executor is ahead

1. **Integration breadth and the path to a first connection:**
   - a catalog of 5,572 entries with 94 curated;
   - one-click Quick Add for OAuth and anonymous MCP servers, with live detection and generated approval and health checks;
   - "Set up with your agent" prompts for everything else.
2. **Operator-run OAuth clients:** a GitHub App, plus Google (in review, with full Gmail scopes) and Slack clients. Users click Connect without registering their own OAuth app on Cloud.
3. **The account model:**
   - personal vs shared accounts;
   - per-person profiles;
   - "management ≠ use";
   - scoped connections;
   - a connected-agents list with revoke;
   - credential handles with host-limited substitution.
4. **Agent-first onboarding:**
   - guides for nine assistants that wait for a real MCP connection, then hand over a first prompt;
   - MCP instructions that teach the product;
   - published `/.well-known/agent-skills`, `/llms.txt`, `/setup-prompt.md`.
5. **ChatGPT readiness:** OpenAI apps domain verification, Sign in with ChatGPT, events for subscriptions.
6. **Speed and mindshare:** 306 commits and 7 betas in 8 days; 4.2k stars; 65 public testimonials.

### What Every App should copy (in priority order)

1. **The three-part story, adapted to companies:** "Every tool your company uses, connected once at your gateway. Real apps on top: install from the app store, or have your agent build one. All in your own Cloudflare account." Executor shows this story now resonates and that "is it still an MCP gateway?" is the question buyers ask.
2. **Quick Add for remote MCP servers, as a gateway connection rather than an app.**
   - Detect "anonymous `initialize` plus `tools/list`, or OAuth discoverable via RFC 9728/8414 plus DCR or CIMD", then store a connection.
   - Default approvals: `destructiveHint` → approval, and **tools without annotations count as writes**. That is stricter than Executor.
   - Add an `mcpHealth`-style check (the server must refuse without credentials, then accept with them).
3. **A canonical provider registry owned by the gateway** (Google, Slack, GitHub, Linear, Microsoft), with named scope sets. Apps declare `connections: ["google:gmail.readonly"]` the same way they declare `providers: ["openai"]` today. This avoids Executor's identical-definition fragility, which Executor's own apps already work around.
4. **Agent setup prompts everywhere:**
   - a per-integration "Set up with your agent" prompt;
   - a `/setup-prompt.md` and `/llms.txt` on the gateway;
   - `/.well-known/agent-skills/index.json` for ToolBus skills;
   - assistant-specific connect pages that confirm the agent really connected before showing the first prompt.
5. **The account semantics:**
   - personal vs shared connections;
   - per-person selection (profiles);
   - "managing an app does not grant use of someone else's accounts";
   - "a login is not an account" (already in the Oct 4 read).
6. **Scoped connections and a "Connected agents" page.** Named MCP URLs per agent with app and tool subsets and revoke. This matches ToolBus's per-app consent.
7. **If Every App opens community submissions,** copy the honest warning ("not reviewed… a copy runs with the accounts you connect") and the scoped names (`@org/...`). Then **beat it with review and updates** (see below).
8. **Seed the long tail from integrations.sh** (repo is MIT; the feed aggregates apis.guru and others, so check data terms before redistributing). Do not try to curate 5k integrations.

### Every App's opening

1. **Curated, maintained apps that update.** Executor's store is 15 unreviewed listings, install means "copy", and updates are "coming later". Every App can ship reviewed first-party apps (todo, chef, workout, and next CRM-like internal tools) with upgrade paths and changelogs.
2. **Your cloud, your data, real apps.**
   - Apps run in the customer's own Cloudflare account with their own D1, KV and Durable Objects, as full TanStack Start apps.
   - Executor apps are small programs on Executor's runtime (or its Docker self-host, which has open memory and CPU bugs) and cannot call each other yet.
   - There is no per-seat vendor fee ($15 per member at Executor).
3. **Connections as first-class gateway objects.** Agents can use a connection directly over ToolBus with no app wrapper, and every installed or custom app reuses it by canonical name. Executor forces every connection into an app.
4. **Company-internal defaults:**
   - org-wide apps;
   - roles and per-app access at the gateway;
   - an **audit row per call for everyone** (an Enterprise line item at Executor);
   - approval links.
   Executor's default is "Only me" personal software.
5. **Both agent modes.** Executor v2 is code-mode only and has an open user request for passthrough (#2198). ToolBus can offer search/invoke by default and add code mode later.
6. **A stateless MCP core.** Executor v2 Cloud just added stateful MCP session Durable Objects, and it still loses paused programs and approvals on restart. Every App's plan (MCP 2026-07-28 stateless, durable single-use approval records) is a reliability advantage. Keep it.
7. **A Cloudflare-native self-host.** Executor dropped Cloudflare self-host in v2. Its Docker self-host has open issues: 5–10 GB memory growth, about 190 GiB/day of writes, 403s behind proxies.

### Watch list and risks

- **Executor could add curated "starter apps" quickly.** The registry, `@executor` scope, copy flow and `live-inbox` example already exist. Their velocity is very high (one founder plus agents).
- **Google verification:** if "Executor for Google" with full Gmail scopes clears review, Executor gets one-click Gmail, Calendar and Drive. Self-hosted Every App customers will need to register their own Google OAuth client; make that a guided five-minute flow.
- **Consent granularity:** Executor documents that its consent screen approves all apps. Ship per-app checkboxes on day one, as the Oct 4 read recommended.
- **ChatGPT:** Executor is positioning for ChatGPT (events, sign-in, domain verification). ToolBus's OAuth should work with ChatGPT connectors at launch.

---

## Corrections and additions to the Oct 4 read

- **v2 MCP surface:** v2 has **only** code mode (`skills`/`execute`/`resume`). The "search and invoke" passthrough and `?search_tools=true` are v1-only. The Oct 4 TL;DR item 2 applied "both versions" too broadly.
- **v2 app data limits** in Oct 4 item 1 (5,000 rows scanned, 1,000 returned, 4 MiB) are superseded by Durable Object SQLite with no row budget (since 2026-10-07).
- **"Running tools over MCP currently requires admin or owner"** (Oct 4 item 14) is superseded. Use now follows app audience; members can call tools.
- **A public app gallery and registry already existed on Oct 4** (first listing 2026-09-28) but was not covered. It is now at executor.sh/apps.
- **Per-person account selection** (Oct 4: "coming later") is now documented as shipped (profiles).
- **Operator-run OAuth clients** (Oct 4 item 9 described them for v1) now exist in v2 Cloud: GitHub, Google, and Slack (unlisted).

## Not verified

- Anything behind sign-in: whether Cloud app pages and app data are fully live (the live `/index.md` says "still in development", the docs say they work); whether the Google first-party client is enabled on Cloud; the real Quick-Add behavior for GitHub, Slack and Stripe.
- X/Twitter post bodies (HTTP 402). Rhys's statements here come from GitHub, the YC pages and executor.sh.
- Cloud user counts. Only proxies are available (npm, release downloads, stars).

---

## Sources (fetched 2026-10-12 unless noted)

- Homepage: https://executor.sh/ · Markdown: https://executor.sh/index.md · https://executor.sh/llms.txt · https://executor.sh/setup-prompt.md
- Pricing: https://executor.sh/pricing
- Docs: https://executor.sh/docs (and `/docs/connect-an-account`, `/docs/concepts/apps-and-deployments`, `/docs/mcp`, `/docs/concepts/organizations-and-access`, `/docs/run/self-host`, `/docs/run/cli`)
- App gallery: https://executor.sh/apps · Registry API: https://api.executor.sh/api/registry/apps · Cloud API: https://api.executor.sh/openapi.json
- MCP metadata: https://mcp.executor.sh/.well-known/oauth-protected-resource/mcp (v2) · https://executor.sh/.well-known/oauth-protected-resource/mcp (v1)
- Skills index: https://executor.sh/.well-known/agent-skills/index.json · About page: https://executor.sh/about-executor
- Repo: https://github.com/UsefulSoftwareCo/executor (v2 @ `9c0f2eb`, main @ `6682324`). Compare: https://github.com/UsefulSoftwareCo/executor/compare/828a680...v2
- Releases: https://github.com/UsefulSoftwareCo/executor/releases (beta.9–beta.15)
- PRs and issues: #2206, #2213, #2217, #2230, #2266, #2269 (v1 → v2 move); #2248 (Rhys: v2-only PRs); #2253 (no blank app); #2278 (Rhys: account on the app); #2198 (passthrough request); #2187, #2193, #2194, #2199, #2216, #2272
- npm: https://registry.npmjs.org/executor · https://registry.npmjs.org/apps · https://api.npmjs.org/downloads/range/last-month/executor
- integrations.sh: https://integrations.sh/ · https://integrations.sh/api.json · https://github.com/UsefulSoftwareCo/integrations
- YC: https://www.ycombinator.com/companies/executor · https://www.ycombinator.com/launches/SBH-executor-one-place-to-connect-your-agents-to-everything
- X (snippets only): https://x.com/RhysSullivan/status/2104702337562657253 (2026-09-28) · https://x.com/RhysSullivan/status/2084672219318452639 (2026-08-04)
- Third-party: https://www.bitdoze.com/executor-sh-vs-composio/ (updated 2026-09-25) · Podcast: https://kentcdodds.com/chats/07/10/primitives-agent-ux-and-executor-product-engineering-with-rhys-sullivan (2026-04-30)
- Key source files (v2 @ `9c0f2eb`):
  - `apps/marketing/src/content/site-copy.ts`
  - `packages/catalog/README.md`
  - `packages/ui/src/implementation/dashboard/{catalog,agent-setup}.tsx`
  - `apps/hosted/server/src/implementation/{catalog,first-party-oauth,organization-defaults}.ts`
  - `apps/hosted/web/src/implementation/pages/agent-setup.tsx`
  - `apps/hosted/cloud/src/contracts/onboarding.ts`
  - `apps/hosted/cloud/src/implementation/{host-roles,publishers,chatgpt-sign-in}.ts`
  - `apps/hosted/cloud/src/implementation/v1-import/*`
  - `apps/hosted/cloud/src/infrastructure/mcp-session*.ts`
  - `packages/app-templates/executor/skills/**`
  - `packages/sdk/src/implementation/remote-registry.ts`
  - `.changeset/*.md`
- Every App context: `docs/research/2026-10-platform-review/ROADMAP.md` (M3-2 ToolBus, M4-8 capabilities), `docs/research/2026-10-platform-review/raw/ref-executor.md`
