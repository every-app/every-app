# Every App Gateway

The Gateway is the one public Worker: it signs people in, holds the organization
and its members, proxies every app's hostname through the perimeter, serves the
apps' tools to MCP clients at `/mcp`, and deploys apps from the browser.

Install or update it with the CLI from the repository root:

```sh
pnpm everyapp setup --domain apps.example.com   # first install, or repair
pnpm everyapp gateway deploy                    # update after git pull
pnpm everyapp status                            # what is live, what to fix
```

## Development

```sh
pnpm dev                    # cf dev on http://localhost:8787
pnpm db:migrate:local       # apply drizzle/ to the local D1
pnpm setup-link             # mint a one-time owner link for the local gateway
node scripts/seed-local.mjs # fill the local D1 with every UI state (header says how)
pnpm test                   # vitest (SQLite-backed)
pnpm auth:generate          # regenerate src/db/auth.schema.ts after an auth config change
```

`cloudflare.config.ts` defines the Worker; `drizzle/` holds the D1 migrations
(one baseline, then appended); `src/server.ts` is the production entry.

## Docs

- [Security model](../../docs/security-model.md)
- [Capabilities the gateway holds](../../docs/capabilities.md)
- [Runbooks](../../docs/runbooks/): Cloudflare Access, email sending, the MCP
  connector and its OAuth server, key rotation, browser app installs
- [Testing](../../docs/TESTING.md)
