---
title: "MCP: tools, the connector and OAuth"
description: How an app defines agent tools with defineTools(), what the Gateway's one MCP address serves (app tools, built-in tools, MCP apps), how AI clients connect (OAuth, consent, personal tokens), and the switches.
---

An app never speaks MCP. It describes its tools with `defineTools()` and passes them to `everyApp(handler, { tools })`. The Gateway snapshots that catalog at deploy and serves every app the caller can open on one address, `https://<gateway>/mcp`, with the policy, argument checks, identity and audit. The person's side is [/docs/connect-ai](/docs/connect-ai).

## `defineTools()`

```ts
import { ToolError, defineTools, toolResult } from "@every-app/sdk/server";
import { z } from "zod";

export const tools = defineTools(
  {
    list_todos: {
      description: "List the caller's todos, newest first.",
      risk: "read",
      input: z.object({ limit: z.number().int().max(100).optional() }),
      handler: async ({ limit }, { user, env }) => listTodos(env, user.id, limit),
    },
    complete_todo: {
      description: "Mark one todo done.",
      risk: "write",
      input: z.object({ id: z.string() }),
      handler: async ({ id }, { user, env }) => {
        if (!(await completeTodo(env, user.id, id))) throw new ToolError("No todo with that id");
        return toolResult({ text: "Done.", structured: { id } });
      },
    },
  },
  { instructions: "Todos belong to the caller. Ids come from list_todos." },
);
```

- Names: lowercase snake_case, at most 48 characters. On the Gateway each becomes `<app>_<tool>`.
- Fields: `description`, `risk` and `input` are required; `handler` runs the tool. Optional: `title`, `output` (a result schema, sent as `structuredContent`), `destructive` (a write tool that deletes or can't be undone; sent as `destructiveHint`, so clients ask first), `idempotent`, `openWorld`. `instructions` is guidance across the app's tools (2048 characters).
- Schemas: zod 4.2+ (any Standard Schema with JSON Schema), or `{ jsonSchema, validate }`. The input must describe an object.
- The handler's context is `{ user, env, ctx, request, callId }`. Scope every read and write by `user.id`; a client never supplies the user.
- Results: a string is text; another value is JSON text; with `output`, the value is validated and sent as structured content too. `toolResult({ text, structured })` sends both. At most 1 MiB.
- Errors: throw `ToolError` for a message the model may read. Anything else reaches the client as `Internal error in <app> (ref <call id>)`.

Risk is `read` (needs `mcp:read`) or `write` (needs `mcp:write`; hidden from read-only connections). A tool that deletes is `risk: "write"` with `destructive: true`. A hidden tool answers `Unknown tool`, exactly like one that doesn't exist.

The Gateway re-reads an app's tools at each deploy and when the version changes. A connected client learns its tool list changed: a session-based client's stale `Mcp-Session-Id` answers 404 and it reconnects; a 2026-07-28 client gets `notifications/tools/list_changed` on its listen stream.

## The connector: `https://<gateway>/mcp`

Who can call it:

| Credential | Access | Apps |
|---|---|---|
| An OAuth token from the consent page | read & write or read only, as chosen | the chosen apps, or every app the person can open |
| A personal access token `Authorization: Bearer epat_…` | full access (`*`): read & write; read only (`mcp:read`) | the one app it's bound to, or every app the person can open |

Every request re-checks the connection, the person's role and access, so revoking, removing someone or taking an app away applies on the next call. Never a cookie, and never Cloudflare Access's signed header. Without a credential, `POST /mcp` answers 401 with the OAuth discovery pointer.

Listing modes: `full` lists the built-ins, the workspace tools the caller's role reaches, then every app tool. `compact` lists the built-ins only; it's used when the full listing would pass 256 tools or 1 MiB, or when asked for with the header `X-EveryApp-Tools: compact` (or `full`) or `/mcp?tools=compact`. The agent finds tools with `everyapp_search_tools` and calls them through `everyapp_call_read` or `everyapp_call_write`. The server's instructions start ``Tools for <org> on EveryApp. Each tool is named `<app>_<tool>`; call everyapp_list_apps.`` and name apps that need setup. Built-ins carry `_meta["anthropic/alwaysLoad"]` so Claude Code keeps them loaded.

Transport: Streamable HTTP, `POST` only, a body of at most 256 KiB. A browser `Origin` must be the Gateway's own or in `MCP_ALLOWED_ORIGINS`. An app has 30 seconds per call. Every call, allowed or not, is audited (Admin → Activity, `everyapp workspace activity`) and counted against the app's cap, if it has one.

## Built-in tools

Named under the reserved id `everyapp`, on the Gateway connector only.

- `everyapp_list_apps`, `everyapp_whoami`, `everyapp_search_tools`: answered from the caller's view.
- `everyapp_call_read`, `everyapp_call_write`: call any app tool by name (the compact listing's way in).
- `everyapp_my_tokens`, `everyapp_revoke_token`, `everyapp_my_connections`, `everyapp_revoke_connection`: the caller's own tokens and AI connections.

### Workspace tools

For owners and admins (what stays an owner's, like acting on another owner, is checked inside each tool), mirroring Manage workspace and `everyapp workspace` ([workspace](/docs/agent/workspace)): `everyapp_workspace_show`, `everyapp_workspace_rename`, `everyapp_workspace_linked_dev`, `everyapp_workspace_users`, `everyapp_workspace_invite`, `everyapp_workspace_uninvite`, `everyapp_workspace_role`, `everyapp_workspace_deactivate`, `everyapp_workspace_reactivate`, `everyapp_workspace_remove`, `everyapp_workspace_reset_email`, `everyapp_workspace_groups`, `everyapp_workspace_group_create`, `everyapp_workspace_group_set`, `everyapp_workspace_group_delete`, `everyapp_workspace_group_members`, `everyapp_workspace_group_members_set`, `everyapp_workspace_group_apps`, `everyapp_workspace_group_apps_set`, `everyapp_workspace_apps`, `everyapp_workspace_app_set`, `everyapp_workspace_app_access`, `everyapp_workspace_app_access_set`, `everyapp_workspace_app_cap`, `everyapp_workspace_cap_default`, `everyapp_workspace_app_delete`, `everyapp_workspace_usage`, `everyapp_workspace_activity`, `everyapp_workspace_audit`, `everyapp_workspace_events`, `everyapp_workspace_events_add`, `everyapp_workspace_events_set`, `everyapp_workspace_events_remove`, `everyapp_workspace_events_test`, `everyapp_workspace_event_deliveries`, `everyapp_workspace_event_redeliver`. The AI default: `everyapp_ai_show`, `everyapp_ai_default`. MCP apps: `everyapp_mcp_list`, `everyapp_mcp_show`, `everyapp_mcp_add`, `everyapp_mcp_remove`, `everyapp_mcp_on`, `everyapp_mcp_off`, `everyapp_mcp_refresh`, `everyapp_mcp_tool`.

No built-in ever returns a credential, and none sets one: keys go in with `everyapp secret set` or `configure`.

### Provider tools

`everyapp_provider_list`, `everyapp_provider_add`, `everyapp_provider_remove`, `everyapp_provider_connections`, `everyapp_provider_disconnect`: the API provider registry and people's OAuth connections, for owners and admins of a self-hosted Gateway. [providers](/docs/agent/providers)

### Sign-in provider tools

`everyapp_signin_list`, `everyapp_signin_show`: which sign-in providers are set up. Adding one needs its client secret, so it's `everyapp signin add` at a terminal. [signin](/docs/agent/signin)

## MCP apps

An MCP app is a set of tools the Gateway serves on its `/mcp` with no deployed app behind it. Its tools are `<id>_<tool>`, attributed to the member and audited like any other. DataForSEO is held to the app's cap; a remote app isn't metered (no cap, `APP_NOT_METERED`), though its calls are counted. The launcher lists them under "MCP apps"; their card opens "Use it from your agent".

- **Built-in**: DataForSEO, a curated tool set on the Gateway's `DATAFORSEO_API_KEY`. `everyapp mcp on dataforseo`, then `everyapp secret set DATAFORSEO_API_KEY` (either order).
- **Remote**: any MCP server by URL. `everyapp mcp add https://mcp.example.com/mcp` (`--name`, `--auth none|bearer|header|query|basic|oauth`, `--provider`, `--header`, `--client-id`, `--risk`, `--description`, `--from-env`). The Gateway lists the server's tools and forwards each call. The app's name and description are the server's own (`serverInfo`'s `title` and `description`, once it is listed) unless `--description` or Edit in Admin → Apps gives them. Guide: `setup/remote-mcp.md`.

### The credential: a provider

A remote app's credential is a provider row `<id>-mcp`, written with the app. Its host is the MCP URL's, so the credential goes nowhere else.

- `--auth bearer|header|query|basic`: a static key, `everyapp secret set <ID>_MCP_TOKEN`.
- `--auth oauth` (picked when the server's 401 names its OAuth metadata): `mcp add` discovers the authorization server and registers a client (DCR); a server that registers none but takes client metadata documents (CIMD, ElevenLabs') gets the URL of the document the Gateway serves, `https://<gateway>/oauth-clients/<id>-mcp`, as a public client's id; else `--client-id` takes one registered by hand. A host the Gateway holds a key for (`api.elevenlabs.io`) takes an OAuth server: each member's own token goes there, never the Gateway's key. Each member connects their own account in the app, at `/connect/<id>-mcp?app=<id>&return=/?mcp=<id>`. Until then their calls answer `Connect your <Provider> account to use this tool: <url>`. The discovered scopes go in the app's capability entry `{ scopes, why }`, `scopes_supported` is `tolerated`, and the scopes the server grants are kept as granted.
- `--provider <id>`: a provider the Gateway already has (`--provider elevenlabs`); the URL's host must be one of its hosts (`REMOTE_MCP_PROVIDER_HOST`).

Adding the app again with another credential replaces its `<id>-mcp` row and deletes its connections.

`mcp off` stops serving and keeps access and tokens; `mcp on` serves again; `mcp remove` deletes the app (its `<id>-mcp` row and key stay its organization's; `provider remove <id>-mcp` drops them). `mcp list` and `mcp show <id>` report the state; `mcp refresh <id>` re-lists a remote server's tools; `mcp tool <id> <tool> --risk read|write|annotations` or `--off` overrides one tool. A remote tool is `read` when the server hints `readOnlyHint`, else `write`. Admin → Apps → Add app → Add an MCP server does the same in the browser.

## Connecting clients

| Client | How |
|---|---|
| claude.ai, ChatGPT, VS Code, Codex | Give it `https://<gateway>/mcp`; it finds the OAuth server and opens the consent page. |
| Claude Code | `claude mcp add --transport http everyapp https://<gateway>/mcp`, then `/mcp` → everyapp → Authenticate. |
| Cursor, Gemini CLI, MCP Inspector | The same URL; they register with dynamic client registration (`/oauth/register`, `MCP_DCR_ENABLED`). |
| Scripts, anything that takes a header | A personal access token: `Authorization: Bearer epat_…`. |

The consent page shows the client and lets the person pick read & write or read only, and the apps (all, or some). Approving records a connection. People see and revoke theirs under the account menu → AI connections (`everyapp workspace connections`, `connection revoke`).

Personal access tokens are made in **Manage workspace → Tokens**: read only (`mcp:read`, the default) or full access, all apps or one app, for 7, 30 (the default) or 90 days or a year. The `epat_` value is shown once and only its hash is stored. Revoke with `everyapp workspace token revoke <id>`.

## The OAuth server

The Gateway is its own authorization server. Clients identify with a Client ID Metadata Document (CIMD) or register (`/oauth/register`). PKCE S256 is required. Discovery is at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`. Access tokens last an hour; a refresh grant lasts 30 days from its last use, so an idle connection lapses. Switches (Gateway settings): `MCP_OAUTH_ENABLED` (off: personal tokens only), `MCP_DCR_ENABLED`, `MCP_ALLOWED_ORIGINS`, `MCP_AUDIT_RETENTION_DAYS`.

Behind Cloudflare Access, `everyapp access on` lets `/mcp`, `/oauth/token`, `/oauth/register` and the discovery documents through Access, so AI clients connect as usual.

## An app host serves no MCP

The Gateway's `/mcp` is the one connector. On an app's host `/mcp` is a private route like any other, and a token holding only `mcp:` scopes opens nothing there. Locally, `http://<app-id>.localhost:8787/mcp` serves the app's live tools: [dev](/docs/agent/dev).
