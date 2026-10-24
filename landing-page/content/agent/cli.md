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
| `-h`, `--help` | Help for everyapp or a command; `-H`, `--help-all` also shows hidden commands and flags. |
| `-v`, `--version` | everyapp's version. |

## `everyapp --help`

```text
Deploy and run Every App apps on your own Cloudflare account.

USAGE
  everyapp <command> [flags]

GET STARTED
  login       Log in to Cloudflare
  setup       Install, upgrade or repair the Gateway
  gateway     Deploy the Gateway you already have
  create      Create a new app from the starter template

APPS
  dev         Run the app locally behind a dev Gateway
  deploy      Deploy the app in this directory, or a release
  delete      Remove an app from the Gateway

CONFIGURE
  secret      Set, remove and list secrets and Gateway settings
  email       Manage the addresses an app sends as and receives at
  access      Put Cloudflare Access in front of the Gateway and its apps, or take it off

INSPECT
  status      Show the Gateway, its apps and anything to fix
  db          Migrate, query and restore an app's D1 database
  workflow    Inspect and control an app's Workflows

SHELL COMPLETION
  completion  Install or remove bash completion

FLAGS
  -h, --help      Show help for everyapp or a command
  -H, --help-all  Also show hidden commands and flags
  -v, --version   Show everyapp's version
      --no-color  Print without colors (also NO_COLOR=1)

EXAMPLES
  $ everyapp setup --domain apps.example.com
  $ everyapp create todo
  $ everyapp deploy

Run everyapp <command> --help for a command's flags.
```

## Command groups

### `everyapp gateway`

```text
Deploy the Gateway you already have.

USAGE
  everyapp gateway <command> [flags]

COMMANDS
  deploy  Deploy this checkout to the Gateway you already have

Run everyapp gateway <command> --help for its flags.
```

### `everyapp secret`

```text
Set, remove and list secrets and Gateway settings.

USAGE
  everyapp secret <command> [flags]

COMMANDS
  set    Set secrets on your app or your Gateway
  unset  Remove secrets from your app or your Gateway
  list   List secrets: the app's in its directory, the Gateway's anywhere else

EXAMPLES
  $ everyapp secret set GITHUB_TOKEN
  $ everyapp secret set GITHUB_TOKEN --from-env GH_TOKEN

Run everyapp secret <command> --help for its flags.
```

### `everyapp email`

```text
Manage the addresses an app sends as and receives at.

Invites, and apps that don't set their own senders, send as the Gateway's sender.
Set it with: everyapp secret set EMAIL_FROM EMAIL_FROM_NAME

USAGE
  everyapp email <command> [flags]

COMMANDS
  show   Show the app's senders and inbound addresses
  set    Set senders or inbound addresses, without a deploy
  unset  Clear senders or inbound addresses, without a deploy

EXAMPLES
  $ everyapp email show
  $ everyapp email set --sender '*@mail.example.com'
  $ everyapp email unset inbound

Run everyapp email <command> --help for its flags.
```

### `everyapp db`

```text
Migrate, query and restore an app's D1 database.

USAGE
  everyapp db <command> [flags]

COMMANDS
  migrate  Apply migrations to the local database
  query    Run SQL against the production database (or --local)
  restore  Put the production database back to before the last migrations

EXAMPLES
  $ everyapp db migrate
  $ everyapp db query 'select count(*) from todos'

Run everyapp db <command> --help for its flags.
```

### `everyapp workflow`

```text
Inspect and control an app's Workflows.

USAGE
  everyapp workflow <command> [flags]

COMMANDS
  list       List the app's Workflows with how many instances each has, by status
  instances  List a Workflow's instances
  get        Show an instance's status, params, steps, output and error
  start      Start an instance of a Workflow
  pause      Pause an instance
  resume     Resume a paused instance
  restart    Run an instance again from the start
  terminate  Stop an instance for good (asks first)

EXAMPLES
  $ everyapp workflow list
  $ everyapp workflow instances RANK_CHECK --status errored
  $ everyapp workflow start RANK_CHECK --params '{"siteId":"abc"}'

Run everyapp workflow <command> --help for its flags.
```

### `everyapp completion`

```text
Install or remove bash completion.

USAGE
  everyapp completion <command> [flags]

COMMANDS
  install    Installs bash autocomplete support for everyapp
  uninstall  Uninstalls bash autocomplete support for everyapp

EXAMPLES
  $ everyapp completion install

Run everyapp completion <command> --help for its flags.
```

## Commands

### `everyapp login`

Log in to Cloudflare.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp login [--json] [--verbose]
  everyapp login --help

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

Install, upgrade or repair the Gateway.

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
  everyapp setup [--domain value] [--account-id value] [--force-dns] [--yes] [--json] [--verbose]
  everyapp setup --help

One command from an empty Cloudflare account to a working Gateway and its owner, and the
one to run after a git pull or when something is off. Run it again any time: it picks up
where it stopped, and does nothing once everything is there. Your Cloudflare login is the
only credential for CLI deploys: apps deploy with it, on this machine or any other, before the Gateway
has an owner.

The Gateway is built from this checkout (apps/every-app-gateway; the build is cached by the
tree hash of its sources). App deploys that rebind the Gateway take it from the same place,
so they upgrade it too when the checkout is newer.

  1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and finds the Gateway in
     the login's accounts; with none, picks the account to install it in
  2. Checks the release (a newer everyapp it needs) before asking anything,
     and Workers Paid, which Every App needs: a Free plan stops before anything is created,
     one it can't confirm is a warning
  3. Picks where the Gateway lives: any hostname under one of the account's domains
     (apps.example.com), checked for DNS records in the way; apps get one each below it
     (todo.apps.example.com), with their own DNS and certificate
  4. Installs the Gateway, or upgrades it to that release (migrations first, with a restore
     point), and waits for its certificate. When it runs that release already, binds and
     publishes every registered app if the live Gateway doesn't, and otherwise says it is up
     to date. A Gateway older than the live one is refused (from a checkout: git pull), and
     one that needs a newer everyapp too
  5. Opens a one-time link to create the owner account, and waits up to 15 minutes for it;
     a run resumed later shows a new link, and the earlier one stops working. In CI there
     is no link: the run ends with a warning to run setup at a terminal (apps deploy
     without an owner)
  6. At a terminal, optionally configures browser deployment (Yes/No, default No), using
     a hidden Cloudflare API token prompt. Skips this when a token is already configured,
     or with --yes

Then: everyapp create my-app, cd into it, everyapp dev, everyapp deploy.
No domain on Cloudflare yet? Buy one in the dashboard (Domains → Buy a domain), then run it again.
Gateway installation asks for no go-ahead: the first lines say which account and where. A checkout
build's output goes to a log file, never to stdout.
With --json, each step is an NDJSON event; what a person must do is `action_required`
(with its link and code), and the run exits 2 when it stops on one.

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

### `everyapp gateway deploy`

Deploy this checkout to the Gateway you already have.

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
  everyapp gateway deploy [--account-id value] [--force-dns] [--yes] [--json] [--verbose]
  everyapp gateway deploy --help

Deploy the Gateway built from this checkout (apps/every-app-gateway) to the Gateway your
Cloudflare login finds, where it is, keeping its data, users and apps. It never installs a
Gateway: with none, it stops and says to run everyapp setup.

  1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and finds the Gateway in
     the login's accounts (--account-id when there is one in more than one)
  2. Upgrades it (migrations first, with a restore point). When it runs this checkout's
     Gateway already, binds and publishes every registered app if the live Gateway doesn't,
     and otherwise says it is up to date. A Gateway older than the live one is refused
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

### `everyapp status`

Show the Gateway, its apps and anything to fix.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp status [--account-id value] [--json] [--verbose]
  everyapp status --help

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
  everyapp create [--yes] [--json] [--verbose] [<name>]
  everyapp create --help

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
  everyapp dev [--port value] [--host value] [--mode value] [--gateway value] [--base-host value] [--skip-migrations]
  everyapp dev --help

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

Deploy the app in this directory, or a release.

| Argument | Required | What it is |
| --- | --- | --- |
| `<source>` | no | An app release to deploy instead of the app in this directory: a GitHub repository URL (its latest release), a release tarball's URL, or a downloaded everyapp-release.tar.gz |

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
| `--bundle-only` | switch | no |  | Build the app in this directory and pack it as a release (everyapp-release.tar.gz) without deploying it: no Gateway or Cloudflare login (CI) |
| `--out` | `<value>` | no |  | With --bundle-only: where to write the release (default: ./everyapp-release.tar.gz) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp deploy [--gateway value] [--account-id value] [--allow-delete-durable-object-data] [--allow-delete-workflows] [--force-dns] [--enable-email-routing] [--no-wait] [--yes] [--bundle-only] [--out value] [--json] [--verbose] [<source>]
  everyapp deploy --help

Deploys the app in this directory as a private Cloudflare Worker defined by cloudflare.config.ts,
with cf and your Cloudflare login (or CLOUDFLARE_API_TOKEN), in the Gateway's account:
  1. Registers the app in the Gateway's D1 database, which names its Worker, resources and hostname
     (a new hostname is checked first: no DNS record that answers it, room in the zone)
  2. Creates or links the D1 databases and KV namespaces in everyapp.config.ts
  3. Installs dependencies (the manifest's install setting, or auto-detected)
  4. Builds with cf build (or the manifest's build command): the same tenant-neutral build for
     every install, with placeholders for its Worker name, organization, Gateway, identity key
     and resource ids. Installs it for this deploy (every placeholder rewritten; refused if one
     survives), checks the installed Worker, and checks that the drizzle migrations still
     describe the schema
  5. Bookmarks the production D1 database, then applies its migrations
  6. Uploads it with cf deploy --prebuilt, its secrets in the same version, and
     creates or updates its Workflows (refused if another Worker runs one of their names);
     its helper Workers (everyapp.config.ts workers, <worker>--<name>) go up first; then routes
     the mail to the addresses its installation lists (everyapp email set --inbound) to it with
     Email Routing rules (checked before anything is created; turning routing on for a domain
     asks first, or --enable-email-routing)
  7. Redeploys the Gateway from this checkout to bind the Worker and publish its hostname (new
     apps; it upgrades the Gateway too when the checkout is newer), then requests the app's
     hostname until it is live (a new hostname's certificate included); behind Cloudflare
     Access, it goes live on its first visit

No Gateway in any account the login sees? At a terminal it offers to install one at
apps.<zone> (what `everyapp setup` does, owner link included), then deploys; otherwise it
stops with action_required install_gateway and the setup command to run.
Nothing else asks first: the first line says where the app goes. Install and build output
goes to a log file (its last lines and path are shown if it fails), never to stdout.
Safe to run again: a redeploy of an app the Gateway already serves never touches the Gateway.

From a release, with no checkout of the app: `everyapp deploy https://github.com/<owner>/<repo>`
deploys the everyapp-release.tar.gz on the repository's latest release (…/releases/tag/<tag>: that
one); a tarball's HTTPS URL or a local file works too. The release holds the app's tenant-neutral
Build Output, migrations and manifest, checked against its SHA-256: steps 3 and 4 install and
check it instead of building (the publisher's build checked the schema). Postgres migrations need
the app's source, so their releases are refused. A repository without a release is never built
from its URL: clone it, then run pnpm install && pnpm everyapp deploy.

--bundle-only [--out <file>] builds the app in this directory, checks its Build Output against the
app policy and its migrations against its schema, and packs the release (default
./everyapp-release.tar.gz) without deploying it: no Gateway or Cloudflare login, for CI. Attach it
to a GitHub release of the app's repository and `everyapp deploy <repository url>` installs it.

--gateway <url> (or EVERYAPP_GATEWAY_URL) names the Gateway to deploy to when your login sees
several; it is checked against the one found in your Cloudflare account.

FLAGS
     [--gateway]                                                                 The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]                                                              The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--allow-delete-durable-object-data/--no-allow-delete-durable-object-data]  Deploy even though Durable Object classes were removed, deleting their data
     [--allow-delete-workflows/--no-allow-delete-workflows]                      Deploy even though Workflows were removed, deleting them and their instances
     [--force-dns/--no-force-dns]                                                Publish the app's new hostname even where a DNS record answers it (one at the hostname is replaced)
     [--enable-email-routing/--no-enable-email-routing]                          Turn on Email Routing for the domains the app's inbound addresses (everyapp email set --inbound) name that don't route mail yet (locks their MX and SPF records to Cloudflare)
     [--no-wait/--no-no-wait]                                                    Don't wait for the app to go live (a new hostname's certificate included); it goes live on its first visit
  -y [--yes/--no-yes]                                                            With no Gateway yet, install one at apps.<zone> without asking (never cf's questions, or the one before replacing a Worker changed outside everyapp)
     [--bundle-only/--no-bundle-only]                                            Build the app in this directory and pack it as a release (everyapp-release.tar.gz) without deploying it: no Gateway or Cloudflare login (CI)
     [--out]                                                                     With --bundle-only: where to write the release (default: ./everyapp-release.tar.gz)
     [--json/--no-json]                                                          Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]                                                    Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                                                                     Print help information and exit
      --                                                                         All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [source]  An app release to deploy instead of the app in this directory: a GitHub repository URL (its latest release), a release tarball's URL, or a downloaded everyapp-release.tar.gz
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
  everyapp delete [--gateway value] [--account-id value] [--purge] [--yes] [--json] [--verbose] [<id>]
  everyapp delete --help

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

### `everyapp secret set`

Set secrets on your app or your Gateway.

| Argument | Required | What it is |
| --- | --- | --- |
| `<name>...` | yes | Secret or Gateway setting |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--from-env` | `<VAR>` | no |  | Read the value from this environment variable |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show which Worker each secret goes to and its new version |

```text
USAGE
  everyapp secret set [--from-env VAR] [--gateway value] [--account-id value] [--json] [--verbose] <name>...
  everyapp secret set --help

Gateway settings (AI provider keys, EMAIL_FROM, sign-in clients) go to the Gateway, from any
directory. Other names go to the app in this directory, which must list them under secrets
in everyapp.config.ts. Values come from a hidden prompt, --from-env or stdin, never the
command line. Changes are live at once; no deploy needed.

Examples:
  everyapp secret set OPENAI_API_KEY
  everyapp secret set GITHUB_TOKEN --from-env GITHUB_TOKEN
  echo "$STRIPE_KEY" | everyapp secret set STRIPE_KEY

See which names you can set: everyapp secret list

FLAGS
     [--from-env]              Read the value from this environment variable
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout (never asks) |
| `--verbose` | switch | no |  | Show which Worker each secret is removed from |

```text
USAGE
  everyapp secret unset [--yes] [--gateway value] [--account-id value] [--json] [--verbose] <name>...
  everyapp secret unset --help

Names go where `secret set` sends them. Asks before removing; the change is live at once.

Example:
  everyapp secret unset GITHUB_TOKEN

FLAGS
  -y [--yes/--no-yes]          Remove without asking
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

List secrets: the app's in its directory, the Gateway's anywhere else.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print the result as an NDJSON event |
| `--verbose` | switch | no |  | Also list the names everyapp sets itself |

```text
USAGE
  everyapp secret list [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp secret list --help

In an app's directory: its secrets and the Gateway settings it uses, with what's missing.
Elsewhere: the Gateway's, and the settings you can set on it.

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print the result as an NDJSON event
     [--verbose/--no-verbose]  Also list the names everyapp sets itself
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
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
  everyapp email show [--manifest path] [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp email show --help

Lists the app's senders and inbound addresses on the Gateway, and whether each
inbound address is routed.

Examples:
  everyapp email show
  everyapp email show --manifest ../analytics/everyapp.config.ts

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
  everyapp email set [--sender pattern]... [--inbound address]... [--enable-email-routing] [--manifest path] [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp email set --help

Each flag replaces its whole list; a list you don't name is kept. The Gateway
picks up a change within 30 seconds, without a deploy. Addresses set before
the app's first upload are routed by its next deploy.

Requirements:
  --sender   everyapp.config.ts lists capabilities.email; each domain is set up for Email Sending
  --inbound  everyapp.config.ts declares email: { inbound: true }; the domain is on Cloudflare DNS

Examples:
  everyapp email set --sender '*@mail.example.com'
  everyapp email set --inbound reports@mail.example.com
  everyapp email set --inbound '*@example.com' --enable-email-routing

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
  everyapp email unset [--manifest path] [--gateway value] [--account-id value] [--json] [--verbose] <senders|inbound>...
  everyapp email unset --help

Clearing inbound addresses removes their Email Routing rules; a catch-all goes
back to dropping mail. Nothing is built or deployed.

Examples:
  everyapp email unset inbound
  everyapp email unset senders inbound

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
  everyapp access on [--email address]... [--email-domain domain]... [--team name] [--session duration] [--team-session duration] [--write-settings] [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp access on --help

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
links the two. Then passwords can go: everyapp secret set EMAIL_PASSWORD_SIGN_IN (false).

Examples:
  everyapp access on
  everyapp access on --email-domain example.com
  everyapp access on --team acme --json

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
  everyapp access off [--keep-applications] [--yes] [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp access off --help

Removes CLOUDFLARE_ACCESS_AUD, CLOUDFLARE_ACCESS_APPS_AUD and CLOUDFLARE_ACCESS_TEAM_DOMAIN
from the Gateway in one change, so passwords sign people in again at once, then deletes the
two Access applications (one that also covers something else only loses Every App's hosts).
The Zero Trust team, its identity providers and the allow policy stay: other applications may
use them. Asks first.

Example:
  everyapp access off

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
  everyapp access show [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp access show --help

The Zero Trust team, who the allow policy lets in, the two Access applications and whether
their public paths match the apps' public routes, and which Access settings the Gateway has
(their values can't be read back). Nothing is changed.

Example:
  everyapp access show

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
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
  everyapp db migrate [--json] [--verbose]
  everyapp db migrate --help

Apply the app's migrations to the local database

Reads migrations from migrations.dir in everyapp.config.ts (default drizzle/).
`everyapp dev` runs this on every start. Production migrations run only during
`everyapp deploy`, after a restore point is saved.

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
  everyapp db query [--local] [--file path] [--binding name] [--gateway value] [--account-id value] [--yes] [--json] [--verbose] [<sql>]
  everyapp db query --help

Run SQL against the app's D1 database

Runs against the production database unless --local is set; SQL that changes it is
confirmed first (--yes skips that). Rows print as a table; use --json for machine output.

EXAMPLES
  $ everyapp db query "select * from todos limit 5"
  $ everyapp db query --local "select count(*) from events"
  $ everyapp db query --file scripts/backfill.sql

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
  everyapp db restore [--gateway] [--account-id value] [--yes] [--json] [<app>]
  everyapp db restore --help

Put the app's production database back to before its last migrations

Each deploy that migrates a database with data saves a restore point first (Time Travel).
This restores the last one, after asking: the migrations are undone, and so is anything
written to the database since. --gateway does the same for the Gateway's database.

EXAMPLES
  $ everyapp db restore
  $ everyapp db restore --gateway

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

### `everyapp workflow list`

List the app's Workflows with how many instances each has, by status.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workflow list [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp workflow list --help

List the app's Workflows with how many instances each has, by status

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workflow instances`

List a Workflow's instances.

| Argument | Required | What it is |
| --- | --- | --- |
| `<workflow>` | yes | The Workflow's binding in everyapp.config.ts, its class or its name |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |
| `--status` | `queued`, `running`, `paused`, `waiting`, `waiting-for-pause`, `errored`, `terminated`, `complete`, `rolling-back` | no |  | Only instances with this status |
| `--limit` | `<n>` | no |  | How many to list, 1-100 (default 25) |

```text
USAGE
  everyapp workflow instances [--gateway value] [--account-id value] [--json] [--verbose] [--status queued|running|paused|waiting|waiting-for-pause|errored|terminated|complete|rolling-back] [--limit n] <workflow>
  everyapp workflow instances --help

List a Workflow's instances

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
     [--status]                Only instances with this status                                                                                            [queued|running|paused|waiting|waiting-for-pause|errored|terminated|complete|rolling-back]
     [--limit]                 How many to list, 1-100 (default 25)
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  workflow  The Workflow's binding in everyapp.config.ts, its class or its name
```

### `everyapp workflow get`

Show an instance's status, params, steps, output and error.

| Argument | Required | What it is |
| --- | --- | --- |
| `<workflow>` | yes | The Workflow's binding in everyapp.config.ts, its class or its name |
| `<instance-id>` | yes | The instance id |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workflow get [--gateway value] [--account-id value] [--json] [--verbose] <workflow> <instance-id>
  everyapp workflow get --help

Show an instance's status, params, steps, output and error

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  workflow     The Workflow's binding in everyapp.config.ts, its class or its name
  instance-id  The instance id
```

### `everyapp workflow start`

Start an instance of a Workflow.

| Argument | Required | What it is |
| --- | --- | --- |
| `<workflow>` | yes | The Workflow's binding in everyapp.config.ts, its class or its name |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |
| `--params` | `<json>` | no |  | The instance's params, as a JSON object |
| `--instance-id` | `<id>` | no |  | The instance id (default: one Cloudflare picks) |

```text
USAGE
  everyapp workflow start [--gateway value] [--account-id value] [--json] [--verbose] [--params json] [--instance-id id] <workflow>
  everyapp workflow start --help

Start an instance of a Workflow

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
     [--params]                The instance's params, as a JSON object
     [--instance-id]           The instance id (default: one Cloudflare picks)
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  workflow  The Workflow's binding in everyapp.config.ts, its class or its name
```

### `everyapp workflow pause`

Pause an instance.

| Argument | Required | What it is |
| --- | --- | --- |
| `<workflow>` | yes | The Workflow's binding in everyapp.config.ts, its class or its name |
| `<instance-id>` | yes | The instance id |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workflow pause [--gateway value] [--account-id value] [--json] [--verbose] <workflow> <instance-id>
  everyapp workflow pause --help

Pause an instance

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  workflow     The Workflow's binding in everyapp.config.ts, its class or its name
  instance-id  The instance id
```

### `everyapp workflow resume`

Resume a paused instance.

| Argument | Required | What it is |
| --- | --- | --- |
| `<workflow>` | yes | The Workflow's binding in everyapp.config.ts, its class or its name |
| `<instance-id>` | yes | The instance id |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workflow resume [--gateway value] [--account-id value] [--json] [--verbose] <workflow> <instance-id>
  everyapp workflow resume --help

Resume a paused instance

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  workflow     The Workflow's binding in everyapp.config.ts, its class or its name
  instance-id  The instance id
```

### `everyapp workflow restart`

Run an instance again from the start.

| Argument | Required | What it is |
| --- | --- | --- |
| `<workflow>` | yes | The Workflow's binding in everyapp.config.ts, its class or its name |
| `<instance-id>` | yes | The instance id |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workflow restart [--gateway value] [--account-id value] [--json] [--verbose] <workflow> <instance-id>
  everyapp workflow restart --help

Run an instance again from the start

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  workflow     The Workflow's binding in everyapp.config.ts, its class or its name
  instance-id  The instance id
```

### `everyapp workflow terminate`

Stop an instance for good (asks first).

| Argument | Required | What it is |
| --- | --- | --- |
| `<workflow>` | yes | The Workflow's binding in everyapp.config.ts, its class or its name |
| `<instance-id>` | yes | The instance id |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |
| `--yes` | switch | no |  | Don't ask for confirmation |

```text
USAGE
  everyapp workflow terminate [--gateway value] [--account-id value] [--json] [--verbose] [--yes] <workflow> <instance-id>
  everyapp workflow terminate --help

Stop an instance for good (asks first)

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -y [--yes/--no-yes]          Don't ask for confirmation
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  workflow     The Workflow's binding in everyapp.config.ts, its class or its name
  instance-id  The instance id
```

### `everyapp completion install` (hidden)

Installs bash autocomplete support for everyapp.

No flags of its own.

```text

```

### `everyapp completion uninstall` (hidden)

Uninstalls bash autocomplete support for everyapp.

No flags of its own.

```text

```
