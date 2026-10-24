# Agent tools (MCP)

An app never speaks MCP. It describes its tools with `defineTools()` in
src/tools.ts and passes them to `everyApp(handler, { tools })`; the Gateway
snapshots that catalog and serves AI clients at `https://<gateway>/mcp` (every
app the caller can use, tools named `<app-id>_<tool>`) and at `https://<app-host>/mcp`
(that app alone). Never add an MCP server, an /mcp route, a login or a token
check to an app. Full reference: https://everyapp.com/docs/agent/mcp.md (in a
checkout landing-page/content/agent/mcp.md); the person's steps: https://everyapp.com/docs/connect-ai.

## Define tools: src/tools.ts

The starter's shape (starter/src/tools.ts, shortened):

```ts
import { ToolError, defineTools } from "@every-app/sdk/server";
import { z } from "zod";
import { TodoError } from "@/server/todoErrors";
import { TodoService } from "@/server/todoService";

export const tools = defineTools(
  {
    list_todos: {
      description: "List all todos belonging to the authenticated user.",
      risk: "read",
      input: z.object({}).strict(),
      handler: async (_input, { user }) => ({
        todos: await TodoService.list(user.id),
      }),
    },
    create_todo: {
      description: "Create a new active todo. The server generates its ID.",
      risk: "write",
      idempotent: false,
      input: z.object({ title: z.string().trim().min(1).max(255) }).strict(),
      handler: async ({ title }, { user }) => ({
        todo: await TodoService.create(user, { id: crypto.randomUUID(), title }),
      }),
    },
    delete_todo: {
      description: "Permanently delete one todo belonging to the user.",
      risk: "destructive",
      input: z.object({ id: z.string().uuid("Invalid todo ID") }).strict(),
      handler: async (input, { user }) => {
        try {
          return { deleted: await TodoService.delete(user.id, input) };
        } catch (error) {
          if (error instanceof TodoError) throw new ToolError(error.message);
          throw error;
        }
      },
    },
  },
  { instructions: "Never guess todo IDs; call list_todos first." },
);
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

Provider apps: the Gateway also serves a data provider's tools of its own
(DataForSEO: `dataforseo_<tool>`) once the operator runs
`pnpm everyapp provider on dataforseo` and sets DATAFORSEO_API_KEY; nothing
to deploy, same /mcp, same access rules (SKILL.md "Providers").

## What the Gateway does with them

Snapshot: the Gateway stores each app's catalog in D1 with the app version it
came from, taken when the app is activated (the first deploy: the CLI waits
for the app to go live, so the catalog exists before anyone connects), when a
hosted deploy finishes a new version, on the first app-host request each
isolate sees after a self-hosted redeploy, when `/mcp` or the consent page
finds a missing or outdated snapshot (synced within the request, 3 s budget),
and when a call reports a drifted `catalogHash` or `unknown_tool`. The CLI's
deploy syncs nothing itself. One sync: `POST /__everyapp/tools/list` (15 s), at
most 100 tools; status `ok`, `empty`, `unsupported` (SDK older than 0.3) or
`error` (retried at most every 5 minutes); logged as `mcp.catalog.sync`.
Calls:   `tools/list` never calls the app. `tools/call` checks the arguments
         against the snapshot, mints a 120 s identity JWT for that one call
         (`chan: "mcp"`, explicit scopes, `tc: { id, name }`), makes one
         `POST /__everyapp/tools/call` (30 s) and audits one `mcp_tool_calls` row.
Built-ins (Gateway connector only, read-only, no input; always loaded in Claude
         Code): `everyapp_list_apps` (the apps this connection can use),
         `everyapp_whoami` (user, org, access).
Changes: 2026-07-28 clients (Claude Code) hold a `subscriptions/listen` stream
         re-read every 30 s, so a change reaches them within about half a
         minute; 2025-era clients get `notifications/tools/list_changed` and a
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
shown as `(tools load on first use)` has no snapshot yet.
Scripts and anything that takes a header: a personal access token. In the
Gateway open **Admin** (the sidebar footer's **Manage workspace**; owners and
admins only), tab **Tokens**, heading **Personal access tokens**, button
**Create access token**: a name, **All my apps** or one app, an expiry (default
90 days). The token is `epat_…`, shown once, read & write. Send it as
`Authorization: Bearer epat_…` to `https://<gateway>/mcp` or `https://<app-host>/mcp` (one app, no OAuth):

```bash
claude mcp add --transport http todos https://<app-host>/mcp --header "Authorization: Bearer $EVERYAPP_TOKEN"
```

Disconnecting: the sidebar footer's **AI connections** link
(`/settings/connections`, beside **Manage workspace**) lists each OAuth
connection; revoking one makes the client's next request
fail `invalid_token`. Removing or deactivating a person ends all of theirs;
tokens are revoked on Admin, Tokens.

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
dropped with a warning (dev prints it as `TOOLS_CATALOG`); (4) the person
cannot open the app: it is absent from `everyapp_list_apps`; grant access in
Admin (a connection made with **Only these apps** needs a reconnect to add one).
401 vs 403 on `/mcp`: 401 means no credential or one that doesn't verify (an
expired or revoked token, a bearer that isn't `epat_` on an app host, the token
of a revoked connection); its body depends on the surface. On
`https://<gateway>/mcp` with OAuth on: an empty body and
`WWW-Authenticate: Bearer realm="OAuth", resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="mcp:read"`
(`error="invalid_token"` added when a token was sent); a revoked connection's
token gets `{"error":"invalid_token","error_description":"This connection was revoked or lost its access. Connect again."}`.
On `https://<app-host>/mcp`, and on the Gateway with OAuth off:
`{"error":"unauthenticated"}` with `WWW-Authenticate: Bearer realm="every-app"`
(`error="invalid_token"` when a bearer was sent; the app host adds
`error_description="Use a personal access token here, or connect <gateway>/mcp"`).
403 `{"error":"forbidden","reason":…}` means the credential verified and was
refused: `token_scope` (scopes without `mcp:read` or `mcp:write`, or an
MCP-only token on a page route), `no_app_access` (app host: the person cannot
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
`/oauth/token`, `/oauth/register` and `/.well-known/*` through on the Gateway
host and `/mcp` on every app host, so OAuth and tokens keep working; the consent
page stays behind Access. With Managed OAuth on the Gateway's Access application
instead, Access is the OAuth server: the person must have signed in to the Gateway
in a browser once (else `403 not_connected`), gets read & write to every app, no connection row.

## Sources

- packages/sdk/src/server/tools.ts, toolsEndpoint.ts, everyApp.ts; packages/sdk/src/internal/tools.ts, protocol.ts
- packages/toolbus/src/server.ts, http.ts, builtins.ts, policy.ts, dev/index.ts
- apps/every-app-gateway/src/server/toolbus/catalog-sync.ts, gateway-mcp.ts, app-host-mcp.ts; src/server/app-activation.ts, deploy/run.ts; src/server/mcp-auth/routes.ts, config.ts, validate.ts, consent.ts, registration-limit.ts
- apps/every-app-gateway/src/routes/_app/admin/tokens.tsx, settings/connections.tsx; src/client/components/Sidebar.tsx, oauth/ConsentForm.tsx, admin/CreateUserTokenModal.tsx
- packages/perimeter/src/gateway.ts; packages/cli/src/commands/dev/devAppGateway.ts, ready.ts; packages/cli/src/commands/deploy/deployApp.ts; packages/cli/src/lib/app/skill.ts
- starter/src/tools.ts, entry.worker.ts, server/todoService.ts, server/todoErrors.ts, README.md; docs/runbooks/mcp-oauth.md; landing-page/content/agent/mcp.md; landing-page/content/docs/connect-ai.mdx
