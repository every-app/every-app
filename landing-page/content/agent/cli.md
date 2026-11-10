---
title: "CLI reference"
description: "Every everyapp command with its arguments and flags, generated from the CLI itself, plus the exit codes and the flags most commands share."
---

<!-- Generated from the command definitions by packages/cli/src/docs/cliReference.ts; regenerate with `pnpm -C packages/cli docs:update`. -->

Install with `npm install -g everyapp`, then run `everyapp …` (in a checkout of the EveryApp repository, `pnpm everyapp …`). Every command takes `--help`. Agents add `--json` and read the events ([the protocol](/docs/agent/json)); codes are on [errors](/docs/agent/errors).

## Exit codes

- `0`: done.
- `1`: an `error` event ended the run (a declined prompt, `CANCELLED`, too).
- `2`: stopped on `action_required`: do the action, then run `data.rerun`.
- `130`: Ctrl-C.
- `251`: no such command (`UNKNOWN_COMMAND`).
- `252`: bad arguments (`UNKNOWN_FLAG`, `INVALID_VALUE`, `MISSING_ARGUMENT`, …).

## Shared flags

Not repeated under each command below:

- `--json`: NDJSON events on stdout, never prompts.
- `--verbose`: every step, the output of what everyapp runs, and stack traces.
- `--no-color`, `-h`/`--help`, `-v`/`--version`.
- `--gateway <url|name>`: which Gateway, when the account holds several (default `EVERYAPP_GATEWAY_URL`). On every command that reaches a Gateway. On the commands that call a Gateway tool (`workspace`, `events`, `ai`, `call`) the default is `EVERYAPP_GATEWAY_URL`, else the Gateway you signed in to with `login --gateway`, else the one your Cloudflare login finds.
- `--account-id <id>`: which Cloudflare account, when the login sees several (default `CLOUDFLARE_ACCOUNT_ID`).

## Commands

### `everyapp create [<name or path>]`
Create a new app from the starter template.

A bare name makes ./<name>; a path (../my-app, ~/apps/my-app) makes the app there, named after its last part. Each is its own git repository, its pnpm-lock.yaml in the first commit. Made by everyapp installed from npm, it is pinned to the published @every-app/sdk and everyapp; made from a checkout, it is linked to that checkout's, so its deploy runs the checkout's CLI. Dependencies are installed and the local database is ready, so `pnpm dev` works straight away. Then: cd into it and `pnpm run deploy`.

Run from a checkout of the EveryApp repository, a bare name goes in apps/<name> (on the checkout's own packages); a path inside the checkout must be apps/<name>.

```sh
everyapp create my-app  # ./my-app, its own repository
everyapp create ~/apps/crm  # ~/apps/crm, its own repository
```

- `<name or path>`: An app name (lowercase letters, digits and dashes, e.g. my-app; asked for when missing), or the path of the folder to make, named after its last part (../my-app)
- `--yes`: Don't ask anything (a name is then required)
- `--verbose`: Stream install and git output to stderr

### `everyapp dev`
Run the app locally behind a dev Gateway.

Runs the app under `cf dev` (or the manifest's dev command) on an internal port and a gateway-lite in front of it on $PORT (default 8787) — the REAL perimeter: public-route policy, header strip/inject, a real RS256 identity JWT, and a seeded dev user. Open http://<app-id>.localhost:8787 — the first Host label selects the app, so portless per-worktree hosts work with no configuration.

Identities are signed with the SDK's well-known dev keypair, which the app's development build trusts on its own: nothing is written into the app. The key is public, so the gateway listens on 127.0.0.1 unless --host says otherwise. Before starting, dev generates the Worker's types when .cloudflare/types is missing and applies local D1 migrations (cf d1 migrations apply --local) to .cloudflare/state.

With no Gateway in local runs, the app reads its manifest's secrets and the keys of its providers and capabilities (OPENROUTER_API_KEY, DATAFORSEO_API_KEY, ...) from .dev.vars in its directory, one NAME=value per line, gitignored. The ready block names the ones that file is missing and the app can't run without; until they are set, AI calls and integrations answer that they aren't set up (email needs none: sendEmail() prints until EMAIL_FROM and a transport are set).

Every request goes through the real perimeter (identity header, public-route policy, CSRF). Public routes are auth-optional; to call them anonymously send the header x-everyapp-dev-anon: 1 (curl) or set the cookie everyapp_dev_anon=1 (browser). Requests straight to the app's internal port get 401 unless they carry an identity token in x-everyapp-identity: `everyapp dev token` prints one.

An app that declares crons runs one on demand with
```sh
curl -X POST http://<app-id>.localhost:8787/__everyapp/cron -d '<schedule>'
```

An app that receives mail gets a curl command that delivers message.eml to its email() handler: a raw message with From, To, Subject and Message-ID headers, to any address. email() gets no identity.

--mode stub (default): seeded dev user, zero setup. --mode mirror: authenticate against a SEPARATELY-running local Gateway (run `pnpm dev` in apps/every-app-gateway first). Real login/launcher are forwarded to it. Requires a two-label base host (e.g. everyapp.localhost) so the session cookie crosses the subdomain boundary; the CLI prints setup guidance if the host is unusable. Also settable via EVERYAPP_DEV_MODE; the flag wins. --gateway https://<your gateway> (linked dev): the app runs here as you, and its AI, email, provider, member and event calls go through that Gateway, with no provider key on this computer. The first run signs you in once in the browser (owners and admins, on a workspace that ran `everyapp workspace linked-dev on`); the token lives in ~/.config/everyapp/linked-dev.json, never in the app. Calls bill the workspace's providers. Data (D1, KV, R2) stays local; the app's own secrets still come from .dev.vars. `everyapp dev unlink` signs out.

Ctrl+C stops the app and exits with 130.

- `--port <value>`: Gateway port (defaults to $PORT, then 8787)
- `--host <value>`: Address the Gateway listens on (default 127.0.0.1; 0.0.0.0 lets other machines in, each as a dev identity)
- `--mode <value>`: stub (seeded dev user, default) | mirror (real login through a local Gateway) | linked (a real Gateway's services as you; --gateway https://… selects it)
- `--gateway <value>`: The Gateway: a real one (https://apps.example.com) links this run to it; a local one (default http://localhost:3000) is mirror mode's
- `--base-host <value>`: mirror mode: two-label base host for cookie scope (default everyapp.localhost)
- `--skip-migrations`: Start without applying local database migrations

### `everyapp dev token`
Print a dev identity token for scripts that call the app's dev port.

Prints an identity token the app accepts while it runs under `everyapp dev`, for scripts and curl that call the app's internal dev port directly as someone other than the gateway-lite's seeded user: a member, an admin, another organization. Send it as the x-everyapp-identity header. The gateway-lite itself replaces that header with its own, so use the internal port the ready block prints (App port).

The token is minted as the gateway-lite mints its own: the SDK's well-known dev key and kid, the dev issuer https://gateway.dev.localhost, aud = the app id, a full session (channel web, scopes *). Only a development build of the app (EVERYAPP_DEV, set by everyAppWorker() under dev) accepts it; a deployed app refuses it whatever it says.

Without --user, owner is the dev user (dev@everyapp.localhost, sub dev-user); admin and member are people of their own (<role>@everyapp.localhost, sub dev-<role>). With --user, the sub is dev-<email>. Agent tools are reached through <app-id>.localhost:8787/mcp, not with this token.

Prints the token alone; --json prints a done event whose data has token, expiresAt, header, appId and user.

```sh
curl -H "x-everyapp-identity: $(everyapp dev token --role member)" http://127.0.0.1:<app port>/api/me
everyapp dev token --user ana@example.com --role admin --ttl 15m
everyapp dev token --app my-app --org other-org --json
```

- `--role owner|admin|member` (default `owner`): The organization role the token carries
- `--user <email>`: Who the token speaks for (default: the dev user for owner, <role>@everyapp.localhost otherwise)
- `--org <id>`: The organization id (default dev-org, the dev user's)
- `--app <id>`: The app id the token is for (default: everyapp.config.ts's id in this directory)
- `--ttl <duration>`: How long it lasts: seconds, or 90s, 15m, 1h (default 1h, at most 24h)

### `everyapp dev link`
Sign everyapp dev in to a Gateway for this app (linked dev), without running it.

Opens the browser at the Gateway's sign-in: approve everyapp dev, and the token for this app is kept in ~/.config/everyapp/linked-dev.json (0600). `everyapp dev --gateway <url>` does the same on its first run; this is for doing the browser step on its own, or again (a new sign-in replaces the earlier one). Owners and admins who can open the app, on a workspace with linked dev on (`everyapp workspace linked-dev on`); otherwise the Gateway says why (LINKED_DEV_REFUSED, OAUTH_REGISTRATION_OFF, OAUTH_OFF).

```sh
everyapp dev link --gateway https://apps.example.com
```

- `--gateway <value>`: The Gateway's URL (else EVERYAPP_GATEWAY_URL)
- `--app <id>`: The app id (default: everyapp.config.ts's id in this directory)

### `everyapp dev unlink`
Sign everyapp dev out of a Gateway for this app: revoke the grant there and forget the token.

Revokes the linked dev grant at the Gateway (it also disappears from Settings → Connections there) and removes the token from ~/.config/everyapp/linked-dev.json. If the Gateway can't be reached the token is still forgotten (warning LINKED_DEV_REVOKE_FAILED): revoke it under Settings → Connections.

```sh
everyapp dev unlink --gateway https://apps.example.com
```

- `--gateway <value>`: The Gateway's URL (else EVERYAPP_GATEWAY_URL)
- `--app <id>`: The app id (default: everyapp.config.ts's id in this directory)

### `everyapp deploy`
Deploy the app in this directory.

Deploys the app in this directory as a private Cloudflare Worker defined by cloudflare.config.ts, with cf and your Cloudflare login (or CLOUDFLARE_API_TOKEN), in the Gateway's account:
1. Registers the app in the Gateway's database, which names its Worker, resources and hostname
2. Creates or links the D1 databases and KV namespaces in everyapp.config.ts
3. Installs dependencies and builds (cf build, or the manifest's build command), then checks the built Worker against the app policy and the drizzle migrations against the schema
4. Bookmarks the production D1 database, then applies its migrations
5. Uploads the Worker with its secrets, its helper Workers, its Workflows and the Email Routing rules for its inbound addresses (turning routing on for a domain asks first)
6. Binds a new app on the Gateway by redeploying the live Gateway's own release (never a newer one: that is everyapp update), then waits for the app's hostname to go live

No Gateway in any account the login sees, and none named? At a terminal it offers to install one at apps.<zone> (what everyapp setup does), then deploys; otherwise it stops with action_required install_gateway and the setup command to run.

A rename: change id in everyapp.config.ts and list the old one under previousIds. When the new id isn't registered and a previous one is, the deploy shows what moves (the id and hostname; the Worker, its data and the Gateway's state stay) and asks first (--yes for CI); the old hostname keeps working. A previousIds entry that names no app stops the deploy.

Nothing else asks first. Install and build output goes to a log file, never to stdout. Safe to run again: a redeploy of an app the Gateway already serves never touches the Gateway.

Someone else's published app: everyapp install <url>. To publish this one: everyapp release. --gateway <url> (or EVERYAPP_GATEWAY_URL) names the Gateway when your login sees several. With --json, each step is an NDJSON event.

- `--allow-delete-durable-object-data`: Deploy even though Durable Object classes were removed, deleting their data
- `--allow-delete-workflows`: Deploy even though Workflows were removed, deleting them and their instances
- `--force-dns`: Publish the app's new hostname even where a DNS record answers it (one at the hostname is replaced)
- `--enable-email-routing`: Turn on Email Routing for the domains the app's inbound addresses (everyapp email set --inbound) name that don't route mail yet (locks their MX and SPF records to Cloudflare)
- `--replace-mx`: Turn on Email Routing even for a domain whose MX records deliver its mail elsewhere (Google Workspace...): they are replaced, and that mail stops arriving there
- `--register-providers`: Register the providers the app bundles, which tell the Gateway where to send their keys (--yes doesn't)
- `--no-wait`: Don't wait for the app to go live (a new hostname's certificate included); the Gateway makes it live within a minute, or on its first visit
- `--yes`: With no Gateway yet, install one at apps.<zone> without asking, and rename the app previousIds names without asking (never registers the providers the app bundles, cf's questions, or the one before replacing a Worker changed outside everyapp)

### `everyapp release`
Pack the app in this directory as a release others can install.

Builds the app in this directory as a deploy would (tenant-neutral), checks its Build Output against the app policy and its migrations against its schema, and packs the release (default ./everyapp-release.tar.gz) without deploying it: no Gateway and no Cloudflare login, so it runs in CI. Attach the tarball to a GitHub release of the app's repository, and everyapp install <repository url> installs it on any Gateway. With --publish (in the app repository's Release workflow) it then publishes the tarball on a GitHub release of the repository the run builds, from GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_EVENT_NAME, GITHUB_REF_* and GITHUB_TOKEN: v<package.json version> on a push to the default branch (v<version>-<yyyymmdd>-<sha7> when that tag exists), the pushed tag on a v* tag, a draft on workflow_dispatch, nothing on a pull request. --dry-run plans it and publishes nothing. With --json, each step is an NDJSON event; done carries the tarball's path and SHA-256 (and the release published).

- `--out <file>`: Where to write the release (default: ./everyapp-release.tar.gz)
- `--publish`: In GitHub Actions, publish the release on GitHub: a push to the default branch as v<version>, a v* tag as itself, a manual run as a draft; a pull request publishes nothing
- `--dry-run`: With --publish, say which release it would publish, and publish nothing

### `everyapp db migrate`
Apply migrations to the local database.

Apply the app's migrations to the local database

Reads migrations from migrations.dir in everyapp.config.ts (default drizzle/). `everyapp dev` runs this on every start. Production migrations run only during `everyapp deploy`, after a restore point is saved.

### `everyapp db query [<sql>]`
Run SQL against the production database (or --local).

Run SQL against the app's D1 database

Runs against the production database unless --local is set; SQL that changes it is confirmed first (--yes skips that). Rows print as a table; with --json they are in the done event's data.results.

```sh
everyapp db query "select * from todos limit 5"
everyapp db query --local "select count(*) from events"
everyapp db query --file scripts/backfill.sql
```

- `<sql>`: SQL to run
- `--local`: Query the local database `everyapp dev` uses
- `--file <path>`: Read the SQL from a file (- for stdin)
- `--binding <name>`: D1 binding to query (default: the migrations binding, or the first)
- `--yes`: Run SQL that changes the production database without asking
- `--json`: Print one NDJSON done event, its rows in data.results, instead of a table
- `--verbose`: Show every step

### `everyapp db restore [<app>]`
Put the production database back to before the last migrations.

Put the app's production database back to before its last migrations

Each deploy that migrates a database with data saves a restore point first (Time Travel). This restores the last one, after asking: the migrations are undone, and so is anything written to the database since. --gateway does the same for the Gateway's database, and runs on a Gateway behind this everyapp (after a failed Gateway migration).

```sh
everyapp db restore
everyapp db restore --gateway
```

- `<app>`: The app (default: the one in this directory)
- `--gateway`: Restore the Gateway's database, from its last migrating setup or upgrade
- `--yes`: Restore without asking

### `everyapp teardown`
Delete everything EveryApp created in a dedicated test Cloudflare account, or one named Gateway.

For a dedicated test account that live tests install into, over and over: removes every Worker, Workflow, D1 database, KV namespace, R2 bucket, Hyperdrive config, queue, Vectorize index, AI Gateway and Secrets Store secret of the default Gateway's names (every-*, but never another Gateway's: every-app-gateway-<name>... or every-<name>--...), the Gateway's own included, the two Cloudflare Access applications and the allow policy, the Email Routing rules that send mail to those Workers (a catch-all drops mail again, and routing is turned off once no rule and no catch-all of anyone else's needs it), the certificate packs of the hostnames the Gateway published, and the Custom Domain records (A, AAAA, CNAME) left at exactly those names. Never the zone, the Workers Paid subscription, the workers.dev subdomain, the Zero Trust team and its identity providers, a Secrets Store itself, any other DNS record (MX, TXT, CAA...) even at those names, R2 buckets outside the default jurisdiction, or anything whose name isn't the Gateway's and that no app recorded.

Without --gateway it is destructive and exists for dedicated test accounts only. The account must be on the allowlist (EVERYAPP_TEST_ACCOUNTS, or one id per line in ~/.config/everyapp/test-accounts), the run needs CLOUDFLARE_API_TOKEN scoped to that account alone (a token that sees any other account is refused), and an account on the forbidden list (EVERYAPP_FORBIDDEN_ACCOUNTS, or one id per line in ~/.config/everyapp/forbidden-accounts) is refused first, whatever the allowlist says. It reads everything first and shows what it found; then the account id is typed at the terminal, or passed again with --confirm for a run without one. There is no --yes.

One account may hold several Gateways. --gateway <name> tears down only that named Gateway: every-app-gateway-<name> with its OAuth KV and activation queue, its apps every-<name>--* and their resources, its AI Gateways every-app-gateway-<name>-*, and its Access applications and policy ("Every App gateway (<name>)" and the like). Nothing of the default Gateway's or another named one's, which its names never match, so it may run in an account that holds a production Gateway: the allowlist and the forbidden list aren't read, CLOUDFLARE_API_TOKEN must still list the account, and the confirmation is the Gateway's Worker name every-app-gateway-<name>, typed or passed with --confirm, instead of the account id. --all tears down every Gateway in the account one after another, the named ones first and the default last, under the test-account guards and the account id's confirmation; it can't go with --gateway.

```sh
EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id> --dry-run
EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id>
EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id> --confirm <id> --json
everyapp teardown --account-id <id> --gateway demo --dry-run
everyapp teardown --account-id <id> --gateway demo --confirm every-app-gateway-demo --json
EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id> --all --confirm <id> --json
```

- `--account-id <id>` (required): The account to empty (required; 32 hex characters, from the dashboard URL dash.cloudflare.com/<id>/…; never read from CLOUDFLARE_ACCOUNT_ID): a dedicated test account, unless --gateway names a named Gateway
- `--gateway <name>`: Tear down only this named Gateway and its apps (its name, or its Worker's every-app-gateway-<name>); without it, the default Gateway
- `--all`: Tear down every Gateway in the account, the named ones first and the default last (a dedicated test account; not with --gateway)
- `--confirm <id>`: The same account id again (with --gateway <name>: every-app-gateway-<name>), for a run without a terminal (--json, a script); at a terminal it is typed instead
- `--dry-run`: List what would be deleted and stop; nothing is written

### `everyapp login`
Log in to Cloudflare, or sign in to a Gateway with --gateway.

Log in to Cloudflare

At a terminal, Cloudflare's own login runs (open its link and enter the code). Piped, or with --json, the link and code are printed and the run waits for the login to be approved. Already logged in, it says as whom. Unattended runs can set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID instead.

Sign in to a Gateway (--gateway <url>)

The workspace, events, ai and call commands are the Gateway's own tools, run as you. This opens the Gateway's consent page in the browser (under --json the link is in a progress event and the run waits): choose read & write and all apps for the admin commands. The grant is kept in ~/.config/everyapp/gateways.json (0600) and refreshed when stale; revoke it under Settings → AI connections there, or with --sign-out. Scripts and CI set EVERYAPP_TOKEN to a personal access token (Manage workspace → Tokens) instead.

- `--gateway <url>`: Sign in to this Gateway instead: its admin API, which the workspace, events, ai and call commands use
- `--sign-out`: With --gateway: revoke this machine's sign-in there and forget it

### `everyapp setup`
Install or repair the Gateway.

One command from an empty Cloudflare account (Workers Paid) to a working Gateway and its owner, and the one to run when something is off. Run it again any time: it picks up where it stopped, and does nothing once everything is there. everyapp update takes a newer Gateway later (setup does that too, on its way).

A fresh install takes 5 to 20 minutes, most of it waiting for you at the owner link: give it a long timeout, or run it in the background and watch its output.

1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and finds the Gateway in the login's accounts; with none, picks the account to install it in. A second Gateway in the same account (staging, a demo) is --name <name>: every-app-gateway-<name>, with its own database, queue and apps (every-<name>--…), beside the first, never touching it
2. Picks where the Gateway lives (--domain, or asked): any hostname under one of the account's domains, apps.example.com; apps get one each below it, todo.apps.example.com
3. Installs the Gateway, or repairs it, and waits for its certificate. Where the Gateway comes from: --release (a GitHub repository or release URL, a tarball's URL, or a downloaded every-app-gateway-release.tar.gz); otherwise this checkout's build when everyapp runs from one; otherwise the published release for this everyapp version (https://github.com/every-app/every-app, gateway-v<version>)
4. Opens a one-time link to create the owner account and waits up to 15 minutes for it; in CI there is no link, and the run ends with a warning to run setup at a terminal
5. Puts Cloudflare Access in front of the Gateway (asked at a terminal, Yes by default; with --yes or --json, done without asking). An account with no Zero Trust team needs its name: asked at a terminal, else --team. --no-access leaves it off (not recommended)

The flags people use: --domain, --account-id, and --yes for a script (it answers setup's own questions; never cf's). With --json each step is an NDJSON event; a run that stops on something only a person can do exits 2 with action_required. Then: everyapp create ../my-app, cd into it, everyapp dev, everyapp deploy. More: https://everyapp.com/docs/gateway

- `--domain <value>`: Where the Gateway lives: any hostname under one of the account's domains, e.g. apps.example.com (asked at a terminal; remembered after that)
- `--account-id <value>`: The Cloudflare account of the Gateway, or with none yet, the one to install it in (default: CLOUDFLARE_ACCOUNT_ID, or the only one)
- `--name <name>`: A second Gateway in the same Cloudflare account, by name (1 to 16 lowercase letters or digits): its Worker is every-app-gateway-<name> and its apps every-<name>--…; setup finds or installs that one only. Without it, the Gateway is every-app-gateway, as always
- `--release <value>`: The Gateway release to deploy: a GitHub repository URL (its latest release) or release page, a release tarball's URL, or a downloaded every-app-gateway-release.tar.gz (default: this checkout's build, or without a checkout, the published release for this everyapp version)
- `--force-dns`: Publish new hostnames even where a DNS record answers them (one at a hostname is replaced)
- `--redeploy` (hidden): Upload the Gateway even when it is up to date (after a change in the dashboard, such as a key rotation)
- `--no-access`: Leave Cloudflare Access off (not recommended): by default setup puts it in front of the Gateway once the owner exists. Remembered, so a later unattended setup leaves it off too; everyapp access on turns it on
- `--team <value>`: The Zero Trust team's name, when the Cloudflare account has none yet: people sign in at <name>.cloudflareaccess.com, and it can't be changed later (ignored once a team exists)
- `--yes`: Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp)
- `--verbose`: Show every step and progress line, and stream the Gateway's build output to stderr

### `everyapp update`
Update the Gateway to a newer release.

Deploys a newer Gateway over the one your Cloudflare login finds, where it is, keeping its data, users and apps. It never installs a Gateway: with none, it stops and says to run everyapp setup. The Gateway comes from --release (a GitHub repository or release URL, a tarball's URL, or a downloaded every-app-gateway-release.tar.gz); otherwise this checkout's build when everyapp runs from one; otherwise the published release for this everyapp version (https://github.com/every-app/every-app, gateway-v<version>).

1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and finds the Gateway in the login's accounts (--account-id when there is one in more than one)
2. Upgrades it (migrations first, with a restore point). When it runs that Gateway already, binds and publishes every registered app if the live Gateway doesn't, and otherwise says it is up to date. A live Gateway newer than this one is replaced with a warning (GATEWAY_DOWNGRADE): that is how a rollback goes; in a checkout, git pull to go forward

A checkout's Gateway is named by its version when it is that version's release (the gateway-v<version> tag), and by the checkout's commit otherwise. With --json, each step is an NDJSON event.

- `--release <value>`: The Gateway release to deploy: a GitHub repository URL (its latest release) or release page, a release tarball's URL, or a downloaded every-app-gateway-release.tar.gz (default: this checkout's build, or without a checkout, the published release for this everyapp version)
- `--force-dns`: Publish new hostnames even where a DNS record answers them (one at a hostname is replaced)
- `--redeploy` (hidden): Upload the Gateway even when it is up to date (after a change in the dashboard, such as a key rotation)
- `--yes`: Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp)

### `everyapp install <source>`
Install an app someone published, from GitHub or a release file.

Installs an app release on your Gateway with no checkout of the app, as everyapp deploy would from the app's directory, with nothing to build: <source> is a GitHub repository URL (the everyapp-release.tar.gz on its latest release; …/releases/tag/<tag> for that one), a tarball's HTTPS URL, or a downloaded everyapp-release.tar.gz. The release holds the app's tenant-neutral Build Output, migrations and manifest, checked against its SHA-256. Run it again later to update the app. Its settings are set with everyapp configure <id>; .everyapp/secrets.env in this directory is the deploy's own file, read only for a Hyperdrive app's database URL.

A repository without a release is never built from its URL: clone it, run pnpm install in it, then everyapp deploy from its directory. Postgres migrations need the app's source, so their releases are refused.

No Gateway in any account the login sees, and none named? At a terminal it offers to install one at apps.<zone> (what everyapp setup does, owner link included), then installs the app; otherwise it stops with action_required install_gateway and the setup command to run. --gateway <url> (or EVERYAPP_GATEWAY_URL) names the Gateway when your login sees several. --dry-run says whether this everyapp would install the release, and installs nothing. With --json, each step is an NDJSON event.

- `<source>`: The app release to install: a GitHub repository URL (its latest release), a release tarball's URL, or a downloaded everyapp-release.tar.gz
- `--allow-delete-durable-object-data`: Deploy even though Durable Object classes were removed, deleting their data
- `--allow-delete-workflows`: Deploy even though Workflows were removed, deleting them and their instances
- `--force-dns`: Publish the app's new hostname even where a DNS record answers it (one at the hostname is replaced)
- `--enable-email-routing`: Turn on Email Routing for the domains the app's inbound addresses (everyapp email set --inbound) name that don't route mail yet (locks their MX and SPF records to Cloudflare)
- `--replace-mx`: Turn on Email Routing even for a domain whose MX records deliver its mail elsewhere (Google Workspace...): they are replaced, and that mail stops arriving there
- `--register-providers`: Register the providers the app bundles, which tell the Gateway where to send their keys (--yes doesn't)
- `--no-wait`: Don't wait for the app to go live (a new hostname's certificate included); the Gateway makes it live within a minute, or on its first visit
- `--dry-run`: Download and check the release, as an install would before deploying, and deploy nothing: no Gateway and no Cloudflare login
- `--yes`: With no Gateway yet, install one at apps.<zone> without asking, and rename the app the release's previousIds names without asking (never registers the providers the app bundles, cf's questions, or the one before replacing a Worker changed outside everyapp)

### `everyapp deploy-token add`
Give the Gateway its own Cloudflare token, so it installs apps itself.

Says what to pick, then opens Cloudflare's page for a new account API token when you press Enter (No prints its link), its name and every permission the installer uses filled in (Workers Scripts, D1, Workers KV, R2, Queues, Hyperdrive, Vectorize, AI Gateway, Secrets Store, Access apps, Email Routing Rules and Zone Settings edit; DNS and Zone read). Create it and paste it at the hidden prompt: it is stored on the Gateway as CF_DEPLOY_TOKEN, with BROWSER_APP_INSTALLS=on. Owners and admins then install apps from Admin → Apps → Install app, or a Deploy to EveryApp button, without running deployment commands.

A Gateway that has a token keeps it: run again, this only turns installs back on. To replace the token: everyapp deploy-token remove, then add.

```sh
everyapp deploy-token add
everyapp deploy-token add --gateway https://apps.example.com
```

### `everyapp deploy-token remove`
Take the Gateway's Cloudflare token off it, so it no longer installs apps itself.

Removes CF_DEPLOY_TOKEN and BROWSER_APP_INSTALLS from the Gateway in one change. The apps it installed keep running. The token works until you delete it in Cloudflare (Manage account → Account API tokens). Asks first.

```sh
everyapp deploy-token remove
```

- `--yes`: Remove the token without asking

### `everyapp configure [<app>]`
Set up an app: asks for what it needs, feature by feature, with each feature's steps.

Reads what the app's everyapp.config.ts declares (AI providers, capabilities, its own secrets and settings, grouped into features) and what is set. It asks for each top-level value that isn't set (hidden input, with where to get it beside each), then walks each required feature: its numbered steps, then each value with where it lives. Then it asks "Set up <name>?" for each optional feature that's off. A generated secret is made for you (and shown once when you paste it somewhere); a file's prompt takes its path. Run it again any time: it shows what is set (names only, never values). Once everything is set it asks nothing and exits; to change a set value, use secret set (below). With --json, the done event's data.features has every feature's steps, values and state.

Where they go: an AI provider's key or a capability's client is a Gateway setting, held once for every app on the Gateway Worker; the app's own secrets go on its Worker, after its first deploy. Changes are live at once; no deploy needed.

For a script or a coding agent, which can't answer a prompt: pipe NAME=value lines in (one per line; # starts a comment only at the start of a line; a value is taken as it is, one pair of quotes around it dropped), or export the variables under the settings' own names and add --from-env (then stdin isn't read). A value never goes on the command line.

```sh
everyapp configure crm
everyapp configure  # in the app's directory
everyapp configure crm --from-env --json
printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY" | everyapp configure crm --json
```

Change a set value, by name: everyapp secret set <NAME> --app <id> (a Gateway setting changes for every app).

- `<app>`: The app to configure (default: the app in this directory)
- `--from-env`: Take each unset setting's value, optional features' too, from the environment variable of its name (DATAFORSEO_API_KEY from $DATAFORSEO_API_KEY; multi-line values such as a PEM are kept); a set name is never replaced; stdin isn't read; the rest are asked for at a terminal

### `everyapp status`
Show the Gateway, its apps and anything to fix.

One screen, all of it from the Gateway's D1 database and cf, nothing asked of the Gateway: its URL and release (and whether this checkout builds it), its owner, the apps its registry lists and whether the live Gateway binds them, each hostname's certificate, any deploy in progress, and what to run when something is off. With --json, the `done` event's data has all of it, `fixes` included: the one state query an agent needs. An account with several Gateways: --gateway <url|name> says which.

### `everyapp delete [<id>]`
Remove an app from the Gateway.

Deletes the app in the Gateway's D1 database (its name stays reserved; deploy it again to bring it back) and removes its Gateway binding and hostname, with a redeploy of the Gateway from this checkout. The app's Worker and data are kept unless --purge, which deletes them for good. Asks first at a terminal; elsewhere it needs --yes.

- `<id>`: App id (default: the app in this directory)
- `--purge`: Also delete the app's Worker and helper Workers, D1 databases, KV namespaces, Workflows and Email Routing routes
- `--yes`: Delete without asking (with --purge too, without typing the app id)

### `everyapp access on`
Turn Cloudflare Access on in front of the Gateway and its apps, or bring it up to date.

Everyone opens the Gateway and its apps through Cloudflare Access first (Sign in with Cloudflare for members of your Cloudflare account, a one-time PIN emailed to everyone else), then lands signed in. With your Cloudflare login it finds or creates the Zero Trust team, adds those two sign-in methods, keeps one allow policy whose rule asks the Gateway whether the person is a member or invited, puts one Access application in front of the Gateway's host and one in front of the apps' hosts (MCP, the OAuth endpoints and each app's public routes stay reachable without a login), and gives the Gateway the team domain and both AUD tags in one change.

Invitations need nothing more: an invitee gets past Access as soon as they are invited. Run it again after deploying an app with new public routes, or after anything changed by hand. It changes only what differs and leaves alone what it didn't set up.

```sh
everyapp access on
everyapp access on --team acme --json
```

- `--team <name>`: Name for a new Zero Trust team when the account has none: its sign-in page is <name>.cloudflareaccess.com, for good (asked at a terminal; ignored once a team exists)

### `everyapp access off`
Turn Cloudflare Access off for the Gateway and its apps.

Removes CLOUDFLARE_ACCESS_AUD, CLOUDFLARE_ACCESS_APPS_AUD and CLOUDFLARE_ACCESS_TEAM_DOMAIN from the Gateway in one change, so it stops requiring Access at once, then deletes the two Access applications (one that also covers something else only loses EveryApp's hosts). The Zero Trust team, its identity providers and the allow policy stay: other applications may use them. Asks first.

```sh
everyapp access off
```

- `--yes`: Turn Access off without asking

### `everyapp access show`
Show how Cloudflare Access fronts the Gateway.

The Zero Trust team, whether the allow policy asks the Gateway who is a member, the sign-in methods, the two Access applications, and which Access settings the Gateway has (their values can't be read back). Nothing is changed.

```sh
everyapp access show
```

### `everyapp signin add <id>`
Turn a sign-in provider on: "Continue with Google" (or Microsoft, GitHub, Apple, Cloudflare, your SSO).

Says where to create the OAuth app and the redirect URL to register with it (https://<gateway>/api/auth/callback/<id>), then sets the provider's settings on the Gateway Worker, all in one new version under your Cloudflare login, live on the next request. At a terminal it asks for each setting: the client id shown as typed, the client secret hidden, an optional one (microsoft's tenant, oidc's label) left as it is when you press Enter. Unattended (--json, or no terminal) every required setting comes from a flag: --client-id, --client-secret-from-env VAR, and for oidc --issuer. The client secret is never taken from the command line.

A provider says who someone is; the Gateway still decides who gets in: a member, or someone with a pending invitation for that exact, verified email. Nobody else.

Safe to repeat: running it again replaces the values given (a rotated secret, a new client). An optional setting not given stays as it is; everyapp secret unset <NAME> removes one. Each provider's console, step by step: the setup guides at https://everyapp.com/docs/agent/setup/guides.

```sh
everyapp signin add google
everyapp signin add github --client-id Iv1.0123456789abcdef --client-secret-from-env GITHUB_SECRET --json
everyapp signin add microsoft --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47
everyapp signin add oidc --issuer https://acme.okta.com --label Okta
```

- `<id>`: The sign-in provider: google, microsoft, github, apple, cloudflare, oidc
- `--client-id <value>`: The OAuth app's client id (not a secret; for apple, the Services ID)
- `--client-secret-from-env <VAR>`: Read the client secret from this environment variable (a secret never goes on the command line)
- `--issuer <url>`: oidc: the issuer's https URL, which serves /.well-known/openid-configuration
- `--label <text>`: oidc: the button text after "Continue with" (default SSO; 40 characters at most)
- `--tenant <value>`: microsoft: the Directory (tenant) ID that pins sign-in to your own directory (recommended), or common, organizations, consumers

### `everyapp signin list`
List the sign-in providers: on, needs setup (naming what is missing) or off.

Reads which of each provider's settings the Gateway Worker holds (names only: a value can't be read back) and says whether the provider is on (every required setting set), needs setup (some set, the rest named; the Gateway keeps it off rather than half configured) or off. A value that is set but malformed also keeps a provider off; the Gateway's log says so (signin.config_problem). Nothing is changed.

```sh
everyapp signin list
```

### `everyapp signin show <id>`
Show a sign-in provider: where to make its OAuth app, the redirect URL, its settings and whether each is set.

The provider's console and what the OAuth app is called there, the redirect URL to register for this Gateway, the scopes asked for (identity only), which claim becomes the email and when it counts as verified, every setting with what it holds and whether it is set, the provider's caveats and its setup guide. Nothing is changed.

```sh
everyapp signin show apple
```

- `<id>`: The sign-in provider: google, microsoft, github, apple, cloudflare, oidc

### `everyapp signin remove <id>`
Turn a sign-in provider off: its settings leave the Gateway; accounts stay.

Asks first (--yes doesn't), then removes every setting of the provider from the Gateway Worker in one new version: the button leaves the sign-in page on the next request. People who signed in with it keep their accounts and sign in another way (a password via Forgot password, another provider, Access). Delete the OAuth app at the provider too: a client the Gateway no longer holds is still a client.

```sh
everyapp signin remove github
```

- `<id>`: The sign-in provider: google, microsoft, github, apple, cloudflare, oidc
- `--yes`: Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp)

### `everyapp secret set <name>...`
Set secrets on your app or your Gateway.

Gateway settings (AI provider keys, EMAIL_FROM, sign-in clients) go to the Gateway, from any directory. Other names go to the app in this directory, or with --app <id> to that app from anywhere; the app's everyapp.config.ts must list them under secrets. Values come from a hidden prompt, --from-env or stdin, never the command line. Changes are live at once; no deploy needed.

```sh
everyapp secret set OPENAI_API_KEY
everyapp secret set GITHUB_TOKEN --from-env GITHUB_TOKEN
echo "$STRIPE_KEY" | everyapp secret set STRIPE_KEY
everyapp secret set MAIN_SECRET --app analytics
```

See what an app needs and what is set: everyapp secret list [<app>]

- `<name>`: Secret or Gateway setting
- `--from-env <VAR>`: Read the value from this environment variable
- `--app <id>`: The app whose secret this is (default: the app in this directory)
- `--verbose`: Show which Worker each secret goes to and its new version

### `everyapp secret unset <name>...`
Remove secrets from your app or your Gateway.

Names go where `secret set` sends them (--app <id> names the app from anywhere). Asks before removing; the change is live at once.

```sh
everyapp secret unset GITHUB_TOKEN
```

- `<name>`: Secret or Gateway setting
- `--yes`: Remove without asking
- `--app <id>`: The app whose secret this is (default: the app in this directory)
- `--json`: Print NDJSON events on stdout (never asks)
- `--verbose`: Show which Worker each secret is removed from

### `everyapp secret list [<app>]`
List what an app needs set and what is: its own secrets and the Gateway's settings.

For one app (the app in this directory, or <app> from anywhere): every setting its manifest declares, where it is held (the Gateway, or the app's Worker), whether it is set, and the one command that opens the app when something required is missing (everyapp configure <app>). Elsewhere with no app named: the Gateway's names and who set them, then every app's settings. Names only, never values.

- `<app>`: An app id (default: the app in this directory; elsewhere, every app)
- `--json`: Print the result as an NDJSON event
- `--verbose`: Also list the names everyapp sets itself

### `everyapp provider add [<provider>]`
Add a provider and set its key or OAuth client in one step, so apps can list it.

Says the one thing to do at the provider (create a key, or register the redirect URI and make an OAuth client), links its page on everyapp.com, then asks for the key or client at hidden prompts and sets it on the Gateway as secret set would. Live at once; no deploy.

Nobody at a terminal (--json, piped, CI), or Enter on nothing: nothing is set, and it prints the one command to run next:
```sh
everyapp secret set OPENROUTER_API_KEY
```

Scripts and agents set it in the same run with --from-env (the variables of the settings' names) or piped NAME=value lines; never on the command line.

A built-in provider (provider list names them) is only its key. An OAuth preset (provider presets: google-workspace, slack, github-oauth) becomes a registered provider, then takes its client; deploying an app that lists one registers it too. Any other API is a spec: its id, name, the page the key comes from (docs), the only hosts the key is ever sent to and how (auth: bearer, header, query or basic), naming the Gateway setting that holds the key. The spec never holds the key. A URL is fetched on this machine. The rules a spec must pass: an id that isn't a built-in provider's, settings named after the id that nothing else reads, and public hosts that aren't the Gateway's own or its apps'. Run in an app's directory, it also writes .everyapp/providers/<id>.json for everyapp dev (your key goes in .dev.vars).

An OpenAI-compatible model provider is a spec with mode "ai": its baseUrl, the key's placement (auth), the models it serves and the defaultModel (embeddingsModel too, when it has one); the AI proxy serves it as a catalog AI provider, inference POSTs alone. Apps list it under providers and call /api/ai/<id>/v1/chat/completions; everyapp ai default <id> makes it the Gateway's default model provider.

--oauth takes an OAuth spec file (auth.kind oauth2-user), or a preset by name. An app lists the scopes it needs in everyapp.config.ts, as the provider names them; people connect in each app. --verbose adds the manifest entry.

```sh
everyapp provider add google-workspace
everyapp provider add openrouter
OPENROUTER_API_KEY=sk-or-... everyapp provider add openrouter --from-env
everyapp provider add github-oauth
printf 'GITHUB_OAUTH_CLIENT_SECRET=%s\n' "$SECRET" | everyapp provider add github-oauth --client-id Iv1.abc
everyapp provider add stripe.json
everyapp provider add https://example.com/providers/stripe.json --replace
everyapp provider add --oauth ./acme.json --from-env
```

- `<provider>`: A built-in provider's id (openrouter), an OAuth preset's (google-workspace, github-oauth), or a spec: a JSON file or an https URL to one (64 KiB at most)
- `--replace`: Replace the provider registered under the spec's id; its key must be set again
- `--oauth <preset>`: An OAuth provider: a preset (provider presets names them: google-workspace, github-oauth), or a JSON spec file with auth.kind oauth2-user
- `--client-id <id>`: An OAuth provider's client id (public); the secret comes from the prompt, piped NAME=value lines or --from-env
- `--from-env`: Set the key or client from the environment variables of its setting names (OPENROUTER_API_KEY; GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET); nothing is asked

### `everyapp provider list`
List the API providers the Gateway offers: built in and registered, each key's state, the apps using each.

Nothing is changed. A key's value can't be read back; only whether it is set, and for a registered provider whether it was set for the hosts the row names now (bound).

```sh
everyapp provider list
```

### `everyapp provider show <id>`
Show a provider: whether its key is set, where the key comes from and goes, who registered it and which apps use it.

What to read to set up and call a provider that has no setup guide. --json carries its whole spec (data.provider). With --save, in an app's directory, the spec is written where everyapp dev reads it.

```sh
everyapp provider show stripe
everyapp provider show stripe --save
```

- `<id>`: The provider's id (provider list names them): stripe
- `--save`: Also write the spec to .everyapp/providers/<id>.json in this app's directory, for everyapp dev

### `everyapp provider remove <id>`
Remove a registered provider from the Gateway; its key stays set until secret unset.

The Gateway stops serving it within 30 seconds. A provider a deployed app lists under capabilities is refused unless --force. The Gateway setting holding its key stays; remove it with everyapp secret unset <NAME>. Registering it again needs the key set again too.

```sh
everyapp provider remove stripe
```

- `<id>`: The provider's id (provider list names them): stripe
- `--force`: Remove it even though deployed apps list it (their calls to it stop)

### `everyapp provider presets`
List the OAuth presets provider add takes: Google, Microsoft 365, Slack, GitHub and more.

Each with its first API host (--json names them all) and the console where its client is made. An app lists the scopes it needs in everyapp.config.ts, as the provider names them. Nothing is read from the Gateway.

```sh
everyapp provider presets
```

### `everyapp provider connections`
List the accounts people connected to OAuth providers in each app on the Gateway.

A connection is one person's, in one app: who connected what, in which app, with the scopes granted, the status and when it was last used. Never a token.

```sh
everyapp provider connections
everyapp provider connections --provider github-oauth
everyapp provider connections --user ben@example.com
everyapp provider connections --app openmail
```

- `--all`: Every organization's connections (default: the Gateway's own organization's)
- `--user <email>`: One person's connections
- `--provider <id>`: One provider's connections
- `--app <app>`: One app's connections, by its id: openmail

### `everyapp provider disconnect <id>`
Remove people's connections to an OAuth provider from the Gateway.

The Gateway drops the tokens it held; the app gets "not connected" until the person connects again in it. --user removes that person's connections in every app, --app narrows it to one app. The CLI holds no token, so the grant stays at the provider until it is revoked there (Disconnect in Connected accounts revokes it from the Gateway).

```sh
everyapp provider disconnect github-oauth --user ben@example.com
everyapp provider disconnect google-workspace --user ben@example.com --app openmail
everyapp provider disconnect github-oauth --all
```

- `<id>`: The OAuth provider's id: github-oauth
- `--user <email>`: This person's connection
- `--all`: Every connection to the provider
- `--app <app>`: Only the connections made in this app, by its id: openmail

### `everyapp provider on <id>` (hidden)
Same as everyapp mcp on; this alias goes after launch week.

- `<id>`: The MCP app (mcp list names them): dataforseo

### `everyapp provider off <id>` (hidden)
Same as everyapp mcp off; this alias goes after launch week.

- `<id>`: The MCP app (mcp list names them): dataforseo

### `everyapp ai show`
What the workspace's default model resolves to now, and every provider it could be.

The provider and model an app that asks for the default chat model gets (ai: { chat: true } in its manifest): the setting (ai default) if there is one, else the first provider of the shipped order whose key is set (OpenRouter, Workers AI, OpenAI, Anthropic, Groq, Mistral, Gemini), else what to set. Then every provider the default could be, in order, each with its key set or not and its catalog models; never a key's value. Says whether calls go through Cloudflare AI Gateway (ai gateway on). The Gateway tool: everyapp_ai_show, run as you.

```sh
everyapp ai show
```

### `everyapp ai default <provider[/model]|off>`
Choose the default model (provider and model) for every app that asks for one, or off for the shipped order.

The workspace's one AI setting, the same as Manage workspace → Usage → AI default. The provider id is everything up to the first slash, the model everything after it (a model id may hold slashes); without a model, the provider's catalog model serves. Embeddings always use the provider's catalog model. A provider whose key isn't set is accepted; one the default can't be (an API provider, an entry without an OpenAI-shaped chat route, AI Gateway) is refused by the Gateway. The Gateway reads the change within 30 seconds; a change queues ai.default_changed. The Gateway tool: everyapp_ai_default, run as you.

```sh
everyapp ai default openrouter
everyapp ai default openrouter/anthropic/claude-sonnet-5.5
everyapp ai default workers-ai --json
everyapp ai default off
```

- `<provider[/model]|off>`: The provider's id (openrouter), or the id and a model (openrouter/anthropic/claude-sonnet-5.5), or off

### `everyapp ai gateway on`
Put Cloudflare AI Gateway in front of every model call: find or make the gateway, set AI_GATEWAY_ID.

Finds the AI Gateway in the Gateway's Cloudflare account (or makes it, logs on, no cache) and records its id as the Gateway setting AI_GATEWAY_ID. From the Gateway's next request every call to a model provider that AI Gateway fronts (OpenRouter, OpenAI, Anthropic, Groq, Mistral, Workers AI) goes through it with the provider's own key still on the call; Gemini and Cohere go direct. Changes no app and no key. For an authenticated gateway, set its token afterwards: everyapp secret set AI_GATEWAY_API_KEY.

```sh
everyapp ai gateway on
everyapp ai gateway on --id acme-models
```

- `--id <id>`: The AI Gateway's id (its name in the dashboard): lowercase letters, digits and single hyphens; everyapp by default

### `everyapp ai gateway off`
Send model calls direct again: unset AI_GATEWAY_ID (the Cloudflare resource stays).

Unsets AI_GATEWAY_ID on the Gateway; every model call goes direct from its next request. The AI Gateway and its logs stay in the account. AI_GATEWAY_API_KEY stays until everyapp secret unset.

```sh
everyapp ai gateway off
```

### `everyapp mcp add <url>`
Add any remote MCP server as an MCP app: its tools reach members' AI clients through the Gateway's /mcp.

The Gateway serves the server's tools on its own /mcp under <id>_<tool> names, holding the server's credential itself: every call is attributed to the member, audited and counted (MCP servers added by URL aren't metered: no cap applies), and read tools are told apart from write tools. The owners and the admins can use it at once; an admin grants others in Admin → Apps → Manage access. Nothing is deployed.

add looks at the URL once from this machine before writing anything. A server that answers without a credential is added with none. One whose 401 names its OAuth metadata is added with OAuth. One that asks for a credential otherwise is refused (REMOTE_MCP_NEEDS_CREDENTIAL) until you say how it authenticates; --force adds it anyway.

The credential is a provider: the app's own <id>-mcp row, written beside it, or --provider <id> for one the Gateway has (its host must be the URL's). --auth bearer|header|query|basic: a static value, <ID>_MCP_TOKEN. At a terminal add offers to set it (hidden input); --from-env VAR sets it from a variable; later: everyapp secret set TREG_MCP_TOKEN Once set, add checks it with one tools/list from here. The Gateway sends it only to the URL's host. --auth oauth: the Gateway signs in to the server. add discovers its authorization server and registers a client with it, or, where the server takes client metadata documents instead, gives it the URL of the Gateway's own; for a server that takes neither, register one with the redirect URI add prints and give --client-id (--client-secret-from-env). Each member then connects their own account, at the connect page add prints and opens (--no-open: print only).

The Gateway follows no redirects.

```sh
everyapp mcp add https://mcp.deepwiki.com/mcp
everyapp mcp add https://treg.to/mcp/ --auth bearer
everyapp mcp add https://api.example.org/mcp --name example --auth header --header X-Api-Key --risk read
everyapp mcp add https://mcp.linear.app/mcp
everyapp mcp add https://api.elevenlabs.io/v1/mcp
```

- `<url>`: The server's MCP address (https://, the one URL the Gateway ever sends its credential to)
- `--name <value>`: The app's id and tool prefix (default: from the URL's host, https://mcp.treg.to/mcp → treg)
- `--auth none|bearer|header|query|basic|oauth`: How the Gateway authenticates to the server (default: OAuth when its 401 names resource metadata, none when it answers without a credential)
- `--header <value>`: With --auth header: the header the server reads the credential from (X-Api-Key)
- `--prefix <value>`: With --auth bearer: the scheme instead of Bearer (Token); with --auth header: what goes before the value
- `--param <value>`: With --auth query: the query parameter the server reads the credential from (api_key)
- `--provider <id>`: Use a provider the Gateway has as the credential (provider list names them): an API key, or an OAuth provider; the URL's host must be one of its hosts
- `--client-id <id>`: With --auth oauth: a client registered with the server by hand, for a server that registers none itself
- `--client-secret-from-env <VAR>`: --client-id's secret, from this environment variable
- `--risk annotations|read|write`: How a tool's risk is decided: from the server's hints, unknown as write (annotations, the default), or every tool read or write
- `--description <value>`: What the app is for, as Admin → Apps and everyapp_list_apps say it (default: the server's own description)
- `--from-env <VAR>`: With a static --auth: set the credential from this environment variable (as secret set --from-env)
- `--force`: Add a server that asks for a credential with none (its tools won't list until it has one)
- `--no-open`: Print the OAuth connect page without opening it in the browser

### `everyapp mcp remove <id>`
Remove an MCP app: it leaves /mcp and Admin → Apps, and everyone's access to it goes.

Like deleting an app: the Gateway stops serving its tools within 30 seconds, and everyone's access to it, the personal tokens bound to it, its tools snapshot and its place in AI connections go with it. Adding it again starts fresh. To stop serving it and keep all that, turn it off instead: everyapp mcp off <id>.

Its provider row (<id>-mcp) and the key or client it holds stay, with everyone's OAuth connections; everyapp provider remove <id>-mcp and everyapp secret unset <NAME> clean them up.

```sh
everyapp mcp remove treg
```

- `<id>`: The MCP app (mcp list names them): dataforseo, or the id a server was added as

### `everyapp mcp on <id>`
Turn an MCP app on: its tools reach members' AI clients through the Gateway's /mcp.

An MCP app is a data provider (DataForSEO, built in) or any remote MCP server added with everyapp mcp add <url>, offered as an app of the Gateway's own with no page and nothing to deploy: the Gateway serves its tools on its /mcp under <id>_<tool> names, with its own key, and counts and audits every call like an app's. It appears under MCP apps in Admin → Apps.

A built-in's first on adds it: the owners and the admins can use it at once, and an admin grants other members with Manage access. On after off serves it again at once, with everyone's access kept. The key is a Gateway setting the tools need (mcp list names it):
```sh
everyapp secret set DATAFORSEO_API_KEY
```

Safe to repeat: an app that is on stays on, with its access.

```sh
everyapp mcp on dataforseo
everyapp mcp on treg --json
```

- `<id>`: The MCP app (mcp list names them): dataforseo, or the id a server was added as

### `everyapp mcp off <id>`
Turn an MCP app off: its tools leave /mcp, and everyone's access is kept for on.

The Gateway stops serving the app's tools within 30 seconds and the home page stops listing it. Everyone's access, the personal tokens bound to it and its tools snapshot are kept, so everyapp mcp on <id> serves it again at once. To remove it for good, with all of that: everyapp mcp remove <id>.

(Until 2026-10-25 off removed the app; that is remove now.)

```sh
everyapp mcp off dataforseo
```

- `<id>`: The MCP app (mcp list names them): dataforseo, or the id a server was added as

### `everyapp mcp list`
List the MCP apps: built-in and added, on or off, their tools and whether each key is set.

Nothing is changed. A key's value can't be read back; only whether it is set.

```sh
everyapp mcp list
```

### `everyapp mcp show <id>`
Show an MCP app: its address, credential, status, last tool listing and every tool with its risk.

For a remote server: the URL, how the Gateway authenticates, its provider, whether the key is set (and set for the hosts it has now), or for OAuth who has connected (never a token) and the connect page, the risk default, when the tools were last listed (and the error if that failed), then every tool the server listed: its name on the Gateway, the server's own name, its risk and where that comes from (the server's hint, the app's default, your override), and whether it is on. Nothing is changed.

```sh
everyapp mcp show treg
everyapp mcp show dataforseo --json
```

- `<id>`: The MCP app (mcp list names them): dataforseo, or the id a server was added as

### `everyapp mcp refresh <id>`
Drop an MCP app's tools snapshot, so the Gateway lists its tools again.

Only the snapshot goes (the Gateway's copy of the tool list); the app, its access and its settings stay. The Gateway lists the tools again on the next request to its /mcp, or within the hour. Use it after the server changed its tools.

```sh
everyapp mcp refresh treg
```

- `<id>`: The MCP app (mcp list names them): dataforseo, or the id a server was added as

### `everyapp mcp tool <id> <tool>`
Override one tool of a remote MCP app: its risk, or whether it is listed at all.

A tool's risk decides who can call it: read tools every connection, write tools only read & write ones; --off keeps a tool from every AI client. The server's hints decide it unless the app's --risk default or this override says otherwise. The Gateway lists the tools again on first use. A built-in MCP app's tools are its own and can't be changed here.

```sh
everyapp mcp tool treg delete_everything --off
everyapp mcp tool treg get_report --risk read
everyapp mcp tool treg search --risk annotations
```

- `<id>`: The MCP app (mcp list names them): dataforseo, or the id a server was added as
- `<tool>`: The tool: the server's name for it, or its name on the Gateway (mcp show lists both)
- `--risk read|write|annotations`: The tool's risk: read or write; annotations drops your override
- `--on`: List the tool (the default)
- `--off`: Leave the tool out: it isn't listed, and a call answers Unknown tool

### `everyapp email show`
Show the app's senders and inbound addresses.

Lists the app's senders and inbound addresses on the Gateway, and whether each inbound address is routed.

```sh
everyapp email show
everyapp email show --manifest ../analytics/everyapp.config.ts
```

- `--manifest <path>`: Path to everyapp.config.ts, if it isn't in this directory

### `everyapp email set`
Set senders or inbound addresses, without a deploy.

Each flag replaces its whole list; a list you don't name is kept. The Gateway picks up a change within 30 seconds, without a deploy. Addresses set before the app's first upload are routed by its next deploy.

Requirements: --sender everyapp.config.ts lists capabilities.email; each domain is set up for Email Sending --inbound everyapp.config.ts declares email: { inbound: true }; the domain is on Cloudflare DNS and doesn't get its mail elsewhere already (its MX records), unless --replace-mx

```sh
everyapp email set --sender '*@mail.example.com'
everyapp email set --inbound reports@mail.example.com
everyapp email set --inbound '*@example.com' --enable-email-routing
```

- `--sender <pattern>` (repeatable): Address the app may send as: '*@<domain>' or one address (repeat, up to 20)
- `--inbound <address>` (repeatable): Address whose mail goes to the app: '*@<apex>' or one address (repeat, up to 50)
- `--enable-email-routing`: Turn on Email Routing for inbound domains without asking
- `--replace-mx`: Turn on Email Routing even for a domain whose MX records deliver its mail elsewhere (Google Workspace...): they are replaced, and that mail stops arriving there
- `--manifest <path>`: Path to everyapp.config.ts, if it isn't in this directory

### `everyapp email unset <senders|inbound>...`
Clear senders or inbound addresses, without a deploy.

Clearing inbound addresses removes their Email Routing rules; a catch-all goes back to dropping mail. Nothing is built or deployed.

```sh
everyapp email unset inbound
everyapp email unset senders inbound
```

- `<senders|inbound>`: List to clear: senders or inbound
- `--manifest <path>`: Path to everyapp.config.ts, if it isn't in this directory

### `everyapp events add [<url>]`
Send the organization's events to a URL (a signed POST) or by email to its owners and admins.

A webhook gets each event as a JSON POST, signed with the subscription's secret: X-EveryApp-Signature: t=<seconds>,v1=<hex>, HMAC-SHA256 over <t>.<body>; the receiver checks it (/docs/events has the code). Without --secret one is made and shown once: copy it then. Slack's Workflow Builder, Zapier, n8n, Make and your own endpoint all take one; the body's top-level summary is a line a person reads.

The URL must be https:// on a public hostname: not an IP address, not a local or internal name, not the Gateway or one of its apps. For a receiver on a private network, set EVENTS_ALLOW_PRIVATE_TARGETS on the Gateway with the value "true" (self-host only; everyapp secret set EVENTS_ALLOW_PRIVATE_TARGETS): then http://, IP addresses and private names are let through.

--email mails each event to the organization's owners (owners) or owners and admins (admins), from the Gateway's sender (EMAIL_FROM); it takes no address. An organization has at most 25 subscriptions. The Gateway sends each event within a minute.

```sh
everyapp events add https://hooks.example.com/everyapp --events cap.*,member.*
everyapp events add https://hooks.zapier.com/hooks/catch/1/abc --name Zapier --secret
everyapp events add --email admins --events cap.*
everyapp events add https://n8n.example.com/webhook/x --secret-from-env N8N_SECRET --json
```

- `<url>`: The webhook's https:// URL (leave it out with --email)
- `--events <types>` (repeatable): The events to send, comma separated: types (member.joined), prefixes (cap.*, app.crm.*) or * (repeat to add more; default: every event but test pings)
- `--name <text>`: What to call it, like 'Slack #ops' (default: the URL's host, or Email owners and admins)
- `--email owners|admins`: Mail each event to the organization's owners, or its owners and admins (admins), instead of a webhook
- `--secret`: Give the webhook's signing secret yourself, 16 to 128 characters: asked at a hidden prompt, or read piped in, never typed on the command line (default: one is made and shown once)
- `--secret-from-env <VAR>`: Read the signing secret from this environment variable

### `everyapp events list`
List the organization's subscriptions: where each goes, what it takes, how its last delivery went.

A webhook shows its URL's host and path (never its query or secret); an email one, whom it mails. Nothing is changed.

```sh
everyapp events list
```

### `everyapp events remove <id>`
Remove a subscription (a built-in one is disabled instead).

Nothing more is delivered to it; its delivery log stays for 30 days. The Gateway's built-in cap alerts are disabled instead of removed, so the Gateway never makes them again.

```sh
everyapp events remove sub_0123456789abcdef01234567
```

- `<id>`: The subscription, by its sub_ id (events list names them)

### `everyapp events enable <id>`
Resume a subscription: new events are queued for it again.

What happened while it was disabled isn't sent. Safe to repeat.

```sh
everyapp events enable sub_0123456789abcdef01234567
```

- `<id>`: The subscription, by its sub_ id (events list names them)

### `everyapp events disable <id>`
Pause a subscription: no new events are queued for it, and what is queued is dropped.

Turn the built-in cap alerts off this way. Safe to repeat; events enable resumes it.

```sh
everyapp events disable sub_0123456789abcdef01234567
```

- `<id>`: The subscription, by its sub_ id (events list names them)

### `everyapp events test <id>`
Send a test event (ping) to one subscription and wait to see whether it was delivered.

Sends a ping to that subscription only, paused or not, and waits for the first attempt: delivered or failed with the receiver's status code or the error. A failed test is retried like any delivery.

```sh
everyapp events test sub_0123456789abcdef01234567
everyapp events test sub_0123456789abcdef01234567 --json
```

- `<id>`: The subscription, by its sub_ id (events list names them)

### `everyapp events deliveries [<id>]`
List the last deliveries (30 days): the event, its subscription, attempts, status, next attempt, last error.

A delivery is retried after 1, 5 and 30 minutes, then 2, 8 and 24 hours; the seventh failure is dead. Nothing is changed.

```sh
everyapp events deliveries
everyapp events deliveries sub_0123456789abcdef01234567 --limit 50
everyapp events deliveries --dead
```

- `<id>`: Only this subscription's (default: every subscription's)
- `--dead`: Only deliveries that ran out of attempts (dead), to redeliver
- `--limit <n>`: How many to show, newest first: 1 to 100 (default 20)
- `--before <cursor>`: The next page: the previous page's nextBefore

### `everyapp events redeliver <delivery>`
Send a failing or dead delivery again: the Gateway sends it within a minute, with the full retry schedule.

Its attempts start over at 0. A delivered one is left alone. The receiver may get the same event id again: receivers deduplicate on it.

```sh
everyapp events redeliver dlv_0123456789abcdef01234567
```

- `<delivery>`: The delivery, by its dlv_ id (events deliveries names them)

### `everyapp events types`
List the event types --events takes, with their versions.

The catalogue this CLI knows, and how a pattern names several (member.*, app.crm.*, *). No Gateway is needed.

```sh
everyapp events types
```

### `everyapp workspace show`
The organization: your role, whether it can send mail, and how many members, invitations, groups and apps it has.

```sh
everyapp workspace show --json
```

The Gateway tool: everyapp_workspace_show (everyapp call everyapp_workspace_show).

### `everyapp workspace rename <name>`
Rename the workspace: the name members see in the organization switcher and in invitations.

```sh
everyapp workspace rename 'Acme Corp'
everyapp workspace rename 'Acme Corp' --json
```

The Gateway tool: everyapp_workspace_rename (everyapp call everyapp_workspace_rename).

- `<name>`: The new name: 1 to 64 characters, no line breaks (quote one with spaces)

### `everyapp workspace users`
The members with their role and state, then the pending invitations.

```sh
everyapp workspace users
```

The Gateway tool: everyapp_workspace_users (everyapp call everyapp_workspace_users).

### `everyapp workspace role <email> <owner|admin|member>`
Set a member's role: owner, admin or member.

The Gateway's rules: only an owner changes an admin or an owner, or makes one; nobody changes their own role; the last owner is never demoted.

```sh
everyapp workspace role sam@example.com owner
everyapp workspace role sam@example.com member --json
```

The Gateway tool: everyapp_workspace_role (everyapp call everyapp_workspace_role).

- `<email>`: The member, by email or user id
- `<owner|admin|member>`: The role to give them

### `everyapp workspace invite <email>`
Invite someone by email: the Gateway mails the invitation when it can send email.

The answer says whether it was mailed. The tool never returns the link: where the Gateway sends no email, everyapp workspace invite-link <email> prints one (under your Cloudflare login), or copy it from Admin → Users.

```sh
everyapp workspace invite ann@example.com
everyapp workspace invite ann@example.com --role admin --json
```

The Gateway tool: everyapp_workspace_invite (everyapp call everyapp_workspace_invite).

- `<email>`: The address to invite
- `--role member|admin` (default `member`): The role they join with

### `everyapp workspace invite-link <email|id>`
Print a new link for a pending invitation, under the Cloudflare login (for a Gateway that sends no email).

The CLI twin of Admin → Users → Copy invite link: a new invite link for a pending, unexpired invitation of the install organization, written into the Gateway's D1 with your Cloudflare login. The Gateway's tools never return a link to their caller, so this is one of the two workspace commands that write D1 (ADR-0003). Earlier links keep working until the invitation is accepted or canceled. Hand the link to the person yourself.

```sh
everyapp workspace invite ann@example.com
everyapp workspace invite-link ann@example.com
```

- `<email|id>`: The pending invitation, by invited email or id (workspace users lists them)

### `everyapp workspace uninvite <email|id>`
Cancel a pending invitation: its links stop working.

```sh
everyapp workspace uninvite ann@example.com
```

The Gateway tool: everyapp_workspace_uninvite (everyapp call everyapp_workspace_uninvite).

- `<email|id>`: The pending invitation, by invited email or id (workspace users lists them)

### `everyapp workspace deactivate <email>`
Lock a member out everywhere: no sign-in, every session ended, their tokens and AI connections revoked.

```sh
everyapp workspace deactivate ann@example.com
```

The Gateway tool: everyapp_workspace_deactivate (everyapp call everyapp_workspace_deactivate).

- `<email>`: The member, by email or user id (workspace users lists them)

### `everyapp workspace reactivate <email>`
Lift a deactivation: they can sign in again (revoked tokens and connections stay revoked).

```sh
everyapp workspace reactivate ann@example.com
```

The Gateway tool: everyapp_workspace_reactivate (everyapp call everyapp_workspace_reactivate).

- `<email>`: The member, by email or user id (workspace users lists them)

### `everyapp workspace remove <email>`
Remove a member from the organization, and their account when it belongs to no other.

Asks first at a terminal; elsewhere it needs --yes.

```sh
everyapp workspace remove ann@example.com --yes --json
```

The Gateway tool: everyapp_workspace_remove (everyapp call everyapp_workspace_remove).

- `<email>`: The member, by email or user id (workspace users lists them)
- `--yes`: Remove without asking (needed where nobody is at a terminal)

### `everyapp workspace reset-email <email>`
Mail a member a password-reset link (the link goes to their inbox, never to you).

```sh
everyapp workspace reset-email ann@example.com
```

The Gateway tool: everyapp_workspace_reset_email (everyapp call everyapp_workspace_reset_email).

- `<email>`: The member, by email or user id (workspace users lists them)

### `everyapp workspace reset-link <email>`
The way back in: print a one-hour, single-use password-reset link for a member, under the Cloudflare login.

For an owner locked out of the Gateway (a lost password, no email sending): Better Auth's own reset token, written into the Gateway's D1 with your Cloudflare login, consumed by the Gateway's /reset-password page. Whoever opens it sets the account's password, so hand it to the person yourself. Only for an active member of the install organization that belongs to no other (USER_IN_OTHER_ORGANIZATION: a password is account-wide). Password sign-in must be on (EMAIL_PASSWORD_SIGN_IN). Everything else here but invite-link goes through the Gateway as you; this is the recovery path that can't (ADR-0003). A member who can sign in uses everyapp workspace reset-email.

```sh
everyapp workspace reset-link owner@example.com
```

- `<email>`: The member of the install organization, by email

### `everyapp workspace groups`
The groups, with how many members and apps each has.

```sh
everyapp workspace groups
```

The Gateway tool: everyapp_workspace_groups (everyapp call everyapp_workspace_groups).

### `everyapp workspace group create <name>`
Make a group: a named set of members that apps are granted to as one.

```sh
everyapp workspace group create Sales --description "The sales team"
```

The Gateway tool: everyapp_workspace_group_create (everyapp call everyapp_workspace_group_create).

- `<name>`: The group's name, 1 to 60 characters, unique in the organization
- `--description <text>`: What the group is for (empty text clears it)

### `everyapp workspace group set <group>`
Rename or describe a group.

```sh
everyapp workspace group set Sales --name "Sales and marketing"
```

The Gateway tool: everyapp_workspace_group_set (everyapp call everyapp_workspace_group_set).

- `<group>`: The group, by name or grp_ id (workspace groups lists them)
- `--name <name>`: A new name
- `--description <text>`: What the group is for (empty text clears it)

### `everyapp workspace group delete <group>`
Delete a group: what it granted ends with it.

Asks first at a terminal; elsewhere it needs --yes.

```sh
everyapp workspace group delete Sales --yes
```

The Gateway tool: everyapp_workspace_group_delete (everyapp call everyapp_workspace_group_delete).

- `<group>`: The group, by name or grp_ id (workspace groups lists them)
- `--yes`: Delete without asking (needed where nobody is at a terminal)

### `everyapp workspace group members <group>`
Who is in a group; --add, --remove or --set change it.

```sh
everyapp workspace group members Sales
everyapp workspace group members Sales --add ann@example.com --add bob@example.com
everyapp workspace group members Sales --set ann@example.com
```

The Gateway tools: everyapp_workspace_group_members to read, everyapp_workspace_group_members_set to change.

- `<group>`: The group, by name or grp_ id (workspace groups lists them)
- `--add <email>` (repeatable): Add a member, by email or user id (repeat for several)
- `--remove <email>` (repeatable): Remove a member, by email or user id (repeat for several)
- `--set <email>` (repeatable): Replace the whole list with these (repeat for several; alone, with neither --add nor --remove)

### `everyapp workspace group apps <group>`
Which apps a group opens; --add, --remove or --set change it.

```sh
everyapp workspace group apps Sales
everyapp workspace group apps Sales --add crm
```

The Gateway tools: everyapp_workspace_group_apps to read, everyapp_workspace_group_apps_set to change.

- `<group>`: The group, by name or grp_ id (workspace groups lists them)
- `--add <app>` (repeatable): Add an app, by id (repeat for several)
- `--remove <app>` (repeatable): Remove an app, by id (repeat for several)
- `--set <app>` (repeatable): Replace the whole list with these (repeat for several; alone, with neither --add nor --remove)

### `everyapp workspace apps`
Every app with whether everyone can open it, how many members have access, its state and what it still needs set.

```sh
everyapp workspace apps --json
```

The Gateway tool: everyapp_workspace_apps (everyapp call everyapp_workspace_apps).

### `everyapp workspace app set <app>`
Change an app's name, description or whether everyone can open it.

Catalog metadata only: the next deploy sets the name and description again from everyapp.config.ts.

```sh
everyapp workspace app set crm --everyone on
everyapp workspace app set crm --name "Open CRM" --description "Contacts and deals"
```

The Gateway tool: everyapp_workspace_app_set (everyapp call everyapp_workspace_app_set).

- `<app>`: The app, by id (crm) or row id (workspace apps lists them)
- `--name <name>`: The name the app library shows (1 to 255 characters)
- `--description <text>`: The description under it
- `--everyone on|off`: Available to everyone: on, every member opens it, new members too; off, only owners, admins and those granted it

### `everyapp workspace app access <app>`
Who can open an app; --add, --remove or --set change the direct grants.

Owners and admins open every app by their role. A change touches direct grants only; what a group grants stays (workspace group apps), and so does "available to everyone" (workspace app set --everyone).

```sh
everyapp workspace app access crm
everyapp workspace app access crm --add ann@example.com
everyapp workspace app access crm --set ann@example.com --set bob@example.com --json
```

The Gateway tools: everyapp_workspace_app_access to read, everyapp_workspace_app_access_set to change.

- `<app>`: The app, by id (crm) or row id (workspace apps lists them)
- `--add <email>` (repeatable): Add a member's direct grant, by email or user id (repeat for several)
- `--remove <email>` (repeatable): Remove a member's direct grant, by email or user id (repeat for several)
- `--set <email>` (repeatable): Replace the whole list with these (repeat for several; alone, with neither --add nor --remove)

### `everyapp workspace app cap <app> [<dollars|off>]`
Cap an app's provider spend per month in dollars, lift its own cap, or exempt it from the workspace default.

off clears the app's own cap (the workspace default then binds); --unlimited with dollars or off is refused.

```sh
everyapp workspace app cap crm 20
everyapp workspace app cap crm off
everyapp workspace app cap crm --unlimited
```

The Gateway tool: everyapp_workspace_app_cap (everyapp call everyapp_workspace_app_cap).

- `<app>`: The app, by id or row id: the organization's own, or a shared one
- `<dollars|off>`: Dollars of provider-reported cost per UTC month (0.01 to 1,000,000), or off for no cap of its own (the workspace default applies); not with --unlimited
- `--unlimited`: No cap at all, even with a workspace default (instead of dollars or off)

### `everyapp workspace cap default <dollars|off>`
Set or clear the workspace default cap: what binds every app without a cap or --unlimited of its own.

```sh
everyapp workspace cap default 20
everyapp workspace cap default off --json
```

The Gateway tool: everyapp_workspace_cap_default (everyapp call everyapp_workspace_cap_default).

- `<dollars|off>`: Dollars of provider-reported cost per UTC month (0.01 to 1,000,000) for every app without its own cap, or off for no default

### `everyapp workspace usage`
What the apps spent in a month: per app (with the cap that binds it), per member and per provider.

```sh
everyapp workspace usage --month 2026-10 --json
```

The Gateway tool: everyapp_workspace_usage (everyapp call everyapp_workspace_usage).

- `--month <YYYY-MM>`: The UTC month (default: this one)

### `everyapp workspace activity`
The tool-call audit trail, newest first: who called which tool on which app, and what came of it.

```sh
everyapp workspace activity --limit 20
everyapp workspace activity --app crm --decision blocked --since 2026-10-24 --json
```

The Gateway tool: everyapp_workspace_activity (everyapp call everyapp_workspace_activity).

- `--app <app>`: Calls on this app only, by id or row id
- `--user <email>`: Calls by this member only, by email or user id
- `--decision allowed|blocked`: Allowed or blocked calls only
- `--risk read|write`: Tools of this risk only
- `--since <time>`: At or after this time (ISO 8601, UTC)
- `--limit <n>`: Rows per page, 1 to 200 (default 50)
- `--before <cursor>`: The next page: the previous page's nextBefore, as <time>:<id>

### `everyapp workspace audit`
The audit log, newest first: every event the Gateway recorded, who did it and what it was about.

```sh
everyapp workspace audit --limit 20
everyapp workspace audit --actor mia@acme.com --type member.* --since 2026-10-24 --json
```

The Gateway tool: everyapp_workspace_audit (everyapp call everyapp_workspace_audit).

- `--actor <who>`: Events this actor caused: a member by email or user id, an AI connection's or token's id, an app's id, or an operator's email
- `--type <type>`: One event type (member.joined), every type under a prefix (member.*, app.crm.*), or * for everything, pings and tool calls included
- `--since <time>`: At or after this time (ISO 8601, UTC)
- `--limit <n>`: Rows per page, 1 to 200 (default 50)
- `--before <cursor>`: The next page: the previous page's nextBefore, as <time>:<id>

### `everyapp workspace tokens`
Your personal access tokens for the organization (never a token's value).

Tokens are made under Manage workspace → Tokens only.

```sh
everyapp workspace tokens --all
```

The Gateway tool: everyapp_my_tokens (everyapp call everyapp_my_tokens).

- `--all`: Revoked and expired tokens too

### `everyapp workspace token revoke <id>`
Revoke one of your personal access tokens: it stops working on its next request.

```sh
everyapp workspace token revoke 3f2a…
```

The Gateway tool: everyapp_revoke_token (everyapp call everyapp_revoke_token).

- `<id>`: The token's id or name (workspace tokens lists them)

### `everyapp workspace connections`
Your AI connections to the Gateway: which AI app, which apps it may use, read or write.

```sh
everyapp workspace connections
```

The Gateway tool: everyapp_my_connections (everyapp call everyapp_my_connections).

### `everyapp workspace connection revoke <id>`
Revoke one of your AI connections: the client is out on its next request.

```sh
everyapp workspace connection revoke mcpc_…
```

The Gateway tool: everyapp_revoke_connection (everyapp call everyapp_revoke_connection).

- `<id>`: The connection's id (workspace connections lists them)

### `everyapp workspace linked-dev [<on|off|show>]`
Let owners and admins run `everyapp dev --gateway` against this Gateway's providers (linked dev), or stop it.

Off by default: a Gateway that didn't turn it on refuses the sign-in and the route. Turning it off stops tokens already issued on their next call.

```sh
everyapp workspace linked-dev on
everyapp workspace linked-dev show
```

The Gateway tools: everyapp_workspace_show to read, everyapp_workspace_linked_dev to change.

- `<on|off|show>`: Turn linked dev on or off for the organization, or show it (default)

### `everyapp call [<tool>] [<json>]`
Call one of the Gateway's tools: every admin action (everyapp_*) and every app's tools.

The Gateway's tools are its one admin API: the same services as Manage workspace and the same tools an AI app gets on <gateway>/mcp, run as you. The workspace, events and ai commands are each one of them; this reaches all of them, and the apps' tools too. The answer is printed as the tool gives it; --json puts it in the done event's data.

As whom: EVERYAPP_TOKEN (a personal access token from Manage workspace → Tokens), else the sign-in everyapp login --gateway stored, else a sign-in now in the browser.

```sh
everyapp call --list
everyapp call everyapp_workspace_users
everyapp call everyapp_workspace_invite '{"email":"ann@example.com","role":"admin"}'
echo '{"query":"contacts"}' | everyapp call everyapp_search_tools - --json
```

- `<tool>`: The tool's name, as --list shows it (everyapp_workspace_users, crm_list_contacts)
- `<json>`: The tool's arguments as one JSON object (default {}); - reads them from stdin
- `--list`: List every tool you can call, with its title, instead of calling one

### `everyapp docs [<page>]`
Print a page of the agent docs, from everyapp.com or, offline, the copy bundled with everyapp.

The agent docs are the reference coding agents answer from: every command, the --json protocol, every error code, everyapp.config.ts, and a setup guide per integration. They live at https://everyapp.com/docs/agent (https://everyapp.com/llms.txt lists them) and change without an everyapp upgrade. This prints one as Markdown: from the site when it answers, else from the copy this everyapp was built with (it says so; that copy may be older).

```sh
everyapp docs
everyapp docs manifest
everyapp docs setup/openrouter
everyapp docs errors --offline
```

- `<page>`: The agent docs page: manifest, setup/openrouter, errors (a URL or .md works too); none lists them
- `--offline`: Read the copy bundled with this everyapp; don't try everyapp.com
