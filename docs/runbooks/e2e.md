# A sandbox Gateway: `pnpm e2e`

`pnpm e2e` gives you a real Gateway to try a change on: a sandbox in a real Cloudflare account, installed from this checkout, or from another ref and then updated to this checkout, which is where existing users break. You try whatever the change is about on it (its data, its pages, its CLI commands), then tear it down.

Each sandbox is a named Gateway (`everyapp setup --name e2e…`): its own Worker, database, queue and apps, beside anything else in the account, and its teardown (`teardown --gateway`) touches nothing else. So the account can be the one you develop in.

## Set up this machine (once)

1. Pick the Cloudflare account. It must be on Workers Paid and hold a zone. On a personal dev machine your own account is fine.
2. Pick the domain sandboxes go under: a zone, or a hostname under one, such as `example.com`. A sandbox lives at `<name>.example.com` and its apps one level below that.
3. Create an API token for that account with the permissions in `docs/runbooks/test-accounts.md`, section 5 (setup, deploy and teardown need them all).
4. Write the config yourself, in a terminal: the token never goes through an agent or a chat.

   ```sh
   mkdir -p ~/.config/everyapp
   cat > ~/.config/everyapp/e2e.json <<'EOF'
   {
     "accountId": "<the account's 32-character id>",
     "domain": "example.com",
     "token": "<the token>"
   }
   EOF
   chmod 600 ~/.config/everyapp/e2e.json
   ```

   `stateDir` (optional) is where each sandbox's state and logs go; the default is `~/.cache/everyapp/e2e`. `oauthClients` (optional) keeps OAuth clients registered for a sandbox name, set on every sandbox `up` brings up under that name (below). `EVERYAPP_E2E_CONFIG` points at another file.
5. Install the browser the health check drives: `pnpm exec playwright install chromium`.

## Use one

From a checkout of the branch to test:

```sh
pnpm e2e up                        # a sandbox of this checkout
pnpm e2e up --from origin/main     # a sandbox of main (or any branch, tag, commit), to update later
pnpm e2e up --name oauth           # a fixed name, so its hostname (and an OAuth client's callback) stays the same
pnpm e2e app <name> <app-id> --provider <id> --scopes <a,b>   # the starter deployed as an app listing a provider
pnpm e2e open <name> [<path>]      # a browser signed in as the owner, for a person (a provider's consent)
pnpm e2e exec <name> -- <command>  # run a command against it with the account's token
pnpm e2e update <name>             # update it to this checkout: migrations, then the code
pnpm e2e list                      # the sandboxes up from this machine
pnpm e2e down <name>               # tear it down
```

- **`up`** installs the Gateway (`setup --name <name> --no-access`) from the checkout it starts at, creates the owner the moment setup shows its one-time link, deploys that checkout's `starter/` app, and checks the sandbox's health. It takes a few minutes, most of it Cloudflare issuing certificates.
- **`update`** runs `everyapp update` from this checkout, as anyone updating does, then checks health again.
- **The health check:** status finds the Gateway claimed, in sync, running the checkout's release with no error to fix (its warnings are printed), and the starter app bound; the owner signs in with a browser and the starter app opens behind the Gateway.
- **`exec`** runs the command with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set to the config's, and `EVERYAPP_GATEWAY_URL` to the sandbox, so `pnpm exec everyapp …` from any checkout aims at it. The upgrade's starting checkout is kept as a git worktree under `~/.cache/everyapp/e2e-base/<commit>`: run its CLI there (`pnpm -C <that worktree> exec everyapp …`) to fill the sandbox the way that version would.

A sandbox stays up until `down`, so tear down what you start. A failed `up` or `update` leaves it up and says how to tear it down.

## Trying a change on it

What to try depends on the change. The sandbox gives you:

- **The Gateway and its owner:** `<stateDir>/<name>/sandbox.json` (mode 600) has the URL and the owner's email and password. Sign in at `<url>/sign-in` with a browser (Playwright is a root dev dependency). Access is off.
- **The CLI:** `pnpm e2e exec <name> -- pnpm exec everyapp <command> --gateway <name>`.
- **The Gateway's database:** `pnpm e2e exec <name> -- node <checkout>/packages/cli/node_modules/cf/bin/cf d1 query <database id> --sql "…"`; `cf d1 list --name every-app-gateway-<name>` gives the id. Seeding rows the old version wrote, then updating, is how a migration is tried on real data.
- **Apps:** deploy any app with `pnpm e2e exec <name> -- pnpm -C <app dir> exec everyapp deploy --gateway <name> --yes`. The starter's `everyapp.config.ts` with another `id` deploys as another app.

## A real provider's consent

A flow that goes through a provider (connect, Reconnect) needs a real OAuth client and a person at the provider's screen. It works the same for every OAuth preset (`pnpm everyapp provider presets` lists them with their consoles):

1. Pick a fixed sandbox name, say `oauth`. The client's callback is then always `https://oauth.<domain>/connect/<provider>/callback`.
2. Register an OAuth client at the provider's console with that callback.
3. Add it to `~/.config/everyapp/e2e.json` yourself:

   ```json
   "oauthClients": {
     "github-oauth": { "sandbox": "oauth", "clientId": "<id>", "clientSecret": "<secret>" }
   }
   ```

4. `pnpm e2e up --name oauth` sets every saved client for that name (`provider add <id> --from-env`, as the Worker secrets the preset names).
5. Deploy apps that list the provider: `pnpm e2e app oauth a --provider github-oauth --scopes read:user`.
6. `pnpm e2e open oauth "/connect/github-oauth?app=a&return=/connections/accounts"`: sign in at the provider and approve. The browser profile is kept in `stateDir`, so the provider sign-in carries over to the next run.

## What it doesn't cover

- A coding agent installing EveryApp from the setup prompt. The old onboarding loop did that (`docs/design/2026-10-onboarding-loop.md`).
- Cloudflare Access: sandboxes leave it off.
