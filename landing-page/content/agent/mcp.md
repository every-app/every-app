---
title: "MCP: tools, the connector and OAuth"
description: How an app exposes tools to AI clients with defineTools(), how the Gateway serves them on its one /mcp connector under app-prefixed names, and how claude.ai, Claude Code, Cursor and scripts connect with OAuth or a personal access token.
---

## The model

An app never speaks MCP. It describes its tools with `defineTools()` from `@every-app/sdk/server` and passes the result to `everyApp(handler, { tools })` (`packages/sdk/src/server/tools.ts`, `starter/src/entry.worker.ts`). The Gateway snapshots that catalog into D1 and serves MCP clients from the snapshot through its ToolBus (`@every-app/toolbus`, `packages/toolbus/src/`, built on `@modelcontextprotocol/server` 2.3.1). There is one connector per Gateway, `https://<gateway>/mcp`, serving every app the caller can reach with tools named `<app>_<tool>` (`todo_create_todo`) plus two built-ins, `everyapp_whoami` and `everyapp_list_apps`; and one per app host, `https://<app-host>/mcp`, serving that app alone under its tools' own names. `tools/list` never calls an app. `tools/call` makes exactly one request to the app's internal tools endpoint over its service binding, carrying a 120-second identity JWT (`IDENTITY_TTL_SECONDS`, `packages/sdk/src/internal/protocol.ts`) minted for that one call: the same verified user the browser gets, with `chan: "mcp"`, explicit scopes (`mcp:read`, or `mcp:read` and `mcp:write`; never `*`) and a `tc` claim `{ id, name }` naming the call and the tool. The handler receives that user; it never sees a cookie, a personal token or an OAuth token.

The person's side (the one address, a custom connector in Claude and ChatGPT, `claude mcp add`, a token for tools that can't sign in, disconnecting) is the user page [/docs/connect-ai](/docs/connect-ai); the how-to every new app ships with is `packages/cli/skills/everyapp/mcp.md` (in an app `.agents/skills/everyapp/mcp.md`), which walks the starter's tools from `defineTools()` to a connected client, and `docs/runbooks/mcp-oauth.md` ([/docs/agent/repo/runbooks/mcp-oauth](/docs/agent/repo/runbooks/mcp-oauth)) is the operator's runbook for the OAuth server.

## defineTools() reference

`packages/sdk/src/server/tools.ts`, exported from `@every-app/sdk/server` (`packages/sdk/src/server/index.ts`): the values `defineTools`, `toolResult` and `ToolError`, and the types `ToolDefinition`, `ToolContext`, `ToolSchema`, `PlainToolSchema`, `StandardSchemaWithJSON`, `ToolResult`, `ToolSet`, `DefineToolsOptions` and `ToolRisk`. `defineTools` takes `(tools, options?)` and returns a frozen `ToolSet` (`names`: the tool names, sorted); pass it as `everyApp(handler, { tools })`. It is generic over the tools' inputs (`defineTools<TInputs>`, `ToolDefinition<TInput>`, `ToolSchema<TInput>`): each `handler`'s first argument is typed as its `input` schema's output type. It validates every definition when called and throws a `TypeError` for a bad one (the table under "Fields of a tool definition"); the catalog itself (descriptors and hash) is built lazily, once per isolate.

```ts
import { ToolError, defineTools, toolResult } from "@every-app/sdk/server";
import { z } from "zod";

export const tools = defineTools(
  {
    list_todos: {
      title: "List todos",
      description: "List the user's todos.",
      risk: "read",
      input: z.object({}).strict(),
      handler: async (_input, { user }) => ({ todos: await list(user.id) }),
    },
  },
  { instructions: "Never guess todo ids; call list_todos first." },
);
```

### Tool names

Lowercase `snake_case`, matching `TOOL_NAME_PATTERN` (`/^[a-z][a-z0-9_]{0,47}$/`, `packages/sdk/src/internal/tools.ts`): a letter, then letters, digits or underscores, at most 48 characters. On the Gateway's connector the name becomes `<app-id>_<tool>` (`namespacedToolName`, `packages/toolbus/src/names.ts`); app ids are kebab-case and never contain an underscore, so the first underscore ends the prefix. The namespaced name must fit `MAX_TOOL_NAME_LENGTH` 64, or the Gateway skips the tool with the warning `"<app>_<tool>" is longer than 64 characters`. `everyapp` is a reserved app id: the ToolBus names its built-ins under it (`BUILTIN_APP_ID`, `packages/toolbus/src/builtins.ts`); `pnpm everyapp create` refuses it (`"everyapp" is reserved for the platform`, `packages/cli/src/commands/create/steps/appId.ts`), the strict manifest validator refuses it (`Invalid everyapp.config: id "everyapp" is reserved for the platform.`, `isReservedAppId`, `packages/perimeter/src/manifest/manifest.ts`) and app registration refuses it (`400 RESERVED_APP_ID`, `The app id "everyapp" is reserved for the platform.`, `packages/perimeter/src/registry/registration.ts`).

### Fields of a tool definition

| Field         | Type                                     | Required | Meaning                                                                                                                                                                                                                                           |
| ------------- | ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description` | `string`, non-empty                      | yes      | What the tool does and when to use it; the model reads it. The Gateway skips a tool whose description is longer than 2048 characters.                                                                                                             |
| `risk`        | `"read"` \| `"write"` \| `"destructive"` | yes      | What a call can change; see "Risk levels". `TypeError` `needs a risk: "read", "write" or "destructive"` otherwise.                                                                                                                                |
| `input`       | `ToolSchema`                             | yes      | The arguments schema; must describe a JSON object. See "Schemas".                                                                                                                                                                                 |
| `handler`     | `(input, context) => unknown`            | yes      | Runs the tool with the validated input and a `ToolContext`. See "Results" and "Errors".                                                                                                                                                           |
| `title`       | `string`                                 | no       | Short human-readable name clients can show. The Gateway skips a tool whose title is longer than 100 characters.                                                                                                                                   |
| `output`      | `ToolSchema`                             | no       | The result schema; must describe an object. The handler's return value is validated against it and sent as MCP `structuredContent` as well as text.                                                                                               |
| `idempotent`  | `boolean`                                | no       | Repeating a call with the same arguments has no further effect. Sent to clients as `annotations.idempotentHint`.                                                                                                                                  |
| `openWorld`   | `boolean`                                | no       | The tool reaches systems outside the app. Sent as `annotations.openWorldHint`; when unset, clients receive `openWorldHint: false` (the spec reads a missing hint as true, so the ToolBus always spells it out; `packages/toolbus/src/server.ts`). |

`options.instructions` (`DefineToolsOptions`) is guidance for the model spanning the app's tools, a string. The Gateway trims it to 2048 characters (warning `instructions trimmed to 2048 characters`); on its multi-app connector each app's instructions are clipped to 1024 characters and all of them together to 8 KiB (`packages/toolbus/src/view.ts`).

What clients receive per tool (`toMcpTool`, `packages/toolbus/src/server.ts`): `name`, `title`, `description`, `inputSchema`, `outputSchema`, and `annotations` with `readOnlyHint: risk === "read"`, `destructiveHint: risk === "destructive"` on non-read tools, `openWorldHint` (default `false`) and `idempotentHint` when set. An app cannot claim `readOnlyHint` for a write tool: hints derive from the declared risk.

`assertToolDefinition` checks the definitions in sorted name order and throws the first problem as `TypeError("defineTools: tool \"<name>\" <problem>")`; `options.instructions` is checked after them. They fire when `defineTools()` runs, which in the starter is at module load (`starter/src/tools.ts`), so a bad definition fails the Worker at module load rather than serving a catalog without the tool.

| `TypeError` message                                                                                                             | Cause                                             |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `defineTools: tool "<name>" must be named in lowercase snake_case: a letter, then letters, digits or _ (at most 48 characters)` | The key fails `TOOL_NAME_PATTERN`.                |
| `defineTools: tool "<name>" must be an object`                                                                                  | The definition is not an object.                  |
| `defineTools: tool "<name>" needs a description`                                                                                | `description` is missing, not a string, or blank. |
| `defineTools: tool "<name>" needs a risk: "read", "write" or "destructive"`                                                     | `risk` is none of the three.                      |
| `defineTools: tool "<name>" input must be a Standard Schema with JSON Schema support (zod >= 4.2) or { jsonSchema, validate }`  | `input` is neither form.                          |
| `defineTools: tool "<name>" output must be a Standard Schema with JSON Schema support (zod >= 4.2) or { jsonSchema, validate }` | `output` is set and neither form.                 |
| `defineTools: tool "<name>" needs a handler function`                                                                           | `handler` is not a function.                      |
| `defineTools: tool "<name>" title must be a string`                                                                             | `title` is set and not a string.                  |
| `defineTools: tool "<name>" idempotent must be a boolean`, `… openWorld must be a boolean`                                      | The flag is set and not a boolean.                |
| `defineTools: instructions must be a string`                                                                                    | `options.instructions` is set and not a string.   |

### Schemas

`input` and `output` accept either of (`ToolSchema`):

- A validator implementing Standard Schema v1 and Standard JSON Schema v1 (`~standard.validate` plus `~standard.jsonSchema.input/output`), which zod 4.2 and later does. The SDK takes no dependency on zod.
- A plain pair `{ jsonSchema: Record<string, unknown>, validate(value) }` (`PlainToolSchema`) for validators without Standard JSON Schema.

Anything else fails with `TypeError` `input must be a Standard Schema with JSON Schema support (zod >= 4.2) or { jsonSchema, validate }`.

How a schema becomes the JSON Schema clients see (`objectJsonSchema`): the converter is called with `target: "draft-2020-12"`; the result goes through a JSON round trip (dropping what JSON can't carry); every `x-mcp-header` keyword is removed at every depth (the 2026-07-28 MCP revision's header-mirroring hint; the Gateway fronts many apps and never routes on an app's headers); a `$schema` equal to `https://json-schema.org/draft/2020-12/schema` is dropped. Both sides must describe objects: a typeless input root (zod `union`/`discriminatedUnion` emit a root `anyOf`/`oneOf` without `type`) gets `type: "object"` added, as MCP arguments are always an object; a typeless output root gets it only when it is provably object-shaped (it has `properties`, `patternProperties`, `additionalProperties` or `required`, or every branch of `oneOf`/`anyOf`/`allOf` is an object; `$ref` is not followed). Otherwise the tool is left out of the catalog with a warning `<name>: skipped, <side> must describe an object (JSON Schema type "object")` or `<side> has no JSON Schema form: <error>`, logged as `[everyapp] defineTools: tool "<name>" <reason>` and reported to the Gateway in the catalog's `warnings`, instead of taking the app's other tools down.

The Gateway's own limits on a received schema (`CATALOG_LIMITS`, `packages/toolbus/src/catalog.ts`): serialized input or output schema at most 20 KiB (`is larger than 20 KB`), `type` must be `"object"`, and every `$ref` must resolve inside the schema (`is not a usable JSON Schema ($ref "<ref>" does not resolve in the schema)`); a schema the Workers validator refuses is skipped with its message.

### The handler's context

`ToolContext`, the second handler argument:

| Member    | Type                   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`    | `EveryAppUser`         | The verified caller: `id` (the JWT `sub`), `email`, `orgId`, `orgRole`, `channel: "mcp"`, `actor: { sub }` (`pat:<token id>`, `oauth:<connection id>`, `access:<email>`, or the user id for a browser or dev session), `scopes` (`["mcp:read"]` or `["mcp:read", "mcp:write"]`), `jti`, and `toolCall: { id, name }` naming this call (`packages/sdk/src/internal/protocol.ts`, `packages/toolbus/src/execute.ts`). |
| `env`     | `Cloudflare.Env`       | The Worker's bindings.                                                                                                                                                                                                                                                                                                                                                                                              |
| `ctx`     | `ExecutionContextLike` | `waitUntil` and friends.                                                                                                                                                                                                                                                                                                                                                                                            |
| `request` | `Request`              | The internal `POST /__everyapp/tools/call` request, not the client's MCP request.                                                                                                                                                                                                                                                                                                                                   |
| `callId`  | `string`               | The call's id (a UUID the ToolBus generated); also the `ref` in masked error messages.                                                                                                                                                                                                                                                                                                                              |

Handlers must scope every read and write by `user.id` (and `user.orgId`): an MCP client never supplies a user id.

The identity's `scopes` also bound what the handler can ask the Gateway for. `sendEmail()` ([/docs/agent/email](/docs/agent/email)) under a `chan: "mcp"` identity without `mcp:write` is refused `403 integration_read_only` (`This agent connection is read-only, and sending email writes. Reconnect the agent with write access.`; `apps/every-app-gateway/src/server/capabilities/email.ts`), which the SDK throws as `GatewayRefusalError`, so a `read` tool's handler can send mail only when the caller connected with read & write.

### Results

`toToolResult` (`packages/sdk/src/server/tools.ts`) turns the handler's return value into an MCP `CallToolResult`:

| Handler returns                                       | Client receives                                                                                                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a `string`                                            | one `text` content block                                                                                                                                                                  |
| `undefined`                                           | `content: []`                                                                                                                                                                             |
| any other JSON-serializable value, no `output` schema | one `text` block holding `JSON.stringify(value)`                                                                                                                                          |
| a value, with an `output` schema                      | the value validated against `output` (it must be a JSON object), sent as `structuredContent` and as a `text` block of its JSON                                                            |
| `toolResult({ text, structured })`                    | `text` as the `text` block (a summary, a table the model reads) and `structured` as `structuredContent`, validated against `output` when there is one; `structured` must be a JSON object |

`toolResult` marks its return value with `Symbol.for("everyapp.toolResult")`; a handler returns it as is. The ToolBus relays at most `MAX_RESULT_BYTES` 1 MiB from the app; past that the client gets the error `The result from <app> is larger than 1 MB.` (`packages/toolbus/src/execute.ts`).

### Errors

Throw `ToolError` (`new ToolError("No todo with that id")`) for an error the model can read and act on: it reaches the client as `{ content: [{ type: "text", text: message }], isError: true }`. Any other thrown error, and a result that fails its `output` schema (`result does not match the output schema: …`) or isn't an object (`structured results must be JSON objects`), is logged in the app as `[everyapp] tool "<name>" failed (ref <callId>): <error>` and reaches the client only as `Internal error in <app-id> (ref <callId>)` with `isError: true` (`packages/sdk/src/server/toolsEndpoint.ts`). A failed `ToolError` never un-commits a mutation: the handler already ran.

### Risk levels

`TOOL_RISKS` and `requiredScopeForRisk` (`packages/sdk/src/internal/tools.ts`); policy in `packages/toolbus/src/policy.ts`.

| `risk`          | Meaning                               | Scope the call's identity must carry | What clients get today                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"read"`        | Changes nothing.                      | `mcp:read`                           | Listed and callable for every caller; `readOnlyHint: true`.                                                                                                                                                                                                                     |
| `"write"`       | Creates or changes data.              | `mcp:write`                          | Listed and callable for read & write callers; hidden from read-only ones (policy reason `read_only_connection`); `destructiveHint: false`.                                                                                                                                      |
| `"destructive"` | Deletes or irreversibly changes data. | `mcp:destructive`                    | Hidden from every caller until approvals exist (policy reason `destructive_requires_approval`): absent from `tools/list`, and a call answers JSON-RPC `-32602 Unknown tool: <name>`. `mcp:destructive` is never minted (`MCP_DESTRUCTIVE_SCOPE`). The handler stays in the app. |

A tool the Gateway receives without a risk is treated as `write`; an unknown risk is skipped (`unknown risk "<value>"`). Hidden means nothing about the tool leaks: the client sees the same `Unknown tool` as for a name that never existed. The SDK enforces the scope again on every call (`Calling <name> needs the <scope> scope.`); `*` does not count there, because the ToolBus only mints explicit scopes.

## The internal tools contract

`packages/sdk/src/internal/tools.ts` (shapes, paths, hash) and `packages/sdk/src/server/toolsEndpoint.ts` (the app side). `everyApp()` answers two reserved paths before any app code runs, whether or not the app defines tools, and the perimeter refuses both from outside with `404 {"error":"not_found"}` however the path is encoded (`isReservedToolsPath`, `packages/perimeter/src/gateway.ts`), so only the Gateway's ToolBus reaches them over the service binding. Both are `POST` with `cache-control: no-store` answers; `TOOLS_PROTOCOL_VERSION` is `1`. These boundaries (the perimeter refusing the endpoints from outside, the ToolBus minting a one-call identity, the app acting only for the user it names) are the subject of `docs/threat-model.md` (assets, actors, trust boundaries, one testable invariant per boundary; mirrored under /docs/agent/repo when it lands).

| Endpoint                      | Credential                                                                                                      | Request body                                                 | Success body                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `POST /__everyapp/tools/list` | `x-everyapp-system`: a system JWT, purpose `tools.list`, 60 s (`SYSTEM_TOKEN_TTL_SECONDS`); it can't call tools | `{"v":1}`                                                    | `{ v: 1, sdk: "0.3.0", hash: "sha256:<hex>", instructions?, tools: ToolDescriptorV1[], warnings?: string[] }` |
| `POST /__everyapp/tools/call` | `x-everyapp-identity`: an identity JWT with `chan: "mcp"` and `tc: { id, name }`                                | `{"v":1,"name":"<tool>","arguments":{…},"callId":"<tc.id>"}` | `{ v: 1, catalogHash: "sha256:<hex>", result: { content, structuredContent?, isError? } }`                    |

`hash` is `sha256:` over the canonical JSON (keys sorted at every depth, `undefined` dropped) of `{ instructions: instructions ?? null, tools }` (`catalogHash`). An app without tools still answers `/list` with an empty catalog, so the Gateway can tell "no tools" from "no contract". Error answers are `{ v: 1, error: { code, message, issues? } }`:

| HTTP | `code`               | When                                                                                                                                                                                                                              |
| ---- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 405  | `method_not_allowed` | Not `POST` (`Use POST.`, `allow: POST`).                                                                                                                                                                                          |
| 500  | `misconfigured`      | The identity verification options can't be resolved (`ConfigurationError`), or the whole catalog can't be built.                                                                                                                  |
| 401  | `unauthenticated`    | The system or identity JWT doesn't verify (`IdentityError` message).                                                                                                                                                              |
| 400  | `invalid_request`    | Body isn't `{"v":1}` / `{"v":1,"name","arguments","callId"}`.                                                                                                                                                                     |
| 403  | `forbidden`          | `Tool calls need an identity the gateway minted for this call.` (no `chan: "mcp"` or no `tc`); `The identity was minted for a different tool call.` (`name`/`callId` differ from `tc`); `Calling <name> needs the <scope> scope.` |
| 404  | `unknown_tool`       | `Unknown tool: <name>`; the ToolBus then marks the snapshot drifted and re-syncs.                                                                                                                                                 |
| 400  | `invalid_arguments`  | `Invalid arguments for <name>: <path>: <message>; …`, with `issues: [{ message, path? }]`.                                                                                                                                        |

## Snapshots: deploy, activation and first use

The Gateway stores each app's catalog in D1 (`app_tool_catalogs`, `app_tools`; `apps/every-app-gateway/src/server/toolbus/catalog-sync.ts`, `AppToolRepository`) with the app version (`apps.version_id`) it was taken from and a status `ok`, `empty`, `unsupported` (the app answered 401, 403, 404 or 405: SDK older than 0.3, `does not serve agent tools (Every App SDK 0.3 or later)`) or `error`. One sync is one `POST /__everyapp/tools/list` over the service binding with a 15 s deadline covering the body (`CATALOG_TIMEOUT_MS`), the response capped at 5 MiB, at most 100 tools kept (`only the first 100 tools are served; <n> skipped`), duplicate names skipped. It happens:

| Trigger (`mcp.catalog.sync` log field `trigger`) | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `first_use`                                      | The app is activated (`activateApp`, `apps/every-app-gateway/src/server/app-activation.ts`), after the response; a `POST` to the Gateway's `/mcp` finds an app with no snapshot or one from another version than the app runs (`findVisibleUnsyncedApps`; `gateway-mcp.ts` passes `first_use` for both): synced within the request, up to 20 apps (`INLINE_SYNCS_MAX`) for 3 s (`INLINE_SYNC_BUDGET_MS`); what finishes in time is in the answer, the rest finishes after it (`waitUntil`); or an app host's `/mcp` `POST` finds no snapshot. |
| `new_version`                                    | A hosted deploy finishes (`apps/every-app-gateway/src/server/deploy/run.ts`); the first request on an isolate that sees an active app run a version it hasn't checked (`followAppVersion`); or an app host's `/mcp` `POST` finds a snapshot from another version than the app runs (`app-host-mcp.ts` is the only `/mcp` surface that tells `new_version` from `first_use`). Until the new snapshot is stored, the older version's keeps serving.                                                                                             |
| `consent`                                        | The OAuth consent page lists an app with no snapshot or one from another version (the same selection and budget as the Gateway's `/mcp`).                                                                                                                                                                                                                                                                                                                                                                                                     |
| `drift`                                          | A tool call's answer reports a `catalogHash` other than the snapshot's, or `unknown_tool`: re-synced in the background after the response.                                                                                                                                                                                                                                                                                                                                                                                                    |

On the Gateway's connector and the consent page, a sync whose last attempt failed is retried only in the background and at most every 5 minutes (`RETRY_FAILED_SYNC_MS`; `syncUnsyncedCatalogs` schedules it after the response), so a broken app never slows a request there. On an app host's `/mcp`, a `POST` that finds the current version's snapshot in a status other than `ok` (`error`, and likewise `empty` or `unsupported`) is proxied to the app while that snapshot is younger than 5 minutes, and re-syncs within the request once it is older (`servableCatalog`, `app-host-mcp.ts`). One isolate claims at most one sync per app per 30 s (`SYNC_WINDOW_MS`). `everyapp deploy` from the CLI does not sync tools: `packages/cli/src/commands/deploy/deployApp.ts` says the Gateway takes the app's agent tools itself, on first use and whenever the app's version changes, and a self-host redeploy is noticed from the app host's next request in each isolate. The SDK's and the Gateway's skip warnings are stored on the snapshot (`warnings`) and counted in the `mcp.catalog.sync` line; `pnpm everyapp dev` prints them as `TOOLS_CATALOG` warnings. A `GET` never makes the Gateway call an app.

## How clients learn about changes

`/mcp` keeps nothing between requests (`packages/toolbus/src/http.ts`), yet a connected client learns when its tool list changes (an app added, removed or redeployed, access gained or lost):

- **2025-06-18 / 2025-11-25 clients** (the `initialize` handshake): `initialize` issues an `Mcp-Session-Id` of `<uuid>.<16 hex chars>`, the suffix a SHA-256 prefix of the caller's tool list (`toolListHash`). A later request whose session carries another hash is answered as an SSE stream, `notifications/tools/list_changed` before the result, with a new `mcp-session-id` header; a `tools/list` on such a session gets HTTP 404 `-32001 Session not found`, so the client initializes again. Claude Code refetches `tools/list` within milliseconds of either.
- **2026-07-28 clients** (per-request `_meta` envelope, `mcp-method` and `mcp-protocol-version` headers): no sessions. A `subscriptions/listen` request with `notifications: { toolsListChanged: true }` is held open as an SSE stream: `notifications/subscriptions/acknowledged` first, then every 30 s (`listenPollMs`, default `LISTEN_POLL_MS`) the view is re-read and either `notifications/tools/list_changed` is pushed or a `: keepalive` comment is written; after 10 minutes (`listenMaxMs`, `LISTEN_MAX_MS`) the stream ends gracefully with a `resultType: "complete"` result and the client opens a new one. It needs `Accept: text/event-stream` (else 406), only `toolsListChanged` is served (a filter without it is acknowledged and closed), and one credential can hold 8 streams per isolate (`LISTEN_STREAMS_PER_CALLER`; more get `-32603 Subscription limit reached`). On the Gateway's connector every poll first rechecks the caller (the OAuth connection, the personal token or the Access identity, without touching last-used), so a revoked connection's stream ends at the next poll (`recheckFor`, `apps/every-app-gateway/src/server/toolbus/gateway-mcp.ts`). The modern era declares `listChanged: true` only when the view can be re-read (`view.refresh`): the Gateway's connector and app hosts can; `everyapp dev` can't (below).
- `tools/list` carries the 2026-07-28 cache hint `ttlMs: 60000, cacheScope: "private"` (`TOOLS_LIST_TTL_MS`).

## The connector: `https://<gateway>/mcp`

Routes in `apps/every-app-gateway/src/server/mcp-auth/routes.ts`; serving in `apps/every-app-gateway/src/server/toolbus/gateway-mcp.ts`.

### Who can call it

| Credential                                                               | Resolved by                                                                  | Access                                                                                    | Apps served                                                                                                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| OAuth access token this Gateway issued (`Authorization: Bearer …`)       | `resolveOauthCaller` (`mcp-auth/validate.ts`)                                | The connection's choice (read & write or read only), capped by the token's scopes         | The connection's chosen apps, or every active app of its organization the user can use (plus the shared apps on the hosted Gateway) |
| Personal access token `Authorization: Bearer epat_…`                     | `resolvePatCaller`, recognized by its prefix before the OAuth server sees it | `*` or `mcp:write`: read & write; `mcp:read`: read only; anything else: `403 token_scope` | The one app the token is bound to, or every app the user can use                                                                    |
| `Cf-Access-Jwt-Assertion` from Cloudflare Access (outer ring configured) | `resolveAccessCaller` (`mcp-auth/access-caller.ts`)                          | Read & write, like a browser session                                                      | Every app the member can use                                                                                                        |

Never a cookie. Nothing is cached: every request re-reads the connection or token, the member's role and ban state, the organization's status and app access, so revocation, removal, deactivation, suspension or losing an app takes effect on the next request. A refused caller gets `403 { "error": "forbidden", "reason": … }` with reasons `token_scope`, `organization_suspended`, `not_connected`, `account_deactivated`, `organization_unresolved`, and for the Access reasons a `message` saying what to do. An OAuth access token that verifies but whose `scope` carries neither `mcp:read` nor `mcp:write` is refused by `mcpBearerValidator` with the OAuth error `insufficient_scope` (`This token carries no MCP access.`, required scope `mcp:read`); the resource server is also built with `requiredScopes: ["mcp:read"]`, which the library checks on its own. Both concern only a token narrowed below what consent grants, since every connection is granted `mcp:read` (`grantedScopes`, `mcp-auth/consent.ts`). A token whose connection no longer stands (revoked, superseded, lapsed, or the member removed or deactivated) gets `invalid_token` (`This connection was revoked or lost its access. Connect again.`), so the client signs in again (`mcpBearerValidator`, `mcp-auth/validate.ts`).

Without a credential, `POST /mcp` answers 401 with `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="<GATEWAY_URL>/.well-known/oauth-protected-resource/mcp", scope="mcp:read"` while OAuth is on, and `Bearer realm="every-app"` (or `Bearer realm="every-app", error="invalid_token"` for a bad bearer) with body `{"error":"unauthenticated"}` while it is off, so a client fails fast instead of half-registering.

### What a caller sees

`gatewaySurfaceView` (`packages/toolbus/src/view.ts`): `serverInfo` name `every-app`, title `<organization> · Every App`, version `0.1.0` (`TOOLBUS_VERSION`), and instructions beginning ``Tools for <organization> on Every App. Each tool is named `<app>_<tool>`; call everyapp_list_apps to see what each app is for.`` then `Apps: <id> (<name>), …` and each app's own instructions. `tools/list` returns the built-ins first, then apps by id, then tools by name, after policy: destructive tools hidden from everyone, write tools hidden from read-only callers.

### Built-in tools

`packages/toolbus/src/builtins.ts`. Answered by the Gateway without calling any app, audited like any call, read-only (`readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`), input `{}` with `additionalProperties: false`, result as JSON text and `structuredContent`. Gateway connector only.

| Tool                 | Result                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `everyapp_list_apps` | `{ apps: [{ id, name, description?, url, tools }] }`: each app this connection can use, its URL (`https://<app-host>`) and how many tools this caller can see.                                                   |
| `everyapp_whoami`    | `{ user: { email, role }, organization: { id, name? }, connection: { kind, access, client? }, apps: [ids] }`; `kind` is `pat`, `session`, `dev`, `oauth` or `access`, `access` is `read & write` or `read only`. |

### Transport

Streamable HTTP with JSON responses, both protocol eras (`packages/toolbus/src/http.ts`):

- `POST` only. `GET` and `DELETE` get 405 `-32000 Method not allowed.` (`allow: POST, OPTIONS`); `OPTIONS` gets a 204 preflight answer. Body at most 256 KiB (`MAX_REQUEST_BODY_BYTES`; 413 `-32600 Request body too large.`); unreadable body 400 `-32700`; JSON-RPC batches 400 `-32600`; an `Mcp-Method` or `Mcp-Name` header that contradicts the body 400 `-32020`.
- A browser `Origin` must be the endpoint's own origin or one listed in `MCP_ALLOWED_ORIGINS`; anything else gets 403 `-32000 Forbidden: origin not allowed.` AI apps call from servers and send none. CORS answers never allow credentials.
- An unknown or hidden tool: JSON-RPC `-32602 Unknown tool: <name>` (names longer than 128 characters are cut with `…`).

### Executing a call

`executeToolCall` (`packages/toolbus/src/execute.ts`), the one path for both surfaces: resolve the name, apply policy, check the arguments against the snapshotted schema, mint the identity, `POST /__everyapp/tools/call` once, map the answer, emit one audit event.

- Arguments must be a JSON object, nested at most 64 levels (`MAX_ARGUMENT_DEPTH`; `arguments are nested more than 64 levels deep.`). The Gateway's check (`packages/toolbus/src/validation.ts`) runs on shared infrastructure, so it never runs an app's regular expressions (`pattern`, `patternProperties` are dropped from its copy; a schema that needs them under `not`, `if`, `oneOf` or `contains`, or with `unevaluatedProperties`/`unevaluatedItems`, is left to the app), skips schemas with `$ref`/`$dynamicRef`/`$recursiveRef`, and skips arguments with more than 1,000 values (`MAX_CHECKED_VALUES`). The app's own schema validates every call anyway. Refused arguments answer `Invalid arguments for <name>: <problem>` as a tool error (`isError: true`), audited with outcome `invalid_arguments`.
- The identity: `sub`/`email`/`orgId`/`orgRole` of the caller, `aud` the app's Worker name, `iss` the Gateway URL, `chan: "mcp"`, `act.sub` as in the context table, scopes `scopesForAccess`, `tc: { id: callId, name }`.
- The app has 30 s for headers and body (`callTimeoutMs`, `DEFAULT_CALL_TIMEOUT_MS`): `<app> did not answer within 30 seconds.` (outcome `timeout`), `<app> could not be reached.` (`unreachable`), `<app> failed to run <tool>.` (`app_error`), `<tool> is no longer available in <app>. Its tool list is being refreshed; list tools again.` (the app answered `unknown_tool`; the snapshot is re-synced).

### Audit

Every call, allowed or not, logs one `mcp.tool_call` line and writes one `mcp_tool_calls` row after the response (`apps/every-app-gateway/src/server/toolbus/runtime.ts`): `surface`, `app`, `tool`, `risk`, `decision` (`allowed`/`blocked`), `reason`, `outcome` (`ok`, `tool_error`, `invalid_arguments`, `app_error`, `timeout`, `unreachable`, `not_run`), `ms`, `args_digest` (the first 32 hex characters of HMAC-SHA256 keyed with `BETTER_AUTH_SECRET`, context `every-app-gateway:mcp-args:v1`, over the canonical arguments), `result_bytes`, `proto`, `request_id` (`cf-ray`), `call_id`, `cred_kind`, `cred_id` (omitted when the credential is an Access email), `org`, `user_id`. Never the arguments or the result. The hourly cron deletes rows older than `MCP_AUDIT_RETENTION_DAYS`.

## Connecting clients

The person's steps are on [/docs/connect-ai](/docs/connect-ai); the facts behind them:

| Client                                                                 | Identifies itself by                            | Connect                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude.ai (web, Desktop, mobile), ChatGPT, VS Code, Codex, Copilot CLI | Client ID Metadata Document (CIMD)              | Give the client `https://<gateway>/mcp` as the server URL; it discovers the OAuth server from the 401 challenge, and the consent page opens in the browser.                                                                                         |
| Claude Code (2.1.81 and later uses CIMD)                               | CIMD                                            | `claude mcp add --transport http everyapp https://<gateway>/mcp`, then `/mcp` → everyapp → Authenticate. `everyapp_whoami` then answers with your account.                                                                                          |
| Cursor, Gemini CLI, MCP Inspector, older clients                       | Dynamic client registration (`/oauth/register`) | Same URL; they register a client first, which `MCP_DCR_ENABLED` controls. MCP Inspector's direct (browser) mode also needs its origin in `MCP_ALLOWED_ORIGINS` (`http://localhost:6274`).                                                           |
| Scripts, and any client that takes a header                            | Personal access token                           | `Authorization: Bearer epat_…` on `https://<gateway>/mcp` (every app) or `https://<app-host>/mcp` (one app): `claude mcp add --transport http todos https://<app-host>/mcp --header "Authorization: Bearer $EVERYAPP_TOKEN"` (`starter/README.md`). |

### Personal access tokens

`apps/every-app-gateway/src/server/services/UserPatService.ts`, `apps/every-app-gateway/src/schemas/user-token.ts`, `apps/every-app-gateway/src/routes/_app/admin/tokens.tsx`. A token is `epat_` followed by 64 hex characters (32 random bytes); only an HMAC-SHA256 of it (`hashUserPat`, context `every-app-gateway:user-pat:v1`, keyed with `BETTER_AUTH_SECRET`; `apps/every-app-gateway/src/server/user-pat-hash.ts`) and the prefix `epat_` plus 4 characters are stored. A person creates one in the Gateway under "Manage workspace" (the sidebar footer's link to `/admin`, `apps/every-app-gateway/src/client/components/Sidebar.tsx`; the user page [/docs/connect-ai](/docs/connect-ai) spells it Admin → Tokens, `starter/README.md` Manage workspace → Tokens), tab "Tokens" (`/admin/tokens`, `apps/every-app-gateway/src/routes/_app/admin.tsx`), heading "Personal access tokens", button "Create access token": a name (at most 64 characters), "All my apps" or one app (a token bound to an app opens that app only: `boundToAnotherApp`, `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts`), and an expiry (default 90 days; between 1 day and 1 year). The admin layout is owner/admin-gated (`Only owners and admins of this organization can manage users, apps and tokens.`), so only they reach the page (a `TODO` in `tokens.tsx`: move it to a member-accessible settings page). The dialog sets no scopes, so the token is stored with `*` and is read & write on `/mcp`; the server function's schema accepts `scopes` (at most 20, each matching `^[a-z0-9][a-z0-9:_-]{0,63}$`, none starting with `provider:`), so a read-only token (`mcp:read`) needs a caller that passes them. A token whose scopes are all `mcp:` scopes is MCP-only: every app route other than `/mcp` answers it `403 { "error": "forbidden", "reason": "token_scope" }` (`isMcpOnlyCredential`, `packages/perimeter/src/session.ts`). A deploy key (`deploy` scope alone, 30-day default) opens no app and no `/mcp`. Revoke on the same page; a revoked or expired token fails verification (401) on its next use.

### The consent page

`GET /oauth/authorize` (`apps/every-app-gateway/src/server/mcp-auth/authorize.ts`) validates the request with the library, requires PKCE S256 of every client (`This app didn't use PKCE (S256), which Every App requires.`), refuses a client id or redirect URI on the platform's domains (the Gateway's host, `APP_BASE_DOMAIN`, or any host under either: `This app uses an address on this gateway's own domain, which only Every App itself may use.`), shows errors on its own page rather than redirecting (registration is open, so a redirect could go anywhere), sends a signed-out user to `/sign-in` and back, then starts a consent transaction (a one-time handle, bound to the browser by a `__Host-everyapp-oauth-` cookie, for ten minutes) and redirects to `/oauth/consent`.

The page (`apps/every-app-gateway/src/server/mcp-auth/consent.ts`, `apps/every-app-gateway/src/client/components/oauth/ConsentForm.tsx`) shows: the client's name (control and formatting characters removed, at most 80 characters, `Unnamed app` when empty); for a CIMD client `Published by <domain>`, shown as verified only when access goes to that domain, a subdomain of it, or an app on this computer (a loopback redirect) (`domainCoversRedirect`, `clientSite.ts`), and a warning otherwise; for a dynamically registered client `This app named itself; its name is not verified.`; where access will be sent (the redirect host); the signed-in email; the user's active organizations with their role; each organization's apps with whether they have tools (ready, none, or `(tools load on first use)` while unknown). The user chooses the organization, `All apps I can use, including future ones` or `Only these apps`, and read & write (default) or `Read only`, then Allow or Deny.

`POST /oauth/consent/decision` must come from the page itself (`Sec-Fetch-Site: same-origin`, or an `Origin` equal to the issuer in a browser without that header), from a signed-in user, with a form of at most 64 KiB. Approving records an `mcp_connections` row whose id `mcpc_<32 hex>` derives from the handle (so a double-clicked Allow records one; the second gets `409 Already answered`), completes the authorization with ids-only props `{ v: 1, kind: "oauth", connectionId, userId, organizationId }`, grants `mcp:read`, `mcp:write` when read & write was chosen, and `offline_access` when the client asked for it (`grantedScopes`), then supersedes the user's earlier connections through the same client in the same organization (for a CIMD client, the same installation's: same redirect URI, a loopback redirect's port not counting; `McpConnectionService.supersedeEarlier`, `installation.ts`). Denying redirects with `access_denied`. Logged as `mcp.connection.created`.

### Connections and revocation

`apps/every-app-gateway/src/server/services/McpConnectionService.ts`. A person lists and disconnects their connections at `/settings/connections`: the "AI connections" link in the sidebar footer (its `nav` is labelled "Workspace settings", `apps/every-app-gateway/src/client/components/Sidebar.tsx`), a page titled "AI connections" (`apps/every-app-gateway/src/routes/_app/settings/connections.tsx`; the user page [/docs/connect-ai](/docs/connect-ai) and `docs/runbooks/cloudflare-access.md` call it "Connected AI apps"): client name and domain, organization, apps (all or named), access, created and last used. A connection ends when the user revokes it (`mcp.connection.revoked`, reason `user`; its grant in `OAUTH_KV` is revoked too), when the member is removed from the organization (`member_removed`; all of their connections there) or deactivated (`user_deactivated`; all of theirs), when the same client connects again (superseded), when the client revokes its own token or the grant lapses after 30 days without a refresh (listed as ended), or after 31 days unused (the cron marks it `expired`). A refresh for a connection that no longer stands fails with `invalid_grant` (`This connection was revoked. Connect again.`), which also revokes the grant; a request with such a token gets `invalid_token` (`This connection was revoked or lost its access. Connect again.`). Removing a user's access to an app only drops that app from their connections' tools.

## The OAuth server

`apps/every-app-gateway/src/server/mcp-auth/config.ts`: `@cloudflare/workers-oauth-provider` 1.2, both the authorization server and the resource server, in the Gateway Worker. The issuer is `GATEWAY_URL`'s origin, which must be `https`, or `http` on exactly `localhost` (not `*.localhost`) or a `127.0.0.0/8` address (`/^127(?:\.\d{1,3}){3}$/`, `canonicalIssuer`); otherwise OAuth stays off (`mcp.oauth.unavailable`) and `/mcp` takes personal tokens only. Changing `GATEWAY_URL` invalidates every connection. The one protected resource is `<GATEWAY_URL>/mcp`: Claude requires the protected resource metadata to name the exact URL the user typed, path included and no trailing slash, so there is one connector per Gateway, not one per app.

### Endpoints

| Path                                             | Served by                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/mcp`                                           | The resource server (OAuth tokens and PATs), or the Access path when a verified assertion is present.                                                                                                                                                                      |
| `/.well-known/oauth-protected-resource/mcp`      | RFC 9728 metadata: `resource` exactly `<GATEWAY_URL>/mcp`, `authorization_servers: ["<GATEWAY_URL>"]`, `resource_name: "Every App"`.                                                                                                                                       |
| `/.well-known/oauth-authorization-server`        | `issuer`, `client_id_metadata_document_supported: true`, `code_challenge_methods_supported: ["S256"]`, `"none"` among `token_endpoint_auth_methods_supported`, `scopes_supported` `mcp:read`, `mcp:write`, `offline_access`; `registration_endpoint` only while DCR is on. |
| `/oauth/authorize`                               | `GET` only (405 otherwise): validation, sign-in, consent transaction.                                                                                                                                                                                                      |
| `/oauth/consent`, `POST /oauth/consent/decision` | The consent page and its form.                                                                                                                                                                                                                                             |
| `/oauth/token`                                   | Token exchange, refresh and revocation; body at most 64 KiB; a client id on the platform's domains answers `401 invalid_client`.                                                                                                                                           |
| `/oauth/register`                                | Dynamic client registration, within limits; `404 { "error": "registration_disabled" }` when DCR is off.                                                                                                                                                                    |

Any other `/mcp/*`, `/oauth/*` or discovery path answers `404 { "error": "not_found" }`; with OAuth off, every OAuth path answers `404 { "error": "oauth_disabled" }`. A failed route (D1 or KV down) answers 503 in the shape its caller reads (`unavailable`, `routes.ts`): an HTML page (`Something went wrong`, no `retry-after`) on `/oauth/authorize` and `/oauth/consent/decision`; JSON-RPC `-32603 Every App is unavailable just now.` with `retry-after: 30` on `/mcp`; `{ "error": "temporarily_unavailable", "error_description": "Try again in a moment." }` with `retry-after: 30` on the other OAuth paths.

### Switches

Set with `pnpm everyapp secret set <NAME>` (a prompt reads the value); locally in `apps/every-app-gateway/.dev.vars`. Parsing in `apps/every-app-gateway/src/server/oauth-flag.ts`: on-values are `true`, `1`, `on`, `yes`; off-values `false`, `0`, `off`, `no` (case-insensitive, trimmed). Unset or an on-value means on. Any other value turns the switch off and logs `mcp.oauth.flag_unrecognized` once per value, with the reason `<name> is neither on nor off, so it is off. Use "false", or delete it.`

| Name                       | Default | Effect                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_OAUTH_ENABLED`        | on      | Off: `/oauth/*` and the discovery documents return 404, `/mcp` accepts `epat_` tokens only, and its 401 names no authorization server. Connections stay recorded and work again when it is turned back on, unless revoked or lapsed meanwhile.                                                                                               |
| `MCP_DCR_ENABLED`          | on      | Off: the authorization server metadata names no `registration_endpoint`, `/oauth/register` returns 404, only CIMD clients can connect, and clients registered before keep working until their registration lapses.                                                                                                                           |
| `MCP_ALLOWED_ORIGINS`      | none    | Browser origins, besides the Gateway's own, that can call `/mcp`; comma or space separated, each parsed as a URL and reduced to a lowercase `http`/`https` origin (`allowedOrigins`, `gateway-mcp.ts`). Behind Cloudflare Access's Managed OAuth a page on such an origin can also call as the person whose Access cookie the browser holds. |
| `MCP_AUDIT_RETENTION_DAYS` | 90      | Days of `mcp_tool_calls` the hourly cron keeps: an integer of at least 1, capped at 3650 (`MAX_AUDIT_RETENTION_DAYS`); a non-integer or a value below 1 means 90 (`retentionDays`, `apps/every-app-gateway/src/server/mcp-auth/maintenance.ts`).                                                                                             |
| `MCP_ACCESS_TOKEN_TTL`     | 3600    | Local testing only (`secret set` refuses it): shorter access tokens, at least 60 s, honored only when the issuer is `http://` (loopback).                                                                                                                                                                                                    |

### Client registration

A client identifies itself one of two ways:

- **CIMD** (Client ID Metadata Document): the client id is an https URL serving its metadata; nothing is stored until a user connects. The Gateway fetches it under the `global_fetch_strictly_public` compatibility flag (`apps/every-app-gateway/cloudflare.config.ts`): the fetch goes out through Cloudflare's front door as a request from the internet would, never straight to an origin behind a zone, and the flag is what makes the server advertise `client_id_metadata_document_supported`. Because the front door of the Gateway's own domain is the Gateway itself, client ids and redirect URIs on the platform's domains are refused before anything is fetched (`apps/every-app-gateway/src/server/mcp-auth/own-domain.ts`). A document that can't be fetched shows `This app couldn't be verified: its client metadata document could not be fetched. Try again later.` and logs `mcp.oauth.cimd_failed`.
- **DCR** (`/oauth/register`, `apps/every-app-gateway/src/server/mcp-auth/registration.ts`): anyone can register, so it is bounded. The body is read with a 16 KiB cap (413 `invalid_request`); only `client_name` (cleaned, at most 200 characters), up to 10 `redirect_uris` of at most 2048 characters (400 `invalid_redirect_uri` past either), `grant_types`, `response_types`, `token_endpoint_auth_methods_supported` (passed through as sent, whatever their length; the library refuses malformed ones) and `token_endpoint_auth_method` (a string is cut to 100 characters) reach the library; contacts, logo, policy and terms URIs are dropped. A registration that omits `token_endpoint_auth_method` is registered as a public client (`none`, PKCE required) instead of RFC 7591's `client_secret_basic`, because most MCP clients that omit it never keep a secret, unless it names Perplexity's callback (`client_secret_post`) or lists supported methods without `none`. Limits (`registration-limit.ts`): 5 a minute per client address per isolate (429, `retry-after: 60`), and per UTC day in D1 `rate_limit_counters`, 20 per address (an IPv6 address by its /64) and 200 per Gateway when self-hosted, 200 and 20,000 on the hosted Gateway, none when the deployment mode is invalid (`apps/every-app-gateway/src/server/platform-policy.ts`); only a registration that gets 201 spends the budget. Past a budget: `429 { "error": "rate_limited", "error_description": "Too many client registrations. Try again later, or connect with a client that publishes a client ID metadata document." }`, logged once per isolate and day as `mcp.oauth.registration_limited`; a budget that can't be read answers `503 temporarily_unavailable`. A registration lasts 60 days without use (`CLIENT_REGISTRATION_TTL_SECONDS`, twice the grant TTL) and renews while its client keeps refreshing. Before any of this, `POST /oauth/register` and `POST /oauth/token` are counted by the Gateway's credential rate limiter while OAuth is on (`rateLimitCredentialRequest`, `apps/every-app-gateway/src/server/auth-rate-limit.ts`, run by `serveGuarded` in `apps/every-app-gateway/src/server.ts` before the route): the Workers Rate Limiting binding `AUTH_RATE_LIMIT_IP`, 60 requests per 60 s per client address (an IPv6 address by its /64), counted per Cloudflare location (`apps/every-app-gateway/cloudflare.config.ts`). Past it: `429 { "error": "rate_limited", "message": "Too many attempts. Wait a minute and try again." }` with `retry-after: 60`, before the DCR budgets are read; the body is never read, so only the address counts.

### Token lifetimes

| Token                     | Lifetime                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Access token              | 3600 s (`ACCESS_TOKEN_TTL_SECONDS`).                                                                                                                                     |
| Refresh token / grant     | 30 days from consent (`REFRESH_TOKEN_TTL_SECONDS`, also the idle TTL); each refresh moves it 30 days later, so a connection in use keeps working and an idle one lapses. |
| Client registration (DCR) | 60 days unused.                                                                                                                                                          |
| Consent transaction       | 10 minutes, one use.                                                                                                                                                     |

### Housekeeping

The Gateway's cron `17 * * * *` runs `runMcpMaintenance` (`maintenance.ts`): deletes `mcp_tool_calls` older than `MCP_AUDIT_RETENTION_DAYS` (up to 20,000 a run; `audit_behind: true` as a warning when more remain), marks connections unused for 31 days (`CONNECTION_IDLE_DAYS`) expired, deletes rate-limit counters whose day ended, and sweeps expired and orphaned grants and tokens from `OAUTH_KV` 50 at a time, resuming from the `purge-cursor` key (after three failed runs in a row it starts a new sweep). Each run logs one `mcp.maintenance` line; a failed step logs `mcp.maintenance.failed` and the others still run. What the Gateway needs for all of this (the `OAUTH_KV` namespace `every-app-gateway-OAUTH_KV`, the compatibility flag, the cron, the migrations creating `mcp_connections`, `mcp_connection_apps`, `mcp_tool_calls` and `rate_limit_counters`) ships with it and `pnpm everyapp setup` provisions it.

### Behind Cloudflare Access

PR #361 (merged 2026-10-20) made the Gateway's `/mcp` take a verified Cloudflare Access assertion as the caller, so an operator can turn on Access's Managed OAuth for the Gateway's host and bypass nothing (`routes.ts` `serveMcpThroughAccess`, `access-caller.ts`; the perimeter side is on [/docs/agent/access](/docs/agent/access) and in `docs/runbooks/cloudflare-access.md`, "MCP through Access too"). With the outer ring configured, a `/mcp` request carrying a non-blank `Cf-Access-Jwt-Assertion` header (the header only, never the `CF_Authorization` cookie) is first checked for a browser `Origin` as every request is (403 `Forbidden: origin not allowed.` before anything is read for the person, since behind Managed OAuth Access vouches for a cookie-carrying browser too), then the assertion is verified against the team's keys and the Gateway's own application AUD. One that doesn't verify (forged, a service token's, or the apps' application's) is ignored and logged `mcp.access_assertion_ignored` (reason `invalid` or `audience`), and the request is served as before, with whatever `Authorization` carries. A verified identity acts as the account the outer ring linked for it (the `accounts` row with `providerId: "cloudflare-access"` and the email; a `users` row that merely shares the email is never a fallback), else `403 not_connected` with `No Every App account is connected to this Cloudflare Access identity. Open <gateway> in your browser, sign in once, then connect again.`; it must not be deactivated; its organization is the only one it belongs to, else the active organization of its most recent live browser session, else `403 organization_unresolved` (`You belong to several organizations here. Open the gateway in your browser and pick one first.`). The caller then has write access to every app the member can use, credential kind `access` with the email as id, actor `access:<email>`; no connection row is written, so `/settings/connections` shows nothing and revocation happens at Access or by deactivating. With Managed OAuth on, Access is the OAuth server AI apps talk to (it serves the discovery documents on the hostname), the Gateway's own OAuth server, consent page and DCR go idle, and the `Authorization` header holds Access's opaque token, which is never looked at when the assertion verified.

`pnpm everyapp access on` (`packages/cli/src/commands/access/index.ts`; the plan in `packages/cli/src/lib/access/plan.ts`) keeps the machine endpoints outside Access unless Managed OAuth is on: on the Gateway's host, `/mcp`, `/mcp/*`, `/oauth/token`, `/oauth/register` and `/.well-known/*` are public path overrides (`GATEWAY_BYPASS_PATHS`; `/oauth/authorize` and the consent page are pages for people and stay behind Access), and on the apps' wildcard `*.<base>` and on each app host with public routes, `/mcp` and `/mcp/*` (`MCP_PATHS`) come before the app's routes. Its tick line says `MCP and the OAuth endpoints let through` and its done message `MCP clients and personal access tokens keep working: /mcp, the OAuth endpoints and each app's public routes are let through without a login.` When the Gateway's application has Managed OAuth on (`oauth_configuration.enabled === true`, `managedOAuthOn`), `access on` and `access show` plan no MCP or OAuth override on either application, and each app's public routes stay let through (`gatewayDestination(host, true)` has none, `appsDestinations(…, { mcp: false })` drops the MCP paths); `access show` prints `· Managed OAuth` after the Gateway's application and reports `data.applications.gateway.managedOAuth: true` under `--json`; `access off` warns `The Gateway's application has Managed OAuth on: AI apps connected through it stop.` before deleting it. Managed OAuth itself is a switch on the Gateway's application at Access (the runbook); `access on --managed-oauth` is not built ("Open decisions"). Step by step for the outer ring: `packages/cli/skills/everyapp/setup/access.md`, in an app `.claude/skills/everyapp/setup/access.md`.

## The app host's own `/mcp` and `mcp: "app"`

`packages/perimeter/src/gateway.ts`, `apps/every-app-gateway/src/server/toolbus/app-host-mcp.ts`. `https://<app-host>/mcp` is private (never in the manifest's `public` routes) and offers no OAuth: its 401 challenge is `Bearer realm="every-app"` or, for a bearer that isn't a personal token, `Bearer realm="every-app", error="invalid_token", error_description="Use a personal access token here, or connect <GATEWAY_URL>/mcp"`; the RFC 9728 paths `/.well-known/oauth-protected-resource*` answer 404 there. The perimeter authenticates the caller first: a personal access token (`Authorization: Bearer epat_…`; an OAuth access token is refused), or the user's browser session from the app's own pages (intended, so an app can call its own tools; the CSRF check requires a cookie-carrying `POST` to be same-origin: `Sec-Fetch-Site: same-origin`, or without that header an `Origin` on the app's host; a sibling app's page or another site gets `403 csrf_denied`). It checks the caller's access to the app, refuses an MCP-only token on every other path (`403 token_scope`), then, for the exact path `/mcp`, unless the manifest says `mcp: "app"` or declares `/mcp` public, hands the request to the ToolBus (`interceptMcp`). Token scopes set access as on the connector (`*` or `mcp:write` read & write, `mcp:read` read only, otherwise `403 { "error": "forbidden", "reason": "token_scope" }`); a browser session is read & write. Tools are served under their own names with `serverInfo` name `every-app-<app-id>` and title the app's name. With no serving snapshot (an app without `defineTools()`, or on an SDK older than 0.3) the request is proxied to the app as before, so an app that answers `/mcp` itself keeps working; only a `POST` makes the Gateway take a missing or outdated snapshot.

The manifest field (`packages/perimeter/src/manifest/manifest.ts`): `mcp: "gateway"` (the default when the field is absent) serves `<app-host>/mcp` from the app's `defineTools()`; `mcp: "app"` leaves the path to the app's own MCP server, which the perimeter then proxies with the usual identity header. That identity is an ordinary one, not an MCP-channel one (`packages/perimeter/src/gateway.ts`: `channel: session.credential?.channel ?? "web"`, `actor` and `scopes` from the credential): for a personal token `chan: "api"`, `act.sub` `pat:<token id>`, `scopes` the token's (`["*"]` when it was created without scopes; `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts`); for the app's own browser session `chan: "web"`, no `act`, no `scopes`. Never `chan: "mcp"`, never a `tc` claim; the Gateway applies no tool policy, checks no arguments and writes no `mcp_tool_calls` row for such a request. Such an app runs its own MCP server (the SDK no longer ships one: its `createMcpHandler` was deprecated in 0.3.0 and is gone) and consumes the verified `EveryAppUser` itself; the Gateway proxies `/mcp` to it only because it defines no tools or sets `mcp: "app"`. `defineTools()` is the supported path. The manifest's `scopes` field (a record of scope id, matching `^[a-z0-9][a-z0-9:_-]{0,63}$`, to a description of at most 200 characters; `*` and `provider:*` reserved) declares opaque app-domain scopes personal tokens can request; the Gateway itself acts on `*`, `mcp:read`, `mcp:write` and `deploy`, and passes a token's scopes to the app in the identity's `scopes` for the app to interpret.

## Local dev

`pnpm everyapp dev` (`packages/cli/src/commands/dev/index.ts`, `devAppGateway.ts`) serves `http://<app-id>.localhost:8787/mcp` from a local ToolBus (`packages/toolbus/src/dev/index.ts`) with the same policy, argument checks and identity contract as the Gateway; the ready block prints it under "MCP". In stub mode (the default) any bearer token acts as the seeded dev user; in mirror mode (`--mode mirror`) a personal access token from the separately running local Gateway is verified for real. The catalog is refetched from the live app every 2 s (`DEFAULT_CATALOG_TTL_MS`), so edits to `defineTools()` show on the next request; identities are signed with the SDK's dev keypair (`kid` `everyapp-identity-dev`) for the audience `<app-id>`, which an app trusts only under `EVERYAPP_DEV`. Only localhost-class `Host` values are served (403 `Forbidden: invalid Host header.`) and any localhost origin can call, with CORS preflights answered, so MCP Inspector works. Each call prints a `dev.mcp` progress line, its parts joined by two spaces and the outcome or reason written as words (underscores become spaces): `MCP  <tool>  <outcome>  <ms>ms` (`MCP  create_todo  tool error  8ms`) or `MCP  <tool>  blocked: <reason>` (`blocked: read only connection`); a catalog problem prints once as a `TOOLS_CATALOG` warning (`Agent tools: <problem>`). An app without tools, or without the contract, keeps `/mcp` for itself.

Point Claude Code at it as `packages/cli/skills/everyapp/mcp.md` does for a deployed app, with any bearer value in stub mode: `claude mcp add --transport http todo-local http://<app-id>.localhost:8787/mcp --header "Authorization: Bearer dev"`. Caveat: the dev ToolBus gives its view no `refresh`, so the 2026-07-28 era declares `listChanged: false` there and Claude Code does not learn of edited tools without reconnecting; only 2025-era clients get the session-hash notification (TODO.md, "everyapp dev: let Claude Code see edited defineTools() without reconnecting").

To test the OAuth server itself locally, run the Gateway on `http://localhost:19300` with `GATEWAY_URL=http://localhost:19300` in `.dev.vars` and follow the runbook's "Test locally" (`apps/every-app-gateway/scripts/mcp-oauth-local.mjs`, run from `apps/every-app-gateway` as `node scripts/mcp-oauth-local.mjs --gateway http://localhost:19300` with `EVERYAPP_EMAIL` and `EVERYAPP_PASSWORD` set; flags `--org <slug>`, `--read-only`, `--conformance`, `--cimd <client id URL> --redirect-uri <uri>`; or `claude mcp add --transport http everyapp-local http://localhost:19300/mcp`); a Gateway under `vite dev` has no service bindings to apps, so it lists only the built-in tools.

## Logs

| Event                                                       | Meaning                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp.tool_call`                                             | One per call (see "Audit"); `mcp.tool_call.audit_failed` when the D1 row couldn't be written.                                                                                                                                                                   |
| `mcp.catalog.sync`                                          | One per snapshot: `app`, `org`, `trigger`, `status`, `tools`, `warnings`, `error`; `mcp.catalog.sync_failed` when the app couldn't be asked; `mcp.catalog.unavailable` when D1 couldn't be read.                                                                |
| `mcp.oauth.error`                                           | The library's error: `status`, `error`, `category`, `reason`; `mcp.oauth.unavailable`, `mcp.oauth.flag_unrecognized`, `mcp.oauth.cimd_failed`, `mcp.oauth.registration_limited`, `mcp.oauth.registration_budget_unreadable`, `mcp.oauth.connection_unreadable`. |
| `mcp.connection.created`, `mcp.connection.revoked`          | Consent and revocation; `mcp.connection.grant_revoke_failed`, `mcp.connection.supersede_failed`, `mcp.connection.revoke_failed` for best-effort steps.                                                                                                          |
| `mcp.access_assertion_ignored`, `mcp.access_caller_refused` | The Access path: an assertion that didn't verify, or a refused person (reason only, never the email).                                                                                                                                                           |
| `mcp.maintenance`, `mcp.maintenance.failed`                 | The hourly run and its failed steps.                                                                                                                                                                                                                            |
| `mcp.route.failed`                                          | An MCP or OAuth route threw; the caller got a 503.                                                                                                                                                                                                              |
| `mcp.pat.touch_failed`, `mcp.connection.touch_failed`       | The token's or connection's last-used time couldn't be written after a `/mcp` request (best effort, in the background; `mcp-auth/validate.ts`).                                                                                                                 |
| `mcp.connection.grants_unreadable`                          | The user's grants in `OAUTH_KV` couldn't be listed while listing their connections, so none is marked ended that run (`McpConnectionService.ts` `listForUser`).                                                                                                 |
| `mcp.oauth.registration_budget_unwritable`                  | A registration got 201 but its daily counter in `rate_limit_counters` couldn't be incremented (`registration-limit.ts` `spend`).                                                                                                                                |

## Open decisions

From `TODO.md`:

- **MCP defaults.** OAuth is on, and dynamic client registration is on with limits; `MCP_OAUTH_ENABLED=false` and `MCP_DCR_ENABLED=false` turn them off.
- **Destructive tools** stay hidden from AI clients until approvals exist; approvals by browser link, then show them again. An "Agent activity" page over `mcp_tool_calls`.
- **Tool list changes** (2026-10-19): a poll rechecks the connection or token, not the access token's expiry, so a held stream can run up to ten minutes past an expired token (the client's next request gets 401); on the app-host surface a poll rechecks nothing (the perimeter authenticates per request; a held stream there only re-reads the snapshot). To decide: the 30 s poll and 10-minute cap (`listenPollMs`, `listenMaxMs` on `ToolBusDeps`); the per-isolate cap of 8 streams (a global cap needs a counter outside the isolate); whether the app-host surface should hold streams and recheck the caller too; whether a stale session's `tools/list` should answer 404 rather than keep notifying.
- **Tool snapshots** (2026-10-19): the consent page and `/mcp` sync missing snapshots within the request (3 s, 20 apps); not built: a deploy-time trigger from the CLI (`everyapp deploy` telling the Gateway about the version it recorded), an hourly reconcile in the cron.
- **MCP through Access** (2026-10-20): the Access identity must already be linked by a browser sign-in (`/mcp` never creates an account or membership); write access to every app; the organization rule; no connection row. Alternatives rejected for now: auto-join from `/mcp`; read-only by default. `everyapp access on --managed-oauth` offering Managed OAuth (not built; `access on` already reads `oauth_configuration.enabled` on the Gateway's application and then bypasses nothing for `/mcp` on either application); the apps' application taking Managed OAuth too, once the perimeter accepts the assertion on `<app-host>/mcp`.
- A member of two organizations keeps one MCP connection per organization for the same AI client.
- `everyapp dev`: give the dev ToolBus a `refresh` so Claude Code sees edited `defineTools()` without reconnecting.
- A longer tool-call limit than 30 seconds for apps that need it.
- A deploy key opens no app and no `/mcp`, even its owner's.
- **Access levels for personal access tokens.** Today the dialog creates `*` tokens only; a read-only one (`mcp:read`) needs a caller that passes `scopes`.
- **OAuth: refuse app hosts outside the Gateway's base domain.** Theoretical today: the deploy already forces them to match.
- To verify live: `secret set MCP_OAUTH_ENABLED` takes effect without a deploy and survives `setup`; the cron logs `mcp.maintenance` at :17; the Gateway takes an app's tools on first `/mcp` use and again after a redeploy; a connected Claude Code refetches `tools/list` within about 30 s of a deploy.

## Sources

- `docs/runbooks/mcp-oauth.md`
- `packages/cli/skills/everyapp/mcp.md`
- `docs/security-model.md`
- `docs/runbooks/cloudflare-access.md`
- `TODO.md`
- `packages/sdk/src/server/tools.ts`
- `packages/sdk/src/server/toolsEndpoint.ts`
- `packages/sdk/src/server/everyApp.ts`
- `packages/sdk/src/internal/tools.ts`
- `packages/sdk/src/internal/protocol.ts`
- `packages/toolbus/package.json`
- `packages/toolbus/src/index.ts`
- `packages/toolbus/src/types.ts`
- `packages/toolbus/src/names.ts`
- `packages/toolbus/src/builtins.ts`
- `packages/toolbus/src/server.ts`
- `packages/toolbus/src/http.ts`
- `packages/toolbus/src/catalog.ts`
- `packages/toolbus/src/execute.ts`
- `packages/toolbus/src/policy.ts`
- `packages/toolbus/src/principal.ts`
- `packages/toolbus/src/view.ts`
- `packages/toolbus/src/validation.ts`
- `packages/toolbus/src/digest.ts`
- `packages/toolbus/src/io.ts`
- `packages/toolbus/src/dev/index.ts`
- `apps/every-app-gateway/cloudflare.config.ts`
- `apps/every-app-gateway/src/server/oauth-flag.ts`
- `apps/every-app-gateway/src/server/platform-policy.ts`
- `apps/every-app-gateway/src/server/app-activation.ts`
- `apps/every-app-gateway/src/server/deploy/run.ts`
- `apps/every-app-gateway/src/server/toolbus/gateway-mcp.ts`
- `apps/every-app-gateway/src/server/toolbus/app-host-mcp.ts`
- `apps/every-app-gateway/src/server/toolbus/catalog-sync.ts`
- `apps/every-app-gateway/src/server/toolbus/runtime.ts`
- `apps/every-app-gateway/src/server/mcp-auth/config.ts`
- `apps/every-app-gateway/src/server/mcp-auth/routes.ts`
- `apps/every-app-gateway/src/server/mcp-auth/validate.ts`
- `apps/every-app-gateway/src/server/mcp-auth/access-caller.ts`
- `apps/every-app-gateway/src/server/mcp-auth/authorize.ts`
- `apps/every-app-gateway/src/server/mcp-auth/consent.ts`
- `apps/every-app-gateway/src/server/mcp-auth/registration.ts`
- `apps/every-app-gateway/src/server/mcp-auth/registration-limit.ts`
- `apps/every-app-gateway/src/server/mcp-auth/installation.ts`
- `apps/every-app-gateway/src/server/mcp-auth/own-domain.ts`
- `apps/every-app-gateway/src/server/mcp-auth/maintenance.ts`
- `apps/every-app-gateway/src/server/mcp-auth/body.ts`
- `apps/every-app-gateway/src/server/mcp-auth/gateway-mcp.e2e.sqlite.test.ts`
- `apps/every-app-gateway/src/server/services/McpConnectionService.ts`
- `apps/every-app-gateway/src/server/services/UserPatService.ts`
- `apps/every-app-gateway/src/server/user-pat-scopes.ts`
- `apps/every-app-gateway/src/server/user-pat-hash.ts`
- `apps/every-app-gateway/src/schemas/user-token.ts`
- `apps/every-app-gateway/src/schemas/consent-decision.ts`
- `apps/every-app-gateway/src/routes/_app/admin/tokens.tsx`
- `apps/every-app-gateway/src/routes/_app/settings/connections.tsx`
- `apps/every-app-gateway/src/client/components/admin/CreateUserTokenModal.tsx`
- `apps/every-app-gateway/src/client/components/oauth/ConsentForm.tsx`
- `apps/every-app-gateway/src/client/components/oauth/clientSite.ts`
- `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts`
- `packages/perimeter/src/manifest/manifest.ts`
- `packages/perimeter/src/gateway.ts`
- `packages/perimeter/src/session.ts`
- `packages/perimeter/src/hostSession.ts`
- `packages/cli/src/commands/dev/index.ts`
- `packages/cli/src/commands/dev/devAppGateway.ts`
- `packages/cli/src/commands/dev/ready.ts`
- `packages/cli/src/commands/dev/mode.ts`
- `packages/cli/src/commands/deploy/deployApp.ts`
- `packages/cli/src/commands/access/index.ts`
- `packages/cli/src/lib/access/plan.ts`
- `packages/cli/src/lib/access/sync.ts`
- `apps/every-app-gateway/src/routes/_app/admin.tsx`
- `landing-page/content/docs/connect-ai.mdx`
- `starter/src/tools.ts`
- `starter/src/entry.worker.ts`
- `starter/README.md`
- `packages/sdk/src/server/index.ts`
- `packages/perimeter/src/registry/registration.ts`
- `packages/cli/src/commands/create/steps/appId.ts`
- `apps/every-app-gateway/src/server.ts`
- `apps/every-app-gateway/src/server/auth-rate-limit.ts`
- `apps/every-app-gateway/src/server/capabilities/email.ts`
- `apps/every-app-gateway/src/server/repositories/AppToolRepository.ts`
- `apps/every-app-gateway/src/client/components/Sidebar.tsx`
- `apps/every-app-gateway/scripts/mcp-oauth-local.mjs`
