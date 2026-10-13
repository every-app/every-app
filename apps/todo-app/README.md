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

## Agent tools (MCP)

`src/tools.ts` defines the app's agent tools with `defineTools()`: list,
create and update the user's todos, plus a destructive delete that AI clients
can't use until the gateway supports approvals. The app doesn't speak MCP
itself. The gateway serves the tools at `https://<app-host>/mcp` (and
`pnpm dev` serves them locally at `http://todo.localhost:8787/mcp`), and every
call reaches the app with the verified user. See
[`docs/todo-mcp-example.md`](../../docs/todo-mcp-example.md).

## Helpful Resources

https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack/
https://orm.drizzle.team/docs/connect-cloudflare-d1
