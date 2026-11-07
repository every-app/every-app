---
title: Development vs production
description: What everyapp dev starts, the dev identity, what matches production and what differs locally (AI, capabilities, email, resources), linked dev against a real Gateway, and the pitfalls.
---

`everyapp dev` (the app's `pnpm dev` script) runs the app's dev server (`cf dev`, or the manifest's `dev` command) on an internal loopback port, and a small local Gateway in front of it that runs the real perimeter: public-route policy, header stripping, CSRF, and a real RS256 identity token. It never ends on its own: an agent starts it in the background and reads the `App` line (with `--json`, the `dev.ready` step; in linked mode the sign-in URL is in the `dev.link` event). Stop it with SIGINT (Ctrl-C).

## What it does

1. Checks the port (`DEV_PORT_IN_USE` names the next free one), generates Worker types when `.cloudflare/types` is missing, and applies local D1 migrations to `.cloudflare/state` (`--skip-migrations` skips).
2. Starts the app's dev server with `PORT` set and waits up to 90 seconds (`DEV_SERVER_FAILED`, `DEV_SERVER_TIMEOUT`).
3. Prints the ready block and serves `http://<app-id>.localhost:8787` (`--port`, default `$PORT` then `8787`). The first host label picks the app, so each worktree can run on its own port.

The ready block lists the app URL, its `/mcp`, the internal port, and, when relevant, the Workflows explorer, a curl for inbound email, a curl for crons (`POST /__everyapp/cron -d '<schedule>'`), and the `.dev.vars` names the app can't run without. Editing `everyapp.config.ts` needs a restart.

## Modes

- `stub` (default): the seeded user `dev@everyapp.localhost`, owner of `dev-org`. No setup.
- `mirror`: real sign-in through a separately running local Gateway (`pnpm dev` in `apps/every-app-gateway`), with `--base-host` (default `everyapp.localhost`). For Gateway work.
- `linked`: `--gateway https://apps.example.com`. The app runs here as you, and its AI, email, provider, member and event calls go through that Gateway, so no provider key is on this computer. Owners and admins only, after `everyapp workspace linked-dev on`. The first run signs in once in the browser; the token is in `~/.config/everyapp/linked-dev.json`. Data stays local; calls bill the workspace's providers. `everyapp dev unlink` signs out.

`EVERYAPP_DEV_MODE` sets the mode; the flag wins.

## The dev identity

The local Gateway signs identities with a dev keypair that's public by design (kid `everyapp-identity-dev`, issuer `https://gateway.dev.localhost`, audience the app id). The app trusts it only in a development build (`EVERYAPP_DEV=1`, which a deploy never sets). Because the key is public, `everyapp dev` listens on `127.0.0.1` unless `--host` says otherwise (`DEV_EXPOSED` warns).

Requests straight to the internal port get 401: nothing added an identity. To test anonymous behavior on public routes, send `x-everyapp-dev-anon: 1` (curl) or the cookie `everyapp_dev_anon=1`.

## Scripts that call the app as someone else: `everyapp dev token`

```sh
curl -H "x-everyapp-identity: $(everyapp dev token --role member)" http://127.0.0.1:<app port>/api/me
```

It prints an identity token the running app accepts: `--role owner|admin|member`, `--user <email>`, `--org <id>` (to test the organization pin), `--app`, `--ttl` (default `1h`, at most `24h`).

## Same as production

Header stripping, the identity token's shape, CSRF (a script's `POST` needs `Origin: http://<app-id>.localhost:8787` or `Sec-Fetch-Site: same-origin`; with a cookie and no `Origin` it's `403 csrf_denied`), public routes, the server-function guard, `/__everyapp/tools/*` refused, the token scope rule, security headers.

## What differs locally

- No `EVERY_APP_GATEWAY` binding. The SDK calls AI providers and API-key providers directly with keys from `.dev.vars` under the Gateway's names (`OPENROUTER_API_KEY`, `DATAFORSEO_API_KEY`), and answers "not set up" without them. `sendEmail()` prints the message unless email credentials are set. `listMembers()` returns the signed-in user. Linked mode uses a real Gateway instead.
- `.dev.vars` in the app's directory, one `NAME=value` per line and gitignored, holds the app's `secrets`, `settings` and those provider keys. Other names aren't passed to the Worker.
- D1, KV, R2, queues, Durable Objects and Workflows are local, under `.cloudflare/state`. Hyperdrive needs `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` in `.dev.vars`.
- Workers AI, Vectorize and Artifacts have no local version: calls throw `Binding … needs to be run remotely` until `vite.config.ts` sets `remoteBindings: true` and `cf auth login` has run. Browser Rendering and Images work locally.
- No Cloudflare Access, every app access check passes, and WebSockets have no Origin check or 15-minute cap.
- `GATEWAY_URL` is the local launcher. The tool catalog is re-read every 2 seconds.

### Secrets Store in development

A `resources.secretsStore` binding reads Miniflare's local store under `.cloudflare/state`, which is empty: `get()` throws `Secret "<name>" not found` until you seed it with Miniflare's API (secret name `every-<id>--<binding>`).

## Calling the app's tools locally

`http://<app-id>.localhost:8787/mcp` serves the app's live `defineTools()` catalog with the Gateway's policy. In stub mode any bearer value is the dev user:

```sh
claude mcp add --transport http todos http://<app-id>.localhost:8787/mcp --header "Authorization: Bearer dev"
```

Each call prints `MCP <tool> <outcome>`. Browser MCP clients work in stub mode only. On macOS `*.localhost` may resolve to `::1` first; pin with `curl --resolve <app-id>.localhost:8787:127.0.0.1`.

## Pitfalls

- `cf dev` alone answers 401 on every protected route; run `pnpm dev`.
- Stale `Env` types after adding a resource or secret: run `pnpm types:check`.
- Stop with Ctrl+C (exit 130); `pkill` can leave Vite and workerd running.
- Development builds compile; only `everyapp deploy` builds for production (with `EVERYAPP_BUILD=1`).
- Local migrations failing is `MIGRATIONS_FAILED`; fix the file and run `everyapp db migrate`.
