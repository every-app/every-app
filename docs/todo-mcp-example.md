# Todo MCP example

## Goal

Expose the todo example's core actions to MCP clients without adding a second
application-auth system. The app should receive the same verified Every App
user for browser and MCP requests and must isolate every database operation by
that user's ID.

This first version is deliberately small. It proves the app-facing MCP
contract; gateway-issued bearer tokens and OAuth are separate follow-up work.

## Endpoint and transport

- Endpoint: `https://<todo-app-host>/mcp`
- Transport: stateless Streamable HTTP
- Supported server capabilities: tools only
- Supported requests: `initialize`, `ping`, `tools/list`, and `tools/call`
- The server does not create MCP sessions or an SSE stream. `GET /mcp` returns
  `405 Method Not Allowed`, which Streamable HTTP permits for servers that do
  not offer a server-initiated event stream.
- Each `POST` contains one JSON-RPC message. Batch requests are not supported.

## Tool contract

The interface exposes four goal-oriented tools. MCP clients do not provide a
user ID; the server always takes it from the verified Every App identity.

| Tool          | Input                                               | Result              | Behavior                                                       |
| ------------- | --------------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| `list_todos`  | `{}`                                                | `{ todos: Todo[] }` | Lists the caller's todos.                                      |
| `create_todo` | `{ title: string }`                                 | `{ todo: Todo }`    | Generates the ID on the server and creates an active todo.     |
| `update_todo` | `{ id: UUID, title?: string, completed?: boolean }` | `{ todo: Todo }`    | Updates only supplied fields. At least one change is required. |
| `delete_todo` | `{ id: UUID }`                                      | `{ deleted: Todo }` | Deletes and returns the caller's previous todo.                |

`Todo` is the common shape supported by both the full example and the starter:

```ts
interface Todo {
  id: string;
  title: string;
  completed: boolean;
}
```

Titles are trimmed, must not be empty, and are limited to 255 characters so
the contract is identical in the full app and cloneable starter. Unknown input
fields are rejected. Looking up, updating, or deleting another user's ID must
produce the same `Todo not found` tool error as a missing ID.

The full todo app broadcasts its existing per-user sync event after successful
MCP mutations so open browser clients refresh. Sync notification failure is
logged asynchronously and does not turn an already-committed mutation into a
failed tool call.

## Authentication boundary

`/mcp` remains private and is not added to the manifest's `public` routes.

1. The Every App gateway authenticates the caller and checks access to this app.
2. The gateway consumes the external credential and mints the existing,
   short-lived, app-audience identity JWT.
3. The app's `everyApp()` wrapper verifies that JWT before routing to the MCP
   handler.
4. The MCP handler receives `EveryAppUser` and keys every query by `user.id`.

Today, the implemented browser-session path can supply that identity. The
follow-up MCP auth work can add a gateway-issued personal token and then OAuth
without changing any tool or database code: both credential types terminate at
the gateway and mint the same internal identity. The app must never receive the
browser cookie, personal token, or OAuth access token.

The MCP helper supports optional per-tool scopes, but this example does not make
them load-bearing yet. The first gateway credential can therefore use a single
`app:use` grant; finer read/write/destructive policy belongs in the later auth
and ToolBus design.

## Acceptance criteria

- The full todo app and cloneable starter both serve the four tools at `/mcp`.
- Unauthenticated requests fail before tool execution.
- All reads and writes are scoped to the verified user.
- Invalid inputs and missing todos return MCP tool errors without leaking data.
- The full app's browser sync is notified after successful MCP mutations.
- The app and starter manifests continue to declare no public routes.
- Focused MCP tests, type checks, and formatting checks pass.
