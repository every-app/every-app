# Todo MCP example

## Goal

Expose the todo example's core actions to MCP clients (Claude, Cursor, MCP
Inspector) without adding a second application-auth system, and without the
app speaking MCP itself. The app receives the same verified Every App user
for browser and agent requests and isolates every database operation by that
user's ID.

## How it fits together

1. The app describes its tools with `defineTools()` from
   `@every-app/sdk/server` (`apps/todo-app/src/tools.ts`,
   `templates/simple-todo/src/tools.ts`) and passes them to
   `everyApp(handler, { tools })`.
2. `everyapp app deploy` asks the gateway to snapshot the tool catalog. The
   gateway fetches it once, over the app's private service binding, and
   stores it in D1. A redeploy re-syncs it; a tool call that reports a
   different catalog re-syncs it in the background.
3. The gateway serves the tools from that snapshot twice: at
   `https://<todo-app-host>/mcp` under their own names, and at the gateway's
   own `https://<gateway>/mcp`, the one connector for every app, as
   `todo_list_todos`, `todo_create_todo`… Listing tools never calls the app.
   Calling a tool makes exactly one call to the app's internal tools endpoint
   with an identity minted for that call.

The app's own code never sees MCP: protocol versions, headers and JSON-RPC
stay in the gateway's ToolBus (`@every-app/toolbus`, built on the official
`@modelcontextprotocol/server`).

## Endpoint and transport

- Endpoints: `https://<gateway>/mcp` (every app, OAuth or a personal token;
  what claude.ai, ChatGPT and Claude Code connect to) and
  `https://<todo-app-host>/mcp` (this app, a personal token or the app's own
  pages), both served by the gateway.
- Transport: stateless Streamable HTTP with JSON responses. Both protocol
  eras work: 2026-07-28 (`server/discover`, per-request `_meta`) and the
  2025-06-18 / 2025-11-25 `initialize` handshake. No sessions, no SSE
  streams; `GET /mcp` returns `405`.
- Capabilities: tools only. `tools/list` results may be cached for 60 s.
- An app whose manifest says `mcp: "app"`, or that has no tools, keeps
  answering `/mcp` itself.

## Tool contract

Four goal-oriented tools. MCP clients never provide a user ID; the app always
takes it from the verified identity.

| Tool          | Risk        | Input                                               | Result              | Behavior                                                       |
| ------------- | ----------- | --------------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| `list_todos`  | read        | `{}`                                                | `{ todos: Todo[] }` | Lists the caller's todos.                                      |
| `create_todo` | write       | `{ title: string }`                                 | `{ todo: Todo }`    | Generates the ID on the server and creates an active todo.     |
| `update_todo` | write       | `{ id: UUID, title?: string, completed?: boolean }` | `{ todo: Todo }`    | Updates only supplied fields. At least one change is required. |
| `delete_todo` | destructive | `{ id: UUID }`                                      | `{ deleted: Todo }` | Deletes and returns the caller's previous todo.                |

`Todo` is the common shape supported by both the full example and the starter:

```ts
interface Todo {
  id: string;
  title: string;
  completed: boolean;
}
```

- Titles are trimmed, must not be empty, and are limited to 255 characters,
  so the contract is identical in the full app and the starter.
- Unknown input fields are rejected. The gateway checks arguments against the
  snapshotted JSON Schema first, leaving out what it won't run on shared
  infrastructure (the app's regular expressions, recursive schemas, very
  large arguments); the app's zod schema checks everything again (including
  rules JSON Schema can't express, such as "a title or completed value").
  Both kinds of failure come back as tool errors the model can read.
- Looking up, updating or deleting another user's todo produces the same
  `Todo not found` tool error as a missing ID. Messages written for the user
  are thrown as `ToolError`; any other failure reaches the client only as
  `Internal error in todo (ref <call id>)`.
- **`delete_todo` is hidden.** Destructive tools are left out of
  `tools/list`, and calling one answers `-32602 Unknown tool`, until the
  gateway supports approvals. The handler stays in the app and is tested.
- The full todo app broadcasts its per-user sync event after successful
  mutations so open browser tabs refresh. A failed notification is logged
  and never turns a committed mutation into a failed tool call.

## Authentication boundary

`/mcp` stays private and is never in the manifest's `public` routes. On the
gateway's `/mcp` the caller is an OAuth connection the user approved (with
its own organization, apps and read & write or read only choice) or a
personal access token; the steps below are for the app host's `/mcp`, and
steps 3 and 4 are the same for both.

1. The perimeter authenticates the caller: a personal access token
   (`Authorization: Bearer epat_…`), or the user's browser session when the
   request comes from the app's own page. That is intended (the app may
   call its own tools) and guarded by the CSRF check: a cookie-carrying
   POST must be same-origin, so a sibling app's page or another site gets
   `403 csrf_denied`. It checks the caller's access to the app.
2. The token's scopes set the caller's access: `*` or `mcp:write` is read &
   write, `mcp:read` is read only (write tools are hidden), anything else is
   refused with `403 token_scope`. A browser session is read & write. A
   token with only `mcp:` scopes is refused (`403 token_scope`) on every
   route of the app except `/mcp`.
3. For each tool call the gateway mints a 120-second identity JWT with
   `chan: "mcp"`, explicit scopes (`mcp:read`, `mcp:write`) and a `tc` claim
   naming the tool and the call. It never mints `mcp:destructive` yet.
4. `everyApp()` verifies that JWT, requires `chan: "mcp"`, a `tc` that
   matches the request, and the scope the tool's risk needs, then runs the
   tool with the verified user.

The app never receives the browser cookie, the personal token, or an OAuth
access token. The internal tools endpoints (`/__everyapp/tools/*`) are
refused at the perimeter for every outside request, and the catalog endpoint
only accepts the gateway's one-minute system token, which can't call tools.

## Trying it

Locally, `pnpm dev` (`everyapp dev`) serves the tools at
`http://todo.localhost:8787/mcp` with the same policy. In stub mode any
bearer acts as the dev user; in mirror mode a personal token from the local
gateway is verified for real.

```sh
H=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H "authorization: Bearer $EVERYAPP_TOKEN")
M='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}'

# 2026-07-28
curl -s https://<todo-app-host>/mcp "${H[@]}" -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: tools/list' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{$M}}"
curl -s https://<todo-app-host>/mcp "${H[@]}" -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: tools/call' -H 'mcp-name: create_todo' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"create_todo\",\"arguments\":{\"title\":\"buy milk\"},$M}}"

# 2025-11-25
curl -s https://<todo-app-host>/mcp "${H[@]}" \
  -d '{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
curl -s https://<todo-app-host>/mcp "${H[@]}" -H 'mcp-protocol-version: 2025-11-25' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_todos","arguments":{}}}'
```

Claude Code, every app over OAuth: `claude mcp add --transport http everyapp https://<gateway>/mcp`,
then `/mcp` → everyapp → Authenticate. This app alone, with a personal token:
`claude mcp add --transport http todos https://<todo-app-host>/mcp --header "Authorization: Bearer $EVERYAPP_TOKEN"`.

## Acceptance criteria

- The full todo app and the starter define the four tools with
  `defineTools()`, and the gateway serves them at `/mcp` on both protocol
  eras; `delete_todo` is neither listed nor callable by AI clients.
- Unauthenticated requests are challenged before any tool runs; tokens
  without MCP scopes are refused; read-only tokens see only `list_todos`.
- All reads and writes are scoped to the verified user.
- Invalid inputs and missing todos return tool errors without leaking data;
  unexpected failures are masked.
- `tools/list` makes no call to the app; each `tools/call` makes exactly one.
- The full app's browser sync is notified after successful mutations.
- The app and starter manifests continue to declare no public routes.
