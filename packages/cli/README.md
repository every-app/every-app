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
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through. That login is the
only credential: the CLI reads and writes the gateway's app registry in the
gateway's own D1 database with it (ADR-0003), and keeps nothing on your
machine. It finds the gateway by asking every account the login sees for the
gateway's database, all at once, and reads its address from the install row
there; when several accounts have one, `--account-id` (or
`CLOUDFLARE_ACCOUNT_ID`) picks. Another machine needs this checkout and
`cf auth login`, nothing else.

Commands that deploy take `--json` to print NDJSON progress events (exit code
0 when done, 2 when an action is required — do it and run the same command
again — and 1 on an error).

## Commands

### Set up Every App

From an empty Cloudflare account (on Workers Paid, with a domain) to a working
gateway and its owner:

```bash
everyapp setup --domain apps.example.com
```

It builds the gateway from this checkout and deploys it at `--domain` (any
hostname in a zone the account has; without the flag it asks), opens a
one-time setup link for the owner account, and waits for the account by
watching the link's row in the gateway's D1. Run it again to resume: it does
nothing once everything is there (a run that gave up shows a new link). `--json` prints NDJSON events for an agent. Then deploy apps from the
repository: `cd apps/todo-app && pnpm run deploy`.

### Deploy the Gateway

```bash
everyapp gateway deploy --domain apps.example.com
```

The deploy builds the gateway release from `apps/every-app-gateway` in this
checkout (once per change to its sources, the SDK's, perimeter's or
toolbus's: the build is kept by their tree hash under
`node_modules/.cache/everyapp/`, so a later deploy or an app's rebind takes
seconds), records the install in the gateway's D1 database (address, zone,
release), migrates that database before the new code goes live (after a Time
Travel bookmark it prints, with the command to restore it), and uploads with
`cf deploy`. A checkout behind the live gateway is refused: run `git pull`.
An app deploy that binds a new app redeploys the gateway from the same
checkout, which upgrades it when the checkout is newer. The gateway serves at `--domain`, and each app one label below
it (`todo.apps.example.com`) as its own Workers Custom Domain: Cloudflare
creates the DNS record and certificate. Before it adds an address, the deploy
checks for a DNS record that answers it, at the name or as a wildcard above it
(`--force-dns` publishes anyway), and room in the zone.

Other gateway commands:

```bash
everyapp gateway upgrade        # deploy the gateway as this checkout builds it
everyapp gateway status         # release, apps, certificates, owner, what to fix (from D1 and cf)
everyapp gateway reconcile      # bind and serve exactly the registered apps
everyapp gateway claim-link     # a new owner setup link
everyapp gateway secret set OPENAI_API_KEY
```

### Create a new app

Create a new app from the starter template (`templates/simple-todo`):

```bash
everyapp app create <app-id> [--deploy]
```

This will:

1. Copy the template to `apps/<id>` when run inside the repository, or to
   `./<id>` anywhere else, linking the SDK and the CLI from the checkout by path,
   and name it in package.json and everyapp.config.ts (with no id, it asks at a
   terminal; `--json` and `--yes` never ask)
2. Install dependencies
3. Generate the Worker's types and run local migrations
4. Outside the repository, start a git repository for it
5. With `--deploy`, deploy it through your gateway; without, it never contacts
   the gateway, and `everyapp dev` works at once

### Deploy an app

Deploy your app to Cloudflare:

```bash
everyapp app deploy
```

Run this from your app directory to build and deploy updates, on any machine
with the Cloudflare login. The deploy registers the app in the gateway's D1
(the rules in `@every-app/perimeter/registry` name its Worker and resources),
migrates the app's D1 database, builds with `cf build`, checks the built
Worker, uploads it with `cf deploy`, records the version and who deployed it,
redeploys the gateway to bind a new app, and then requests the app's address
until the gateway has made it live (behind Cloudflare Access, it goes live on
its first visit instead).

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

Runs the app with `cf dev` behind a local gateway (on 127.0.0.1) with the real
perimeter and a seeded dev user, after generating the Worker's types when they
are missing and applying local D1 migrations. It writes nothing into the app.

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

## Documentation

For full documentation, visit [everyapp.com/docs](https://everyapp.com/docs).
