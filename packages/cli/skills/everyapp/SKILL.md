---
name: everyapp
description: Create, run, deploy and manage private web apps on Cloudflare with everyapp (Every App). Use before running any everyapp command, to deploy an app, set a secret, query its database or check the Gateway.
---

everyapp: self-hosted platform for private web apps on Cloudflare. While
publishing is paused the command is `pnpm everyapp` (never `npx everyapp`).

Pass --json. One JSON event per line; "done" = success; exit 2 = show the
user the last action_required (url, code), then run its data.rerun (the same
command, unless it names another); exit 1 = show the error; if data.authorize
is set, ask before using data.rerun. waiting: true = keep reading (up to 15
min: device login, owner link).

State:   pnpm everyapp status --json   (data.fixes says what to run when something is off)
Gateway: pnpm everyapp setup --domain <host> --json   (install, upgrade, repair;
         --mode hosted only when the user asks for the hosted Gateway)
New app: pnpm everyapp create <id> --json   then cd into it and edit src/; the
         manifest is everyapp.config.ts
Run:     pnpm everyapp dev   (long-running, human-facing: start it in the
         background and read the printed URL; no --json)
Ship:    pnpm everyapp deploy --json   (from the app directory; safe to repeat;
         also upgrades the Gateway to this checkout when it has to rebind).
         No Gateway yet: action_required install_gateway; ask the user, run
         its data.rerun (setup), then deploy again.
Release: someone else's app, without a clone: pnpm everyapp deploy
         https://github.com/<owner>/<repo> --json (its latest release's
         everyapp-release.tar.gz; a tarball URL or file works too). NO_RELEASE:
         the repository publishes none; clone it, then pnpm install && pnpm
         everyapp deploy. Never build a repository from its URL yourself.
         To publish one: pnpm everyapp deploy --bundle-only (new apps' release
         workflow runs it on every v* tag).
Shared:  hosted Gateway only, platform organization owners/admins, when the
         user asks for a first-party app every organization opens:
         deploy --shared --json (redeploys and secret set keep it shared), or for a
         Worker deployed by other means: pnpm everyapp register <id>
         --worker <name> --manifest <everyapp.config.ts> --json
         (WORKER_NAME_MISMATCH names the Worker name to deploy under).
Hosted:  third-party apps on a hosted Gateway, only when the user has a deploy
         key: EVERYAPP_DEPLOY_TOKEN=<key> pnpm everyapp deploy --gateway <url> --json
         (no Cloudflare login; EVERYAPP_GATEWAY_URL works too; BUNDLE_REFUSED
         lists what the hosted policy refuses)
Data:    pnpm everyapp db migrate (local)   pnpm everyapp db query "<sql>" [--local] --json
         (a production write stops with CONFIRMATION_REQUIRED: add --yes only
         if the user said so). pnpm everyapp db restore --json undoes the last
         deploy's migrations (and every write since): only when the user asks.
Postgres: an app with resources.hyperdrive or migrations.dialect "postgresql"
         reads POSTGRES_DATABASE_URL (and <BINDING>_ORIGIN_URL) from
         .everyapp/secrets.env, which the user writes; never print, commit or
         ask for its values in chat. deploy runs drizzle-kit migrate before
         the upload.
Secrets: pnpm everyapp secret set NAME --from-env VAR --json   (live at once, no deploy)
         The name decides where it goes. A Gateway setting (OPENAI_API_KEY,
         EMAIL_FROM, LINKEDIN_CLIENT_ID, …) is set on the Gateway from any
         directory. An app's own secret must be listed under `secrets` in
         its everyapp.config.ts and is set from the app's directory after
         its first deploy (SECRET_NOT_DECLARED: add it there first). Never
         put a value on the command line. secret unset NAME; secret list
         (in an app directory: the app's secrets and the Gateway settings it
         needs, set or not; elsewhere: the Gateway's).
Email:   pnpm everyapp email set --sender "*@<domain>" --inbound <address> --json
         In the app's directory, after its first deploy; nothing is deployed. --sender
         replaces the From addresses the Gateway lets the app name (everyapp.config.ts
         lists capabilities.email); --inbound replaces the addresses routed to its
         email() handler (everyapp.config.ts declares email: { inbound: true }) and
         makes the Email Routing rules now. EMAIL_ROUTING_DISABLED needs the user's
         yes: rerun with --enable-email-routing only if they said so. email unset
         senders|inbound clears; email show prints both.
Remove:  pnpm everyapp delete <id> --json   never add --purge, --force-dns,
         --allow-delete-*, --allow-downgrade, or --yes to delete unless the
         user asked.

Only a person can: approve the Cloudflare login, open the owner link, pick
a workers.dev subdomain, pay for Workers Paid, buy a domain. Interactive
setup optionally offers browser deployment: a Yes/No prompt (default No),
then a hidden Cloudflare API token prompt. Never ask for its value in chat.
Otherwise, only a hosted Gateway's deploy key is supplied.
Full reference: https://everyapp.com/docs/commands
