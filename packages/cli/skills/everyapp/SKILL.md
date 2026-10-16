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
Shared:  hosted Gateway only, platform organization owners/admins, when the
         user asks for a first-party app every organization opens:
         deploy --shared --json (redeploys and secret set keep it shared), or for a
         Worker deployed by other means: pnpm everyapp register <id>
         --worker <name> --shared --manifest <everyapp.config.ts> --json
         (WORKER_NAME_MISMATCH names the Worker name to deploy under).
Hosted:  third-party apps on a hosted Gateway, only when the user has a deploy
         key: EVERYAPP_DEPLOY_TOKEN=<key> pnpm everyapp deploy --gateway <url> --json
         (no Cloudflare login; EVERYAPP_GATEWAY_URL works too; BUNDLE_REFUSED
         lists what the hosted policy refuses)
Data:    pnpm everyapp db migrate (local)   pnpm everyapp db query "<sql>" [--local] --json
Postgres: an app with resources.hyperdrive or migrations.dialect "postgresql"
         reads POSTGRES_DATABASE_URL (and <BINDING>_ORIGIN_URL) from
         .everyapp/secrets.env, which the user writes; never print, commit or
         ask for its values in chat. deploy runs drizzle-kit migrate before
         the upload.
Secrets: pnpm everyapp secret set NAME --from-env VAR -y --json   (redeploys the app)
         secret unset NAME, secret list; add --for gateway for the Gateway's settings
Remove:  pnpm everyapp delete <id> --json   never add --purge, --force-dns,
         --allow-delete-*, --allow-downgrade, or --yes to delete unless the
         user asked.

Only a person can: approve the Cloudflare login, open the owner link, pick
a workers.dev subdomain, pay for Workers Paid, buy a domain. There are no
tokens to paste, except a hosted Gateway's deploy key the user gives you.
Full reference: https://everyapp.com/docs/reference/cli
