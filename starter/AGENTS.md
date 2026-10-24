# Agent instructions

- Before running everyapp, read the everyapp skill: `.agents/skills/everyapp/SKILL.md` (also in `.claude/skills/`). `everyapp create` puts it there.
- The Gateway signs people in; this app has no login, session or token check of its own, and never builds one. Read who the user is only through the SDK: `context.user` behind `ensureUserMiddleware` (`src/middleware/ensureUser.ts`) in a server function, the `user` a tool handler receives, `getEveryAppUser()` on a public route. Never from a header, cookie or parameter a client sent.
- The Gateway admits every member of the organization; which rows each one sees is the app's job. Scope every query by `user.id`, as `src/server/todos.ts` does.
- `description` in `everyapp.config.ts` is the one line the Gateway's app library shows under the app's name; change it when the app stops being a todo list.

## Add a feature

- A page: a file in `src/routes/`, like `src/routes/index.tsx`: `createFileRoute` with a `loader` that calls server functions and a component that reads `Route.useLoaderData()`. After a change, `router.invalidate()` runs the loader again. `pnpm dev` (or `pnpm build`) rewrites `src/routeTree.gen.ts` for the new file; commit it. `pnpm types:check` alone doesn't, so a new route is a type error until one of them has run.
- Data: a server function in `src/serverFunctions/` with `.middleware([ensureUserMiddleware])` (that is where `context.user` comes from), a zod `.validator`, and a handler that calls a function in `src/server/`. Queries live in `src/server/` so the page, the tools and the test share them.
- A JSON endpoint without a page: `src/routes/health.ts` (`server.handlers`). A route is private unless listed under `public` in `everyapp.config.ts`; a public route is open to the internet and checks what it must itself.
- An AI tool: add it to `defineTools()` in `src/tools.ts` with its honest `risk` (`read`, `write`, `destructive`). The Gateway serves the tools at `/mcp` (`pnpm dev` prints the URL); a destructive tool stays hidden from AI clients until the Gateway has approvals.
- `pnpm dev` runs it locally as a test user; `pnpm test` and `pnpm types:check` before a pull request, and `/security-review` in Claude Code when identity, public routes, tools or queries changed.

## Add a table

1. Declare it in `src/db/schema.ts` (drizzle, SQLite on D1). Give it a `userId` column and filter by it in every query.
2. `pnpm run db:generate` writes the migration into `drizzle/`; commit it. `pnpm dev` applies migrations to the local database when it starts; `pnpm run deploy` applies them live.
3. Query through `db` from `@/db`. Test the queries like `src/server/todos.test.ts`: an in-memory SQLite with the app's migrations applied.
4. Another resource (a second D1 database, KV, R2, Durable Objects, Workflows): list it under `resources` in `everyapp.config.ts`; `pnpm run deploy` creates it and binds it as `env.<NAME>`; `pnpm types:check` regenerates `Env`. After editing `public` or `resources` in `everyapp.config.ts`, restart `pnpm dev`: the local Gateway reads them when it starts (the app itself reloads).

## Add a capability

A capability is something the Gateway does for the app with keys the Gateway holds. List it under `capabilities` in `everyapp.config.ts` with `access` and a `why` (an OAuth client with scope sets, `google-workspace`, `microsoft-365`, `slack`, also `scopes: [...]`; the sets are in the skill); deploying the manifest is the grant, and a call for anything not listed is refused (`capability_not_requested`). `members` is listed already and read in `src/serverFunctions/home.ts` with `listMembers()`; email is `sendEmail()` (`email`); third-party APIs and OAuth clients (`dataforseo`, `google-workspace`, `slack`, ...) are `integrationFetch()` and `integrationStatus()`; an AI model is a provider under `providers` called through `createGatewayFetch()`. Every call takes `env` and, for a request, `for: request`. Locally there is no Gateway: the app uses your own keys from `.dev.vars`, and `pnpm dev` names the ones it is missing. Which capabilities and providers exist and how each is set up: `.agents/skills/everyapp/SKILL.md` and its `setup/` guides.

## Add a secret

A secret only this app uses (a key it calls out with, a signing secret). List its name under `secrets` in `everyapp.config.ts`; `{ name: "GITHUB_TOKEN", optional: true }` when the app works without it. Declare it in `src/env.d.ts` and read `env.GITHUB_TOKEN`. Locally: a `GITHUB_TOKEN=...` line in `.dev.vars` (gitignored). Live: after a deploy, `pnpm everyapp secret set GITHUB_TOKEN` in this directory; the person types the value at the hidden prompt, never in the chat. A required secret keeps the app closed ("Needs setup") until it is set. The keys of AI providers and capabilities are the Gateway's, set once for every app: never list those here.

## Deploy

`pnpm run deploy` (`everyapp deploy`) in this directory: it builds, migrates, uploads, registers the app with the Gateway and prints the app's address and who can open it. Run it again for every change; app secrets stay. Never `cf deploy` or `wrangler deploy`. `pnpm everyapp status` says what is online. When this app is the root of its own GitHub repository (what `everyapp create` makes outside the Every App checkout), `.github/workflows/security-review.yml` runs Anthropic's security review on every pull request once `ANTHROPIC_API_KEY` is in that repository's Actions secrets; at `apps/<name>` inside the checkout GitHub reads no workflow from this folder, and the checkout's own workflow reviews pull requests to the checkout's repository once you have a fork or remote of your own, with the same key in its secrets.
