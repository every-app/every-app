---
title: Driving setup for a person
description: How an agent sets EveryApp up for a person end to end with --json: what only the person can do, prerequisites, the setup steps, Cloudflare Access, create, deploy and share, updates, verification, recovery and the safety rules.
---

This is the agent's side of [/docs/quickstart](/docs/quickstart), [/docs/create-an-app](/docs/create-an-app) and [/docs/people](/docs/people). The step-by-step guide is [setup/gateway](/docs/agent/setup/gateway); every integration has one ([setup guides](/docs/agent/setup/guides)). Commands are `everyapp …` (`npm install -g everyapp`); always add `--json` ([the protocol](/docs/agent/json)).

A fresh `setup` takes 5 to 20 minutes: 5 to 10 for the Gateway upload and its certificate, then up to 15 waiting for the person to open the owner link. Use a long timeout or run it in the background and read its output.

## What only the person can do

| Handoff | Signal | What to ask |
|---|---|---|
| Create a Cloudflare account | none; ask first | Sign up at dash.cloudflare.com and verify the email. |
| Pay for Workers Paid ($5 a month) | `upgrade_workers_paid`, `data.url` | Subscribe at the link, then you rerun. |
| Turn on R2 (the first 10 GB a month is free) | `enable_r2`, `data.url` | Turn it on at the link, then you rerun. |
| Get a domain onto Cloudflare | `add_domain`, `data.url`; or `ZONE_NOT_FOUND` | Buy one in the dashboard (about $10 a year) or point an existing one's nameservers at Cloudflare. |
| Approve the Cloudflare login | `cloudflare_login`, `data.url`, `data.code`, waiting (5 minutes) | Open the link and enter the code. |
| Pick an account | `choose_account`, `data.choices` | Which account? Run that choice's `rerun`. |
| Pick a workers.dev subdomain | `register_workers_subdomain`, `data.url` | Pick any name there. |
| Create the owner account | `claim_owner`, `data.url`, waiting (15 minutes) | Open the link and create the owner account. It works once, expires in 24 hours, and is a password: never post it anywhere. |
| Name the Zero Trust team | `ACCESS_TEAM_REQUIRED`, `data.suggested` | A name for the Access sign-in page (`<name>.cloudflareaccess.com`, permanent). |
| Confirm at a terminal | `rerun_interactive` or `needsTerminal: true` | Run this command in your terminal. |
| Enter a key | `SECRET_VALUE_REQUIRED` | Run `everyapp configure <app>` in your terminal and paste the key there. |

## Prerequisites

Node.js 22.18 or newer (not Bun), git, and pnpm for apps. Nothing else: `cf` comes with everyapp. Contributors working in a checkout of the EveryApp repository run `pnpm install` once, then `pnpm everyapp …`, which builds the Gateway from the checkout instead of downloading the published release.

For unattended runs (CI), set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead of logging in. The token needs Account › Workers Scripts › Edit, Account › D1 › Edit, Account › Workers KV Storage › Edit, Zone › Zone › Read and Zone › DNS › Read, limited to this account and the domain's zone. `everyapp access on` needs Access permissions on top ([access](/docs/agent/access)). Under `CI` the owner link is never shown.

## The setup

1. **Ask which domain.** Propose `apps.<their domain>`: apps then live at `<app>.apps.example.com`. Any hostname under one of the account's domains works; avoid the zone's apex (`GATEWAY_AT_ZONE_APEX`). The address can't change later.
2. **Run** `everyapp setup --domain apps.example.com --json`. It logs in, checks the plan and the domain, uploads the Gateway, waits for its certificate, then shows the owner link and waits. Add `--account-id` when the login sees several accounts.
3. **Read the events** and hand off per the table above. On an error, look up the code on [errors](/docs/agent/errors).
4. **Resume** by running the same command again. Setup picks up where it stopped and does nothing once everything is there.
5. **Show the result**: `done.data` has `gatewayUrl`, `adminUrl`, `owner` and `next`. Tell the person the address and that they're signed in.

After the owner exists, setup turns **Cloudflare Access** on by default: a second sign-in at Cloudflare in front of the Gateway and every app. Recommend keeping it. `--no-access` (or `everyapp access off`) leaves it off. Access asks the Gateway who is a member, so invitations need nothing in Access; deploys keep apps' public routes let through. [access](/docs/agent/access)

Then offer, one at a time: an AI key (`everyapp provider add openrouter`), email (`everyapp secret set EMAIL_FROM EMAIL_FROM_NAME` after onboarding the domain to Email Sending; guide [setup/email](/docs/agent/setup/email)), inviting people, connecting their AI client to `https://<gateway>/mcp`, and a first app. `everyapp status --json` lists what's left in `data.next`.

## Create, run, deploy, share

- **Create**: `everyapp create my-app` makes `./my-app`, its own git repository, with dependencies installed and a local database. Then build it with the `build-every-app` skill ([Build an app](/docs/agent/build)).
- **Run**: `pnpm dev` in its directory (in the background), then `http://my-app.localhost:8787`. [dev](/docs/agent/dev)
- **Deploy**: `everyapp deploy --json` in its directory. With no Gateway yet it offers to install one. A takeover (`authorize: true`) needs the person's yes. [deploy](/docs/agent/deploy)
- **After a deploy**, tell the person the URL, who can open it (new apps are private to owners and admins until shared in Admin → Apps), and anything it needs set (`APP_NEEDS_SETUP`: they run `everyapp configure <app>`).
- **Install an open app**: `everyapp install <GitHub URL>`, then `everyapp configure <id>`. [apps](/docs/agent/apps)
- **Invite people**: Manage workspace → Users, or `everyapp workspace invite <email>` (mailed when the Gateway sends email; otherwise `everyapp workspace invite-link <email>` prints a link to hand over). [workspace](/docs/agent/workspace)
- **Manage the workspace from the terminal**: `workspace`, `events`, `ai show|default` and `call` run the Gateway's own tools as the person, so they need a Gateway credential, not the Cloudflare login: `EVERYAPP_TOKEN` (a personal access token from Manage workspace → Tokens), or `everyapp login --gateway https://<gateway> --json`, which emits a `gateway.signin` progress event with a URL to hand the person (they choose **Read & write** and **All apps**) and waits. The first admin command signs in the same way when nothing is stored.
- **Connect an AI client**: [/docs/connect-ai](/docs/connect-ai).

## Keeping things up to date

`npm install -g everyapp@latest`, then `everyapp update` moves the Gateway to the release for that version (in a checkout: `git pull`, `pnpm install`, `pnpm everyapp update`). Deploying an app never changes the Gateway. Apps update by deploying again, or `everyapp install` again for a release; an app's agent skills come with its `everyapp` dependency (`node_modules/everyapp/skills`) and point at these pages, which change without an upgrade. After an everyapp update, a command against a Gateway whose database is behind stops with `GATEWAY_OUTDATED` until `everyapp update` runs. An update that would put an older Gateway over the live one stops with `GATEWAY_DOWNGRADE`; `git pull` (or update everyapp), then `update`, goes forward, and `update --downgrade` is the rollback: the older code goes back and the database keeps its migrations. From a checkout, a live Gateway is replaced only by what the remote's main branch holds: uncommitted Gateway changes (`CHECKOUT_UNCOMMITTED`) or a commit that isn't on `origin/main` (`CHECKOUT_UNMERGED`) stop the update, because a migration it applies can't be taken back. When you run your Gateway from a fork or a branch of your own, `pnpm everyapp update --unmerged` says so. A first `setup` is never refused.

## Verifying

- After setup: `everyapp status --json` shows the owner, Access on, the release, TLS ready, and no `error` or `warning` fixes. `GET https://<gateway>/health` answers `{"status":"ok"}`.
- After a deploy: the app is `live` in `status`. Fetching its URL answers a redirect to sign in (or Access's login page), which is correct for a private app. Its public routes answer without a sign-in.

## Recovery

- Setup stopped: run it again. The owner link was lost or expired: run it again for a new one.
- A deploy broke the database: `everyapp db restore` (asks; loses writes since).
- Locked out by Access: see [access](/docs/agent/access#recovery).
- Something else: [troubleshooting](/docs/agent/troubleshooting).
- Remove everything: delete each app with `--purge`, `everyapp access off`, then delete the `every-app-gateway` Worker, D1 database, KV namespace and the `every-app-gateway--releases` R2 bucket in the dashboard. [/docs/update](/docs/update#remove-everything)

## Safety rules

- Never ask for a key, token or password in the chat, and never put one on a command line. Hand the person `everyapp configure <app>` or `everyapp secret set NAME` to run in their terminal.
- Never post the owner link, an invite link or a reset link anywhere public.
- Never add a takeover flag (`--force-dns`, `--allow-delete-*`, `--yes`, `--enable-email-routing`, `--register-providers`) without the person's yes to that exact thing.
- Never add `--yes` to delete, or to a production write (`CONFIRMATION_REQUIRED`), without the person's yes.
- Never `delete --purge` or `db restore` unless the person asked.
- Never run `teardown` on a person's account; it's for a dedicated test account the person names. Run it with `--dry-run --json` first, and never add `--confirm` unless they explicitly asked.
- Never add `--no-access` unless the person says so. On `ACCESS_TEAM_REQUIRED`, ask them for the team name (it's permanent), then rerun with `--team <name>`.
- Don't suggest Gateway app installs from the browser (off by default). Only when the person asks, they run `everyapp deploy-token add` at a terminal themselves.
- Never vendor the SDK or CLI into an app (no tarballs, no committed `file:` or `link:` specifiers): pin a published version. To try unreleased platform code, `pnpm link` it locally without committing; a published rc ships it (`docs/runbooks/app-releases.md` in the EveryApp repository).
- Never change a Worker in the dashboard: the next deploy then needs a confirmation at a terminal.
