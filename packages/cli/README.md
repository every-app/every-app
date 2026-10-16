# everyapp

CLI for [Every App](https://everyapp.com) - deploy and manage self-hosted apps on Cloudflare.

## Running it

Nothing is published while we work from the repository (`.github/RELEASE.md`),
so the CLI runs from a checkout of it:

```bash
pnpm install                  # at the repository root, once
pnpm everyapp <command>       # anywhere in the repository
pnpm -C packages/cli install:global   # optional: `everyapp` on your PATH
```

It builds itself the first time, and again whenever its source, or the SDK,
perimeter or toolbus it bundles, changed (`bin/everyapp.js`). The apps in the
repository depend on it (`workspace:*`), so `pnpm dev` and `pnpm run deploy`
in an app run it too. Don't use `npx everyapp`: that is npm's old 0.2 CLI.

Requires Node.js 22.18 or newer. The CLI runs Cloudflare's `cf` CLI for you:
its own pinned copy, or the app's when the command is about one app. It never
handles a Cloudflare token itself: `cf` keeps its own login (`cf auth login`,
which the CLI offers when you're logged out), and CI passes
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through.

Commands that deploy take `--json` to print NDJSON progress events (exit code
0 when done, 2 when an action is required — do it and run the same command
again — and 1 on an error).

## Commands

### Set up Every App

From an empty Cloudflare account (on Workers Paid, with a domain) to a working
gateway, its owner, and this machine logged in:

```bash
everyapp setup --domain apps.example.com
```

It builds the gateway from this checkout and deploys it at `--domain` (any
hostname in a zone the account has; without the flag it asks), opens a
one-time setup link for the owner account, and logs this machine in once that
account exists. Run it again to resume: it does nothing once everything is
there. `--json` prints NDJSON events for an agent. Then deploy apps from the
repository: `cd apps/todo-app && pnpm run deploy`.

### Deploy the Gateway

```bash
everyapp gateway deploy --domain apps.example.com
```

The deploy builds the gateway release from `apps/every-app-gateway` in this
checkout (or takes `--release <tarball>`), migrates the gateway's D1 database
before the new code goes live (after a Time Travel bookmark it prints, with
the command to restore it), uploads with `cf deploy`, and remembers the
address and account for later runs. The gateway serves at `--domain`, and each app one label below
it (`todo.apps.example.com`) as its own Workers Custom Domain: Cloudflare
creates the DNS record and certificate. Before it adds an address, the deploy
checks for a DNS record it would replace (`--force-dns` replaces it), CAA
records that would block the certificate, and room in the zone.

Other gateway commands:

```bash
everyapp gateway upgrade        # deploy the gateway as this checkout builds it
everyapp gateway status         # release, apps, addresses and certificates, owner
everyapp gateway reconcile      # bind and serve exactly the registered apps
everyapp gateway claim-link     # a new owner setup link
everyapp gateway secret set OPENAI_API_KEY
everyapp gateway adopt --domain example.com   # take over a gateway deployed before cf
everyapp gateway use-per-app-domains          # move it off its wildcard route
```

### Create a new app

Create a new app from the starter template (`templates/simple-todo`):

```bash
everyapp app create [name]
```

This will:

1. Prompt for an app ID (or use the provided name)
2. Copy the template to `apps/<id>` when run inside the repository, or to
   `./<id>` anywhere else, linking the SDK and the CLI from the checkout by path
3. Deploy it through your gateway (D1 database, KV namespace, Worker)
4. Configure package.json, everyapp.config.ts and .env files
5. Install dependencies and run local migrations

### Deploy an app

Deploy your app to Cloudflare:

```bash
everyapp app deploy
```

Run this from your app directory to build and deploy updates. The gateway
names the app's Worker and resources; the deploy migrates the app's D1
database, builds with `cf build`, checks the built Worker, uploads it with
`cf deploy`, and has the gateway serve it.

### Delete an app

```bash
everyapp app delete [app-id] [--purge]
```

Removes the app from the gateway, with its address and certificate. Its
Worker and data stay unless `--purge`, which deletes only what the app's
deploys recorded creating.

### Run an app locally

From your app directory:

```bash
everyapp dev
```

Runs the app with `cf dev` behind a local gateway with the real perimeter and a
seeded dev user, after writing the dev identity to `.dev.vars` and applying
local D1 migrations.

### Query or migrate the app's D1 database

```bash
everyapp app d1 query "SELECT count(*) FROM todos"
everyapp app d1 query --local "SELECT count(*) FROM todos"
everyapp app d1 migrate --local
```

`query` runs SQL against the production database (with your Cloudflare login,
in the gateway's account) or, with `--local`, the one `everyapp dev` uses.
`migrate --local` applies the app's migrations locally (`cf d1 migrations
apply --local`); production migrations run as part of `app deploy`.

### Set up local environment

Set up local development for an existing Every App app (for example, after cloning a repo):

```bash
everyapp app setup-local
```

This will:

1. Find the gateway and check it has an owner
2. Install dependencies
3. Create or refresh `.env.local`
4. Generate Cloudflare types and run local migrations

## Documentation

For full documentation, visit [everyapp.com/docs](https://everyapp.com/docs).
