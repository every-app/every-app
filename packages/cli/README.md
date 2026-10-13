# everyapp

CLI for [Every App](https://everyapp.dev) - deploy and manage self-hosted apps on Cloudflare.

## Installation

```bash
# Run the latest CLI directly with npx
npx -y everyapp@latest <command>
```

Requires Node.js 22.18 or newer. The CLI runs Cloudflare's `cf` CLI for you:
its own pinned copy, or the app's when the command is about one app. It never
handles a Cloudflare token itself: `cf` keeps its own login (`npx cf auth
login`, which the CLI offers when you're logged out), and CI passes
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through.

Commands that deploy take `--json` to print NDJSON progress events (exit code
0 when done, 2 when an action is required — do it and run the same command
again — and 1 on an error).

## Commands

### Deploy the Gateway

Deploy the Every App Gateway to your Cloudflare account:

```bash
npx -y everyapp@latest gateway deploy --domain you.dev
```

The gateway ships prebuilt inside the CLI; nothing is installed or built on
your machine. The deploy migrates the gateway's D1 database before the new
code goes live (after a Time Travel bookmark it prints, with the command to
restore it), uploads with `cf deploy`, and remembers the domain and account
for later runs. Apps are served at `<app>-<org>.you.dev` through a wildcard
DNS record (`*`, proxied) you add once.

Other gateway commands:

```bash
npx -y everyapp@latest gateway upgrade        # deploy the release this CLI ships
npx -y everyapp@latest gateway status         # release, bound apps, owner, certificate
npx -y everyapp@latest gateway reconcile      # bind exactly the registered apps
npx -y everyapp@latest gateway claim-link     # a new owner setup link
npx -y everyapp@latest gateway secret set OPENAI_API_KEY
```

### Create a new app

Create a new app from the starter template:

```bash
npx -y everyapp@latest app create [name]
```

This will:

1. Prompt for an app ID (or use the provided name)
2. Deploy it through your gateway (D1 database, KV namespace, Worker)
3. Configure package.json, everyapp.config.ts and .env files
4. Install dependencies and run local migrations

### Deploy an app

Deploy your app to Cloudflare:

```bash
npx -y everyapp@latest app deploy
```

Run this from your app directory to build and deploy updates. The gateway
names the app's Worker and resources; the deploy migrates the app's D1
database, builds with `cf build`, checks the built Worker, uploads it with
`cf deploy`, and has the gateway serve it.

### Delete an app

```bash
npx -y everyapp@latest app delete [app-id] [--purge]
```

Removes the app from the gateway. Its Worker and data stay unless `--purge`,
which deletes only what the app's deploys recorded creating.

### Run an app locally

From your app directory:

```bash
npx -y everyapp@latest dev
```

Runs the app with `cf dev` behind a local gateway with the real perimeter and a
seeded dev user, after writing the dev identity to `.dev.vars` and applying
local D1 migrations.

### Query or migrate the app's D1 database

```bash
npx -y everyapp@latest app d1 query "SELECT count(*) FROM todos"
npx -y everyapp@latest app d1 query --local "SELECT count(*) FROM todos"
npx -y everyapp@latest app d1 migrate --local
```

`query` runs SQL against the production database (with your Cloudflare login,
in the gateway's account) or, with `--local`, the one `everyapp dev` uses.
`migrate --local` applies the app's migrations locally (`cf d1 migrations
apply --local`); production migrations run as part of `app deploy`.

### Set up local environment

Set up local development for an existing Every App app (for example, after cloning a repo):

```bash
npx -y everyapp@latest app setup-local
```

This will:

1. Find the gateway and check it has an owner
2. Install dependencies
3. Create or refresh `.env.local`
4. Generate Cloudflare types and run local migrations

## Documentation

For full documentation, visit [everyapp.dev/docs](https://everyapp.dev/docs).
