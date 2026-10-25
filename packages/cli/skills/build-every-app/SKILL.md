---
name: build-every-app
description: Build or change an app on Every App: create one, add a feature, a page, a table, an AI tool, a capability, a public route or a secret, the way the apps already on Every App do it. Use before writing any code for an Every App app, for "build me an app", "add X to the app" or "make the app do Y".
---

# Build an app on Every App

An Every App app is a private web app on the person's own Cloudflare account,
behind their Gateway. The Gateway signs people in, holds every key, serves the
app's tools to AI clients, and gives the app nothing it doesn't declare in
`everyapp.config.ts`. You build the app; the plumbing is done.

## Read first

1. `patterns.md`, beside this file (in an app,
   `.agents/skills/build-every-app/patterns.md`; in the checkout,
   `packages/cli/skills/build-every-app/patterns.md`; on the web,
   https://everyapp.com/docs/agent/patterns): how the apps on Every App do
   each thing, and the file to copy from, in the starter or in one of four
   open apps (OpenCRM, OpenAnalytics, OpenSEO, Agentic Inbox), at
   `https://github.com/every-app/<name>`. Read the sections for the job
   before the first edit, every time: identity and tests for a table, tools
   for a tool, the manifest for a capability. Copy a working file over
   inventing one; when a cited file is out of reach, the row's "What it is"
   and "Copy this" columns are the pattern.
2. The everyapp skill beside this one drives the CLI: every command,
   `--json`, setup, secrets, what only a person can do. Read it before running
   `pnpm everyapp`; never guess a flag.
3. https://everyapp.com/llms.txt lists every agent page with a one-line
   summary; a page is Markdown at its URL plus `.md`. In an Every App checkout
   they are `landing-page/content/agent/*.md`. Read the page for the job:
   manifest (`everyapp.config.ts`: resources, public, providers,
   capabilities, secrets, migrations), identity (what the Worker receives,
   the SDK's exports), secrets (where a key lives, `.dev.vars`), mcp (tools,
   the connector, MCP apps),
   dev (dev vs production), deploy (release and install), email.

## The shape of an app

`pnpm everyapp create ../my-app`, from the every-app folder, copies the starter
(`starter/` in the checkout; in the app it made, a `starter/` path is that path
in the app) to `my-app` beside the checkout (the path's last part is the app's
id), a git repository of its own linked to the checkout: a TanStack Start app
on a Worker with a D1 database, a todo list whose first screen shows who you
are and what the app was allowed. One repository per app is the default. (With
many apps, keep them inside the checkout instead: `pnpm everyapp create my-app`
there makes `apps/my-app`, untracked by git.)
Read the app's `README.md`, `AGENTS.md` and every file under `src/` once; they
are short. An app may carry skills of its own at its top level
(`.agents/skills/<name>`, `.claude/skills/<name>`), as OpenSEO's repository
does; read them before changing the app.

Keep, the plumbing: `everyapp.config.ts` (the manifest), `cloudflare.config.ts`
(builds the Worker from it), `src/entry.worker.ts` (`everyApp()` verifies the
identity and serves the tools), `src/middleware/ensureUser.ts` (who the
Gateway signed in), `src/db/index.ts`, `src/env.d.ts`, `vite.config.ts`,
`drizzle.config.ts`, `vitest.config.ts`, `src/routes/__root.tsx`,
`src/router.tsx`.

The example, which the app outgrows: `src/routes/index.tsx` (the page),
`src/serverFunctions/` (what the page calls, each behind
`ensureUserMiddleware`), `src/server/todos.ts` and its test (the queries),
`src/db/schema.ts` and `drizzle/` (the table and its migrations),
`src/tools.ts` (the same queries as tools), `src/routes/health.ts` (a JSON
endpoint without a page; private, like every route not under `public`). Keep
the layering: page, then server function, then a query in `src/server/`, so the
page, the tools and the test share one set of queries.

Add means add. A feature the person asks for goes beside what the app has:
the todo list, its first screen and its migration stay until the person asks
for a different app or says to take them out. Replace the example when the app
becomes something else, not on the first feature.

## The rules

1. Identity only through the SDK: `context.user` behind `ensureUserMiddleware`
   in a server function, the `user` a tool handler receives,
   `getEveryAppUser()` on a route without a page (`null` only on a public
   route, for anyone not signed in). Never from a header, cookie, query or
   body a client sent.
2. Scope every query by `user.id` unless sharing is the app's intent. Then the
   unit is the organization: the four apps key every row by the organization
   in the signed identity (`user.orgId`), every member sees the organization's
   rows, and owners and admins (`user.orgRole`) manage. An app for the whole
   organization also says so in the manifest: `access: "everyone"` (the
   default, `admins`, opens it to the deployer, owners and admins alone).
   Never an allowlist of users of your own: the Gateway decides who may open
   the app.
3. Routes are private unless listed under `public` in `everyapp.config.ts`. A
   public route exists only when the app needs one (a webhook, a collector, an
   OAuth callback); the starter has none, and its manifest's comment shows a
   webhook. It is open to the internet and checks what it must itself (a
   signature, a token the app issued, a rate limit), and returns nothing that
   is anyone's without that check.
4. Never a login page, session, password, token check or MCP server of the
   app's own. The Gateway signs people in, and its one `/mcp` is the connector
   for every app; an app's host answers `/mcp` only with the manifest opt-in
   `mcp: { by, why }`, which none of the four apps needs. Never set a cookie:
   the Gateway strips every cookie before a request reaches the app.
5. A key only this app uses goes under `secrets` (required by default;
   `optional: true` when one feature can wait; `anyOf` for one of a group),
   typed in `src/env.d.ts`, read from `env`. After the first deploy,
   `pnpm everyapp configure <app>` is the one command that sets up everything
   the app declares, each value at a hidden prompt (before that deploy,
   `pnpm everyapp configure` in the app's directory sets the Gateway's
   settings); `pnpm everyapp secret set NAME` sets one name, and is the form
   for a script. Locally, `.dev.vars`. Never ask for, print or repeat a value
   in the chat; never put one in a file you commit or on a command line.
6. AI through the Gateway: the provider under `providers` with a `why`, called
   with `createGatewayFetch({ env, for: request })`; `ai.models` lists the
   models the app may ask for. The Gateway holds the key; a provider the
   manifest doesn't list is refused.
7. A capability (`members`, `email`, `dataforseo`, `context`, an OAuth client)
   under `capabilities` with `access` and a `why`; an OAuth client
   (`google-workspace`, `microsoft-365`, `slack`) also with `scopes: [...]`,
   the least that does the job. Called with `listMembers()`, `sendEmail()`,
   `integrationFetch()`; a refusal is a state the page shows, never a crash.
8. Tools in `defineTools()` over the same `src/server/` queries, each with an
   honest `risk` (`read`, `write`, `destructive`), a description the model can
   act on, and `instructions` for the set. Throw `ToolError` for a message
   the model may read. A destructive tool stays hidden until the Gateway has
   approvals; declare it anyway.
9. Schema changes through drizzle: edit `src/db/schema.ts`, run
   `pnpm run db:generate`, commit the migration it writes. Never edit a
   migration that has been deployed.
10. A test over the queries (`src/server/*.test.ts`: an in-memory SQLite with
    the app's migrations applied), including one that two people's rows stay
    apart.
11. Before a pull request: `pnpm types:check`, `pnpm test`, and a security
    review when identity, public routes, tools, secrets or queries changed:
    `/security-review` in Claude Code against the app boundaries in
    `.agents/skills/everyapp/security-review.md` (in the checkout,
    `packages/cli/skills/everyapp/security-review.md`); any other agent
    reads `git diff` against them. No CI job, no API key.
12. `description` in `everyapp.config.ts` is the one line the app library
    shows; change it, and `name`, as soon as the app stops being a todo list.
    Add an `icon` (an SVG the app serves) when it has a look.
13. The way back: a link to the Gateway. The starter's header has one ("All
    apps", `launcher` in `src/serverFunctions/home.ts`: the identity issuer,
    `EVERYAPP_IDENTITY_ISSUER`, or the dev host under `everyapp dev`; the four
    apps read `GATEWAY_URL` first, then the issuer); keep it. When the app
    gets a sidebar, the convention the identity page states is the first row:
    muted, "‹ Every App", aria-label "Back to Every App", above the app's own
    name. OpenCRM and OpenSEO keep theirs in the sidebar footer today,
    labelled "Back to Every App".
14. After editing `everyapp.config.ts`, restart `pnpm dev`: the local Gateway
    reads it when it starts (the tools catalog is the exception). Every
    manifest change reaches the real Gateway on the next deploy.

## Working with the person

For a new app, or when the ask leaves these open, ask five short questions:
what the app is for; who uses it (just them, or everyone in the organization:
then `access: "everyone"`); what it stores (the tables); what it does on its
own (sends mail, calls a model, runs on a schedule, serves a script to a
website); what stays private to each person. Repeat the answers back in one
paragraph, then build. For a clear request, build. The database is D1 unless
the person has a Postgres (Neon, Supabase, any URL) or asks for one: then
Hyperdrive ("Postgres through Hyperdrive" in `patterns.md`), and the person
puts its URL in `.everyapp/secrets.env` themselves.

The loop: `pnpm everyapp create ../my-app` from the every-app folder (or work
in the app you are in); the schema and the queries, the server functions, the
page, the tools, the test; `pnpm dev` in the background, open the printed URL
as the test user; iterate; `pnpm run deploy` when they say so (it prints the
app's address and who can open it: tell them). Manage the workspace (people,
groups, who can open an app, caps, usage, what agents did):
`pnpm everyapp workspace --help`, or the `everyapp_workspace_*` tools on
`/mcp` as an owner or admin. A required secret, provider or capability keeps
the app at "Needs setup" until it is set: say which, and the one command,
`pnpm everyapp configure <app>`. For anything the CLI does, read the everyapp
skill. Before building a tool over a data provider the Gateway offers as an
MCP app, say so: DataForSEO's tools reach the person's AI client with no page
and nothing to deploy, `pnpm everyapp mcp on dataforseo`
(https://everyapp.com/docs/agent/mcp#mcp-apps).

For a non-technical person, say in plain words: what they will see (the page,
its first screen); where the app is (its own address, behind their Gateway, on
their Cloudflare account); who can open it (every member of the organization,
or owners and admins; a public route, if there is one, is open to anyone);
what it costs (Cloudflare usage, and any paid service a `why` line names); and
that they can use it from Claude, ChatGPT or Cursor through the Gateway's MCP
connector. No stack traces, no file paths.

## Patterns, the ten most used

| Pattern                                | Copy from                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Identity in a server function          | `starter/src/middleware/ensureUser.ts`, `starter/src/serverFunctions/todos.ts`                                |
| Identity in a tool handler             | `starter/src/tools.ts`; `open-crm/src/server/everyapp/crm-tool.ts`                                            |
| Identity on a public route             | `open-analytics/src/lib/edge/collector/collect.ts`; `open-crm/src/server/features/tracking/trackingRoutes.ts` |
| Organization-wide rows                 | `open-crm/src/middleware/ensure-user/everyApp.ts`; `agentic-inbox/workers/everyapp/identity.ts`               |
| A public route with its own token      | `open-analytics/src/lib/edge/auth/collect-token.ts`, `open-analytics/src/lib/edge/collector/collect.ts`       |
| AI through the Gateway                 | `open-crm/src/server/lib/openrouter.ts`; `agentic-inbox/workers/everyapp/gateway.ts`                          |
| Sending and receiving email            | `agentic-inbox/workers/everyapp/email.ts`; `agentic-inbox/workers/app.ts`                                     |
| A Durable Object agent                 | `open-crm/src/server/features/agent/CrmAgent.ts`; `agentic-inbox/workers/agent/index.ts`                      |
| Tools per feature, with output schemas | `open-crm/src/server/everyapp/tools.ts`, `open-crm/src/server/everyapp/tools/companies.ts`                    |
| Needs setup inside the app             | `open-crm/src/client/features/agent/AgentPaused.tsx`; `agentic-inbox/app/components/SendingOffBanner.tsx`     |

All of them, with every manifest field, Workflows and a second Worker, cookies,
the lean Worker bundle, tests, dev vs production, release and install:
`patterns.md` beside this file.
