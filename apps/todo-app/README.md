# Todo Example App

## Development

From your terminal, run the app behind the local gateway in stub mode:

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
`everyapp.config.ts` (D1, KV and the `UserSyncDO` Durable Object) with
`everyAppWorker()`. Deploy only with `pnpm run deploy` (`everyapp app deploy`).

## MCP

The app serves a stateless Streamable HTTP MCP endpoint at `/mcp` with tools to
list, create, update, and delete the authenticated user's todos. The route stays
private: the Every App gateway authenticates the caller, and the app receives
only the verified user identity. See [`docs/todo-mcp-example.md`](../../docs/todo-mcp-example.md)
for the contract and the planned bearer/OAuth boundary.

## Helpful Resources

https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack/
https://orm.drizzle.team/docs/connect-cloudflare-d1
