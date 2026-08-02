# Every App

## Development

Run locally behind the local gateway (stub mode, with a seeded dev user):

```sh
pnpm install
pnpm dev
```

Use `pnpm dev:vite` only when you intentionally need the bare Vite server;
SDK-protected routes require the gateway started by `pnpm dev`.

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
npx -y everyapp@latest app deploy
```
