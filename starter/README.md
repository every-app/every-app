# Every App

A private web app on Cloudflare behind your Every App Gateway. The Gateway signs people in; the app gets who they are. It starts as a todo list whose first screen shows who you are and what the app was allowed. Each person sees only their own todos: every query in `src/server/todos.ts` takes the signed-in user's id, and what an app shares between people is up to the app. Tell your coding agent what it should become: the notes it reads are in `AGENTS.md`.

## What's here

The todo list is the example; the rest is the plumbing that makes it an Every App app. Replace the example, keep the plumbing.

- The example: `src/routes/index.tsx` (the page), `src/serverFunctions/` (what the page calls, each behind the signed-in user: the todos, and in `home.ts` the first screen's facts), `src/server/todos.ts` and its test (the queries), `src/db/schema.ts` and `drizzle/` (the table and its migrations), `src/tools.ts` (the same todos as tools for AI clients), `src/routes/health.ts` (a JSON endpoint without a page; private, like every route not named under `public` in `everyapp.config.ts`).
- The plumbing: `everyapp.config.ts` (what the app is and what the Gateway allows it), `cloudflare.config.ts` (builds the Worker from it), `src/entry.worker.ts` (wraps the app in `everyApp()`, which verifies what the Gateway sent and serves the tools), `src/middleware/ensureUser.ts` (reads who the Gateway signed in), `src/db/index.ts`, `src/env.d.ts`, `vite.config.ts`, `drizzle.config.ts`.
- The shell: `src/routes/__root.tsx`, `src/router.tsx`, `src/styles/app.css`. `src/routeTree.gen.ts` is generated.
- The skills: `.agents/skills/` and `.claude/skills/`, copies `everyapp create` makes of the CLI's `everyapp` (runs the commands) and `build-every-app` (how to build one, with patterns from real apps). Your coding agent reads them, with `AGENTS.md`.

## Run it

```sh
pnpm install   # done by `everyapp create`; needed after a fresh clone
pnpm dev
```

Open the address it prints. You're signed in as a test user. Ctrl+C stops it.

## Put it online

```sh
pnpm run deploy
```

It prints the app's address and who can open it. Run it again for every change you want live.

The first deploy puts the app's Worker, its D1 database and its hostname with a certificate in your Cloudflare account, then redeploys the Gateway so it serves the app (upgrading the Gateway when your Every App checkout is newer than the one online). No Gateway yet? It offers to install one first. Later deploys change only the app. What it all costs: https://everyapp.com/docs#what-it-costs.

## Use it from Claude, ChatGPT or Cursor

Its tools are served by your Gateway at `https://<your gateway>/mcp`: https://everyapp.com/docs/connect-ai
