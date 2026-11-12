---
title: Troubleshooting by symptom
description: What to do when something is wrong and there's a symptom but no code, grouped by setup, domains, deploys, running apps, secrets, local dev, MCP and Access.
---

First run `everyapp status --json` and work through `data.fixes` ([status](/docs/agent/status)). When a command failed, its code is on [errors](/docs/agent/errors), and `data.fix` or `data.rerun` says what to do. The person's version of this page is [/docs/troubleshooting](/docs/troubleshooting).

## Setup and login

- **Stopped halfway** (any reason): run `everyapp setup` again; it resumes.
- **Owner link lost or expired**, or `NO_OWNER`: run `everyapp setup` again for a new link (the old one stops working).
- **Several Cloudflare accounts**: `choose_account`; pick one, or pass `--account-id`.
- **`GATEWAY_OUTDATED` from a command**: the Gateway's database is behind this everyapp; run `everyapp update`, then the command again.
- **Admin commands (`workspace`, `events`, `ai show|default`, `call`) open a browser or fail with `GATEWAY_REFUSED`**: they run as you through the Gateway. Sign in with `everyapp login --gateway <url>` (choose read & write and all apps) or set `EVERYAPP_TOKEN`; `GATEWAY_TOOL_ERROR` is the Gateway's own refusal (`data.code`).
- **Commands or flags these docs name don't exist**: an old `everyapp`. Run `npm install -g everyapp@latest`; check `everyapp --version`. `everyapp: command not found` means the npm global bin isn't on `PATH`.
- **Node too old or Bun**: `UNSUPPORTED_RUNTIME`. Install Node 22 or 24.
- **In a checkout, `pnpm install` refuses a frozen lockfile**, or `GATEWAY_BUILD_FAILED` after `git pull`: run `pnpm install` (after a lockfile change, `rm -rf node_modules` first).
- **The Gateway's address**: it can't move (`DOMAIN_CHANGE_UNSUPPORTED`); to change it, remove everything and set up again.
- **`UNSAFE_CF_DIRECTORY`**: don't run everyapp with `sudo`; fix `~/.everyapp`'s owner.

## Domains and TLS

- **`DNS_RECORD_CONFLICT`**: a record already answers the hostname. Delete it in Cloudflare → DNS, pick another name, or (with the person's yes) rerun with `--force-dns`.
- **The certificate never comes** (`CERT_PENDING` for more than an hour): check the zone's CAA records allow Cloudflare's authorities.
- **A new address doesn't load right after a deploy**: the local DNS cache still says it's missing (`LOCAL_DNS_STALE`); wait a few minutes or flush DNS. "Goes live on its first visit" means open it once.
- **`ZONE_CUSTOM_DOMAIN_LIMIT`**: Cloudflare allows 100 Custom Domains per zone; delete unused apps or use a second Gateway on another domain.

## Deploys

- **`SCHEMA_DRIFT`**: run `pnpm db:generate`, commit the migration, deploy again.
- **`MIGRATION_FAILED`**: nothing was uploaded; fix the migration. A failure after migrating says how to restore (`everyapp db restore`).
- **`APP_POLICY`**: build the Worker with `everyAppWorker()` and fix each listed problem.
- **`RESOURCE_NAME_TAKEN`, `WORKER_NAME_TAKEN`, `HOSTNAME_TAKEN`**: something else holds the app's names. Delete it, or give the app another id.
- **`DURABLE_OBJECT_REMOVED`, `WORKFLOW_REMOVED`**: the manifest dropped one. Restore it, or rerun with the flag after the person agrees to delete its data.
- **`APP_NOT_LIVE`**: run `everyapp status`, then deploy again.
- **`LEASE_HELD`**: another deploy is running (`status` shows whose); retry when it's done.
- **`R2_NOT_ENABLED`**, **`SECRETS_STORE_MISSING`**: a one-time step in the Cloudflare dashboard, then rerun.
- **`HYPERDRIVE_ORIGIN_MISSING`**, **`POSTGRES_URL_MISSING`**: put the database URL in `.everyapp/secrets.env`.
- **A Worker was changed in the dashboard**: the deploy stops on `rerun_interactive`; the person confirms in a terminal.

## Running apps

- **401 from an app**: read the body. The Gateway's own answers are `{ "error", "reason" }`. `unauthenticated` from the app itself after a key rotation means apps must be redeployed with the new key (`IDENTITY_KEY_UNKNOWN`).
- **403 `no_app_access`**: the person can't open the app. Grant it in Admin → Apps, or `everyapp workspace app access <app> --add <email>`.
- **A route meant to be public gets 401 or a redirect**: it isn't in the manifest's `public` (or the method isn't); add it and deploy. Behind Access, the deploy updates Access; after `ACCESS_UPDATE_FAILED`, run `everyapp access on`.
- **403 `csrf_denied`**: a state-changing request from another origin, or a script without `Origin`. **403 `server_fn_denied`**: a server function called by a navigation or from another site.
- **An AI or capability call refused**: read `x-everyapp-error`. `*_not_configured` means set the key (`everyapp configure <app>`); `capability_not_requested` or `provider_not_allowed` means add it to the manifest and deploy; `integration_not_connected` means the person opens the app's Connect link, which leads to the provider or to the Gateway's page that allows the app; `app_monthly_cap_exceeded` means the app is paused at its cap (raise it in Manage workspace → Usage).
- **Email not sent**: see the codes on [email](/docs/agent/email). Not received: `everyapp email show` and `status` (`EMAIL_ROUTE_*`).
- **The app shows Needs setup**: `everyapp configure <app>`.
- **A removed person still gets in for a moment**: identity tokens live up to two minutes; deactivate (not just remove) to end sessions at once.

## Secrets

- **`SECRET_NOT_DECLARED`**: the name isn't a Gateway setting or one the app declares. Fix the name, or declare it and deploy first.
- **A value is set but the app doesn't see it**: it went to the Gateway (a Gateway setting) instead of the app, or the app reads another name. `everyapp secret list <app>` shows where each lives.
- **Works in production, not in dev**: put the value in the app's `.dev.vars`, or use `everyapp dev --gateway <url>`.

## Local dev

- **`DEV_PORT_IN_USE`**: run the `rerun`, which uses the next free port.
- **The dev server doesn't start**: `DEV_SERVER_FAILED` (read its output) or `DEV_SERVER_TIMEOUT` (it must listen on `PORT`).
- **`Binding … needs to be run remotely`**: Workers AI, Vectorize and Artifacts need `remoteBindings: true` and `cf auth login`.
- **Claude Code still lists old tools**: reconnect the server (`/mcp` → reconnect); the dev catalog refreshes every 2 seconds.
- More on [dev](/docs/agent/dev#pitfalls).

## MCP clients

- **A client can't connect or loops on sign-in**: check `MCP_OAUTH_ENABLED` and `MCP_DCR_ENABLED` aren't off, and, behind Access, run `everyapp access on` to put its bypassed paths back.
- **A personal token gets 401 or `token_scope`**: it's revoked, expired, read-only on a write tool, or bound to another app. Make a new one in Manage workspace → Tokens.
- **Tools missing**: hidden by risk (a read-only connection sees no write tools), the person can't open the app, or the app needs setup. `everyapp workspace activity` shows blocked calls with the reason.
- **An MCP app added by URL shows Needs setup**: its key isn't set (`everyapp secret set <ID>_MCP_TOKEN`), its `<id>-mcp` provider row changed since (set the key again), or it's an OAuth server nobody has connected yet (the link is in `everyapp mcp show <id>`). A registration from before 2026-11-02: `mcp remove`, then `mcp add`.
- **A call answers `Connect your <Provider> account to use this tool: <url>`**: that member opens the link once. Each member connects their own account.

## Cloudflare Access

- **Locked out**: [access recovery](/docs/agent/access#recovery).
- **"You don't have an account on this gateway yet"**: invite them; Access asks the Gateway, so nothing else is needed.
- **Apps send people back to sign in**: the apps' Access application changed; `everyapp access on` writes its AUD again.
- **The 51st person is blocked**: Zero Trust Free covers 50 seats.
- **"An account with this email already exists"**: sign in once with the password to link it.

## When to escalate

An `UNEXPECTED` error is a bug: rerun with `--verbose` and report the stack trace (with no secrets) at https://github.com/every-app/every-app/issues, or ask in the Discord the CLI's help names.
