---
title: "CLI reference"
description: "Every everyapp command with its arguments, flags, defaults and help text, generated from the CLI itself. Exit codes and the global flags are here too."
---

<!-- Generated from packages/cli/src/app.ts and the command definitions by packages/cli/src/docs/cliReference.ts; the test in packages/cli/src/docs/agentDocs.test.ts fails when this page is stale. Regenerate with `pnpm -C packages/cli docs:update`. -->

The command is `everyapp`: `npm install -g everyapp`, then `everyapp …` (in a checkout of the EveryApp repository, `pnpm everyapp …`, which builds the Gateway from the tree). Every command takes `--help`; an agent adds `--json` and reads the event stream described on [/docs/agent/json](/docs/agent/json). What each error code means is on [/docs/agent/errors](/docs/agent/errors).

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
  everyapp <command> [flags]

BUILD AN APP
  create        Create a new app from the starter template
  dev           Run the app locally behind a dev Gateway
  deploy        Deploy the app in this directory
  release       Pack the app in this directory as a release others can install
  db            Migrate, query and restore an app's D1 database

RUN A GATEWAY
  login         Log in to Cloudflare, or sign in to a Gateway with --gateway
  setup         Install or repair the Gateway
  update        Update the Gateway to a newer release
  install       Install an app someone published, from GitHub or a release file
  deploy-token  Give the Gateway its own Cloudflare token, so it installs apps itself, or take it off
  configure     Set up an app: asks for each setting it needs, required ones first, then the optional ones
  status        Show the Gateway, its apps and anything to fix
  delete        Remove an app from the Gateway
  access        Put Cloudflare Access in front of the Gateway and its apps, or take it off
  signin        Let people sign in with Google, Microsoft, GitHub, Apple, Cloudflare or your SSO, beside passwords
  secret        Set, remove and list secrets and Gateway settings
  provider      Register API providers for apps to call with the Gateway's key, and OAuth providers people connect their accounts to
  ai            The default model apps get when they ask for one, and AI Gateway in front
  mcp           Offer MCP servers to members' AI clients as MCP apps, with the Gateway holding each one's key
  email         Manage the addresses an app sends as and receives at
  events        Send the Gateway's events to Slack, Zapier, n8n or your own endpoint (signed), or by email
  teardown      Delete everything EveryApp created in a dedicated test Cloudflare account, or one named Gateway

MANAGE THE WORKSPACE
  workspace     Manage the workspace from the terminal: members, invitations, groups, app access, caps, usage, activity, the audit log, tokens, AI connections and linked dev
  call          Call one of the Gateway's tools: every admin action (everyapp_*) and every app's tools

FLAGS
  -h, --help      Show help for everyapp or a command
  -v, --version   Show everyapp's version
      --no-color  Print without colors (also NO_COLOR=1)

EXAMPLES
  $ everyapp setup --domain apps.example.com
  $ everyapp create todo
  $ everyapp deploy
  $ everyapp install https://github.com/<owner>/<repo>
  $ everyapp configure crm

Run everyapp <command> --help for a command's flags.
Stuck? Ask in Discord: https://discord.gg/c9uGs3cFXr
```

## Command groups

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

### `everyapp access`

```text
Put Cloudflare Access in front of the Gateway and its apps, or take it off.

USAGE
  everyapp access <command> [flags]

COMMANDS
  on    Turn Cloudflare Access on in front of the Gateway and its apps, or bring it up to date
  off   Turn Cloudflare Access off for the Gateway and its apps
  show  Show how Cloudflare Access fronts the Gateway

EXAMPLES
  $ everyapp access on
  $ everyapp access show
  $ everyapp access off

Run everyapp access <command> --help for its flags.
```

### `everyapp secret`

```text
Set, remove and list secrets and Gateway settings.

USAGE
  everyapp secret <command> [flags]

COMMANDS
  set    Set secrets on your app or your Gateway
  unset  Remove secrets from your app or your Gateway
  list   List what an app needs set and what is: its own secrets and the Gateway's settings

EXAMPLES
  $ everyapp secret set GITHUB_TOKEN
  $ everyapp secret set GITHUB_TOKEN --from-env GH_TOKEN
  $ everyapp secret set MAIN_SECRET --app analytics
  $ everyapp secret list crm

Run everyapp secret <command> --help for its flags.
```

### `everyapp provider`

```text
Register API providers for apps to call with the Gateway's key, and OAuth providers people connect their accounts to.

USAGE
  everyapp provider <command> [flags]

COMMANDS
  add          Add a provider and set its key or OAuth client in one step, so apps can list it
  list         List the API providers the Gateway offers: built in and registered, each key's state, the apps using each
  show         Print a provider's spec: its hosts, how its key is sent, its settings, who registered it and which apps use it
  remove       Remove a registered provider from the Gateway; its key stays set until secret unset
  presets      List the OAuth presets provider add --oauth takes: GitHub, Notion, Linear and more, and the built-in clients
  connections  List the accounts people connected to OAuth providers in each app on the Gateway
  disconnect   Remove people's connections to an OAuth provider from the Gateway

EXAMPLES
  $ everyapp provider list
  $ everyapp provider add openrouter
  $ everyapp provider add google-workspace
  $ everyapp provider add stripe.json
  $ everyapp provider connections

Run everyapp provider <command> --help for its flags.
```

### `everyapp mcp`

```text
Offer MCP servers to members' AI clients as MCP apps, with the Gateway holding each one's key.

USAGE
  everyapp mcp <command> [flags]

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
  $ everyapp mcp list
  $ everyapp mcp on dataforseo
  $ everyapp mcp add https://treg.to/mcp/ --auth bearer
  $ everyapp mcp show treg
  $ everyapp mcp off treg

Run everyapp mcp <command> --help for its flags.
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

### `everyapp workspace`

```text
Manage the workspace from the terminal: members, invitations, groups, app access, caps, usage, activity, the audit log, tokens, AI connections and linked dev.

Everything Admin → Users, Groups, Apps, Tokens, Usage and Activity do, from the terminal.
Each command is one of the Gateway's own tools (everyapp_workspace_*), run as you in your
organization: EVERYAPP_TOKEN, or the sign-in everyapp login --gateway <url> keeps (the first
command asks for it in the browser). reset-link alone works under the Cloudflare login: the
way back in for a locked-out owner.
Depth-two groups have their own help: everyapp workspace group --help, app, token, connection.

USAGE
  everyapp workspace <command> [flags]

COMMANDS
  show         The organization: your role, whether it can send mail, and how many members, invitations, groups and apps it has
  rename       Rename the workspace: the name members see in the organization switcher and in invitations
  users        The members with their role and state, then the pending invitations
  role         Set a member's role: owner, admin or member
  invite       Invite someone by email: the Gateway mails the invitation when it can send email
  invite-link  Print a new link for a pending invitation, under the Cloudflare login (for a Gateway that sends no email)
  uninvite     Cancel a pending invitation: its links stop working
  deactivate   Lock a member out everywhere: no sign-in, every session ended, their tokens and AI connections revoked
  reactivate   Lift a deactivation: they can sign in again (revoked tokens and connections stay revoked)
  remove       Remove a member from the organization, and their account when it belongs to no other
  reset-email  Mail a member a password-reset link (the link goes to their inbox, never to you)
  reset-link   The way back in: print a one-hour, single-use password-reset link for a member, under the Cloudflare login
  groups       The groups, with how many members and apps each has
  group        Make, change or delete a group, and set its members and apps
  apps         Every app with whether everyone can open it, how many members have access, its state and what it still needs set
  app          Change an app's listing, who can open it, and its monthly cap in dollars
  cap          The workspace default cap in dollars on every app's provider calls
  usage        What the apps spent in a month: per app (with the cap that binds it), per member and per provider
  activity     The tool-call audit trail, newest first: who called which tool on which app, and what came of it
  audit        The audit log, newest first: every event the Gateway recorded, who did it and what it was about
  tokens       Your personal access tokens for the organization (never a token's value)
  token        Revoke one of your personal access tokens
  connections  Your AI connections to the Gateway: which AI app, which apps it may use, read or write
  connection   Revoke one of your AI connections
  linked-dev   Let owners and admins run `everyapp dev --gateway` against this Gateway's providers (linked dev), or stop it

EXAMPLES
  $ everyapp workspace rename 'Acme Corp'
  $ everyapp workspace users
  $ everyapp workspace role sam@example.com owner
  $ everyapp workspace role sam@example.com member
  $ everyapp workspace invite ann@example.com --role admin
  $ everyapp workspace app access crm --add ann@example.com
  $ everyapp workspace group members Sales --set ann@example.com --set bob@example.com
  $ everyapp workspace usage --month 2026-10 --json

Run everyapp workspace <command> --help for its flags.
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
  everyapp create [--yes] [--json] [--verbose] [<name or path>]
  everyapp create --help

A bare name makes ./<name>; a path (../my-app, ~/apps/my-app) makes the app there,
named after its last part. Each is its own git repository, its pnpm-lock.yaml in
the first commit. Made by everyapp installed from npm, it is pinned to the published
@every-app/sdk and everyapp; made from a checkout, it is linked to that checkout's,
so its deploy runs the checkout's CLI.
Dependencies are installed and the local database is ready, so `pnpm dev` works
straight away. Then: cd into it and `pnpm run deploy`.

Run from a checkout of the EveryApp repository, a bare name goes in apps/<name>
(on the checkout's own packages); a path inside the checkout must be apps/<name>.

Examples:
  everyapp create my-app      ./my-app, its own repository
  everyapp create ~/apps/crm  ~/apps/crm, its own repository

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
| `--mode` | `<value>` | no |  | stub (seeded dev user, default) \| mirror (real login through a local Gateway) \| linked (a real Gateway's services as you; --gateway https://… selects it) |
| `--gateway` | `<value>` | no |  | The Gateway: a real one (https://apps.example.com) links this run to it; a local one (default http://localhost:3000) is mirror mode's |
| `--base-host` | `<value>` | no |  | mirror mode: two-label base host for cookie scope (default everyapp.localhost) |
| `--skip-migrations` | switch | no |  | Start without applying local database migrations |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |

```text
USAGE
  everyapp dev [--port value] [--host value] [--mode value] [--gateway value] [--base-host value] [--skip-migrations] [--json]
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
(browser). Requests straight to the app's internal port get 401 unless they
carry an identity token in x-everyapp-identity: `everyapp dev token` prints one.

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
--gateway https://<your gateway> (linked dev): the app runs here as you,
  and its AI, email, provider, member and event calls go through that
  Gateway, with no provider key on this computer. The first run signs you
  in once in the browser (owners and admins, on a workspace that ran
  `everyapp workspace linked-dev on`); the token lives in
  ~/.config/everyapp/linked-dev.json, never in the app. Calls bill the
  workspace's providers. Data (D1, KV, R2) stays local; the app's own
  secrets still come from .dev.vars. `everyapp dev unlink` signs out.

Ctrl+C stops the app and exits with 130.

FLAGS
     [--port]                                  Gateway port (defaults to $PORT, then 8787)
     [--host]                                  Address the Gateway listens on (default 127.0.0.1; 0.0.0.0 lets other machines in, each as a dev identity)
     [--mode]                                  stub (seeded dev user, default) | mirror (real login through a local Gateway) | linked (a real Gateway's services as you; --gateway https://… selects it)
     [--gateway]                               The Gateway: a real one (https://apps.example.com) links this run to it; a local one (default http://localhost:3000) is mirror mode's
     [--base-host]                             mirror mode: two-label base host for cookie scope (default everyapp.localhost)
     [--skip-migrations/--no-skip-migrations]  Start without applying local database migrations
     [--json/--no-json]                        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
  -h  --help                                   Print help information and exit
      --                                       All subsequent inputs should be interpreted as arguments

COMMANDS
  token   Print a dev identity token for scripts that call the app's dev port
  link    Sign everyapp dev in to a Gateway for this app (linked dev), without running it
  unlink  Sign everyapp dev out of a Gateway for this app: revoke the grant there and forget the token

Run everyapp dev <command> --help for its flags.
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
  everyapp dev token [--role owner|admin|member] [--user email] [--org id] [--app id] [--ttl duration] [--json]
  everyapp dev token --help

Prints an identity token the app accepts while it runs under `everyapp dev`, for
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
  curl -H "x-everyapp-identity: $(everyapp dev token --role member)" http://127.0.0.1:<app port>/api/me
  everyapp dev token --user ana@example.com --role admin --ttl 15m
  everyapp dev token --app my-app --org other-org --json

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

### `everyapp dev link`

Sign everyapp dev in to a Gateway for this app (linked dev), without running it.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL (else EVERYAPP_GATEWAY_URL) |
| `--app` | `<id>` | no |  | The app id (default: everyapp.config.ts's id in this directory) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp dev link [--gateway value] [--app id] [--json] [--verbose]
  everyapp dev link --help

Opens the browser at the Gateway's sign-in: approve everyapp dev, and the token for this
app is kept in ~/.config/everyapp/linked-dev.json (0600). `everyapp dev --gateway <url>`
does the same on its first run; this is for doing the browser step on its own, or again
(a new sign-in replaces the earlier one). Owners and admins who can open the app, on a
workspace with linked dev on (`everyapp workspace linked-dev on`); otherwise the Gateway
says why (LINKED_DEV_REFUSED, OAUTH_REGISTRATION_OFF, OAUTH_OFF).

Examples:
  everyapp dev link --gateway https://apps.example.com

FLAGS
     [--gateway]               The Gateway's URL (else EVERYAPP_GATEWAY_URL)
     [--app]                   The app id (default: everyapp.config.ts's id in this directory)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp dev unlink`

Sign everyapp dev out of a Gateway for this app: revoke the grant there and forget the token.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL (else EVERYAPP_GATEWAY_URL) |
| `--app` | `<id>` | no |  | The app id (default: everyapp.config.ts's id in this directory) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp dev unlink [--gateway value] [--app id] [--json] [--verbose]
  everyapp dev unlink --help

Revokes the linked dev grant at the Gateway (it also disappears from Settings → Connections
there) and removes the token from ~/.config/everyapp/linked-dev.json. If the Gateway can't
be reached the token is still forgotten (warning LINKED_DEV_REVOKE_FAILED): revoke it under
Settings → Connections.

Examples:
  everyapp dev unlink --gateway https://apps.example.com

FLAGS
     [--gateway]               The Gateway's URL (else EVERYAPP_GATEWAY_URL)
     [--app]                   The app id (default: everyapp.config.ts's id in this directory)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp deploy`

Deploy the app in this directory.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--allow-delete-durable-object-data` | switch | no |  | Deploy even though Durable Object classes were removed, deleting their data |
| `--allow-delete-workflows` | switch | no |  | Deploy even though Workflows were removed, deleting them and their instances |
| `--force-dns` | switch | no |  | Publish the app's new hostname even where a DNS record answers it (one at the hostname is replaced) |
| `--enable-email-routing` | switch | no |  | Turn on Email Routing for the domains the app's inbound addresses (everyapp email set --inbound) name that don't route mail yet (locks their MX and SPF records to Cloudflare) |
| `--register-providers` | switch | no |  | Register the providers the app bundles, which tell the Gateway where to send their keys (--yes doesn't) |
| `--no-wait` | switch | no |  | Don't wait for the app to go live (a new hostname's certificate included); the Gateway makes it live within a minute, or on its first visit |
| `--yes` | switch | no |  | With no Gateway yet, install one at apps.<zone> without asking (never registers the providers the app bundles, cf's questions, or the one before replacing a Worker changed outside everyapp) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp deploy [--gateway value] [--account-id value] [--allow-delete-durable-object-data] [--allow-delete-workflows] [--force-dns] [--enable-email-routing] [--register-providers] [--no-wait] [--yes] [--json] [--verbose]
  everyapp deploy --help

Deploys the app in this directory as a private Cloudflare Worker defined by cloudflare.config.ts,
with cf and your Cloudflare login (or CLOUDFLARE_API_TOKEN), in the Gateway's account:
  1. Registers the app in the Gateway's database, which names its Worker, resources and hostname
  2. Creates or links the D1 databases and KV namespaces in everyapp.config.ts
  3. Installs dependencies and builds (cf build, or the manifest's build command), then checks
     the built Worker against the app policy and the drizzle migrations against the schema
  4. Bookmarks the production D1 database, then applies its migrations
  5. Uploads the Worker with its secrets, its helper Workers, its Workflows and the Email
     Routing rules for its inbound addresses (turning routing on for a domain asks first)
  6. Binds a new app on the Gateway by redeploying the live Gateway's own release (never a
     newer one: that is everyapp update), then waits for the app's hostname to go live

No Gateway in any account the login sees, and none named? At a terminal it offers to install one at
apps.<zone> (what everyapp setup does), then deploys; otherwise it stops with action_required
install_gateway and the setup command to run. Nothing else asks first. Install and build
output goes to a log file, never to stdout. Safe to run again: a redeploy of an app the
Gateway already serves never touches the Gateway.

Someone else's published app: everyapp install <url>. To publish this one: everyapp release.
--gateway <url> (or EVERYAPP_GATEWAY_URL) names the Gateway when your login sees several.
With --json, each step is an NDJSON event.

FLAGS
     [--gateway]                                                                 The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
     [--account-id]                                                              The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--allow-delete-durable-object-data/--no-allow-delete-durable-object-data]  Deploy even though Durable Object classes were removed, deleting their data
     [--allow-delete-workflows/--no-allow-delete-workflows]                      Deploy even though Workflows were removed, deleting them and their instances
     [--force-dns/--no-force-dns]                                                Publish the app's new hostname even where a DNS record answers it (one at the hostname is replaced)
     [--enable-email-routing/--no-enable-email-routing]                          Turn on Email Routing for the domains the app's inbound addresses (everyapp email set --inbound) name that don't route mail yet (locks their MX and SPF records to Cloudflare)
     [--register-providers/--no-register-providers]                              Register the providers the app bundles, which tell the Gateway where to send their keys (--yes doesn't)
     [--no-wait/--no-no-wait]                                                    Don't wait for the app to go live (a new hostname's certificate included); the Gateway makes it live within a minute, or on its first visit
  -y [--yes/--no-yes]                                                            With no Gateway yet, install one at apps.<zone> without asking (never registers the providers the app bundles, cf's questions, or the one before replacing a Worker changed outside everyapp)
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
| `--publish` | switch | no |  | In GitHub Actions, publish the release on GitHub: a push to the default branch as v<version>, a v* tag as itself, a manual run as a draft; a pull request publishes nothing |
| `--dry-run` | switch | no |  | With --publish, say which release it would publish, and publish nothing |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp release [--out file] [--publish] [--dry-run] [--json] [--verbose]
  everyapp release --help

Builds the app in this directory as a deploy would (tenant-neutral), checks its Build Output
against the app policy and its migrations against its schema, and packs the release
(default ./everyapp-release.tar.gz) without deploying it: no Gateway and no Cloudflare login,
so it runs in CI. Attach the tarball to a GitHub release of the app's repository, and
everyapp install <repository url> installs it on any Gateway.
With --publish (in the app repository's Release workflow) it then publishes the tarball on
a GitHub release of the repository the run builds, from GITHUB_REPOSITORY, GITHUB_SHA,
GITHUB_EVENT_NAME, GITHUB_REF_* and GITHUB_TOKEN: v<package.json version> on a push to the
default branch (v<version>-<yyyymmdd>-<sha7> when that tag exists), the pushed tag on a v* tag,
a draft on workflow_dispatch, nothing on a pull request. --dry-run plans it and publishes nothing.
With --json, each step is an NDJSON event; done carries the tarball's path and SHA-256
(and the release published).

FLAGS
     [--out]                   Where to write the release (default: ./everyapp-release.tar.gz)
     [--publish/--no-publish]  In GitHub Actions, publish the release on GitHub: a push to the default branch as v<version>, a v* tag as itself, a manual run as a draft; a pull request publishes nothing
     [--dry-run/--no-dry-run]  With --publish, say which release it would publish, and publish nothing
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--yes` | switch | no |  | Run SQL that changes the production database without asking |
| `--json` | switch | no |  | Print one NDJSON done event, its rows in data.results, instead of a table |
| `--verbose` | switch | no |  | Show every step |

```text
USAGE
  everyapp db query [--local] [--file path] [--binding name] [--gateway value] [--account-id value] [--yes] [--json] [--verbose] [<sql>]
  everyapp db query --help

Run SQL against the app's D1 database

Runs against the production database unless --local is set; SQL that changes it is
confirmed first (--yes skips that). Rows print as a table; with --json they are in the
done event's data.results.

EXAMPLES
  $ everyapp db query "select * from todos limit 5"
  $ everyapp db query --local "select count(*) from events"
  $ everyapp db query --file scripts/backfill.sql

FLAGS
     [--local/--no-local]      Query the local database `everyapp dev` uses
     [--file]                  Read the SQL from a file (- for stdin)
     [--binding]               D1 binding to query (default: the migrations binding, or the first)
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
  everyapp db restore [--gateway] [--account-id value] [--yes] [--json] [<app>]
  everyapp db restore --help

Put the app's production database back to before its last migrations

Each deploy that migrates a database with data saves a restore point first (Time Travel).
This restores the last one, after asking: the migrations are undone, and so is anything
written to the database since. --gateway does the same for the Gateway's database, and
runs on a Gateway behind this everyapp (after a failed Gateway migration).

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

### `everyapp teardown`

Delete everything EveryApp created in a dedicated test Cloudflare account, or one named Gateway.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--account-id` | `<id>` | yes |  | The account to empty (required; 32 hex characters, from the dashboard URL dash.cloudflare.com/<id>/…; never read from CLOUDFLARE_ACCOUNT_ID): a dedicated test account, unless --gateway names a named Gateway |
| `--gateway` | `<name>` | no |  | Tear down only this named Gateway and its apps (its name, or its Worker's every-app-gateway-<name>); without it, the default Gateway |
| `--all` | switch | no |  | Tear down every Gateway in the account, the named ones first and the default last (a dedicated test account; not with --gateway) |
| `--confirm` | `<id>` | no |  | The same account id again (with --gateway <name>: every-app-gateway-<name>), for a run without a terminal (--json, a script); at a terminal it is typed instead |
| `--dry-run` | switch | no |  | List what would be deleted and stop; nothing is written |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp teardown (--account-id id) [--gateway name] [--all] [--confirm id] [--dry-run] [--json] [--verbose]
  everyapp teardown --help

For a dedicated test account that live tests install into, over and over: removes every Worker,
Workflow, D1 database, KV namespace, R2 bucket, Hyperdrive config, queue, Vectorize index,
AI Gateway and Secrets Store secret of the default Gateway's names (every-*, but never
another Gateway's: every-app-gateway-<name>... or every-<name>--...), the Gateway's own
included, the two Cloudflare Access applications and the allow policy, the Email Routing
rules that send mail to those Workers (a catch-all drops mail again, and routing is turned
off once no rule and no catch-all of anyone else's needs it), the certificate packs of the
hostnames the Gateway published, and the Custom Domain records (A, AAAA, CNAME) left at
exactly those names. Never the zone, the Workers Paid subscription, the workers.dev
subdomain, the Zero Trust team and its identity providers, a Secrets Store itself, any other
DNS record (MX, TXT, CAA...) even at those names, R2 buckets outside the default
jurisdiction, or anything whose name isn't the Gateway's and that no app recorded.

Without --gateway it is destructive and exists for dedicated test accounts only. The
account must be on the allowlist (EVERYAPP_TEST_ACCOUNTS, or one id per line in
~/.config/everyapp/test-accounts), the run needs CLOUDFLARE_API_TOKEN scoped to that account
alone (a token that sees any other account is refused), and an account on the forbidden
list (EVERYAPP_FORBIDDEN_ACCOUNTS, or one id per line in ~/.config/everyapp/forbidden-accounts)
is refused first, whatever the allowlist says. It reads everything first and shows what it
found; then the account id is typed at the terminal, or passed again with --confirm for a
run without one. There is no --yes.

One account may hold several Gateways. --gateway <name> tears down only that named
Gateway: every-app-gateway-<name> with its OAuth KV and activation queue, its apps
every-<name>--* and their resources, its AI Gateways every-app-gateway-<name>-*, and its
Access applications and policy ("Every App gateway (<name>)" and the like). Nothing of the
default Gateway's or another named one's, which its names never match, so it may run in an
account that holds a production Gateway: the allowlist and the forbidden list aren't read,
CLOUDFLARE_API_TOKEN must still list the account, and the confirmation is the Gateway's
Worker name every-app-gateway-<name>, typed or passed with --confirm, instead of the account
id. --all tears down every Gateway in the account one after another, the named ones first
and the default last, under the test-account guards and the account id's confirmation; it
can't go with --gateway.

Examples:
  EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id> --dry-run
  EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id>
  EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id> --confirm <id> --json
  everyapp teardown --account-id <id> --gateway demo --dry-run
  everyapp teardown --account-id <id> --gateway demo --confirm every-app-gateway-demo --json
  EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id> --all --confirm <id> --json

FLAGS
      --account-id             The account to empty (required; 32 hex characters, from the dashboard URL dash.cloudflare.com/<id>/…; never read from CLOUDFLARE_ACCOUNT_ID): a dedicated test account, unless --gateway names a named Gateway
     [--gateway]               Tear down only this named Gateway and its apps (its name, or its Worker's every-app-gateway-<name>); without it, the default Gateway
     [--all/--no-all]          Tear down every Gateway in the account, the named ones first and the default last (a dedicated test account; not with --gateway)
     [--confirm]               The same account id again (with --gateway <name>: every-app-gateway-<name>), for a run without a terminal (--json, a script); at a terminal it is typed instead
     [--dry-run/--no-dry-run]  List what would be deleted and stop; nothing is written
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp login`

Log in to Cloudflare, or sign in to a Gateway with --gateway.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<url>` | no |  | Sign in to this Gateway instead: its admin API, which the workspace, events, ai and call commands use |
| `--sign-out` | switch | no |  | With --gateway: revoke this machine's sign-in there and forget it |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp login [--gateway url] [--sign-out] [--json] [--verbose]
  everyapp login --help

Log in to Cloudflare

At a terminal, Cloudflare's own login runs (open its link and enter the code). Piped, or
with --json, the link and code are printed and the run waits for the login to be approved.
Already logged in, it says as whom. Unattended runs can set CLOUDFLARE_API_TOKEN and
CLOUDFLARE_ACCOUNT_ID instead.

Sign in to a Gateway (--gateway <url>)

The workspace, events, ai and call commands are the Gateway's own tools, run as you. This
opens the Gateway's consent page in the browser (under --json the link is in a progress
event and the run waits): choose read & write and all apps for the admin commands. The
grant is kept in ~/.config/everyapp/gateways.json (0600) and refreshed when stale; revoke
it under Settings → AI connections there, or with --sign-out. Scripts and CI set
EVERYAPP_TOKEN to a personal access token (Manage workspace → Tokens) instead.

FLAGS
     [--gateway]                 Sign in to this Gateway instead: its admin API, which the workspace, events, ai and call commands use
     [--sign-out/--no-sign-out]  With --gateway: revoke this machine's sign-in there and forget it
     [--json/--no-json]          Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]    Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                     Print help information and exit
      --                         All subsequent inputs should be interpreted as arguments
```

### `everyapp setup`

Install or repair the Gateway.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--domain` | `<value>` | no |  | Where the Gateway lives: any hostname under one of the account's domains, e.g. apps.example.com (asked at a terminal; remembered after that) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, or with none yet, the one to install it in (default: CLOUDFLARE_ACCOUNT_ID, or the only one) |
| `--name` | `<name>` | no |  | A second Gateway in the same Cloudflare account, by name (1 to 16 lowercase letters or digits): its Worker is every-app-gateway-<name> and its apps every-<name>--…; setup finds or installs that one only. Without it, the Gateway is every-app-gateway, as always |
| `--release` | `<value>` | no |  | The Gateway release to deploy: a GitHub repository URL (its latest release) or release page, a release tarball's URL, or a downloaded every-app-gateway-release.tar.gz (default: this checkout's build, or without a checkout, the published release for this everyapp version) |
| `--force-dns` | switch | no |  | Publish new hostnames even where a DNS record answers them (one at a hostname is replaced) |
| `--redeploy` (hidden) | switch | no |  | Upload the Gateway even when it is up to date (after a change in the dashboard, such as a key rotation) |
| `--no-access` | switch | no |  | Leave Cloudflare Access off (not recommended): by default setup puts it in front of the Gateway once the owner exists. Remembered, so a later unattended setup leaves it off too; everyapp access on turns it on |
| `--team` | `<value>` | no |  | The Zero Trust team's name, when the Cloudflare account has none yet: people sign in at <name>.cloudflareaccess.com, and it can't be changed later (ignored once a team exists) |
| `--yes` | switch | no |  | Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, and stream the Gateway's build output to stderr |

```text
USAGE
  everyapp setup [--domain value] [--account-id value] [--name name] [--release value] [--force-dns] [--no-access] [--team value] [--yes] [--json] [--verbose]
  everyapp setup --help

One command from an empty Cloudflare account (Workers Paid) to a working Gateway and its
owner, and the one to run when something is off. Run it again any time: it picks up where it
stopped, and does nothing once everything is there. everyapp update takes a newer Gateway
later (setup does that too, on its way).

A fresh install takes 5 to 20 minutes, most of it waiting for you at the owner link: give it a
long timeout, or run it in the background and watch its output.

  1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and finds the Gateway in
     the login's accounts; with none, picks the account to install it in. A second Gateway
     in the same account (staging, a demo) is --name <name>: every-app-gateway-<name>, with
     its own database, queue and apps (every-<name>--…), beside the first, never touching it
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
     with --yes or --json, done without asking). An account with no Zero Trust team needs
     its name: asked at a terminal, else --team. --no-access leaves it off (not recommended)

The flags people use: --domain, --account-id, and --yes for a script (it answers setup's own
questions; never cf's). With --json each step is an NDJSON event; a run that stops on
something only a person can do exits 2 with action_required.
Then: everyapp create ../my-app, cd into it, everyapp dev, everyapp deploy.
More: https://everyapp.com/docs/gateway

FLAGS
     [--domain]                    Where the Gateway lives: any hostname under one of the account's domains, e.g. apps.example.com (asked at a terminal; remembered after that)
     [--account-id]                The Cloudflare account of the Gateway, or with none yet, the one to install it in (default: CLOUDFLARE_ACCOUNT_ID, or the only one)
     [--name]                      A second Gateway in the same Cloudflare account, by name (1 to 16 lowercase letters or digits): its Worker is every-app-gateway-<name> and its apps every-<name>--…; setup finds or installs that one only. Without it, the Gateway is every-app-gateway, as always
     [--release]                   The Gateway release to deploy: a GitHub repository URL (its latest release) or release page, a release tarball's URL, or a downloaded every-app-gateway-release.tar.gz (default: this checkout's build, or without a checkout, the published release for this everyapp version)
     [--force-dns/--no-force-dns]  Publish new hostnames even where a DNS record answers them (one at a hostname is replaced)
     [--no-access/--no-no-access]  Leave Cloudflare Access off (not recommended): by default setup puts it in front of the Gateway once the owner exists. Remembered, so a later unattended setup leaves it off too; everyapp access on turns it on
     [--team]                      The Zero Trust team's name, when the Cloudflare account has none yet: people sign in at <name>.cloudflareaccess.com, and it can't be changed later (ignored once a team exists)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--release` | `<value>` | no |  | The Gateway release to deploy: a GitHub repository URL (its latest release) or release page, a release tarball's URL, or a downloaded every-app-gateway-release.tar.gz (default: this checkout's build, or without a checkout, the published release for this everyapp version) |
| `--force-dns` | switch | no |  | Publish new hostnames even where a DNS record answers them (one at a hostname is replaced) |
| `--redeploy` (hidden) | switch | no |  | Upload the Gateway even when it is up to date (after a change in the dashboard, such as a key rotation) |
| `--yes` | switch | no |  | Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp update [--account-id value] [--gateway value] [--release value] [--force-dns] [--yes] [--json] [--verbose]
  everyapp update --help

Deploys a newer Gateway over the one your Cloudflare login finds, where it is, keeping its
data, users and apps. It never installs a Gateway: with none, it stops and says to run
everyapp setup. The Gateway comes from --release (a GitHub repository or release URL, a
tarball's URL, or a downloaded every-app-gateway-release.tar.gz); otherwise this checkout's
build when everyapp runs from one; otherwise the published release for this everyapp
version (https://github.com/every-app/every-app, gateway-v<version>).

  1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and finds the Gateway in
     the login's accounts (--account-id when there is one in more than one)
  2. Upgrades it (migrations first, with a restore point). When it runs that Gateway
     already, binds and publishes every registered app if the live Gateway doesn't, and
     otherwise says it is up to date. A live Gateway newer than this one is replaced
     with a warning (GATEWAY_DOWNGRADE): that is how a rollback goes; in a checkout, git pull
     to go forward

A checkout's Gateway is named by its version when it is that version's release (the
gateway-v<version> tag), and by the checkout's commit otherwise.
With --json, each step is an NDJSON event.

FLAGS
     [--account-id]                The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--gateway]                   The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--allow-delete-durable-object-data` | switch | no |  | Deploy even though Durable Object classes were removed, deleting their data |
| `--allow-delete-workflows` | switch | no |  | Deploy even though Workflows were removed, deleting them and their instances |
| `--force-dns` | switch | no |  | Publish the app's new hostname even where a DNS record answers it (one at the hostname is replaced) |
| `--enable-email-routing` | switch | no |  | Turn on Email Routing for the domains the app's inbound addresses (everyapp email set --inbound) name that don't route mail yet (locks their MX and SPF records to Cloudflare) |
| `--register-providers` | switch | no |  | Register the providers the app bundles, which tell the Gateway where to send their keys (--yes doesn't) |
| `--no-wait` | switch | no |  | Don't wait for the app to go live (a new hostname's certificate included); the Gateway makes it live within a minute, or on its first visit |
| `--yes` | switch | no |  | With no Gateway yet, install one at apps.<zone> without asking (never registers the providers the app bundles, cf's questions, or the one before replacing a Worker changed outside everyapp) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp install [--gateway value] [--account-id value] [--allow-delete-durable-object-data] [--allow-delete-workflows] [--force-dns] [--enable-email-routing] [--register-providers] [--no-wait] [--yes] [--json] [--verbose] <source>
  everyapp install --help

Installs an app release on your Gateway with no checkout of the app, as everyapp deploy
would from the app's directory, with nothing to build: <source> is a GitHub repository URL
(the everyapp-release.tar.gz on its latest release; …/releases/tag/<tag> for that one), a
tarball's HTTPS URL, or a downloaded everyapp-release.tar.gz. The release holds the app's
tenant-neutral Build Output, migrations and manifest, checked against its SHA-256. Run it
again later to update the app. Its settings are set with everyapp configure <id>;
.everyapp/secrets.env in this directory is the deploy's own file, read only for a Hyperdrive
app's database URL.

A repository without a release is never built from its URL: clone it, run pnpm
install in it, then everyapp deploy from its directory. Postgres migrations
need the app's source, so their releases are refused.

No Gateway in any account the login sees, and none named? At a terminal it offers to install one at
apps.<zone> (what everyapp setup does, owner link included), then installs the app; otherwise
it stops with action_required install_gateway and the setup command to run.
--gateway <url> (or EVERYAPP_GATEWAY_URL) names the Gateway when your login sees several.
With --json, each step is an NDJSON event.

FLAGS
     [--gateway]                                                                 The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
     [--account-id]                                                              The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--allow-delete-durable-object-data/--no-allow-delete-durable-object-data]  Deploy even though Durable Object classes were removed, deleting their data
     [--allow-delete-workflows/--no-allow-delete-workflows]                      Deploy even though Workflows were removed, deleting them and their instances
     [--force-dns/--no-force-dns]                                                Publish the app's new hostname even where a DNS record answers it (one at the hostname is replaced)
     [--enable-email-routing/--no-enable-email-routing]                          Turn on Email Routing for the domains the app's inbound addresses (everyapp email set --inbound) name that don't route mail yet (locks their MX and SPF records to Cloudflare)
     [--register-providers/--no-register-providers]                              Register the providers the app bundles, which tell the Gateway where to send their keys (--yes doesn't)
     [--no-wait/--no-no-wait]                                                    Don't wait for the app to go live (a new hostname's certificate included); the Gateway makes it live within a minute, or on its first visit
  -y [--yes/--no-yes]                                                            With no Gateway yet, install one at apps.<zone> without asking (never registers the providers the app bundles, cf's questions, or the one before replacing a Worker changed outside everyapp)
     [--json/--no-json]                                                          Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]                                                    Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                                                                     Print help information and exit
      --                                                                         All subsequent inputs should be interpreted as arguments

ARGUMENTS
  source  The app release to install: a GitHub repository URL (its latest release), a release tarball's URL, or a downloaded everyapp-release.tar.gz
```

### `everyapp deploy-token add`

Give the Gateway its own Cloudflare token, so it installs apps itself.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp deploy-token add [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp deploy-token add --help

Says what to pick, then opens Cloudflare's page for a new account API token when you press
Enter (No prints its link), its name and every permission the installer uses filled in
(Workers Scripts, D1, Workers KV, R2, Queues, Hyperdrive, Vectorize, AI Gateway, Secrets
Store, Access apps, Email Routing Rules and Zone Settings edit; DNS and Zone read). Create it
and paste it at the hidden prompt: it is stored on the Gateway as CF_DEPLOY_TOKEN, with
BROWSER_APP_INSTALLS=on. Owners and admins then install apps from Admin → Apps → Install app,
or a Deploy to EveryApp button, without running deployment commands.

A Gateway that has a token keeps it: run again, this only turns installs back on.
To replace the token: everyapp deploy-token remove, then add.

Examples:
  everyapp deploy-token add
  everyapp deploy-token add --gateway https://apps.example.com

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp deploy-token remove`

Take the Gateway's Cloudflare token off it, so it no longer installs apps itself.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--yes` | switch | no |  | Remove the token without asking |
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp deploy-token remove [--yes] [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp deploy-token remove --help

Removes CF_DEPLOY_TOKEN and BROWSER_APP_INSTALLS from the Gateway in one change. The apps
it installed keep running. The token works until you delete it in Cloudflare (Manage
account → Account API tokens). Asks first.

Example:
  everyapp deploy-token remove

FLAGS
  -y [--yes/--no-yes]          Remove the token without asking
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp configure`

Set up an app: asks for each setting it needs, required ones first, then the optional ones.

| Argument | Required | What it is |
| --- | --- | --- |
| `<app>` | no | The app to configure (default: the app in this directory) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--from-env` | switch | no |  | Take each unset setting's value, optional ones too, from the environment variable of its name (DATAFORSEO_API_KEY from $DATAFORSEO_API_KEY); a set name is never replaced; stdin isn't read; the rest are asked for at a terminal |
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp configure [--from-env] [--gateway value] [--account-id value] [--json] [--verbose] [<app>]
  everyapp configure --help

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
  everyapp configure crm
  everyapp configure                       (in the app's directory)
  everyapp configure crm --from-env --json
  printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY" | everyapp configure crm --json

One setting at a time, by name: everyapp secret set <NAME> [--app <id>]

FLAGS
     [--from-env/--no-from-env]  Take each unset setting's value, optional ones too, from the environment variable of its name (DATAFORSEO_API_KEY from $DATAFORSEO_API_KEY); a set name is never replaced; stdin isn't read; the rest are asked for at a terminal
     [--gateway]                 The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp status [--account-id value] [--gateway value] [--json] [--verbose]
  everyapp status --help

One screen, all of it from the Gateway's D1 database and cf, nothing asked of the Gateway:
its URL and release (and whether this checkout builds it), its owner, the apps its registry
lists and whether the live Gateway binds them, each hostname's certificate, any deploy in
progress, and what to run when something is off. With --json, the `done` event's data has
all of it, `fixes` included: the one state query an agent needs. An account with several
Gateways: --gateway <url|name> says which.

FLAGS
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--purge` | switch | no |  | Also delete the app's Worker and helper Workers, D1 databases, KV namespaces, Workflows and Email Routing routes |
| `--yes` | switch | no |  | Delete without asking (with --purge too, without typing the app id) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp delete [--gateway value] [--account-id value] [--purge] [--yes] [--json] [--verbose] [<id>]
  everyapp delete --help

Deletes the app in the Gateway's D1 database (its name stays reserved; deploy it again to
bring it back) and removes its Gateway binding and hostname, with a redeploy of the Gateway
from this checkout.
The app's Worker and data are kept unless --purge, which deletes them for good.
Asks first at a terminal; elsewhere it needs --yes.

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--team` | `<name>` | no |  | Name for a new Zero Trust team when the account has none: its sign-in page is <name>.cloudflareaccess.com, for good (asked at a terminal; ignored once a team exists) |
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp access on [--team name] [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp access on --help

Everyone opens the Gateway and its apps through Cloudflare Access first (Sign in with
Cloudflare for members of your Cloudflare account, a one-time PIN emailed to everyone else),
then lands signed in. With your Cloudflare login it finds or creates the Zero Trust team,
adds those two sign-in methods, keeps one allow policy whose rule asks the Gateway whether
the person is a member or invited, puts one Access application in front of the Gateway's
host and one in front of the apps' hosts (MCP, the OAuth endpoints and each app's public
routes stay reachable without a login), and gives the Gateway the team domain and both AUD
tags in one change.

Invitations need nothing more: an invitee gets past Access as soon as they are invited.
Run it again after deploying an app with new public routes, or after anything changed by
hand. It changes only what differs and leaves alone what it didn't set up.

Examples:
  everyapp access on
  everyapp access on --team acme --json

FLAGS
     [--team]                  Name for a new Zero Trust team when the account has none: its sign-in page is <name>.cloudflareaccess.com, for good (asked at a terminal; ignored once a team exists)
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp access off`

Turn Cloudflare Access off for the Gateway and its apps.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--yes` | switch | no |  | Turn Access off without asking |
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp access off [--yes] [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp access off --help

Removes CLOUDFLARE_ACCESS_AUD, CLOUDFLARE_ACCESS_APPS_AUD and CLOUDFLARE_ACCESS_TEAM_DOMAIN
from the Gateway in one change, so it stops requiring Access at once, then deletes the
two Access applications (one that also covers something else only loses EveryApp's hosts).
The Zero Trust team, its identity providers and the allow policy stay: other applications may
use them. Asks first.

Example:
  everyapp access off

FLAGS
  -y [--yes/--no-yes]          Turn Access off without asking
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp access show`

Show how Cloudflare Access fronts the Gateway.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp access show [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp access show --help

The Zero Trust team, whether the allow policy asks the Gateway who is a member, the sign-in
methods, the two Access applications, and which Access settings the Gateway has (their
values can't be read back). Nothing is changed.

Example:
  everyapp access show

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp signin add [--client-id value] [--client-secret-from-env VAR] [--issuer url] [--label text] [--tenant value] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp signin add --help

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
client). An optional setting not given stays as it is; everyapp secret unset <NAME>
removes one. The everyapp skill's setup/signin-<id>.md walks through each provider's
console.

Examples:
  everyapp signin add google
  everyapp signin add github --client-id Iv1.0123456789abcdef --client-secret-from-env GITHUB_SECRET --json
  everyapp signin add microsoft --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47
  everyapp signin add oidc --issuer https://acme.okta.com --label Okta

FLAGS
     [--client-id]               The OAuth app's client id (not a secret; for apple, the Services ID)
     [--client-secret-from-env]  Read the client secret from this environment variable (a secret never goes on the command line)
     [--issuer]                  oidc: the issuer's https URL, which serves /.well-known/openid-configuration
     [--label]                   oidc: the button text after "Continue with" (default SSO; 40 characters at most)
     [--tenant]                  microsoft: the Directory (tenant) ID that pins sign-in to your own directory (recommended), or common, organizations, consumers
     [--gateway]                 The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp signin list [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp signin list --help

Reads which of each provider's settings the Gateway Worker holds (names only: a value
can't be read back) and says whether the provider is on (every required setting set),
needs setup (some set, the rest named; the Gateway keeps it off rather than half
configured) or off. A value that is set but malformed also keeps a provider off; the
Gateway's log says so (signin.config_problem). Nothing is changed.

Example:
  everyapp signin list

ALIASES
  everyapp signin ls

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp signin show [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp signin show --help

The provider's console and what the OAuth app is called there, the redirect URL to
register for this Gateway, the scopes asked for (identity only), which claim becomes
the email and when it counts as verified, every setting with what it holds and whether
it is set, the provider's caveats and its setup guide. Nothing is changed.

Example:
  everyapp signin show apple

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp signin remove [--yes] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp signin remove --help

Asks first (--yes doesn't), then removes every setting of the provider from the Gateway
Worker in one new version: the button leaves the sign-in page on the next request.
People who signed in with it keep their accounts and sign in another way (a password
via Forgot password, another provider, Access). Delete the OAuth app at the provider
too: a client the Gateway no longer holds is still a client.

Example:
  everyapp signin remove github

FLAGS
     [--yes/--no-yes]          Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp)
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show which Worker each secret goes to and its new version |

```text
USAGE
  everyapp secret set [--from-env VAR] [--app id] [--gateway value] [--account-id value] [--json] [--verbose] <name>...
  everyapp secret set --help

Gateway settings (AI provider keys, EMAIL_FROM, sign-in clients) go to the Gateway, from any
directory. Other names go to the app in this directory, or with --app <id> to that app from
anywhere; the app's everyapp.config.ts must list them under secrets. Values come from a
hidden prompt, --from-env or stdin, never the command line. Changes are live at once; no
deploy needed.

Examples:
  everyapp secret set OPENAI_API_KEY
  everyapp secret set GITHUB_TOKEN --from-env GITHUB_TOKEN
  echo "$STRIPE_KEY" | everyapp secret set STRIPE_KEY
  everyapp secret set MAIN_SECRET --app analytics

See what an app needs and what is set: everyapp secret list [<app>]

FLAGS
     [--from-env]              Read the value from this environment variable
     [--app]                   The app whose secret this is (default: the app in this directory)
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout (never asks) |
| `--verbose` | switch | no |  | Show which Worker each secret is removed from |

```text
USAGE
  everyapp secret unset [--yes] [--app id] [--gateway value] [--account-id value] [--json] [--verbose] <name>...
  everyapp secret unset --help

Names go where `secret set` sends them (--app <id> names the app from anywhere). Asks before
removing; the change is live at once.

Example:
  everyapp secret unset GITHUB_TOKEN

FLAGS
  -y [--yes/--no-yes]          Remove without asking
     [--app]                   The app whose secret this is (default: the app in this directory)
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print the result as an NDJSON event |
| `--verbose` | switch | no |  | Also list the names everyapp sets itself |

```text
USAGE
  everyapp secret list [--gateway value] [--account-id value] [--json] [--verbose] [<app>]
  everyapp secret list --help

For one app (the app in this directory, or <app> from anywhere): every setting its manifest
declares, where it is held (the Gateway, or the app's Worker), whether it is set, and the one
command that opens the app when something required is missing (everyapp configure <app>).
Elsewhere with no app named: the Gateway's names and who set them, then every app's
settings. Names only, never values.

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp provider add [--replace] [--oauth preset] [--client-id id] [--from-env] [--gateway value] [--account-id value] [--json] [--verbose] [<provider>]
  everyapp provider add --help

Says the one thing to do at the provider (create a key, or register the redirect URI and
make an OAuth client), links its page on everyapp.com, then asks for the key or client at
hidden prompts and sets it on the Gateway as secret set would. Live at once; no deploy.

Nobody at a terminal (--json, piped, CI), or Enter on nothing: nothing is set, and it prints
the one command to run next:
  everyapp secret set OPENROUTER_API_KEY
Scripts and agents set it in the same run with --from-env (the variables of the settings'
names) or piped NAME=value lines; never on the command line.

A built-in provider (provider list names them) is only its key; an OAuth client
(google-workspace, slack, microsoft-365) its client. An OAuth preset (provider
presets: github-oauth) becomes a registered provider. Any other API is a spec: its id, name,
the page the key comes from (docs), the only hosts the key is ever sent to and how (auth:
bearer, header, query or basic), naming the Gateway setting that holds the key. The spec
never holds the key. A URL is fetched on this machine. The rules a spec must pass: an id
that isn't a built-in provider's, settings named after the id that nothing else reads, and
public hosts that aren't the Gateway's own or its apps'. Run in an app's directory, it also
writes .everyapp/providers/<id>.json for everyapp dev (your key goes in .dev.vars).

An OpenAI-compatible model provider is a spec with mode "ai": its baseUrl, the key's
placement (auth), the models it serves and the defaultModel (embeddingsModel too, when it has
one); the AI proxy serves it as a catalog AI provider, inference POSTs alone. Apps list it
under providers and call /api/ai/<id>/v1/chat/completions; everyapp ai default <id> makes
it the Gateway's default model provider.

--oauth takes an OAuth spec file (auth.kind oauth2-user), or a preset or built-in client by
name. Apps list the provider's own scopes in everyapp.config.ts; people connect in each app.
--verbose adds the manifest entry.

Examples:
  everyapp provider add google-workspace
  everyapp provider add openrouter
  OPENROUTER_API_KEY=sk-or-... everyapp provider add openrouter --from-env
  everyapp provider add github-oauth
  printf 'GITHUB_OAUTH_CLIENT_SECRET=%s\n' "$SECRET" | everyapp provider add github-oauth --client-id Iv1.abc
  everyapp provider add stripe.json
  everyapp provider add https://example.com/providers/stripe.json --replace
  everyapp provider add --oauth ./acme.json --from-env

FLAGS
     [--replace/--no-replace]    Replace the provider registered under the spec's id; its key must be set again
     [--oauth]                   An OAuth provider: a preset (provider presets names them: github-oauth), a built-in client (google-workspace), or a JSON spec file with auth.kind oauth2-user
     [--client-id]               An OAuth provider's client id (public); the secret comes from the prompt, piped NAME=value lines or --from-env
     [--from-env/--no-from-env]  Set the key or client from the environment variables of its setting names (OPENROUTER_API_KEY; GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET); nothing is asked
     [--gateway]                 The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp provider list [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp provider list --help

Nothing is changed. A key's value can't be read back; only whether it is set, and for a
registered provider whether it was set for the hosts the row names now (bound).

Example:
  everyapp provider list

ALIASES
  everyapp provider ls

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp provider show [--save] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp provider show --help

What an agent reads to set up and call a provider without a setup guide. With --save, in an
app's directory, the spec is written where everyapp dev reads it.

Examples:
  everyapp provider show stripe
  everyapp provider show stripe --save

FLAGS
     [--save/--no-save]        Also write the spec to .everyapp/providers/<id>.json in this app's directory, for everyapp dev
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp provider remove [--force] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp provider remove --help

The Gateway stops serving it within 30 seconds. A provider a deployed app lists under
capabilities is refused unless --force. The Gateway setting holding its key stays; remove
it with everyapp secret unset <NAME>. Registering it again needs the key set again too.

Example:
  everyapp provider remove stripe

ALIASES
  everyapp provider rm

FLAGS
     [--force/--no-force]      Remove it even though deployed apps list it (their calls to it stop)
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
  everyapp provider presets [--json] [--verbose]
  everyapp provider presets --help

Each with its API hosts and the console where its client is made. Apps list the
provider's own scopes in everyapp.config.ts. Nothing is read from the Gateway.

Example:
  everyapp provider presets

FLAGS
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp provider connections`

List the accounts people connected to OAuth providers in each app on the Gateway.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--all` | switch | no |  | Every organization's connections (default: the Gateway's own organization's) |
| `--user` | `<email>` | no |  | One person's connections |
| `--provider` | `<id>` | no |  | One provider's connections |
| `--app` | `<app>` | no |  | One app's connections, by its id: openmail |
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp provider connections [--all] [--user email] [--provider id] [--app app] [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp provider connections --help

A connection is one person's, in one app: who connected what, in which app, with the scopes
granted, the status and when it was last used. Never a token.

Examples:
  everyapp provider connections
  everyapp provider connections --provider github-oauth
  everyapp provider connections --user ben@example.com
  everyapp provider connections --app openmail

FLAGS
     [--all/--no-all]          Every organization's connections (default: the Gateway's own organization's)
     [--user]                  One person's connections
     [--provider]              One provider's connections
     [--app]                   One app's connections, by its id: openmail
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp provider disconnect`

Remove people's connections to an OAuth provider from the Gateway.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The OAuth provider's id: github-oauth |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--user` | `<email>` | no |  | This person's connection |
| `--all` | switch | no |  | Every connection to the provider |
| `--app` | `<app>` | no |  | Only the connections made in this app, by its id: openmail |
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp provider disconnect [--user email] [--all] [--app app] [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp provider disconnect --help

The Gateway drops the tokens it held; the app gets "not connected" until the person
connects again in it. --user removes that person's connections in every app, --app narrows
it to one app. The CLI holds no token, so the grant stays at the provider until it is
revoked there (Disconnect in Connected accounts revokes it from the Gateway).

Examples:
  everyapp provider disconnect github-oauth --user ben@example.com
  everyapp provider disconnect google-workspace --user ben@example.com --app openmail
  everyapp provider disconnect github-oauth --all

FLAGS
     [--user]                  This person's connection
     [--all/--no-all]          Every connection to the provider
     [--app]                   Only the connections made in this app, by its id: openmail
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The OAuth provider's id: github-oauth
```

### `everyapp provider on` (hidden)

Same as everyapp mcp on; this alias goes after launch week.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The MCP app (mcp list names them): dataforseo |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text

```

### `everyapp provider off` (hidden)

Same as everyapp mcp off; this alias goes after launch week.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The MCP app (mcp list names them): dataforseo |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text

```

### `everyapp ai show`

What the workspace's default model resolves to now, and every provider it could be.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp ai show [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp ai show --help

The provider and model an app that asks for the default chat model gets (ai: { chat: true }
in its manifest): the setting (ai default) if there is one, else the first provider of the
shipped order whose key is set (OpenRouter, Workers AI, OpenAI, Anthropic, Groq, Mistral,
Gemini), else what to set. Then every provider the default could be, in order, each with its
key set or not and its catalog models; never a key's value. Says whether calls go through
Cloudflare AI Gateway (ai gateway on). The Gateway tool: everyapp_ai_show, run as you.

Example:
  everyapp ai show

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp ai default`

Choose the default model (provider and model) for every app that asks for one, or off for the shipped order.

| Argument | Required | What it is |
| --- | --- | --- |
| `<provider[/model]\|off>` | yes | The provider's id (openrouter), or the id and a model (openrouter/anthropic/claude-sonnet-5.5), or off |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp ai default [--gateway value] [--account-id value] [--json] [--verbose] <provider[/model]|off>
  everyapp ai default --help

The workspace's one AI setting, the same as Manage workspace → Usage → AI default. The
provider id is everything up to the first slash, the model everything after it (a model id
may hold slashes); without a model, the provider's catalog model serves. Embeddings always
use the provider's catalog model. A provider whose key isn't set is accepted; one the
default can't be (an API provider, an entry without an OpenAI-shaped chat route, AI
Gateway) is refused by the Gateway. The Gateway reads the change within 30 seconds; a
change queues ai.default_changed. The Gateway tool: everyapp_ai_default, run as you.

Examples:
  everyapp ai default openrouter
  everyapp ai default openrouter/anthropic/claude-sonnet-5.5
  everyapp ai default workers-ai --json
  everyapp ai default off

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp ai gateway on [--id id] [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp ai gateway on --help

Finds the AI Gateway in the Gateway's Cloudflare account (or makes it, logs on, no cache)
and records its id as the Gateway setting AI_GATEWAY_ID. From the Gateway's next request
every call to a model provider that AI Gateway fronts (OpenRouter, OpenAI, Anthropic, Groq,
Mistral, Workers AI) goes through it with the provider's own key still on the call; Gemini
and Cohere go direct. Changes no app and no key. For an authenticated gateway, set its
token afterwards: everyapp secret set AI_GATEWAY_API_KEY.

Examples:
  everyapp ai gateway on
  everyapp ai gateway on --id acme-models

FLAGS
     [--id]                    The AI Gateway's id (its name in the dashboard): lowercase letters, digits and single hyphens; everyapp by default
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp ai gateway off [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp ai gateway off --help

Unsets AI_GATEWAY_ID on the Gateway; every model call goes direct from its next request.
The AI Gateway and its logs stay in the account. AI_GATEWAY_API_KEY stays until everyapp secret unset.

Example:
  everyapp ai gateway off

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp mcp add [--name value] [--auth none|bearer|header|basic|oauth] [--header value] [--secret value] [--risk annotations|read|write] [--description value] [--from-env VAR] [--gateway value] [--account-id value] [--json] [--verbose] <url>
  everyapp mcp add --help

The Gateway serves the server's tools on its own /mcp under <id>_<tool> names, holding the
server's credential itself: every call is attributed to the member, audited, counted and
capped like an app's, and read tools are told apart from write tools (a read-only
connection sees only the read ones). The owners and the admins can use it at once; an
admin grants others in Admin → Apps → Manage access. Nothing is deployed.

The credential is a Gateway setting named <ID>_MCP_TOKEN (--secret picks another name
ending in _MCP_TOKEN), pinned to the URL's origin when it is set: the Gateway never sends
it anywhere else. At a terminal, add offers to set it right away (hidden input, as secret
set asks); --from-env VAR sets it from an environment variable; otherwise, afterwards:
  everyapp secret set TREG_MCP_TOKEN

--auth bearer sends Authorization: Bearer <value>; header sends <header>: <value>; basic
takes user:password; none sends nothing. oauth is recorded but not served yet: the Gateway
doesn't sign in to MCP servers with OAuth this week.

add looks at the URL once from this machine, without the credential, and says what it
found (MCP, a 401, a redirect, or nothing); that is a warning, never a refusal, since the
Gateway, not this machine, is what fetches it. The Gateway follows no redirects.

Examples:
  everyapp mcp add https://mcp.deepwiki.com/mcp
  everyapp mcp add https://treg.to/mcp/ --auth bearer
  everyapp mcp add https://api.example.org/mcp --name example --auth header --header X-Api-Key --risk read

FLAGS
     [--name]                  The app's id and tool prefix (default: from the URL's host, https://mcp.treg.to/mcp → treg)
     [--auth]                  How the Gateway authenticates to the server (default: none; bearer with --secret, header with --header)                                                                                                                                                                          [none|bearer|header|basic|oauth]
     [--header]                With --auth header: the header the server reads the credential from (X-Api-Key)
     [--secret]                The Gateway setting holding the credential, ending in _MCP_TOKEN (default: <ID>_MCP_TOKEN)
     [--risk]                  How a tool's risk is decided: from the server's hints, unknown as write (annotations, the default), or every tool read or write                                                                                                                                                  [annotations|read|write]
     [--description]           What the app is for, as Admin → Apps and everyapp_list_apps say it (default: from the URL)
     [--from-env]              Set the credential from this environment variable once the app is added (as secret set --from-env)
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp mcp remove [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp mcp remove --help

Like deleting an app: the Gateway stops serving its tools within 30 seconds, and
everyone's access to it, the personal tokens bound to it, its tools snapshot and its
place in AI connections go with it. Adding it again starts fresh. To stop serving it
and keep all that, turn it off instead: everyapp mcp off <id>.

The Gateway setting holding its key or credential stays, and so does a credential's pin
to its origin; everyapp secret unset <NAME> removes both.

Example:
  everyapp mcp remove treg

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp mcp on [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp mcp on --help

An MCP app is a data provider (DataForSEO, built in) or any remote MCP server added with
everyapp mcp add <url>, offered as an app of the Gateway's own with no page and nothing to
deploy: the Gateway serves its tools on its /mcp under <id>_<tool> names, with its own key,
and counts and audits every call like an app's. It appears in Admin → Apps and under MCP
apps on the home page.

A built-in's first on adds it: the owners and the admins can use it at once, and an
admin grants other members with Manage access. On after off serves it again at once,
with everyone's access kept. The key is a Gateway setting the tools need (mcp list names
it):
  everyapp secret set DATAFORSEO_API_KEY

Safe to repeat: an app that is on stays on, with its access.

Examples:
  everyapp mcp on dataforseo
  everyapp mcp on treg --json

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp mcp off [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp mcp off --help

The Gateway stops serving the app's tools within 30 seconds and the home page stops
listing it. Everyone's access, the personal tokens bound to it and its tools snapshot
are kept, so everyapp mcp on <id> serves it again at once. To remove it for good, with
all of that: everyapp mcp remove <id>.

(Until 2026-10-25 off removed the app; that is remove now.)

Example:
  everyapp mcp off dataforseo

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp mcp list [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp mcp list --help

Nothing is changed. A key's value can't be read back; only whether it is set.

Example:
  everyapp mcp list

ALIASES
  everyapp mcp ls

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp mcp show [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp mcp show --help

For a remote server: the URL, how the Gateway authenticates, the credential's name, whether
it is set and the origin it is pinned to, the risk default, when the tools were last listed
(and the error if that failed), then every tool the server listed: its name on the Gateway,
the server's own name, its risk and where that comes from (the server's hint, the app's
default, your override), and whether it is on. Nothing is changed.

Examples:
  everyapp mcp show treg
  everyapp mcp show dataforseo --json

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp mcp refresh [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp mcp refresh --help

Only the snapshot goes (the Gateway's copy of the tool list); the app, its access and its
settings stay. The Gateway lists the tools again on the next request to its /mcp, or
within the hour. Use it after the server changed its tools.

Example:
  everyapp mcp refresh treg

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--risk` | `read`, `write`, `annotations` | no |  | The tool's risk: read or write; annotations drops your override |
| `--on` | switch | no |  | List the tool (the default) |
| `--off` | switch | no |  | Leave the tool out: it isn't listed, and a call answers Unknown tool |
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp mcp tool [--risk read|write|annotations] [--on] [--off] [--gateway value] [--account-id value] [--json] [--verbose] <id> <tool>
  everyapp mcp tool --help

A tool's risk decides who can call it: read tools every connection, write tools only
read & write ones; --off keeps a tool from every AI client. The server's hints decide it
unless the app's --risk default or this override says otherwise. The Gateway lists the
tools again on first use. A built-in MCP app's tools are its own and can't be changed
here.

Examples:
  everyapp mcp tool treg delete_everything --off
  everyapp mcp tool treg get_report --risk read
  everyapp mcp tool treg search --risk annotations

FLAGS
     [--risk]                  The tool's risk: read or write; annotations drops your override                                                                                                                                                                                                                  [read|write|annotations]
     [--on/--no-on]            List the tool (the default)
     [--off/--no-off]          Leave the tool out: it isn't listed, and a call answers Unknown tool
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
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
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
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
     [--gateway]                                         The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
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
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp events add [--events types]... [--name text] [--email owners|admins] [--secret] [--secret-from-env VAR] [--gateway value] [--account-id value] [--json] [--verbose] [<url>]
  everyapp events add --help

A webhook gets each event as a JSON POST, signed with the subscription's secret:
X-EveryApp-Signature: t=<seconds>,v1=<hex>, HMAC-SHA256 over <t>.<body>; the receiver checks
it (/docs/events has the code). Without --secret one is made and shown once: copy it then.
Slack's Workflow Builder, Zapier, n8n, Make and your own endpoint all take one; the body's
top-level summary is a line a person reads.

The URL must be https:// on a public hostname: not an IP address, not a local or internal
name, not the Gateway or one of its apps. For a receiver on a private network, set
EVENTS_ALLOW_PRIVATE_TARGETS on the Gateway with the value "true" (self-host only;
everyapp secret set EVENTS_ALLOW_PRIVATE_TARGETS): then http://, IP addresses and private names are let through.

--email mails each event to the organization's owners (owners) or owners and admins
(admins), from the Gateway's sender (EMAIL_FROM); it takes no address. An organization has at
most 25 subscriptions. The Gateway sends each event within a minute.

Examples:
  everyapp events add https://hooks.example.com/everyapp --events cap.*,member.*
  everyapp events add https://hooks.zapier.com/hooks/catch/1/abc --name Zapier --secret
  everyapp events add --email admins --events cap.*
  everyapp events add https://n8n.example.com/webhook/x --secret-from-env N8N_SECRET --json

FLAGS
     [--events]...             The events to send, comma separated: types (member.joined), prefixes (cap.*, app.crm.*) or * (repeat to add more; default: every event but test pings)
     [--name]                  What to call it, like 'Slack #ops' (default: the URL's host, or Email owners and admins)
     [--email]                 Mail each event to the organization's owners, or its owners and admins (admins), instead of a webhook                                                                                 [owners|admins]
     [--secret/--no-secret]    Give the webhook's signing secret yourself, 16 to 128 characters: asked at a hidden prompt, or read piped in, never typed on the command line (default: one is made and shown once)
     [--secret-from-env]       Read the signing secret from this environment variable
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp events list [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp events list --help

A webhook shows its URL's host and path (never its query or secret); an email one, whom it
mails. Nothing is changed.

Example:
  everyapp events list

ALIASES
  everyapp events ls

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp events remove [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp events remove --help

Nothing more is delivered to it; its delivery log stays for 30 days. The Gateway's built-in
cap alerts are disabled instead of removed, so the Gateway never makes them again.

Example:
  everyapp events remove sub_0123456789abcdef01234567

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp events enable [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp events enable --help

What happened while it was disabled isn't sent. Safe to repeat.

Example:
  everyapp events enable sub_0123456789abcdef01234567

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp events disable [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp events disable --help

Turn the built-in cap alerts off this way. Safe to repeat; events enable resumes it.

Example:
  everyapp events disable sub_0123456789abcdef01234567

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp events test [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp events test --help

Sends a ping to that subscription only, paused or not, and waits for the first attempt:
delivered or failed with the receiver's status code or the error. A failed test is retried
like any delivery.

Examples:
  everyapp events test sub_0123456789abcdef01234567
  everyapp events test sub_0123456789abcdef01234567 --json

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--limit` | `<n>` | no |  | How many to show, newest first: 1 to 100 (default 20) |
| `--before` | `<cursor>` | no |  | The next page: the previous page's nextBefore |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp events deliveries [--dead] [--limit n] [--before cursor] [--gateway value] [--account-id value] [--json] [--verbose] [<id>]
  everyapp events deliveries --help

A delivery is retried after 1, 5 and 30 minutes, then 2, 8 and 24 hours; the seventh failure
is dead. Nothing is changed.

Examples:
  everyapp events deliveries
  everyapp events deliveries sub_0123456789abcdef01234567 --limit 50
  everyapp events deliveries --dead

FLAGS
     [--dead/--no-dead]        Only deliveries that ran out of attempts (dead), to redeliver
     [--limit]                 How many to show, newest first: 1 to 100 (default 20)
     [--before]                The next page: the previous page's nextBefore
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp events redeliver [--gateway value] [--account-id value] [--json] [--verbose] <delivery>
  everyapp events redeliver --help

Its attempts start over at 0. A delivered one is left alone. The receiver may get the same
event id again: receivers deduplicate on it.

Example:
  everyapp events redeliver dlv_0123456789abcdef01234567

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
  everyapp events types [--json] [--verbose]
  everyapp events types --help

The catalogue this CLI knows, and how a pattern names several (member.*, app.crm.*, *). No
Gateway is needed.

Example:
  everyapp events types

FLAGS
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workspace show`

The organization: your role, whether it can send mail, and how many members, invitations, groups and apps it has.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace show [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp workspace show --help

Example:
  everyapp workspace show --json

The Gateway tool: everyapp_workspace_show (everyapp call everyapp_workspace_show).

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace rename [--gateway value] [--account-id value] [--json] [--verbose] <name>
  everyapp workspace rename --help

Examples:
  everyapp workspace rename 'Acme Corp'
  everyapp workspace rename 'Acme Corp' --json

The Gateway tool: everyapp_workspace_rename (everyapp call everyapp_workspace_rename).

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace users [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp workspace users --help

Example:
  everyapp workspace users

The Gateway tool: everyapp_workspace_users (everyapp call everyapp_workspace_users).

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `<email>` | yes | The member, by email or user id |
| `<owner\|admin\|member>` | yes | The role to give them |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace role [--gateway value] [--account-id value] [--json] [--verbose] <email> <owner|admin|member>
  everyapp workspace role --help

The Gateway's rules: only an owner changes an admin or an owner, or makes one; nobody
changes their own role; the last owner is never demoted.

Examples:
  everyapp workspace role sam@example.com owner
  everyapp workspace role sam@example.com member --json

The Gateway tool: everyapp_workspace_role (everyapp call everyapp_workspace_role).

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  email               The member, by email or user id
  owner|admin|member  The role to give them
```

### `everyapp workspace invite`

Invite someone by email: the Gateway mails the invitation when it can send email.

| Argument | Required | What it is |
| --- | --- | --- |
| `<email>` | yes | The address to invite |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--role` | `member`, `admin` | no | `member` | The role they join with |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace invite [--role member|admin] [--gateway value] [--account-id value] [--json] [--verbose] <email>
  everyapp workspace invite --help

The answer says whether it was mailed. The tool never returns the link: where the Gateway
sends no email, everyapp workspace invite-link <email> prints one (under your Cloudflare login),
or copy it from Admin → Users.

Examples:
  everyapp workspace invite ann@example.com
  everyapp workspace invite ann@example.com --role admin --json

The Gateway tool: everyapp_workspace_invite (everyapp call everyapp_workspace_invite).

FLAGS
     [--role]                  The role they join with                                                                                                                                                               [member|admin, default = member]
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  email  The address to invite
```

### `everyapp workspace invite-link`

Print a new link for a pending invitation, under the Cloudflare login (for a Gateway that sends no email).

| Argument | Required | What it is |
| --- | --- | --- |
| `<email\|id>` | yes | The pending invitation, by invited email or id (workspace users lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace invite-link [--gateway value] [--account-id value] [--json] [--verbose] <email|id>
  everyapp workspace invite-link --help

The CLI twin of Admin → Users → Copy invite link: a new invite link for a pending, unexpired
invitation of the install organization, written into the Gateway's D1 with your Cloudflare
login. The Gateway's tools never return a link to their caller, so this is one of the two
workspace commands that write D1 (ADR-0003). Earlier links keep working until the invitation
is accepted or canceled. Hand the link to the person yourself.

Examples:
  everyapp workspace invite ann@example.com
  everyapp workspace invite-link ann@example.com

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace uninvite [--gateway value] [--account-id value] [--json] [--verbose] <email|id>
  everyapp workspace uninvite --help

Example:
  everyapp workspace uninvite ann@example.com

The Gateway tool: everyapp_workspace_uninvite (everyapp call everyapp_workspace_uninvite).

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace deactivate [--gateway value] [--account-id value] [--json] [--verbose] <email>
  everyapp workspace deactivate --help

Example:
  everyapp workspace deactivate ann@example.com

The Gateway tool: everyapp_workspace_deactivate (everyapp call everyapp_workspace_deactivate).

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace reactivate [--gateway value] [--account-id value] [--json] [--verbose] <email>
  everyapp workspace reactivate --help

Example:
  everyapp workspace reactivate ann@example.com

The Gateway tool: everyapp_workspace_reactivate (everyapp call everyapp_workspace_reactivate).

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace remove [--yes] [--gateway value] [--account-id value] [--json] [--verbose] <email>
  everyapp workspace remove --help

Asks first at a terminal; elsewhere it needs --yes.

Example:
  everyapp workspace remove ann@example.com --yes --json

The Gateway tool: everyapp_workspace_remove (everyapp call everyapp_workspace_remove).

FLAGS
  -y [--yes/--no-yes]          Remove without asking (needed where nobody is at a terminal)
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  email  The member, by email or user id (workspace users lists them)
```

### `everyapp workspace reset-email`

Mail a member a password-reset link (the link goes to their inbox, never to you).

| Argument | Required | What it is |
| --- | --- | --- |
| `<email>` | yes | The member, by email or user id (workspace users lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace reset-email [--gateway value] [--account-id value] [--json] [--verbose] <email>
  everyapp workspace reset-email --help

Example:
  everyapp workspace reset-email ann@example.com

The Gateway tool: everyapp_workspace_reset_email (everyapp call everyapp_workspace_reset_email).

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  email  The member, by email or user id (workspace users lists them)
```

### `everyapp workspace reset-link`

The way back in: print a one-hour, single-use password-reset link for a member, under the Cloudflare login.

| Argument | Required | What it is |
| --- | --- | --- |
| `<email>` | yes | The member of the install organization, by email |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace reset-link [--gateway value] [--account-id value] [--json] [--verbose] <email>
  everyapp workspace reset-link --help

For an owner locked out of the Gateway (a lost password, no email sending): Better Auth's
own reset token, written into the Gateway's D1 with your Cloudflare login, consumed by the
Gateway's /reset-password page. Whoever opens it sets the account's password, so hand it
to the person yourself. Only for an active member of the install organization that belongs
to no other (USER_IN_OTHER_ORGANIZATION: a password is account-wide). Password sign-in must
be on (EMAIL_PASSWORD_SIGN_IN). Everything else here but invite-link goes through the Gateway
as you; this is the recovery path that can't (ADR-0003). A member who can sign in uses everyapp workspace reset-email.

Example:
  everyapp workspace reset-link owner@example.com

FLAGS
     [--gateway]               The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  email  The member of the install organization, by email
```

### `everyapp workspace groups`

The groups, with how many members and apps each has.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace groups [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp workspace groups --help

Example:
  everyapp workspace groups

The Gateway tool: everyapp_workspace_groups (everyapp call everyapp_workspace_groups).

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace group create [--description text] [--gateway value] [--account-id value] [--json] [--verbose] <name>
  everyapp workspace group create --help

Example:
  everyapp workspace group create Sales --description "The sales team"

The Gateway tool: everyapp_workspace_group_create (everyapp call everyapp_workspace_group_create).

FLAGS
     [--description]           What the group is for (empty text clears it)
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace group set [--name name] [--description text] [--gateway value] [--account-id value] [--json] [--verbose] <group>
  everyapp workspace group set --help

Example:
  everyapp workspace group set Sales --name "Sales and marketing"

The Gateway tool: everyapp_workspace_group_set (everyapp call everyapp_workspace_group_set).

FLAGS
     [--name]                  A new name
     [--description]           What the group is for (empty text clears it)
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace group delete [--yes] [--gateway value] [--account-id value] [--json] [--verbose] <group>
  everyapp workspace group delete --help

Asks first at a terminal; elsewhere it needs --yes.

Example:
  everyapp workspace group delete Sales --yes

The Gateway tool: everyapp_workspace_group_delete (everyapp call everyapp_workspace_group_delete).

FLAGS
  -y [--yes/--no-yes]          Delete without asking (needed where nobody is at a terminal)
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace group members [--add email]... [--remove email]... [--set email]... [--gateway value] [--account-id value] [--json] [--verbose] <group>
  everyapp workspace group members --help

Examples:
  everyapp workspace group members Sales
  everyapp workspace group members Sales --add ann@example.com --add bob@example.com
  everyapp workspace group members Sales --set ann@example.com

The Gateway tools: everyapp_workspace_group_members to read, everyapp_workspace_group_members_set to change.

FLAGS
     [--add]...                Add a member, by email or user id (repeat for several)
     [--remove]...             Remove a member, by email or user id (repeat for several)
     [--set]...                Replace the whole list with these (repeat for several; alone, with neither --add nor --remove)
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace group apps [--add app]... [--remove app]... [--set app]... [--gateway value] [--account-id value] [--json] [--verbose] <group>
  everyapp workspace group apps --help

Examples:
  everyapp workspace group apps Sales
  everyapp workspace group apps Sales --add crm

The Gateway tools: everyapp_workspace_group_apps to read, everyapp_workspace_group_apps_set to change.

FLAGS
     [--add]...                Add an app, by id (repeat for several)
     [--remove]...             Remove an app, by id (repeat for several)
     [--set]...                Replace the whole list with these (repeat for several; alone, with neither --add nor --remove)
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  group  The group, by name or grp_ id (workspace groups lists them)
```

### `everyapp workspace apps`

Every app with whether everyone can open it, how many members have access, its state and what it still needs set.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace apps [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp workspace apps --help

Example:
  everyapp workspace apps --json

The Gateway tool: everyapp_workspace_apps (everyapp call everyapp_workspace_apps).

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--everyone` | `on`, `off` | no |  | Available to everyone: on, every member opens it, new members too; off, only owners, admins and those granted it |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace app set [--name name] [--description text] [--everyone on|off] [--gateway value] [--account-id value] [--json] [--verbose] <app>
  everyapp workspace app set --help

Catalog metadata only: the next deploy sets the name and description again from
everyapp.config.ts.

Examples:
  everyapp workspace app set crm --everyone on
  everyapp workspace app set crm --name "Open CRM" --description "Contacts and deals"

The Gateway tool: everyapp_workspace_app_set (everyapp call everyapp_workspace_app_set).

FLAGS
     [--name]                  The name the app library shows (1 to 255 characters)
     [--description]           The description under it
     [--everyone]              Available to everyone: on, every member opens it, new members too; off, only owners, admins and those granted it                                                                      [on|off]
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace app access [--add email]... [--remove email]... [--set email]... [--gateway value] [--account-id value] [--json] [--verbose] <app>
  everyapp workspace app access --help

Owners and admins open every app by their role. A change touches direct grants only; what
a group grants stays (workspace group apps), and so does "available to everyone"
(workspace app set --everyone).

Examples:
  everyapp workspace app access crm
  everyapp workspace app access crm --add ann@example.com
  everyapp workspace app access crm --set ann@example.com --set bob@example.com --json

The Gateway tools: everyapp_workspace_app_access to read, everyapp_workspace_app_access_set to change.

FLAGS
     [--add]...                Add a member's direct grant, by email or user id (repeat for several)
     [--remove]...             Remove a member's direct grant, by email or user id (repeat for several)
     [--set]...                Replace the whole list with these (repeat for several; alone, with neither --add nor --remove)
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  app  The app, by id (crm) or row id (workspace apps lists them)
```

### `everyapp workspace app cap`

Cap an app's provider spend per month in dollars, lift its own cap, or exempt it from the workspace default.

| Argument | Required | What it is |
| --- | --- | --- |
| `<app>` | yes | The app, by id or row id: the organization's own, or a shared one |
| `<dollars\|off>` | no | Dollars of provider-reported cost per UTC month (0.01 to 1,000,000), or off for no cap of its own (the workspace default applies); not with --unlimited |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--unlimited` | switch | no |  | No cap at all, even with a workspace default (instead of dollars or off) |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace app cap [--unlimited] [--gateway value] [--account-id value] [--json] [--verbose] <app> [<dollars|off>]
  everyapp workspace app cap --help

off clears the app's own cap (the workspace default then binds); --unlimited with dollars
or off is refused.

Examples:
  everyapp workspace app cap crm 20
  everyapp workspace app cap crm off
  everyapp workspace app cap crm --unlimited

The Gateway tool: everyapp_workspace_app_cap (everyapp call everyapp_workspace_app_cap).

FLAGS
     [--unlimited/--no-unlimited]  No cap at all, even with a workspace default (instead of dollars or off)
     [--gateway]                   The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]                The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]            Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]      Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                       Print help information and exit
      --                           All subsequent inputs should be interpreted as arguments

ARGUMENTS
   app           The app, by id or row id: the organization's own, or a shared one
  [dollars|off]  Dollars of provider-reported cost per UTC month (0.01 to 1,000,000), or off for no cap of its own (the workspace default applies); not with --unlimited
```

### `everyapp workspace cap default`

Set or clear the workspace default cap: what binds every app without a cap or --unlimited of its own.

| Argument | Required | What it is |
| --- | --- | --- |
| `<dollars\|off>` | yes | Dollars of provider-reported cost per UTC month (0.01 to 1,000,000) for every app without its own cap, or off for no default |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace cap default [--gateway value] [--account-id value] [--json] [--verbose] <dollars|off>
  everyapp workspace cap default --help

Examples:
  everyapp workspace cap default 20
  everyapp workspace cap default off --json

The Gateway tool: everyapp_workspace_cap_default (everyapp call everyapp_workspace_cap_default).

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  dollars|off  Dollars of provider-reported cost per UTC month (0.01 to 1,000,000) for every app without its own cap, or off for no default
```

### `everyapp workspace usage`

What the apps spent in a month: per app (with the cap that binds it), per member and per provider.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--month` | `<YYYY-MM>` | no |  | The UTC month (default: this one) |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace usage [--month YYYY-MM] [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp workspace usage --help

Example:
  everyapp workspace usage --month 2026-10 --json

The Gateway tool: everyapp_workspace_usage (everyapp call everyapp_workspace_usage).

FLAGS
     [--month]                 The UTC month (default: this one)
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
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
| `--risk` | `read`, `write` | no |  | Tools of this risk only |
| `--since` | `<time>` | no |  | At or after this time (ISO 8601, UTC) |
| `--limit` | `<n>` | no |  | Rows per page, 1 to 200 (default 50) |
| `--before` | `<cursor>` | no |  | The next page: the previous page's nextBefore, as <time>:<id> |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace activity [--app app] [--user email] [--decision allowed|blocked] [--risk read|write] [--since time] [--limit n] [--before cursor] [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp workspace activity --help

Examples:
  everyapp workspace activity --limit 20
  everyapp workspace activity --app crm --decision blocked --since 2026-10-24 --json

The Gateway tool: everyapp_workspace_activity (everyapp call everyapp_workspace_activity).

FLAGS
     [--app]                   Calls on this app only, by id or row id
     [--user]                  Calls by this member only, by email or user id
     [--decision]              Allowed or blocked calls only                                                                                                                                                         [allowed|blocked]
     [--risk]                  Tools of this risk only                                                                                                                                                               [read|write]
     [--since]                 At or after this time (ISO 8601, UTC)
     [--limit]                 Rows per page, 1 to 200 (default 50)
     [--before]                The next page: the previous page's nextBefore, as <time>:<id>
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workspace audit`

The audit log, newest first: every event the Gateway recorded, who did it and what it was about.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--actor` | `<who>` | no |  | Events this actor caused: a member by email or user id, an AI connection's or token's id, an app's id, or an operator's email |
| `--type` | `<type>` | no |  | One event type (member.joined), every type under a prefix (member.*, app.crm.*), or * for everything, pings and tool calls included |
| `--since` | `<time>` | no |  | At or after this time (ISO 8601, UTC) |
| `--limit` | `<n>` | no |  | Rows per page, 1 to 200 (default 50) |
| `--before` | `<cursor>` | no |  | The next page: the previous page's nextBefore, as <time>:<id> |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace audit [--actor who] [--type type] [--since time] [--limit n] [--before cursor] [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp workspace audit --help

Examples:
  everyapp workspace audit --limit 20
  everyapp workspace audit --actor mia@acme.com --type member.* --since 2026-10-24 --json

The Gateway tool: everyapp_workspace_audit (everyapp call everyapp_workspace_audit).

FLAGS
     [--actor]                 Events this actor caused: a member by email or user id, an AI connection's or token's id, an app's id, or an operator's email
     [--type]                  One event type (member.joined), every type under a prefix (member.*, app.crm.*), or * for everything, pings and tool calls included
     [--since]                 At or after this time (ISO 8601, UTC)
     [--limit]                 Rows per page, 1 to 200 (default 50)
     [--before]                The next page: the previous page's nextBefore, as <time>:<id>
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workspace tokens`

Your personal access tokens for the organization (never a token's value).

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--all` | switch | no |  | Revoked and expired tokens too |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace tokens [--all] [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp workspace tokens --help

Tokens are made under Manage workspace → Tokens only.

Example:
  everyapp workspace tokens --all

The Gateway tool: everyapp_my_tokens (everyapp call everyapp_my_tokens).

FLAGS
     [--all/--no-all]          Revoked and expired tokens too
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workspace token revoke`

Revoke one of your personal access tokens: it stops working on its next request.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The token's id or name (workspace tokens lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace token revoke [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp workspace token revoke --help

Example:
  everyapp workspace token revoke 3f2a…

The Gateway tool: everyapp_revoke_token (everyapp call everyapp_revoke_token).

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The token's id or name (workspace tokens lists them)
```

### `everyapp workspace connections`

Your AI connections to the Gateway: which AI app, which apps it may use, read or write.

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace connections [--gateway value] [--account-id value] [--json] [--verbose]
  everyapp workspace connections --help

Example:
  everyapp workspace connections

The Gateway tool: everyapp_my_connections (everyapp call everyapp_my_connections).

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments
```

### `everyapp workspace connection revoke`

Revoke one of your AI connections: the client is out on its next request.

| Argument | Required | What it is |
| --- | --- | --- |
| `<id>` | yes | The connection's id (workspace connections lists them) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace connection revoke [--gateway value] [--account-id value] [--json] [--verbose] <id>
  everyapp workspace connection revoke --help

Example:
  everyapp workspace connection revoke mcpc_…

The Gateway tool: everyapp_revoke_connection (everyapp call everyapp_revoke_connection).

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  id  The connection's id (workspace connections lists them)
```

### `everyapp workspace linked-dev`

Let owners and admins run `everyapp dev --gateway` against this Gateway's providers (linked dev), or stop it.

| Argument | Required | What it is |
| --- | --- | --- |
| `<on\|off\|show>` | no | Turn linked dev on or off for the organization, or show it (default) |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp workspace linked-dev [--gateway value] [--account-id value] [--json] [--verbose] [<on|off|show>]
  everyapp workspace linked-dev --help

Off by default: a Gateway that didn't turn it on refuses the sign-in and the route.
Turning it off stops tokens already issued on their next call.

Examples:
  everyapp workspace linked-dev on
  everyapp workspace linked-dev show

The Gateway tools: everyapp_workspace_show to read, everyapp_workspace_linked_dev to change.

FLAGS
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [on|off|show]  Turn linked dev on or off for the organization, or show it (default)
```

### `everyapp call`

Call one of the Gateway's tools: every admin action (everyapp_*) and every app's tools.

| Argument | Required | What it is |
| --- | --- | --- |
| `<tool>` | no | The tool's name, as --list shows it (everyapp_workspace_users, crm_list_contacts) |
| `<json>` | no | The tool's arguments as one JSON object (default {}); - reads them from stdin |

| Flag | Value | Required | Default | What it does |
| --- | --- | --- | --- | --- |
| `--list` | switch | no |  | List every tool you can call, with its title, instead of calling one |
| `--gateway` | `<value>` | no |  | The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there) |
| `--account-id` | `<value>` | no |  | The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID) |
| `--json` | switch | no |  | Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments) |
| `--verbose` | switch | no |  | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace |

```text
USAGE
  everyapp call [--list] [--gateway value] [--account-id value] [--json] [--verbose] [<tool>] [<json>]
  everyapp call --help

The Gateway's tools are its one admin API: the same services as Manage workspace and the
same tools an AI app gets on <gateway>/mcp, run as you. The workspace, events and ai
commands are each one of them; this reaches all of them, and the apps' tools too. The
answer is printed as the tool gives it; --json puts it in the done event's data.

As whom: EVERYAPP_TOKEN (a personal access token from Manage workspace → Tokens), else the
sign-in everyapp login --gateway stored, else a sign-in now in the browser.

Examples:
  everyapp call --list
  everyapp call everyapp_workspace_users
  everyapp call everyapp_workspace_invite '{"email":"ann@example.com","role":"admin"}'
  echo '{"query":"contacts"}' | everyapp call everyapp_search_tools - --json

FLAGS
     [--list/--no-list]        List every tool you can call, with its title, instead of calling one
     [--gateway]               The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)
     [--account-id]            The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)
     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)
     [--verbose/--no-verbose]  Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace
  -h  --help                   Print help information and exit
      --                       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [tool]  The tool's name, as --list shows it (everyapp_workspace_users, crm_list_contacts)
  [json]  The tool's arguments as one JSON object (default {}); - reads them from stdin
```
