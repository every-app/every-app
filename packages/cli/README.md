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

Every command takes `--json` to print NDJSON events and nothing else on stdout
(exit code 0 when done, 2 when an action is required — do it, then run
`data.rerun`, usually the same command — and 1 on an error), except `dev`,
which runs until you stop it. Coding agents read `skills/everyapp/SKILL.md`,
the one page that says how (`everyapp create` copies it into each new app).

## Commands

| Command                              | Does                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `everyapp login`                     | Logs in to Cloudflare (or says who is logged in)                                       |
| `everyapp setup [--domain D]`        | Installs, upgrades or repairs the gateway; creates its owner the first time            |
| `everyapp status`                    | The gateway, its owner, apps, certificates, running deploys, and what to fix           |
| `everyapp create <id> [--deploy]`    | A new app from the starter template, ready for `dev`                                   |
| `everyapp dev`                       | The app in this directory, behind a local gateway                                      |
| `everyapp deploy`                    | Deploys the app in this directory (offers to install the gateway when there is none)   |
| `everyapp delete [id] [--purge]`     | Removes an app                                                                         |
| `everyapp secret set\|unset\|list`   | The app's secrets and the gateway's settings, each by name                             |
| `everyapp email set\|unset\|show`    | The addresses the app sends as and receives at, kept on the gateway                    |
| `everyapp db …`                      | Local migrations (`migrate`), SQL (`query`), undoing the last migrations (`restore`)   |
| `everyapp workflow …`                | The deployed app's Workflows                                                           |

### Create and run an app

```bash
everyapp create my-app        # apps/my-app inside the repository, ./my-app anywhere else
cd apps/my-app
everyapp dev
```

`create` copies the starter template (`templates/simple-todo`): to `apps/<id>`
when run inside the repository, or to `./<id>` anywhere else, linking the SDK
and the CLI from the checkout by path. It names the app in package.json and
everyapp.config.ts (with no id, it asks at a terminal; `--json` and `--yes`
never ask), puts the everyapp skill in `.claude/skills/everyapp` and
`.agents/skills/everyapp`, installs dependencies, generates the Worker's types,
runs local migrations, and outside the repository starts a git repository for
it. It never contacts the gateway, so `everyapp dev` works at once; `--deploy`
deploys it right after.

`dev` runs the app with `cf dev` behind a local gateway (on 127.0.0.1) with the
real perimeter and a seeded dev user, after generating the Worker's types when
they are missing and applying local D1 migrations. It writes nothing into the
app.

### Deploy an app

```bash
everyapp deploy
```

Run this from your app directory to build and deploy, on any machine with the
Cloudflare login. The deploy registers the app in the gateway's D1 (the rules
in `@every-app/perimeter/registry` name its Worker and resources), builds with
`cf build`, checks the built Worker and that its migrations describe its
schema, migrates the app's D1 database (after a Time Travel bookmark it
prints), uploads it with `cf deploy`, records the version and who deployed it,
redeploys the gateway from this checkout to bind a new app, and then requests
the app's address until the gateway has made it live (behind Cloudflare Access,
it goes live on its first visit instead; `--no-wait` skips the wait).

With no gateway in any account the login sees, a deploy at a terminal offers
to install one at `apps.<your domain>` (`setup`, owner link included), then
deploys; under `--json` it stops with `action_required install_gateway`, whose
`data.rerun` is the setup command.

### The gateway: `setup`

```bash
everyapp setup --domain apps.example.com
```

From an empty Cloudflare account (on Workers Paid, with a domain) to a working
gateway and its owner, and the command to run after a `git pull` or when
`status` says something is off. It builds the gateway from
`apps/every-app-gateway` in this checkout (once per change to its sources, the
SDK's, perimeter's or toolbus's: the build is kept by their tree hash under
`node_modules/.cache/everyapp/`, so a later run or an app's rebind takes
seconds), records the install in the gateway's D1 database (address, zone,
release), migrates that database before the new code goes live (after a Time
Travel bookmark it prints, with the command to restore it), uploads with
`cf deploy`, opens a one-time setup link for the owner account, and waits for
the account by watching the link's row in the gateway's D1.

Run again, it resumes where it stopped (a run that gave up shows a new link),
upgrades a gateway older than the checkout, and repairs one that runs this
checkout's release but doesn't bind and publish exactly the registered apps;
otherwise it says the gateway is up to date and changes nothing. A checkout
behind the live gateway is refused: run `git pull`. The gateway serves at
`--domain` (any hostname in a zone the account has; without the flag it asks),
and each app one label below it (`todo.apps.example.com`) as its own Workers
Custom Domain: Cloudflare creates the DNS record and certificate. Before it
adds an address, it checks for a DNS record that answers it, at the name or as
a wildcard above it (`--force-dns` publishes anyway), and room in the zone.
`setup` deploys no app.

```bash
everyapp status                                    # release, apps, certificates, owner, what to fix (from D1 and cf)
everyapp secret set OPENAI_API_KEY                 # a gateway setting: live on the next request, no deploy
```

### Delete an app

```bash
everyapp delete [id] [--purge]
```

Removes the app from the gateway, with its address and certificate. Its
Worker and data stay unless `--purge`, which deletes only what the app's
deploys recorded creating.

### Secrets

```bash
everyapp secret set GITHUB_TOKEN [--from-env VAR]   # the app's own: listed under `secrets` in everyapp.config.ts
everyapp secret set OPENAI_API_KEY                  # a gateway setting, from any directory
everyapp secret unset GITHUB_TOKEN
everyapp secret list
```

The name says where a secret goes; there is no target flag. A gateway
setting (an AI provider's key, a capability's client, `EMAIL_FROM`, the MCP
and Cloudflare Access switches, …) lands on the live gateway Worker, which
reads it on its next request. Any other name lands on the app in this
directory, on its Worker and each helper, which must be deployed and must
list the name under `secrets` in `everyapp.config.ts`; a name that is
neither is refused before a value is read. `set` and `unset` change the live
Worker in one new version and never deploy; the next `deploy` or `setup`
keeps the secrets. `list` in an app's directory shows each Worker's secrets,
the ones the manifest lists that nobody set, and the gateway settings the
app's providers and capabilities need; elsewhere, the gateway's.

### Email

```bash
everyapp email set --sender "*@mail.example.com" --inbound support@mail.example.com   # in the app's directory, after its first deploy
everyapp email unset inbound
everyapp email show
```

The manifest only declares (`capabilities.email`, `email: { inbound: true }`);
the lists are the installation's, kept on the gateway. `--inbound` makes the
Email Routing rules at once; `everyapp deploy` keeps them in step and
`delete --purge` removes them.

### Query, migrate or restore the app's D1 database

```bash
everyapp db query "SELECT count(*) FROM todos"
everyapp db query --local "SELECT count(*) FROM todos"
everyapp db query --file scripts/backfill.sql
everyapp db migrate
everyapp db restore
```

`db query` runs SQL against the production database (with your Cloudflare
login, in the gateway's account) or, with `--local`, the one `everyapp dev`
uses; SQL that changes the production database is confirmed first (`--yes`
skips that). `db migrate` applies the app's migrations to that local database
(`cf d1 migrations apply --local`); production migrations run as part of
`deploy`, and nowhere else. Before a deploy migrates a database that has data,
it saves a restore point (a D1 Time Travel bookmark, kept in the gateway's
database); `db restore` puts the database back to it, and `db restore --gateway`
does the same for the gateway's own database after a migrating `setup`.

## Documentation

For full documentation, visit [everyapp.com/docs](https://everyapp.com/docs);
every command and flag is on the [CLI reference](https://everyapp.com/docs/commands).
