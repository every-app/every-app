---
title: The deploy pipeline
description: What everyapp deploy does from its first line to Live, what can stop it, what a redeploy keeps, renaming an app (previousIds), releases (release, install), browser installs, and delete.
---

`everyapp deploy` (the app's `pnpm run deploy`) puts the app in the current directory online as a private Worker behind the Gateway. `cf`, Cloudflare's CLI, does every Cloudflare call under the person's own login. The Gateway's database is the registry, written directly by the CLI: there's no deploy API on a self-hosted Gateway, and no deploy token. Anyone who can sign in to the Cloudflare account can deploy.

The credential is the Cloudflare login (`everyapp login`), or `CLOUDFLARE_API_TOKEN` with `CLOUDFLARE_ACCOUNT_ID` for unattended runs. The Gateway is found through that login; `--gateway` or `--account-id` pick when there are several. With no Gateway yet, `deploy` offers to install one (`--yes` does without asking).

## The steps

Each is a `step` event ([json](/docs/agent/json)):

1. `app.connect`: the login and the Gateway.
2. `app.deploy`: the first line, saying what goes where.
3. `app.providers`: provider specs the app bundles in `.everyapp/providers/*.json` are registered only with the person's yes (`--register-providers`; `--yes` doesn't cover them).
4. `app.rename`: only when `previousIds` names the app this one was ([below](#renaming-an-app)): what moves, then a confirmation (`--yes` gives it; unattended without it, `CONFIRMATION_REQUIRED`).
5. `app.register`: the registry row. The Worker name, hostname and resource names are assigned once and kept. A new app grants nobody: owners and admins open every app, and with `access: "everyone"` it is available to every member.
6. `app.domain`: a new hostname must not be answered by DNS already (`DNS_RECORD_CONFLICT`; `--force-dns` replaces the record, after asking) or belong to another Gateway.
7. `app.lease`: one deploy per app at a time (`LEASE_HELD` waits up to 5 minutes).
8. Dropped Durable Object classes or Workflows stop the deploy until the person agrees (`--allow-delete-durable-object-data`, `--allow-delete-workflows`).
9. `app.resources`: creates or reuses every resource the manifest declares, R2 buckets included, recorded as the app's (`RESOURCE_NAME_TAKEN` when a same-named one isn't). The install engine here is the same one a Gateway's browser installs run.
10. `app.install` and `app.build`: dependencies (with `SDK_VERSION_MISMATCH` when the app's `@every-app/sdk` isn't this everyapp's version), then the production build with `EVERYAPP_BUILD=1`. The build fills in the real names, ids and keys, then the **policy check** (`APP_POLICY`) refuses a Worker that isn't built by `everyAppWorker()`: wrong name, missing identity keys, `EVERYAPP_DEV` set, undeclared helpers or bindings to other Workers.
11. `app.schema`: with drizzle, the schema must match the committed migrations (`SCHEMA_DRIFT`: run `pnpm db:generate`).
12. `app.migrations`: saves a D1 restore point, then applies migrations before the upload. A failed migration leaves the old version serving.
13. `app.upload`: `cf deploy --prebuilt` for each Worker. A Worker changed outside everyapp needs a person's confirmation at a terminal (`rerun_interactive`).
14. `app.bind`: the Gateway is redeployed with a binding to a new app and its hostname, only when something changed.
15. `app.live`: waits until the app answers (`--no-wait` skips; a new certificate can take minutes). Behind Access it reads the app's row while the Gateway's per-minute cron makes it live.
16. `app.access`: when this deploy changed the app's public routes while Cloudflare Access is on, `access on`'s recipe runs again (`ok`, "Cloudflare Access updated for <app>'s public routes"). If that fails, the deploy still succeeds with `ACCESS_UPDATE_FAILED`: run `everyapp access on`. Otherwise nothing.

The end says the URL, who can open the app and its public routes. A required setting that's unset ends with the warning `APP_NEEDS_SETUP`: run `everyapp configure <app>`.

## Safe to rerun

Every step looks before it acts, so rerun the same command after any stop. Resources and uploads are recorded as soon as they exist, the lease frees itself, and the Gateway is rebound only when needed. Nothing is kept on the deploying machine, so another machine needs only the login. Never repeated by itself: replacing a Worker changed outside everyapp, replacing a DNS record, deleting data.

## What a redeploy keeps

The Worker name, hostname and resource names; who can open the app; D1, KV, R2, Hyperdrive and Vectorize data; Durable Object data (unless a class is dropped with the flag); the app's secrets and settings. Settings with a `default` the Worker doesn't hold yet are written. The Gateway re-reads the app's tools when the version changes.

## Renaming an app

The app's `id` names its hostname, Worker and resources, so changing `id` alone deploys a new, empty app. To rename one, change `id` and list the old one under `previousIds`:

```ts
export default defineConfig({ id: "scribe", previousIds: ["talk"], name: "Scribe", /* … */ });
```

`everyapp deploy` sees that `scribe` isn't registered and `talk` is. Before it asks or writes anything it checks what the rename needs: the live Gateway's release, which publishing the new hostname deploys again (`GATEWAY_RELEASE_UNAVAILABLE`: run `everyapp update`, then deploy again), and that no DNS record answers the new hostname (`DNS_RECORD_CONFLICT`). It then shows the plan (`app.rename`) and asks; `--yes` answers for CI. Then:

- The registry row takes the new id and the hostname `scribe.<app base domain>`. It keeps its Worker name (`every-<orgKey>-talk`), so the D1, KV, R2 and other resources named after it, the Worker's secrets, and its data stay as they are. Nothing is copied.
- Everything the Gateway holds for the app stays with it: who can open it, groups, tokens bound to it, AI connections, its access to people's OAuth connections, native sign-ins, caps, usage, events, email setup.
- The old hostname keeps working. Until the new one answers over HTTPS it serves the app in full; from then on (`app.rename` "now redirect", or the next deploy if this one didn't wait) page loads and shared links get a `308` to the same path on the new host, while requests with a bearer token, non-GET requests and WebSockets are served on the old host as before. A desktop app's `/api/v1` calls and webhooks keep working without a change.
- Two things follow the new id: the app's tools are named `scribe_*` on the Gateway's `/mcp`, and `everyapp dev --linked` signs in again.

`previousIds` is the app's history, the same in every copy of a release. On a Gateway where no app has or had any of the listed ids (it never installed the app, or deleted it), the deploy installs a new app under `id`, asks nothing, and says so (`app.rename` with status `skip` and `data.newApp`). Ids nothing answers to are ignored beside one that names an app.

Refused before anything changes: a new id that is already an app while a listed id is another one (`RENAME_TARGET_EXISTS`), ids of two different apps (`RENAME_AMBIGUOUS`), and a registered app listing an id another app had (`PREVIOUS_ID_UNKNOWN`).

The old id stays the app's for good: its Worker carries it, so no new app can take it (`APP_ID_RENAMED`). Removing it from `previousIds` retires the old hostname on that deploy (the Gateway stops publishing it); adding it back serves it again. Renaming back (`id: "talk", previousIds: ["scribe"]`) works the same way.

## Releases

`everyapp release` packs the built app into `everyapp-release.tar.gz` (`--out`): the Build Output, the migrations and `release.json`. It refuses local state and secrets (`RELEASE_LOCAL_STATE`). Postgres apps can't be released yet (`RELEASE_MIGRATIONS_UNSUPPORTED`). In GitHub Actions, `release --publish` makes the GitHub release; `--dry-run` shows what it would do. The starter ships a Release workflow that does this on every push.

`everyapp install <source>` deploys a release with no checkout. `<source>` is a GitHub repository URL (its latest release), a release tag URL, a tarball URL or a local file. Downloads are anonymous, HTTPS-only, at most 200 MB and checked by SHA-256. The pipeline is the same minus install and build. The hash proves the file is whole, not who built it: installing a release trusts its publisher like running their code. At a terminal it offers to set the app up afterwards. The open apps install this way: [apps](/docs/agent/apps).

## Gateway app installs

Browser installs (Admin → Apps → Install app, or `/install?source=<release URL>`) let the Gateway deploy a release itself. They are off by default. `everyapp deploy-token add`, at a terminal, opens Cloudflare's page for an account token with the permissions the installer needs filled in, and stores it as `CF_DEPLOY_TOKEN` with `BROWSER_APP_INSTALLS=on`. Those permissions are Workers Scripts, D1, KV, R2, Queues, Hyperdrive, Vectorize, AI Gateway, Secrets Store, Access: Apps and Policies, Email Routing Rules and Zone Settings Edit, plus DNS and Zone Read on the Gateway's zone. `everyapp deploy-token remove` turns installs off.

Only owners and admins install, from a sign-in in the last 10 minutes. The approval page shows the release, its settings and any bundled providers, and the install is bound to the reviewed hash. Sources are public GitHub repositories or `https://oss.new/apps/<key>` URLs. The Gateway never builds release source. Codes: [errors](/docs/agent/errors#the-gateways-deploy-api).

## `everyapp delete [<app>]`

Takes the app off the Gateway: it can't be opened, and the Gateway drops its binding and hostname. Its Worker and data are kept (crons, Workflows and mail routes keep running) unless `--purge`, which deletes the Worker and every resource the app recorded, after the person types the app's id. Deleting an app that had public routes, behind Access, takes them out of Access (`app.access`; `ACCESS_UPDATE_FAILED` if that fails: run `everyapp access on`). Resources the app didn't record are kept (`RESOURCES_KEPT`). Unattended, it needs `--yes`, so ask first. The app's id stays reserved, so deploying it again brings it back with the same names.

## `everyapp db`

- `db migrate`: apply local migrations.
- `db query <sql>` (`--local`, `--file`, `--binding`): run SQL against the production or local D1. A write asks first.
- `db restore`: put the production database back to the restore point of its last migrating deploy. It asks first, and loses what was written since. `--gateway` restores the Gateway's own database.
