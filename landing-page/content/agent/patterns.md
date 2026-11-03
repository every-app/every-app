---
title: "Example patterns"
description: "A look-up table: each job an app does and the file to copy, in the starter or one of the four open apps: identity, public routes, the manifest, email and AI, agents and Workflows, tools, needs setup, cookies and tests, dev, release and install."
---

<!-- Generated from packages/cli/skills/build-every-app/patterns.md by packages/cli/src/docs/skillPages.ts; the test in packages/cli/src/docs/agentDocs.test.ts fails when this page is stale. Regenerate with `pnpm -C packages/cli docs:update`. -->

This page is `patterns.md` of the `build-every-app` skill (`packages/cli/skills/build-every-app/patterns.md` in the checkout; in an app `.agents/skills/build-every-app/patterns.md`), the table [Build an app](/docs/agent/build) looks rows up in. Each app's repository is `https://github.com/every-app/<name>`; clone it beside the app to read a file.

A look-up table: find the job, open the file, copy it. `starter/` is the template `everyapp create` copies (in an app, the same path without `starter/`). `open-crm/`, `open-analytics/`, `open-seo/` and `open-mail/` are the four open apps at `https://github.com/every-app/<name>`; a path is relative to that repository. Every field, flag and refusal code is on the agent pages (https://everyapp.com/llms.txt).

## Identity

| Pattern | Copy from | Note |
| --- | --- | --- |
| Identity in a server function | `starter/src/serverFunctions/todos.ts` | `.middleware([ensureUserMiddleware])`, then `context.user.id` into every query |
| Identity in a tool handler | `starter/src/tools.ts`; `open-crm/src/server/everyapp/crm-tool.ts` | The handler's second argument is the verified caller |
| Identity on a public route | `open-analytics/src/lib/edge/collector/collect.ts`; `open-crm/src/server/features/tracking/trackingRoutes.ts` | `getEveryAppUser()` is `null` for anyone not signed in; never assume a member |
| Organization-wide rows | `open-crm/src/middleware/ensure-user/everyApp.ts`; `open-mail/workers/everyapp/identity.ts` | Key shared rows on the organization from the token, never on a row the app wrote |
| Roles and admin-only actions | `open-crm/src/server/auth/org-gate.ts` | `isAdmin(user)` from `@every-app/sdk/server`; no role table of the app's own |
| The way back to the Gateway | `starter/src/serverFunctions/home.ts`; `open-crm/src/client/components/Sidebar.tsx` | `gatewayUrl(env)`; a sidebar's first row is a muted "‹ EveryApp" link |

## Public routes

| Pattern | Copy from | Note |
| --- | --- | --- |
| A public route with its own token | `open-analytics/src/lib/edge/auth/collect-token.ts`, `open-analytics/src/lib/edge/collector/script-endpoint.ts` | Verify the token before storing anything |
| A public route armed by a secret | `open-crm/src/server/features/erasure/erasureRoute.ts` | 404 until the optional secret is set; constant-time compare |
| Share pages and static assets | `open-analytics/everyapp.config.ts` | `public` for pages and their data, `publicAssets` for files they load |

## The manifest

| Pattern | Copy from | Note |
| --- | --- | --- |
| `id`, `name`, `description`, `icon` | `open-crm/everyapp.config.ts` | The description is the app library's one line |
| `resources.d1` and `resources.kv` | `starter/everyapp.config.ts`; `open-analytics/everyapp.config.ts` | One KV namespace per purpose |
| `resources.durableObjects` | `open-mail/everyapp.config.ts`; `open-crm/everyapp.config.ts` | Comment what one instance is |
| `resources.workflows` and `workers` | `open-seo/everyapp.config.ts` | A helper Worker declared with its service binding |
| An R2 bucket | `open-crm/cloudflare.config.ts` | The account enables R2 once (`R2_NOT_ENABLED`) |
| Postgres through Hyperdrive | `open-seo/src/db/pg/client.ts`, `open-seo/drizzle/pg.config.ts` | The person writes the URL into `.everyapp/secrets.env`; a client per request |
| Artifacts and every other resource kind | `landing-page/content/agent/manifest.md`; `packages/sdk/src/cloudflare/worker.ts` | Queues, Vectorize, Images, Browser and the rest: the manifest page has each entry and its handler |
| `migrations` | `open-crm/everyapp.config.ts` (drizzle); `open-analytics/everyapp.config.ts` (plain SQL) | The starter's default needs no `migrations` field |
| `public` | `starter/everyapp.config.ts`; `open-crm/everyapp.config.ts` | Comment why each route is open |
| `providers` and `ai.models` | `open-mail/everyapp.config.ts` | Every model id the code can send |
| `capabilities`: an API key | `open-seo/everyapp.config.ts` | `{ access, why }`, `optional` where a feature can say what is missing |
| `capabilities`: an OAuth provider | `open-mail/everyapp.config.ts` | `{ scopes, why }`: the provider's own scopes, the fewest that work |
| `capabilities.email` and `capabilities.members` | `starter/everyapp.config.ts`; `open-analytics/everyapp.config.ts` | `listMembers()` in `starter/src/serverFunctions/home.ts` |
| `secrets` | `open-analytics/everyapp.config.ts` (required); `open-crm/everyapp.config.ts` (optional) | A `why` that says how to make the value |
| `settings` | `landing-page/content/agent/manifest.md` | A per-install value that isn't a secret; never baked into `cloudflare.config.ts` |
| `access: "everyone"` | `open-crm/everyapp.config.ts` | The default is admins only |
| `build`, `dev` and `compatibilityDate` | `open-analytics/everyapp.config.ts` | `dev` must listen on `PORT` |
| `cloudflare.config.ts` beyond the manifest | `open-crm/cloudflare.config.ts` | Crons and flags that are the same for every install |

## Email and AI

| Pattern | Copy from | Note |
| --- | --- | --- |
| Sending email | `open-mail/workers/everyapp/email.ts`; `open-analytics/src/lib/notifications/edge/delivery.ts` | `sendEmail()`; a refusal is a state, not a crash |
| Receiving email | `open-mail/workers/app.ts`, `open-mail/workers/everyapp/inbound.ts` | An `email()` export beside `everyApp()`; `email: { inbound: true }` |
| AI through the Gateway | `open-mail/workers/everyapp/gateway.ts` | `createGatewayFetch({ env })` as the client's `fetch`, `aiBaseUrl(provider)` as its base URL; `aiBaseUrl()` with `model: "default"` takes the workspace's default model |
| Every AI failure as a sentence | `landing-page/content/agent/identity.md` | `refusalFromError(error)` after a failed call; on a `*_not_configured` code, show the Gateway's `setup` sentence |
| Whose call it is | `starter/src/server/events.ts` | Crons, Workflow steps and alarms run under `withOrganization()` |

## Agents, Workflows and a second Worker

| Pattern | Copy from | Note |
| --- | --- | --- |
| A Durable Object agent | `open-mail/workers/agent/index.ts` | Authorize in the Worker before the request reaches the object |
| Workflows | `open-seo/src/server/workflows/RankCheckWorkflow.ts`, `open-seo/src/server/workflows/pgStep.ts` | Name the organization once around `run()` |
| A second Worker | `open-seo/src/audit-worker.ts`, `open-seo/vite-plugin-every-app.ts` | `everyAppAuxiliaryWorker()`; only the app's Worker reaches it |
| The lean Worker bundle | `open-seo/vite-plugin-lean-worker-bundle.ts` | Fail the build when a denylisted module reaches the eager graph |

## Tools

| Pattern | Copy from | Note |
| --- | --- | --- |
| The starter's catalog | `starter/src/tools.ts`, `starter/src/server/todos.ts` | `risk` per tool; `ToolError` for a message the model may read |
| Tools per feature, with output schemas | `open-crm/src/server/everyapp/tools.ts`, `open-crm/src/server/everyapp/tools/companies.ts` | Name people by email, never by id |
| Wrapping an existing tool registry | `open-seo/src/server/everyapp/tools.ts` | `riskOf()` from the old annotations; the app's own MCP server goes |
| Tools over the private API | `open-analytics/src/lib/mcp/tools.ts` | Each tool calls the API the dashboard uses, as the caller |
| Testing the tools | `starter/src/tools.test.ts`; `open-crm/src/server/everyapp/catalog.test.ts` | `listTools()` and `callTool()` from `@every-app/sdk/testing` |

## Needs setup inside the app

| Pattern | Copy from | Note |
| --- | --- | --- |
| The starter's first screen | `starter/src/routes/index.tsx`, `starter/src/serverFunctions/home.ts` | Catch the `GatewayRefusalError` and show its code |
| A required secret | `open-analytics/src/middleware.ts` | Name the secret and `pnpm everyapp configure <app>`, or `.dev.vars` in dev |
| A capability that isn't set | `open-seo/src/server/lib/provider-access.ts` | `integrationStatus()`: `ready` gates, `setup` is the sentence to show |
| An OAuth account that isn't connected | `open-seo/src/server/features/google/googleAccess.ts` | Link to `connectUrl({ env, provider, returnTo })` |
| Calling an OAuth provider's API | `open-seo/src/server/lib/gscClient.ts` | `integrationFetch()`; the Gateway adds the token |
| Email that isn't set up | `open-mail/app/components/SendingOffBanner.tsx` | Owners and admins get the command, members whom to ask |

## Cookies, headers and tests

| Pattern | Copy from | Note |
| --- | --- | --- |
| No cookies | `packages/sdk/src/server/everyApp.ts` | The Gateway strips them; keep preferences in `localStorage` |
| Light, dark or system | `starter/src/lib/theme.ts` | Read the shared `everyapp-theme` cookie first |
| Security headers | `open-crm/src/server.ts` | `frame-ancestors 'self'` and a nonce per response |
| Tests over queries | `starter/src/server/todos.test.ts` | In-memory SQLite with the app's migrations; two people's rows stay apart |
| Two organizations kept apart | `open-crm/src/server/testing/testDb.ts`, `open-crm/src/server/features/mailbox/repositories/isolation.test.ts` | Seed two, assert neither sees the other |
| A request as a signed-in member | `packages/sdk/src/testing/index.test.ts` | `testRequest(url, { user })` and `testEnv()` |

## Dev, release and install

| Pattern | Copy from | Note |
| --- | --- | --- |
| `.dev.vars` | `open-crm/.dev.vars.example` | Name each variable and where it comes from, no values |
| The manifest and env in the Worker | `starter/src/env.d.ts`, `starter/src/serverFunctions/home.ts` | `env.EVERYAPP_MANIFEST`; `cf workers types` writes `Env` |
| Call the app as someone else | `landing-page/content/agent/dev.md` | `pnpm everyapp dev token --role member` |
| Release and install | `starter/.github/workflows/release.yml`, `docs/runbooks/app-releases.md` | `pnpm everyapp release`; anyone installs with `pnpm everyapp install <repository url>` |
