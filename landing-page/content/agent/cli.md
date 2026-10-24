---
title: "CLI reference"
description: "Every everyapp command with its arguments, flags, defaults and help text, generated from the CLI itself. Exit codes and the global flags are here too."
---

<!-- Generated from packages/cli/src/app.ts and the command definitions by packages/cli/src/docs/cliReference.ts; the test in packages/cli/src/docs/agentDocs.test.ts fails when this page is stale. Regenerate with `pnpm -C packages/cli docs:update`. -->

The command is `everyapp`, run as `pnpm everyapp` from the Every App checkout (publishing to npm is paused; never `npx everyapp`). Every command takes `--help`; an agent adds `--json` and reads the event stream described on [/docs/agent/json](/docs/agent/json). What each error code means is on [/docs/agent/errors](/docs/agent/errors).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Done. |
| `1` | An `error` event ended the run, whatever came before it (a declined prompt, `CANCELLED`, exits 1 too). |
| `2` | The run stopped on an `action_required` event: do the action, then run the command in its `data.rerun`. |
| `130` | Stopped with Ctrl-C. |
| `251` | No such command (`UNKNOWN_COMMAND`). |
| `252` | Bad arguments: an unknown flag, a missing or invalid value (`UNKNOWN_FLAG`, `INVALID_VALUE`, `MISSING_ARGUMENT`, `MISSING_FLAG_VALUE`, `TOO_MANY_ARGUMENTS`, `REPEATED_FLAG`). |

## Global flags

| Flag | What it does |
| --- | --- |
| `--json` | Print NDJSON events on stdout and never prompt. Read before any command parses its arguments, so argument errors are events too. |
| `--verbose` | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace. |
| `--no-color` | Print without colors (also `NO_COLOR=1`). |
| `-h`, `--help` | Help for everyapp or a command. |
| `-v`, `--version` | everyapp's version. |

## `everyapp --help`

```text
Deploy and run Every App apps on your own Cloudflare account.

USAGE
  pnpm everyapp <command> [flags]

BUILD AN APP
  create    Create a new app from the starter template
  dev       Run the app locally behind a dev Gateway
  deploy    Deploy the app in this directory
  release   Pack the app in this directory as a release others can install
  db        Migrate, query and restore an app's D1 database

RUN A GATEWAY
  login     Log in to Cloudflare
  setup     Install or repair the Gateway
  update    Update the Gateway to this checkout (after git pull)
  install   Install an app someone published, from GitHub or a release file
  status    Show the Gateway, its apps and anything to fix
  delete    Remove an app from the Gateway
  access    Put Cloudflare Access in front of the Gateway and its apps, or take it off
  secret    Set, remove and list secrets and Gateway settings
  email     Manage the addresses an app sends as and receives at
  teardown  Delete everything Every App created in a dedicated test Cloudflare account

FLAGS
  -h, --help      Show help for everyapp or a command
  -v, --version   Show everyapp's version
      --no-color  Print without colors (also NO_COLOR=1)

EXAMPLES
  $ pnpm everyapp setup --domain apps.example.com
  $ pnpm everyapp create todo
  $ pnpm everyapp deploy
  $ pnpm everyapp install https://github.com/<owner>/<repo>

Run pnpm everyapp <command> --help for a command's flags.
```

## Command groups

### `everyapp db`

```text
Migrate, query and restore an app's D1 database.

USAGE
  pnpm everyapp db <command> [flags]

COMMANDS
  migrate  Apply migrations to the local database
  query    Run SQL against the production database (or --local)
  restore  Put the production database back to before the last migrations

EXAMPLES
  $ pnpm everyapp db migrate
  $ pnpm everyapp db query 'select count(*) from todos'

Run pnpm everyapp db <command> --help for its flags.
```

### `everyapp access`

```text
Put Cloudflare Access in front of the Gateway and its apps, or take it off.

USAGE
  pnpm everyapp access <command> [flags]

COMMANDS
  on    Turn Cloudflare Access on in front of the Gateway and its apps, or bring it up to date
  off   Turn Cloudflare Access off for the Gateway and its apps
  show  Show how Cloudflare Access fronts the Gateway, and what access on would change

EXAMPLES
  $ pnpm everyapp access on
  $ pnpm everyapp access on --email-domain example.com
  $ pnpm everyapp access off

Run pnpm everyapp access <command> --help for its flags.
```

### `everyapp secret`

```text
Set, remove and list secrets and Gateway settings.

USAGE
  pnpm everyapp secret <command> [flags]

COMMANDS
  set    Set secrets on your app or your Gateway
  unset  Remove secrets from your app or your Gateway
  list   List what an app needs set and what is: its own secrets and the Gateway's settings

EXAMPLES
  $ pnpm everyapp secret set GITHUB_TOKEN
  $ pnpm everyapp secret set GITHUB_TOKEN --from-env GH_TOKEN
  $ pnpm everyapp secret set MAIN_SECRET --app analytics
  $ pnpm everyapp secret list crm

Run pnpm everyapp secret <command> --help for its flags.
```

### `everyapp email`

```text
Manage the addresses an app sends as and receives at.

Invites, and apps that don't set their own senders, send as the Gateway's sender.
Set it with: pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME

USAGE
  pnpm everyapp email <command> [flags]

COMMANDS
  show   Show the app's senders and inbound addresses
  set    Set senders or inbound addresses, without a deploy
  unset  Clear senders or inbound addresses, without a deploy

EXAMPLES
  $ pnpm everyapp email show
  $ pnpm everyapp email set --sender '*@mail.example.com'
  $ pnpm everyapp email unset inbound

Run pnpm everyapp email <command> --help for its flags.
```

## Commands

### `everyapp create`

Create a new app from the starter template.

| Argument | Required | What it is |
| --- | --- | --- |
| `<name>` | no | Lowercase letters, digits and dashes, e.g. my-app (asked for when missing) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--yes` | switch | no |  | Don't ask anything (a name is then required) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Stream install and git output to stderr |

```text
USAGE
  pnpm everyapp create [--yes] [--json] [--verbose] [<name>]
  pnpm everyapp create --help

Inside your Every App checkout the app goes in apps/<name>; anywhere else in ./<name>,
with its own git repository. Dependencies are installed and the local database is ready,
so `pnpm dev` works straight away. Then: cd into it and `pnpm run deploy`.

Example:
  pnpm everyapp create analytics

FLAGS
  -y [--yes/--no-yes]          Don't ask anything (a name is then required)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Stream install and git output to stderr
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [name]  Lowercase letters, digits and dashes, e.g. my-app (asked for when missing)
```

### `everyapp dev`

Run the app locally behind a dev Gateway.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--port` | `<value>` | no |  | Gateway port (defaults to $PORT, then 8787) |
| `--host` | `<value>` | no |  | Address the Gateway listens on (default 127.0.0.1; 0.0.0.0 lets other machines in, each as a dev identity) |
| `--mode` | `<value>` | no |  | stub (seeded dev user, default) \| mirror (real login through a local Gateway) |
| `--gateway` | `<value>` | no |  | mirror mode: URL of the separately-run local Gateway (default http://localhost:3000) |
| `--base-host` | `<value>` | no |  | mirror mode: two-label base host for cookie scope (default everyapp.localhost) |
| `--skip-migrations` | switch | no |  | Start without applying local database migrations |

```text
USAGE
  pnpm everyapp dev [--port value] [--host value] [--mode value] [--gateway value] [--base-host value] [--skip-migrations]
  pnpm everyapp dev --help

Runs the app under `cf dev` (or the manifest's dev command) on an internal
port and a gateway-lite in front of it on $PORT (default 8787) — the REAL
perimeter: public-route policy, header strip/inject, a real RS256 identity
JWT, and a seeded dev user. Open http://<app-id>.localhost:8787 — the first
Host label selects the app, so portless per-worktree hosts work with no
configuration.

Identities are signed with the SDK's well-known dev keypair, which the app's
development build trusts on its own: nothing is written into the app. The
key is public, so the gateway listens on 127.0.0.1 unless --host says
otherwise. Before starting, dev generates the Worker's types when
.cloudflare/types is missing and applies local D1 migrations
(cf d1 migrations apply --local) to .cloudflare/state.

With no Gateway in local runs, the app reads its manifest's secrets and the
keys of its providers and capabilities (OPENROUTER_API_KEY, DATAFORSEO_API_KEY,
...) from .dev.vars in its directory, one NAME=value per line, gitignored. The
ready block names the ones that file is missing and the app can't run without;
until they are set, AI calls and integrations answer that they aren't set up
(email needs none: sendEmail() prints until EMAIL_FROM and a transport are set).

Every request goes through the real perimeter (identity header, public-route
policy, CSRF). Public routes are auth-optional; to call them anonymously send
the header x-everyapp-dev-anon: 1 (curl) or set the cookie everyapp_dev_anon=1
(browser). Requests straight to the app's internal port get 401, by design.

An app that declares crons runs one on demand with
  curl -X POST http://<app-id>.localhost:8787/__everyapp/cron -d '<schedule>'
An app that receives mail gets a curl command that delivers message.eml to its
email() handler: a raw message with From, To, Subject and Message-ID headers,
to any address. email() gets no identity.

--mode stub (default): seeded dev user, zero setup.
--mode mirror: authenticate against a SEPARATELY-running local Gateway
  (run `pnpm dev` in apps/every-app-gateway first). Real login/launcher
  are forwarded to it. Requires a two-label base host (e.g.
  everyapp.localhost) so the session cookie crosses the subdomain
  boundary; the CLI prints setup guidance if the host is unusable.
  Also settable via EVERYAPP_DEV_MODE; the flag wins.

Ctrl+C stops the app and exits with 130.

FLAGS
     [--port]                                  Gateway port (defaults to $PORT, then 8787)
     [--host]                                  Address the Gateway listens on (default 127.0.0.1; 0.0.0.0 lets other machines in, each as a dev identity)
     [--mode]                                  stub (seeded dev user, default) | mirror (real login through a local Gateway)
     [--gateway]                               mirror mode: URL of the separately-run local Gateway (default http://localhost:3000)
     [--base-host]                             mirror mode: two-label base host for cookie scope (default everyapp.localhost)
     [--skip-migrations/--no-skip-migrations]  Start without applying local database migrations
  -h  --help                                   Print help information and exit
      --                                       All subsequent inputs should be interpreted as arguments
```

### `everyapp deploy`

Deploy the app in this directory.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--allow-delete-durable-object-data` | switch | no |  | Deploy even though Durable Object classes were removed, deleting their data |
| `--allow-delete-workflows` | switch | no |  | Deploy even though Workflows were removed, deleting them and their instances |
| `--force-dns` | switch | no |  | Publish the app's new hostname even where a DNS record answers it (one at the hostname is replaced) |
| `--enable-email-routing` | switch | no |  | Turn on Email Routing for the domains the app's inbound addresses (everyapp email set --inbound) name that don't route mail yet (locks their MX and SPF records to Cloudflare) |
| `--no-wait` | switch | no |  | Don't wait for the app to go live (a new hostname's certificate included); it goes live on its first visit |
| `--yes` | switch | no |  | With no Gateway yet, install one at apps.<zone> without asking (never cf's questions, or the one before replacing a Worker changed outside everyapp) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp deploy [--gateway value] [--account-id value] [--allow-delete-durable-object-data] [--allow-delete-workflows] [--force-dns] [--enable-email-routing] [--no-wait] [--yes] [--json] [--verbose]
  pnpm everyapp deploy --help

Deploys the app in this directory as a private Cloudflare Worker defined by cloudflare.config.ts,
with cf and your Cloudflare login (or CLOUDFLARE_API_TOKEN), in the Gateway's account:
  1. Registers the app in the Gateway's database, which names its Worker, resources and hostname
  2. Creates or links the D1 databases and KV namespaces in everyapp.config.ts
  3. Installs dependencies and builds (cf build, or the manifest's build command), then checks
     the built Worker against the app policy and the drizzle migrations against the schema
  4. Bookmarks the production D1 database, then applies its migrations
  5. Uploads the Worker with its secrets, its helper Workers, its Workflows and the Email
     Routing rules for its inbound addresses (turning routing on for a domain asks first)
  6. Rebinds the Gateway from this checkout when the app is new (upgrading the Gateway too
     when the checkout is newer), then waits for the app's hostname to go live

No Gateway in any account the login sees? At a terminal it offers to install one at
apps.<zone> (what pnpm everyapp setup does), then deploys; otherwise it stops with action_required
install_gateway and the setup command to run. Nothing else asks first. Install and build
output goes to a log file, never to stdout. Safe to run again: a redeploy of an app the
Gateway already serves never touches the Gateway.

Someone else's published app: pnpm everyapp install <url>. To publish this one: pnpm everyapp release.
--gateway <url> (or EVERYAPP_GATEWAY_URL) names the Gateway when your login sees several.
With --json, each step is an NDJSON event.

FLAGS
     [--gateway]                                                                 The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]                                                              The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--allow-delete-durable-object-data/--no-allow-delete-durable-object-data]  Deploy even though Durable Object classes were removed, deleting their data
     [--allow-delete-workflows/--no-allow-delete-workflows]                      Deploy even though Workflows were removed, deleting them and their instances
     [--force-dns/--no-force-dns]                                                Publish the app's new hostname even where a DNS record answers it (one at the hostname is replaced)
     [--enable-email-routing/--no-enable-email-routing]                          Turn on Email Routing for the domains the app's inbound addresses (everyapp email set --inbound) name that don't route mail yet (locks their MX and SPF records to Cloudflare)
     [--no-wait/--no-no-wait]                                                    Don't wait for the app to go live (a new hostname's certificate included); it goes live on its first visit
  -y [--yes/--no-yes]                                                            With no Gateway yet, install one at apps.<zone> without asking (never cf's questions, or the one before replacing a Worker changed outside everyapp)
     [--json/--no-json]                                                          Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]                                                    Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                                                                     Print help information and exit
      --                                                                         All subsequent inputs should be interpreted as arguments
```

### `everyapp release`

Pack the app in this directory as a release others can install.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--out` | `<file>` | no |  | Where to write the release (default: ./everyapp-release.tar.gz) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp release [--out file] [--json] [--verbose]
  pnpm everyapp release --help

Builds the app in this directory as a deploy would (tenant-neutral), checks its Build Output
against the app policy and its migrations against its schema, and packs the release
(default ./everyapp-release.tar.gz) without deploying it: no Gateway and no Cloudflare login,
so it runs in CI. Attach the tarball to a GitHub release of the app's repository, and
pnpm everyapp install <repository url> installs it on any Gateway.
With --json, each step is an NDJSON event; done carries the tarball's path and SHA-256.

FLAGS
     [--out]                   Where to write the release (default: ./everyapp-release.tar.gz)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp db migrate`

Apply migrations to the local database.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp db migrate [--json] [--verbose]
  pnpm everyapp db migrate --help

Apply the app's migrations to the local database

Reads migrations from migrations.dir in everyapp.config.ts (default drizzle/).
`pnpm everyapp dev` runs this on every start. Production migrations run only during
`pnpm everyapp deploy`, after a restore point is saved.

FLAGS
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp db query`

Run SQL against the production database (or --local).

| Argument | Required | What it is |
| --- | --- | --- |
| `<sql>` | no | SQL to run |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--local` | switch | no |  | Query the local database `everyapp dev` uses |
| `--file` | `<path>` | no |  | Read the SQL from a file (- for stdin) |
| `--binding` | `<name>` | no |  | D1 binding to query (default: the migrations binding, or the first) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--yes` | switch | no |  | Run SQL that changes the production database without asking |
| `--json` | switch | no |  | Print rows as NDJSON instead of a table |
| `--verbose` | switch | no |  | Show every step |

```text
USAGE
  pnpm everyapp db query [--local] [--file path] [--binding name] [--gateway value] [--account-id value] [--yes] [--json] [--verbose] [<sql>]
  pnpm everyapp db query --help

Run SQL against the app's D1 database

Runs against the production database unless --local is set; SQL that changes it is
confirmed first (--yes skips that). Rows print as a table; use --json for machine output.

EXAMPLES
  $ pnpm everyapp db query "select * from todos limit 5"
  $ pnpm everyapp db query --local "select count(*) from events"
  $ pnpm everyapp db query --file scripts/backfill.sql

FLAGS
     [--local/--no-local]      Query the local database `everyapp dev` uses
     [--file]                  Read the SQL from a file (- for stdin)
     [--binding]               D1 binding to query (default: the migrations binding, or the first)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--yes/--no-yes]          Run SQL that changes the production database without asking
     [--json/--no-json]        Print rows as NDJSON instead of a table
     [--verbose/--no-verbose]  Show every step
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [sql]  SQL to run
```

### `everyapp db restore`

Put the production database back to before the last migrations.

| Argument | Required | What it is |
| --- | --- | --- |
| `<app>` | no | The app (default: the one in this directory) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | switch | no |  | Restore the Gateway's database, from its last migrating setup or upgrade |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--yes` | switch | no |  | Restore without asking |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |

```text
USAGE
  pnpm everyapp db restore [--gateway] [--account-id value] [--yes] [--json] [<app>]
  pnpm everyapp db restore --help

Put the app's production database back to before its last migrations

Each deploy that migrates a database with data saves a restore point first (Time Travel).
This restores the last one, after asking: the migrations are undone, and so is anything
written to the database since. --gateway does the same for the Gateway's database.

EXAMPLES
  $ pnpm everyapp db restore
  $ pnpm everyapp db restore --gateway

FLAGS
     [--gateway/--no-gateway]  Restore the Gateway's database, from its last migrating setup or upgrade
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--yes/--no-yes]          Restore without asking
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [app]  The app (default: the one in this directory)
```

### `everyapp teardown`

Delete everything Every App created in a dedicated test Cloudflare account.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--account-id` | `<id>` | yes |  | The dedicated test account to empty (required; never read from CLOUDFLARE_ACCOUNT_ID) |
| `--confirm` | `<id>` | no |  | The same account id again, for a run without a terminal (--json, a script); at a terminal it is typed instead |
| `--dry-run` | switch | no |  | List what would be deleted and stop; nothing is written |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp teardown (--account-id id) [--confirm id] [--dry-run] [--json] [--verbose]
  pnpm everyapp teardown --help

For the accounts the onboarding loop installs into, over and over: removes every Worker,
Workflow, D1 database, KV namespace, R2 bucket and Hyperdrive config named every-*, the
Gateway's own included, the two Cloudflare Access applications and the allow policy, the
Email Routing rules that send mail to those Workers (a catch-all drops mail again, and
routing is turned off once no rule and no catch-all of anyone else's needs it), the
certificate packs of the hostnames the Gateway published, and the Custom Domain records
(A, AAAA, CNAME) left at exactly those names. Never the zone, the Workers Paid subscription,
the workers.dev subdomain, the Zero Trust team and its identity providers, any other DNS
record (MX, TXT, CAA...) even at those names, R2 buckets outside the default jurisdiction,
or anything whose name doesn't start with every- and that no app recorded.

It is destructive and exists for dedicated test accounts only. The account must be on the
allowlist (EVERYAPP_TEST_ACCOUNTS, or one id per line in ~/.config/everyapp/test-accounts),
the run needs CLOUDFLARE_API_TOKEN scoped to that account alone (a token that sees any other
account is refused), and one account is refused by id whatever the lists say. It reads
everything first and shows what it found; then the account id is typed at the terminal, or
passed again with --confirm for a run without one. There is no --yes.

Examples:
  EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id> --dry-run
  EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id>
  EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id> --confirm <id> --json

FLAGS
      --account-id             The dedicated test account to empty (required; never read from CLOUDFLARE_ACCOUNT_ID)
     [--confirm]               The same account id again, for a run without a terminal (--json, a script); at a terminal it is typed instead
     [--dry-run/--no-dry-run]  List what would be deleted and stop; nothing is written
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp login`

Log in to Cloudflare.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp login [--json] [--verbose]
  pnpm everyapp login --help

Log in to Cloudflare

At a terminal, Cloudflare's own login runs (open its link and enter the code). Piped, or
with --json, the link and code are printed and the run waits for the login to be approved.
Already logged in, it says as whom. Unattended runs can set CLOUDFLARE_API_TOKEN and
CLOUDFLARE_ACCOUNT_ID instead.

FLAGS
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp setup`

Install or repair the Gateway.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--domain` | `<value>` | no |  | Where the Gateway lives: any hostname under one of the account's domains, e.g. apps.example.com (asked at a terminal; remembered after that) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, or with none yet, the one to install it in (default: CLOUDFLARE_ACCOUNT_ID, or the only one) |
| `--force-dns` | switch | no |  | Publish new hostnames even where a DNS record answers them (one at a hostname is replaced) |
| `--allow-downgrade` (hidden) | switch | no |  | Deploy this Gateway even though it is older than the live one (a deliberate rollback) |
| `--redeploy` (hidden) | switch | no |  | Upload the Gateway even when it is up to date (after a change in the dashboard, such as a key rotation) |
| `--yes` | switch | no |  | Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, and stream the Gateway's build output to stderr |

```text
USAGE
  pnpm everyapp setup [--domain value] [--account-id value] [--force-dns] [--yes] [--json] [--verbose]
  pnpm everyapp setup --help

One command from an empty Cloudflare account (Workers Paid) to a working Gateway and its
owner, and the one to run when something is off. Run it again any time: it picks up where it
stopped, and does nothing once everything is there. After a git pull, pnpm everyapp update takes
the newer Gateway from this checkout (setup does that too, on its way).

  1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and finds the Gateway in
     the login's accounts; with none, picks the account to install it in
  2. Picks where the Gateway lives (--domain, or asked): any hostname under one of the
     account's domains, apps.example.com; apps get one each below it, todo.apps.example.com
  3. Installs the Gateway from this checkout (apps/every-app-gateway), or repairs it, and
     waits for its certificate
  4. Opens a one-time link to create the owner account and waits up to 15 minutes for it;
     in CI there is no link, and the run ends with a warning to run setup at a terminal

The flags people use: --domain, --account-id, and --yes for a script (it answers setup's own
questions; never cf's). With --json each step is an NDJSON event; a run that stops on
something only a person can do exits 2 with action_required.
Then: pnpm everyapp create my-app, cd into it, pnpm everyapp dev, pnpm everyapp deploy.
More: https://everyapp.com/docs/gateway

FLAGS
     [--domain]                    Where the Gateway lives: any hostname under one of the account's domains, e.g. apps.example.com (asked at a terminal; remembered after that)
     [--account-id]                The Cloudflare account of the Gateway, or with none yet, the one to install it in (default: CLOUDFLARE_ACCOUNT_ID, or the only one)
     [--force-dns/--no-force-dns]  Publish new hostnames even where a DNS record answers them (one at a hostname is replaced)
  -y [--yes/--no-yes]              Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp)
     [--json/--no-json]            Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]      Show every step and progress line, and stream the Gateway's build output to stderr
  -h  --help                       Print help information and exit
      --                           All subsequent inputs should be interpreted as arguments
```

### `everyapp update`

Update the Gateway to this checkout (after git pull).

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--force-dns` | switch | no |  | Publish new hostnames even where a DNS record answers them (one at a hostname is replaced) |
| `--allow-downgrade` (hidden) | switch | no |  | Deploy this Gateway even though it is older than the live one (a deliberate rollback) |
| `--redeploy` (hidden) | switch | no |  | Upload the Gateway even when it is up to date (after a change in the dashboard, such as a key rotation) |
| `--yes` | switch | no |  | Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp update [--account-id value] [--force-dns] [--yes] [--json] [--verbose]
  pnpm everyapp update --help

Deploys the Gateway built from this checkout (apps/every-app-gateway) over the one your
Cloudflare login finds, where it is, keeping its data, users and apps. It never installs a
Gateway: with none, it stops and says to run pnpm everyapp setup.

  1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and finds the Gateway in
     the login's accounts (--account-id when there is one in more than one)
  2. Upgrades it (migrations first, with a restore point). When it runs this checkout's
     Gateway already, binds and publishes every registered app if the live Gateway doesn't,
     and otherwise says it is up to date. A Gateway newer than this checkout is refused
     (git pull)

The release is named by its version when this checkout's Gateway is that version's release
(the gateway-v<version> tag), and by the checkout's commit otherwise.
With --json, each step is an NDJSON event.

FLAGS
     [--account-id]                The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--force-dns/--no-force-dns]  Publish new hostnames even where a DNS record answers them (one at a hostname is replaced)
  -y [--yes/--no-yes]              Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp)
     [--json/--no-json]            Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]      Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                       Print help information and exit
      --                           All subsequent inputs should be interpreted as arguments
```

### `everyapp install`

Install an app someone published, from GitHub or a release file.

| Argument | Required | What it is |
| --- | --- | --- |
| `<source>` | yes | The app release to install: a GitHub repository URL (its latest release), a release tarball's URL, or a downloaded everyapp-release.tar.gz |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--allow-delete-durable-object-data` | switch | no |  | Deploy even though Durable Object classes were removed, deleting their data |
| `--allow-delete-workflows` | switch | no |  | Deploy even though Workflows were removed, deleting them and their instances |
| `--force-dns` | switch | no |  | Publish the app's new hostname even where a DNS record answers it (one at the hostname is replaced) |
| `--enable-email-routing` | switch | no |  | Turn on Email Routing for the domains the app's inbound addresses (everyapp email set --inbound) name that don't route mail yet (locks their MX and SPF records to Cloudflare) |
| `--no-wait` | switch | no |  | Don't wait for the app to go live (a new hostname's certificate included); it goes live on its first visit |
| `--yes` | switch | no |  | With no Gateway yet, install one at apps.<zone> without asking (never cf's questions, or the one before replacing a Worker changed outside everyapp) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp install [--gateway value] [--account-id value] [--allow-delete-durable-object-data] [--allow-delete-workflows] [--force-dns] [--enable-email-routing] [--no-wait] [--yes] [--json] [--verbose] <source>
  pnpm everyapp install --help

Installs an app release on your Gateway with no checkout of the app, as pnpm everyapp deploy
would from the app's directory, with nothing to build: <source> is a GitHub repository URL
(the everyapp-release.tar.gz on its latest release; …/releases/tag/<tag> for that one), a
tarball's HTTPS URL, or a downloaded everyapp-release.tar.gz. The release holds the app's
tenant-neutral Build Output, migrations and manifest, checked against its SHA-256. Run it
again later to update the app. Its secrets come from .everyapp/secrets.env in this directory.

A repository without a release is never built from its URL: clone it, then run
pnpm install && pnpm everyapp deploy in it. Postgres migrations need the app's source, so their
releases are refused.

No Gateway in any account the login sees? At a terminal it offers to install one at
apps.<zone> (what pnpm everyapp setup does, owner link included), then installs the app; otherwise
it stops with action_required install_gateway and the setup command to run.
--gateway <url> (or EVERYAPP_GATEWAY_URL) names the Gateway when your login sees several.
With --json, each step is an NDJSON event.

FLAGS
     [--gateway]                                                                 The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]                                                              The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--allow-delete-durable-object-data/--no-allow-delete-durable-object-data]  Deploy even though Durable Object classes were removed, deleting their data
     [--allow-delete-workflows/--no-allow-delete-workflows]                      Deploy even though Workflows were removed, deleting them and their instances
     [--force-dns/--no-force-dns]                                                Publish the app's new hostname even where a DNS record answers it (one at the hostname is replaced)
     [--enable-email-routing/--no-enable-email-routing]                          Turn on Email Routing for the domains the app's inbound addresses (everyapp email set --inbound) name that don't route mail yet (locks their MX and SPF records to Cloudflare)
     [--no-wait/--no-no-wait]                                                    Don't wait for the app to go live (a new hostname's certificate included); it goes live on its first visit
  -y [--yes/--no-yes]                                                            With no Gateway yet, install one at apps.<zone> without asking (never cf's questions, or the one before replacing a Worker changed outside everyapp)
     [--json/--no-json]                                                          Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]                                                    Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                                                                     Print help information and exit
      --                                                                         All subsequent inputs should be interpreted as arguments

ARGUMENTS
  source  The app release to install: a GitHub repository URL (its latest release), a release tarball's URL, or a downloaded everyapp-release.tar.gz
```

### `everyapp status`

Show the Gateway, its apps and anything to fix.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp status [--account-id value] [--json] [--verbose]
  pnpm everyapp status --help

One screen, all of it from the Gateway's D1 database and cf, nothing asked of the Gateway:
its URL and release (and whether this checkout builds it), its owner, the apps its registry
lists and whether the live Gateway binds them, each hostname's certificate, any deploy in
progress, and what to run when something is off. With --json, the `done` event's data has
all of it, `fixes` included: the one state query an agent needs.

FLAGS
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp delete`

Remove an app from the Gateway.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | no | App id (default: the app in this directory) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--purge` | switch | no |  | Also delete the app's Worker and helper Workers, D1 databases, KV namespaces, Workflows and Email Routing routes |
| `--yes` | switch | no |  | Delete without asking (with --purge too, without typing the app id) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp delete [--gateway value] [--account-id value] [--purge] [--yes] [--json] [--verbose] [<id>]
  pnpm everyapp delete --help

Deletes the app in the Gateway's D1 database (its name stays reserved to your organization) and
removes its Gateway binding and hostname, with a redeploy of the Gateway from this checkout.
The app's Worker and data are kept unless --purge, which deletes them for good.
Asks first at a terminal; elsewhere it needs --yes.

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--purge/--no-purge]      Also delete the app's Worker and helper Workers, D1 databases, KV namespaces, Workflows and Email Routing routes
  -y [--yes/--no-yes]          Delete without asking (with --purge too, without typing the app id)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [id]  App id (default: the app in this directory)
```

### `everyapp access on`

Turn Cloudflare Access on in front of the Gateway and its apps, or bring it up to date.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--email` | `<address>` (repeatable) | no |  | Also let this email address past Access (repeat for several; an account still takes an invitation) |
| `--email-domain` | `<domain>` (repeatable) | no |  | Also let everyone with an email address at this domain past Access (repeat for several) |
| `--team` | `<name>` | no |  | Name for a new Zero Trust team when the account has none: its sign-in page is <name>.cloudflareaccess.com, for good (asked at a terminal; ignored once a team exists) |
| `--session` | `<duration>` | no |  | How long an Access sign-in lasts, like 720h or 24h (default 720h, the most Access allows; an existing application keeps its own unless given) |
| `--team-session` | `<duration>` | no |  | Set the team's global session too (how often people sign in at the identity provider): it applies to every Access application in the account |
| `--write-settings` | switch | no |  | Write the three Gateway settings even when they are set already (after an Access application was recreated by hand: its AUD tag changed) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp access on [--email address]... [--email-domain domain]... [--team name] [--session duration] [--team-session duration] [--write-settings] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp access on --help

Everyone opens the Gateway and its apps through Cloudflare Access first (a one-time PIN to
their email, or your identity provider), then lands signed in. With your Cloudflare login it
finds or creates the Zero Trust team, adds the one-time PIN when people have no other way to
sign in, keeps an allow policy with every member's and invitee's email, puts one Access
application in front of the Gateway's host and one in front of the apps' hosts (MCP, the OAuth
endpoints and each app's public routes stay reachable without a login), and gives the Gateway
the team domain and both AUD tags in one change.

Run it again any time: after inviting someone, so Access lets them in, or after anything
changed by hand. It changes only what differs, never removes anyone from the policy, and
leaves alone what it didn't set up. Deploys keep an app's public routes in step themselves.

Afterwards each existing member signs in once with their password through Access, which
links the two. Then passwords can go: pnpm everyapp secret set EMAIL_PASSWORD_SIGN_IN (false).

Examples:
  pnpm everyapp access on
  pnpm everyapp access on --email-domain example.com
  pnpm everyapp access on --team acme --json

FLAGS
     [--email]...                            Also let this email address past Access (repeat for several; an account still takes an invitation)
     [--email-domain]...                     Also let everyone with an email address at this domain past Access (repeat for several)
     [--team]                                Name for a new Zero Trust team when the account has none: its sign-in page is <name>.cloudflareaccess.com, for good (asked at a terminal; ignored once a team exists)
     [--session]                             How long an Access sign-in lasts, like 720h or 24h (default 720h, the most Access allows; an existing application keeps its own unless given)
     [--team-session]                        Set the team's global session too (how often people sign in at the identity provider): it applies to every Access application in the account
     [--write-settings/--no-write-settings]  Write the three Gateway settings even when they are set already (after an Access application was recreated by hand: its AUD tag changed)
     [--gateway]                             The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]                          The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]                      Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]                Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                                 Print help information and exit
      --                                     All subsequent inputs should be interpreted as arguments
```

### `everyapp access off`

Turn Cloudflare Access off for the Gateway and its apps.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--keep-applications` | switch | no |  | Keep the two Access applications: Access still asks people to sign in there, and the Gateway no longer requires it |
| `--yes` | switch | no |  | Turn Access off without asking |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp access off [--keep-applications] [--yes] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp access off --help

Removes CLOUDFLARE_ACCESS_AUD, CLOUDFLARE_ACCESS_APPS_AUD and CLOUDFLARE_ACCESS_TEAM_DOMAIN
from the Gateway in one change, so passwords sign people in again at once, then deletes the
two Access applications (one that also covers something else only loses Every App's hosts).
The Zero Trust team, its identity providers and the allow policy stay: other applications may
use them. Asks first.

Example:
  pnpm everyapp access off

FLAGS
     [--keep-applications/--no-keep-applications]  Keep the two Access applications: Access still asks people to sign in there, and the Gateway no longer requires it
  -y [--yes/--no-yes]                              Turn Access off without asking
     [--gateway]                                   The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]                                The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]                            Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]                      Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                                       Print help information and exit
      --                                           All subsequent inputs should be interpreted as arguments
```

### `everyapp access show`

Show how Cloudflare Access fronts the Gateway, and what access on would change.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp access show [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp access show --help

The Zero Trust team, who the allow policy lets in, the two Access applications and whether
their public paths match the apps' public routes, and which Access settings the Gateway has
(their values can't be read back). Nothing is changed.

Example:
  pnpm everyapp access show

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp secret set`

Set secrets on your app or your Gateway.

| Argument | Required | What it is |
| --- | --- | --- |
| `<name>...` | yes | Secret or Gateway setting |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--from-env` | `<VAR>` | no |  | Read the value from this environment variable |
| `--app` | `<id>` | no |  | The app whose secret this is (default: the app in this directory) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show which Worker each secret goes to and its new version |

```text
USAGE
  pnpm everyapp secret set [--from-env VAR] [--app id] [--gateway value] [--account-id value] [--json] [--verbose] <name>...
  pnpm everyapp secret set --help

Gateway settings (AI provider keys, EMAIL_FROM, sign-in clients) go to the Gateway, from any
directory. Other names go to the app in this directory, or with --app <id> to that app from
anywhere; the app's everyapp.config.ts must list them under secrets. Values come from a
hidden prompt, --from-env or stdin, never the command line. Changes are live at once; no
deploy needed.

Examples:
  pnpm everyapp secret set OPENAI_API_KEY
  pnpm everyapp secret set GITHUB_TOKEN --from-env GITHUB_TOKEN
  echo "$STRIPE_KEY" | pnpm everyapp secret set STRIPE_KEY
  pnpm everyapp secret set MAIN_SECRET --app analytics

See what an app needs and what is set: pnpm everyapp secret list [<app>]

FLAGS
     [--from-env]              Read the value from this environment variable
     [--app]                   The app whose secret this is (default: the app in this directory)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show which Worker each secret goes to and its new version
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  name...  Secret or Gateway setting
```

### `everyapp secret unset`

Remove secrets from your app or your Gateway.

| Argument | Required | What it is |
| --- | --- | --- |
| `<name>...` | yes | Secret or Gateway setting |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--yes` | switch | no |  | Remove without asking |
| `--app` | `<id>` | no |  | The app whose secret this is (default: the app in this directory) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout (never asks) |
| `--verbose` | switch | no |  | Show which Worker each secret is removed from |

```text
USAGE
  pnpm everyapp secret unset [--yes] [--app id] [--gateway value] [--account-id value] [--json] [--verbose] <name>...
  pnpm everyapp secret unset --help

Names go where `secret set` sends them (--app <id> names the app from anywhere). Asks before
removing; the change is live at once.

Example:
  pnpm everyapp secret unset GITHUB_TOKEN

FLAGS
  -y [--yes/--no-yes]          Remove without asking
     [--app]                   The app whose secret this is (default: the app in this directory)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout (never asks)
     [--verbose/--no-verbose]  Show which Worker each secret is removed from
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  name...  Secret or Gateway setting
```

### `everyapp secret list`

List what an app needs set and what is: its own secrets and the Gateway's settings.

| Argument | Required | What it is |
| --- | --- | --- |
| `<app>` | no | An app id (default: the app in this directory; elsewhere, every app) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print the result as an NDJSON event |
| `--verbose` | switch | no |  | Also list the names everyapp sets itself |

```text
USAGE
  pnpm everyapp secret list [--gateway value] [--account-id value] [--json] [--verbose] [<app>]
  pnpm everyapp secret list --help

For one app (the app in this directory, or <app> from anywhere): every setting its manifest
declares, where it is held (the Gateway, or the app's Worker), whether it is set, and the one
secret set command that opens the app when something required is missing. Elsewhere with no
app named: the Gateway's names and who set them, then every app's settings. Names only, never
values.

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print the result as an NDJSON event
     [--verbose/--no-verbose]  Also list the names everyapp sets itself
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [app]  An app id (default: the app in this directory; elsewhere, every app)
```

### `everyapp email show`

Show the app's senders and inbound addresses.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--manifest` | `<path>` | no |  | Path to everyapp.config.ts, if it isn't in this directory |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp email show [--manifest path] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp email show --help

Lists the app's senders and inbound addresses on the Gateway, and whether each
inbound address is routed.

Examples:
  pnpm everyapp email show
  pnpm everyapp email show --manifest ../analytics/everyapp.config.ts

FLAGS
     [--manifest]              Path to everyapp.config.ts, if it isn't in this directory
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp email set`

Set senders or inbound addresses, without a deploy.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--sender` | `<pattern>` (repeatable) | no |  | Address the app may send as: '*@<domain>' or one address (repeat, up to 20) |
| `--inbound` | `<address>` (repeatable) | no |  | Address whose mail goes to the app: '*@<apex>' or one address (repeat, up to 50) |
| `--enable-email-routing` | switch | no |  | Turn on Email Routing for inbound domains without asking |
| `--manifest` | `<path>` | no |  | Path to everyapp.config.ts, if it isn't in this directory |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp email set [--sender pattern]... [--inbound address]... [--enable-email-routing] [--manifest path] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp email set --help

Each flag replaces its whole list; a list you don't name is kept. The Gateway
picks up a change within 30 seconds, without a deploy. Addresses set before
the app's first upload are routed by its next deploy.

Requirements:
  --sender   everyapp.config.ts lists capabilities.email; each domain is set up for Email Sending
  --inbound  everyapp.config.ts declares email: { inbound: true }; the domain is on Cloudflare DNS

Examples:
  pnpm everyapp email set --sender '*@mail.example.com'
  pnpm everyapp email set --inbound reports@mail.example.com
  pnpm everyapp email set --inbound '*@example.com' --enable-email-routing

FLAGS
     [--sender]...                                       Address the app may send as: '*@<domain>' or one address (repeat, up to 20)
     [--inbound]...                                      Address whose mail goes to the app: '*@<apex>' or one address (repeat, up to 50)
     [--enable-email-routing/--no-enable-email-routing]  Turn on Email Routing for inbound domains without asking
     [--manifest]                                        Path to everyapp.config.ts, if it isn't in this directory
     [--gateway]                                         The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]                                      The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]                                  Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]                            Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                                             Print help information and exit
      --                                                 All subsequent inputs should be interpreted as arguments
```

### `everyapp email unset`

Clear senders or inbound addresses, without a deploy.

| Argument | Required | What it is |
| --- | --- | --- |
| `<senders|inbound>...` | yes | List to clear: senders or inbound |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--manifest` | `<path>` | no |  | Path to everyapp.config.ts, if it isn't in this directory |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp email unset [--manifest path] [--gateway value] [--account-id value] [--json] [--verbose] <senders|inbound>...
  pnpm everyapp email unset --help

Clearing inbound addresses removes their Email Routing rules; a catch-all goes
back to dropping mail. Nothing is built or deployed.

Examples:
  pnpm everyapp email unset inbound
  pnpm everyapp email unset senders inbound

FLAGS
     [--manifest]              Path to everyapp.config.ts, if it isn't in this directory
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  senders|inbound...  List to clear: senders or inbound
```
