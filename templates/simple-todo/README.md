# Every App

## Development

Run locally behind the local gateway (stub mode, with a seeded dev user):

```sh
pnpm install
pnpm dev
```

`pnpm dev` runs `everyapp dev`: it writes the dev identity to `.dev.vars`,
applies local D1 migrations, starts the app with `cf dev` and puts the local
gateway in front of it. Use `pnpm dev:vite` (bare `cf dev`) only when you
intentionally need the app server alone; SDK-protected routes require the
gateway started by `pnpm dev`.

The Worker is defined in `cloudflare.config.ts`, which builds it from
`everyapp.config.ts` with `everyAppWorker()`. Declare D1 databases, KV
namespaces and Durable Objects in `everyapp.config.ts`.

## MCP

The starter serves a stateless Streamable HTTP MCP endpoint at `/mcp` with
tools to list, create, update, and delete the authenticated user's todos. Keep
the route private: Every App verifies identity before any tool runs. The
platform contract and auth boundary are documented in
[`docs/todo-mcp-example.md`](https://github.com/every-app/every-app/blob/main/docs/todo-mcp-example.md).

Generate Migration

```sh
pnpm run db:generate
```

Migrate Local DB

```sh
pnpm run db:migrate:local
```

## Deploy

```sh
pnpm run deploy
```

Deploy only with `pnpm run deploy` (`everyapp app deploy`). A production build
needs deploy inputs that only `everyapp app deploy` provides, so `cf build` and
`cf deploy` on their own refuse to build for production. `pnpm build` makes a
development build to check that the app compiles.
