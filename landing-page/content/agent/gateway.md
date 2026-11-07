---
title: Everything a Gateway offers
description: "The page an agent reads to make the most of a Gateway for a person: apps and MCP apps, the one MCP address, Manage workspace tab by tab, every CLI command by job, what to suggest next, and which other MCP servers to recommend."
---

## The shape

- **The Gateway**: the sign-in, the app launcher, **Manage workspace** (`/admin`, owners and admins) and the one MCP address `https://<gateway>/mcp`. Its state is a D1 database in the person's Cloudflare account. Setup, deploys, settings and status work under the Cloudflare login; the admin commands (`workspace`, `events`, `ai show|default`, `call`) call the Gateway's own tools as the signed-in person ([workspace](/docs/agent/workspace)). `everyapp status --json` is the one state query.
- **Apps**: each is its own Worker on `<app>.<app base domain>`, built from its `everyapp.config.ts` ([manifest](/docs/agent/manifest)) by `everyapp deploy`, or installed from a release with `everyapp install <GitHub URL>` ([deploy](/docs/agent/deploy)). An app gets only what its manifest declares, and every route is private unless listed under `public`. Build one with [Build an app](/docs/agent/build).
- **MCP apps**: tools the Gateway offers AI clients with no page and no Worker. DataForSEO is built in (`everyapp mcp on dataforseo`), and any MCP server can be added by URL (`everyapp mcp add <url>`). They're listed under "MCP apps" in Admin → Apps, not on the launcher. [mcp](/docs/agent/mcp#mcp-apps)
- **The one connector**: `https://<gateway>/mcp` serves every app and MCP app the caller can open, as `<app>_<tool>`, plus the built-ins named `everyapp_*`. When the catalog is large it lists compactly, and the agent finds tools with `everyapp_search_tools`. Owners and admins open every app; members open an app when it's available to everyone (the first deploy sets that from the manifest's `access: "everyone"`; `"admins"` is the default), granted to them, or held by one of their groups.

## Manage workspace

Owners and admins only. Each tab has a CLI command and an MCP tool: [workspace](/docs/agent/workspace).

| Tab | Route | What it does |
|---|---|---|
| **Users** | `/admin/users` | Invite (by email, or an invite link when the Gateway can't send mail), roles, password reset links, deactivate, reactivate, delete. Invite-only. |
| **Sign-in** | `/admin/sign-in` | The ways in: passwords, Cloudflare Access, the sign-in providers. Read-only; `everyapp signin` changes them. |
| **Apps** | `/admin/apps` | Every app and MCP app; **Manage access**, **Available to everyone**, edit, delete; **Add app** (install a release); **Add MCP server**. |
| **Groups** | `/admin/groups` | A set of members with the same apps. |
| **Tokens** | `/admin/tokens` | Personal access tokens: read-only (the default) or full access, all apps or one app, 7, 30 or 90 days or a year; shown once. |
| **Providers** | `/admin/providers` | API and OAuth providers, their keys or clients, people's connections; **Add OAuth provider**. |
| **Usage** | `/admin/usage` | Calls and cost per app, member and provider; **Default monthly cap** and each app's **Monthly cap** in dollars, **Paused** apps and **Raise**; the AI default. |
| **Activity** | `/admin/activity` | Every tool call by AI clients, allowed or blocked; the **Audit** toggle shows the audit log. |
| **Events** | `/admin/events` | Webhooks and email alerts. [events](/docs/agent/events) |

Each person manages their own AI connections under the account menu → AI connections.

## The CLI by job

All run as `everyapp …` (with `--json` for an agent); every flag is on [cli](/docs/agent/cli).

| Job | Command |
|---|---|
| Log in to Cloudflare; sign in to a Gateway for the admin commands | `everyapp login`; `everyapp login --gateway <url>` (or `EVERYAPP_TOKEN`) |
| Install, repair or update the Gateway | `everyapp setup --domain <host>`; `everyapp update` ([setup](/docs/agent/setup)) |
| Know the state of everything | `everyapp status --json` ([status](/docs/agent/status)) |
| Make an app | `everyapp create my-app`, then [Build an app](/docs/agent/build) |
| Run it locally | `everyapp dev` in its directory; `everyapp dev token` for scripts; `everyapp dev link` and `everyapp dev unlink` for linked dev ([dev](/docs/agent/dev)) |
| Put it online | `everyapp deploy` in its directory |
| Set up an app that says Needs setup | `everyapp configure <app>` |
| Set or list keys | `everyapp secret set NAME`, `everyapp secret unset NAME`, `everyapp secret list [<app>]` |
| Install or publish a release | `everyapp install <GitHub URL>`; `everyapp release` |
| Let the Gateway install apps itself | `everyapp deploy-token add`, `everyapp deploy-token remove` |
| Take an app off | `everyapp delete <id>` (`--purge` only when the person asks) |
| An app's database | `everyapp db query "<sql>"`, `everyapp db migrate`, `everyapp db restore` |
| Offer an MCP app | `everyapp mcp on dataforseo`, `everyapp mcp add <url>`, `everyapp mcp off <id>`, `everyapp mcp remove <id>`, `everyapp mcp list`, `everyapp mcp show <id>`, `everyapp mcp refresh <id>`, `everyapp mcp tool <id> <tool>` |
| The model apps get | `everyapp ai show`, `everyapp ai default <provider>[/<model>]`, `everyapp ai gateway on`, `everyapp ai gateway off` ([ai](/docs/agent/ai)) |
| API and OAuth providers | `everyapp provider add <id\|spec>`, `everyapp provider list`, `everyapp provider show <id>`, `everyapp provider remove <id>`, `everyapp provider presets`, `everyapp provider connections`, `everyapp provider disconnect <id>` ([providers](/docs/agent/providers)) |
| Events out | `everyapp events add <url>`, `everyapp events list`, `everyapp events remove <id>`, `everyapp events enable <id>`, `everyapp events disable <id>`, `everyapp events test <id>`, `everyapp events deliveries`, `everyapp events redeliver <id>`, `everyapp events types` |
| An app's email addresses | `everyapp email show`, `everyapp email set`, `everyapp email unset` ([email](/docs/agent/email)) |
| Cloudflare Access | `everyapp access on`, `everyapp access off`, `everyapp access show` ([access](/docs/agent/access)) |
| Sign-in providers | `everyapp signin add <id>`, `everyapp signin list`, `everyapp signin show <id>`, `everyapp signin remove <id>` |
| The workspace | `everyapp workspace …` ([workspace](/docs/agent/workspace)); any Gateway tool by name: `everyapp call <tool> [json]`, `everyapp call --list` |
| Read an agent docs page, online or off | `everyapp docs <page>` (`everyapp docs` lists them) |
| Empty a dedicated test account | `everyapp teardown --account-id <id> --dry-run`: refuses any account not on `EVERYAPP_TEST_ACCOUNTS`; never a person's Gateway |

Not a command: making a personal access token (Manage workspace → Tokens), and connecting an AI client (the client's own `mcp add`; [mcp](/docs/agent/mcp#connecting-clients)).

## What to suggest next

`everyapp status --json` lists at most four suggestions in `data.next`: an AI key (`AI_KEY`), an MCP app whose key is set (`PROVIDER_OFFER`) or whose key is missing (`PROVIDER_KEY`), Cloudflare Access (`ACCESS_OFF`), people to invite (`INVITE`), an AI client to connect (`CONNECT_AI`), a first app (`CREATE_APP`), email (`EMAIL_UNSET`). Offer each once while it's true, never more than four, and never one the person can't act on. A member gets one suggestion only: connect an AI client (`everyapp_whoami` says the role). To see which apps the team uses most, check `everyapp workspace usage --json`.

## Other MCP servers to recommend

A server the whole team should reach goes on the Gateway as an MCP app (`everyapp mcp add <url>`), so the Gateway holds its key, or each member connects their own account for an OAuth server. In each person's own client, recommend two:

- The Gateway's connector, `https://<gateway>/mcp`. Every member should have it.
- Cloudflare's, `https://mcp.cloudflare.com/mcp`, for the operator: reading the account (DNS, Workers, D1, Access, logs, billing) beyond what `everyapp status` and `access show` report. It's not for changing what everyapp manages: a Worker changed outside everyapp needs a person's confirmation before the next deploy.

Not needed: a GitHub server (`everyapp install` downloads releases anonymously; use `gh`), Cloudflare's separate docs server, or a docs MCP for EveryApp (these pages are Markdown at `https://everyapp.com/docs/agent/<page>.md`).
