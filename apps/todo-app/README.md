# Todo Example App

## Development

From your terminal, run the app behind the local gateway in stub mode:

```sh
pnpm install
pnpm dev
```

Use `pnpm dev:vite` only when you intentionally need the bare Vite server;
SDK-protected routes require the gateway started by `pnpm dev`.

## MCP

The app serves a stateless Streamable HTTP MCP endpoint at `/mcp` with tools to
list, create, update, and delete the authenticated user's todos. The route stays
private: the Every App gateway authenticates the caller, and the app receives
only the verified user identity. See [`docs/todo-mcp-example.md`](../../docs/todo-mcp-example.md)
for the contract and the planned bearer/OAuth boundary.

## Helpful Resources

https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack/
https://orm.drizzle.team/docs/connect-cloudflare-d1
