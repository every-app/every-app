---
title: Identity, headers and the SDK
description: What an app Worker receives from the Gateway on every request (headers, the identity token, env), what @every-app/sdk/server exports, and how an app calls the Gateway back for AI, capabilities, email, members and events.
---

## The request path

Every request to an app's host goes to the Gateway Worker first. Before the app sees anything, the Gateway's perimeter:

1. Finds the app from the `Host`. An unknown host is `404 no_app_for_host`; a disabled app is `503 app_unavailable`; one still deploying is `503 app_deploying`.
2. Closes an app that needs setup: a private page redirects to the Gateway (`/?setup=<app>`), anything else is `503 app_needs_setup`. Public routes stay up.
3. Refuses `/__everyapp/tools/*` from outside (404) and cross-site calls to TanStack Start server functions (`403 server_fn_denied`).
4. Checks CSRF on state-changing requests: `Sec-Fetch-Site: same-origin`, or an `Origin` equal to the app's host. A failure is `403 csrf_denied` (on a public route it just drops the identity).
5. Authenticates the session cookie or a personal access token (`Authorization: Bearer epat_…`). Behind Cloudflare Access it also checks Access's signed header.
6. Checks the person may open the app (`403 forbidden`, `reason: "no_app_access"`). A token narrower than `*` (an AI connection's `mcp:` scopes) opens no private app route (`403 token_scope`); it's for the Gateway's own `/mcp`. An app host serves no MCP.
7. Strips every inbound `cookie`, `authorization`, `x-everyapp-*` and `cf-access-*` header.
8. Mints a fresh identity token into `x-everyapp-identity`, or on a public route for an anonymous caller sets `x-everyapp-public`. With neither, the private route answers `401 unauthenticated`.
9. Calls the app over a service binding and adds security headers (HSTS, `nosniff`, `X-Frame-Options: DENY`, `noindex`) and `Server-Timing: gw;dur=…, app;dur=…` on the way back.

So an app never sees the session cookie, a personal token or anything a client typed into `x-everyapp-*`. It can't set cookies either: `everyApp()` drops `Set-Cookie`, since cookies never reach it. A response the Gateway sends itself is JSON with an `error` field.

## Headers

| Header | Meaning |
|---|---|
| `x-everyapp-identity` | The identity token, on every request from a signed-in person with access (public routes too). |
| `x-everyapp-public` | A signed marker: an anonymous caller (or a signed-in non-member) on a declared public route. |
| `x-everyapp-system` | A system token, on the Gateway's own calls: `POST /__everyapp/tools/list`, `POST /__everyapp/events`. |
| `x-everyapp-org` | Set by the SDK on a background call to the Gateway, naming the organization. |
| `x-everyapp-error` | On a refusal the Gateway makes itself (AI, capability, email): the code, readable without the body (`GATEWAY_ERROR_HEADER`). |

## The identity token

An RS256 JWT, `kid` `everyapp-identity` (`everyapp-identity-dev` under `everyapp dev`), living 120 seconds, for this app only.

| Claim | Value |
|---|---|
| `typ` | `user` (`public` on the marker, `system` on a system token). |
| `sub` | The user id. Key every row by it. |
| `email` | The user's email. |
| `org_id`, `org_role`, `org_name` | The organization, the person's role in it (`owner`, `admin`, `member`), its display name. |
| `chan` | The channel: `web` (a browser), `api` (a personal token), `mcp` (an AI client's tool call). |
| `act` | `{ sub }`: what acted for the person (`pat:<id>`, `oauth:<id>`, `access:<email>`). |
| `scopes` | `["*"]` for a session or a full token. |
| `jti`, `tc` | The token id; on a tool call, `{ id, name }` of the one call. |
| `aud`, `iss`, `sub`, `iat`, `exp` | Audience is the app's Worker name (`EVERYAPP_AUDIENCE`); issuer is the Gateway's URL. |

`everyApp()` verifies it before the handler runs: pinned `alg` and `kid`, the keys in `EVERYAPP_IDENTITY_PUBLIC_KEYS` (current and next, for rotation), audience, issuer and expiry. A failure is `401 unauthenticated`. An identity for another organization than the Worker's `EVERY_APP_ORG_ID` is refused. Apps never check scopes on their own routes; the perimeter already did.

The user object (the handler's fourth argument, `getEveryAppUser()`, `requireEveryAppUser()`) is `{ id, email, orgId, orgRole, orgName, channel, actor, scopes, jti, toolCall }`. `isAdmin(user)` is owner or admin; `hasScope()` reads the scopes.

## Env

What every app Worker gets:

| Name | Value |
|---|---|
| `EVERYAPP_APP_ID` | The manifest's id. |
| `EVERYAPP_AUDIENCE` | The Worker's name, the token's audience. |
| `EVERYAPP_IDENTITY_PUBLIC_KEYS`, `EVERYAPP_IDENTITY_ISSUER` | The Gateway's public keys and URL. Under `everyapp dev`, the well-known dev key and `https://gateway.dev.localhost`. |
| `EVERY_APP_GATEWAY` | A service binding to the Gateway, for AI, capabilities, email, members and events. Absent in dev, where the SDK calls providers directly with local keys. |
| `GATEWAY_URL`, `EVERY_APP_ORG_ID` | The Gateway's URL; the organization the Worker serves. |
| `DATABASE_PROVIDER` | `database.provider` when declared. |
| `EVERYAPP_DEV` | `"1"` in development only: trusts dev identities. |
| `EVERYAPP_SHARED` | `"1"` on a shared app. |
| `EVERYAPP_BUILD` | `1` while `everyapp deploy` builds (not at runtime). |
| `EVERYAPP_EMAIL_SENDERS` | The app's allowed sender patterns (`everyapp email set --sender`). |

The Worker never holds the manifest: the Gateway keeps `everyapp.config.ts`, and the Worker gets the bindings it lists. A value the code needs at run time (a model id, the app's name) is written in the code. `env.EVERYAPP_MANIFEST` is gone from `@every-app/sdk` after 0.3.3; a Worker built with an older SDK still gets it, without `why`, `how`, `docs` and `steps` when the manifest is over 5 KB.

Then the manifest's resources, and the app's own secrets and settings.

## The handler

```ts
// src/entry.worker.ts
import { everyApp } from "@every-app/sdk/server";
import { tools } from "./tools";

export default everyApp<Env>(async (request, env, ctx, user) => {
  // user is null only on a public route with an anonymous caller.
  return new Response(`Hello ${user?.email}`);
}, { tools });
```

A TanStack Start app passes the request to Start's server entry and reads the user in server functions with `ensureUserMiddleware` from `@every-app/sdk/tanstack-start` (the starter does). Crons and inbound mail sit beside it: `export default { ...everyApp(handler, { tools }), scheduled, email }`; their Gateway calls say whom they're for with `for: { background: true }`. `nodeServerHandler({ boot })` serves Express or NestJS.

## The server API (`@every-app/sdk/server`)

- Identity: `everyApp`, `getEveryAppUser`, `requireEveryAppUser`, `isAdmin`, `hasScope`, `gatewayUrl`.
- AI ([ai](/docs/agent/ai)): `createGatewayFetch` (the one way to call a model), `aiBaseUrl`, `providerBaseUrl`.
- Capabilities ([providers](/docs/agent/providers)): `integrationFetch`, `integrationStatus`, `connectUrl`, `connectPath`, `devAccessTokenName`.
- Email and members: `sendEmail`, `listMembers`.
- Events ([events](/docs/agent/events)): `emit`, `verifyWebhook`, `WEBHOOK_MAX_BYTES_DEFAULT`.
- Tools ([mcp](/docs/agent/mcp)): `defineTools`, `toolResult`, `ToolError`.
- Refusals: `GatewayRefusalError`, `gatewayRefusal`, `refusalFromError`, `GATEWAY_ERROR_HEADER`.
- Errors: `ConfigurationError` (500, misconfigured), `AttributionError`. A failed identity check is an error with `status` 401 (`name` `IdentityError`; the class isn't exported).
- Other: `nodeServerHandler`.

`@every-app/sdk/testing` gives `testEnv()`, `testRequest()`, `mintTestIdentity()`, `callTool()` and `listTools()` for unit tests.

## Calling the Gateway from the app

Calls go over `EVERY_APP_GATEWAY` and act for the person behind the current request. Outside a request (a cron, a queue, a Workflow step), pass `for: { background: true }` (a shared app adds `organizationId`); without it the SDK throws an error with code `request_context_missing` before any call.

- **AI**: `createGatewayFetch({ env })` with any OpenAI-compatible client, `baseURL` from `aiBaseUrl()`. The key stays on the Gateway.
- **Capabilities**: `integrationFetch({ env, provider: "dataforseo" })` returns a `fetch` that sends to the provider's own URLs; the Gateway adds the key. `integrationStatus()` says whether it's ready, without a call.
- **Email**: `sendEmail({ env, message })` through the `email` capability.
- **Members**: `listMembers({ env })` through the `members` capability: the people who can open the app.
- **Events**: `emit({ env, event, data })`, delivered as `app.<id>.<event>`.

A refusal is JSON `{ error, message }` with `x-everyapp-error`. The ones an app should handle: `ai_provider_not_configured` and `integration_not_configured` (503, the key isn't set: show setup info), `capability_not_requested` and `provider_not_allowed` (403: add it to the manifest), `model_not_allowed` (403: `ai.models`), `integration_not_connected` (409: the person must connect, or allow this app to use their connection, `connectUrl()` for both), and `app_monthly_cap_exceeded` (429: the app reached its cap; the operator raises it).

### Setup info: what to set, in the Gateway's words

A not-configured refusal and `integrationStatus()` carry `settings` (the Gateway settings it needs), `setup` (one sentence for a person) and `command` (`everyapp configure <app>`, or `null` when the reader can't run it). Show `setup` in the app where the feature would be, instead of failing. `refusalFromError(error)` reads it out of a thrown OpenAI or ai-sdk error.

## Agent tools

An app's tools are `defineTools()` passed to `everyApp(handler, { tools })`. The Gateway lists them at deploy through `/__everyapp/tools/list` and calls them through `/__everyapp/tools/call` with a `chan: "mcp"` identity for the one call. [mcp](/docs/agent/mcp)
