# Every App

## Development

Run locally behind the local gateway (stub mode, with a seeded dev user):

```sh
pnpm install
pnpm dev
```

`pnpm dev` runs `everyapp dev`: it applies local D1 migrations, starts the
app with `cf dev` and puts the local gateway in front of it, signing a dev
identity the app's development build trusts. Use `pnpm dev:vite` (bare `cf dev`) only when you
intentionally need the app server alone; SDK-protected routes require the
gateway started by `pnpm dev`.

The Worker is defined in `cloudflare.config.ts`, which builds it from
`everyapp.config.ts` with `everyAppWorker()`. Declare D1 databases, KV
namespaces, Durable Objects and Workflows in `everyapp.config.ts`.

## Agent tools (MCP)

`src/tools.ts` defines the starter's agent tools with `defineTools()` from
`@every-app/sdk/server`: list, create and update the user's todos, and a
destructive delete that AI clients can't use yet. The app never speaks MCP;
the Every App gateway serves the tools to Claude, Cursor and other MCP
clients at `https://<app-host>/mcp`, and `pnpm dev` serves them locally at
`http://<app-id>.localhost:8787/mcp`. To connect Claude Code to a deployed
app with a personal access token:

```sh
claude mcp add --transport http todos https://<app-host>/mcp \
  --header "Authorization: Bearer $EVERYAPP_TOKEN"
```

`$EVERYAPP_TOKEN` is a personal access token from your Gateway: **Manage
workspace → Tokens → Create access token**.

Add a tool by adding an entry to `defineTools()` and redeploying; the deploy
syncs the gateway's copy. The contract is described in
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

Deploy only with `pnpm run deploy` (`everyapp deploy`). A production build
holds placeholders for the Worker's name, keys and resources that only
`everyapp deploy` installs, so `cf build` and `cf deploy` on their own refuse
to build for production. `pnpm build` makes a
development build to check that the app compiles.

## Publish a release

Not yet: the workflow runs the everyapp CLI from npm, and the CLI isn't
published there yet. Once it is, this works without changes to the app.

Push a tag like `v1.0.0` and `.github/workflows/release.yml` builds the app
with `everyapp deploy --bundle-only` and attaches `everyapp-release.tar.gz`
to the tag's GitHub release. Anyone with a Gateway installs it without
cloning this repository:

```sh
pnpm everyapp deploy https://github.com/<owner>/<repo>
```
