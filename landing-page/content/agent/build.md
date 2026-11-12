---
title: "Build an app"
description: "Build or change an app on EveryApp: the six rules (the Gateway signs people in, every route private and every query scoped, schema and migrations, page to server function to query, values declared never pasted, dev, test, deploy), where things are, the starter's shape, and working with the person."
---

An EveryApp app is a private web app on the person's own Cloudflare account,
behind their Gateway. The Gateway signs people in, holds every key and serves
the app's tools to AI clients. The app gets nothing it doesn't declare in
`everyapp.config.ts`. You build the app; the plumbing is done.

## The six rules

1. **The Gateway signs people in.** Read the user only as `context.user`
   (server functions behind `ensureUserMiddleware` from
   `@every-app/sdk/tanstack-start`) or `user` (a tool handler's second
   argument). No login, session, cookie or token check of the app's own, and
   never who the user is from a header, cookie or parameter a client sent.
2. **Every route is private.** Give each row `userId` (private to a person)
   or `orgId` (shared by the team) and filter every query by it. A route is
   public only when listed under `public`, and only when something other than
   a member must reach it (a webhook, an OAuth callback); it checks what it
   must itself.
3. **Schema in `src/db/schema.ts`,** then `pnpm run db:generate`, then commit
   the migration it writes to `drizzle/`. Never edit a deployed migration.
4. **Page → server function → query in `src/server`.** Tools in `src/tools.ts`
   (`defineTools()`, each with an honest `risk`: `read` or `write`, plus
   `destructive: true` on a write tool that deletes or can't be undone) call
   the same queries, so the page, the tools and the tests share one set.
5. **A value the app needs is declared, never pasted.** The app's own key
   goes under `secrets`, a plain per-install value under `settings`; a key the
   Gateway holds is a provider (`providers`, for AI, called through
   `createGatewayFetch({ env })`) or a capability (`capabilities`: `members`,
   `email`, `dataforseo`, an OAuth provider with `{ scopes, why }`). The top
   level is required. Group what is set up together, or what the app works
   without, into `features` (`{ name, why, required?, steps, secrets,
   settings, capabilities }`, each value with a `how`; optional by default,
   all or nothing; [manifest](/docs/agent/manifest#features)). Locally the value is in `.dev.vars`; after
   a deploy, `pnpm everyapp configure <app>` walks each feature's steps and
   asks for each value at a hidden prompt. A value never goes through the chat, into
   a committed file or onto a command line.
6. **`pnpm dev` to try, `pnpm test`, `pnpm run deploy` to ship.** Never
   `cf deploy` or `wrangler deploy`. Anything else:
   https://everyapp.com/llms.txt. Look rows up in
   [patterns](/docs/agent/patterns) when you need one.

## Where things are

[Example patterns](/docs/agent/patterns) maps each job to a file to copy,
in the starter or one of four open apps (OpenCRM, OpenAnalytics, OpenSEO,
OpenMail at `https://github.com/every-app/<name>`). Copy a working file over
inventing one.

This page is what the `build-every-app` skill points at. The skill and the
`everyapp` skill ship in the CLI package (`node_modules/everyapp/skills/`),
and every app links them from `.agents/skills/` and `.claude/skills/`:
never edit them. The app's own skills go under another name, and its own
guides in its repository (`docs/`).

The `everyapp` skill drives the CLI: every command, `--json`, setup,
secrets, and what only a person can do. Read it before running
`pnpm everyapp`; never guess a flag ([cli](/docs/agent/cli)).

The other agent pages answer the rest (https://everyapp.com/llms.txt lists
them; offline, `pnpm everyapp docs <page>`): [manifest](/docs/agent/manifest)
(every field of `everyapp.config.ts`), [identity](/docs/agent/identity) (what
the Worker receives, the SDK), [secrets](/docs/agent/secrets) (where each
value lives), [tools](/docs/agent/tools) (writing an app's AI tools),
[mcp](/docs/agent/mcp) (the connector), [dev](/docs/agent/dev) (dev vs
production), [deploy](/docs/agent/deploy), [email](/docs/agent/email).

## The shape of an app

`pnpm everyapp create my-app` copies the starter: a TanStack Start app on a
Worker with a D1 database, a todo list whose first screen shows who you are.
From an EveryApp checkout, `pnpm everyapp create ../my-app` makes its own
repository beside it.

- Plumbing, keep: `everyapp.config.ts` (the manifest), `cloudflare.config.ts`,
  `src/entry.worker.ts` (`everyApp()` verifies the identity and serves the
  tools), `src/db/index.ts`, `src/env.d.ts`, `vite.config.ts`,
  `drizzle.config.ts`, `vitest.config.ts`, `src/routes/__root.tsx`,
  `src/router.tsx`.
- The look, keep and build with: `src/client/components/ui/` (shadcn's
  `base-nova` components on Base UI, copied in as files, the ones the open
  apps use), `src/client/components/AppShell.tsx` (the frame every page sits
  in) and `PageHeader.tsx`, `src/client/styles/app.css` (the colour tokens,
  light and dark), `src/client/lib/theme.ts` (the light, dark or system
  pick). Add a component with `pnpm dlx shadcn@4.21.4 add <name>`
  (`components.json` keeps the style). No hand-written `.card` or `.button`
  classes, no raw colours, no font of the app's own.
- The example, which the app outgrows: `src/routes/index.tsx` (the page),
  `src/serverFunctions/` (what it calls), `src/server/todos.ts` and
  `src/server/todos.test.ts` (the queries and a test that two people's rows
  stay apart), `src/db/schema.ts` and `drizzle/`, `src/tools.ts` and
  `src/tools.test.ts`, `src/routes/health.ts` (a JSON route without a page).

Add means add: a new feature goes beside the todo list until the person asks
for a different app. When it stops being a todo list, change `name` and
`description` in `everyapp.config.ts` (the app library's one line). After
editing `everyapp.config.ts`, restart `pnpm dev`.

## Working with the person

For a new app, or an ask that leaves these open, ask: what it is for, who
uses it (just them, or the whole team: `access: "everyone"`), what it stores,
what it does on its own (mail, a model, a schedule), and what stays private
to each person. Repeat the answers in one paragraph, then build. For a clear
request, build.

The loop: the schema and queries, the server functions, the page, the tools,
the test; `pnpm dev` in the background and open the printed URL as the test
user; iterate; `pnpm run deploy` when they say so, and tell them the address
it prints and who can open it. An app that still needs a value shows "Needs
setup": name it and the one command, `pnpm everyapp configure <app>`.

Before a pull request: `pnpm types:check`, `pnpm test`, and, when identity,
public routes, tools, secrets or queries changed, a review against
[security-review](/docs/agent/security-review) (`/security-review` in Claude
Code).

For a non-technical person, say in plain words what they will see, where the
app lives (its own address behind their Gateway), who can open it, what it
costs (Cloudflare usage and any paid service a `why` names), and that Claude,
ChatGPT or Cursor can use it through the Gateway's MCP connector.
