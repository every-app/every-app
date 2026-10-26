---
title: "CLI reference"
description: "Every everyapp command with its arguments, flags, defaults and help text, generated from the CLI itself. Exit codes and the global flags are here too."
---

<!-- Generated from packages/cli/src/app.ts and the command definitions by packages/cli/src/docs/cliReference.ts; the test in packages/cli/src/docs/agentDocs.test.ts fails when this page is stale. Regenerate with `pnpm -C packages/cli docs:update`. -->

The command is `everyapp`, run as `pnpm everyapp` from the EveryApp checkout (publishing to npm is paused; never `npx everyapp`). Every command takes `--help`; an agent adds `--json` and reads the event stream described on [/docs/agent/json](/docs/agent/json). What each error code means is on [/docs/agent/errors](/docs/agent/errors).

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
Deploy and run EveryApp apps on your own Cloudflare account.

USAGE
  pnpm everyapp <command> [flags]

BUILD AN APP
  create     Create a new app from the starter template
  dev        Run the app locally behind a dev Gateway
  deploy     Deploy the app in this directory
  release    Pack the app in this directory as a release others can install
  db         Migrate, query and restore an app's D1 database
  skills     Keep the agent skills in an app up to date with the CLI

RUN A GATEWAY
  login      Log in to Cloudflare
  setup      Install or repair the Gateway
  update     Update the Gateway to a newer release
  install    Install an app someone published, from GitHub or a release file
  configure  Set up an app: asks for each setting it needs, required ones first, then the optional ones
  status     Show the Gateway, its apps and anything to fix
  delete     Remove an app from the Gateway
  access     Put Cloudflare Access in front of the Gateway and its apps, or take it off
  signin     Let people sign in with Google, Microsoft, GitHub, Apple, Cloudflare or your SSO, beside passwords
  secret     Set, remove and list secrets and Gateway settings
  provider   Register API providers for apps to call with the Gateway's key, and OAuth providers people connect their accounts to
  ai         The default model provider apps get when they ask for one, and AI Gateway in front
  mcp        Offer MCP servers to members' AI clients as MCP apps, with the Gateway holding each one's key
  email      Manage the addresses an app sends as and receives at
  events     Send the Gateway's events to Slack, Zapier, n8n or your own endpoint (signed), or by email
  teardown   Delete everything EveryApp created in a dedicated test Cloudflare account

MANAGE THE WORKSPACE
  workspace  Manage the workspace from the terminal: members, invitations, groups, app access, caps, usage, activity, the audit log, tokens and AI connections

FLAGS
  -h, --help      Show help for everyapp or a command
  -v, --version   Show everyapp's version
      --no-color  Print without colors (also NO_COLOR=1)

EXAMPLES
  $ pnpm everyapp setup --domain apps.example.com
  $ pnpm everyapp create todo
  $ pnpm everyapp deploy
  $ pnpm everyapp install https://github.com/<owner>/<repo>
  $ pnpm everyapp configure crm

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

### `everyapp provider`

```text
Register API providers for apps to call with the Gateway's key, and OAuth providers people connect their accounts to.

USAGE
  pnpm everyapp provider <command> [flags]

COMMANDS
  add          Add a provider and set its key or OAuth client in one step, so apps can list it
  list         List the API providers the Gateway offers: built in and registered, each key's state, the apps using each
  show         Print a provider's spec: its hosts, how its key is sent, its settings, who registered it and which apps use it
  remove       Remove a registered provider from the Gateway; its key stays set until secret unset
  presets      List the OAuth presets provider add --oauth takes: GitHub, Notion, Linear and more, and the built-in clients
  connections  List the accounts people (and the organization) connected to OAuth providers on the Gateway
  disconnect   Remove a person's or the organization's connection to an OAuth provider from the Gateway

EXAMPLES
  $ pnpm everyapp provider list
  $ pnpm everyapp provider add openrouter
  $ pnpm everyapp provider add google-workspace
  $ pnpm everyapp provider add stripe.json
  $ pnpm everyapp provider connections

Run pnpm everyapp provider <command> --help for its flags.
```

### `everyapp mcp`

```text
Offer MCP servers to members' AI clients as MCP apps, with the Gateway holding each one's key.

USAGE
  pnpm everyapp mcp <command> [flags]

COMMANDS
  add      Add any remote MCP server as an MCP app: its tools reach members' AI clients through the Gateway's /mcp
  remove   Remove an MCP app: it leaves /mcp and the home page, and everyone's access to it goes
  on       Turn an MCP app on: its tools reach members' AI clients through the Gateway's /mcp
  off      Turn an MCP app off: its tools leave /mcp, and everyone's access is kept for on
  list     List the MCP apps: built-in and added, on or off, their tools and whether each key is set
  show     Show an MCP app: its address, credential, status, last tool listing and every tool with its risk
  refresh  Drop an MCP app's tools snapshot, so the Gateway lists its tools again
  tool     Override one tool of a remote MCP app: its risk, or whether it is listed at all

EXAMPLES
  $ pnpm everyapp mcp list
  $ pnpm everyapp mcp on dataforseo
  $ pnpm everyapp mcp add https://treg.to/mcp/ --auth bearer
  $ pnpm everyapp mcp show treg
  $ pnpm everyapp mcp off treg

Run pnpm everyapp mcp <command> --help for its flags.
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

### `everyapp workspace`

```text
Manage the workspace from the terminal: members, invitations, groups, app access, caps, usage, activity, the audit log, tokens and AI connections.

Everything Admin → Users, Groups, Apps, Tokens, Usage and Activity do, from the terminal.
Acts under your Cloudflare login (the operator is root in every organization of the Gateway),
on the install organization unless --org names another by slug, id or name (a name two
organizations share is refused: give the slug). The Gateway mails nothing from here: invite
and reset-link print the link to hand over.
Depth-two groups have their own help: pnpm everyapp workspace group --help, app, token, connection.

USAGE
  pnpm everyapp workspace <command> [flags]

COMMANDS
  show         The organization: its owners, whether it can send mail, and how many members, invitations, groups and apps it has
  rename       Rename the workspace: the name members see in the organization switcher and in invitations
  users        The members with their role and state, then the pending invitations
  role         Set a member's role: owner, admin or member
  invite       Invite someone by email and print the link to send them (the Gateway mails nothing from here)
  invite-link  Print a new link for a pending invitation (earlier links keep working until it is used)
  uninvite     Cancel a pending invitation: its links stop working
  deactivate   Lock a member out everywhere: no sign-in, every session ended, their tokens and AI connections revoked
  reactivate   Lift a deactivation: they can sign in again (revoked tokens and connections stay revoked)
  remove       Remove a member from the organization, and their account when it belongs to no other
  reset-link   Print a one-hour, single-use password-reset link to hand to a member
  groups       The groups, with how many members and apps each has
  group        Make, change or delete a group, and set its members and apps
  apps         Every app with who can open it, whether everyone can, its state and what it still needs set
  app          Change an app's listing, who can open it, and its monthly cap
  cap          The workspace default cap on every app's provider calls
  usage        What the apps spent in a month: per app (with the cap that binds it), per member and per provider
  activity     The tool-call audit trail, newest first: who called which tool on which app, and what came of it
  audit        The audit log, newest first: every event the Gateway recorded (members, apps, caps, connections, tokens, Access, MCP apps, providers, apps' own events), who did it and what it was about
  tokens       Every member's personal access tokens for the organization (never a token's value)
  token        Revoke a personal access token
  connections  Every member's AI connections to the organization: which AI app, which apps it may use, read or write
  connection   Revoke an AI connection

EXAMPLES
  $ pnpm everyapp workspace rename 'Acme Corp'
  $ pnpm everyapp workspace users
  $ pnpm everyapp workspace role sam@example.com owner
  $ pnpm everyapp workspace role sam@example.com member
  $ pnpm everyapp workspace invite ann@example.com --role admin
  $ pnpm everyapp workspace app access crm --add ann@example.com
  $ pnpm everyapp workspace group members Sales --set ann@example.com --set bob@example.com
  $ pnpm everyapp workspace usage --month 2026-10 --json

Run pnpm everyapp workspace <command> --help for its flags.
```

## Commands

### `everyapp create`

Create a new app from the starter template.

| Argument | Required | What it is |
| --- | --- | --- |
| `<name or path>` | no | An app name (lowercase letters, digits and dashes, e.g. my-app; asked for when missing), or the path of the folder to make, named after its last part (../my-app) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--yes` | switch | no |  | Don't ask anything (a name is then required) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Stream install and git output to stderr |

```text
USAGE
  pnpm everyapp create [--yes] [--json] [--verbose] [<name or path>]
  pnpm everyapp create --help

A path (../my-app, ~/apps/my-app) makes the app there, named after its last part:
outside your EveryApp checkout it is its own git repository, linked to the checkout (from an
everyapp installed with npm, pinned to the published packages at this version);
inside it only apps/<name> is allowed. A bare name goes in apps/<name> when run from
the checkout, in ./<name> anywhere else. Dependencies are installed and the local
database is ready, so `pnpm dev` works straight away. Then: cd into it and
`pnpm run deploy`.

Examples:
  pnpm everyapp create ../my-app    beside the checkout, its own repository
  pnpm everyapp create analytics    apps/analytics, from the checkout

FLAGS
  -y [--yes/--no-yes]          Don't ask anything (a name is then required)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Stream install and git output to stderr
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [name or path]  An app name (lowercase letters, digits and dashes, e.g. my-app; asked for when missing), or the path of the folder to make, named after its last part (../my-app)
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
(browser). Requests straight to the app's internal port get 401 unless they
carry an identity token in x-everyapp-identity: `pnpm everyapp dev token` prints one.

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

COMMANDS
  token  Print a dev identity token for scripts that call the app's dev port

Run pnpm everyapp dev <command> --help for its flags.
```

### `everyapp dev token`

Print a dev identity token for scripts that call the app's dev port.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--role` | `owner`, `admin`, `member` | no | `owner` | The organization role the token carries |
| `--user` | `<email>` | no |  | Who the token speaks for (default: the dev user for owner, <role>@everyapp.localhost otherwise) |
| `--org` | `<id>` | no |  | The organization id (default dev-org, the dev user's) |
| `--app` | `<id>` | no |  | The app id the token is for (default: everyapp.config.ts's id in this directory) |
| `--ttl` | `<duration>` | no |  | How long it lasts: seconds, or 90s, 15m, 1h (default 1h, at most 24h) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |

```text
USAGE
  pnpm everyapp dev token [--role owner|admin|member] [--user email] [--org id] [--app id] [--ttl duration] [--json]
  pnpm everyapp dev token --help

Prints an identity token the app accepts while it runs under `pnpm everyapp dev`, for
scripts and curl that call the app's internal dev port directly as someone other
than the gateway-lite's seeded user: a member, an admin, another organization.
Send it as the x-everyapp-identity header. The gateway-lite itself replaces that
header with its own, so use the internal port the ready block prints (App port).

The token is minted as the gateway-lite mints its own: the SDK's well-known dev
key and kid, the dev issuer https://gateway.dev.localhost, aud = the app id, a
full session (channel web, scopes *). Only a development build of the app
(EVERYAPP_DEV, set by everyAppWorker() under dev) accepts it; a deployed app
refuses it whatever it says.

Without --user, owner is the dev user (dev@everyapp.localhost, sub dev-user);
admin and member are people of their own (<role>@everyapp.localhost, sub
dev-<role>). With --user, the sub is dev-<email>. Agent tools are reached through
<app-id>.localhost:8787/mcp, not with this token.

Prints the token alone; --json prints a done event whose data has token,
expiresAt, header, appId and user.

Examples:
  curl -H "x-everyapp-identity: $(pnpm everyapp dev token --role member)" http://127.0.0.1:<app port>/api/me
  pnpm everyapp dev token --user ana@example.com --role admin --ttl 15m
  pnpm everyapp dev token --app my-app --org other-org --json

FLAGS
     [--role]            The organization role the token carries                                                                                    [owner|admin|member, default = owner]
     [--user]            Who the token speaks for (default: the dev user for owner, <role>@everyapp.localhost otherwise)
     [--org]             The organization id (default dev-org, the dev user's)
     [--app]             The app id the token is for (default: everyapp.config.ts's id in this directory)
     [--ttl]             How long it lasts: seconds, or 90s, 15m, 1h (default 1h, at most 24h)
     [--json/--no-json]  Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
  -h  --help             Print help information and exit
      --                 All subsequent inputs should be interpreted as arguments
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
| `--no-wait` | switch | no |  | Don't wait for the app to go live (a new hostname's certificate included); the Gateway makes it live within a minute, or on its first visit |
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

No Gateway in any account the login sees, and none named? At a terminal it offers to install one at
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
     [--no-wait/--no-no-wait]                                                    Don't wait for the app to go live (a new hostname's certificate included); the Gateway makes it live within a minute, or on its first visit
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
| `--json` | switch | no |  | Print one NDJSON done event, its rows in data.results, instead of a table |
| `--verbose` | switch | no |  | Show every step |

```text
USAGE
  pnpm everyapp db query [--local] [--file path] [--binding name] [--gateway value] [--account-id value] [--yes] [--json] [--verbose] [<sql>]
  pnpm everyapp db query --help

Run SQL against the app's D1 database

Runs against the production database unless --local is set; SQL that changes it is
confirmed first (--yes skips that). Rows print as a table; with --json they are in the
done event's data.results.

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
     [--json/--no-json]        Print one NDJSON done event, its rows in data.results, instead of a table
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

### `everyapp skills update`

Replace this app's copies of the skills with the ones this CLI ships.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |

```text
USAGE
  pnpm everyapp skills update [--json]
  pnpm everyapp skills update --help

Replace the app's copies of the skills with the ones this CLI ships

Run in the app's directory (the one with everyapp.config.ts). Each skill the CLI ships
(everyapp, build-every-app) is copied to .claude/skills/<name> and .agents/skills/<name>,
as create does: a copy that differs is replaced whole, so files no longer shipped go too,
and a missing skill is added. Other directories under those folders are left alone.
AGENTS.md gets a line for any skill it doesn't mention. Prints what was added, updated
or left unchanged; with --json, done carries each copy's files added, updated and removed.

EXAMPLES
  $ pnpm everyapp skills update
  $ pnpm everyapp skills update --json

FLAGS
     [--json/--no-json]  Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
  -h  --help             Print help information and exit
      --                 All subsequent inputs should be interpreted as arguments
```

### `everyapp teardown`

Delete everything EveryApp created in a dedicated test Cloudflare account.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--account-id` | `<id>` | yes |  | The dedicated test account to empty (required; 32 hex characters, from the dashboard URL dash.cloudflare.com/<id>/…; never read from CLOUDFLARE_ACCOUNT_ID) |
| `--confirm` | `<id>` | no |  | The same account id again, for a run without a terminal (--json, a script); at a terminal it is typed instead |
| `--dry-run` | switch | no |  | List what would be deleted and stop; nothing is written |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp teardown (--account-id id) [--confirm id] [--dry-run] [--json] [--verbose]
  pnpm everyapp teardown --help

For the accounts the onboarding loop installs into, over and over: removes every Worker,
Workflow, D1 database, KV namespace, R2 bucket, Hyperdrive config, queue, Vectorize index,
AI Gateway and Secrets Store secret named every-*, the Gateway's own included, the two
Cloudflare Access applications and the allow policy, the Email Routing rules that send mail
to those Workers (a catch-all drops mail again, and routing is turned off once no rule and no
catch-all of anyone else's needs it), the certificate packs of the hostnames the Gateway
published, and the Custom Domain records (A, AAAA, CNAME) left at exactly those names. Never
the zone, the Workers Paid subscription, the workers.dev subdomain, the Zero Trust team and
its identity providers, a Secrets Store itself, any other DNS record (MX, TXT, CAA...) even
at those names, R2 buckets outside the default jurisdiction, or anything whose name doesn't
start with every- and that no app recorded.

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
      --account-id             The dedicated test account to empty (required; 32 hex characters, from the dashboard URL dash.cloudflare.com/<id>/…; never read from CLOUDFLARE_ACCOUNT_ID)
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
| `--release` | `<value>` | no |  | The Gateway release to deploy: a GitHub repository URL (its latest release) or release page, a release tarball's URL, or a downloaded every-app-gateway-release.tar.gz (default: this checkout's build, or without a checkout, the published release for this everyapp version) |
| `--force-dns` | switch | no |  | Publish new hostnames even where a DNS record answers them (one at a hostname is replaced) |
| `--allow-downgrade` (hidden) | switch | no |  | Deploy this Gateway even though it is older than the live one (a deliberate rollback) |
| `--redeploy` (hidden) | switch | no |  | Upload the Gateway even when it is up to date (after a change in the dashboard, such as a key rotation) |
| `--no-access` | switch | no |  | Leave Cloudflare Access off: by default setup puts it in front of the Gateway once the owner exists (asked at a terminal; unattended when the account can). everyapp access off takes it off later |
| `--yes` | switch | no |  | Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, and stream the Gateway's build output to stderr |

```text
USAGE
  pnpm everyapp setup [--domain value] [--account-id value] [--release value] [--force-dns] [--no-access] [--yes] [--json] [--verbose]
  pnpm everyapp setup --help

One command from an empty Cloudflare account (Workers Paid) to a working Gateway and its
owner, and the one to run when something is off. Run it again any time: it picks up where it
stopped, and does nothing once everything is there. pnpm everyapp update takes a newer Gateway
later (setup does that too, on its way).

A fresh install takes 5 to 20 minutes, most of it waiting for you at the owner link: give it a
long timeout, or run it in the background and watch its output.

  1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and finds the Gateway in
     the login's accounts; with none, picks the account to install it in
  2. Picks where the Gateway lives (--domain, or asked): any hostname under one of the
     account's domains, apps.example.com; apps get one each below it, todo.apps.example.com
  3. Installs the Gateway, or repairs it, and waits for its certificate. Where the Gateway
     comes from: --release (a GitHub repository or release URL, a tarball's URL, or a
     downloaded every-app-gateway-release.tar.gz); otherwise this checkout's build when
     everyapp runs from one; otherwise the published release for this everyapp version
     (https://github.com/every-app/every-app, gateway-v<version>)
  4. Opens a one-time link to create the owner account and waits up to 15 minutes for it;
     in CI there is no link, and the run ends with a warning to run setup at a terminal
  5. Puts Cloudflare Access in front of the Gateway (asked at a terminal, Yes by default;
     with --yes or --json, done when the account can, else a warning names access on);
     --no-access leaves it off

The flags people use: --domain, --account-id, and --yes for a script (it answers setup's own
questions; never cf's). With --json each step is an NDJSON event; a run that stops on
something only a person can do exits 2 with action_required.
Then: pnpm everyapp create ../my-app, cd into it, pnpm everyapp dev, pnpm everyapp deploy.
More: https://everyapp.com/docs/gateway

FLAGS
     [--domain]                    Where the Gateway lives: any hostname under one of the account's domains, e.g. apps.example.com (asked at a terminal; remembered after that)
     [--account-id]                The Cloudflare account of the Gateway, or with none yet, the one to install it in (default: CLOUDFLARE_ACCOUNT_ID, or the only one)
     [--release]                   The Gateway release to deploy: a GitHub repository URL (its latest release) or release page, a release tarball's URL, or a downloaded every-app-gateway-release.tar.gz (default: this checkout's build, or without a checkout, the published release for this everyapp version)
     [--force-dns/--no-force-dns]  Publish new hostnames even where a DNS record answers them (one at a hostname is replaced)
     [--no-access/--no-no-access]  Leave Cloudflare Access off: by default setup puts it in front of the Gateway once the owner exists (asked at a terminal; unattended when the account can). everyapp access off takes it off later
  -y [--yes/--no-yes]              Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp)
     [--json/--no-json]            Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]      Show every step and progress line, and stream the Gateway's build output to stderr
  -h  --help                       Print help information and exit
      --                           All subsequent inputs should be interpreted as arguments
```

### `everyapp update`

Update the Gateway to a newer release.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--release` | `<value>` | no |  | The Gateway release to deploy: a GitHub repository URL (its latest release) or release page, a release tarball's URL, or a downloaded every-app-gateway-release.tar.gz (default: this checkout's build, or without a checkout, the published release for this everyapp version) |
| `--force-dns` | switch | no |  | Publish new hostnames even where a DNS record answers them (one at a hostname is replaced) |
| `--allow-downgrade` (hidden) | switch | no |  | Deploy this Gateway even though it is older than the live one (a deliberate rollback) |
| `--redeploy` (hidden) | switch | no |  | Upload the Gateway even when it is up to date (after a change in the dashboard, such as a key rotation) |
| `--yes` | switch | no |  | Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp update [--account-id value] [--release value] [--force-dns] [--yes] [--json] [--verbose]
  pnpm everyapp update --help

Deploys a newer Gateway over the one your Cloudflare login finds, where it is, keeping its
data, users and apps. It never installs a Gateway: with none, it stops and says to run
pnpm everyapp setup. The Gateway comes from --release (a GitHub repository or release URL, a
tarball's URL, or a downloaded every-app-gateway-release.tar.gz); otherwise this checkout's
build when everyapp runs from one; otherwise the published release for this everyapp
version (https://github.com/every-app/every-app, gateway-v<version>).

  1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and finds the Gateway in
     the login's accounts (--account-id when there is one in more than one)
  2. Upgrades it (migrations first, with a restore point). When it runs that Gateway
     already, binds and publishes every registered app if the live Gateway doesn't, and
     otherwise says it is up to date. A live Gateway newer than this one is refused (in a
     checkout: git pull)

A checkout's Gateway is named by its version when it is that version's release (the
gateway-v<version> tag), and by the checkout's commit otherwise.
With --json, each step is an NDJSON event.

FLAGS
     [--account-id]                The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--release]                   The Gateway release to deploy: a GitHub repository URL (its latest release) or release page, a release tarball's URL, or a downloaded every-app-gateway-release.tar.gz (default: this checkout's build, or without a checkout, the published release for this everyapp version)
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
| `--no-wait` | switch | no |  | Don't wait for the app to go live (a new hostname's certificate included); the Gateway makes it live within a minute, or on its first visit |
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
again later to update the app. Its settings are set with pnpm everyapp configure <id>;
.everyapp/secrets.env in this directory is the deploy's own file, read only for a Hyperdrive
app's database URL.

A repository without a release is never built from its URL: clone it, then run pnpm
install in it and this checkout's pnpm everyapp deploy from its directory. Postgres migrations
need the app's source, so their releases are refused.

No Gateway in any account the login sees, and none named? At a terminal it offers to install one at
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
     [--no-wait/--no-no-wait]                                                    Don't wait for the app to go live (a new hostname's certificate included); the Gateway makes it live within a minute, or on its first visit
  -y [--yes/--no-yes]                                                            With no Gateway yet, install one at apps.<zone> without asking (never cf's questions, or the one before replacing a Worker changed outside everyapp)
     [--json/--no-json]                                                          Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]                                                    Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                                                                     Print help information and exit
      --                                                                         All subsequent inputs should be interpreted as arguments

ARGUMENTS
  source  The app release to install: a GitHub repository URL (its latest release), a release tarball's URL, or a downloaded everyapp-release.tar.gz
```

### `everyapp configure`

Set up an app: asks for each setting it needs, required ones first, then the optional ones.

| Argument | Required | What it is |
| --- | --- | --- |
| `<app>` | no | The app to configure (default: the app in this directory) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--from-env` | switch | no |  | Take each unset setting's value, optional ones too, from the environment variable of its name (DATAFORSEO_API_KEY from $DATAFORSEO_API_KEY); a set name is never replaced; stdin isn't read; the rest are asked for at a terminal |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp configure [--from-env] [--gateway value] [--account-id value] [--json] [--verbose] [<app>]
  pnpm everyapp configure --help

Reads what the app's everyapp.config.ts declares (AI providers, capabilities, its own
secrets) and what is set, then asks for each required setting that isn't (hidden input,
with where to get it beside each), offers the optional ones (Enter skips them all), and
says whether the app is ready. One member of an any-of group is enough: it asks which.
Run it again any time: it shows what is set (names only, never values) and lets you
change one.

Where they go: an AI provider's key or a capability's client is a Gateway setting, held
once for every app on the Gateway Worker; the app's own secrets go on its Worker, after
its first deploy. Changes are live at once; no deploy needed.

For a script or a coding agent, which can't answer a prompt: pipe NAME=value lines in
(one per line; # starts a comment only at the start of a line; a value is taken as it is,
one pair of quotes around it dropped), or export the variables under the settings' own
names and add --from-env (then stdin isn't read). A value never goes on the command line.

Examples:
  pnpm everyapp configure crm
  pnpm everyapp configure                       (in the app's directory)
  pnpm everyapp configure crm --from-env --json
  printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY" | pnpm everyapp configure crm --json

One setting at a time, by name: pnpm everyapp secret set <NAME> [--app <id>]

FLAGS
     [--from-env/--no-from-env]  Take each unset setting's value, optional ones too, from the environment variable of its name (DATAFORSEO_API_KEY from $DATAFORSEO_API_KEY); a set name is never replaced; stdin isn't read; the rest are asked for at a terminal
     [--gateway]                 The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]              The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]          Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]    Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                     Print help information and exit
      --                         All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [app]  The app to configure (default: the app in this directory)
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

Deletes the app in the Gateway's D1 database (its name stays reserved; deploy it again to
bring it back) and removes its Gateway binding and hostname, with a redeploy of the Gateway
from this checkout.
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
two Access applications (one that also covers something else only loses EveryApp's hosts).
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

### `everyapp signin add`

Turn a sign-in provider on: "Continue with Google" (or Microsoft, GitHub, Apple, Cloudflare, your SSO).

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The sign-in provider: google, microsoft, github, apple, cloudflare, oidc |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--client-id` | `<value>` | no |  | The OAuth app's client id (not a secret; for apple, the Services ID) |
| `--client-secret-from-env` | `<VAR>` | no |  | Read the client secret from this environment variable (a secret never goes on the command line) |
| `--issuer` | `<url>` | no |  | oidc: the issuer's https URL, which serves /.well-known/openid-configuration |
| `--label` | `<text>` | no |  | oidc: the button text after "Continue with" (default SSO; 40 characters at most) |
| `--tenant` | `<value>` | no |  | microsoft: the Directory (tenant) ID that pins sign-in to your own directory (recommended), or common, organizations, consumers |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp signin add [--client-id value] [--client-secret-from-env VAR] [--issuer url] [--label text] [--tenant value] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp signin add --help

Says where to create the OAuth app and the redirect URL to register with it
(https://<gateway>/api/auth/callback/<id>), then sets the provider's settings on the
Gateway Worker, all in one new version under your Cloudflare login, live on the next
request. At a terminal it asks for each setting: the client id shown as typed, the
client secret hidden, an optional one (microsoft's tenant, oidc's label) left as it is
when you press Enter. Unattended (--json, or no terminal) every required setting comes
from a flag: --client-id, --client-secret-from-env VAR, and for oidc --issuer. The
client secret is never taken from the command line.

A provider says who someone is; the Gateway still decides who gets in: a member, or
someone with a pending invitation for that exact, verified email. Nobody else.

Safe to repeat: running it again replaces the values given (a rotated secret, a new
client). An optional setting not given stays as it is; pnpm everyapp secret unset <NAME>
removes one. The everyapp skill's setup/signin-<id>.md walks through each provider's
console.

Examples:
  pnpm everyapp signin add google
  pnpm everyapp signin add github --client-id Iv1.0123456789abcdef --client-secret-from-env GITHUB_SECRET --json
  pnpm everyapp signin add microsoft --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47
  pnpm everyapp signin add oidc --issuer https://acme.okta.com --label Okta

FLAGS
     [--client-id]               The OAuth app's client id (not a secret; for apple, the Services ID)
     [--client-secret-from-env]  Read the client secret from this environment variable (a secret never goes on the command line)
     [--issuer]                  oidc: the issuer's https URL, which serves /.well-known/openid-configuration
     [--label]                   oidc: the button text after "Continue with" (default SSO; 40 characters at most)
     [--tenant]                  microsoft: the Directory (tenant) ID that pins sign-in to your own directory (recommended), or common, organizations, consumers
     [--gateway]                 The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]              The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]          Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]    Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                     Print help information and exit
      --                         All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The sign-in provider: google, microsoft, github, apple, cloudflare, oidc
```

### `everyapp signin list`

List the sign-in providers: on, needs setup (naming what is missing) or off.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp signin list [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp signin list --help

Reads which of each provider's settings the Gateway Worker holds (names only: a value
can't be read back) and says whether the provider is on (every required setting set),
needs setup (some set, the rest named; the Gateway keeps it off rather than half
configured) or off. A value that is set but malformed also keeps a provider off; the
Gateway's log says so (signin.config_problem). Nothing is changed.

Example:
  pnpm everyapp signin list

ALIASES
  pnpm everyapp signin ls

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp signin show`

Show a sign-in provider: where to make its OAuth app, the redirect URL, its settings and whether each is set.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The sign-in provider: google, microsoft, github, apple, cloudflare, oidc |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp signin show [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp signin show --help

The provider's console and what the OAuth app is called there, the redirect URL to
register for this Gateway, the scopes asked for (identity only), which claim becomes
the email and when it counts as verified, every setting with what it holds and whether
it is set, the provider's caveats and its setup guide. Nothing is changed.

Example:
  pnpm everyapp signin show apple

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The sign-in provider: google, microsoft, github, apple, cloudflare, oidc
```

### `everyapp signin remove`

Turn a sign-in provider off: its settings leave the Gateway; accounts stay.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The sign-in provider: google, microsoft, github, apple, cloudflare, oidc |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--yes` | switch | no |  | Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp signin remove [--yes] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp signin remove --help

Asks first (--yes doesn't), then removes every setting of the provider from the Gateway
Worker in one new version: the button leaves the sign-in page on the next request.
People who signed in with it keep their accounts and sign in another way (a password
via Forgot password, another provider, Access). Delete the OAuth app at the provider
too: a client the Gateway no longer holds is still a client.

Example:
  pnpm everyapp signin remove github

FLAGS
     [--yes/--no-yes]          Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The sign-in provider: google, microsoft, github, apple, cloudflare, oidc
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
command that opens the app when something required is missing (pnpm everyapp configure <app>).
Elsewhere with no app named: the Gateway's names and who set them, then every app's
settings. Names only, never values.

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

### `everyapp provider add`

Add a provider and set its key or OAuth client in one step, so apps can list it.

| Argument | Required | What it is |
| --- | --- | --- |
| `<provider>` | no | A built-in provider's id (openrouter, google-workspace, github-oauth), or a spec: a JSON file or an https URL to one (64 KiB at most) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--replace` | switch | no |  | Replace the provider registered under the spec's id; its key must be set again |
| `--oauth` | `<preset>` | no |  | An OAuth provider: a preset (provider presets names them: github-oauth), a built-in client (google-workspace), or a JSON spec file with auth.kind oauth2-user |
| `--client-id` | `<id>` | no |  | An OAuth provider's client id (public); the secret comes from the prompt, piped NAME=value lines or --from-env |
| `--from-env` | switch | no |  | Set the key or client from the environment variables of its setting names (OPENROUTER_API_KEY; GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET); nothing is asked |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp provider add [--replace] [--oauth preset] [--client-id id] [--from-env] [--gateway value] [--account-id value] [--json] [--verbose] [<provider>]
  pnpm everyapp provider add --help

Says the one thing to do at the provider (create a key, or register the redirect URI and
make an OAuth client), links its page on everyapp.com, then asks for the key or client at
hidden prompts and sets it on the Gateway as secret set would. Live at once; no deploy.

Nobody at a terminal (--json, piped, CI), or Enter on nothing: nothing is set, and it prints
the one command to run next:
  pnpm everyapp secret set OPENROUTER_API_KEY
Scripts and agents set it in the same run with --from-env (the variables of the settings'
names) or piped NAME=value lines; never on the command line.

A built-in provider (provider list names them) is only its key; an OAuth client
(google-workspace, slack, microsoft-365, discord) its client. An OAuth preset (provider
presets: github-oauth) becomes a registered provider. Any other API is a spec: its id, name,
the page the key comes from (docs), the only hosts the key is ever sent to and how (auth:
bearer, header, query or basic), naming the Gateway setting that holds the key. The spec
never holds the key. A URL is fetched on this machine. The rules a spec must pass: an id
that isn't a built-in provider's, settings named after the id that nothing else reads, and
public hosts that aren't the Gateway's own or its apps'. Run in an app's directory, it also
writes .everyapp/providers/<id>.json for everyapp dev (your key goes in .dev.vars).

--oauth takes an OAuth spec file (auth.kind oauth2-user), or a preset or built-in client by
name. --verbose adds an OAuth provider's scope sets and the manifest entry.

Examples:
  pnpm everyapp provider add google-workspace
  pnpm everyapp provider add openrouter
  OPENROUTER_API_KEY=sk-or-... pnpm everyapp provider add openrouter --from-env
  pnpm everyapp provider add github-oauth
  printf 'GITHUB_OAUTH_CLIENT_SECRET=%s\n' "$SECRET" | pnpm everyapp provider add github-oauth --client-id Iv1.abc
  pnpm everyapp provider add stripe.json
  pnpm everyapp provider add https://example.com/providers/stripe.json --replace
  pnpm everyapp provider add --oauth ./acme.json --from-env

FLAGS
     [--replace/--no-replace]    Replace the provider registered under the spec's id; its key must be set again
     [--oauth]                   An OAuth provider: a preset (provider presets names them: github-oauth), a built-in client (google-workspace), or a JSON spec file with auth.kind oauth2-user
     [--client-id]               An OAuth provider's client id (public); the secret comes from the prompt, piped NAME=value lines or --from-env
     [--from-env/--no-from-env]  Set the key or client from the environment variables of its setting names (OPENROUTER_API_KEY; GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET); nothing is asked
     [--gateway]                 The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]              The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]          Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]    Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                     Print help information and exit
      --                         All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [provider]  A built-in provider's id (openrouter, google-workspace, github-oauth), or a spec: a JSON file or an https URL to one (64 KiB at most)
```

### `everyapp provider list`

List the API providers the Gateway offers: built in and registered, each key's state, the apps using each.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp provider list [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp provider list --help

Nothing is changed. A key's value can't be read back; only whether it is set, and for a
registered provider whether it was set for the hosts the row names now (bound).

Example:
  pnpm everyapp provider list

ALIASES
  pnpm everyapp provider ls

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp provider show`

Print a provider's spec: its hosts, how its key is sent, its settings, who registered it and which apps use it.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The provider's id (provider list names them): stripe |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--save` | switch | no |  | Also write the spec to .everyapp/providers/<id>.json in this app's directory, for everyapp dev |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp provider show [--save] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp provider show --help

What an agent reads to set up and call a provider without a setup guide. With --save, in an
app's directory, the spec is written where everyapp dev reads it.

Examples:
  pnpm everyapp provider show stripe
  pnpm everyapp provider show stripe --save

FLAGS
     [--save/--no-save]        Also write the spec to .everyapp/providers/<id>.json in this app's directory, for everyapp dev
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The provider's id (provider list names them): stripe
```

### `everyapp provider remove`

Remove a registered provider from the Gateway; its key stays set until secret unset.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The provider's id (provider list names them): stripe |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--force` | switch | no |  | Remove it even though deployed apps list it (their calls to it stop) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp provider remove [--force] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp provider remove --help

The Gateway stops serving it within 30 seconds. A provider a deployed app lists under
capabilities is refused unless --force. The Gateway setting holding its key stays; remove
it with pnpm everyapp secret unset <NAME>. Registering it again needs the key set again too.

Example:
  pnpm everyapp provider remove stripe

ALIASES
  pnpm everyapp provider rm

FLAGS
     [--force/--no-force]      Remove it even though deployed apps list it (their calls to it stop)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The provider's id (provider list names them): stripe
```

### `everyapp provider presets`

List the OAuth presets provider add --oauth takes: GitHub, Notion, Linear and more, and the built-in clients.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp provider presets [--json] [--verbose]
  pnpm everyapp provider presets --help

Each with its scope sets (what an app lists under scopes) and the console where its client
is made. Nothing is read from the Gateway.

Example:
  pnpm everyapp provider presets

FLAGS
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp provider connections`

List the accounts people (and the organization) connected to OAuth providers on the Gateway.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--all` | switch | no |  | Every organization's connections (default: the Gateway's own organization's) |
| `--user` | `<email>` | no |  | One person's connections |
| `--provider` | `<id>` | no |  | One provider's connections |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp provider connections [--all] [--user email] [--provider id] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp provider connections --help

Who connected what, with the scope sets granted, the status and when it was last used.
Never a token.

Examples:
  pnpm everyapp provider connections
  pnpm everyapp provider connections --provider github-oauth
  pnpm everyapp provider connections --user ben@example.com

FLAGS
     [--all/--no-all]          Every organization's connections (default: the Gateway's own organization's)
     [--user]                  One person's connections
     [--provider]              One provider's connections
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp provider disconnect`

Remove a person's or the organization's connection to an OAuth provider from the Gateway.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The OAuth provider's id: github-oauth |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--user` | `<email>` | no |  | This person's connection |
| `--organization` | switch | no |  | The organization's own connection (the one background work uses) |
| `--all` | switch | no |  | Every connection to the provider |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp provider disconnect [--user email] [--organization] [--all] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp provider disconnect --help

The Gateway drops the tokens it held; apps get "not connected" until the person connects
again at /connect/<id>. The CLI holds no token, so the grant stays at the provider until it
is revoked there (Admin → Providers → Disconnect revokes it from the Gateway).

Examples:
  pnpm everyapp provider disconnect github-oauth --user ben@example.com
  pnpm everyapp provider disconnect github-oauth --organization
  pnpm everyapp provider disconnect github-oauth --all

FLAGS
     [--user]                            This person's connection
     [--organization/--no-organization]  The organization's own connection (the one background work uses)
     [--all/--no-all]                    Every connection to the provider
     [--gateway]                         The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]                      The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]                  Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]            Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                             Print help information and exit
      --                                 All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The OAuth provider's id: github-oauth
```

### `everyapp provider on` (hidden)

Same as pnpm everyapp mcp on; this alias goes after launch week.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The MCP app (mcp list names them): dataforseo |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text

```

### `everyapp provider off` (hidden)

Same as pnpm everyapp mcp off; this alias goes after launch week.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The MCP app (mcp list names them): dataforseo |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text

```

### `everyapp ai show`

What the Gateway's default model provider resolves to now, and why.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp ai show [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp ai show --help

The provider and model an app that asks for the default chat model gets (ai: { chat: true }
in its manifest, the SDK's ai()): the stored choice (ai default) if there is one, else the
first provider of the shipped order whose key is set (OpenRouter, Workers AI, OpenAI, Anthropic,
Groq, Mistral, Gemini), else what to set. Reads the Gateway's setting names, never values.
Says whether calls go through Cloudflare AI Gateway (ai gateway on).

Example:
  pnpm everyapp ai show

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp ai list`

Every provider the default model could be, in order, each with its key set or not.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp ai list [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp ai list --help

The shipped order first, then any other AI provider with an OpenAI-shaped chat route; the
one the default resolves to now is marked. An API provider (Stripe) or one without such a
route (Cohere) isn't here: an app pins those under providers.

Example:
  pnpm everyapp ai list

ALIASES
  pnpm everyapp ai ls

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp ai default`

Choose the default model provider (and model) for every app that asks for one, or off for the shipped order.

| Argument | Required | What it is |
| --- | --- | --- |
| `<provider[/model]\|off>` | yes | The provider's id (openrouter), or the id and a model (openrouter/anthropic/claude-sonnet-5.5), or off |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp ai default [--gateway value] [--account-id value] [--json] [--verbose] <provider[/model]|off>
  pnpm everyapp ai default --help

The same setting as Manage workspace → Usage → AI default. The provider id is everything
up to the first slash, the model everything after it (a model id may hold slashes). Without
a model, the provider's own default model is filled in. A provider whose key isn't set is
accepted with a warning naming the key; one the default can't be (an API provider, an entry
without an OpenAI-shaped chat route, AI Gateway) is refused (AI_DEFAULT_INVALID). The Gateway
reads the change within 30 seconds; a change queues ai.default_changed. Refused on a Gateway
from before the setting (GATEWAY_PREDATES_AI_DEFAULT): run update first.

Examples:
  pnpm everyapp ai default openrouter
  pnpm everyapp ai default openrouter/anthropic/claude-sonnet-5.5
  pnpm everyapp ai default workers-ai --json
  pnpm everyapp ai default off

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  provider[/model]|off  The provider's id (openrouter), or the id and a model (openrouter/anthropic/claude-sonnet-5.5), or off
```

### `everyapp ai gateway on`

Put Cloudflare AI Gateway in front of every model call: find or make the gateway, set AI_GATEWAY_ID.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--id` | `<id>` | no |  | The AI Gateway's id (its name in the dashboard): lowercase letters, digits and single hyphens; everyapp by default |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp ai gateway on [--id id] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp ai gateway on --help

Finds the AI Gateway in the Gateway's Cloudflare account (or makes it, logs on, no cache)
and records its id as the Gateway setting AI_GATEWAY_ID. From the Gateway's next request
every call to a model provider that AI Gateway fronts (OpenRouter, OpenAI, Anthropic, Groq,
Mistral, Workers AI) goes through it with the provider's own key still on the call; Gemini
and Cohere go direct. Changes no app and no key. For an authenticated gateway, set its
token afterwards: pnpm everyapp secret set AI_GATEWAY_API_KEY.

Examples:
  pnpm everyapp ai gateway on
  pnpm everyapp ai gateway on --id acme-models

FLAGS
     [--id]                    The AI Gateway's id (its name in the dashboard): lowercase letters, digits and single hyphens; everyapp by default
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp ai gateway off`

Send model calls direct again: unset AI_GATEWAY_ID (the Cloudflare resource stays).

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp ai gateway off [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp ai gateway off --help

Unsets AI_GATEWAY_ID on the Gateway; every model call goes direct from its next request.
The AI Gateway and its logs stay in the account. AI_GATEWAY_API_KEY stays until pnpm everyapp secret unset.

Example:
  pnpm everyapp ai gateway off

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp mcp add`

Add any remote MCP server as an MCP app: its tools reach members' AI clients through the Gateway's /mcp.

| Argument | Required | What it is |
| --- | --- | --- |
| `<url>` | yes | The server's MCP address (https://, the one URL the Gateway ever sends its credential to) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--name` | `<value>` | no |  | The app's id and tool prefix (default: from the URL's host, https://mcp.treg.to/mcp → treg) |
| `--auth` | `none`, `bearer`, `header`, `basic`, `oauth` | no |  | How the Gateway authenticates to the server (default: none; bearer with --secret, header with --header) |
| `--header` | `<value>` | no |  | With --auth header: the header the server reads the credential from (X-Api-Key) |
| `--secret` | `<value>` | no |  | The Gateway setting holding the credential, ending in _MCP_TOKEN (default: <ID>_MCP_TOKEN) |
| `--risk` | `annotations`, `read`, `write` | no |  | How a tool's risk is decided: from the server's hints, unknown as write (annotations, the default), or every tool read or write |
| `--description` | `<value>` | no |  | What the app is for, as Admin → Apps and everyapp_list_apps say it (default: from the URL) |
| `--from-env` | `<VAR>` | no |  | Set the credential from this environment variable once the app is added (as secret set --from-env) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp mcp add [--name value] [--auth none|bearer|header|basic|oauth] [--header value] [--secret value] [--risk annotations|read|write] [--description value] [--from-env VAR] [--gateway value] [--account-id value] [--json] [--verbose] <url>
  pnpm everyapp mcp add --help

The Gateway serves the server's tools on its own /mcp under <id>_<tool> names, holding the
server's credential itself: every call is attributed to the member, audited, counted and
capped like an app's, and read tools are told apart from write tools (a read-only
connection sees only the read ones). You, the owners and the admins get it at once; an
admin grants others in Admin → Apps → Manage access. Nothing is deployed.

The credential is a Gateway setting named <ID>_MCP_TOKEN (--secret picks another name
ending in _MCP_TOKEN), pinned to the URL's origin when it is set: the Gateway never sends
it anywhere else. At a terminal, add offers to set it right away (hidden input, as secret
set asks); --from-env VAR sets it from an environment variable; otherwise, afterwards:
  pnpm everyapp secret set TREG_MCP_TOKEN

--auth bearer sends Authorization: Bearer <value>; header sends <header>: <value>; basic
takes user:password; none sends nothing. oauth is recorded but not served yet: the Gateway
doesn't sign in to MCP servers with OAuth this week.

add looks at the URL once from this machine, without the credential, and says what it
found (MCP, a 401, a redirect, or nothing); that is a warning, never a refusal, since the
Gateway, not this machine, is what fetches it. The Gateway follows no redirects.

Examples:
  pnpm everyapp mcp add https://mcp.deepwiki.com/mcp
  pnpm everyapp mcp add https://treg.to/mcp/ --auth bearer
  pnpm everyapp mcp add https://api.example.org/mcp --name example --auth header --header X-Api-Key --risk read

FLAGS
     [--name]                  The app's id and tool prefix (default: from the URL's host, https://mcp.treg.to/mcp → treg)
     [--auth]                  How the Gateway authenticates to the server (default: none; bearer with --secret, header with --header)                         [none|bearer|header|basic|oauth]
     [--header]                With --auth header: the header the server reads the credential from (X-Api-Key)
     [--secret]                The Gateway setting holding the credential, ending in _MCP_TOKEN (default: <ID>_MCP_TOKEN)
     [--risk]                  How a tool's risk is decided: from the server's hints, unknown as write (annotations, the default), or every tool read or write [annotations|read|write]
     [--description]           What the app is for, as Admin → Apps and everyapp_list_apps say it (default: from the URL)
     [--from-env]              Set the credential from this environment variable once the app is added (as secret set --from-env)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  url  The server's MCP address (https://, the one URL the Gateway ever sends its credential to)
```

### `everyapp mcp remove`

Remove an MCP app: it leaves /mcp and the home page, and everyone's access to it goes.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The MCP app (mcp list names them): dataforseo, or the id a server was added as |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp mcp remove [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp mcp remove --help

Like deleting an app: the Gateway stops serving its tools within 30 seconds, and
everyone's access to it, the personal tokens bound to it, its tools snapshot and its
place in AI connections go with it. Adding it again starts fresh. To stop serving it
and keep all that, turn it off instead: pnpm everyapp mcp off <id>.

The Gateway setting holding its key or credential stays, and so does a credential's pin
to its origin; pnpm everyapp secret unset <NAME> removes both.

Example:
  pnpm everyapp mcp remove treg

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The MCP app (mcp list names them): dataforseo, or the id a server was added as
```

### `everyapp mcp on`

Turn an MCP app on: its tools reach members' AI clients through the Gateway's /mcp.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The MCP app (mcp list names them): dataforseo, or the id a server was added as |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp mcp on [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp mcp on --help

An MCP app is a data provider (DataForSEO, built in) or any remote MCP server added with
pnpm everyapp mcp add <url>, offered as an app of the Gateway's own with no page and nothing to
deploy: the Gateway serves its tools on its /mcp under <id>_<tool> names, with its own key,
and counts and audits every call like an app's. It appears in Admin → Apps and under MCP
apps on the home page.

A built-in's first on adds it: you, the owners and the admins get it at once, and an
admin grants other members with Manage access. On after off serves it again at once,
with everyone's access kept. The key is a Gateway setting the tools need (mcp list names
it):
  pnpm everyapp secret set DATAFORSEO_API_KEY

Safe to repeat: an app that is on stays on, with its access.

Examples:
  pnpm everyapp mcp on dataforseo
  pnpm everyapp mcp on treg --json

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The MCP app (mcp list names them): dataforseo, or the id a server was added as
```

### `everyapp mcp off`

Turn an MCP app off: its tools leave /mcp, and everyone's access is kept for on.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The MCP app (mcp list names them): dataforseo, or the id a server was added as |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp mcp off [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp mcp off --help

The Gateway stops serving the app's tools within 30 seconds and the home page stops
listing it. Everyone's access, the personal tokens bound to it and its tools snapshot
are kept, so pnpm everyapp mcp on <id> serves it again at once. To remove it for good, with
all of that: pnpm everyapp mcp remove <id>.

(Until 2026-10-25 off removed the app; that is remove now.)

Example:
  pnpm everyapp mcp off dataforseo

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The MCP app (mcp list names them): dataforseo, or the id a server was added as
```

### `everyapp mcp list`

List the MCP apps: built-in and added, on or off, their tools and whether each key is set.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp mcp list [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp mcp list --help

Nothing is changed. A key's value can't be read back; only whether it is set.

Example:
  pnpm everyapp mcp list

ALIASES
  pnpm everyapp mcp ls

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp mcp show`

Show an MCP app: its address, credential, status, last tool listing and every tool with its risk.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The MCP app (mcp list names them): dataforseo, or the id a server was added as |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp mcp show [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp mcp show --help

For a remote server: the URL, how the Gateway authenticates, the credential's name, whether
it is set and the origin it is pinned to, the risk default, when the tools were last listed
(and the error if that failed), then every tool the server listed: its name on the Gateway,
the server's own name, its risk and where that comes from (the server's hint, the app's
default, your override), and whether it is on. Nothing is changed.

Examples:
  pnpm everyapp mcp show treg
  pnpm everyapp mcp show dataforseo --json

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The MCP app (mcp list names them): dataforseo, or the id a server was added as
```

### `everyapp mcp refresh`

Drop an MCP app's tools snapshot, so the Gateway lists its tools again.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The MCP app (mcp list names them): dataforseo, or the id a server was added as |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp mcp refresh [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp mcp refresh --help

Only the snapshot goes (the Gateway's copy of the tool list); the app, its access and its
settings stay. The Gateway lists the tools again on the next request to its /mcp, or
within the hour. Use it after the server changed its tools.

Example:
  pnpm everyapp mcp refresh treg

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The MCP app (mcp list names them): dataforseo, or the id a server was added as
```

### `everyapp mcp tool`

Override one tool of a remote MCP app: its risk, or whether it is listed at all.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The MCP app (mcp list names them): dataforseo, or the id a server was added as |
| `<tool>` | yes | The tool: the server's name for it, or its name on the Gateway (mcp show lists both) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--risk` | `read`, `write`, `destructive`, `annotations` | no |  | The tool's risk: read, write or destructive (hidden until approvals exist); annotations drops your override |
| `--on` | switch | no |  | List the tool (the default) |
| `--off` | switch | no |  | Leave the tool out: it isn't listed, and a call answers Unknown tool |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp mcp tool [--risk read|write|destructive|annotations] [--on] [--off] [--gateway value] [--account-id value] [--json] [--verbose] <id> <tool>
  pnpm everyapp mcp tool --help

A tool's risk decides who can call it: read tools every connection, write tools only
read & write ones, destructive tools nobody until approvals exist. The server's hints
decide it unless the app's --risk default or this override says otherwise. The Gateway
lists the tools again on first use. A built-in MCP app's tools are its own and can't be
changed here.

Examples:
  pnpm everyapp mcp tool treg delete_everything --risk destructive
  pnpm everyapp mcp tool treg treg_noisy_tool --off
  pnpm everyapp mcp tool treg search --risk annotations

FLAGS
     [--risk]                  The tool's risk: read, write or destructive (hidden until approvals exist); annotations drops your override                [read|write|destructive|annotations]
     [--on/--no-on]            List the tool (the default)
     [--off/--no-off]          Leave the tool out: it isn't listed, and a call answers Unknown tool
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id    The MCP app (mcp list names them): dataforseo, or the id a server was added as
  tool  The tool: the server's name for it, or its name on the Gateway (mcp show lists both)
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
| `<senders\|inbound>...` | yes | List to clear: senders or inbound |

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

### `everyapp events add`

Send the organization's events to a URL (a signed POST) or by email to its owners and admins.

| Argument | Required | What it is |
| --- | --- | --- |
| `<url>` | no | The webhook's https:// URL (leave it out with --email) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--events` | `<types>` (repeatable) | no |  | The events to send, comma separated: types (member.joined), prefixes (cap.*, app.crm.*) or * (repeat to add more; default: every event but test pings) |
| `--name` | `<text>` | no |  | What to call it, like 'Slack #ops' (default: the URL's host, or Email owners and admins) |
| `--email` | `owners`, `admins` | no |  | Mail each event to the organization's owners, or its owners and admins (admins), instead of a webhook |
| `--secret` | switch | no |  | Give the webhook's signing secret yourself, 16 to 128 characters: asked at a hidden prompt, or read piped in, never typed on the command line (default: one is made and shown once) |
| `--secret-from-env` | `<VAR>` | no |  | Read the signing secret from this environment variable |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp events add [--events types]... [--name text] [--email owners|admins] [--secret] [--secret-from-env VAR] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] [<url>]
  pnpm everyapp events add --help

A webhook gets each event as a JSON POST, signed with the subscription's secret:
X-EveryApp-Signature: t=<seconds>,v1=<hex>, HMAC-SHA256 over <t>.<body>; the receiver checks
it (/docs/events has the code). Without --secret one is made and shown once: copy it then.
Slack's Workflow Builder, Zapier, n8n, Make and your own endpoint all take one; the body's
top-level summary is a line a person reads.

The URL must be https:// on a public hostname: not an IP address, not a local or internal
name, not the Gateway or one of its apps. For a receiver on a private network, set
EVENTS_ALLOW_PRIVATE_TARGETS on the Gateway with the value "true" (self-host only;
pnpm everyapp secret set EVENTS_ALLOW_PRIVATE_TARGETS): then http://, IP addresses and private names are let through.

--email mails each event to the organization's owners (owners) or owners and admins
(admins), from the Gateway's sender (EMAIL_FROM); it takes no address. An organization has at
most 25 subscriptions. The Gateway sends each event within a minute.

Examples:
  pnpm everyapp events add https://hooks.example.com/everyapp --events cap.*,member.*
  pnpm everyapp events add https://hooks.zapier.com/hooks/catch/1/abc --name Zapier --secret
  pnpm everyapp events add --email admins --events cap.*
  pnpm everyapp events add https://n8n.example.com/webhook/x --secret-from-env N8N_SECRET --json

FLAGS
     [--events]...             The events to send, comma separated: types (member.joined), prefixes (cap.*, app.crm.*) or * (repeat to add more; default: every event but test pings)
     [--name]                  What to call it, like 'Slack #ops' (default: the URL's host, or Email owners and admins)
     [--email]                 Mail each event to the organization's owners, or its owners and admins (admins), instead of a webhook                                                                               [owners|admins]
     [--secret/--no-secret]    Give the webhook's signing secret yourself, 16 to 128 characters: asked at a hidden prompt, or read piped in, never typed on the command line (default: one is made and shown once)
     [--secret-from-env]       Read the signing secret from this environment variable
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [url]  The webhook's https:// URL (leave it out with --email)
```

### `everyapp events list`

List the organization's subscriptions: where each goes, what it takes, how its last delivery went.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp events list [--org slug] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp events list --help

A webhook shows its URL's host and path (never its query or secret); an email one, whom it
mails. Nothing is changed.

Example:
  pnpm everyapp events list

ALIASES
  pnpm everyapp events ls

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp events remove`

Remove a subscription (a built-in one is disabled instead).

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The subscription, by its sub_ id (events list names them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp events remove [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp events remove --help

Nothing more is delivered to it; its delivery log stays for 30 days. The Gateway's built-in
cap alerts are disabled instead of removed, so the Gateway never makes them again.

Example:
  pnpm everyapp events remove sub_0123456789abcdef01234567

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The subscription, by its sub_ id (events list names them)
```

### `everyapp events enable`

Resume a subscription: new events are queued for it again.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The subscription, by its sub_ id (events list names them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp events enable [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp events enable --help

What happened while it was disabled isn't sent. Safe to repeat.

Example:
  pnpm everyapp events enable sub_0123456789abcdef01234567

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The subscription, by its sub_ id (events list names them)
```

### `everyapp events disable`

Pause a subscription: no new events are queued for it, and what is queued is dropped.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The subscription, by its sub_ id (events list names them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp events disable [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp events disable --help

Turn the built-in cap alerts off this way. Safe to repeat; events enable resumes it.

Example:
  pnpm everyapp events disable sub_0123456789abcdef01234567

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The subscription, by its sub_ id (events list names them)
```

### `everyapp events test`

Send a test event (ping) to one subscription and wait to see whether it was delivered.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The subscription, by its sub_ id (events list names them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--no-wait` | switch | no |  | Return once the test event is queued; events deliveries shows how it went |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp events test [--no-wait] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp events test --help

Queues a ping for that subscription only, then waits up to 90 seconds while the Gateway
sends it (it sends queued events every minute), and says delivered or failed with the
receiver's status code or the error. A failed test is retried like any delivery.

Examples:
  pnpm everyapp events test sub_0123456789abcdef01234567
  pnpm everyapp events test sub_0123456789abcdef01234567 --no-wait --json

FLAGS
     [--no-wait/--no-no-wait]  Return once the test event is queued; events deliveries shows how it went
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The subscription, by its sub_ id (events list names them)
```

### `everyapp events deliveries`

List the last deliveries (30 days): the event, its subscription, attempts, status, next attempt, last error.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | no | Only this subscription's (default: every subscription's) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--dead` | switch | no |  | Only deliveries that ran out of attempts (dead), to redeliver |
| `--limit` | `<n>` | no |  | How many to show, newest first: 1 to 200 (default 20) |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp events deliveries [--dead] [--limit n] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] [<id>]
  pnpm everyapp events deliveries --help

A delivery is retried after 1, 5 and 30 minutes, then 2, 8 and 24 hours; the seventh failure
is dead. Nothing is changed.

Examples:
  pnpm everyapp events deliveries
  pnpm everyapp events deliveries sub_0123456789abcdef01234567 --limit 50
  pnpm everyapp events deliveries --dead

FLAGS
     [--dead/--no-dead]        Only deliveries that ran out of attempts (dead), to redeliver
     [--limit]                 How many to show, newest first: 1 to 200 (default 20)
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [id]  Only this subscription's (default: every subscription's)
```

### `everyapp events redeliver`

Send a failing or dead delivery again: the Gateway sends it within a minute, with the full retry schedule.

| Argument | Required | What it is |
| --- | --- | --- |
| `<delivery>` | yes | The delivery, by its dlv_ id (events deliveries names them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp events redeliver [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <delivery>
  pnpm everyapp events redeliver --help

Its attempts start over at 0. A delivered one is left alone. The receiver may get the same
event id again: receivers deduplicate on it.

Example:
  pnpm everyapp events redeliver dlv_0123456789abcdef01234567

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  delivery  The delivery, by its dlv_ id (events deliveries names them)
```

### `everyapp events types`

List the event types --events takes, with their versions.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp events types [--json] [--verbose]
  pnpm everyapp events types --help

The catalogue this CLI knows, and how a pattern names several (member.*, app.crm.*, *). No
Gateway is needed.

Example:
  pnpm everyapp events types

FLAGS
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workspace show`

The organization: its owners, whether it can send mail, and how many members, invitations, groups and apps it has.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace show [--org slug] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp workspace show --help

Nothing is changed. Email counts as configured when the Gateway settings EMAIL_FROM and a
provider key are set, which is what invitations need to be mailed from the Gateway (this
command prints links instead either way).

Example:
  pnpm everyapp workspace show --json

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workspace rename`

Rename the workspace: the name members see in the organization switcher and in invitations.

| Argument | Required | What it is |
| --- | --- | --- |
| `<name>` | yes | The new name: 1 to 64 characters, no line breaks (quote one with spaces) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace rename [--gateway value] [--account-id value] [--json] [--verbose] <name>
  pnpm everyapp workspace rename --help

The workspace is the Gateway's organization: the one the setup claim made, named after
its owner. This gives it the name you want; the same rename is under Manage workspace in
the Gateway, for owners and admins. Nothing is built or deployed: the Gateway reads the
name live, and each member sees it on their next page.

Before the Gateway is claimed there is no workspace to rename (WORKSPACE_NOT_CLAIMED):
claim it in a browser first.

Examples:
  pnpm everyapp workspace rename 'Acme Corp'
  pnpm everyapp workspace rename 'Acme Corp' --json

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  name  The new name: 1 to 64 characters, no line breaks (quote one with spaces)
```

### `everyapp workspace users`

The members with their role and state, then the pending invitations.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace users [--org slug] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp workspace users --help

Nothing is changed. A deactivated member is listed as such; a pending invitation with when
it expires.

Example:
  pnpm everyapp workspace users

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workspace role`

Set a member's role: owner, admin or member.

| Argument | Required | What it is |
| --- | --- | --- |
| `<email>` | yes | The member's email address, as Manage workspace → Users lists it |
| `<owner\|admin\|member>` | yes | The role to give them |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace role [--gateway value] [--account-id value] [--json] [--verbose] <email> <owner|admin|member>
  pnpm everyapp workspace role --help

The workspace is the Gateway's own organization, the one its owner claimed. Owners are
peers: any owner can make a member or an admin an owner, and change another owner's
role, from Manage workspace → Users or with this command under the Cloudflare login.
The workspace always keeps at least one owner, so the last owner's role is never
changed (LAST_OWNER): make someone else an owner first. Deactivated owners don't
count here, so this command can't leave a workspace whose only owner is locked out
(the Gateway's own Users page needs no such rule: a deactivated owner can't act, and
only an owner acts on an owner). Only a member can be given a role; someone still
invited isn't one yet (MEMBER_NOT_FOUND). The Gateway picks up the change within 30
seconds.

Examples:
  pnpm everyapp workspace role sam@example.com owner
  pnpm everyapp workspace role sam@example.com member --json

FLAGS
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  email               The member's email address, as Manage workspace → Users lists it
  owner|admin|member  The role to give them
```

### `everyapp workspace invite`

Invite someone by email and print the link to send them (the Gateway mails nothing from here).

| Argument | Required | What it is |
| --- | --- | --- |
| `<email>` | yes | The address to invite |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--role` | `member`, `admin` | no | `member` | The role they join with |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace invite [--role member|admin] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <email>
  pnpm everyapp workspace invite --help

Makes a pending invitation (72 hours, single use, only for an account with that email) in
your name: your Cloudflare login's email must be a member of the organization. Prints
<gateway>/accept-invitation?token=einv_…, which is the invitation's only secret: hand it to
the person yourself. The Gateway mails invitations only from Admin → Users.

Examples:
  pnpm everyapp workspace invite ann@example.com
  pnpm everyapp workspace invite ann@example.com --role admin --json

FLAGS
     [--role]                  The role they join with                                                                                                                                      [member|admin, default = member]
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  email  The address to invite
```

### `everyapp workspace invite-link`

Print a new link for a pending invitation (earlier links keep working until it is used).

| Argument | Required | What it is |
| --- | --- | --- |
| `<email\|id>` | yes | The pending invitation, by invited email or id (workspace users lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace invite-link [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <email|id>
  pnpm everyapp workspace invite-link --help

The link's token is new each time and stored only as its hash. Every link of an invitation
stops working once it is accepted, canceled or expired.

Example:
  pnpm everyapp workspace invite-link ann@example.com

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  email|id  The pending invitation, by invited email or id (workspace users lists them)
```

### `everyapp workspace uninvite`

Cancel a pending invitation: its links stop working.

| Argument | Required | What it is |
| --- | --- | --- |
| `<email\|id>` | yes | The pending invitation, by invited email or id (workspace users lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace uninvite [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <email|id>
  pnpm everyapp workspace uninvite --help

Example:
  pnpm everyapp workspace uninvite ann@example.com

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  email|id  The pending invitation, by invited email or id (workspace users lists them)
```

### `everyapp workspace deactivate`

Lock a member out everywhere: no sign-in, every session ended, their tokens and AI connections revoked.

| Argument | Required | What it is |
| --- | --- | --- |
| `<email>` | yes | The member, by email or user id (workspace users lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace deactivate [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <email>
  pnpm everyapp workspace deactivate --help

The account stays, listed as deactivated, and the ban holds in every organization it belongs
to; workspace reactivate lifts it (revoked tokens and connections stay revoked). An
organization always keeps an owner who can act, and the ban is account-wide, so the last
live owner of this organization, or of any other they own, can't be deactivated
(LAST_OWNER, naming the organization): a deactivated owner doesn't count.

Example:
  pnpm everyapp workspace deactivate ann@example.com

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  email  The member, by email or user id (workspace users lists them)
```

### `everyapp workspace reactivate`

Lift a deactivation: they can sign in again (revoked tokens and connections stay revoked).

| Argument | Required | What it is |
| --- | --- | --- |
| `<email>` | yes | The member, by email or user id (workspace users lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace reactivate [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <email>
  pnpm everyapp workspace reactivate --help

Example:
  pnpm everyapp workspace reactivate ann@example.com

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  email  The member, by email or user id (workspace users lists them)
```

### `everyapp workspace remove`

Remove a member from the organization, and their account when it belongs to no other.

| Argument | Required | What it is |
| --- | --- | --- |
| `<email>` | yes | The member, by email or user id (workspace users lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--yes` | switch | no |  | Remove without asking (needed where nobody is at a terminal) |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace remove [--yes] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <email>
  pnpm everyapp workspace remove --help

Deletes the membership, their app grants and places in groups, and revokes their personal
access tokens for the organization and AI connections to it, in one write. The account goes
too when it belongs to no other organization (a hosted Gateway keeps accounts). Someone
Cloudflare Access would let straight back in (the Gateway has CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS
or CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN set) is deactivated and kept listed instead, as the
Gateway's own Delete does. Owners are peers, and the organization always keeps one who can
act: the last owner who isn't deactivated can't be removed (LAST_OWNER). Asks first at a
terminal; elsewhere it needs --yes.

Example:
  pnpm everyapp workspace remove ann@example.com --yes --json

FLAGS
  -y [--yes/--no-yes]          Remove without asking (needed where nobody is at a terminal)
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  email  The member, by email or user id (workspace users lists them)
```

### `everyapp workspace reset-link`

Print a one-hour, single-use password-reset link to hand to a member.

| Argument | Required | What it is |
| --- | --- | --- |
| `<email>` | yes | The member, by email or user id (workspace users lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace reset-link [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <email>
  pnpm everyapp workspace reset-link --help

Better Auth's own reset token, consumed by the Gateway's /reset-password page: whoever opens
it sets the account's password, so hand it to the person yourself. Only for an active
account (PASSWORD_RESET_REQUIRES_ACTIVE_USER) that belongs to this organization alone
(USER_IN_OTHER_ORGANIZATION: a password is account-wide, so the Gateway's rule holds here
too). Password sign-in must be on (EMAIL_PASSWORD_SIGN_IN) for the page to take it. An
owner's too: the operator is root (the Gateway refuses that to admins and other owners),
which is the way back in for a sole owner who lost their password.

Example:
  pnpm everyapp workspace reset-link ann@example.com

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  email  The member, by email or user id (workspace users lists them)
```

### `everyapp workspace groups`

The groups, with how many members and apps each has.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace groups [--org slug] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp workspace groups --help

Nothing is changed.

Example:
  pnpm everyapp workspace groups

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workspace group create`

Make a group: a named set of members that apps are granted to as one.

| Argument | Required | What it is |
| --- | --- | --- |
| `<name>` | yes | The group's name, 1 to 60 characters, unique in the organization |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--description` | `<text>` | no |  | What the group is for (empty text clears it) |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace group create [--description text] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <name>
  pnpm everyapp workspace group create --help

A member opens an app when they hold a grant to it, or belong to a group that does.

Example:
  pnpm everyapp workspace group create Sales --description "The sales team"

FLAGS
     [--description]           What the group is for (empty text clears it)
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  name  The group's name, 1 to 60 characters, unique in the organization
```

### `everyapp workspace group set`

Rename or describe a group.

| Argument | Required | What it is |
| --- | --- | --- |
| `<group>` | yes | The group, by name or grp_ id (workspace groups lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--name` | `<name>` | no |  | A new name |
| `--description` | `<text>` | no |  | What the group is for (empty text clears it) |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace group set [--name name] [--description text] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <group>
  pnpm everyapp workspace group set --help

Example:
  pnpm everyapp workspace group set Sales --name "Sales and marketing"

FLAGS
     [--name]                  A new name
     [--description]           What the group is for (empty text clears it)
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  group  The group, by name or grp_ id (workspace groups lists them)
```

### `everyapp workspace group delete`

Delete a group: what it granted ends with it.

| Argument | Required | What it is |
| --- | --- | --- |
| `<group>` | yes | The group, by name or grp_ id (workspace groups lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--yes` | switch | no |  | Delete without asking (needed where nobody is at a terminal) |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace group delete [--yes] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <group>
  pnpm everyapp workspace group delete --help

Its members keep their direct grants and their other groups. Asks first at a terminal;
elsewhere it needs --yes.

Example:
  pnpm everyapp workspace group delete Sales --yes

FLAGS
  -y [--yes/--no-yes]          Delete without asking (needed where nobody is at a terminal)
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  group  The group, by name or grp_ id (workspace groups lists them)
```

### `everyapp workspace group members`

Who is in a group; --add, --remove or --set change it.

| Argument | Required | What it is |
| --- | --- | --- |
| `<group>` | yes | The group, by name or grp_ id (workspace groups lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--add` | `<email>` (repeatable) | no |  | Add a member, by email or user id (repeat for several) |
| `--remove` | `<email>` (repeatable) | no |  | Remove a member, by email or user id (repeat for several) |
| `--set` | `<email>` (repeatable) | no |  | Replace the whole list with these (repeat for several; alone, with neither --add nor --remove) |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace group members [--add email]... [--remove email]... [--set email]... [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <group>
  pnpm everyapp workspace group members --help

Without a change flag, lists every member of the organization and whether they are in the
group. Only members of the organization can be in its groups.

Examples:
  pnpm everyapp workspace group members Sales
  pnpm everyapp workspace group members Sales --add ann@example.com --add bob@example.com
  pnpm everyapp workspace group members Sales --set ann@example.com

FLAGS
     [--add]...                Add a member, by email or user id (repeat for several)
     [--remove]...             Remove a member, by email or user id (repeat for several)
     [--set]...                Replace the whole list with these (repeat for several; alone, with neither --add nor --remove)
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  group  The group, by name or grp_ id (workspace groups lists them)
```

### `everyapp workspace group apps`

Which apps a group opens; --add, --remove or --set change it.

| Argument | Required | What it is |
| --- | --- | --- |
| `<group>` | yes | The group, by name or grp_ id (workspace groups lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--add` | `<app>` (repeatable) | no |  | Add an app, by id (repeat for several) |
| `--remove` | `<app>` (repeatable) | no |  | Remove an app, by id (repeat for several) |
| `--set` | `<app>` (repeatable) | no |  | Replace the whole list with these (repeat for several; alone, with neither --add nor --remove) |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace group apps [--add app]... [--remove app]... [--set app]... [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <group>
  pnpm everyapp workspace group apps --help

Without a change flag, lists the organization's own apps and whether the group opens each.
A shared app opens for everyone already and is never granted to a group.

Examples:
  pnpm everyapp workspace group apps Sales
  pnpm everyapp workspace group apps Sales --add crm

FLAGS
     [--add]...                Add an app, by id (repeat for several)
     [--remove]...             Remove an app, by id (repeat for several)
     [--set]...                Replace the whole list with these (repeat for several; alone, with neither --add nor --remove)
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  group  The group, by name or grp_ id (workspace groups lists them)
```

### `everyapp workspace apps`

Every app with who can open it, whether everyone can, its state and what it still needs set.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace apps [--org slug] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp workspace apps --help

The admin's view (Admin → Apps); everyapp status has the operator's. Nothing is changed.

Example:
  pnpm everyapp workspace apps --json

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workspace app set`

Change an app's name, description or whether everyone can open it.

| Argument | Required | What it is |
| --- | --- | --- |
| `<app>` | yes | The app, by id (crm) or row id (workspace apps lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--name` | `<name>` | no |  | The name the app library shows (1 to 255 characters) |
| `--description` | `<text>` | no |  | The description under it |
| `--everyone` | `on`, `off` | no |  | Available to everyone: on grants every member now and every future member on joining; off keeps existing access |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace app set [--name name] [--description text] [--everyone on|off] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <app>
  pnpm everyapp workspace app set --help

Catalog metadata only: the next deploy sets the name and description again from
everyapp.config.ts.

Examples:
  pnpm everyapp workspace app set crm --everyone on
  pnpm everyapp workspace app set crm --name "Open CRM" --description "Contacts and deals"

FLAGS
     [--name]                  The name the app library shows (1 to 255 characters)
     [--description]           The description under it
     [--everyone]              Available to everyone: on grants every member now and every future member on joining; off keeps existing access                                              [on|off]
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  app  The app, by id (crm) or row id (workspace apps lists them)
```

### `everyapp workspace app access`

Who can open an app; --add, --remove or --set change the direct grants.

| Argument | Required | What it is |
| --- | --- | --- |
| `<app>` | yes | The app, by id (crm) or row id (workspace apps lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--add` | `<email>` (repeatable) | no |  | Add a member's direct grant, by email or user id (repeat for several) |
| `--remove` | `<email>` (repeatable) | no |  | Remove a member's direct grant, by email or user id (repeat for several) |
| `--set` | `<email>` (repeatable) | no |  | Replace the whole list with these (repeat for several; alone, with neither --add nor --remove) |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace app access [--add email]... [--remove email]... [--set email]... [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <app>
  pnpm everyapp workspace app access --help

Without a change flag, lists every member with whether they hold a direct grant and which
groups open the app for them. A change touches direct grants only; what a group grants
stays (workspace group apps). A shared app's access can't be changed.

Examples:
  pnpm everyapp workspace app access crm
  pnpm everyapp workspace app access crm --add ann@example.com
  pnpm everyapp workspace app access crm --set ann@example.com --set bob@example.com --json

FLAGS
     [--add]...                Add a member's direct grant, by email or user id (repeat for several)
     [--remove]...             Remove a member's direct grant, by email or user id (repeat for several)
     [--set]...                Replace the whole list with these (repeat for several; alone, with neither --add nor --remove)
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  app  The app, by id (crm) or row id (workspace apps lists them)
```

### `everyapp workspace app cap`

Cap an app's provider calls or dollars per month, lift its own caps, or exempt it from the workspace defaults.

| Argument | Required | What it is |
| --- | --- | --- |
| `<app>` | yes | The app, by id or row id: the organization's own, or a shared one |
| `<n\|off>` | no | Provider calls per UTC month (1 to 1,000,000,000), or off for no call cap of its own (the workspace default applies); left out to keep it, and with --unlimited |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--usd` | `<dollars|off>` | no |  | Dollars of provider-reported cost per UTC month (0.01 to 1,000,000), or off for no dollar cap of its own; counted only where the provider reports a price (OpenRouter, DataForSEO) |
| `--unlimited` | switch | no |  | No cap at all, of either kind, even with workspace defaults (instead of a number, off or --usd) |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace app cap [--usd dollars|off] [--unlimited] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <app> [<n|off>]
  pnpm everyapp workspace app cap --help

An app has caps of its own (a number of calls, --usd dollars, or both), no cap whatever
the workspace defaults (--unlimited), or neither (off, and --usd off): the defaults set
with workspace cap default bind it, and without them it is uncapped. A kind left out
keeps the app's own, so --usd alone keeps the call cap; a cap of either kind ends
--unlimited, the other kind then following its default. The dollar cap counts the cost
a provider reports (OpenRouter, DataForSEO); other calls count toward the call cap
alone. Past either cap that binds it, a provider tool answers a tool error naming it and
an app's brokered call gets 429 app_monthly_cap_exceeded until the next UTC month. Binds
within seconds. --unlimited with a number, off or --usd is refused (INVALID_VALUE); on a
Gateway from before the workspace default, --unlimited is refused
(GATEWAY_PREDATES_DEFAULT_CAPS) and a number or off still work; on one from before dollar
caps, --usd is refused (GATEWAY_PREDATES_COST_CAPS).

Examples:
  pnpm everyapp workspace app cap crm 5000
  pnpm everyapp workspace app cap crm --usd 20
  pnpm everyapp workspace app cap crm off --usd off
  pnpm everyapp workspace app cap crm --unlimited

FLAGS
     [--usd]                       Dollars of provider-reported cost per UTC month (0.01 to 1,000,000), or off for no dollar cap of its own; counted only where the provider reports a price (OpenRouter, DataForSEO)
     [--unlimited/--no-unlimited]  No cap at all, of either kind, even with workspace defaults (instead of a number, off or --usd)
     [--org]                       The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]                   The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]                The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]            Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]      Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                       Print help information and exit
      --                           All subsequent inputs should be interpreted as arguments

ARGUMENTS
   app     The app, by id or row id: the organization's own, or a shared one
  [n|off]  Provider calls per UTC month (1 to 1,000,000,000), or off for no call cap of its own (the workspace default applies); left out to keep it, and with --unlimited
```

### `everyapp workspace cap default`

Set or clear the workspace default caps: what binds every app without a cap or --unlimited of its own.

| Argument | Required | What it is |
| --- | --- | --- |
| `<n\|off>` | no | Provider calls per UTC month (1 to 1,000,000,000) for every app without its own call cap, or off for no default; left out to keep it |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--usd` | `<dollars|off>` | no |  | Dollars of provider-reported cost per UTC month (0.01 to 1,000,000) for every app without its own dollar cap, or off for no dollar default |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace cap default [--usd dollars|off] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] [<n|off>]
  pnpm everyapp workspace cap default --help

The same setting as Manage workspace → Usage → Default monthly cap: a number of calls,
--usd dollars of provider-reported cost, or both; a kind left out is kept. An app's own
cap of that kind, or its --unlimited, stays. The dollar cap counts the cost a provider
reports (OpenRouter, DataForSEO); other calls count toward the call cap alone. The
Gateway holds every app without its own to them within 30 seconds; past either, a
provider tool answers a tool error naming the cap and an app's brokered call gets 429
app_monthly_cap_exceeded until the next UTC month. As in the Gateway, the workspace's
first cap makes the built-in Cap alerts subscription, and a default set, raised or
removed queues cap.raised (a lowered one doesn't). The default model provider in the
same row stays. Refused on a Gateway from before the workspace default
(GATEWAY_PREDATES_DEFAULT_CAPS), and --usd on one from before dollar caps
(GATEWAY_PREDATES_COST_CAPS): run update first.

Examples:
  pnpm everyapp workspace cap default 1000
  pnpm everyapp workspace cap default --usd 20
  pnpm everyapp workspace cap default off --usd off --json

FLAGS
     [--usd]                   Dollars of provider-reported cost per UTC month (0.01 to 1,000,000) for every app without its own dollar cap, or off for no dollar default
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [n|off]  Provider calls per UTC month (1 to 1,000,000,000) for every app without its own call cap, or off for no default; left out to keep it
```

### `everyapp workspace usage`

What the apps spent in a month: per app (with the cap that binds it), per member and per provider.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--month` | `<YYYY-MM>` | no |  | The UTC month (default: this one) |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace usage [--month YYYY-MM] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp workspace usage --help

Provider calls, failures, tokens and provider-reported cost, counted at the Gateway after a
provider answered, and allowed MCP tool calls from the audit trail. Every callable app is
listed, with zeros in a month it made no call, its own caps (calls and dollars), the caps
that bind it and where they come from (its own, or the workspace default), whether it is
exempt (--unlimited) and whether it is paused this month and by which cap; the workspace
default caps come with it. Nothing is
changed. Refused on a Gateway from before the workspace default
(GATEWAY_PREDATES_DEFAULT_CAPS): run update first.

Example:
  pnpm everyapp workspace usage --month 2026-10 --json

FLAGS
     [--month]                 The UTC month (default: this one)
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workspace activity`

The tool-call audit trail, newest first: who called which tool on which app, and what came of it.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--app` | `<app>` | no |  | Calls on this app only, by id or row id |
| `--user` | `<email>` | no |  | Calls by this member only, by email or user id |
| `--decision` | `allowed`, `blocked` | no |  | Allowed or blocked calls only |
| `--risk` | `read`, `write`, `destructive` | no |  | Tools of this risk only |
| `--since` | `<time>` | no |  | Calls at or after this time (ISO 8601, UTC) |
| `--limit` | `<n>` | no |  | Rows per page, 1 to 200 (default 50) |
| `--before` | `<cursor>` | no |  | The next page: the previous page's nextBefore, as <createdAt>:<id> |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace activity [--app app] [--user email] [--decision allowed|blocked] [--risk read|write|destructive] [--since time] [--limit n] [--before cursor] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp workspace activity --help

Never the arguments or the result: the trail holds neither. One page at a time; --json
carries data.nextBefore for the next page. Nothing is changed.

Examples:
  pnpm everyapp workspace activity --limit 20
  pnpm everyapp workspace activity --app crm --decision blocked --since 2026-10-24 --json

FLAGS
     [--app]                   Calls on this app only, by id or row id
     [--user]                  Calls by this member only, by email or user id
     [--decision]              Allowed or blocked calls only                                                                                                                                [allowed|blocked]
     [--risk]                  Tools of this risk only                                                                                                                                      [read|write|destructive]
     [--since]                 Calls at or after this time (ISO 8601, UTC)
     [--limit]                 Rows per page, 1 to 200 (default 50)
     [--before]                The next page: the previous page's nextBefore, as <createdAt>:<id>
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workspace audit`

The audit log, newest first: every event the Gateway recorded (members, apps, caps, connections, tokens, Access, MCP apps, providers, apps' own events), who did it and what it was about.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--actor` | `<who>` | no |  | Events this actor caused: a member by email or user id, an AI connection's or token's id, an app's id, or an operator's email |
| `--type` | `<type>` | no |  | One event type (member.joined), every type under a prefix (member.*, app.crm.*), or * for everything, pings and tool calls included |
| `--since` | `<time>` | no |  | Events at or after this time (ISO 8601, UTC) |
| `--limit` | `<n>` | no |  | Rows per page, 1 to 200 (default 50) |
| `--before` | `<cursor>` | no |  | The next page: the previous page's nextBefore, as <time>:<id> |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace audit [--actor who] [--type type] [--since time] [--limit n] [--before cursor] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp workspace audit --help

The same rows as Admin → Activity → Audit and everyapp_workspace_audit, kept 90 days. Each
row is when, who (a member by name, agent · <AI app>, CLI · <operator>, app · <id>, or
Gateway), what (the type in plain words) and the subject; never an event's data, a
secret or a tool's arguments. Test pings and tool calls stay out unless --type names
them (tool.*, *): workspace activity lists the calls. One page at a time; --json carries
data.nextBefore for the next page. Refused on a Gateway from before the audit log
(GATEWAY_OUTDATED): run update first. Nothing is changed.

Examples:
  pnpm everyapp workspace audit --limit 20
  pnpm everyapp workspace audit --actor mia@acme.com --type member.* --since 2026-10-24 --json

FLAGS
     [--actor]                 Events this actor caused: a member by email or user id, an AI connection's or token's id, an app's id, or an operator's email
     [--type]                  One event type (member.joined), every type under a prefix (member.*, app.crm.*), or * for everything, pings and tool calls included
     [--since]                 Events at or after this time (ISO 8601, UTC)
     [--limit]                 Rows per page, 1 to 200 (default 50)
     [--before]                The next page: the previous page's nextBefore, as <time>:<id>
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workspace tokens`

Every member's personal access tokens for the organization (never a token's value).

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--user` | `<email>` | no |  | One member's only, by email or user id |
| `--all` | switch | no |  | Revoked and expired tokens too |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace tokens [--user email] [--all] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp workspace tokens --help

Tokens are created in Admin → Tokens only: their hash is keyed by a Gateway secret the CLI
never holds. Nothing is changed.

Example:
  pnpm everyapp workspace tokens --user ann@example.com

FLAGS
     [--user]                  One member's only, by email or user id
     [--all/--no-all]          Revoked and expired tokens too
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workspace token revoke`

Revoke a personal access token: it stops working on its next request.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The token's id (workspace tokens lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace token revoke [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp workspace token revoke --help

Example:
  pnpm everyapp workspace token revoke 3f2a…

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The token's id (workspace tokens lists them)
```

### `everyapp workspace connections`

Every member's AI connections to the organization: which AI app, which apps it may use, read or write.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--user` | `<email>` | no |  | One member's only, by email or user id |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace connections [--user email] [--org slug] [--gateway value] [--account-id value] [--json] [--verbose]
  pnpm everyapp workspace connections --help

A connection is an OAuth client (Claude, Cursor, …) a member connected to the Gateway's /mcp.
Nothing is changed.

Example:
  pnpm everyapp workspace connections

FLAGS
     [--user]                  One member's only, by email or user id
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workspace connection revoke`

Revoke an AI connection: the client is out on its next request.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The connection's id (workspace connections lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--org` | `<slug>` | no |  | The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  pnpm everyapp workspace connection revoke [--org slug] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  pnpm everyapp workspace connection revoke --help

Example:
  pnpm everyapp workspace connection revoke mcpc_…

FLAGS
     [--org]                   The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)
     [--gateway]               The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The connection's id (workspace connections lists them)
```
