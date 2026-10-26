---
title: The open apps
description: The apps EveryApp publishes, for an agent installing one for a person. Each app's manifest id, repository, install command, every setting it declares (required or optional, held by the Gateway or by the app), its public routes, who can open it, and whether it needs R2.
---

Five open source apps run behind a Gateway as the person's own: four the README, the docs home and the Gateway's empty home offer, and RepoLens. The user page for each is under [/docs/apps](/docs/apps); this page is the same facts as an agent needs them, from each app's `everyapp.config.ts` and README. The one-line descriptions here are the lines the README, the docs home and the Gateway's home print.

## The flow

1. `pnpm everyapp install <repository URL> --json` from the checkout: the repository's latest release's `everyapp-release.tar.gz` is deployed and the app is registered under its manifest id. `NO_RELEASE`: the repository publishes none (RepoLens, while private). `R2_NOT_ENABLED`: the person enables R2 once in the Cloudflare dashboard (R2 Object Storage, Get started), then rerun. [The deploy pipeline](/docs/agent/deploy)
2. `pnpm everyapp configure <id>` from any directory: asks for every setting the manifest declares that isn't set, Gateway settings and the app's own alike, and sets each where it belongs. Without a terminal, pipe `NAME=value` lines or export the names and add `--from-env`. [Secrets, Gateway settings and capabilities](/docs/agent/secrets)
3. `pnpm everyapp status --json`: the app leaves **Needs setup** once its required settings are set. [`everyapp status`](/docs/agent/status)
4. Update: the same `install` command again. The deploy saves a restore point before it migrates the app's database.

A Gateway setting is held once for every app: `OPENROUTER_API_KEY` serves OpenSEO, OpenCRM and OpenMail at once, `CONTEXT_API_KEY` serves OpenSEO and OpenCRM, `EMAIL_FROM` serves OpenAnalytics and OpenMail. The setup skill has a file per key with where it comes from and a smoke check: `setup/openrouter.md`, `setup/dataforseo.md`, `setup/context.md`, `setup/email.md`, `setup/google.md`, `setup/microsoft-365.md`, `setup/slack.md`.

| id          | Name          | Repository                                  | R2  | Who opens it after the install                                |
| ----------- | ------------- | ------------------------------------------- | --- | ------------------------------------------------------------- |
| `openseo`   | OpenSEO       | https://github.com/every-app/open-seo       | yes | every member (`access: "everyone"`)                           |
| `crm`       | OpenCRM       | https://github.com/every-app/open-crm       | yes | every member                                                  |
| `analytics` | OpenAnalytics | https://github.com/every-app/open-analytics | no  | every member                                                  |
| `openmail`  | OpenMail      | https://github.com/every-app/open-mail      | yes | every member; owners and admins manage mailboxes              |
| `repolens`  | RepoLens      | private today, no public address yet        | no  | the deployer, owners and admins; grant others in Admin → Apps |

## OpenSEO (`openseo`)

SEO research, rank tracking, site audits and AI visibility for your sites.

```bash
pnpm everyapp install https://github.com/every-app/open-seo
pnpm everyapp configure openseo
```

| Setting                                                                                                                                                    | Held by | Need     | Why (from the manifest)                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENROUTER_API_KEY` (provider `openrouter`)                                                                                                               | Gateway | required | SAM, prompt suggestions and website research run on it.                                                                                                                  |
| `DATAFORSEO_API_KEY` (capability `dataforseo`, read)                                                                                                       | Gateway | required | Keyword, SERP, backlink, local business and AI answer data, including scheduled rank checks. The value is `login:password` from the DataForSEO dashboard, or its base64. |
| `CONTEXT_API_KEY` (capability `context`, read)                                                                                                             | Gateway | optional | Renders JavaScript-heavy pages when a site audit asks for it.                                                                                                            |
| `GOOGLE_WORKSPACE_CLIENT_ID`, `GOOGLE_WORKSPACE_CLIENT_SECRET` (capability `google-workspace`, scopes `identity`, `search-console.read`, `analytics.read`) | Gateway | optional | Search Console and GA4 reads for your sites, with the Google account you connect in Every App.                                                                           |
| `CRAWLER_ACCESS_SECRET`                                                                                                                                    | app     | optional | Encrypts the Shopify crawler-access signatures that audits of protected stores send. Any string of 32+ characters.                                                       |
| `OPENROUTER_MODEL`                                                                                                                                         | app     | optional | Picks the OpenRouter model for SAM, prompt suggestions and website research (default `openai/gpt-5.6-luna`).                                                             |

Resources: D1 `DB`, KV `KV`, Durable Objects `SAM_CHAT` and `AUDIT_SCRATCHPAD`, Workflows `RANK_CHECK_WORKFLOW`, `AI_VISIBILITY_WORKFLOW` and `SITE_AUDIT_WORKFLOW`, a helper Worker `audit` (the site-audit engine, bound as `AUDIT_ENGINE`), and an R2 bucket named after the Worker. Migrations: drizzle, `drizzle/sqlite`. `public: []`. Every tool is served through the Gateway's connector as `openseo_<tool>`; the app's own `/mcp` is off in this mode.

## OpenCRM (`crm`)

Companies, contacts and deals, kept up to date by a research agent.

```bash
pnpm everyapp install https://github.com/every-app/open-crm
pnpm everyapp configure crm
```

| Setting                                                                                                                                     | Held by | Need     | Why (from the manifest)                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any model provider's key (`ai: { chat }`; OpenRouter first)                                                                                 | Gateway | required | The research agent's model, through the Gateway's default model provider.                                                                                   |
| `OPENROUTER_API_KEY` (provider `openrouter`)                                                                                                | Gateway | optional | Web research through Perplexity's Sonar models and OpenRouter's web search tool.                                                                            |
| `CONTEXT_API_KEY` (capability `context`, read)                                                                                              | Gateway | required | Company brand data, LinkedIn profiles and website extraction for the research agent.                                                                        |
| `GOOGLE_WORKSPACE_CLIENT_ID`, `GOOGLE_WORKSPACE_CLIENT_SECRET` (capability `google-workspace`, write, scopes `gmail.read`, `calendar.read`) | Gateway | optional | Members connect their Gmail and Google Calendar, read only, so their work conversations and meetings are filed on companies and contacts.                   |
| `MICROSOFT_365_CLIENT_ID`, `MICROSOFT_365_CLIENT_SECRET` (capability `microsoft-365`, write, scopes `identity`, `mail.read`)                | Gateway | optional | Members connect their Outlook mail, read only, so their work conversations are filed on companies and contacts.                                             |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` (capability `slack`, write)                                                                        | Gateway | optional | Connects the workspace's Slack so team agents can post to an approved channel.                                                                              |
| `TOKEN_ENCRYPTION_KEY`                                                                                                                      | app     | optional | Needed before anyone connects mail, a calendar or Slack: their tokens are encrypted under it. 32 or more random characters, e.g. `openssl rand -base64 32`. |
| `GITHUB_TOKEN`                                                                                                                              | app     | optional | Raises GitHub's rate limit when the agent matches people to GitHub profiles. Any classic token with no scopes will do.                                      |
| `AGENT_MODEL`                                                                                                                               | app     | optional | The model id the agent runs on, as the Gateway's default provider names it; empty takes the operator's default.                                             |
| `ERASURE_SECRET`                                                                                                                            | app     | optional | Set only while an operator erases an organization: it signs the erasure requests. Unset it afterwards.                                                      |

Resources: D1 `DB`, Durable Object `CRM_AGENT`, an R2 bucket named after the Worker, a cron every minute (the agent's dispatcher). Migrations: drizzle, `drizzle/sqlite`. Public routes: `GET /t/*` and `POST /t/e` (website tracking on the organization's own site), `POST /internal/erase-organization` (404 while `ERASURE_SECRET` is unset). The agent spends the person's OpenRouter and Context.dev accounts: at most about $0.25 per researched record plus web searches; a daily credit limit on the OpenRouter key bounds it, and **Research automatically** in Settings → Workspace turns the automatic research off.

## OpenAnalytics (`analytics`)

Web analytics for your sites. No cookies, no stored IP addresses.

```bash
pnpm everyapp install https://github.com/every-app/open-analytics
pnpm everyapp configure analytics
```

| Setting                                                     | Held by | Need           | Why (from the manifest)                                                                                                                                |
| ----------------------------------------------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MAIN_SECRET`                                               | app     | required       | The root secret for visitor salts and collect tokens; 32 or more random characters, e.g. `openssl rand -base64 32`. Changing it splits visitor counts. |
| capability `members` (read)                                 | Gateway | nothing to set | Sends reports and alerts only to people who can still open the app.                                                                                    |
| `EMAIL_FROM`, `EMAIL_FROM_NAME` (capability `email`, write) | Gateway | optional       | Emails scheduled reports and alerts to members who turned email notifications on.                                                                      |

Resources: D1 `DB`, KV `SITE_SETTINGS_KV`, Durable Object `INGEST_DO` (one per site). Migrations: `d1-sql`, `migrations/`. No R2. Public routes: `GET /script.js`, `POST /collect`, `GET /share/**`, `GET /:locale/share/**`, `GET /api/public/share/**`, `GET /api/public/resources/**`, `GET /assets/**`, `GET /images/**` and the icon files. The tracking snippet is `<script defer src="https://analytics.<gateway domain>/script.js?siteId=<id>"></script>`; the tracker posts `text/plain`, so there is no preflight and `OPTIONS` stays private.

## OpenMail (`openmail`)

A team inbox with an AI agent that reads, drafts and sends email on your domain.

```bash
pnpm everyapp install https://github.com/every-app/open-mail
pnpm everyapp configure openmail
pnpm everyapp email set --sender '*@example.com' --inbound '*@example.com'
```

| Setting                                                     | Held by | Need     | Why (from the manifest)                                                                                        |
| ----------------------------------------------------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| Any model provider's key (`ai: { chat }`; OpenRouter first) | Gateway | required | The inbox agent's model, with the prompt-injection scanner and the draft verifier.                             |
| `EMAIL_FROM`, `EMAIL_FROM_NAME` (capability `email`, write) | Gateway | required | Sends mail from the organization's mailboxes on its own domain.                                                |
| provider `openrouter`                                       | Gateway | optional | Only for a Worker built with `AI_PROVIDER=openrouter` (a pin); the default model needs no provider of its own. |
| provider `workers-ai`                                       | Gateway | optional | Only for a Worker built with `AI_PROVIDER=workers-ai` (a pin); the default model needs no provider of its own. |

No secrets of its own. `email: { inbound: true }`: the Worker has an `email()` handler, and the installation's addresses are set after the deploy with `everyapp email set --sender <pattern> --inbound <address>`, which creates the Email Routing rules (a `*@<domain>` catch-all exists only on a zone's apex; a subdomain needs literal addresses) and offers to enable Email Routing (`--enable-email-routing` unattended). Each sending domain must be on Cloudflare DNS in the Gateway's account and onboarded to the Gateway's email provider. [Email](/docs/agent/email). Resources: Durable Objects `MAILBOX` and `EMAIL_AGENT` (SQLite), an R2 bucket named after the Worker. `public: []`. Mail to an address with no mailbox is dropped.

## RepoLens (`repolens`)

Keeps the GitHub traffic, star, fork and download history GitHub forgets.

The repository is private at the time of writing, so there is no URL to `install` from (an install by URL would answer `NO_RELEASE`: no anonymous download). A person with access clones it beside the checkout, runs `pnpm install` in it, and deploys with the checkout's CLI from its directory: `node ../every-app/packages/cli/bin/everyapp.js deploy`, then `pnpm everyapp configure repolens`. When it is public, the install is `pnpm everyapp install <repository URL>` like the others.

| Setting        | Held by | Need     | Why (from the manifest)                                                                                                                                                              |
| -------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_TOKEN` | app     | required | Reads the repositories RepoLens tracks: a classic token with the repo scope, or a fine-grained token with Administration, Contents and Metadata read (traffic needs Administration). |

Resources: D1 `DB`. Migrations: drizzle, `drizzle/`. No R2. A cron `17 */6 * * *` captures every six hours. Public route: `GET /badge/*/*.svg` (cached an hour; works for tracked private repositories too). No `access` in the manifest, so a fresh install opens to the deployer, owners and admins; `workspace app access` or Admin → Apps grants the rest. Tools: `repolens_list_repos`, `repolens_get_repo_stats`, `repolens_track_repo`, `repolens_capture_now`.

## Not here

Mission Control (`mission-control`), OpenSEO's own metrics dashboard, runs on a Gateway too, but reads OpenSEO's production database, PostHog project and Stripe account; it isn't reusable as it stands and has no public repository.
