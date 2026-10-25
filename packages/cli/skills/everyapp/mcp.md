# Agent tools (MCP)

An app never speaks MCP. It describes its tools with `defineTools()` in
src/tools.ts and passes them to `everyApp(handler, { tools })`; the Gateway
snapshots that catalog and serves AI clients at `https://<gateway>/mcp` (every
app the caller can use, tools named `<app-id>_<tool>`). An app's own host
serves `https://<app-host>/mcp` (that app alone) only when everyapp.config.ts
says `mcp: { by: "gateway", why: "..." }`; leave it out (the default), and
point clients at the Gateway. Never add an MCP server, an /mcp route, a login
or a token check to an app. Full reference: https://everyapp.com/docs/agent/mcp.md (in a
checkout landing-page/content/agent/mcp.md); the person's steps: https://everyapp.com/docs/connect-ai.

## Define tools: src/tools.ts

The starter's shape (starter/src/tools.ts, shortened; the queries and their zod
schemas live in starter/src/server/todos.ts, shared with the server functions):

```ts
import { ToolError, defineTools } from "@every-app/sdk/server";
import { z } from "zod";
import * as todos from "@/server/todos";

export const tools = defineTools(
  {
    list_todos: {
      description: "List the user's todos, completed ones included.",
      risk: "read",
      input: z.object({}).strict(),
      handler: (_input, { user }) => todos.listTodos(user.id),
    },
    create_todo: {
      description: "Add a todo. The server assigns its id.",
      risk: "write",
      idempotent: false,
      input: todos.createTodoInput,
      handler: (input, { user }) => todos.createTodo(user.id, input),
    },
    delete_todo: {
      description: "Delete one todo for good.",
      risk: "destructive",
      input: todos.deleteTodoInput,
      handler: async (input, { user }) =>
        (await todos.deleteTodo(user.id, input)) ?? raise("No todo with that id"),
    },
  },
  {
    instructions:
      "Never guess todo ids: call list_todos first when an id isn't already known.",
  },
);

/** A message the model may read; any other error reaches it as "Internal error". */
function raise(message: string): never {
  throw new ToolError(message);
}
```

Register them once, in src/entry.worker.ts:
`export default everyApp<Env>(async (request) => tanstackEntry.fetch(request), { tools });`

Names:   lowercase snake_case, a letter first, at most 48 characters; on the
         Gateway connector `<app-id>_<tool>` must fit 64 or the tool is skipped.
Fields:  `description` (required; the model reads it; over 2048 characters the
         Gateway skips the tool), `risk` (required), `input` (required: zod 4.2
         or later, any Standard Schema with JSON Schema support, or a plain
         `{ jsonSchema, validate }`; it must describe an object),
         `handler(input, context)` (required), `idempotent` (boolean, sent as
         `annotations.idempotentHint`), `title`, `output` (an object schema,
         validated and sent as `structuredContent`), `openWorld`. Second
         argument `{ instructions }`: guidance across the tools, at most 2048;
         on the Gateway connector it is clipped to 1024 and placed after the
         app list, and Claude Code shows the model only the first 4,096
         characters of the whole (Codex's docs ask that the first 512 stand
         alone), so put what matters first.
Risk:    "read": listed and callable for every caller (`readOnlyHint: true`).
         "write": hidden from read-only connections (`read_only_connection`).
         "destructive": hidden from every AI client until approvals exist
         (`destructive_requires_approval`): absent from tools/list, a call
         answers `-32602 Unknown tool: <name>`. Keep the handler.
Context: the handler's second argument: `user` (the verified caller: `id`,
         `email`, `orgId`, `orgRole`, `channel: "mcp"`, `actor.sub` of
         `pat:<token id>`, `oauth:<connection id>` or `access:<email>`,
         `scopes` of `["mcp:read"]` or `["mcp:read", "mcp:write"]`, and
         `toolCall` with this call's `id` and `name`), `env`, `ctx`, `request`
         (the internal `POST /__everyapp/tools/call`), `callId`. Scope every
         read and write by `user.id`: a client never supplies a user id.
Results: a string (one text block), any JSON value (a JSON text block), a value
         checked by `output` (text plus `structuredContent`), or
         `toolResult({ text, structured })`. At most 1 MiB reaches the client.
Errors:  throw `new ToolError("No todo with that id")` for a message the model
         may read (`isError: true`). Any other error is logged in the app as
         `[everyapp] tool "<name>" failed (ref <callId>): …` and reaches the
         client only as `Internal error in <app-id> (ref <callId>)`.
A bad definition throws at module load (`defineTools: tool "<name>" needs a risk: "read", "write" or "destructive"`),
so the Worker fails rather than serving a catalog without the tool; a schema with
no object JSON Schema form only skips that tool with a warning (`TOOLS_CATALOG` in dev).

MCP apps: the Gateway also serves tools that aren't any app's, with no page
and nothing to deploy, on the same /mcp under the same access rules: a data
provider's built in (DataForSEO: `dataforseo_<tool>`, once the operator runs
`pnpm everyapp mcp on dataforseo` and sets DATAFORSEO_API_KEY), and any remote
MCP server added by URL (`pnpm everyapp mcp add <url> --auth bearer`, its tools
`<id>_<tool>`). For a remote server the Gateway holds the credential (the
Gateway setting `<ID>_MCP_TOKEN`, pinned to the URL's origin), forwards each
call, and decides each tool's risk from the server's annotations (no hint
counts as `write`; `mcp tool <id> <tool> --risk …` overrides one). `mcp off`
stops serving and keeps access; `mcp remove` deletes it. Never wrap a
remote MCP server in an app of your own to put it behind the Gateway: add it
(setup/remote-mcp.md, SKILL.md "MCP apps").

## What the Gateway does with them

Snapshot: the Gateway stores each app's catalog in D1 with the app version it
came from, taken when the app is activated (the first deploy: the CLI waits
for the app to go live, so the catalog exists before anyone connects), when a
deploy through the Gateway (a browser install) finishes a new version, on the first app-host request each
isolate sees after a self-hosted redeploy, when `/mcp` or the consent page
finds a missing or outdated snapshot (synced within the request, 3 s budget),
and when a call reports a drifted `catalogHash` or `unknown_tool`. The CLI's
deploy syncs nothing itself. One sync: `POST /__everyapp/tools/list` (15 s, a
5 MiB response; no count cap per app: a catalog is bounded by its per-tool
limits, the response size and one atomic D1 write); status `ok`, `empty`,
`unsupported` (SDK older than 0.3) or `error` (retried at most every 5
minutes); logged as `mcp.catalog.sync`.
Calls:   `tools/list` never calls the app. `tools/call` checks the arguments
         against the snapshot, mints a 120 s identity JWT for that one call
         (`chan: "mcp"`, explicit scopes, `tc: { id, name }`), makes one
         `POST /__everyapp/tools/call` (30 s) and audits one `mcp_tool_calls` row.
Built-ins (Gateway connector only; always loaded in Claude Code):
         `everyapp_list_apps` (the apps this connection can use; one that
         needs setup is `available: false` with the command an admin runs;
         for an owner or admin of the install organization, an MCP app
         that is off while its key is set, and no deployed app lists its
         capability, is `offered: true` with `pnpm everyapp mcp on <id>`,
         and the instructions' head says the same in one line),
         `everyapp_whoami` (user, org, access), `everyapp_search_tools`
         (`{ query?, app?, limit? }`: finds callable tools by words, by app
         id or both, with their input schemas; read-only), and the two call
         wrappers `everyapp_call_read` and `everyapp_call_write`
         (`{ name, arguments? }`: run one app tool by its `<app-id>_<tool>`
         name; the read wrapper runs read tools only with `mcp:read` alone,
         the write wrapper is hidden from read-only connections). A wrapped
         call is the same one call: same policy, checks and identity, and
         one audit row naming the inner tool with `via` set to the wrapper.
Workspace tools (Gateway connector only; every admin action of the UI, listed
         in full mode to a caller whose role reaches each; a read-only
         connection never sees a write one; a token bound to one app or a
         connection consented to some apps sees none of them; never a
         credential that opens the Gateway; one audit row per call under app
         `everyapp`): owners and admins get
         `everyapp_workspace_show`, `everyapp_workspace_users`,
         `everyapp_workspace_invite` (never the link), `everyapp_workspace_uninvite`,
         `everyapp_workspace_role`, `everyapp_workspace_deactivate`,
         `everyapp_workspace_reactivate`, `everyapp_workspace_reset_email`,
         `everyapp_workspace_groups`, `everyapp_workspace_group_create`,
         `everyapp_workspace_group_set`, `everyapp_workspace_group_delete`,
         `everyapp_workspace_group_members`, `everyapp_workspace_group_members_set`,
         `everyapp_workspace_group_apps`, `everyapp_workspace_group_apps_set`,
         `everyapp_workspace_apps`, `everyapp_workspace_app_set`,
         `everyapp_workspace_app_access`, `everyapp_workspace_app_access_set`,
         `everyapp_workspace_app_cap`, `everyapp_workspace_cap_default`,
         `everyapp_workspace_usage`, `everyapp_workspace_activity`,
         `everyapp_workspace_audit` (the audit log: who did what, 90 days),
         `everyapp_workspace_rename`, and the
         events tools `everyapp_workspace_events`, `everyapp_workspace_events_add`
         (a generated signing secret comes back once, in that answer: it opens
         nothing on the Gateway, so the person stores it in the receiver now),
         `everyapp_workspace_events_set`, `everyapp_workspace_events_remove`
         (asks `confirm: true`; Cap alerts is turned off instead),
         `everyapp_workspace_events_test`, `everyapp_workspace_event_deliveries`,
         `everyapp_workspace_event_redeliver`, `everyapp_workspace_remove`
         and `everyapp_workspace_app_delete` (the last two ask `confirm: true`;
         an admin never removes an owner); every member gets their own
         `everyapp_my_tokens`, `everyapp_revoke_token`, `everyapp_my_connections`
         and `everyapp_revoke_connection`. A user is an email or id, an app a
         manifest id or row id, a group a name or `grp_` id, an event
         subscription a name or `sub_` id. MCP apps, the
         `mcp` commands as tools: `everyapp_mcp_list`, `everyapp_mcp_show`,
         `everyapp_mcp_add` (a credential's setting name, never its value; the
         answer names `secret set`), `everyapp_mcp_on`, `everyapp_mcp_off`,
         `everyapp_mcp_refresh`, `everyapp_mcp_tool` and
         `everyapp_mcp_remove` (`confirm: true`). Full reference:
         /docs/agent/mcp#workspace-tools.
Provider tools (Gateway connector only; one audit row per call like the
         workspace tools): every member gets `everyapp_provider_list` (the
         API providers this Gateway brokers, catalog and rows, with their
         settings and hints and which of this organization's apps list
         each; set-ness and the key binding for owners and admins only);
         owners and admins on a self-hosted Gateway also get
         `everyapp_provider_add` (`{ spec }`: the spec object, never a URL,
         never a replace of a row that is there) and
         `everyapp_provider_remove` (`{ id }`: refuses a built-in, a row
         whose key is set, and a row an app lists). A hosted Gateway hides
         both writers. No key is ever set through a tool: `everyapp secret
         set NAME` from the terminal. Full reference:
         /docs/agent/mcp#provider-tools.
Sign-in provider tools (Gateway connector only, owners and admins, reads):
         `everyapp_signin_list` (Manage workspace → Sign-in: each sign-in
         provider on, off or needing setup, its settings by name with
         whether each is set, the redirect URL to register and the
         command) and `everyapp_signin_show` (`{ id }`). Never a value, and
         no tool adds or removes a provider: `pnpm everyapp signin add
         <id>` from the terminal. Full reference:
         /docs/agent/mcp#sign-in-provider-tools.
Listing: full (the built-ins, the workspace tools, then every tool) until a connection's full list
         would pass 256 tools or 1 MiB, then compact (the built-ins only:
         find tools with `everyapp_search_tools`, run them through the
         wrappers or by name); `X-EveryApp-Tools: full|compact` chooses
         for any caller that can set a header, `?tools=` on /mcp for a
         personal token, an Access caller or Claude Code (the header first
         when both are given); claude.ai, Claude Desktop and ChatGPT need
         the OAuth resource to equal the URL typed, so for them the query
         form fails to connect and the bare /mcp gets the automatic rule.
         Compact hides nothing: an unlisted tool is still callable; a
         hidden one stays `Unknown tool`. A read-only connection is told
         to use `everyapp_call_read` alone.
Changes: 2026-07-28 clients (Claude Code) hold a `subscriptions/listen` stream
         re-read every 30 s, so a change reaches them within about half a
         minute; the Gateway ends it after 30 minutes (an app host after 10,
         and never past the token's expiry) and the client opens a new one,
         few enough an hour that Claude Code keeps listening indefinitely;
         2025-era clients get `notifications/tools/list_changed` and a
         new `Mcp-Session-Id` on their next request (a stale session's
         `tools/list` answers 404, so the client initializes again).
         `tools/list` carries `ttlMs: 60000` (a minute's cache).

## Local: pnpm everyapp dev

`pnpm everyapp dev` prints `http://<app-id>.localhost:8787/mcp` under "MCP" in
its ready block: a local ToolBus with the Gateway's policy, argument checks and
identity contract, serving the app's live `defineTools()` catalog, re-read
every 2 s, so an edit shows on the next request. In the default stub mode any
bearer value acts as the seeded dev user; in `--mode mirror` it takes a
personal access token from the local Gateway. Each call prints
`MCP  <tool>  <outcome>  <ms>ms` or `MCP  <tool>  blocked: <reason>` (two
spaces between parts; outcome and reason codes are printed as words: `tool
error`, `destructive requires approval`). Claude Code:

```bash
claude mcp add --transport http todo-local http://<app-id>.localhost:8787/mcp --header "Authorization: Bearer dev"
```

Caveat: the dev ToolBus declares `listChanged: false`, so Claude Code sees
tools added to `defineTools()` only after reconnecting (`/mcp`, the server).

## Connecting a person

Claude Code (2.1.81 and later), then `/mcp`, choose **everyapp**, choose
**Authenticate**, allow in the browser; `everyapp_whoami` confirms the account:

```bash
claude mcp add --transport http everyapp https://<gateway>/mcp
```

claude.ai, Claude Desktop, ChatGPT: a custom connector with the URL
`https://<gateway>/mcp`; the client identifies itself with a Client ID
Metadata Document (CIMD), finds the OAuth server from the 401 challenge, and
the consent page opens. Cursor, Gemini CLI, MCP Inspector: the same URL, after
dynamic client registration (`/oauth/register`; `MCP_DCR_ENABLED` controls it).
Consent page: the organization, **All apps I can use, including future ones**
or **Only these apps**, read & write (default) or **Read only**, then
**Allow**. It grants `mcp:read` and, for read & write, `mcp:write`; an app
shown as `(no AI tools yet)` has a snapshot with no tools; one with no
snapshot yet shows no hint (its tools load on first use).
Scripts and anything that takes a header: a personal access token. In the
Gateway open **Admin** (the sidebar footer's **Manage workspace**; owners and
admins only), tab **Tokens**, heading **Personal access tokens**, button
**New token**: a name, **All my apps** or one app, an expiry (default
90 days). The token is `epat_…`, shown once, read & write. Send it as
`Authorization: Bearer epat_…` to `https://<gateway>/mcp` (a token made for one
app sees that app alone):

```bash
claude mcp add --transport http everyapp https://<gateway>/mcp --header "Authorization: Bearer $EVERYAPP_TOKEN"
```

`https://<app-host>/mcp` takes the same header only where that app's manifest
sets `mcp: { by: "gateway", why }`; on any other app host the path is the app's
own private route and an MCP-only token gets 403 `token_scope` everywhere.

Disconnecting: **AI connections** in the account menu at the bottom of the
sidebar (`/settings/connections`) lists each OAuth connection; revoking one
makes the client's next request fail `invalid_token`. Removing or
deactivating a person ends all of theirs; tokens are revoked on Admin, Tokens.

Other servers worth having beside the Gateway's (Cloudflare's API server for
the owner, read before write; nothing else): [setup/gateway.md](setup/gateway.md),
"Optional: MCP servers worth having beside Every App". Offer one in a line;
never add it unasked.

## Troubleshooting

Tools missing after a deploy, in order: (1) the client's cache: tools/list is
good for 60 s and a held stream polls every 30 s, so list tools again after a
minute; (2) the snapshot: read `mcp.catalog.sync` in the Gateway's logs
(`unsupported`: an SDK older than 0.3; `error`: the app's tools endpoint
failed, retried in 5 minutes; a self-hosted redeploy is noticed from the app
host's next request in each isolate); (3) hidden on purpose: destructive
tools are never listed, write tools are hidden from a read-only connection
(`everyapp_whoami` shows `access`), and a tool whose namespaced name passes 64
characters, whose description passes 2048 or whose schema isn't an object is
dropped with a warning (dev prints it as `TOOLS_CATALOG`); unlisted is not
hidden: a compact listing (the instructions' first line says the connection
"lists its tools compactly") leaves every app tool out of tools/list on
purpose, and each is found by `everyapp_search_tools` and callable by name or
through `everyapp_call_read`/`everyapp_call_write`, while a hidden tool stays
`Unknown tool` there too; (4) the person
cannot open the app: it is absent from `everyapp_list_apps`; grant access in
Admin (a connection made with **Only these apps** needs a reconnect to add one).
401 vs 403 on `/mcp`: 401 means no credential or one that doesn't verify (an
expired or revoked token, a bearer that isn't `epat_` on an app host, the token
of a revoked connection); its body depends on the surface. On
`https://<gateway>/mcp` with OAuth on: an empty body and
`WWW-Authenticate: Bearer realm="OAuth", resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="mcp:read"`
(`error="invalid_token"` added when a token was sent); a revoked connection's
token gets `{"error":"invalid_token","error_description":"This connection was revoked or lost its access. Connect again."}`.
On `https://<app-host>/mcp` (where the manifest sets `mcp`), and on the Gateway with OAuth off:
`{"error":"unauthenticated"}` with `WWW-Authenticate: Bearer realm="every-app"`
(`error="invalid_token"` when a bearer was sent; the app host adds
`error_description="Use a personal access token here, or connect <gateway>/mcp"`).
An app host without `mcp` in its manifest answers `/mcp` as the app does (usually 404),
and one with `by: "gateway"` but no catalog to serve answers 503 `{"error":"mcp_unavailable"}`.
403 `{"error":"forbidden","reason":…}` means the credential verified and was
refused: `token_scope` (scopes without `mcp:read` or `mcp:write`, an
MCP-only token on a page route, or any route of a host without `mcp`), `no_app_access` (app host: the person cannot
open this app), `not_connected`, `organization_unresolved`, `account_deactivated`, `organization_suspended`.
OAuth off: `MCP_OAUTH_ENABLED` is `false`, or `GATEWAY_URL` is neither https
nor http on exactly localhost or 127.x: `/oauth/*` and the discovery documents
answer 404 `oauth_disabled`, `/mcp` takes `epat_` tokens only and its 401 says
`WWW-Authenticate: Bearer realm="every-app"` with no authorization server. Turn
it on with `pnpm everyapp secret set MCP_OAUTH_ENABLED`, entering `true` (live at once).
DCR off or limited: with `MCP_DCR_ENABLED` `false`, `/oauth/register` answers
404 `registration_disabled`; CIMD clients still connect, Cursor cannot. While
on: 5 registrations a minute and 20 a day per client address, 200 a day per
self-hosted Gateway, then `429 rate_limited` (wait, or use a CIMD client); past
60 requests a minute per address on `/oauth/register` or `/oauth/token`, 429 `Too many attempts.`
Behind Cloudflare Access: `pnpm everyapp access on` lets `/mcp`, `/mcp/*`,
`/oauth/token`, `/oauth/register`, `/.well-known/*` and `/health` through on the Gateway
host, and `/mcp` on an app host only where its manifest sets `mcp`, so OAuth and tokens keep working; the consent
page stays behind Access. With Managed OAuth on the Gateway's Access application
instead, Access is the OAuth server: the person must have signed in to the Gateway
in a browser once (else `403 not_connected`), gets read & write to every app, no connection row.

## Sources

- packages/sdk/src/server/tools.ts, toolsEndpoint.ts, everyApp.ts; packages/sdk/src/internal/tools.ts, protocol.ts
- packages/toolbus/src/server.ts, http.ts, builtins.ts, policy.ts, dev/index.ts
- apps/every-app-gateway/src/server/toolbus/catalog-sync.ts, gateway-mcp.ts, app-host-mcp.ts; src/server/app-activation.ts, deploy/run.ts; src/server/mcp-auth/routes.ts, config.ts, validate.ts, consent.ts, registration-limit.ts
- apps/every-app-gateway/src/routes/_app/admin/tokens.tsx, settings/connections.tsx; src/client/components/Sidebar.tsx, oauth/ConsentForm.tsx, admin/CreateUserTokenModal.tsx
- packages/perimeter/src/gateway.ts; packages/cli/src/commands/dev/devAppGateway.ts, ready.ts; packages/cli/src/commands/deploy/deployApp.ts; packages/cli/src/lib/app/skill.ts
- starter/src/tools.ts, entry.worker.ts, server/todos.ts, README.md; docs/runbooks/mcp-oauth.md; landing-page/content/agent/mcp.md; landing-page/content/docs/connect-ai.mdx
