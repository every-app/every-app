---
title: "Managing the workspace: the CLI and the MCP tools"
description: Everything the Gateway's admin UI does (people, roles, groups, who opens which app, caps, usage, activity, audit log, tokens, AI connections) as everyapp_workspace_* tools, which the everyapp workspace commands are thin clients of, who may do what, and what neither ever returns.
---

The admin UI (**Manage workspace** in the sidebar: Users, Groups, Apps, Tokens, Usage, Activity, Events, Sign-in, Providers; AI connections in the account menu) is one of three equal ways to run a workspace. The other two are the same tools:

| Surface | Who acts | Authority |
|---|---|---|
| `everyapp workspace …`, `everyapp call <tool>` | the person signed in to the Gateway (`EVERYAPP_TOKEN` or `everyapp login --gateway <url>`) | exactly the tools': each command is one `everyapp_*` tool, run through the Gateway's own services; one Activity row per call, client `everyapp-cli` |
| `everyapp_*` tools on `https://<gateway>/mcp` | the person behind an AI connection or personal token | their live role (re-read each call) and the connection's access |

Every UI action has a command and a tool, or a stated reason why not (the matrix is `docs/design/2026-10-agent-parity.md`, held by a test).

## Roles

- **Owner**: everything, including making and demoting owners. A workspace keeps at least one owner (`LAST_OWNER`).
- **Admin**: invites, removes members (not owners), manages apps, groups, caps and events. Owners and admins open every app.
- **Member**: opens the apps they're given; manages their own tokens and AI connections.

## Who can open an app

Owners and admins open every app through their role. Members open an app three ways: **Available to everyone** (every member, now and later; the first deploy sets it from the manifest's `access: "everyone"`), direct grants, and groups. `workspace app set <app> --everyone on|off`, `workspace app access <app> --add <email>`, `workspace group apps <group> --add <app>`.

## Caps

Each app's provider calls (AI and API providers) are counted per UTC month and can be capped in dollars of provider-reported cost. A **default cap** applies to every app without its own; `--unlimited` exempts one app. A capped app is **Paused**: its provider calls answer `429 app_monthly_cap_exceeded` until next month or a raise, while the app still opens. Owners and admins get an email at 80% and at the cap (the built-in Cap alerts subscription; the Gateway must send email). Caps count only providers that report a price (OpenRouter, DataForSEO); calls to others are counted but never move a cap. MCP servers added by URL aren't metered: no cap of their own or the default's (`APP_NOT_METERED` refuses one), and Usage shows them as Not metered (`notMetered` in `workspace usage`). Their calls are still counted and audited.

## `everyapp workspace`

Each command is one Gateway tool, run as you through the Gateway's admin API: its flags become the tool's arguments and the tool's answer is `done.data` under `--json`. `everyapp call <tool> [json]` runs any tool by name, apps' tools too; `everyapp call --list` lists what your credential may call.

**As whom.** `EVERYAPP_TOKEN` (a personal access token; a read-only or one-app token sees what it would on `/mcp`), else the sign-in `everyapp login --gateway <url>` stored in `~/.config/everyapp/gateways.json`, else that sign-in now: the browser opens at the Gateway's consent page (under `--json` its URL is in a `gateway.signin` progress event and the run waits). Choose read & write and all apps there: a grant narrowed to some apps sees no workspace tool. `everyapp login --gateway <url> --sign-out` revokes and forgets it. **Which Gateway**: `--gateway <url>`, else `EVERYAPP_GATEWAY_URL`, else the one this machine signed in to (`GATEWAY_AMBIGUOUS` among several), else the one the Cloudflare login finds. A refusal is `GATEWAY_TOOL_ERROR` with the Gateway's code in `data.code`; a refused credential `GATEWAY_REFUSED`.

People are named by email or user id, apps by manifest id or row id, groups by name or `grp_` id. `--yes` skips the confirmation of `remove` and `group delete`.

| Command | Tool |
|---|---|
| `workspace show` | `everyapp_workspace_show` |
| `workspace rename <name>` | `everyapp_workspace_rename` |
| `workspace users` | `everyapp_workspace_users` |
| `workspace invite <email> [--role admin]` | `everyapp_workspace_invite`: mailed when the Gateway sends email; never returns the link |
| `workspace uninvite <email\|id>` | `everyapp_workspace_uninvite` |
| `workspace role <email> <owner\|admin\|member>` | `everyapp_workspace_role` |
| `workspace deactivate <email>`, `workspace reactivate <email>` | `everyapp_workspace_deactivate`, `everyapp_workspace_reactivate`: deactivating ends every session and revokes tokens and AI connections |
| `workspace remove <email>` | `everyapp_workspace_remove` |
| `workspace reset-email <email>` | `everyapp_workspace_reset_email`: mails the member a reset link |
| `workspace groups`, `workspace group create <name> [--description]`, `workspace group set <group> [--name] [--description]`, `workspace group delete <group>` | `everyapp_workspace_groups`, `…_group_create`, `…_group_set`, `…_group_delete` |
| `workspace group members <group> [--add] [--remove] [--set]`, `workspace group apps <group> [--add] [--remove] [--set]` | `…_group_members(_set)`, `…_group_apps(_set)`; `--set` replaces the list |
| `workspace apps` | `everyapp_workspace_apps` |
| `workspace app set <app> [--name] [--description] [--everyone on\|off]` | `everyapp_workspace_app_set` |
| `workspace app access <app> [--add] [--remove] [--set]` | `everyapp_workspace_app_access(_set)`: direct grants |
| `workspace app cap <app> [<dollars>\|off] [--unlimited]` | `everyapp_workspace_app_cap`: dollars from 0.01 to 1,000,000, `off` for none of its own, `--unlimited` for no cap even under the default |
| `workspace cap default <dollars>\|off` | `everyapp_workspace_cap_default` |
| `workspace usage [--month YYYY-MM]` | `everyapp_workspace_usage`: calls and cost per app, member, provider and model |
| `workspace activity [--app] [--user] [--decision allowed\|blocked] [--risk read\|write] [--since] [--limit] [--before]` | `everyapp_workspace_activity`: tool calls, newest first |
| `workspace audit [--actor] [--type] [--since] [--limit] [--before]` | `everyapp_workspace_audit`: the audit log (90 days) |
| `workspace tokens [--all]`, `workspace token revoke <id>` | `everyapp_my_tokens`, `everyapp_revoke_token`: your own, never a value |
| `workspace connections`, `workspace connection revoke <id>` | `everyapp_my_connections`, `everyapp_revoke_connection`: your own |
| `workspace linked-dev [on\|off\|show]` | `everyapp_workspace_linked_dev`; `show` reads `linkedDev` from `everyapp_workspace_show` |
| `workspace invite-link <email\|id>` | none: a new link for a pending invitation, printed to hand over, written under the Cloudflare login (for a Gateway that sends no email) |
| `workspace reset-link <email>` | none: the recovery link, a one-hour reset link printed to hand over, written under the Cloudflare login: the way back in for an owner who can't sign in |

Nothing makes a personal access token but Manage workspace → Tokens.

## The MCP tools

Owners and admins see the `everyapp_workspace_*` tools; members see none. A read-only connection sees the read tools only, and a credential narrowed to some apps sees none of them. Everyone gets their own: `everyapp_my_tokens`, `everyapp_revoke_token`, `everyapp_my_connections`, `everyapp_revoke_connection`. The full list is on [mcp](/docs/agent/mcp#workspace-tools).

Rules every tool holds:

- No tool returns an invite link, a reset link or a token value, and none creates a token; the CLI's two links (`invite-link`, `reset-link`) come from the Cloudflare login instead. The one secret a tool returns is a new webhook's signing secret, once.
- `everyapp_workspace_remove`, `everyapp_workspace_app_delete` and `everyapp_workspace_events_remove` need `confirm: true`. `app_delete` removes the catalog row; the Worker stays until `everyapp delete`.
- A refusal is a tool error, `CODE: message`, with the UI's codes (`OWNER_REQUIRED`, `CANNOT_MANAGE_SELF`, `CANNOT_MANAGE_OWNER`, `USER_NOT_FOUND`, `APP_NOT_FOUND`, `INVALID_INPUT`). Every call is audited with an argument digest, never the arguments.
