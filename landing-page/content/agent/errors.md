---
title: Error codes
description: Every code an everyapp command can end with (errors, the reporter's and cf's, argument errors), the codes the Gateway's deploy API and browser install answer, every warning, and every problem status reports, each with what it means and how to fix it.
---

Codes are stable strings for scripts; messages are for people. With `--json` a code arrives on an `error` event (`code`, `message`, `retryable`, `data.fix`, `data.rerun`, `data.rerunNote`, `data.authorize`), a `warning` event (`code`) or in `status --json`'s `data.fixes[]` ([the protocol](/docs/agent/json)). An entry's anchor is its code, lowercased (`#dns_record_conflict`). Where a fix is a command that takes something over (`--force-dns`, `--allow-delete-*`, `--yes`, `--enable-email-routing`), the event carries `data.authorize: true`: show it to the person and ask before running it.

## Error codes A–E

Each entry says what the code means, which commands raise it, and what the error itself says to do next, as `packages/cli/src/lib/errors.ts` defines it: `fix` is a remedy in words; `rerun` is a command to run, with `rerunNote` after it. A `rerun` defaults to the same command again only when the error is `retryable`, or when the code is a takeover: then the rerun carries the takeover flag and the event has `data.authorize: true`, which means show the error and ask the person before running it, never retry with the flag on your own. Under `--json` these arrive on the `error` event as `data.fix`, `data.rerun`, `data.rerunNote`, `data.authorize` and the top-level `retryable` (`packages/cli/src/lib/output/report.ts`). Commands below are written `pnpm everyapp …`; the prefix in a real message follows how everyapp was started (`packages/cli/src/lib/output/command.ts`: `pnpm everyapp`, `npx everyapp`, `yarn everyapp`, or `everyapp`).

### ACCESS_DOMAIN_INVALID

`access on --email-domain <x>`: the value (trimmed, lowercased, a leading `@` stripped) isn't a hostname as `DOMAIN` in `commands/access/index.ts` defines one: one or more labels of lowercase letters, digits and dashes (1–63 characters, no dash at either end), each followed by a dot, then a last label of 2–63 of those characters, 253 characters at most. Checked with the other arguments, before anything connects. Headline: `--email-domain <x> isn't a domain` (the value as given), then `Use the part after the @, like example.com.`

**Fix:** none offered; no rerun; not retryable. Pass the domain alone, as in `--email-domain example.com`.

Source: `packages/cli/src/commands/access/index.ts` (`wantedRules`).

### ACCESS_EMAIL_INVALID

`access on --email <x>`: the value (trimmed, lowercased) doesn't match `EMAIL`, `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` (no spaces, one `@`, a dot after it). Checked with the other arguments, before anything connects. Headline: `--email <x> isn't an email address` (the value as given), one line.

**Fix:** none offered; no rerun; not retryable.

Source: `packages/cli/src/commands/access/index.ts` (`wantedRules`).

### ACCESS_HOSTED

`access on` and `access off` against a Gateway whose install row records `deploymentMode: "hosted"`: a hosted Gateway ignores the Access settings, so there is nothing to put in front of it. Checked right after connecting, before anything is read from Access. `access show` works there: it reads the Worker's settings and skips Access. Headline: `This Gateway can't be put behind Cloudflare Access`, then `Hosted Gateways ignore the Access settings.`

**Fix:** none offered; no rerun; not retryable.

Source: `packages/cli/src/commands/access/index.ts` (`refuseHosted`, called from `turnAccessOn` and `turnAccessOff`).

### ACCESS_NOBODY_ALLOWED

`access on` when the allow policy it would make would let nobody in: the Gateway has no active member (a `users` row not `banned`, or whose `ban_expires` has passed), no `pending` invitation that hasn't expired, no `--email` or `--email-domain` was given, and no Access policy named `Every App gateway members` (`POLICY_NAME`) exists yet. Raised after reading the Gateway's people and Access's organization, identity providers and policies, before any write. Headline: `Nobody to let in yet`, then `The Gateway has no members or invitations, and no --email was given, so the Access policy would let nobody in. Claim the Gateway first, or name who will (the setup link is then behind Access too).`

**Fix:** `rerun`: `pnpm everyapp access on --email <your address>`. Not retryable.

Source: `packages/cli/src/commands/access/index.ts` (`turnAccessOn`, `readPeople`).

### ACCESS_PERMISSION_MISSING

An Access call (the Zero Trust organization, identity providers, policies or applications) that cf refused with its `auth` kind (API code `10000` or `9109`, or output saying `No authentication token found`, `Not logged in` or `cf auth login`): the login or token lacks the Access permissions. Every Access call in `lib/cf/access.ts` goes through `explainAccessError`, so `access on`, `access off` and `access show` raise it at their first Access read; a Workers or D1 refusal elsewhere in the run stays cf's own (`CF_AUTH`). Headline: `This Cloudflare login can't manage Access`, then the first line of cf's error; `data.url`: `https://dash.cloudflare.com/profile/api-tokens`.

`deploy` and `delete` bring the apps application up to date afterwards (`syncAppsAccessAfter`), and there it is never an error: when the app has public routes the run warns `ACCESS_NOT_CHECKED` (`This Cloudflare login can't read Cloudflare Access, so <app> wasn't checked against it`, then `If the Gateway is behind Access, <app>'s public routes need a login there until it is updated.`, or for `delete` `… <app>'s host stays listed there until it is updated.`; `data.rerun`: `pnpm everyapp access on`, `data.rerunNote`: `with a login that can manage Access, if the Gateway is behind it`) and goes on; with no public routes it says nothing.

**Fix:** `fix`: `use a login or token with Access: Apps and Policies (edit) and Access: Organizations, Identity Providers, and Groups (edit)`. No rerun; not retryable.

Source: `packages/cli/src/lib/cf/access.ts` (`explainAccessError`, `access`), `packages/cli/src/lib/access/sync.ts` (`syncAppsAccessAfter`), `packages/cli/src/lib/cf/errors.ts` (the `auth` kind).

### ACCESS_SESSION_INVALID

`access on --session <d>` or `--team-session <d>` whose value isn't a duration Access takes. `durationSeconds` (`lib/access/plan.ts`) reads one or more `<number><unit>` parts with no spaces, the number with an optional decimal part and the unit one of `ns`, `us`, `µs`, `ms`, `s`, `m`, `h` (`720h`, `2h30m`, `1.5h`); `checkDuration` refuses anything else, and a total of zero or less. Checked first, before any network. Headline: `--session <d> isn't a duration Access takes` (or `--team-session <d> …`; the value as given), then `Use hours and minutes, like 720h or 2h30m.` Without `--session` the value is `720h` (`DEFAULT_SESSION`, the most Access allows for an application's session); without `--team-session` the team's global session is left as it is.

**Fix:** none offered; no rerun; not retryable.

Source: `packages/cli/src/commands/access/index.ts` (`checkDuration`), `packages/cli/src/lib/access/plan.ts` (`durationSeconds`).

### ACCESS_TEAM_CREATE_FAILED

`access on` creating the Zero Trust team (`createAccessOrganization`: `cf zero-trust organization create` with the name, `<team>.cloudflareaccess.com` and the session) when cf failed with a `CfError` of any kind but `auth`. A permission refusal arrives as `ACCESS_PERMISSION_MISSING` and goes through unchanged, as does any error that isn't cf's. Headline: `Cloudflare didn't create the Zero Trust team <team>`, then the first line of cf's error; `data.team`.

**Fix:** `fix`: `pick another name with --team: team names are shared across Cloudflare`. No rerun; not retryable.

Source: `packages/cli/src/commands/access/index.ts` (`turnAccessOn`), `packages/cli/src/lib/cf/access.ts` (`createAccessOrganization`).

### ACCESS_TEAM_INVALID

`access on` about to create a Zero Trust team whose name doesn't match `TEAM`, `/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/` (1–63 lowercase letters, digits and dashes, no dash at either end): the label before `.cloudflareaccess.com`. Checked only when the account has no team yet; with one, `--team` is ignored, as its help says. Headline: `--team <name> can't be a team name` (without the `--team ` prefix when the name was typed at the terminal's prompt rather than passed as the flag), then `Use lowercase letters, digits and dashes: it becomes <name>.cloudflareaccess.com.`

**Fix:** none offered; no rerun; not retryable.

Source: `packages/cli/src/commands/access/index.ts` (`turnAccessOn`).

### ACCESS_TEAM_REQUIRED

`access on` when the Cloudflare account has no Zero Trust team (`getAccessOrganization` answers null), no `--team` was given, and nobody is at a terminal (`--json`, `CI` set, or stdin/stderr not a TTY). At a terminal the name is asked for instead (`Zero Trust team name`, the suggestion as the default, answers checked against `TEAM`). The team's sign-in domain is permanent once used, so it is never chosen unasked. Headline: `Choose a name for the Zero Trust team with --team`, then `This Cloudflare account has none yet. Its sign-in page becomes https://<name>.cloudflareaccess.com and can't be changed later.`; `data.suggested`: the first label of the install's zone name, lowercased with anything outside `[a-z0-9-]` removed, or `every-app` when nothing is left.

**Fix:** `fix`: `add --team <suggested>, or another name`. No rerun; not retryable. The agent-driven Access setup, step by step: `packages/cli/skills/everyapp/setup/access.md` (in an app `.claude/skills/everyapp/setup/access.md`).

Source: `packages/cli/src/commands/access/index.ts` (`turnAccessOn`, `askTeamAtTerminal`).

### ACCOUNT_NOT_ACCESSIBLE

`--account-id` (or `CLOUDFLARE_ACCOUNT_ID`) names a Cloudflare account that isn't among the accounts `cf auth whoami` lists for this login; raised only when the login lists at least one account (a login that lists none takes the id as given). Headline: `<email> can't use Cloudflare account <id>`, followed by `Accounts this login can use:` and the list. Raised while choosing the account to install a Gateway in: `setup` with no Gateway found, and `deploy` when it offers to install one.

**Fix:** `fix`: `pass one of these with --account-id, or log in as someone else`. `rerun`: `pnpm everyapp login`. Not retryable, no takeover.

Source: `packages/cli/src/lib/cf/account.ts` (`resolveAccount`), called from `packages/cli/src/commands/setup/runSetup.ts` and `packages/cli/src/commands/deploy/steps/offerGateway.ts`.

### ACCOUNT_REQUIRED

No `--account-id` and no `CLOUDFLARE_ACCOUNT_ID`, and the Cloudflare login lists no accounts at all (an API token can), so there is nothing to install a Gateway in. Headline: `This Cloudflare login can't list any accounts`, then `The account id is in your dashboard URL: dash.cloudflare.com/<account-id>/…`. Same callers as `ACCOUNT_NOT_ACCESSIBLE`. (Several accounts and nobody at a terminal is not an error but the `choose_account` action, one rerun per account in `data.choices`.)

**Fix:** `fix`: `pass --account-id, or set CLOUDFLARE_ACCOUNT_ID`. No rerun; not retryable.

Source: `packages/cli/src/lib/cf/account.ts` (`resolveAccount`).

### APP_CHANGING

After the Worker is uploaded, the deploy records its version on the app's registry row with an `UPDATE … WHERE id = ? AND status = ?` over the status it just read, so an admin switching the app off meanwhile keeps it off; when that write matches no row three times running (`MARK_DEPLOYED_ATTEMPTS = 3`), the row is changing under the run. Headline: `The app's registry row keeps changing while this deploy records its upload`, then `The upload is kept.` Raised by `deploy` (under the app's lease, after the `app.email` step and before the Gateway rebind).

**Fix:** `retryable: true`, so `rerun` is this same command. No takeover.

Source: `packages/cli/src/lib/gateway/registry.ts` (`markDeployed`).

### APP_DIR_EXISTS

`create <name>` found the directory the new app would go in already there: `apps/<name>` inside the Every App checkout, `./<name>` anywhere else. Headline: `<dir> already exists` (`./<name>` for a directory under the current one, a relative path otherwise).

**Fix:** `fix`: `pick another name, or move <dir> away`. No rerun; not retryable.

Source: `packages/cli/src/commands/create/index.ts`.

### APP_ID_REQUIRED

`create` was given no name and can't ask for one: under `--json`, under `--yes`, or with no terminal. Headline: `No app name given`, then `--yes means nothing is asked.` or `There's no terminal to ask for one.` At a terminal the name is prompted for instead (default `my-app`); a name that is given but invalid is `INVALID_APP_ID`.

**Fix:** `rerun`: `pnpm everyapp create <name>` (with ` --yes` appended when `--yes` was given). Not retryable.

Source: `packages/cli/src/commands/create/steps/appId.ts` (`resolveAppId`).

### APP_NOT_FOUND

The app the command acts on has no usable row in the Gateway's registry (never deployed, deleted, or gone mid-run). Each raise site says it its own way:

| Raised by                                                                                               | Headline                                                                                                   | Next step                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `db query` (production), `db restore`, `email set`, `email unset` (registry `readApp`, `writeAppEmail`) | `<app> isn't deployed to this Gateway yet`                                                                 | `rerun`: `pnpm everyapp deploy`, `rerunNote`: `in the app's directory`                                    |
| `deploy` and `email set/unset` reading the row's email lists under the lease (registry `readAppEmail`)  | `The app is no longer registered on this Gateway`                                                          | `rerun`: `pnpm everyapp deploy`, `rerunNote`: `in the app's directory`                                    |
| `delete <app>` (registry `deleteApp`): no row, or a row with no Worker name                             | `No app named <app> on this Gateway`                                                                       | `rerun`: `pnpm everyapp status`, `rerunNote`: `lists its apps`                                            |
| `secret set`, `secret unset` for an app's names, before any value is read                               | `<app> isn't deployed yet` / `Its secrets can be set after its first deploy. Nothing was changed.`         | `rerun`: `pnpm everyapp deploy`                                                                           |
| `deploy` recording the upload (`markDeployed`): the row is gone, or is a tombstone                      | `The app's registry row is gone; deploy it again.` / `No app "<app>" is registered for this organization.` | No fix or rerun; `retryable: false` (a `RegistrationError` with status 404, wrapped by `asEveryAppError`) |
| `deploy` in step `app.live`: the row was deleted while the run waited for the app to go live            | `<app> was deleted during this run`                                                                        | `retryable: true`, so `rerun` is this same command; `rerunNote`: `to put it back`                         |

**Fix:** as the table says; in every case but the last two, deploy the app first. No takeover.

Source: `packages/cli/src/lib/gateway/registry.ts`, `packages/cli/src/commands/deploy/steps/waitForLive.ts`, `packages/cli/src/commands/secret/index.ts`, `packages/perimeter/src/registry/registration.ts` (`assertLiveApp`).

### APP_NOT_LIVE

The last step of `deploy` (`app.live`) sends `GET https://<hostname>/` every 3 seconds and reads the registry after each, until the row says `active` or 10 minutes pass (`DEFAULT_MAX_WAIT_MS = 600_000`). This code is the timeout in the case where the Gateway did answer the probe at some point, so a certificate isn't what's missing: the Gateway can't reach the app's Worker. Headline: `<app> isn't live after <Nm NNs>: the Gateway can't reach its Worker yet`, then `<app> stays uploaded and bound.` A timeout with no answer at all is the `CERT_PENDING` warning instead, and the run ends normally; `--no-wait` skips the wait.

**Fix:** `retryable: true`; `rerun`: `pnpm everyapp status`, `rerunNote`: `then deploy again`. No takeover.

Source: `packages/cli/src/commands/deploy/steps/waitForLive.ts`, called through `awaitLive` in `packages/cli/src/commands/appGateway.ts`.

### APP_POLICY

The app's Build Output (`.cloudflare/output/v0`) fails the app policy, checked before anything is uploaded: in `deploy` (step `app.build`) and `release`. Three headlines:

- ``The app's Build Output isn't a production build. The manifest's build command must run `cf build` (production by default).``
- `The app's Build Output has no default Worker. Build it from everyAppWorker() in cloudflare.config.ts.`
- `The built Worker can't be deployed as an Every App app:` followed by one `  - <problem>` line each, then `Build it from everyAppWorker() in cloudflare.config.ts.` The problems a Worker can have: its `name` isn't the Worker name the registry assigned; `workersDev` or `previewUrls` isn't `false`; it declares `domains`, routes (a `fetch` trigger) or any trigger other than `scheduled`; `EVERYAPP_DEV` is set; `EVERYAPP_IDENTITY_PUBLIC_KEYS` or `EVERYAPP_IDENTITY_ISSUER` isn't a built-in `text` binding; `EVERYAPP_AUDIENCE` isn't the Worker's name; a binding type outside `text`, `json`, `secret`, `version-metadata`, `assets`, `d1`, `kv`, `r2`, `durable-object`, `workflow`, `worker`, `hyperdrive`; a `worker` binding to anything but the Gateway's `AppGateway` (binding `EVERY_APP_GATEWAY`) or, from the app's own Worker, its helper Workers; a `durable-object` or `workflow` binding to another Worker's; a `d1`, `kv` or `hyperdrive` binding the deploy didn't provision; an `r2` bucket outside the manifest's `resources.r2` (or, with none declared, not named after the Worker); a Workflow not named `<worker>--<name>`; a Durable Object export that is `transferred`, `expecting-transfer`, container-backed, or `deleted` without `--allow-delete-durable-object-data`; an export that isn't a Worker, Workflow or Durable Object; a built Worker `workers` doesn't declare, or a declared helper the build lacks.

The install step raises the same code when a Durable Object class the deploy would tombstone is still exported by the build: `Durable Object class <name> is both exported by the build and being deleted; declare it in everyapp.config.ts, or stop exporting it.`

**Fix:** none offered by the error: build the Worker from `everyAppWorker()` in `cloudflare.config.ts` and correct what the list names. No rerun; not retryable.

Source: `packages/cli/src/lib/app/policy.ts` (`prepareAppBuildOutput`, `appPolicyProblems`, `helperPolicyProblems`), `packages/cli/src/lib/app/installBuildOutput.ts` (`installWorkerConfig`).

### BUILD_FAILED

The app's production build failed (step `app.build` of `deploy` and `release`). The build runs with `EVERYAPP_BUILD=1`: `cf build` by default, or the manifest's `build` command. With `cf build`, the headline is `Build failed`, then `cf build's last lines:` and the tail of what it printed. With a manifest `build` command, the headline is `Build failed`, then `<command> exited with code <n>. Its last lines:`, the tail, and `Full log: <path>` (`$TMPDIR/everyapp/<name>-<time>-<pid>.log`), with `data.command`, `data.exitCode`, `data.tail` and `data.log`. A `cf build` that runs past 10 minutes is a `CfTimeoutError`, reported as `CF_TIMEOUT`, not this code.

**Fix:** none offered: fix the build error in the tail or the log. No rerun; not retryable. `--verbose` streams the build's output to stderr.

Source: `packages/cli/src/lib/app/buildApp.ts`, `packages/cli/src/lib/childLog.ts` (`runLogged`).

### CHECKOUT_MISSING

everyapp isn't running from a checkout of the Every App repository: no directory above the CLI's module holds both `apps/every-app-gateway/scripts/build-release.ts` and `packages/cli/package.json`. Raised by `create` (the starter template it copies comes from the checkout) and by every Gateway deploy (`checkoutGateway` in `lib/gateway/checkoutRelease.ts` builds the Gateway's release from the checkout: `setup`, `update`, and the rebind `deploy` and `delete` run). `status` uses the nullable `findCheckoutRoot` and skips the checkout comparison outside one. Headline: `everyapp has to run from a checkout of the Every App repository`, then `This copy is installed in <package dir>, outside any checkout.`

**Fix:** `fix`: `in your checkout, run pnpm everyapp <the same arguments>`. No rerun; not retryable.

Source: `packages/cli/src/lib/checkout.ts` (`checkoutRoot`, `findCheckoutRoot`), called from `packages/cli/src/commands/create/index.ts`, `packages/cli/src/lib/gateway/checkoutRelease.ts`, `packages/cli/src/commands/status/index.ts`.

### CLI_TOO_OLD

A release's `release.json` names a `minCli` newer than this everyapp (`compareVersions`: dotted parts compared numerically, a leading `v` and prerelease suffixes ignored), so it is refused before anything changes. Headline: `<what> needs everyapp <minCli> or newer (this is <cliVersion>)`, where `<what>` is `Gateway <version>` for a Gateway release and `<appId> <version>` for an app release; `data.minCli`, `data.cliVersion`. Raised by `setup` and `update` (the source's `minCli` before anything is asked, then the opened release), by the Gateway rebind that `deploy` and `delete` run (`lib/gateway/reconcile.ts`), and by `install <source>` opening an app release (`lib/app/release.ts`; app releases are packed with `minCli: "0.3.0"`).

**Fix:** `fix`: `update everyapp (in a checkout: git pull), then run this again`. No rerun; not retryable.

Source: `packages/cli/src/lib/gateway/release.ts` (`refuseNewerThanCli`), called from `packages/cli/src/commands/setup/runSetup.ts`, `packages/cli/src/lib/gateway/reconcile.ts`, `packages/cli/src/lib/app/release.ts`.

### CLOUDFLARE_LOGIN_FAILED

cf's login didn't leave cf logged in. Raised anywhere a command logs in (`login`, `setup`, and every Gateway command through `lib/gateway/connect.ts`), in two situations:

- After `cf auth login` at a terminal, or the device login, `cf auth whoami` still says `authenticated: false`. Headline: `Cloudflare login didn't complete`. `rerun`: `pnpm everyapp login`; not retryable.
- The unattended device login (`cf auth login --no-browser`) failed or ran out of time. `logIn` runs it whenever nobody is at a terminal and the caller passed `onDeviceLogin`: `setup` (`runSetup.ts`) and the Gateway commands (`lib/gateway/connect.ts`) pass it only under `--json`; `login` passes it always, so `pnpm everyapp login` piped or under `CI` runs it without `--json` too (a Gateway command with no terminal and no `--json` gets the `cloudflare_login` action instead, and no login runs). cf's link and code go out first as the `cloudflare_login` action (`data.url`, `data.code`, `data.expiresAt`, `waiting: true`), then cf waits 15 minutes for the approval (`DEVICE_LOGIN_TIMEOUT_MS`). Headline: `Cloudflare login timed out after 15m`, then `Or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.`, or `Cloudflare login didn't complete` with the error under it. `retryable: true`, `rerun`: `pnpm everyapp login`.

**Fix:** run `pnpm everyapp login` again, or for unattended runs set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. No takeover.

Source: `packages/cli/src/lib/cf/account.ts` (`logIn`, `deviceLogin`), `packages/cli/src/commands/login/index.ts`.

### CLOUDFLARE_TOKEN_REJECTED

`CLOUDFLARE_API_TOKEN` is set, and `cf auth whoami` says cf isn't authenticated with it, so no login is attempted (cf would use the token). Headline: `Cloudflare didn't accept CLOUDFLARE_API_TOKEN`, then `It may be mistyped, expired or revoked.` and `A token needs Workers, D1, KV and Zone DNS Read access: https://dash.cloudflare.com/profile/api-tokens`. Raised by every command that logs in.

**Fix:** `fix`: `set a valid token, or unset CLOUDFLARE_API_TOKEN and run pnpm everyapp login`. No rerun; not retryable.

Source: `packages/cli/src/lib/cf/account.ts` (`logIn`).

### CONFIRMATION_REQUIRED

A step needs a person's yes, `--yes` wasn't given, and nobody is at a terminal (`--json`, `CI` set, or stdin/stderr not a TTY): the run refuses instead of guessing. The message is the step's own `unattended` text. At a terminal the same step asks a `(y/N)` question, and No is `CANCELLED` (exit 1), not this code.

| Command                                                 | Headline                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `access off`                                            | `Turning Access off needs confirmation at a terminal, or --yes` (raised after connecting and reading the Gateway's settings and the Access applications; with nothing to turn off the run ends with `Cloudflare Access isn't in front of <host>. Nothing changed.` instead. At a terminal: `Turn Cloudflare Access off for <host>?`, No is `Cancelled. Access stays on.`)                                                     |
| `db query` against production, SQL that isn't read-only | `This SQL can change <app>'s production database` / `A person at a terminal confirms it first, or --yes does.`                                                                                                                                                                                                                                                                                                                |
| `db restore`                                            | `Restoring <app>'s database needs a person at a terminal to confirm, or --yes` / `It undoes <n> migration(s) (<names>) applied <time> ago by <who>; anything written to it since is lost too.` (`the Gateway's database` instead of `<app>'s database` with `--gateway`; `<who>` is `an API token` for a restore point an API token saved; `data`: `appId`, `databaseId`, `bookmark`, `migrations`, `createdAt`, `createdBy`) |
| `delete <app>`                                          | `Deleting an app needs confirmation at a terminal, or --yes`                                                                                                                                                                                                                                                                                                                                                                  |
| `secret unset`                                          | `Removing secrets needs confirmation, and there's no terminal to ask in`                                                                                                                                                                                                                                                                                                                                                      |

**Fix:** takeover: `rerun` is this same command with `--yes`, and `data.authorize: true`. Show the message and ask the person before rerunning with `--yes`. Not retryable.

Source: `packages/cli/src/lib/output/prompt.ts` (`confirmUnlessYes`), called from `packages/cli/src/commands/access/index.ts` (`turnAccessOff`), `packages/cli/src/commands/db/index.ts`, `packages/cli/src/commands/db/restore.ts`, `packages/cli/src/commands/delete/index.ts`, `packages/cli/src/commands/secret/index.ts`.

### D1_NOT_FOUND

`db query` against production: the Gateway's ledger of the app's resources records no D1 database for the binding queried (the one named with `--binding`, else the manifest's migration binding). The database is created by the app's first deploy. Headline: `<app> has no <binding> database yet`, then `It's created on the app's first deploy.`

**Fix:** `rerun`: `pnpm everyapp deploy`. Not retryable.

Source: `packages/cli/src/commands/db/index.ts` (`queryProduction`).

### DATABASE_URL_INVALID

A database URL in the app's secrets file `.everyapp/secrets.env` can't be parsed: `<BINDING>_ORIGIN_URL` for a Hyperdrive binding, or `POSTGRES_DATABASE_URL` (the origin of an app's only Hyperdrive config, and the database `drizzle-kit migrate` runs against). The message names the variable, never the value: `<VARIABLE> in .everyapp/secrets.env isn't a URL`, `… isn't a postgres:// or mysql:// URL`, or `… needs a host, a database, a user and a password` (the port defaults to 5432 or 3306). Raised by `deploy` while provisioning Hyperdrive configs (step `app.resources`) and before a Postgres migration runs (step `app.migrations`). No earlier step parses the URL: right after the manifest loads, `deploy` checks only that `POSTGRES_DATABASE_URL` is set (`POSTGRES_URL_MISSING`), and `parseOriginUrl` has no other caller.

**Fix:** `fix`: `write it as postgres://<user>:<password>@<host>:<port>/<database>`. No rerun; not retryable.

Source: `packages/cli/src/lib/app/deploySecrets.ts` (`parseOriginUrl`), called from `packages/cli/src/lib/app/resources.ts` and `packages/cli/src/lib/migrations/localCli.ts`.

### DEPLOY_NOT_UPLOADED

`cf deploy --prebuilt` exited 0, but Cloudflare reports the Worker's version unchanged: nothing was uploaded. cf does that when a person answers no to one of its own questions (it runs attached to the terminal under `--verbose`, or again attached after a strict-mode conflict) or gives up on a conflict. Headline: `cf finished without uploading a new version of <worker>`, then `Was one of its questions answered no? The version that was serving still is.` Raised wherever everyapp uploads a Worker: `deploy` (steps `app.upload` and `app.helper`), and the Gateway's own upload in `setup`, `update` and the rebind.

**Fix:** `rerun`: this same command, `rerunNote`: `to deploy again`. `retryable: false`; no takeover.

Source: `packages/cli/src/lib/cf/deploy.ts` (`cfDeploy`), called from `packages/cli/src/commands/deploy/deployApp.ts` and `packages/cli/src/lib/gateway/apply.ts`.

### DEV_PORT_IN_USE

`dev`: the gateway-lite's port (`--port`, else `$PORT`, else `8787`) on its host (`--host`, default `127.0.0.1`) is taken (`EADDRINUSE`). Checked before anything starts, and again when the server listens after the app is up. Headline: `Port <port> is already in use`; `data.port`, `data.host`, `data.free` (the next free port, found by probing upward), `data.error`.

**Fix:** `rerun`: this same command with `--port <free>` (any `--port` given is replaced). Not retryable.

Source: `packages/cli/src/commands/dev/gatewayServer.ts` (`portError`), `packages/cli/src/commands/dev/rerun.ts` (`replaceFlag`).

### DEV_PORT_UNAVAILABLE

`dev` can't listen on the host and port for a reason other than `EADDRINUSE` (the system's error is quoted). Headline: `Can't listen on <host>:<port>`, then the error's message; `data.port`, `data.host`.

**Fix:** `data.fix`: `pass another --port or --host`. No rerun; not retryable.

Source: `packages/cli/src/commands/dev/gatewayServer.ts` (`portError`).

### DEV_SERVER_FAILED

`dev` started the app's dev server (`cf dev`, or the manifest's `dev` command) on an internal port, and it exited before it answered HTTP there. Headline: `<app>'s dev server exited before it was ready`, then `Its output is above.` (the server's output is released to the terminal when it fails).

**Fix:** none offered: read the dev server's output above the error. No rerun; not retryable.

Source: `packages/cli/src/commands/dev/index.ts` (`waitForAppServer`).

### DEV_SERVER_TIMEOUT

`dev`: the app's dev server was still running but hadn't answered on its port 90 seconds after starting (`waitForHttp`, `timeoutMs = 90_000`). It must listen on the port everyapp passes in `PORT`. Headline: `<app>'s dev server didn't start listening in time`, then `It must listen on the port everyapp passes in PORT.`; `data.appPort`.

**Fix:** `data.fix`: `make its dev command (<dev command>) listen on the port in PORT` when the manifest has a `dev` command, else `in vite.config.ts, set server.port: Number(process.env.PORT)`. No rerun; not retryable.

Source: `packages/cli/src/commands/dev/index.ts` (`waitForAppServer`), `packages/cli/src/commands/dev/proxy.ts` (`waitForHttp`).

### DNS_RECORD_CONFLICT

A hostname about to be published as a Workers Custom Domain is already answered in DNS: an `A`, `AAAA`, `CNAME` or `NS` record at the name, or, when the name has no records of its own, a wildcard `*.<parent>` over it. cf would replace the record without asking, so the deploy refuses first. Checked for an app's new `<app>.<base>` (step `app.domain` of `deploy`, before anything is created or uploaded) and for the Gateway's hostnames (step `gateway.domains` of `setup`, `update` and the rebind). Headline: `<host> already points somewhere else` (or `<n> hostnames already point somewhere else`), then `Its DNS record: <type> <content>. Publishing it replaces the record.`, plus `A wildcard record stays, and keeps answering every other name.` when a wildcard answers it. Hostnames the Gateway already publishes are never a conflict: not the install row's, and (since 2026-10-24) not one the Gateway Worker holds as a Custom Domain without the row saying so, which a run that stopped after publishing it leaves behind (the account's first Worker stops on `register_workers_subdomain` after it) with Cloudflare's placeholder record `AAAA 100::` at the name. For a hostname with such a record in the way the check reads `cf workers list` once; when `every-app-gateway`'s `references.domains` has it, a `progress` line says `<host> is already this Gateway's Custom Domain (an earlier run published it, then stopped)` and the run goes on. The same record under another Worker's Custom Domain, or when the Workers can't be listed, is a conflict.

**Fix:** `fix`: `delete the record in Cloudflare (<zone> → DNS), or use another name` (`the records` for several). Takeover: `rerun` is this same command with `--force-dns`, `data.authorize: true`; ask before using it. With `--force-dns` the run goes on and warns `DNS_RECORD_REPLACED` instead. Not retryable.

Source: `packages/cli/src/lib/domains/preflight.ts` (`checkDnsRecords`), called from `packages/cli/src/commands/deploy/deployApp.ts`, `packages/cli/src/lib/gateway/apply.ts`.

### DNS_UNREADABLE

The same DNS check couldn't read the zone's records because Cloudflare refused the login (cf's `auth` kind: API code `10000` or `9109`, typically an API token without Zone DNS Read), so it can't tell whether publishing the hostname would replace a record. Headline: `Can't read <zone>'s DNS records with this Cloudflare login`, then `So it can't tell whether publishing <host> would replace one.` With `--force-dns` the check treats the zone as having no records and goes on.

**Fix:** `fix`: `give the API token Zone → DNS → Read`. Takeover: `rerun` is this same command with `--force-dns`, `data.authorize: true`. Not retryable.

Source: `packages/cli/src/lib/domains/preflight.ts` (`recordsAt`), `packages/cli/src/lib/cf/errors.ts` (the `auth` kind).

### DOMAIN_CHANGE_UNSUPPORTED

`setup --domain <host>` names a different host than the one the install row says the Gateway is live at (`liveVersionId` set). Moving an installed Gateway isn't supported; only an install that never uploaded can still change where it goes. Headline: `The Gateway can't move to <domain>`, then `It's installed at <gatewayHost>, and moving an installed Gateway isn't supported.`

**Fix:** `rerun`: this same command without `--domain` (and its value), `rerunNote`: `(without --domain) to update it where it is`. Not retryable.

Source: `packages/cli/src/commands/setup/deployGateway.ts` (`gatewayTarget`).

### DOMAIN_REQUIRED

`setup` is installing a new Gateway, no `--domain` was given, and nobody is at a terminal to pick one; the account has at least one active zone (with none it is the `add_domain` action). This is also how a `--json` run of the `install_gateway` action's rerun ends when that rerun is `pnpm everyapp setup` with no domain (`status`, `secret`, `email`, `db`: `lib/gateway/connect.ts`). Headline: `Choose the Gateway's address with --domain`, then `It must be under one of this account's domains: <zones>. A subdomain works best.`; `data.zones`.

**Fix:** with one zone: `fix`: `add --domain apps.<zone>, or another name under <zone>`, `rerun`: this same command with `--domain apps.<zone>` appended (`--json` included when the run had it: run it as it is), `rerunNote`: `or another name under <zone>`. With several zones: `fix`: `add --domain apps.<first zone>, or another name under <zone a>, <zone b> or <zone c>`, no `rerun`, and `data.choices`: one `{ label: <zone>, rerun }` per zone (the shape of `choose_account`), so the agent runs one choice's `rerun` as it is (built the same way), or asks the person which. Not retryable.

Source: `packages/cli/src/commands/setup/runSetup.ts` (`pickDomain`).

### DOWNGRADE_REFUSED

The Gateway this run would deploy is older than the live one. Order is not the version: a release is placed by the `when` of its newest migration, then by when its sources were last committed (`compareReleaseOrder`); the same release (same `sha256`) or a build of the same sources (same tree hash) is never a downgrade. Headline: `This checkout's Gateway (<version>) is older than the live one (<liveVersion>)`, or with equal versions `This checkout's Gateway (<version> from <Mon D>) is older than the live one (from <Mon D>)` (every Gateway deploy builds its release from the checkout, `lib/gateway/checkoutRelease.ts`); `data.live`, `data.candidate`. Two forms:

- `setup` and `update` (which take `--allow-downgrade`, a hidden flag): `fix`: `git pull, then run setup again`; `rerun`: this same command with `--allow-downgrade`, with `authorize: true` set by the error itself (`DOWNGRADE_REFUSED` isn't in `TAKEOVER_FLAGS`; only these two commands take the flag).
- `deploy` and `delete`, which rebind the Gateway with the one this checkout builds and so stop before anything changes (`refuseOlderCheckout`), and the rebind's recheck under the Gateway lease: `fix`: `git pull`; `rerun`: this same command, `rerunNote`: `after that`. No takeover.

**Fix:** as above: `git pull`, then the same command; a deliberate rollback is `setup --allow-downgrade`, after asking. Not retryable.

Source: `packages/cli/src/lib/gateway/apply.ts` (`downgradeRefused`, `refuseDowngrade`, `refuseOlderCheckout`), called from `packages/cli/src/commands/setup/runSetup.ts`, `packages/cli/src/commands/deploy/deployApp.ts`, `packages/cli/src/commands/delete/index.ts`.

### DRIZZLE_KIT_MISSING

`deploy` of an app whose manifest has `migrations.dialect: "postgresql"` (drizzle engine) runs the app's own `drizzle-kit migrate` (step `app.migrations`), and the app has no local `drizzle-kit` package to run. Nothing has been migrated or uploaded at that point. Headline: `Postgres migrations need drizzle-kit, which isn't installed`, then `Nothing was migrated or uploaded.`

**Fix:** `fix`: `add drizzle-kit to devDependencies, then deploy again`. No rerun; not retryable.

Source: `packages/cli/src/lib/migrations/postgres.ts` (`localDrizzleKit`), `packages/cli/src/lib/migrations/localCli.ts` (`localPackageRunner`).

### DURABLE_OBJECT_MOVED

`deploy` compares the manifest's `resources.durableObjects` with the previous deploy's: a class that is still declared but on a different `worker` would need its data moved between Workers, which Cloudflare does only by a transfer the deploy never makes. Headline: `<class> can't move to another Worker`, then `A Durable Object's data can't follow it.` Checked under the app's lease, before any resource is created.

**Fix:** `fix`: `give the class a new name in everyapp.config.ts`. No rerun; not retryable.

Source: `packages/cli/src/commands/deploy/deployApp.ts` (`checkDurableObjects`).

### DURABLE_OBJECT_REMOVED

`deploy`: the previous deploy's manifest declared Durable Object classes on the app's Worker that `everyapp.config.ts` no longer declares, and `--allow-delete-durable-object-data` wasn't given; deploying would delete their data for good. Headline: `Deploying would delete <class>'s data for good` (or `the data of <a>, <b>`), then `everyapp.config.ts no longer declares the Durable Object class <class>.` With the flag, the installed build gets a `durable-object` export with `state: "deleted"` for each class. (A class dropped from a helper Worker is `HELPER_DURABLE_OBJECT_REMOVED`, which the flag doesn't cover.)

**Fix:** takeover: `rerun` is this same command with `--allow-delete-durable-object-data`, `data.authorize: true`; show it and ask, the data is gone once it runs. Otherwise declare the class again. Not retryable.

Source: `packages/cli/src/commands/deploy/deployApp.ts` (`checkDurableObjects`), `packages/cli/src/lib/app/installBuildOutput.ts`.

### EMAIL_ADDRESS_TAKEN

An inbound address (the installation's `email_inbound` list, set with `email set --inbound`) belongs to something else. Three situations: the first two are found by the Email Routing plan (`planEmailRoutes`, before anything is created) in both `deploy` and `email set --inbound`; the third while the routes are made (`applyEmailRoutes`), and arrives under this code only from `deploy`:

- The Gateway's ledger records the address for another app: `<address> already goes to another app (<appId>)`. `fix`: `pick another address, or run pnpm everyapp email unset inbound in <appId>'s directory first`; `data.address`, `data.workerName`, `data.appId`.
- An Email Routing rule that isn't the app's delivers it (one named `everyapp:<worker>`, or sending to the app's Worker, or recorded by the app, counts as the app's): `<address> already forwards to <x>` (or `drops mail`, `goes to another Worker`, `sends mail to "<type>"`), then `The Email Routing rule "<name>" on <zone> delivers it.` `fix`: `remove that rule, or pick another address`; `data.address`, `data.zone`, `data.ruleId`, `data.actions`.
- While the routes were being made, another app recorded the address first (the ledger's `RESOURCE_OWNED`, in `recordRoute`): `<address> was recorded for another app while this run was routing it`. `fix`: `take another address, or remove it from that app first`; `data.address`. `deploy` calls `applyEmailRoutes` bare, so this is the error it reports. `email set --inbound` wraps the call, so from it the same failure arrives as `EMAIL_ROUTES_PARTIAL` with `data.cause: "EMAIL_ADDRESS_TAKEN"` and this message under that headline (see that entry).

**Fix:** as above. No rerun; not retryable; an address is never taken over.

Source: `packages/cli/src/lib/app/emailRoutes.ts` (`planEmailRoutes`, `recordRoute`).

### EMAIL_CATCH_ALL_NOT_APEX

An inbound address `*@<domain>` names a domain that is a subdomain of its Cloudflare zone; Email Routing's catch-all exists only at a zone's apex. Headline: `<address>: catch-alls only work on a zone's apex`, then `<domain> is a subdomain of <zone>.`; `data.address`, `data.zone`. Raised by `deploy` and `email set --inbound`.

**Fix:** `fix`: `list each address instead, e.g. --inbound support@<domain>`. No rerun; not retryable.

Source: `packages/cli/src/lib/app/emailRoutes.ts` (`planEmailRoutes`).

### EMAIL_CATCH_ALL_TAKEN

An inbound address `*@<zone>` would take over the zone's catch-all, which is enabled and already sends mail somewhere (any action other than `drop`) and isn't the app's. Headline: `<zone>'s catch-all already forwards to <x>` (or `goes to another Worker`, `sends mail to "<type>"`), then `<address> would take it over.`; `data.address`, `data.zone`, `data.actions`. Raised by `deploy` and `email set --inbound`.

**Fix:** `fix`: `set the catch-all back to Drop (Email Routing → Routing rules), or list addresses one by one`. No rerun; not retryable.

Source: `packages/cli/src/lib/app/emailRoutes.ts` (`planEmailRoutes`).

### EMAIL_INBOUND_INVALID

`email set --inbound <address> …` refused before the manifest is read or anything connects. `assertValidList` runs `emailListProblems("inbound", …)` (`packages/sdk/src/internal/email.ts`) and refuses the list with its problems, each said once: more than 50 addresses (`EMAIL_LIMITS.inbound`: `At most 50 inbound addresses, not <n>.`); an address longer than 90 characters (`EMAIL_LIMITS.inboundAddressChars`, Email Routing's limit on a rule's value: `<x> is longer than Email Routing's 90 characters.`); a value that isn't `*@<domain>` or `<local>@<domain>` in lowercase (`EMAIL_INBOUND_PATTERN`, `/^(\*|[a-z0-9._+-]+)@([a-z0-9-]+\.)+[a-z]{2,}$/`: `"<x>" isn't an inbound address: an inbound address is "*@<domain>" or "<local>@<domain>", in lowercase.`); a value listed twice (`<x> is listed twice.`). One problem: the headline is its text before `: `, and what follows is the next line with its first letter capitalized (`"Foo@example.com" isn't an inbound address` / `An inbound address is "*@<domain>" or "<local>@<domain>", in lowercase.`). Several: `<n> problems with --inbound`, then one `• <problem>` line each. `data.problems` either way.

**Fix:** with one problem, when lowercasing the values is all the list needs, `rerun` is this same command with those values lowercased (`--json` included when the run had it, as `thisCommand` builds it: run it as it is); otherwise none. Not retryable. `email unset` takes no list and never raises it.

Source: `packages/cli/src/commands/email/index.ts` (`assertValidList`, called from `setEmail`), `packages/sdk/src/internal/email.ts` (`emailListProblems`, `EMAIL_LIMITS`, `EMAIL_INBOUND_PATTERN`).

### EMAIL_INBOUND_NOT_DECLARED

`email set --inbound` for an app whose `everyapp.config.ts` doesn't declare `email: { inbound: true }` (the declaration that its Worker exports an `email()` handler). Checked from the local manifest, before the Gateway is contacted. Headline: `<app> can't receive mail yet`, then `everyapp.config.ts doesn't declare email: { inbound: true }.`

**Fix:** `fix`: `declare email: { inbound: true } and export email() from the app's Worker`; `rerun`: `pnpm everyapp deploy`, `rerunNote`: `then this command again`. Not retryable.

Source: `packages/cli/src/commands/email/index.ts` (`setEmail`).

### EMAIL_NOTHING_TO_SET

`email set` with neither `--sender` nor `--inbound`. Refused before the manifest is read. Headline: `Name what to set: --sender, --inbound, or both`.

**Fix:** `rerun`: `pnpm everyapp email set --help`. Not retryable.

Source: `packages/cli/src/commands/email/index.ts` (`setEmail`).

### EMAIL_NOT_DECLARED

`email set --sender` for an app whose manifest doesn't declare the email capability (`capabilities.email.access === "write"`). Checked from the local manifest. Headline: `<app> can't send mail yet`, then `everyapp.config.ts doesn't list email in its capabilities.`

**Fix:** `fix`: `add capabilities: { email: { access: "write" } } to everyapp.config.ts`; `rerun`: `pnpm everyapp deploy`, `rerunNote`: `then this command again`. Not retryable.

Source: `packages/cli/src/commands/email/index.ts` (`setEmail`).

### EMAIL_ROUTES_PARTIAL

`email set --inbound` or `email unset inbound` wrote the new list to the app's registry row (the intent), then making or removing the Email Routing routes from it stopped part-way. The addresses are saved; the next `deploy`, or the same command again, finishes the routes from the same row. Headline: `Inbound addresses saved, but routing them stopped part-way`, then the cause's message; `data.saved` (the stored list), `data.cause` (the inner error's code, or `null`).

**Fix:** `retryable: true`, so `rerun` is this same command; `rerunNote`: `again, or pnpm everyapp deploy, to finish`. No takeover.

Source: `packages/cli/src/commands/email/index.ts` (`changeEmail`).

### EMAIL_ROUTING_DISABLED

Email Routing is off for a domain of the app's inbound addresses (for a zone's apex, the zone's setting; for a subdomain, whether it has MX records at `*.mx.cloudflare.net`), `--enable-email-routing` wasn't given, and nobody is at a terminal to agree. Turning it on locks the domain's MX and SPF records to Cloudflare, so it is never done unasked. Headline: `Email Routing is off for <domain, …>`, then `Turning it on locks the domain's MX and SPF records to Cloudflare. Nothing was changed.`; `data.domains`, and `data.commands`: one `npx cf email-routing enable -z <zone> --name <domain>` per domain, to do it by hand. At a terminal the run asks `Turn on Email Routing for <domains>?` instead (No is `CANCELLED`). Raised by `deploy` and `email set --inbound`, both of which take the flag.

**Fix:** takeover: `rerun` is this same command with `--enable-email-routing`, `data.authorize: true`; show it and ask first. Not retryable.

Source: `packages/cli/src/lib/app/emailRoutes.ts` (`planEmailRoutes`).

### EMAIL_SENDERS_HOSTED

`email set --sender` against a Gateway whose install row records `deploymentMode: "hosted"`: a hosted Gateway sends all app mail from its own sender and takes no app senders. Checked after connecting, before the app's row is read. Headline: `This Gateway doesn't take app senders`, then `Hosted Gateways send all app mail from their own sender for now.`

**Fix:** none offered; no rerun; not retryable. Inbound addresses (`--inbound`) are unaffected.

Source: `packages/cli/src/commands/email/index.ts` (`changeEmail`).

### EMAIL_SENDER_INVALID

`email set --sender <pattern> …`: the same check on the sender list (`emailListProblems("senders", …)`): more than 20 senders (`EMAIL_LIMITS.senders`: `At most 20 senders, not <n>.`); a value that isn't `*@<domain>` or `<local>@<domain>` in lowercase (`EMAIL_SENDER_PATTERN`, `/^(\*|[a-z0-9._+-]+)@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/`: `"<x>" isn't a sender: a sender is "*@<domain>" or "<local>@<domain>", in lowercase.`); a value listed twice (`<x> is listed twice.`). No length limit on a sender. Same shape as `EMAIL_INBOUND_INVALID`: one problem is the headline with its rule under it, several are `<n> problems with --sender` and one `• <problem>` line each; `data.problems`. Checked before the manifest is read, so before `EMAIL_NOT_DECLARED` and `EMAIL_SENDERS_HOSTED`; with `--sender` and `--inbound` together the senders are checked first.

**Fix:** as for `EMAIL_INBOUND_INVALID`: with one problem that lowercasing the values would fix, `rerun` is this same command with them lowercased; otherwise none. Not retryable.

Source: `packages/cli/src/commands/email/index.ts` (`assertValidList`, called from `setEmail`), `packages/sdk/src/internal/email.ts` (`emailListProblems`, `EMAIL_LIMITS`, `EMAIL_SENDER_PATTERN`).

### EMAIL_ZONE_NOT_FOUND

The domain of an inbound address isn't in any zone of the Gateway's Cloudflare account (`resolveZone` found none holding it; a zone that exists but isn't active stays `ZONE_NOT_ACTIVE`). Email Routing rules live in the domain's zone, so there is nowhere to make one. Headline: `<domain> isn't on Cloudflare DNS in this account`, then `Email Routing needs the domain's zone in the Gateway's Cloudflare account.`; `data.domain`. Raised by `deploy` and `email set --inbound`.

**Fix:** `fix`: `add the domain (or its parent) to the account, or pick an address on another domain`. No rerun; not retryable.

Source: `packages/cli/src/lib/app/emailRoutes.ts` (`emailZone`), `packages/cli/src/lib/domains/zones.ts` (`resolveZone`).

## Error codes F–R

The codes below follow the defaults in `packages/cli/src/lib/errors.ts`: an error event has no `data.rerun` unless its raise site sets one or the error is `retryable: true` (then `data.rerun` is this same command as typed, `--json` included when the run had it, built by `thisCommand()`: run it as it is); `data.authorize: true` is set only for the takeover flags in `TAKEOVER_FLAGS`, and no code in this range is one of them, so none of these reruns needs a person's yes. Each entry says whether the code is `retryable`; a `data.fix` is a remedy in words, `data.rerun` a command to run, `data.rerunNote` what follows it. Angle brackets inside quoted messages stand for values filled in at run time.

### GATEWAY_NOT_FOUND

`requireGateway()` found no Gateway to act on after probing every Cloudflare account the login lists (`cf auth whoami`, then `cf d1 list --name every-app-gateway` per account; an account cf refuses or doesn't know counts as having none). Raised by every self-host command that connects to the Gateway through `connectToGateway()` (`deploy`, `delete`, `db query` without `--local`, `db restore`, `secret`, `email`, `access on|off|show`), by `status`, and by `update`. When the login lists accounts and none has a Gateway, `deploy` offers to install one instead, whether or not `--account-id` named one (at a terminal; otherwise `action_required install_gateway`; `connectToGateway()`'s `onNoGateway`), and `status` emits `install_gateway` unless an account was named (`existingGateway()`); so from `deploy` this code means the login lists no accounts, or the named account has none while another account does; from `status`, also that `--account-id` named an account and no account has one. Three messages:

| Situation                                                                                                                 | Message                                                                                                                                                                                                              | `data.fix` / `data.rerun`                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--account-id` or `CLOUDFLARE_ACCOUNT_ID` names an account without a Gateway while another account the login sees has one | `Cloudflare account <id> has no Gateway` then `This login's Gateway is in <account> at https://<host>.` (`Gateways are in …; …` for several)                                                                         | `data.fix`: `pass that account's id to --account-id (or CLOUDFLARE_ACCOUNT_ID), or drop it`                        |
| The login lists no accounts                                                                                               | `This Cloudflare login lists no accounts` (then `Logged in to Cloudflare as <email>.` when known)                                                                                                                    | `data.fix`: `pass the Gateway's account with --account-id, or set CLOUDFLARE_ACCOUNT_ID`                           |
| No account has one                                                                                                        | `No Gateway in <account>, the only account this login sees`, or `No Gateway in the <n> accounts this login sees` then their names; then the login line and `Or log in to the Gateway's account: pnpm everyapp login` | `data.rerun`: `pnpm everyapp setup --domain <hostname>` (literal `<hostname>`), `data.rerunNote`: `to install one` |

**Fix:** as the table says. `data.accounts` lists every account probed as `{ id, name }` (`name` null for an account cf doesn't list, such as one only `--account-id` named). Not retryable.

Source: `packages/cli/src/lib/gateway/discover.ts`, `packages/cli/src/lib/gateway/connect.ts`, `packages/cli/src/commands/setup/runSetup.ts`, `packages/cli/src/commands/deploy/steps/offerGateway.ts`

### GATEWAY_NOT_INSTALLED

The Gateway's D1 database exists but its install never finished. Four raise sites:

- `notDeployedByEveryapp()` in `lib/gateway/install.ts`: the database has no `_everyapp_install` row. Message `The Gateway's install didn't finish` then `Setup stopped before it recorded the install.`; `data.rerun` `pnpm everyapp setup`, `data.rerunNote` `asks for the hostname again`. Raised by `connectToGateway()` for every app command, and by `update` (which uses this message for a null `live_version_id` too).
- `requireInstall()` in `lib/gateway/connect.ts`: the row exists with `live_version_id` null (setup stopped before its first upload). Message `The Gateway at https://<host> isn't finished installing` then `Setup stopped before its first upload.`; `data.rerun` `pnpm everyapp setup`. Every command through `connectToGateway()`.
- `everyapp secret set|unset` of a Gateway setting (step `secrets.gateway`): the install row, re-read under the Gateway's lease, is gone. Message `The Gateway in <account> isn't fully installed` (the account omitted when cf doesn't name it); `data.rerun` `pnpm everyapp setup`.
- `reconcileGateway()` in `lib/gateway/reconcile.ts` reads the install row again before the rebind (`deploy`, step `app.bind`; `delete`; the repair or `--redeploy` of `setup` and `update`) and throws `notDeployedByEveryapp()` when the row is gone by then: the first site's message, `data.rerun` and `data.rerunNote`.

**Fix:** run `pnpm everyapp setup`; it resumes from the row it wrote, or asks for the hostname again when there is none. No `data.fix`, not retryable.

Source: `packages/cli/src/lib/gateway/install.ts`, `packages/cli/src/lib/gateway/connect.ts`, `packages/cli/src/commands/secret/index.ts`, `packages/cli/src/commands/setup/runSetup.ts`, `packages/cli/src/lib/gateway/reconcile.ts`

### GATEWAY_URL_MISMATCH

`--gateway` and `EVERYAPP_GATEWAY_URL` only pick among several Gateways; the URL a command uses always comes from the install row. `checkGatewayUrl()` raises this when the host they name (compared lowercase) isn't the found Gateway's `gateway_host`. Raised by every command through `connectToGateway()` (`deploy`, `delete`, `db query`, `db restore`, `secret`, `email`, `access on|off|show`). Message `The Gateway here is <found host>, not <requested host>` then `Found in <account>. For <requested host>, pass its account with --account-id.`

**Fix:** when the host came from `--gateway` on the command line, `data.rerun` is this command without `--gateway` and its value (`thisCommandWithout()`), `data.rerunNote` `to use <found host>`; when it came from the environment, `data.fix` is `unset EVERYAPP_GATEWAY_URL to use <found host>`. Not retryable.

Source: `packages/cli/src/lib/gateway/discover.ts`, `packages/cli/src/lib/gateway/connect.ts`

### HELPER_DURABLE_OBJECT_REMOVED

`deploy`, in `checkDurableObjects()` right after taking the app's lease and before any resource is touched: the last deployed manifest declared a Durable Object class with a `worker` (a helper Worker), and the new `everyapp.config.ts` no longer declares that class. Removing a helper Worker's class isn't supported, and `--allow-delete-durable-object-data` doesn't cover it (that flag covers classes on the app's own Worker: `DURABLE_OBJECT_REMOVED`). Message `The helper Worker <worker> still defines <class>` then `Removing a helper Worker's Durable Object class isn't supported yet.`

**Fix:** `data.fix`: `keep declaring <class> in everyapp.config.ts`. No rerun, not retryable.

Source: `packages/cli/src/commands/deploy/deployApp.ts`

### HYPERDRIVE_ORIGIN_MISSING

Self-host `deploy` (step `app.resources`) has to create the Hyperdrive config for a `resources.hyperdrive` binding and the app's secrets file `.everyapp/secrets.env` holds no origin for it: neither `<BINDING>_ORIGIN_URL` nor, when it is the app's only Hyperdrive config, `POSTGRES_DATABASE_URL`. The deploy creates one whenever no config under the binding's name can be used: none is recorded as the app's and none in the account has the name; the recorded one (by id) was deleted and nothing else has the name (a `RESOURCE_RECREATED` warning comes first); or the record has no id (a claim whose create was never recorded) and nothing has the name. Message `<binding> needs the database its Hyperdrive config connects to` then `Creating the config needs its URL.`

**Fix:** `data.fix`: `set <BINDING>_ORIGIN_URL (or POSTGRES_DATABASE_URL, when it is the app's only config) in .everyapp/secrets.env to postgres://<user>:<password>@<host>:<port>/<database>`; `data.rerun` is this same command. Not retryable.

Source: `packages/cli/src/lib/app/resources.ts`, `packages/cli/src/lib/app/deploySecrets.ts`

### IDENTITY_KEY_UNKNOWN

`deploy`, after the `app.deploy` step and before the app is registered: the install row's `jwt_public_key` is null, so the deploy has no public key to give the app's Workers for verifying the identities the Gateway signs. Message `The Gateway is missing its sign-in public key` then `App Workers need it to check who is signed in.`

**Fix:** `data.fix`: `restore JWT_PUBLIC_KEY as in https://github.com/every-app/every-app/blob/main/docs/runbooks/key-rotation.md` (mirrored at `/docs/agent/repo/runbooks/key-rotation`). No rerun, not retryable.

Source: `packages/cli/src/commands/deploy/deployApp.ts`, `packages/cli/src/lib/gateway/install.ts`

### INSTALL_FAILED

The app's dependency install exited non-zero: the manifest's `install` command (run through a shell) or, without one, the detected package manager's install (`pnpm install`, `npx pnpm install` when pnpm isn't on PATH, `yarn install`, `npm install`; detection: `packageManager` in package.json, then the lockfile, else pnpm). `runLogged()` keeps the child's output in `$TMPDIR/everyapp/<command>-<time>-<pid>.log`, echoed to stderr with `--verbose`. Raised in step `app.install` by `deploy` (unless deploying a release or the manifest sets `install: false`) and `release`: message `Installing dependencies failed` (or `Installing dependencies with <pnpm|yarn|npm> failed`), then `<command> exited with code <n>. Its last lines:` (or `… was stopped by <signal>`), the last 20 lines indented, and `Full log: <path>`. `everyapp create` (step `create.install`) rewraps it as `Couldn't install dependencies`, `<command> exited <n>. Its last lines:`, the last 5 lines, `Full log: <path>`, and `<./dir> is created; only the install is left.` Why pnpm installs fail: pnpm 10 and later block dependency build scripts unless approved, pnpm 11 exits 1 with `ERR_PNPM_IGNORED_BUILDS`, and nobody can answer `pnpm approve-builds` in this non-interactive install, so a project must declare its approvals.

**Fix:** no `data.fix`. From `create`, `data.rerun` is `cd <dir> && pnpm install`; from `deploy`, no rerun. `data` carries `command`, `exitCode` (null when a signal stopped it), `tail` (the last lines) and `log` (the file). Not retryable.

Source: `packages/cli/src/lib/package-manager.ts`, `packages/cli/src/lib/childLog.ts`, `packages/cli/src/commands/create/index.ts`, `packages/cli/src/commands/deploy/deployApp.ts`, `packages/cli/src/commands/release/bundleApp.ts`

### INSTALL_INPUTS_MISSING

Installing the Build Output for a self-host deploy (`installWorkerConfig()`, step `app.build`): a Worker's config binds a D1, KV, Hyperdrive or R2 resource whose `name` (D1, R2) or `id` (KV, Hyperdrive) is still that binding's build placeholder (`resourceSentinel(binding)`), but the deploy provisioned no resource of that kind under that binding, which is what happens when `cloudflare.config.ts` binds something `everyapp.config.ts` doesn't declare. Message `The build binds <D1 database|KV namespace|Hyperdrive config|R2 bucket> <binding>, which the deploy didn't provision`.

**Fix:** `data.fix`: `declare it in everyapp.config.ts's resources`. No rerun, not retryable.

Source: `packages/cli/src/lib/app/installBuildOutput.ts`

### INSTALL_PLACEHOLDER_LEFT

After installing a Worker's config for a self-host `deploy` (step `app.build`), a build placeholder survives: the sentinel Worker name, organization id, gateway URL or public key, or its JSON-encoded form, in a value or a key. Message `The build of <worker> still holds a build placeholder after installing it, at <paths>. Build the Worker from everyAppWorker() in cloudflare.config.ts, and leave its names, keys and ids to the deploy.` (`<paths>` are dotted paths into `worker.config.json`; `(root)` for the top level.)

**Fix:** build the Worker from `everyAppWorker()` and leave names, keys and ids out of `cloudflare.config.ts`. No `data.fix`, no rerun, not retryable.

Source: `packages/cli/src/lib/app/installBuildOutput.ts`

### INVALID_APP_BASE_DOMAIN

Patching the Gateway's Build Output for a Gateway deploy (`setup`, `update`, or the rebind an app's `deploy` or `delete` runs): the gateway host and the app base domain differ. The Gateway scopes its session cookie to `APP_BASE_DOMAIN` and apps find the Gateway by dropping their first label, so the base must be the Gateway's own host; one label above would hand the cookie to every other name in the zone. Message `Apps live one label below the gateway host <host>, so APP_BASE_DOMAIN must be <host>, not <base>.` Both values come from `--domain` on an install (`gatewayTarget` in `commands/setup/deployGateway.ts` sets the base to the domain) and from the install row on a rebind (`lib/gateway/reconcile.ts`), so the guard trips only on an install row whose base isn't its host.

**Fix:** none offered (no `data.fix`, no rerun); not retryable.

Source: `packages/cli/src/lib/gateway/patchBuildOutput.ts`, `packages/cli/src/lib/gateway/apply.ts`

### INVALID_APP_HOST

The same patch step: an app hostname to publish as a Workers Custom Domain on the Gateway isn't exactly one label below the app base domain. `applyGateway()` filters the hosts with `publishedAppHosts()` before the patch, so this is a guard. Message `Refusing to publish <hosts> on the gateway: app hosts are one label below <base>.`

**Fix:** none offered; not retryable.

Source: `packages/cli/src/lib/gateway/patchBuildOutput.ts`, `packages/cli/src/lib/gateway/apply.ts`, `packages/cli/src/lib/domains/hostnames.ts`

### INVALID_APP_ID

`everyapp create <name>`: the name given isn't a valid app id (without a name, the prompt validates inline instead). Rules: at most 64 characters; no `--` (it separates a Worker's name from its resources' names); `^[a-z]([a-z0-9-]*[a-z0-9])?$`; not reserved (`everyapp`, which prefixes the Gateway's own MCP tools, or a name whose Worker name is the Gateway's `every-app-gateway`: `workerNameFor()` prefixes `every-` unless the name already starts with it, so `app-gateway` and `every-app-gateway` are both reserved). Headline `"<name>" isn't a valid app name`, or `"<name>" is reserved for the platform`.

**Fix:** `data.fix` names the rule: `use 64 characters or fewer`; `don't put two dashes in a row, e.g. <name with each dash run collapsed>`; `use lowercase letters, digits and dashes, e.g. <slug>` when a slug can be made, else `use lowercase letters, digits and dashes, starting with a letter`; `pick another name` for a reserved one. No rerun, not retryable.

Source: `packages/cli/src/commands/create/steps/appId.ts`, `packages/perimeter/src/manifest/manifest.ts`

### INVALID_BUILD_OUTPUT

`validateWorkerConfig()` refused a `worker.config.json`. It runs on the Gateway's patched config before `cf` sees it, and on every app Worker's config in the app policy (`prepareAppBuildOutput()`: `deploy`, `release`, release deploys). Three messages: `The patched Worker config isn't valid Build Output: <path>: <issue>; …` (`@cloudflare/config`'s `OutputWorkerSchema`, every issue listed); `The Worker config still has a deploy-time placeholder.` (the string `__EVERYAPP_PATCH__` is still in it); and, for the Gateway only, `The gateway has no domain to deploy to.`

**Fix:** none offered; not retryable.

Source: `packages/cli/src/lib/gateway/patchBuildOutput.ts`, `packages/cli/src/lib/app/policy.ts`

### INVALID_DEV_MODE

`everyapp dev`: `--mode`, or `EVERYAPP_DEV_MODE` when the flag is absent, isn't `stub` or `mirror` (compared lowercase). Message `--mode must be stub or mirror, not "<value>"` (or `EVERYAPP_DEV_MODE must be stub or mirror, not "<value>"`) then `stub signs you in as a seeded dev user; mirror uses real login through a local Gateway.`

**Fix:** pass one of the two. No `data.fix`, no rerun, not retryable.

Source: `packages/cli/src/commands/dev/mode.ts`

### INVALID_DOMAIN

`normalizeHostname()` refused a hostname. The input is trimmed, lowercased and stripped of `http://` or `https://`, anything from the first `/`, `?` or `#`, and a trailing dot; what is left must be at least two labels of `[a-z0-9]` and `-` (1 to 63 characters each, no leading or trailing dash), 253 characters at most. `normalizeHostname()`'s own message is `<value> isn't a full hostname`, but its only callers are in `setup`'s `runSetup.ts`, and the form that surfaces is `domainFlag()`'s re-raise under the same code, `--domain <value> isn't a full hostname`: from `everyapp setup --domain <value>`, and from the Gateway install that `deploy` offers, which passes `apps.<zone>` (always a hostname) the same way. The interactive address prompt's `validate` catches it and asks again (`Enter a hostname like apps.<zone>`), and the call on the prompt's answer runs after that check.

**Fix:** `data.fix`: `use a name like apps.example.com`. No rerun, not retryable.

Source: `packages/cli/src/lib/domains/hostnames.ts`, `packages/cli/src/commands/setup/runSetup.ts`

### INVALID_GATEWAY_URL

`--gateway <value>`, or `EVERYAPP_GATEWAY_URL` without the flag, isn't a URL `new URL()` parses (a valid one is normalized: trailing slashes, query and fragment dropped). Raised by every command that reads them (`deploy`, `delete`, `db query`, `db restore`, `secret`, `email`, `access on|off|show`). Messages: `--gateway must be a full URL, not "<value>"` then `For example https://apps.example.com.`; or `EVERYAPP_GATEWAY_URL must be a full URL, not "<value>"`.

**Fix:** for the environment variable, `data.fix`: `set it to https://<value without its scheme>, or unset it`; for the flag, nothing beyond the message. No rerun, not retryable.

Source: `packages/cli/src/lib/gateway/connect.ts`

### INVALID_MANIFEST

`everyapp.config.ts` loaded, but `validateManifestStrict()` (`@every-app/perimeter/manifest`) threw a `ManifestError`. `everyapp dev` raises it itself: `everyapp.config.ts isn't valid` then the validator's message. In every other command the `ManifestError` propagates and `reportFailure()` reports it under this code with the validator's message alone (`knownFailure()` in `lib/output/report.ts`).

The registry raises the same code (a `RegistrationError`, status 400, passed through `lib/gateway/registry.ts` and answered by the Gateway's deploy API) when the manifest it is handed fails `validateManifest` (the validator's message, else `Invalid manifest`), when its `id` isn't the app id being registered (`manifest.id "<id>" does not match appId "<appId>"`), or when a `resources.r2` binding's bucket name is one Cloudflare refuses (`resources.r2: <binding> would be the R2 bucket "<name>", which Cloudflare refuses (at most <n> lowercase letters, digits and hyphens, starting and ending with a letter or digit). Rename the binding in everyapp.config.ts.`).

**Fix:** correct what the message names in `everyapp.config.ts`. No `data.fix`, no rerun, not retryable.

Source: `packages/cli/src/commands/dev/index.ts`, `packages/cli/src/lib/output/report.ts`, `packages/cli/src/lib/manifest.ts`, `packages/perimeter/src/registry/registration.ts`

### LEASE_HELD

A deploy lease (a row in the Gateway's D1 table `_everyapp_deploy_lease`, id `gateway`, `app:<workerName>` or `access`) was still held after 5 minutes of waiting (`WAIT_MS`, retried every 5 s; the rebind passes its own `leaseWaitMs`, and the Access sync after `deploy` and `delete` waits 60 s, `SYNC_LEASE_WAIT_MS`). A lease expires 3 minutes after its last renewal and is renewed every 30 s, so a dead holder frees it within 3 minutes; a live one holds it as long as it runs and nothing takes it over. While waiting, `progress` events on the step (`app.lease`, `gateway.lease`, `db.lease`) say who holds it. Takers: `deploy` (the app's lease, then the Gateway's for the rebind), `delete` (the Gateway's, for the rebind that unbinds the app), `secret set|unset`, `email set|unset`, `db restore`, `setup`, `update`, and `access on` plus the Access sync after `deploy` and `delete` (the `access` lease, step `gateway.lease`). Message with a holder: `<activity> is still running after 5m`, where `<activity>` is `A deploy of <app>`, `A Gateway upgrade`, `An update of Cloudflare Access`, `A restore of <app>'s database`, … (from the row's `purpose` and `app`) then `It's from <deployer on >machine. If it stopped without cleaning up, it's released within <time>.`; without one: `Couldn't take hold of <the Gateway|app id|this app> after 5m` (`this app` for the `access` lease, whose row names no app). When the Gateway's lease is held during an app's rebind (step `app.bind`), `bindIfNeeded()` rethrows with one more line, `This app's upload is kept; deploying again binds it and makes it live.`, and `data.rerunNote` `once the other deploy finishes`. The Access sync after `deploy` and `delete` catches it and emits the `ACCESS_SYNC_FAILED` warning (step `app.access`, with the message's first line) instead; from `access on` it is this error.

**Fix:** `retryable: true`: `data.rerun` is this same command, `data.rerunNote` `once it's done (pnpm everyapp status shows it)`. `data.holder`, when there is one, is the row: `id`, `holder`, `purpose` (`app.deploy`, `app.register`, `app.secrets`, `app.email`, `gateway.deploy`, `gateway.upgrade`, `gateway.reconcile`, `gateway.secrets`, `access.sync`, `db.restore`), `acquiredAt`, `expiresAt`, `app`, `deployer`, `machine`. No `data.fix`.

Source: `packages/cli/src/lib/gateway/lease.ts`, `packages/cli/src/commands/appGateway.ts`, `packages/cli/src/lib/access/sync.ts`

### LEASE_LOST

`lease.check()`, called right before each step that can't be undone (an app's migrate, each `cf deploy` of its Workers and its email routes; the Gateway's migrate and upload in `applyGateway()`; the D1 restore; the app's email settings row and then its routes in `email set|unset`; the Access applications in the Access sync), renewed the lease and found it no longer this run's: the renewal returned no row (the row is gone, or another run took it after it expired), or renewals had been failing for more than half the TTL (90 s). A `LEASE_HEARTBEAT` warning precedes it when renewals fail. Message `Stopped: this run lost its hold on <the Gateway|app id>` then `Its hold expired, so it stopped before its next change to avoid overlapping another run.` The Access sync after `deploy` and `delete` catches it and emits the `ACCESS_SYNC_FAILED` warning instead.

**Fix:** `retryable: true`: `data.rerun` is this same command. No `data.fix`.

Source: `packages/cli/src/lib/gateway/lease.ts`, `packages/cli/src/lib/access/sync.ts`

### MANIFEST_NOT_FOUND

`loadEveryAppManifestFile()` found no manifest file. From the working directory (`dev`, `deploy`, `release`, `db migrate`, `db query`, `db restore` without an app argument or `--gateway`): `No everyapp.config.ts in this directory`, `data.fix` `run this from the app's directory`. `email set|unset|show` without `--manifest`: the same message, `data.fix` `run this from the app's directory, or pass --manifest <path>`; with `--manifest <path>`: `No manifest at <path>`, no fix. `delete` without an app id: `Which app? There's no everyapp.config.ts here`, `data.fix` `run this from the app's directory, or name it: pnpm everyapp delete <id>`. `secret` reads the manifest only when one is there. `dev` raises it like every other command, through `loadEveryAppManifest` (its `loadManifest` in `commands/dev/index.ts` rewraps only an invalid manifest, as `INVALID_MANIFEST`).

**Fix:** as above. No rerun, not retryable.

Source: `packages/cli/src/lib/manifest.ts`, `packages/cli/src/commands/email/index.ts`, `packages/cli/src/commands/delete/index.ts`, `packages/cli/src/commands/dev/index.ts`

### MIGRATIONS_FAILED

A local D1 migration (the database `cf dev` and `everyapp dev` serve) failed to apply. `everyapp db migrate` (step `db.migrate`): `Migration <file> failed` (the first still-pending migration, which is the one that failed, since cf applies them in order and stops) or `A local migration failed`, then the SQL problem with its `SQLITE_…` code in parentheses; `data.migration` names the file. `everyapp dev` (step `dev.migrations`, before the app starts): `A local migration failed`, the error, then `Or start with --skip-migrations if the local database is already usable.` `everyapp create` emits a `warning` with this code instead when it can't set up the new app's local database (`data.rerun` `pnpm everyapp db migrate`).

**Fix:** `data.fix`: `correct <migrations dir>/<file>` (or `correct the migration` when the file isn't known) from `db migrate`; `correct the migration, then run <this command> again` from `dev`. No rerun, not retryable.

Source: `packages/cli/src/commands/db/index.ts`, `packages/cli/src/commands/dev/migrations.ts`, `packages/cli/src/commands/create/index.ts`

### MIGRATION_FAILED

A production migration failed. Migrations run before the upload, so the version that's serving keeps running. Three raise sites:

- D1, `cf d1 migrations apply` (`lib/migrations/remote.ts`): an app's (`deploy`; step `app.migrations`) or the Gateway's (`setup`, `update`, a rebind; step `gateway.migrations`). Message `Database migration failed`, cf's error, `Nothing was uploaded; the version that's serving keeps running.`, and, when a restore point was saved first, `To roll the database back to before this run: pnpm everyapp db restore` (`db restore <appId>` for a release deploy, `db restore --gateway` for the Gateway). A restore point (a Time Travel bookmark recorded in the Gateway's registry) is saved only when the database already held some of the migrations; a fresh database gets none. `data.fix` `correct the migration`; `data.rollbackCommand` is cf's own `d1 time-travel restore` command when a point was saved.
- Postgres with drizzle (`lib/migrations/postgres.ts`, the app's own `drizzle-kit migrate`): `drizzle-kit couldn't migrate the Postgres database` then `<why>. Nothing was uploaded.`; `data.fix` `check POSTGRES_DATABASE_URL in .everyapp/secrets.env and the migrations`.
- Postgres with Prisma (`lib/migrations/prisma.ts`, the app's own `prisma migrate deploy`): `prisma migrate deploy couldn't migrate the Postgres database` then `<why>. Nothing was uploaded.`; `data.fix` `check POSTGRES_DATABASE_URL in .everyapp/secrets.env, prisma.config.ts (its datasource reads it) and the migrations`.

Postgres has no restore point: the database's own backups are the way back. What the tools print comes back with the URL and password replaced.

**Fix:** as above; no rerun, not retryable.

Source: `packages/cli/src/lib/migrations/remote.ts`, `packages/cli/src/lib/migrations/postgres.ts`, `packages/cli/src/lib/migrations/prisma.ts`, `packages/cli/src/commands/deploy/deployApp.ts`, `packages/cli/src/lib/gateway/apply.ts`

### MIRROR_BASE_HOST

`everyapp dev --mode mirror` with a `--base-host` of one label (a port is ignored; the default, `everyapp.localhost`, passes): the session cookie must cross from the Gateway's base host to the app's subdomain, which needs a parent domain to scope it to. Message `Mirror mode needs a two-label base host, like everyapp.localhost`, then `The session cookie must cross from the Gateway to the app's subdomain; "<host>" has one label.`, then `Open apps at http://<app>.everyapp.localhost:<port> through portless or an /etc/hosts entry.`

**Fix:** `data.rerun` is this command with `--base-host everyapp.localhost` in place of the value given (`replaceFlag()`); `data.baseHost` is the value refused; `data.fix` `on the local Gateway, set EVERYAPP_DEV_COOKIE_DOMAIN=everyapp.localhost and GATEWAY_URL=http://everyapp.localhost:<port>`. Not retryable.

Source: `packages/cli/src/commands/dev/mode.ts`, `packages/cli/src/commands/dev/rerun.ts`

### MIRROR_GATEWAY_UNREACHABLE

`everyapp dev --mode mirror` (step `dev.gateway`, before anything starts): the separately running local Gateway at `--gateway` (default `http://localhost:3000`) didn't answer within 5 s. Message `No local Gateway at <url>` then `See "mirror mode" in docs/TESTING.md.`

**Fix:** `data.fix`: `run pnpm dev in apps/every-app-gateway, or pass --gateway <url>`; `data.gatewayUrl` is the URL probed. No rerun, not retryable.

Source: `packages/cli/src/commands/dev/index.ts`

### MISSING_CLOUDFLARE_CONFIG

The app has no `cloudflare.config.ts`. Self-host `deploy` of the app in the directory (not of a release) raises it with the headline `No cloudflare.config.ts in this app`, a sample config (`defineConfig` from `cf/config`, `everyAppWorker` from `@every-app/sdk/cloudflare`, the entrypoint imported `with { type: "cf-worker" }`, the manifest from `./everyapp.config.ts`) and `starter/ has the full setup (package.json, vite.config.ts).` `everyapp dev` raises it only when the manifest has no `dev` command either: `No cloudflare.config.ts in this directory` then `Every App apps build their Worker in cloudflare.config.ts with everyAppWorker() from @every-app/sdk/cloudflare.`

**Fix:** from `dev`, `data.fix`: `copy cloudflare.config.ts from starter/`; from `deploy`, the sample in the message. No rerun, not retryable.

Source: `packages/cli/src/commands/deploy/deployApp.ts`, `packages/cli/src/lib/app/cloudflareConfig.ts`, `packages/cli/src/commands/dev/index.ts`

### NESTED_APP

`everyapp create` was run in a directory that already has an `everyapp.config.ts` (the first check, before the name). Message `This directory is already an app` then `It has an everyapp.config.ts. New apps go next to it, not inside it.`

**Fix:** `data.fix`: `run create from the directory that holds your apps`. No rerun, not retryable.

Source: `packages/cli/src/commands/create/index.ts`

### NODE_TOO_OLD

Before `cf build` or `cf dev` (the cf calls that run the project's package manager: `deploy`, `dev`, `release`), the runner asks the package manager which Node it runs the project's tools on (`pnpm exec node -p process.versions.node`, `npm exec -- node …`, `yarn node …`). One older than 22.18.0 can't load `cloudflare.config.ts` (the build fails with `Unknown file extension ".ts"`); a Volta `volta.node` pin in package.json or pnpm's `use-node-version` puts another Node first. A probe that fails or prints no version raises nothing (cf reports in its own words). Message `<pm> runs this project's tools on Node.js <version>; cf needs 22.18.0 or newer` then ``everyapp runs on <node>, but something pins this project's (a Volta `volta.node` in package.json, pnpm's use-node-version). cf needs 22.18.0 or newer to load cloudflare.config.ts.``

**Fix:** `data.fix`: raise the pin (`volta pin node@22`, for Volta); `data.rerun` is this same command. Not retryable.

Source: `packages/cli/src/lib/cf/toolchain.ts`, `packages/cli/src/lib/cf/runner.ts`, `packages/cli/src/lib/runtime.ts`

### NO_D1

`everyapp db query` on an app whose manifest declares no `resources.d1` (checked before `--local` or production is decided). Message `<app> declares no D1 database`.

**Fix:** `data.fix`: `add a binding to resources.d1 in everyapp.config.ts`; `data.rerun` is `pnpm everyapp deploy` (the deploy that creates the database). Not retryable.

Source: `packages/cli/src/commands/db/index.ts`

### NO_RELEASE

`everyapp install <github.com repository URL>` (the repository, its `/releases` or `/releases/latest`, or `/releases/tag/<tag>`): that release has no `everyapp-release.tar.gz` an anonymous download can get (GitHub answers 404; a private repository looks the same). It is the download's `RELEASE_NOT_FOUND`, rewrapped for a repository; the CLI never builds a repository from source. Message `<owner/repo> publishes no everyapp release` (then ` <tag>` when one was named) then `Its GitHub releases have no everyapp-release.tar.gz.`

**Fix:** `data.fix`: `clone it, then run pnpm install && pnpm everyapp deploy in it`. No rerun, not retryable.

Source: `packages/cli/src/lib/app/release.ts`, `packages/cli/src/lib/release/github.ts`

### NO_RESTORE_POINT

`everyapp db restore [app]` or `db restore --gateway`: the Gateway's registry holds no restore point for that database. One is recorded only by a migrating deploy (an app's) or a migrating `setup` or Gateway upgrade (the Gateway's) when the database already held some of the migrations; a fresh database's is forgotten, an app's is forgotten once it is restored, and the Gateway's row goes with the restore itself. Message `No restore point for <app>'s database` (or `the Gateway's database`) then `everyapp saves one when a deploy migrates a database that has data.` (or `when setup or a Gateway upgrade migrates …`).

**Fix:** none offered; not retryable.

Source: `packages/cli/src/commands/db/restore.ts`, `packages/cli/src/lib/migrations/remote.ts`

### POSTGRES_URL_MISSING

`deploy` of an app whose manifest sets `migrations.dialect: "postgresql"`: `.everyapp/secrets.env` has no `POSTGRES_DATABASE_URL`. Checked right after the manifest loads, before the Gateway is contacted or anything is created. Message `<app> needs a Postgres URL to migrate its database` then `Format: postgres://<user>:<password>@<host>:<port>/<database>`.

**Fix:** `data.fix`: `set POSTGRES_DATABASE_URL in .everyapp/secrets.env, then deploy again`. No rerun, not retryable.

Source: `packages/cli/src/commands/deploy/deployApp.ts`, `packages/cli/src/lib/app/deploySecrets.ts`

### PRISMA_MISSING

Self-host `deploy` of an app with `migrations.engine: "prisma"` (dialect `postgresql`), step `app.migrations`: the app's own `prisma` package isn't installed, so `prisma migrate deploy` can't run. Message `Prisma migrations need prisma, which isn't installed` then `Nothing was migrated or uploaded.`

**Fix:** `data.fix`: `add prisma to devDependencies, then deploy again`. No rerun, not retryable.

Source: `packages/cli/src/lib/migrations/prisma.ts`

### QUERY_FAILED

`everyapp db query` (local or production): D1 refused the SQL with a SQLite error, recognized by a `SQLITE_…` code in cf's message. Message `Query failed: <problem>` then `<SQLITE_CODE> from the <local|production> database.` A cf failure without such a code is reported as cf's own (`CF_…`).

**Fix:** correct the SQL. No `data.fix`, no rerun, not retryable.

Source: `packages/cli/src/commands/db/index.ts`, `packages/cli/src/lib/cf/d1.ts`

### RELEASE_CORRUPT

Opening a release (`extractRelease()`): the SHA-256 over the extracted tree (every file except `release.json`: each path and the hash of its contents, in path order) isn't the `sha256` its `release.json` records. Gateway releases (the build from the checkout that every Gateway deploy opens, kept under the checkout's `node_modules/.cache/everyapp/<tree>.tar.gz`; `lib/gateway/checkoutRelease.ts`) and app releases (`install <url|tarball>`) alike. Message `<Gateway|App> release <version> doesn't match its checksum` then `The download may be damaged. Download it again.`

**Fix:** download it again. `data.expected` and `data.actual` carry the two hashes. No `data.fix`, no rerun, not retryable.

Source: `packages/cli/src/lib/gateway/release.ts`

### RELEASE_DOWNLOAD_FAILED

Downloading a release tarball over HTTPS failed: `install <url>` (step `app.release`). Downloads are anonymous (no token, cookie or identifying header), follow at most 5 redirects, HTTPS only, within 5 minutes and 200 MB. Messages: `<url> redirects nowhere.` or `<url> redirects too many times.`; `<href> isn't a URL.`; `<url> isn't an HTTPS URL.` or `<url> redirects to <href>, which isn't an HTTPS URL.`; `Couldn't download <url>: HTTP <status>.` (a 404 is `RELEASE_NOT_FOUND`); `GitHub didn't say which release of <owner/repo> <url> is.` (no redirect named a tag); `Downloading <url> timed out.`; `Couldn't download <url>: <error>`.

**Fix:** `retryable: true` (`data.rerun` is this same command) for a timeout, a thrown request or stream error, and an HTTP 5xx; not for the other messages. No `data.fix`.

Source: `packages/cli/src/lib/release/github.ts`, `packages/cli/src/lib/release/fetch.ts`, `packages/cli/src/lib/app/release.ts`

### RELEASE_INVALID

A release tarball isn't what it claims. From `extractRelease()`, either kind: `<tarball> is an app release, not a Gateway release.` (or the reverse; a `release.json` without `kind` is a Gateway's); `<tarball> holds more than a gateway release: <entries>.` (only `.cloudflare`, `drizzle` and `release.json` for a Gateway, `.cloudflare`, `migrations` and `release.json` for an app, since cf runs in a copy of it and would run anything else there); `<tarball> isn't a valid gateway release` then `Its release.json is malformed: <first issue>`; `<tarball> isn't a gateway release: <message>` (`an app release` for an app's) when `release.json` is missing (ENOENT) or isn't JSON (a `SyntaxError`), or when `tar` itself can't be spawned (ENOENT too); a tarball tar can't extract isn't rewrapped: `extractTarGz()` rejects with a plain `Error`, `tar couldn't extract <tarball> (exit <code>)`, which `reportFailure()` reports as `UNEXPECTED`. From `openAppRelease()`: `<tarball> carries a manifest this everyapp refuses: <message>`; `<tarball> says it is <appId>, but its manifest is <id>'s.`; `<tarball>'s manifest keeps its migrations in <dir>; a release keeps them in migrations/.`

**Fix:** none offered; not retryable.

Source: `packages/cli/src/lib/gateway/release.ts`, `packages/cli/src/lib/app/release.ts`

### RELEASE_LOCAL_STATE

`everyapp release`: the files staged for the release include local state or secrets: a name starting with `.dev.vars` or `.env`, ending in `.pem`, or a path under `.cloudflare/state`, `.cloudflare/types`, `.wrangler/` or `.everyapp/`. Message `Refusing to pack local state or secrets into the release:` then the files, one per line.

**Fix:** remove them from the Build Output and the migrations directory. No `data.fix`, no rerun, not retryable.

Source: `packages/cli/src/lib/app/release.ts`

### RELEASE_MIGRATIONS_UNSUPPORTED

A release carries SQL files, which only the D1 migration applies by itself; Postgres migrations run the app's own drizzle-kit or Prisma with its config, which a release doesn't have. Two raise sites: self-host `install <release>` of a manifest with `migrations.dialect: "postgresql"` (`deployApp.ts`, before anything else): `<app> can't deploy from a release: its Postgres migrations need the source`, `data.fix` `clone it, then run pnpm install && pnpm everyapp deploy in it`; and `release` of a manifest with `migrations.engine: "prisma"` (`lib/app/release.ts`): `<app> migrates with Prisma, which a release can't carry` then `Prisma migrations (migrations.engine "prisma") need the app's source and its Prisma CLI.`, `data.rerun` `pnpm everyapp deploy`, `data.rerunNote` `from the app's checkout`.

**Fix:** as above; not retryable.

Source: `packages/cli/src/commands/deploy/deployApp.ts`, `packages/cli/src/lib/app/release.ts`

### RELEASE_NOT_FOUND

The release `install <source>` names isn't there. A source that is neither a URL nor an existing file: `<source> is neither a URL nor a file` then `Pass a GitHub repository URL (https://github.com/<owner>/<repo>), a release tarball's URL, or a downloaded everyapp-release.tar.gz.` An HTTP 404: for a GitHub release asset, `<owner/repo> has no published release with <asset> that can be downloaded without signing in (https://github.com/<owner/repo>/releases).` (or `has no release <tag> with …`); for any other URL, `<url> doesn't exist (404).` For `install` with a github.com repository URL the 404 is reported as `NO_RELEASE` instead.

**Fix:** none offered beyond the message; not retryable.

Source: `packages/cli/src/lib/release/fetch.ts`, `packages/cli/src/lib/release/github.ts`, `packages/cli/src/lib/app/release.ts`

### RELEASE_PACK_FAILED

`everyapp release` couldn't pack the app. `.cloudflare/output` doesn't hold exactly `v0`: `Expected the Build Output v0 alone in <dir>, found <entries|none>.`; the Build Output isn't a production build: `The app's Build Output isn't a production build` then `A release ships only one.`, with `data.fix` build with `cf build` (production by default); or tar exited non-zero: `tar couldn't pack the release (exit <code>): <stderr>`.

**Fix:** as above; no rerun, not retryable.

Source: `packages/cli/src/lib/app/release.ts`

### RELEASE_TOO_LARGE

A release download declared (`content-length`) or streamed more than 200 MB. Message `<url> is over 200 MB, too big for a release` then `A release is a few MB. Check the URL.`

**Fix:** check the URL. No `data.fix`, no rerun, not retryable.

Source: `packages/cli/src/lib/release/github.ts`

### RELEASE_UNSUPPORTED

A release's `release.json` names a `buildOutputVersion` other than `v0`, the only Build Output format this CLI deploys. Gateway and app releases alike. Message `<Gateway|App> release <version> needs a newer everyapp`. (A release whose `minCli` is newer than this CLI is `CLI_TOO_OLD`.)

**Fix:** `data.fix`: `update everyapp (in a checkout: git pull), then run this again`; `data.buildOutputVersion` is the release's, `data.supported` is `v0`. No rerun, not retryable.

Source: `packages/cli/src/lib/gateway/release.ts`

### RESOURCE_NAME_MISSING

Self-host `deploy` (step `app.resources`): the registration plan the Gateway's rules produced has no name for a D1, KV or R2 binding, or a reserved one (`every-app-gateway`, or a name starting with `every-app-gateway-`, the Gateway's own resources). Message `The Gateway assigned no usable <D1 database|KV namespace|R2 bucket> name for binding <binding>`.

**Fix:** `data.rerun`: `pnpm everyapp setup`, `data.rerunNote` `to upgrade the Gateway`. No `data.fix`, not retryable.

Source: `packages/cli/src/lib/app/resources.ts`, `packages/perimeter/src/manifest/manifest.ts`

### RESOURCE_NAME_TAKEN

Self-host `deploy` (step `app.resources`) found a resource under the app's assigned name that no deploy of this app recorded as its own in `_everyapp_app_resources`; a name proves nothing, so it is refused on every attempt. D1 or KV: `A <D1 database|KV namespace> named "<name>" already exists in this Cloudflare account` then `No deploy of this app created it; it may belong to another Gateway, app or project.`, `data.fix` `delete or rename it`. Hyperdrive, when the existing config doesn't connect to the origin in `.everyapp/secrets.env` (one that does is adopted): `A Hyperdrive config named "<name>" already exists in this Cloudflare account` then `No deploy of this app created it.`, `data.fix` `to use it, set <BINDING>_ORIGIN_URL in .everyapp/secrets.env to the URL of the database it connects to; otherwise delete or rename it`. A race, when Cloudflare says the name was taken between the lookup and the create: `<Kind> "<name>" was created by someone else while this deploy was creating it`, `data.fix` `delete or rename it`. (The Worker's equivalent is `WORKER_NAME_TAKEN`.)

**Fix:** as above; each sets `data.rerun` to this same command. Not retryable.

Source: `packages/cli/src/lib/app/resources.ts`

### RESOURCE_OWNED

Recording a resource as the app's in `_everyapp_app_resources` hit one of its unique indexes: another app already records that resource id, or that name, under the same kind (Worker, D1, KV, Hyperdrive). Raised while claiming the Worker and provisioning resources in a self-host `deploy` (step `app.resources`). Message `<Kind> "<name>" is recorded as another app's` then `<workerName> can't use it.` For an Email Routing address the same violation is reported as `EMAIL_ADDRESS_TAKEN`.

**Fix:** `data.fix`: `rename the binding in everyapp.config.ts`. No rerun, not retryable.

Source: `packages/cli/src/lib/app/ownership.ts`, `packages/cli/src/lib/app/emailRoutes.ts`

### RESOURCE_REPLACED

Self-host `deploy` (step `app.resources`): the app's record names a D1, KV or Hyperdrive resource by id, that id no longer exists, and a different resource now has the name. (When nothing has the name, the deploy recreates it empty with a `RESOURCE_RECREATED` warning.) Message `<Kind> "<name>" isn't the one this app created` then `That one (<recorded id>) was deleted, and this one was created by someone else since.`

**Fix:** `data.fix`: `delete or rename it`; `data.rerun` is this same command. Not retryable.

Source: `packages/cli/src/lib/app/resources.ts`

### RESTORE_TARGET_TWICE

`everyapp db restore <app> --gateway`: an app and the Gateway named together. Message `Pass <app> or --gateway, not both`.

**Fix:** `data.fix`: `drop one of them`. No rerun, not retryable.

Source: `packages/cli/src/commands/db/restore.ts`

## Error codes S–Z

### SCHEMA_CHECK_FAILED

`deploy` and `release`, step `app.schema`: `drizzle-kit generate`, run with the app's own drizzle config but its `out` pointed at a copy of the migrations under `.everyapp/`, failed without writing a migration, so whether the schema matches is unknown. Headline `drizzle-kit couldn't compare the schema with the migrations`, then the first `...Error` line of drizzle-kit's stderr (else its last line, else `no answer in 120 s` or `exit <code>`), then `Nothing was migrated or uploaded.` The check runs after the build and before the database or the Worker changes, only for `migrations.engine` `"drizzle"` (the default) with D1 resources or `migrations.dialect` `"postgresql"`; a Prisma app is not checked (its step says so), and a missing drizzle-kit or config is the warning `SCHEMA_CHECK_SKIPPED`, not this error.

**Fix:** `rerun`: `pnpm db:generate`, `rerunNote`: `in a terminal; it asks about renamed columns and tables`. Not retryable.

Source: `packages/cli/src/commands/deploy/steps/checkSchemaDrift.ts`

### SCHEMA_DRIFT

Same step as `SCHEMA_CHECK_FAILED`: `drizzle-kit generate` wrote a new `.sql` file into the copy, which means the schema has changes the committed migrations lack. Message: `The schema has changes no migration covers` / `drizzle-kit would write a new migration for them. Nothing was migrated or uploaded.`

**Fix:** `rerun`: `pnpm db:generate`, `rerunNote`: `then run this again`. Not retryable.

Source: `packages/cli/src/commands/deploy/steps/checkSchemaDrift.ts`

### SECRETS_PARTIALLY_APPLIED

`secret set` or `secret unset`: the change landed on an earlier destination (the Gateway's Worker goes first, then the app's Worker and each helper) and `cf workers secrets bulk` failed on a later one. Message lines: `Couldn't set|remove <names> on|from <destination>`, `Cloudflare said: <first line of cf's error>`, `<done names> is|are set|removed; only <left names> is|are left.` `data.applied` is what already changed (per destination, with the Worker versions it made) and `data.left` the names still to do; the rerun names only those, so no value is asked for twice. When nothing had landed yet the cf error itself is reported instead.

**Fix:** `retryable: true`; `rerun`: `pnpm everyapp secret <set|unset> <left names>`.

Source: `packages/cli/src/commands/secret/index.ts`

### SECRET_EMPTY

`secret set <name> --from-env <VAR>` where `$VAR` is unset or empty: `$<VAR> is empty or not set`. Raised when the value is read, after the names were routed and the app found.

**Fix:** `fix`: `export <VAR> first, or name another variable with --from-env`.

Source: `packages/cli/src/lib/secretValue.ts`

### SECRET_NAME_INVALID

A secret name that isn't `/^[A-Za-z_][A-Za-z0-9_]*$/`: `"<name>" isn't a valid secret name`. Checked by `assertAppSecretName`, which `secret set|unset` (`notRoutable`) runs on a name the manifest's `secrets` doesn't list, after the `didYouMean` check against the Gateway settings (`SETTABLE_GATEWAY_SETTINGS` in `packages/sdk/src/internal/gatewaySettings.ts`) and the `SECRET_NOT_SETTABLE` checks, and before the Gateway is reached. A declared name is never checked here: the manifest validator already refused a bad one.

**Fix:** `fix`: `use letters, digits and underscores, starting with a letter, e.g. GITHUB_TOKEN`.

Source: `packages/cli/src/lib/app/secrets.ts`

### SECRET_NAME_RESERVED

`secret set|unset` of a name an app's secret can't take, checked without regard to case: `GATEWAY_URL`, `CF_VERSION_METADATA`, or any name starting `EVERYAPP_`, `EVERY_APP_` or `APP__` (the deploy sets `GATEWAY_URL` itself and builds in the identity settings and the gateway binding). Message: `<name> is a reserved name` / `everyapp manages GATEWAY_URL, CF_VERSION_METADATA and the EVERYAPP_*, EVERY_APP_* and APP__* names.` The manifest's own `secrets` follow the same rule.

**Fix:** `fix`: `pick another name`.

Source: `packages/cli/src/lib/app/secrets.ts`, `packages/sdk/src/internal/gatewaySettings.ts`

### SECRET_NOT_DECLARED

`secret set|unset`: a name that goes nowhere, refused before anything is read or the network used. Three situations, in the order `notRoutable` checks them:

- The name differs only in case or underscores from a Gateway setting or one of the manifest's secrets: `<name> isn't a Gateway setting[ or one of <app>'s secrets]`; `rerun` is the same command with the name corrected and `data.didYouMean` is the match.
- There is no `everyapp.config.ts` in the working directory: `<name> isn't a Gateway setting, and there's no app here` / `An app's own secrets are set|removed from the app's directory (where everyapp.config.ts is).` / `Gateway settings: pnpm everyapp secret list`; `fix`: `cd into the app's directory and run this again`.
- `set` of a name the manifest's `secrets` doesn't list: `<app> doesn't list <name> as a secret`, then either `It's one of the Gateway's own keys; listing it under secrets gives <app> a secret of its own.` (an install-owned setting) or `It isn't a Gateway setting either.`; `fix`: `add it to secrets in everyapp.config.ts: secrets: [<declared>, "<name>"],`, `rerun`: `pnpm everyapp secret set <name>`. `unset` takes an undeclared name (a secret dropped from the manifest can still be removed).

**Fix:** as above; a validation error, never retryable.

Source: `packages/cli/src/commands/secret/index.ts`

### SECRET_NOT_SETTABLE

`secret set|unset` of a Gateway setting the command doesn't change. Outside an app directory, an install-owned setting (`GATEWAY_URL`, `APP_BASE_DOMAIN`, `BETTER_AUTH_SECRET`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `GATEWAY_DEPLOYMENT_MODE`, `CLOUDFLARE_ACCOUNT_ID`, `THIRD_PARTY_DEPLOYS`): `<name> can't be changed with secret <set|unset>` / `It's one of the Gateway's own keys, written once by setup.` (for `THIRD_PARTY_DEPLOYS`: `It's the hosted Gateway's launch gate, opened by hand.`), with no fix. A dev-only setting (`MCP_ACCESS_TOKEN_TTL`, `DATAFORSEO_SANDBOX`): `<name> only works in local development` / `A deployed Gateway doesn't read it.`

**Fix:** dev-only: `fix`: `set it in the Gateway's .dev.vars`. Install-owned: none (run `setup`).

Source: `packages/cli/src/commands/secret/index.ts`, `packages/sdk/src/internal/gatewaySettings.ts`

### SECRET_SEVERAL_NAMES

`secret set A B ... --from-env VAR`, or two or more names with a value piped on stdin: a source that holds one value can't set several names. Message: `--from-env sets one secret at a time, and you named <n>` or `A piped value sets one secret at a time, and you named <n>`. Checked first, before any other check. At a terminal (stdin a TTY, no `--from-env`) several names are fine: each gets its own hidden prompt.

**Fix:** `fix`: `run it once per name, e.g. pnpm everyapp secret set A --from-env VAR` or `echo "$A" | pnpm everyapp secret set A`.

Source: `packages/cli/src/lib/secretValue.ts`

### SECRET_VALUE_REQUIRED

`secret set <name>` with no way to get a value: stdin was piped but empty, or there is no terminal to prompt at (`canPromptInTerminal` in `packages/cli/src/lib/output/prompt.ts`: stdin or stderr isn't a TTY, `--json`, or `CI` is set). Message: `Can't ask for <name>'s value without a terminal` / `Or pipe it in: echo "$<name>" | pnpm everyapp secret set <name>`. A value never comes from the command line.

**Fix:** `rerun`: `pnpm everyapp secret set <name> --from-env <name>`.

Source: `packages/cli/src/lib/secretValue.ts`

### SETTING_VALUE_INVALID

`secret set <name>` of a plain Gateway setting (a name `isPlainGatewaySetting` knows, such as `EMAIL_FROM`, `EMAIL_PASSWORD_SIGN_IN` or `CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS`) with a `--from-env` or piped value the Gateway wouldn't read, checked after the value is trimmed and before anything is written. Message: `<name> can't be "<value>"` (the value as typed, on one line, at most 64 characters: a plain value is never hidden), then one line saying what is wrong, such as `Not one of true, false, 1, 0, on, off, yes or no.` or `"hello" isn't an address or Name <address>.`; `data.name` is the setting. At a terminal the same check re-asks the visible prompt with that line instead of failing; a credential (any other name) is never checked or trimmed. Each setting's rule, as the Gateway parses it, is listed in secrets.md under "Plain settings are shown and checked".

**Fix:** `fix`: `use <what the setting takes>`, the line the prompt shows as `Takes …`: e.g. `use true or false; false turns password sign-in off (only while Cloudflare Access sign-in is on)`, `use an address, or Name <address>`, `use email domains whose people join without an invitation, comma separated, e.g. example.com`. A validation error: no rerun.

Source: `packages/cli/src/lib/secretValue.ts`

### SHARED_APP_FORBIDDEN

A Cloudflare login whose verified email isn't an owner or admin of the platform organization tried to `deploy` or `delete` a shared app (a row whose scope is `shared`; a redeploy keeps the row's scope), or to change its email lists with `email set|unset`: `Only <organization> owners and admins can <deploy|delete|change the email of> shared apps` / `<email> isn't an owner or admin of <organization>, the platform organization.` An API token (`CLOUDFLARE_API_TOKEN` set, so the deployer has no email) is the account's own authority and is never checked.

**Fix:** `fix`: `ask an owner of <organization> to make you an admin, or to do it for you`.

Source: `packages/cli/src/lib/gateway/registry.ts`

### SQL_FILE_NOT_FOUND

`db query --file <path>` where nothing is at `<path>`: `No file at <path>`. `--file -` reads stdin instead.

**Fix:** none given; pass a file that exists.

Source: `packages/cli/src/commands/db/index.ts`

### SQL_REQUIRED

`db query` with neither a SQL argument nor `--file`: `No SQL to run`.

**Fix:** `data.fix`: `pass it as an argument, or with --file <path> (- for stdin)`.

Source: `packages/cli/src/commands/db/index.ts`

### SQL_TWICE

`db query "<sql>" --file <path>`: both given. Message: `Pass the SQL or --file, not both`.

**Fix:** `data.fix`: `drop one of them`.

Source: `packages/cli/src/commands/db/index.ts`

### TEARDOWN_ACCOUNT_FORBIDDEN

`teardown --account-id <id>` names an account that can never be torn down (`FORBIDDEN_ACCOUNTS` in `packages/cli/src/lib/teardown/guards.ts`: the live account that holds openseo.so and everyapp.team). Refused before the allowlist is read and before anything is asked of Cloudflare. Headline: `Cloudflare account <id> can never be torn down`, then `It is a live account, refused by id before any allowlist is read.`; `data.accountId`.

**Fix:** none offered; no rerun; not retryable. Use a dedicated test account (docs/runbooks/onboarding-loop-test-accounts.md in the checkout).

Source: `packages/cli/src/lib/teardown/guards.ts` (`checkAccountEligible`).

### TEARDOWN_ACCOUNT_NOT_VISIBLE

`teardown`: `cf auth whoami` under `CLOUDFLARE_API_TOKEN` doesn't list `--account-id`. Checked after the allowlist and the token's scope, before any read of the account. Headline: `CLOUDFLARE_API_TOKEN doesn't list Cloudflare account <id>`, then `It lists no accounts.` or `It lists <ids>.`; `data.accountId`, `data.accounts` (what it does list, each `{ id, name }`).

**Fix:** `fix`: `use that account's token, with Account Settings: Read on it (runbook step 5)`; no rerun; not retryable.

Source: `packages/cli/src/lib/teardown/guards.ts` (`checkTokenScope`).

### TEARDOWN_CONFIRMATION_REQUIRED

`teardown` without a terminal (`--json`, a pipe, `CI` set) and without `--confirm`: the inventory was read and is in the event, and nothing was deleted. Headline: `Tearing down <id> needs its id typed at a terminal, or --confirm <id>`, then `<the plan's summary> would be deleted for good. Nothing was changed.`; `data.accountId`, `data.plan` (the inventory, as `--dry-run`'s `done.data.plan`). At a terminal the same step asks `Type <id> to delete all of this`, and anything else typed is `CANCELLED` (exit 1).

**Fix:** `rerun`: this command with `--confirm <id>` (`data.authorize: true`: show the plan to the person and run it only when they asked for the deletion; there is no `--yes`); `rerunNote`: `only for a dedicated test account`. Not retryable.

Source: `packages/cli/src/commands/teardown/index.ts`.

### TEARDOWN_CONFIRM_MISMATCH

`teardown --confirm <x>` where `<x>` (trimmed, lowercased) isn't `--account-id`. Refused before `cf auth whoami`, so before any read. Headline: `--confirm <x> isn't the account id`, then `It must repeat --account-id <id> exactly. Nothing was read or changed.`; `data.accountId`, `data.confirm`.

**Fix:** `fix`: `pass --confirm <id>`; no rerun; not retryable.

Source: `packages/cli/src/commands/teardown/index.ts`.

### TEARDOWN_INVALID_ACCOUNT_ID

`teardown --account-id <x>` where `<x>` (trimmed) isn't 32 hex characters: no allowlist could hold it, so the refusal doesn't send anyone to the allowlist. Checked first, before the forbidden list. Headline: `"<x>" isn't a Cloudflare account id`, then `An account id is 32 hex characters (Compute (Workers) → Overview, or any dashboard URL dash.cloudflare.com/<account id>/...).`; `data.accountId`.

**Fix:** `fix`: `pass the test account's id from the dashboard as --account-id`; no rerun; not retryable.

Source: `packages/cli/src/lib/teardown/guards.ts` (`checkAccountEligible`).

### TEARDOWN_NEEDS_TOKEN

`teardown` with no `CLOUDFLARE_API_TOKEN` in the environment, or when `cf auth whoami` says it authenticated with something else (`authSource` not the environment token: a `cf auth login` session is a person, who sees every account they belong to), so the command runs only under a token scoped to the test account. The first is checked after the allowlist, before `cf auth whoami`; the second right after whoami, before any read of the account. Headline: `teardown needs CLOUDFLARE_API_TOKEN`, or `teardown needs CLOUDFLARE_API_TOKEN, but cf authenticated with <authSource>`, then `A Cloudflare login is a person, who sees every account they belong to; teardown runs only with an API token scoped to the test account (runbook step 5).`; `data.accountId`, and `data.authSource` in the second case. A token Cloudflare rejects (`tokenValid: false`, no accounts) is `CLOUDFLARE_TOKEN_REJECTED` instead.

**Fix:** `fix`: `set CLOUDFLARE_API_TOKEN to the test account's token for this one command, and run it again`; no rerun; not retryable.

Source: `packages/cli/src/lib/teardown/guards.ts` (`checkAccountEligible`).

### TEARDOWN_NOT_ALLOWLISTED

`teardown --account-id <id>` where `<id>` isn't on the allowlist of dedicated test accounts: `EVERYAPP_TEST_ACCOUNTS` (ids separated by commas or whitespace) and the file `~/.config/everyapp/test-accounts` (`$XDG_CONFIG_HOME/everyapp/test-accounts` when set; one id per line, `#` starts a comment), read together. Checked before the token and before any read. Headline: `Cloudflare account <id> isn't on the teardown allowlist`, then `teardown deletes everything Every App made in an account, so it runs only against accounts listed as dedicated test accounts.`; `data.accountId`, `data.file`.

**Fix:** `fix`: `only for a dedicated test account that holds nothing else (docs/runbooks/onboarding-loop-test-accounts.md): set EVERYAPP_TEST_ACCOUNTS=<id> for this one command, or add a line <id> to <file>`; no rerun; not retryable. Never add an account to the list on the person's behalf.

Source: `packages/cli/src/lib/teardown/guards.ts` (`checkAccountEligible`, `readAllowlist`).

### TEARDOWN_TOKEN_TOO_BROAD

`teardown`: `cf auth whoami` under `CLOUDFLARE_API_TOKEN` lists an account that isn't on the allowlist, or a forbidden one, so there would be a path from this run to a live account. Checked before any read of the account. Headline: `CLOUDFLARE_API_TOKEN sees <n> account(s) that isn't a test account|aren't test accounts: <name (id), …>`, then `A teardown token must be scoped to the test account alone (Account Resources → Include → that account), so there is no path from here to a live account.`; `data.accountId`, `data.accounts` (the accounts outside the list).

**Fix:** `fix`: `mint a token for the test account only (runbook step 5)`; no rerun; not retryable.

Source: `packages/cli/src/lib/teardown/guards.ts` (`checkTokenScope`).

### TIER_POLICY

`deploy` (self-host), after the registration and before the `app.register` step is reported (a `--json` run shows no `app.register` step before this error): `manifestTierProblems(manifest, plan.app.tier)` returned problems. Message: `<app> can't be deployed as configured` followed by one problem per line. For tier `service_binding` (the tier the CLI registers every app on) there are never any; for tier `dispatch` the problems are `resources.hyperdrive: Hyperdrive isn't available to apps in a dispatch namespace (an account holds at most 25 configs)`, `resources.r2: R2 buckets aren't available to apps in a dispatch namespace yet`, `email.inbound: apps in a dispatch namespace don't receive mail` and `secrets: third-party apps can't have secrets of their own yet`; any other tier is `apps on tier "<tier>" can't be deployed`.

**Fix:** `fix`: `change everyapp.config.ts, then deploy again`.

Source: `packages/cli/src/commands/deploy/deployApp.ts`, `packages/perimeter/src/manifest/manifest.ts` (`manifestTierProblems`)

### UNKNOWN_D1_BINDING

`db query --binding <name>` where `<name>` isn't one of the manifest's `resources.d1`: `No D1 binding <name> in everyapp.config.ts` / `It declares <bindings>.` Without `--binding` the query goes to the migration binding (`migrations.binding`, else the first D1 binding).

**Fix:** `rerun`: this command with `--binding` set to the first declared binding.

Source: `packages/cli/src/commands/db/index.ts`

### UNSAFE_CF_DIRECTORY

Raised by any command before it runs `cf`: the CLI runs account-plane `cf` calls in `~/.everyapp/cf/neutral` and keeps the files it hands to cf (secrets files, extracted releases, the patched build cf deploys) under `~/.everyapp/cf/tmp`, because cf runs the first `cloudflare.config.ts` it finds in its working directory or any parent. Each of these is refused:

- `sudo everyapp …` with the user's HOME kept (root, `SUDO_UID` set, HOME owned by that uid): `everyapp is running as root (sudo) with your HOME` / `It would leave ~/.everyapp in <home> to root.`; `fix`: `run it without sudo`.
- `~/.everyapp` isn't a directory, is owned by another user, is writable by other users and can't be made 0700 (a file in it belongs to another user): `<dir> <problem>` / `everyapp runs cf and keeps the files it hands to cf (secrets among them) there, so only you may be able to write to it.`; `fix`: `fix or remove it`, `rerun`: this command. A directory of ours that is merely too open is made 0700 silently.
- A directory under it can't be recreated as a private directory: `<dir> can't be made a private directory (<error>; was everyapp run with sudo?)`.
- An ancestor of the directory (up to `/`, real path) is owned by another user, or group- or world-writable: `<ancestor> is owned by another user|is writable by other users, so everyapp won't run cf below it` / `cf runs any cloudflare.config.ts it finds in a parent of its working directory (here <dir>).`; `fix`: `make it writable only by you (chmod go-w "<ancestor>"), or run everyapp with a HOME that is`. An ancestor owned by root is always trusted; run as root, any ancestor's owner is (`othersCanWrite`: `stat.uid === uid || stat.uid === 0 || (parent && uid === 0)`; CI containers run as root with the runner user's HOME).
- A `cloudflare.config.ts` exists in an ancestor: `cf would run <file> in every command everyapp starts`; `fix`: `move that file into a project directory`, `rerun`: this command.

**Fix:** as above. Not retryable.

Source: `packages/cli/src/lib/cf/privateDir.ts`

### UNSUPPORTED_RUNTIME

Checked in `packages/cli/src/bin/cli.ts` before any command runs, and reported through the normal error path (so `--json` gets the event). Under Bun: `everyapp runs on Node.js, not Bun` / `The Cloudflare CLI can't load cloudflare.config.ts under Bun.`; `rerun`: this command, `rerunNote`: `with Node.js 22.18.0 or newer`. On Node older than `22.18.0` (`MIN_NODE_VERSION`, the first Node whose built-in TypeScript stripping loads a `cloudflare.config.ts`): `everyapp needs Node.js 22.18.0 or newer; this is <version>` / `The Cloudflare CLI loads cloudflare.config.ts with Node's built-in TypeScript support.`

**Fix:** `fix`: `install Node 22 or 24, then run the command again`.

Source: `packages/cli/src/lib/runtime.ts`, `packages/cli/src/bin/cli.ts`

### VERSION_UNKNOWN

`deploy`, step `app.upload`: cf uploaded the Worker but reported no version id: `Cloudflare reports no version for <app> after the upload`, `data.workerName`; nothing to run.

**Fix:** as above. Not retryable.

Source: `packages/cli/src/commands/deploy/deployApp.ts`

### WORKER_NAME_MISMATCH

`register()` in `lib/gateway/registry.ts`, when its caller passes an `expectedWorkerName` that isn't the one the registry's naming rules give the app: `<app>'s Worker must be named <expected>, not <given>` / `The Gateway binds each app's Worker by that name only.` No command passes one (`deploy` takes the Worker name from the registration), so no command ends with it.

**Fix:** `fix`: `deploy the Worker as <expected>`; `rerun`: this command without `--worker`, then `--worker <expected>`.

Source: `packages/cli/src/lib/gateway/registry.ts`

### WORKER_NAME_TAKEN

`deploy`, step `app.resources` (`claimAppWorker`, for the app's Worker and each helper Worker): a Worker with the name exists in the Cloudflare account, but the Gateway's resource ledger doesn't record it as this app's: `A Worker named <name> already exists in this Cloudflare account` / `No deploy of this app created it; it may belong to another Gateway or project.`; `fix`: `delete or rename it`, `rerun`: this command. The same code comes from the registry rules (a `RegistrationError`, status 409, passed through `lib/gateway/registry.ts` and the Gateway's deploy API) when the Worker name is registered to another app on this Gateway: `The worker name "<name>" is already registered to another app on this gateway. Choose a different app id.`

**Fix:** as above. The registry variant is not retryable (status 409 is below 500).

Source: `packages/cli/src/lib/app/resources.ts`, `packages/perimeter/src/registry/registration.ts`

### WORKFLOW_NAME_TAKEN

`deploy`, step `app.build` (`assertOwnWorkflows`, for the app's Worker and each helper): a Workflow named `<worker>--<binding>` exists in the account and runs on another Worker, and cf's update would reassign it: `A Workflow named "<name>" already exists in this Cloudflare account` / `It runs on Worker <script name>, not <worker>; deploying would take it over.`

**Fix:** `fix`: `delete or rename it`, `rerun`: this command.

Source: `packages/cli/src/lib/app/workflows.ts`

### WORKFLOW_NAME_TOO_LONG

`deploy`, when the Build Output is installed: a Workflow's name (the Worker's name plus the binding) is longer than Cloudflare's 64 characters: `<binding> would be the Workflow "<name>", longer than Cloudflare's 64 characters`.

**Fix:** `fix`: `shorten its binding name in everyapp.config.ts`.

Source: `packages/cli/src/lib/app/installBuildOutput.ts`

### WORKFLOW_REMOVED

`deploy`: `everyapp.config.ts` no longer declares a Workflow that the last deploy's manifest did and that still runs on the app's Worker, so deploying would delete it and its instances: `Deploying would delete the Workflow(s) <bindings> and its|their instances` / `everyapp.config.ts no longer declares it|them. Renaming a binding renames its Workflow.` Checked before the upload.

**Fix:** a takeover: `rerun` is this command with `--allow-delete-workflows`, with `data.authorize: true` (show it and ask before running it). Not retryable.

Source: `packages/cli/src/commands/deploy/deployApp.ts` (`TAKEOVER_FLAGS` in `packages/cli/src/lib/errors.ts`)

### ZONE_CUSTOM_DOMAIN_LIMIT

`preflightDomains` before new hostnames are published on the Gateway (setup and the Gateway rebind, step `gateway.domains`; `deploy`, step `app.domain`): the Gateway would publish more than Cloudflare's 100 Custom Domains in the zone: `<zone> would go over Cloudflare's 100 Custom Domains per zone` / `The Gateway alone needs <total> there, before other Workers' domains.` `data.total`, `data.limit: 100`. From 95 on it's the warning `ZONE_CUSTOM_DOMAIN_LIMIT_NEAR`.

**Fix:** `fix`: `delete apps you no longer use (pnpm everyapp delete <app>), or install a second Gateway on another domain`.

Source: `packages/cli/src/lib/domains/preflight.ts`

### ZONE_NOT_ACTIVE

`resolveZone`: the zone holding the hostname exists in the account but its status isn't `active` (its nameservers don't point at Cloudflare yet), and Custom Domains can't be created in it: `The Cloudflare zone <zone> is <status>, not active`. Reached through `planEmailRoutes` (an inbound address's domain) by `deploy` and `email set --inbound`. `setup` reports the same situation as the `add_domain` action instead.

**Fix:** `fix`: `finish its nameserver setup (Cloudflare dashboard → <zone> → Overview)`, `rerun`: this command.

Source: `packages/cli/src/lib/domains/zones.ts`

### ZONE_NOT_FOUND

`setup --domain <host>` (and the domain picked at the prompt): no zone in the account holds the hostname: `<domain> isn't under a domain in this Cloudflare account`, then `This account's domains: <active zones>` when there are any; `data.url` is the account's Domains page (`https://dash.cloudflare.com/<account id>/domains/overview`) and `data.zones` the active zones. The same code from `resolveZone` (`No zone in this Cloudflare account holds <host>` / `Looked for <candidates>. Buy a domain in the dashboard (Domains, <url>), or add one you own and point its nameservers at Cloudflare.`, `fix`: `use a domain that is on Cloudflare in this account`) is rethrown by its only caller, `lib/app/emailRoutes.ts`, as `EMAIL_ZONE_NOT_FOUND`.

**Fix:** setup: `fix`: `use a name under one of them, or add <domain>'s domain to Cloudflare` (or `add <domain>'s domain to Cloudflare` when the account has no active zone).

Source: `packages/cli/src/commands/setup/deployGateway.ts`, `packages/cli/src/lib/domains/zones.ts`

## Codes the reporter gives

`reportFailure` in `packages/cli/src/lib/output/report.ts` turns whatever a command threw into its last event. An `ActionRequiredError` is `action_required`; an `EveryAppError` is `error` with its own code (the codes above and in the other sections); everything else gets one of these. A `retryable` one carries `data.rerun` (this command, `--json` included when the run had it: run it as it is). A failure after a migration appends `The database stays migrated. To roll it back: <restore command>` to the message and `data.rollbackCommand` (cf's `d1 time-travel restore`) to the data.

### CANCELLED

`ReportCode.Cancelled`: the person declined a prompt or pressed Ctrl-C at one (`CancelledError`). Nothing went wrong, so the terminal shows it dim with no next step; the message says what stayed as it was (default `Cancelled. Nothing changed.`). Exit code 1 for scripts.

**Fix:** none; nothing changed.

Source: `packages/cli/src/lib/errors.ts`

### UNEXPECTED

`ReportCode.Unexpected`: an error everyapp didn't raise on purpose, i.e. a bug. Message: `everyapp hit an unexpected error` / `<name>: <message>` / `This is a bug in everyapp, not something you did.` `data.stack` carries the stack (shown with `--verbose`).

**Fix:** without `--verbose`: `rerun`: this command with `--verbose`, `rerunNote`: `for a stack trace to report`. Not retryable.

Source: `packages/cli/src/lib/output/report.ts`

### NETWORK_ERROR

`ReportCode.Network`: the error (or its `cause`) has one of Node's network codes `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_SOCKET`, or is the `TypeError` `fetch failed`. Message: `The network failed (<code>)` / `<message>`, or `The network failed` / `fetch failed`.

**Fix:** `retryable: true`, `rerun`: this command.

Source: `packages/cli/src/lib/output/report.ts`

### SYSTEM_ERROR

`ReportCode.System`: a Node error with an uppercase system code (`/^[A-Z_]+$/`, e.g. `ENOENT`, `EACCES`) that isn't a network code; the message is the error's own.

**Fix:** none; not retryable.

Source: `packages/cli/src/lib/output/report.ts`

### CF_TIMEOUT

A `CfTimeoutError`: a `cf` call ran past its time limit and its process group was killed. The runner's default is 120 s for a call that isn't attached to the terminal (`DEFAULT_TIMEOUT_MS` in `packages/cli/src/lib/cf/runner.ts`; interactive calls have no limit unless the call sets one). Message: `` `<command>` did not finish within <seconds>s (last output: <last stderr line>)``.

**Fix:** `retryable: true`, `rerun`: this command.

Source: `packages/cli/src/lib/cf/errors.ts`, `packages/cli/src/lib/cf/runner.ts`

### CF_OUTPUT

A `CfOutputError`: cf exited 0 but printed something other than the JSON the CLI expected: `` Unexpected output from `<command>`: stdout is not JSON`` or the schema's validation message.

**Fix:** none; not retryable.

Source: `packages/cli/src/lib/cf/errors.ts`, `packages/cli/src/lib/cf/runner.ts`

### CF_AUTH

The `CfError` kinds below are `CF_<KIND>` in upper case; the message is cf's own, parsed from its error box on stderr (`┌ Error` or `┌ APIError` … `└`, wrapped lines rejoined) or else the last lines of its output, else `cf failed without an error message`. Cloudflare API codes are read from `[<code>]` or `[code: <code>]` in that message. The kind is decided in this order: `strict_conflict` (its regex over stdout and stderr together), then `d1_id_rejected`, `subdomain_missing`, `email_unverified`, `r2_not_enabled`, `free_plan`, `auth`, `already_exists`, `not_found`, else `unknown`. None is retryable, and the message is cf's own, except `email_unverified`, which `reportFailure` words itself and marks retryable (`CF_EMAIL_UNVERIFIED` below).

`auth`: API code `10000` (authentication error, also a token without the permission) or `9109` (not allowed to access the resource), or the text `No authentication token found`, `Not logged in` or `cf auth login`. A command logs in before its first cf call (`cf auth whoami`, then the login or the `cloudflare_login` action, [the protocol](/docs/agent/json)), the Access calls say this kind as `ACCESS_PERMISSION_MISSING` and the DNS read as `DNS_UNREADABLE` (both above); this code is what remains: a token that lacks a permission for a call mid-run.

**Fix:** none given; give the login or API token the permission cf names.

Source: `packages/cli/src/lib/cf/errors.ts`, `packages/cli/src/lib/output/report.ts`

### CF_NOT_FOUND

`not_found`: API code `10007` (Worker), `10009` (KV key), `7404` (D1 database) or `10200` (Workflow), or the text `not found` or `does not exist`. Most callers catch this kind themselves (`isCfError(error, "not_found")`); it is reported only where none did.

**Fix:** none; not retryable.

Source: `packages/cli/src/lib/cf/errors.ts`

### CF_ALREADY_EXISTS

`already_exists`: API code `7502` (D1) or `10014` (KV), or the text `already exists`: a second resource with the same name was refused. The deploy's resource creation turns this into `RESOURCE_NAME_TAKEN`; it is reported raw elsewhere.

**Fix:** none; not retryable.

Source: `packages/cli/src/lib/cf/errors.ts`

### CF_ABORTED

`aborted`: cf asks before anything destructive (`d1 delete`, `kv namespaces delete`, `workers delete`, `d1 time-travel restore`) unless it gets `--force`; with no terminal it answers no for itself, prints a line that is exactly `Aborted.` and exits 0. The runner makes that a failure: `` `<command>` asked for a confirmation no one could give, and did nothing (it printed "Aborted.").``

**Fix:** none; not retryable. everyapp passes `--force` where it has already asked.

Source: `packages/cli/src/lib/cf/errors.ts` (`abortedCfError`)

### CF_STRICT_CONFLICT

`strict_conflict`: cf's strict-mode abort at an upload (`Aborting the upload operation because of conflicts` on stdout or stderr): the Worker was changed in the dashboard or through the API and cf, run without a terminal, won't overwrite it. Every Worker upload goes through `cfDeploy` (`lib/cf/deploy.ts`): with a person at the terminal it runs cf again attached, so cf asks; piped, its `explainDeployFailure` turns this kind into the `rerun_interactive` action (`<worker> was changed outside everyapp; confirm in a terminal` / `It was last changed in the Cloudflare dashboard or through the API, so cf won't overwrite it unattended.`, `rerunNote`: `in a terminal, and confirm cf's prompt`, `data.needsTerminal: true`: hand the command to the person, never add `--json` back), and `assertReplaceable` raises the same action before the upload when the serving version isn't one everyapp recorded (`rerunNote`: `in a terminal`; `data.workerName`, `data.versionId` of the serving version, and `data.needsTerminal: true` again); so a run doesn't end with this code, and the kind is how the two recognize it.

**Fix:** none; not retryable.

Source: `packages/cli/src/lib/cf/errors.ts`, `packages/cli/src/lib/cf/deploy.ts`

### CF_SUBDOMAIN_MISSING

`subdomain_missing`: the text `workers.dev subdomain` or `/workers/onboarding`: the account has no workers.dev subdomain yet. `lib/cf/deploy.ts` turns it into the `register_workers_subdomain` action where it matters; the pattern is unverified against a live account (said so in the source).

**Fix:** none here; register the subdomain in the dashboard.

Source: `packages/cli/src/lib/cf/errors.ts`

### CF_FREE_PLAN

`free_plan`: the text `Workers Paid` or `paid plan` (case-insensitive). `reportFailure` checks this kind before anything else and emits the `upgrade_workers_paid` action instead (`Cloudflare refused, for the Free plan: <message>` / `Every App needs Workers Paid ($5 a month, then usage). Subscribe, then run this command again.`, `data.url`: `https://dash.cloudflare.com/?to=/:account/workers/plans`, `data.rerun`: this command), so a run never ends with `CF_FREE_PLAN`; the kind is how callers recognize it.

**Fix:** subscribe to Workers Paid, then run the command again.

Source: `packages/cli/src/lib/cf/errors.ts`, `packages/cli/src/lib/output/report.ts`

### CF_EMAIL_UNVERIFIED

`email_unverified`: API code `10034`: the Cloudflare account's email address isn't verified, which Cloudflare requires before anything is created. The one cf kind `reportFailure` (`knownFailure`) gives its own words: `Verify your Cloudflare account's email address first` / `Cloudflare refuses to create anything until the address on the account is verified. Open the message Cloudflare sent you, then run this command again.`; `data.url`: `https://dash.cloudflare.com/profile`, `data.cloudflare`: cf's message.

**Fix:** `retryable: true`, so `rerun` is this command; verify the address at `data.url` first.

Source: `packages/cli/src/lib/cf/errors.ts`, `packages/cli/src/lib/output/report.ts`

### CF_R2_NOT_ENABLED

`r2_not_enabled`: API code `10042`: R2 isn't enabled on the account, so an R2 bucket can't be created.

**Fix:** none given; enable R2 in the dashboard.

Source: `packages/cli/src/lib/cf/errors.ts`

### CF_D1_ID_REJECTED

`d1_id_rejected`: the text `Expected a D1 database ID`: cf was given a database name or binding where it wanted an id.

**Fix:** none; not retryable (a CLI bug if it happens).

Source: `packages/cli/src/lib/cf/errors.ts`

### CF_UNKNOWN

`unknown`: cf failed (non-zero exit) and no rule above matched. The message is cf's.

**Fix:** none; not retryable. Run with `--verbose` to see cf's output as it comes.

Source: `packages/cli/src/lib/cf/errors.ts`

## Argument errors (exit 251 and 252)

What stricli's router and parser refuse, reported as an `error` event through the run's sink (so `--json` gets NDJSON) with a code from `ArgumentErrorCode`, a headline, and in `data`: `didYouMean` (a close match: within two edits, case-insensitive), `usage` (`pnpm everyapp <command> <args> [flags]`), `help` (`pnpm everyapp <command> --help`) or `fix`. The exit code stays stricli's: 251 for a command it can't find, 252 for arguments. None has a rerun.

### UNKNOWN_COMMAND

Exit 251. `Unknown command <path> <input>`, then `<path> has <commands>.` when the unknown name is inside a group that has commands (`pnpm everyapp secret foo`), never at the top level. `data.didYouMean`: `pnpm everyapp <path> <match>` when a visible command is close; `data.help`: `pnpm everyapp <path> --help`.

**Fix:** run the suggested command or the help.

Source: `packages/cli/src/argumentErrors.ts`

### UNKNOWN_FLAG

Exit 252. `Unknown flag --<flag> for <command>` (or `-<alias>`). `data.didYouMean`: `--<match>` among the command's flags (kebab-cased); `data.help`.

**Fix:** use the suggested flag or read the help.

Source: `packages/cli/src/argumentErrors.ts`

### INVALID_VALUE

Exit 252. One of: an enum flag, `--<flag> can't be "<input>"` / `Use one of: <values>.` with `data.didYouMean`; a boolean flag given a value, `--<flag> is a switch and takes no value (got "<input>")` with `data.fix`: `use --<flag> or --no-<flag>`; a flag whose parser refused the value, `--<flag> can't be "<input>"` / `<reason>` (or `<reason>, not <input>` when the reason already names the flag); a positional argument that failed to parse, `"<input>" won't do for <placeholder>` / `<reason>` with `data.usage`; `--no-<flag> is a switch and takes no value (got "<value>")`.

**Fix:** as the message says.

Source: `packages/cli/src/argumentErrors.ts`

### MISSING_ARGUMENT

Exit 252. A required positional is missing: `Missing the <argument>` (named by the parameter's brief when it is 30 characters or shorter, else its placeholder), or for a list parameter `Name at least one <brief>`. `data.usage`.

**Fix:** pass the argument.

Source: `packages/cli/src/argumentErrors.ts`

### MISSING_FLAG_VALUE

Exit 252. `--<flag> needs a value`. `data.usage`.

**Fix:** give the flag a value.

Source: `packages/cli/src/argumentErrors.ts`

### TOO_MANY_ARGUMENTS

Exit 252. `<command> takes no arguments|one argument|<n> arguments, but got another: "<input>"`. `data.usage`.

**Fix:** drop the extra argument.

Source: `packages/cli/src/argumentErrors.ts`

### REPEATED_FLAG

Exit 252. `--<flag> is given more than once`. `data.help`.

**Fix:** give it once.

Source: `packages/cli/src/argumentErrors.ts`

### COMMAND_FAILED

Exit 252 from the argument parser: any other exception stricli raised while routing or parsing, with its own message and `data.help`. The same code is also `runLogged`'s default (`lib/childLog.ts`, see [Codes raised with a dynamic value](#codes-raised-with-a-dynamic-value)); every current caller passes its own code, so from a child process it is not seen.

**Fix:** read the help.

Source: `packages/cli/src/argumentErrors.ts`, `packages/cli/src/lib/childLog.ts`

## Codes the Gateway's deploy API and the browser install answer

The Gateway's deploy API (`apps/every-app-gateway/src/server/deploy/routes.ts`: `GET /api/v1/deploy-key`, `POST /api/v1/orgs/{orgId}/apps`, `POST /api/v1/orgs/{orgId}/apps/{appId}/deploys` and `GET /api/v1/orgs/{orgId}/deploys/{id}`, called with a deploy key as `authorization: Bearer <token>`) and the browser install (Admin → Apps → Install app: `POST /api/admin/apps/install`, `GET /api/admin/deploys/{id}`, with a session) raise the codes in this section. No everyapp command calls either, so none of them arrives on an `error` event. Each route answers a refusal as JSON `{ "error": "<code>", "message": "<sentence>" }` with the code's HTTP status (`DeployError` in `apps/every-app-gateway/src/server/deploy/errors.ts`; anything else thrown is `INTERNAL_ERROR`, 500).

A deploy runs as a job (`{ id, status: "running" | "succeeded" | "failed", error: { code, message } | null, app }`): the POST answers once it finished or after 20 s (`INLINE_WAIT_MS` in `run.ts`), and `GET /api/v1/orgs/{orgId}/deploys/{id}` reads it after that. A job that ends `failed` carries its code in `error.code`. The browser install deploys through the same pipeline and answers the same codes. On a self-hosted Gateway the browser install deploys with the Cloudflare REST API (`cfRestDeployer.ts` with no dispatch namespace); the codes below marked "self-hosted browser install" come from there.

### BUNDLE_REFUSED

Status 422. `The app can't be deployed as a third-party app:` followed by every problem as a ` -` line. The manifest is checked at registration (`manifestProblems`), the Build Output before the job starts and again before the upload (`bundleProblems`), and the pipeline adds its own. What is refused:

- Manifest (`manifestProblems`, `apps/every-app-gateway/src/server/deploy/metadata.ts`): helper Workers (`workers`); Workflows; KV namespaces (`use D1`); R2 or Hyperdrive (`which the browser deployer can't provision; use the CLI`); migrations with a `dialect` other than `sqlite` or an `engine` other than `drizzle` (`browser installs support D1 SQL migrations only`); `secrets`; `email.inbound`; a Durable Object class that names a helper Worker; more Durable Object classes than the policy's limit (`thirdPartyLimits.durableObjectClasses`; 2 for self-hosted browser installs).
- Worker config (`bundleProblems`): a Worker name other than the tenant-neutral build's sentinel (`a deploy through the gateway uploads the tenant-neutral build, uninstalled (everyapp deploy --gateway)`); any `worker.config.json` key outside `name`, `compatibilityDate`, `compatibilityFlags`, `workersDev`, `previewUrls`, `observability`, `env`, `exports`, `manifest`, `assets`, `triggers`; `workersDev` or `previewUrls` not `false`; any `triggers`; no compatibility date; compatibility flags that aren't a list (`its compatibility flags aren't a list`); a compatibility flag outside `nodejs_compat`, `nodejs_compat_v2`, `nodejs_als`, `global_fetch_strictly_public`; no main module; `assets` keys outside `htmlHandling`, `notFoundHandling`, `runWorkerFirst`; `EVERYAPP_DEV` set.
- Bindings: the platform's text bindings (`EVERYAPP_APP_ID`, `EVERYAPP_AUDIENCE`, `EVERYAPP_IDENTITY_PUBLIC_KEYS`, `EVERYAPP_IDENTITY_ISSUER`) not of type `text`, or `EVERYAPP_APP_ID` not the manifest's id; `GATEWAY_URL` and `EVERY_APP_ORG_ID` not declared as `secret`; a `worker` binding other than `EVERY_APP_GATEWAY` to `every-app-gateway`'s `AppGateway` export; a `d1` binding the manifest doesn't declare; a `durable-object` binding to another Worker or to an undeclared class; an `assets` binding with no assets uploaded; any `secret`. A `version-metadata` binding (`CF_VERSION_METADATA`) is accepted; any other binding type (service bindings other than the Gateway's, dispatch namespaces, KV, R2, Hyperdrive, rate limits, secrets store, mTLS, Workers AI, email, queues, variables) is refused. Exports that aren't `worker` or a declared Durable Object class, or whose `state` isn't `created`.
- Pipeline (`pipeline.ts`): no ES module at the Worker's main module; `migrations.binding` not one of its D1 databases; dropping a Durable Object class the live Worker has (`which deletes its data; third-party deploys never do`); a live migration tag the deployer didn't write (not `everyapp-v<n>`). A GitHub or oss.new release whose Build Output has helper Workers (`release.ts`).
- Self-host, same intent: `manifestTierProblems` (`TIER_POLICY` above) refuses Hyperdrive, R2, `email.inbound` and `secrets` on tier `dispatch`.

**Fix:** change `everyapp.config.ts` or the build so the bundle has none of these; not retryable.

Source: `apps/every-app-gateway/src/server/deploy/errors.ts`, `apps/every-app-gateway/src/server/deploy/metadata.ts`, `apps/every-app-gateway/src/server/deploy/pipeline.ts`, `apps/every-app-gateway/src/server/deploy/release.ts`, `packages/perimeter/src/manifest/manifest.ts`

### BINDINGS_MISMATCH

Status 502, a job error. After the upload the pipeline reads the Worker's bindings back; any difference from what it sent (names, each field, a Durable Object class on another Worker) deletes the Worker: `Cloudflare lists other bindings for <worker> than the deployer sent (<names>), so the Worker was deleted. Deploy again; if it happens again, the gateway's operators need to look.`

On a self-hosted browser install (`cfRestDeployer.ts`) the same code, also 502, means the read-back itself failed, and nothing is deleted: `Cloudflare did not return the Worker's bindings.` (the Worker's settings came back without a bindings list) or `Cloudflare did not retain the app's Gateway binding. Try again.` (the Gateway's `APP__<worker>` service binding wasn't there after the publish).

**Fix:** deploy again.

Source: `apps/every-app-gateway/src/server/deploy/pipeline.ts`, `apps/every-app-gateway/src/server/deploy/cfRestDeployer.ts`

### DEPLOY_FAILED

A job that failed with an error the deployer didn't name (not a `DeployError`): `The deploy failed in the gateway. Deploy again.`

`DEPLOY_ABANDONED` is the job's `error.code` when it is read, not stored: a job still `running` 5 minutes after it was created (`DEPLOY_JOB_DEADLINE_MS` in `apps/every-app-gateway/src/server/repositories/DeployJobRepository.ts`) is answered as `failed` with `The deploy stopped without finishing: the gateway gives a deploy about 50 seconds, and a large app (many assets, slow migrations) can run out of them. Deploy again.` A job whose outcome couldn't be recorded ends this way too.

**Fix:** deploy again.

Source: `apps/every-app-gateway/src/server/deploy/run.ts`, `apps/every-app-gateway/src/server/repositories/DeployJobRepository.ts`

### INVALID_REPO_URL

Status 400, browser install only (`POST /api/admin/apps/install` with `repoUrl`): the value isn't `https://github.com/<owner>/<repo>` (an optional `.git` and trailing `/` are accepted): `Paste a GitHub repository URL: https://github.com/<owner>/<repo>.`

**Fix:** paste the repository's URL.

Source: `apps/every-app-gateway/src/server/deploy/release.ts`, `apps/every-app-gateway/src/server/deploy/install.ts`

### APP_INSTALL_FORBIDDEN

Status 403, browser install: the session's live role in the chosen organization isn't `owner` or `admin`: `Only the organization's owners and admins install apps.`

**Fix:** ask an owner or admin.

Source: `apps/every-app-gateway/src/server/deploy/install.ts`

### APP_INSTALL_NOT_AVAILABLE

Status 404, browser install: neither the hosted launch gate (`THIRD_PARTY_DEPLOYS` exactly `on`) nor self-hosted installs (`GATEWAY_DEPLOYMENT_MODE` `self_hosted`, `BROWSER_APP_INSTALLS` not `off`, `CF_DEPLOY_TOKEN` set, a 32-hex `CLOUDFLARE_ACCOUNT_ID`, `APP_BASE_DOMAIN` set) are on: `Browser installation is not enabled on this Gateway. Its owner can configure the browser deployer, or deploy with the everyapp CLI.`

**Fix:** configure the browser deployer (`setup` offers it), or deploy with the CLI.

Source: `apps/every-app-gateway/src/server/deploy/install.ts`, `apps/every-app-gateway/src/server/deploy/browser-install.ts`

### DEPLOYER_NOT_CONFIGURED

Status 503 (502 for a Cloudflare answer the deployer can't use): the Gateway lacks what deploying needs. Messages: `This gateway has no GATEWAY_URL or JWT_PUBLIC_KEY to give apps.`; `This gateway's deployer isn't configured (CF_DEPLOY_TOKEN, CLOUDFLARE_ACCOUNT_ID and DISPATCH_NAMESPACE).` (hosted) or `Set CF_DEPLOY_TOKEN and CLOUDFLARE_ACCOUNT_ID on the Gateway.` (self-hosted); `THIRD_PARTY_DOMAIN (<domain>) overlaps the gateway's own domain (<base>); third-party apps need a registrable domain of their own.`; `Set APP_BASE_DOMAIN before installing apps.`; `The Gateway's CLI install record is missing. Finish Gateway setup before installing apps.`; and on a self-hosted install's publish: `A self-hosted app needs its Worker and hostname.`, `App hosts must be below this Gateway's hostname.`, `This account has no Custom Domain for the Gateway.`, `Cloudflare did not return one serving version for <worker>. Reconcile it with the CLI.` (502), `Cloudflare did not return the Gateway's bindings. Nothing was replaced.` (502).

**Fix:** the Gateway's operator sets the named setting.

Source: `apps/every-app-gateway/src/server/deploy/run.ts`, `apps/every-app-gateway/src/server/deploy/cfRestDeployer.ts`, `apps/every-app-gateway/src/server/deploy/registry.ts`, `apps/every-app-gateway/src/server/deploy/browser-install.ts`

### DEPLOY_FORBIDDEN

Status 403: the deploy key's owner is a member of its organization but not `owner` or `admin`: `Only the organization's owners and admins deploy apps.`

**Fix:** use a deploy key of an owner or admin.

Source: `apps/every-app-gateway/src/server/deploy/auth.ts`

### DEPLOY_IN_PROGRESS

Status 409: another job of the same app is running (and not past its deadline): `Another deploy of <app> is running; wait for it, then deploy again.`; or, for a self-hosted browser install, the install lease `app:<worker>` (shared with the CLI's lease table) is held: `Another install or CLI operation is running. Try again when it finishes.`

**Fix:** wait, then deploy again.

Source: `apps/every-app-gateway/src/server/deploy/run.ts`, `apps/every-app-gateway/src/server/deploy/browser-install.ts`

### DEPLOY_KEY_APP_MISMATCH

Status 403: the deploy key is bound to one app (`appRowId`) and the registration or deploy names another: `This deploy key is bound to another app.`

**Fix:** use a deploy key bound to this app, or to none.

Source: `apps/every-app-gateway/src/server/deploy/routes.ts`

### DEPLOY_SCOPE_REQUIRED

Status 403: the bearer token is a valid personal access token but its scopes aren't exactly `["deploy"]` (`*` doesn't count): `This token isn't a deploy key. Create one in Admin → Tokens (Deploy key).`

**Fix:** create a deploy key (Admin → Tokens) and send that.

Source: `apps/every-app-gateway/src/server/deploy/auth.ts`

### INTERNAL_ERROR

Status 500: the route threw something other than a `DeployError`: `The deploy API failed.` (deploy API) or `The install failed.` (browser install). Also a `PublicError` code on the control plane.

**Fix:** try again.

Source: `apps/every-app-gateway/src/server/deploy/routes.ts`, `apps/every-app-gateway/src/server/deploy/install.ts`, `apps/every-app-gateway/src/server/errors.ts`

### ORGANIZATION_SUSPENDED

Status 403: the deploy key's organization, or the browser install's, isn't active: `The organization is suspended.` Also a `GatewayError` code on the control plane (`This organization is suspended.`).

**Fix:** none for the caller.

Source: `apps/every-app-gateway/src/server/deploy/auth.ts`, `apps/every-app-gateway/src/server/deploy/install.ts`, `apps/every-app-gateway/src/middleware/auth.ts`

### PROTOCOL_TOO_OLD

Status 426: the upload's stamp carries a `protocol` below `MIN_HOSTED_DEPLOY_PROTOCOL` (1; a browser install stamps the release it fetched with `HOSTED_DEPLOY_PROTOCOL`, 1, in `release.ts`): `This CLI packages deploy protocol <n>; the gateway reads <min> or later. Update everyapp and deploy again.`

**Fix:** update everyapp (`git pull` in the checkout), deploy again.

Source: `apps/every-app-gateway/src/server/deploy/bundle.ts`, `apps/every-app-gateway/src/server/deploy/release.ts`, `packages/perimeter/src/manifest/deploy.ts`

### HTTP_nnn

The pattern `HTTP_<status>` (`HTTP_502` from a proxy) is what a client gives a deploy API answer that has no JSON `error` in it. Every refusal of the deploy API and the browser install carries one (`DeployError`, the codes in this section), and no everyapp command reads the API's answers, so no everyapp command ends with a code of this pattern.

**Fix:** none.

Source: `apps/every-app-gateway/src/server/deploy/errors.ts`

### DEPLOY_KEY_REQUIRED

Status 401: no bearer token: `Send a deploy key as the bearer token (EVERYAPP_DEPLOY_TOKEN).`

**Fix:** send a deploy key as the bearer token.

Source: `apps/every-app-gateway/src/server/deploy/auth.ts`

### DEPLOY_KEY_INVALID

Status 401: `The deploy key is unknown, revoked or expired. Create one in Admin → Tokens (Deploy key).`

**Fix:** create a new key (Admin → Tokens).

Source: `apps/every-app-gateway/src/server/deploy/auth.ts`

### NOT_A_MEMBER

Status 401: `The deploy key's owner is no longer a member of its organization, or is deactivated.`

**Fix:** use a key of a current member.

Source: `apps/every-app-gateway/src/server/deploy/auth.ts`

### UNAUTHORIZED

Status 401, browser install: no session or a banned user (`Sign in again.`), or no membership in the chosen organization (`Organization membership required.`).

**Fix:** sign in; join the organization.

Source: `apps/every-app-gateway/src/server/deploy/install.ts`

### NOT_FOUND

Status 404: `No such deploy API route.`, also answered when the path's `orgId` isn't the key's organization.

**Fix:** none; a path whose `orgId` isn't the key's organization is a key of another organization.

Source: `apps/every-app-gateway/src/server/deploy/routes.ts`

### INVALID_REQUEST

Status 400: the body isn't what the route takes. Deploy API: `Send JSON: { appId, manifest }.`, `appId is required.`; browser install: `Send JSON with one repoUrl or releaseUrl.`, `Send one repoUrl or releaseUrl.`, `Choose a valid workspace.`

**Fix:** send the body the route asks for.

Source: `apps/every-app-gateway/src/server/deploy/routes.ts`, `apps/every-app-gateway/src/server/deploy/install.ts`

### INVALID_BUNDLE

Status 400: the multipart upload is malformed: not `multipart/form-data`, a missing or oversized (1 MB) JSON part, a stamp without `protocol` or `cliVersion`, a module, asset or migration path with empty, `.`, `..`, backslash or control-character segments, or an asset path not starting with `/`.

**Fix:** none for the caller; not retryable.

Source: `apps/every-app-gateway/src/server/deploy/bundle.ts`

### BUNDLE_TOO_LARGE

Status 413: `The upload is <n> bytes; the deploy API takes at most <max>.` (from `content-length`) or `The upload holds more than <files> files or <max> bytes.` while reading: more than 64 MB or 10,000 files.

**Fix:** shrink the Build Output (assets, modules).

Source: `apps/every-app-gateway/src/server/deploy/bundle.ts`

### DEPLOY_NOT_FOUND

Status 404: `No such deploy.`: `GET /api/v1/orgs/{orgId}/deploys/{id}` with a job id the organization doesn't have.

**Fix:** none; poll the id the POST answered with.

Source: `apps/every-app-gateway/src/server/deploy/run.ts`

### WORKER_OWNED

Status 409. From the Gateway's resource ledger (`ledger.ts`): the Worker isn't recorded as this app's (`This Worker is not recorded as this app's. Use the CLI to reconcile it.`) or its ownership claim is missing (`The Worker's ownership claim is missing. Use the CLI to reconcile it.`). From a self-hosted browser install (`cfRestDeployer.ts`), before anything is uploaded: Cloudflare's Worker list doesn't include the existing Worker (`Cloudflare did not list the existing Worker's ownership. Nothing was uploaded.`), or it lacks the `org-<organization id>` and `app-<app slug>` tags the installer writes (`A Worker with this name already exists outside this browser installer. Use the CLI to manage it.`).

**Fix:** reconcile or manage the Worker with the CLI (`pnpm everyapp deploy` from the app's directory).

Source: `apps/every-app-gateway/src/server/deploy/ledger.ts`, `apps/every-app-gateway/src/server/deploy/cfRestDeployer.ts`

### APP_ALREADY_INSTALLED

Status 409, self-hosted browser install only (`cfRestDeployer.ts`, when the pipeline asks for the app Worker's migration tag): the app's row is already `active` or `disabled`: `This app is already installed. Open it from your Gateway; use the CLI to update it.` The browser installer installs; updates are the CLI's.

**Fix:** `pnpm everyapp deploy` from the app's directory.

Source: `apps/every-app-gateway/src/server/deploy/cfRestDeployer.ts`

### WORKER_CHANGED

Status 409, self-hosted browser install only: the Worker exists with the installer's tags, but the version serving traffic is neither the one the browser ledger recorded (`claimBrowserWorker`) nor the row's `versionId`: `This Worker changed outside the browser installer. Use the CLI to reconcile it.`

**Fix:** `pnpm everyapp deploy` from the app's directory.

Source: `apps/every-app-gateway/src/server/deploy/cfRestDeployer.ts`

### BINDING_OWNED

Status 409, self-hosted browser install only, at the publish: the Gateway Worker already has a binding named `APP__<worker>` that isn't a service binding to that Worker's default entrypoint: `The Gateway already uses this app binding for something else.`

**Fix:** none in the browser; `pnpm everyapp setup` rebinds the Gateway from the registry.

Source: `apps/every-app-gateway/src/server/deploy/cfRestDeployer.ts`

### ORGANIZATION_NOT_FOUND

Status 404: `No such organization.`: the registry went to claim the organization's key for a registration and the organization row is gone.

**Fix:** none for the caller.

Source: `apps/every-app-gateway/src/server/deploy/registry.ts`

### INVALID_RELEASE_URL

Status 400, browser install: `releaseUrl` isn't `https://oss.new/apps/<key>`: `Use an oss.new release URL: https://oss.new/apps/<key>.`

**Fix:** paste the release's oss.new URL.

Source: `apps/every-app-gateway/src/server/deploy/release.ts`

### RELEASE_FETCH_FAILED

Status 502, browser install: GitHub or oss.new unreachable, redirected off https, too many redirects, or a non-2xx answer; the message says which.

**Fix:** try again; check the repository's latest release has `everyapp-release.tar.gz`.

Source: `apps/every-app-gateway/src/server/deploy/release.ts`

`POST /api/setup/claim` (the one-time owner claim from the Gateway's `/setup` page, `apps/every-app-gateway/src/routes/api/setup/claim.ts`) is not a deploy API route and the CLI never calls it. Its refusals are `UNSUPPORTED_MEDIA_TYPE` (415: the `content-type` isn't `application/json`), `ORIGIN_NOT_ALLOWED` (403: the request's `origin` header isn't the Gateway's own origin, `GATEWAY_URL`'s else the request URL's; the route is for the Gateway's `/setup` page only, and the code is also a `GatewayError` in `apps/every-app-gateway/src/server/errors.ts`) and `INVALID_INPUT` (400: a body that isn't JSON or fails its schema, `message` the first issue; also the `PublicError` the control plane's request validation throws, `apps/every-app-gateway/src/middleware/publicError.ts`).

The other codes these routes answer are documented where the same code is raised elsewhere:

| Code                  | Status  | When                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_NOT_REGISTERED`  | 404/409 | Deploying an app id that isn't registered (or is deleted) for the organization; a job for an app row with no Worker name (409). Below, under [Codes raised with a dynamic value](#codes-raised-with-a-dynamic-value).                                                                                                                                                                                                              |
| `MIGRATION_FAILED`    | 422     | Job: a migration's statements failed: `Migration <name> failed: <error>. Nothing was uploaded; the version that is serving keeps running.` Documented above.                                                                                                                                                                                                                                                                       |
| `APP_NOT_FOUND`       | 404     | Job: the app's registry row is gone; also a registry refusal for a deleted app. Documented above.                                                                                                                                                                                                                                                                                                                                  |
| `APP_CHANGING`        | 409     | Job: the registry row changed while the deploy recorded its upload; self-hosted browser install: the row changed before the lease was taken. Documented above.                                                                                                                                                                                                                                                                     |
| `RESOURCE_OWNED`      | 409     | Ledger: the D1 database's name is recorded as another app's. Documented above.                                                                                                                                                                                                                                                                                                                                                     |
| `RESOURCE_REPLACED`   | 409     | Ledger: the recorded database was deleted and another created under its name. Documented above.                                                                                                                                                                                                                                                                                                                                    |
| `LEASE_LOST`          | 409     | Self-hosted browser install: the install lease couldn't be renewed. Documented above.                                                                                                                                                                                                                                                                                                                                              |
| `ORG_KEY_UNAVAILABLE` | 409     | Every candidate key for the organization's slug is taken. Below.                                                                                                                                                                                                                                                                                                                                                                   |
| `RELEASE_INVALID`     | 422     | Browser install: the archive isn't gzip or tar, has entries beyond `.cloudflare`, `migrations` and `release.json`, or `release.json` / `worker.config.json` is missing or malformed. The CLI's own code of the same name is above.                                                                                                                                                                                                 |
| `RELEASE_UNSUPPORTED` | 422     | Browser install: `release.json` `schema` isn't 1, `kind` isn't `app`, or `buildOutputVersion` isn't `v0`. Documented above.                                                                                                                                                                                                                                                                                                        |
| `RELEASE_TOO_LARGE`   | 413     | Browser install: over 100 MB compressed or unpacked. Documented above.                                                                                                                                                                                                                                                                                                                                                             |
| `NO_RELEASE`          | 404     | Browser install: the repository's latest release has no `everyapp-release.tar.gz`. Documented above.                                                                                                                                                                                                                                                                                                                               |
| Registry rules        | 400–409 | `RegistrationError` codes (`packages/perimeter/src/registry/registration.ts`) pass through unchanged: `INVALID_APP_HOSTNAME`, `RESERVED_APP_ID`, `INVALID_APP_ID`, `INVALID_WORKER_NAME`, `INVALID_MANIFEST`, `RESOURCE_NAME_CONFLICT` (400); `SHARED_APP_NOT_PLATFORM` (403); `APP_SCOPE_MISMATCH`, `HOSTNAME_TAKEN`, `WORKER_NAME_TAKEN` (409); `APP_TIER_MISMATCH` (400 or 409); `PROVIDER_APP_UNKNOWN` (400, from `provider on | off`). Each except `INVALID_APP_ID`, `INVALID_MANIFEST`and`WORKER_NAME_TAKEN` (documented above) is described under [Codes raised with a dynamic value](#codes-raised-with-a-dynamic-value). |

## Warnings

A `warning` event (`{ type: "warning", code, message, step?, data? }`) is something a run went on past. The terminal shows it as a `!` headline with the message's further lines dim and, from `data`, `rerun` (with `rerunNote`), `fix` or `url` after it; `--json` gets the event as is. `QUIET_WARNINGS` in `packages/cli/src/lib/output/events.ts` names the ones the terminal renderer skips without `--verbose`: only `CUSTOM_DOMAIN_OWNER_UNCHECKED`. The `ACCESS_*` warnings come from `access on` (`packages/cli/src/commands/access/index.ts`) and from the Access sync `deploy` and `delete` run afterwards (`syncAppsAccessAfter` in `packages/cli/src/lib/access/sync.ts`), except `ACCESS_IN_FRONT`, which the live wait and `setup` emit; the command is documented at [/docs/agent/access](/docs/agent/access), and the agent-driven Access setup step by step in `packages/cli/skills/everyapp/setup/access.md` (in an app `.claude/skills/everyapp/setup/access.md`).

### ACCESS_APP_OUTSIDE_BASE

Step `access.routes` (`access on`; the sync after `deploy` and `delete`): an app whose hostname isn't under the apps' domain gets no Access destination: `<apps> isn't|aren't under the apps' domain, so Access isn't set up for it|them.` `data.apps` (the app ids). Nothing to do short of giving the app a host under the base domain.

Source: `packages/cli/src/lib/access/sync.ts` (`emitPlanWarnings`), `packages/cli/src/lib/access/plan.ts`

### ACCESS_EMAIL_NOT_INVITED

`access on --email …`, step `access.update`: an address that has no account on this Gateway (neither a member nor invited): `<emails> has|have no account on this Gateway` / `Access will let them through, but the Gateway refuses anyone it doesn't know. Invite them in Manage workspace → Users.` `data.emails`.

Source: `packages/cli/src/commands/access/index.ts`

### ACCESS_FOREIGN_DESTINATION

Step `access.routes`: an Access application everyapp manages also covers destinations that aren't Every App's; they are kept: `The Access application "<name>" also covers <uris>` / `That destination isn't Every App's and stays as it is. access off won't delete this application.` (several: `Those <n> destinations aren't Every App's and stay as they are. …`). `data.application` (its name, else id), `data.uris`.

Source: `packages/cli/src/lib/access/sync.ts`, `packages/cli/src/commands/access/index.ts`

### ACCESS_IDP_UNVERIFIED_EMAILS

`access on`, step `access.update`: a sign-in method among the policy's identity providers is of a type that doesn't verify the address (`UNVERIFIED_EMAIL_IDP_TYPES`): `<name> (<type>) is a generic provider` (or `… are generic providers`) / `The Gateway signs people in as the email Access asserts. A provider that lets people choose their own address would let them choose someone else's; keep only providers that verify addresses (runbook: "Verified emails").` `data.providers`: `[{ id, type, name }]`.

Source: `packages/cli/src/commands/access/index.ts`

### ACCESS_INLINE_POLICIES

`access on`, step `access.update`: the existing Access application has policies of its own (`reusable: false`), so the reusable policy `Every App gateway members` can't be attached and the application is left as it is (outcome `skipped`): `The Access application "<name>" has a policy|policies of its own: <names>` / `It is left as it is: Access takes either application policies or reusable ones, not both, so the policy "Every App gateway members" can't be attached and its paths aren't managed here. Make its policies reusable in the dashboard, or manage it there.` `data.application` (its id), `data.policies` (their ids).

Source: `packages/cli/src/commands/access/index.ts`

### ACCESS_IN_FRONT

The probe of `https://<hostname>/` got a 3xx redirect to Cloudflare Access's login (a `location` matching `cloudflareaccess.com` or `/cdn-cgi/access/`). From `deploy`, step `app.live`: `Cloudflare Access answers before the Gateway, so this run can't confirm <app> is live` / `It goes live on its first visit, once someone signs in through Access.`, `data.hostname`; the wait ends with outcome `first_visit`. From `setup`, step `setup.owner`, before the owner link is printed: `Cloudflare Access protects <host>` / `Whoever opens the setup link signs in to Access first.` Nothing to do.

Source: `packages/cli/src/commands/deploy/steps/waitForLive.ts`, `packages/cli/src/commands/setup/runSetup.ts`, `packages/cli/src/lib/domains/https.ts`

### ACCESS_NOT_CHECKED

After `deploy` and `delete`, step `app.access` (`syncAppsAccessAfter`): the Access applications couldn't be listed, so whether the Gateway is behind Access, and whether the app's public routes are let through, wasn't checked. A login without the Access permissions (`ACCESS_PERMISSION_MISSING` above) says so only when the app has public routes: `This Cloudflare login can't read Cloudflare Access, so <app> wasn't checked against it`; any other failure: `Couldn't check Cloudflare Access for <app>` / `<first line of the error>`; then `If the Gateway is behind Access, <app>'s public routes need a login there until it is updated.` (on `delete`: `If the Gateway is behind Access, <app>'s host stays listed there until it is updated.`). `data.appId`, `data.rerun`: `pnpm everyapp access on`, `data.rerunNote`: `with a login that can manage Access, if the Gateway is behind it` or `if the Gateway is behind Access`.

Source: `packages/cli/src/lib/access/sync.ts`

### ACCESS_ONE_APPLICATION

`access on`, step `access.update`: one Access application covers both the Gateway host and `*.<base>`: `One Access application covers <gateway host> and *.<base>` / `It is kept and updated. The runbook recommends two, so an app host's Access cookie is never a Gateway login.` No data.

Source: `packages/cli/src/commands/access/index.ts`

### ACCESS_ROUTE_NOT_EXPRESSIBLE

Step `access.routes` (`access on`; the sync after `deploy` and `delete`): a public route with no Access path equivalent stays behind Access: `A public route stays behind Access: <app> <path>` (or `<n> public routes stay behind Access: …`) / `Access path patterns take one * per segment, so these have no equivalent. People signed in to Access still reach them.` `data.routes`: `[{ appId, path, reason: "not_expressible" }]`.

Source: `packages/cli/src/lib/access/sync.ts`, `packages/cli/src/lib/access/plan.ts`

### ACCESS_SYNC_FAILED

Step `app.access` after `deploy` and `delete`: the Access applications were listed and the apps application exists, but updating it failed; the run doesn't fail for it: `Couldn't update Cloudflare Access for <app>'s public routes` / `<first line of the error>` / `Until it is updated, they need an Access login.` (on `delete`: `<app>'s host stays listed there until it is updated.`). `data.appId`, `data.rerun`: `pnpm everyapp access on`.

Source: `packages/cli/src/lib/access/sync.ts`

### ACCESS_TOO_MANY_PUBLIC_ROUTES

Step `access.routes`: more public paths on one host than Access takes; the rest stay behind Access: `A public route stays behind Access: <app> <path>` (or `<n> public routes stay behind Access: …`) / `Access lets through at most 25 paths per host, two of them for MCP. Merge routes under one prefix, or keep these behind the login.` `data.routes`: `[{ appId, path, reason: "too_many" }]`.

Source: `packages/cli/src/lib/access/sync.ts`, `packages/cli/src/lib/access/plan.ts`

### APP_DISABLED

`deploy`, step `app.live`: `<app> is switched off in Admin → Apps`; the Gateway serves it once an admin turns it on. The wait ends with outcome `disabled`.

Source: `packages/cli/src/commands/deploy/steps/waitForLive.ts`

### APP_HOST_OUTSIDE_BASE

`deploy`, step `app.domain`, and the Gateway rebind: the app's hostname isn't one label below the Gateway's app base domain, so it is never published and the app can't be reached. `data.hosts` on the rebind.

Source: `packages/cli/src/commands/deploy/deployApp.ts`, `packages/cli/src/lib/gateway/apply.ts`

### APP_NEEDS_SETUP

`deploy`, after the upload: the app's manifest declares a required provider, capability or secret that isn't set (the settings model, [`/docs/agent/manifest`](/docs/agent/manifest#required-optional-or-one-of-a-group)), so the Gateway won't open it: `<app> won't open until <names> is set` (or `are set`), the second line the first unmet setting's `why`. The one command that opens it is the `done` event's `next` entry (`pnpm everyapp secret set <names> [--app <id>]`), not `data.rerun`. `data.unmet`: the unmet settings' ids.

Source: `packages/cli/src/commands/deploy/deployApp.ts`

### APP_NOT_BOUND

The Gateway rebind (any command that redeploys the Gateway: `setup`, and `deploy`/`delete` when they rebind), for each registered app whose Worker exists but isn't the one everyapp registered (`desired.skipped`): `Skipping <app>: its Worker isn't the one everyapp registered` / `So the Gateway won't route to it.` `data.appId`, `data.workerName`, `data.fix`: `deploy <app> again, or remove it with pnpm everyapp delete <app>`. `status` reports the same as the fix `APP_NOT_BOUND (status)` below.

Source: `packages/cli/src/lib/gateway/apply.ts`

### CERT_CLEANUP_FAILED

`delete`, step `app.certificate`: the deleted app's hostname's certificate packs couldn't be deleted: `Couldn't remove <hostname>'s certificate` / `It serves nothing now. Cloudflare said: <error>.` / `Optional: delete it in the Cloudflare dashboard (SSL/TLS → Edge Certificates).` The app is deleted either way.

Source: `packages/cli/src/lib/domains/certificates.ts`, `packages/cli/src/commands/delete/index.ts`

### CERT_PENDING

Two sites. `deploy`, step `app.live`, when nothing answered over HTTPS within the wait: `No certificate for <hostname> after <elapsed>` / `It usually comes within 5 minutes; <app> goes live on its first visit once it has one.`, `data.hostname`, `data.fix`: `if it never comes, check the zone's CAA records allow Cloudflare's certificate authorities`; outcome `first_visit`. `setup` and the Gateway deploy (`waitForCertificates`), for the Gateway's hostnames still without one: `https://<host>, … has|have no certificate after <elapsed>. It usually comes within five minutes; the gateway serves it|them as soon as it does. If it never comes, check the zone's CAA records allow Cloudflare's certificate authorities. Check later with `pnpm everyapp status`.`, `data.hosts`. `status` shows the same as `CERT_PENDING (status)` below.

Source: `packages/cli/src/commands/deploy/steps/waitForLive.ts`, `packages/cli/src/lib/domains/certWait.ts`

### CF_VERSION_DIFFERS

`dev`: the app's own `cf` version isn't the one everyapp is tested with; `data.version` (the app's), `data.tested`. Informational.

Source: `packages/cli/src/commands/dev/index.ts`

### CUSTOM_DOMAIN_OWNER_UNCHECKED

`preflightDomains`, when cf isn't attached to a person's terminal (not interactive, or without `--verbose`): the check reads which Worker holds a Custom Domain only for a hostname with a DNS record in the way, and publishing moves a hostname another Worker serves without asking. `If another Worker already serves <host>, it will be replaced by this deployment.` (or `any of <hosts>`), `data.hosts`: the new hostnames, less any found to be the Gateway's own Custom Domain already. Quiet without `--verbose` (`QUIET_WARNINGS`): nothing can be done about it in advance; attached with `--verbose`, cf asks before moving one.

Source: `packages/cli/src/lib/domains/preflight.ts`, `packages/cli/src/lib/output/events.ts`

### DEV_EXPOSED

`dev` (stub mode), listening on a non-loopback address: `anyone who can reach port <port> gets in as the dev user`. Bind to loopback unless that is meant.

Source: `packages/cli/src/commands/dev/index.ts`

### DEV_REQUEST_FAILED

`dev`: `<method> <path> failed in the local Gateway: <reason>` (the request was answered 502), once per reason.

Source: `packages/cli/src/commands/dev/gatewayServer.ts`

### DEV_WRONG_HOST

`dev`: `Request for <host> refused: this dev server serves <served>` (answered 421), once per host.

Source: `packages/cli/src/commands/dev/gatewayServer.ts`

### DNS_RECORD_REPLACED

`preflightDomains` with `--force-dns`: the A, AAAA, CNAME or NS record(s) that answer a new hostname (at the name, or a wildcard over a name with no records of its own) are being replaced instead of refused (`DNS_RECORD_CONFLICT` above): `Replacing <host>'s DNS record (<records>)` or `Replacing the DNS records of <n> hostnames` / `<host> (<records>); …`, plus `A wildcard record stays, and keeps answering every other name.` when a wildcard was involved. `data.conflicts`: `[{ host, records }]`.

Source: `packages/cli/src/lib/domains/preflight.ts`

### GATEWAY_AT_ZONE_APEX

`setup`: the Gateway's domain is a zone's apex, so its sign-in cookie covers every subdomain; `data.suggestedDomain`: `apps.<zone>`.

Source: `packages/cli/src/commands/setup/deployGateway.ts`

### GATEWAY_UNREACHABLE

`setup`, step `setup.owner`: one plain request to `https://<host>/` (`checkReachable`, before the owner link goes out) got no answer, so the link can't be opened until the host answers. Message `<host> doesn't answer over HTTPS yet`, then why (`Its certificate is probably still on the way (TLS handshake failed).`, `DNS has no address for <host> yet.` or `It didn't answer (<reason>).`), then `The link below works as soon as it does.`; `data.kind` (`tls`, `dns` or `other`, `NoAnswerKind` in `lib/domains/https.ts`) and `data.reason` say what failed. Nothing to do but wait for the certificate or the DNS record, then open the link.

Source: `packages/cli/src/commands/setup/runSetup.ts`, `packages/cli/src/lib/domains/https.ts`

### HELPER_WORKER_KEPT

`deploy`, step `app.upload`: a helper Worker (`workers`) the previous manifest declared and this one doesn't keeps running, with its crons, because a deploy never deletes a Worker: `Helper Worker <name> is no longer in everyapp.config.ts, but it still runs` / `Its Worker is <worker>--<name>.` `data.fix`: `delete that Worker in the Cloudflare dashboard`.

Source: `packages/cli/src/commands/deploy/deployApp.ts`

### LEASE_HEARTBEAT

A run holding a lease (the Gateway's, an app's, a database's) couldn't renew it in the Gateway's D1: `Can't reach Cloudflare to keep hold of <target> (<for> so far)` / `<reason>. Another run can take over in <time> if this continues.` (the reason is `The database didn't answer within <heartbeat timeout>` on a timeout). When renewal has failed for more than half the lease's TTL, or another holder took it: `This run lost its hold on <target>` / `Its hold expired, and another run may have started. It stops before its next change.`; the next lease check then fails with `LEASE_LOST` (above). Nothing to do but let the network recover.

Source: `packages/cli/src/lib/gateway/lease.ts`

### LEGACY_LOCAL_STATE

`db migrate` and `dev`: the app has `.wrangler/state` (where Wrangler kept local data) and no `.cloudflare/state` yet: `Local data now lives in .cloudflare/state` / `Rows in the old .wrangler/state database weren't copied over.` Informational.

Source: `packages/cli/src/commands/localMigrations.ts`, `packages/cli/src/lib/app/localD1.ts`

### LOCAL_DNS_STALE

`deploy`, step `app.live`, and the certificate wait: the hostname is live but this computer's or network's resolver still caches it as missing; `data.host`, `data.negativeCacheTtlSeconds`. Clears by itself; on macOS `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder` clears the local cache.

Source: `packages/cli/src/lib/domains/localDns.ts`

### MIRROR_SESSION

`dev --mode mirror`: the separately-run local Gateway refused the browser's session, said once per reason: `No Gateway session yet: log in at <login url>, then reload`; `No active organization: create or pick one in the Gateway, then reload`; `Your Gateway session expired: log in again, then reload`; `The Gateway rejected the session (<reason>)`; or, when `/api/dev/identity` couldn't be reached: `Can't reach the local Gateway at <url>` / `<error>. Is pnpm dev running in apps/every-app-gateway?` Do what the line says.

Source: `packages/cli/src/commands/dev/index.ts`, `packages/cli/src/commands/dev/remoteAuth.ts`

### NONSTANDARD_CLOUDFLARE_CONFIG

`deploy`: `cloudflare.config.ts` doesn't use `everyAppWorker()`; the built Worker is still checked against the app policy.

Source: `packages/cli/src/commands/deploy/deployApp.ts`

### OWNER_NOT_CLAIMED

`setup`, step `setup.owner`: the Gateway has no owner and the one-time setup link can't be shown here: nobody is at a terminal and the run isn't `--json` (piped output, `CI`), since the link makes whoever opens it the owner. `The Gateway has no owner yet` / `Apps deploy without one. To create it, run setup at a terminal with this Cloudflare login.`; `data.rerun`: `pnpm everyapp setup`, `data.rerunNote`: `at a terminal`, `data.needsTerminal: true`: hand the command to the person; never add `--json` to run it yourself. Under `--json` the link is relayed in the events instead, and this warning isn't emitted.

Source: `packages/cli/src/commands/setup/runSetup.ts`

### PROVIDER_KEY_UNSET

`provider on`, step `provider.update`: the provider app is on, but the Gateway setting holding its key isn't set, so its tools answer "not set up" until it is: `<NAME> isn't set on the Gateway` / `<provider>'s tools answer "not set up" until it is.`; `data.fix`: `pnpm everyapp secret set <NAME>`, `data.name`: the setting (`DATAFORSEO_API_KEY`). The `done` event's `data.key.set` is false and `data.next` names the same command. Set the key (the setup skill's file for the provider, `setup/dataforseo.md`) and nothing else needs rerunning: the Gateway reads the setting on its next request.

Source: `packages/cli/src/commands/provider/index.ts`

### RESOURCES_KEPT

`delete --purge`, step `app.purge`: resources with the app's names that no deploy recorded creating were kept; `data.kept`, `data.fix` (delete them in the dashboard if they are the app's).

Source: `packages/cli/src/commands/delete/index.ts`

### RESOURCE_RECREATED

`deploy`, step `app.resources`: a recorded database, namespace or bucket no longer exists in the account; a new, empty one is created.

Source: `packages/cli/src/commands/deploy/deployApp.ts`

### SCHEMA_CHECK_SKIPPED

`deploy`, step `app.schema`: the drift check (`SCHEMA_CHECK_FAILED` above) couldn't run: `Can't check the schema against the migrations: drizzle-kit isn't installed` (`data.fix`: `add drizzle-kit to devDependencies`); `… : no drizzle.config.ts` (with the detail `An app that writes its SQL by hand sets migrations.engine to "d1-sql".`); or, when `migrations.config` names the file, `… : no <value> (migrations.config)`, where `<value>` is `migrations.config`'s value.

Source: `packages/cli/src/commands/deploy/steps/checkSchemaDrift.ts`

### TEARDOWN_ALLOWLIST_IGNORED

`teardown`, while reading the allowlist: an entry of `EVERYAPP_TEST_ACCOUNTS` or `~/.config/everyapp/test-accounts` isn't 32 hex characters and was ignored. `Ignored <n> entry|entries of the teardown allowlist that isn't|aren't account ids: <entries>` / `An account id is 32 hex characters (EVERYAPP_TEST_ACCOUNTS, <file>).`; `data.ignored`, `data.file`. The run goes on with the ids that parsed.

Source: `packages/cli/src/lib/teardown/guards.ts`

### TEARDOWN_DELETE_FAILED

`teardown`, step `teardown.delete`: one resource couldn't be deleted (Cloudflare refused: an R2 bucket with objects in it, say), or the DNS records at a published name couldn't be read. `Couldn't delete the <kind "name">` / `<Cloudflare's reason>` (`data.kind`, `data.described`, `data.reason`, `data.fix`: `delete it in the Cloudflare dashboard (<place>)`), or `Couldn't read the DNS records at <name>` / `<reason>` (`data.kind: "dns"`, `data.name`, `data.fix`). The resource is listed under `done.data.kept` with its place in the dashboard; the other kinds are still deleted, and a run after the cause is fixed removes it.

Source: `packages/cli/src/lib/teardown/delete.ts`

### TEARDOWN_READ_FAILED

`teardown`, step `teardown.inventory`: one kind of resource couldn't be listed (a permission the token lacks, say). `Couldn't list <what>; whatever is there is kept` / `<reason>`; `data.what`, `data.reason`, `data.fix`: `check the token's permissions (runbook step 5), then run again`. The kind is reported kept; the inventory, the confirmation and the other kinds go on.

Source: `packages/cli/src/lib/teardown/inventory.ts`

### TOOLS_CATALOG

`dev`, step `dev.mcp`: `Agent tools: <problem>` with the app's MCP tool catalog; `data.appId`.

Source: `packages/cli/src/commands/dev/devAppGateway.ts`

### UPLOAD_UNRECORDED

`cfDeploy`, under the upload's step (`gateway.deploy`, `app.upload`, `app.helper`): cf failed after its upload went live (publishing a Custom Domain, the workers.dev subdomain) and the version that went live couldn't be recorded either: `The version cf uploaded of <worker> couldn't be recorded` then why; `data.workerName`, `data.error`. The run still ends with cf's failure. The next run finds a Worker version the install row or registry doesn't name: the Gateway's own, when it holds the row's hostname as a Custom Domain (resumed without asking: `gateway.resume`); otherwise a confirmation at a terminal (`rerun_interactive`).

Source: `packages/cli/src/lib/cf/deploy.ts`

### WORKERS_PAID_UNVERIFIED

`setup`, step `setup.plan`: the account's subscriptions (`cf accounts subscriptions get`, `workersPlan` in `lib/cf/plan.ts`) were listed, but no live Workers subscription among them reads as Paid (`paid`, `standard`, `bundled` or `unbound` in its name) or Free: `Couldn't confirm this account is on Workers Paid` / `Every App needs it ($5 a month, then usage). On Free, the Gateway stops once D1 hits its daily limit.` `data.url` (the account's Workers plans page), `data.plan`: `unknown`. Free is the `upgrade_workers_paid` action; a list cf couldn't read at all (`unreadable`, a token without the permission) is a skipped step (`Couldn't read this account's plan; Cloudflare refuses the upload if it's on Free`). Subscribe if the account isn't on Paid.

Source: `packages/cli/src/commands/setup/runSetup.ts`, `packages/cli/src/lib/cf/plan.ts`

### WORKER_TYPES_FAILED

`create`, step `create.types`: Worker types couldn't be generated; `pnpm dev tries again.`

Source: `packages/cli/src/commands/create/index.ts`

### ZONE_CUSTOM_DOMAIN_LIMIT_NEAR

`preflightDomains`: the Gateway will publish 95 or more hostnames in the zone (limit 100, `ZONE_CUSTOM_DOMAIN_LIMIT` above): `<zone> is close to Cloudflare's 100 Custom Domains per zone` / `It will hold at least <total>, and other Workers' domains there count too.` `data.total`, `data.limit`. Delete apps you no longer use, or plan a second Gateway on another domain.

Source: `packages/cli/src/lib/domains/preflight.ts`

Four warnings share their code with an error or a `status` fix and are documented under that heading:

| Code                       | Where                        | What                                                                                                                                                                                                                                                 |
| -------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_WORKER_MISSING`       | The Gateway rebind           | `Skipping <app>: its Worker is missing`; `data.fix`: `deploy <app> again, or remove it with pnpm everyapp delete <app>`. Heading under [What status reports as fixes](#what-status-reports-as-fixes).                                                |
| `EMAIL_INBOUND_UNDECLARED` | `deploy`, `app.email`        | The manifest no longer declares inbound email; the app's mail routes are removed, its stored addresses stay; `data.rerun`: `pnpm everyapp email unset inbound`. Heading under [What status reports as fixes](#what-status-reports-as-fixes).         |
| `GIT_FAILED`               | `create`, `create.git`       | `git init`/`add`/`commit` failed; the app is complete without a repository. `data.fix`: set `user.name` and `user.email` then commit, or `git init` yourself. Heading under [Codes raised with a dynamic value](#codes-raised-with-a-dynamic-value). |
| `MIGRATIONS_FAILED`        | `create`, `migrations.local` | The new app's local database couldn't be migrated; `data.rerun`: `pnpm everyapp db migrate`. `db migrate`/`dev` raise it as an error, documented above.                                                                                              |

## What status reports as fixes

`everyapp status` ends with a `done` event whose `data.fixes` is one entry per problem: `{ code, severity, message, run, note?, fix? }`, where `message` is the headline and detail lines joined by newlines, `run` the command to run (or `null`), `note` what follows it, and `fix` a remedy that isn't one command. `severity` is `error` (✗, broken), `warning` (!, something to do or something the report couldn't check), `info` (a dim i: good to know, nothing to fix; listed last) or `settling` (no glyph: it resolves by itself); only errors and warnings count in the one-line summary (`Gateway <url>: <n> apps live, <n> problems to fix` or `nothing to fix`). The codes are `ProblemCode` in `packages/cli/src/commands/status/problems.ts`. `data.access` is `{ on, teamDomain }`: whether all three Access settings are on the Gateway Worker and the team domain `access on` recorded (`readAccessState` in `packages/cli/src/lib/access/settings.ts`, from the Worker's secret names and the Gateway's D1 record; Zero Trust itself isn't asked), or `null` for a hosted Gateway, before the first upload, or when cf couldn't list the settings (then `ACCESS_UNKNOWN` below). A Gateway whose database exists but has no install row gets only `GATEWAY_NOT_INSTALLED`, with `data.installed: false`.

### CHECKOUT_BEHIND

Warning. `This checkout is behind the live Gateway`, `This checkout has <version>; <live> is live.` (when they differ), `Deploys from here are refused until it catches up.` (`DOWNGRADE_REFUSED` above). Run: `git pull`.

Source: `packages/cli/src/commands/status/problems.ts`

### GATEWAY_OUTDATED

Info. The install row's tree hash isn't this checkout's Gateway sources' and the Gateway has been uploaded: `Your every-app folder has a newer Gateway than the one online` / `Run update now, or leave it: the next new app's deploy updates it too.` Run: `pnpm everyapp update`, `note`: `updates it now`. Not a problem to fix: it is listed after the others and doesn't count in the summary.

Source: `packages/cli/src/commands/status/problems.ts`

### NO_OWNER

Warning. The Gateway is uploaded but nobody has claimed it: `No owner yet, so nobody can sign in` / `Apps still deploy. Setup prints a one-time link that creates the owner account.` Run: `pnpm everyapp setup`.

Source: `packages/cli/src/commands/status/problems.ts`

### APP_NEEDS_SETUP (status)

Warning. A served app (active, or binding and bound) whose required settings aren't all set, so it doesn't open; its APP cell reads `! needs setup` and the SETTINGS table shows each setting: `<app> needs setup`, one detail line per unmet setting (`<NAME>: <why>`, then `Get it at <docs>` and `Guide: .claude/skills/everyapp/<setup>` once per distinct guide). Run: `pnpm everyapp secret set <names> [--app <id>]` (`runNote` carries an unmet any-of group's alternatives). The same report is `data.apps[].setup` ([`/docs/agent/json`](/docs/agent/json#done)).

Source: `packages/cli/src/commands/status/problems.ts`

### GATEWAY_NOT_INSTALLED (status)

Warning. The Gateway's D1 database exists but there is no install row: `Setup stopped before it recorded the Gateway's install` / `The Gateway's database exists, but nothing else was recorded.` Run: `pnpm everyapp setup`, `note`: `asks for the hostname again`. (The error of the same name is documented above.)

Source: `packages/cli/src/commands/status/problems.ts`

### GATEWAY_NOT_UPLOADED

Warning. The install row has no `liveVersionId`: `The Gateway's install stopped before its first upload` / `Setup finishes it, then prints the link that creates the owner account.` Run: `pnpm everyapp setup`.

Source: `packages/cli/src/commands/status/problems.ts`

### GATEWAY_CHANGED

Warning. The Gateway Worker serves a version other than the one the install row records: `The Gateway Worker was changed outside everyapp` / `It serves a version from the dashboard or API, not the one setup uploaded.` Run: `pnpm everyapp setup` (`redeploys <live>, asking first`).

Source: `packages/cli/src/commands/status/problems.ts`

### BINDINGS_DIFFER

Warning. The live Gateway's bindings or hostnames aren't what the registry says. With apps it should bind and doesn't: `The live Gateway doesn't serve <apps>` / `<apps> is|are uploaded, but the live Gateway doesn't bind it|them.`; otherwise `The live Gateway's apps or hostnames are out of date` / `It still serves something that was removed, or not yet what was added.` Run: `pnpm everyapp setup`.

Source: `packages/cli/src/commands/status/problems.ts`

### APP_WORKER_MISSING

Error. A registered app's Worker no longer exists in the account: `<app>'s Worker no longer exists`. Run: `pnpm everyapp deploy from <app>'s directory, or pnpm everyapp delete <app>`.

Source: `packages/cli/src/commands/status/problems.ts`

### APP_NOT_BOUND (status)

Error. The app's Worker isn't named the way the Gateway names it, so the Gateway can't bind it: `The Gateway can't bind <app>` / `Its Worker isn't named the way the Gateway names <app>'s.` Run: `pnpm everyapp delete <app>`.

Source: `packages/cli/src/commands/status/problems.ts`

### APP_NOT_UPLOADED

Warning. The app's row is `pending`: `<app> was registered, but none of its deploys finished`. Run: `pnpm everyapp deploy from the app's directory, or pnpm everyapp delete <app>`.

Source: `packages/cli/src/commands/status/problems.ts`

### APP_BINDING

Settling. The app is `binding` and the live Gateway binds it: `<app> goes live on its first visit to https://<hostname>`. Nothing to run.

Source: `packages/cli/src/commands/status/problems.ts`

### EMAIL_ROUTES_UNKNOWN

Warning. cf couldn't list the Email Routing rules: `Couldn't check the apps' Email Routing rules` / `Cloudflare said: <error>. Deleted rules won't show above.` Nothing to run.

Source: `packages/cli/src/commands/status/problems.ts`

### EMAIL_INBOUND_UNDECLARED

Warning. The installation has inbound addresses but the manifest it was deployed from doesn't declare `email: { inbound: true }`: `<app> has an inbound address|inbound addresses, but its config doesn't turn inbound mail on` / `<app> was deployed without email: { inbound: true }, so nothing routes <addresses>.` Fix: `declare it in everyapp.config.ts and run pnpm everyapp deploy, or drop the address|the addresses: pnpm everyapp email unset inbound`; where: `Run either from <app>'s directory.`

Source: `packages/cli/src/commands/status/problems.ts`

### EMAIL_ROUTE_PENDING

Warning. Stored inbound addresses with no route yet, or routes for addresses no longer listed, and every existing route delivers: `<app> doesn't get mail at <addresses> yet` or `<app>'s mail routes don't match its addresses` (with a detail line listing what isn't routed yet and what is still routed though no longer listed). Run: `pnpm everyapp deploy from <app>'s directory`.

Source: `packages/cli/src/commands/status/problems.ts`

### EMAIL_ROUTE_MISSING

Warning. At least one recorded route doesn't deliver to the app's Worker (`emailRouteProblems` in `packages/cli/src/lib/app/emailRoutes.ts`: `a deploy stopped before recording its rule`, `its Email Routing rule is gone`, `its rule|the catch-all is off` or `sends mail to …`, `Email Routing is off for <domain>`): `<app> doesn't get mail at <address>` or `at <n> of its addresses` (or the mismatch headline above when stale routes exist too), detail `<address> gets no mail: <problem>`. Run: `pnpm everyapp deploy from <app>'s directory`.

Source: `packages/cli/src/commands/status/problems.ts`, `packages/cli/src/lib/app/emailRoutes.ts`

### CERTIFICATES_UNKNOWN

Warning. cf couldn't list the zone's certificate packs: `Couldn't list <zone>'s certificates` / `Cloudflare said: <error>.` Nothing to run.

Source: `packages/cli/src/commands/status/problems.ts`

### CERT_PENDING (status)

Settling. Published hostnames with no certificate yet: `No certificate yet for <hosts>` / `It usually comes within minutes.` Nothing to run.

Source: `packages/cli/src/commands/status/problems.ts`

### ACCESS_UNKNOWN (status)

Warning. cf couldn't list the Gateway Worker's settings, so whether Cloudflare Access is on wasn't checked, and `data.access` is `null`: `Couldn't check whether Cloudflare Access is on` / `Cloudflare said: <error>.` Nothing to run. Only read for a self-hosted Gateway that has been uploaded.

Source: `packages/cli/src/commands/status/problems.ts`, `packages/cli/src/lib/access/settings.ts`

### DEPLOY_RUNNING

Settling. A live lease: `<Holder's activity> is running` (as `describeLeaseHolder` words it). Nothing to run; wait.

Source: `packages/cli/src/commands/status/problems.ts`

### SETTINGS_UNKNOWN (status)

Warning. cf couldn't list a Worker's secrets, so the SETTINGS table can't say whether those settings are set: `Couldn't list the Workers' secrets` / `Cloudflare said: <reason>`; the affected rows read `! couldn't check` (the Gateway's) or `! not recorded` (an app's own), and nothing is recorded for them. The rest of the report stands.

Source: `packages/cli/src/commands/status/problems.ts`

## Codes raised with a dynamic value

Five raise sites pass a code they didn't write themselves:

- `packages/cli/src/commands/create/index.ts`: `installFailed` re-raises `INSTALL_FAILED` (above) with the install's last 5 lines, the log path and `<dir> is created; only the install is left.` It also handles `GIT_FAILED` (below) as a warning.
- `packages/cli/src/commands/email/index.ts`: `assertValidList` raises `EMAIL_SENDER_INVALID` or `EMAIL_INBOUND_INVALID` (above), the code chosen by which flag is being checked; `emailListProblems` in `packages/sdk/src/internal/email.ts` supplies the problems.
- `packages/cli/src/commands/setup/runSetup.ts`: `domainFlag` re-raises `normalizeHostname`'s `INVALID_DOMAIN` (above) as `--domain <value> isn't a full hostname` with the same `fix` (`use a name like apps.example.com`).
- `packages/cli/src/lib/gateway/registry.ts`: every registry call turns a `RegistrationError` from `packages/perimeter/src/registry/registration.ts` into an `EveryAppError` with the same code and message, `retryable` when its HTTP status is 500 or more (none is). The Gateway's deploy API answers the same codes with the same statuses (`run.ts` and `routes.ts` re-raise them as `DeployError`s). Of the `RegistrationErrorCode`s, `INVALID_APP_ID`, `APP_NOT_FOUND`, `INVALID_MANIFEST` and `WORKER_NAME_TAKEN` are documented above, `ORG_KEY_UNAVAILABLE`, `APP_NOT_REGISTERED` and `HOSTNAME_TAKEN` have headings below, and the seven others are in the table after this list.
- `packages/cli/src/lib/childLog.ts`: `runLogged` raises `options.code ?? "COMMAND_FAILED"` when a child everyapp runs itself exits non-zero: `<what> failed` / `<command> exited with code <n>.` (or `was stopped by <signal>`) `Its last lines:`, the last 20 lines indented, `Full log: $TMPDIR/everyapp/<name>-<time>-<pid>.log`; `data.command`, `data.exitCode`, `data.tail`, `data.log`. Every caller passes a code: `INSTALL_FAILED` (`lib/package-manager.ts`, above), `BUILD_FAILED` (`lib/app/buildApp.ts`, above), `GIT_FAILED` (`lib/git.ts`, below) and `GATEWAY_BUILD_FAILED` (`lib/gateway/checkoutRelease.ts`: the Gateway release built from this checkout, `pnpm --filter @every-app/sdk build` then `pnpm run build:release` in `apps/every-app-gateway`, exited non-zero: `Building the Gateway failed` / `<command> exited with code <n>. Its last lines:` … `Full log: $TMPDIR/everyapp/gateway-build-<time>-<pid>.log`, `fix`: `fix the build error above, then run this again`; raised by `setup`, and by `deploy`/`delete` when they rebind a Gateway from the checkout), so `COMMAND_FAILED` is the default nobody uses.

The registry rules without a heading of their own (`packages/perimeter/src/registry/registration.ts`; none retryable, every status below 500):

| Code                      | Status     | Message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_APP_HOSTNAME`    | 400        | The app's host label (`<appId>` for the install organization, `<appId>-<orgKey>` otherwise) isn't a DNS label of at most 63 lowercase letters, digits and hyphens: `The app id must form a valid DNS label of at most 63 characters; received "<label>".` (or `The app id and organization key must form …`). Choose a shorter or simpler app id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `RESERVED_APP_ID`         | 400        | `The app id "everyapp" is reserved for the platform.` (it prefixes the Gateway's own MCP tools). Choose another id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `INVALID_WORKER_NAME`     | 400        | `App id "<id>" is too long: its Worker name "<name>" would exceed 63 characters.` or `App id "<id>" can't be registered: its Worker would be "<name>", which is reserved for the gateway or isn't the app's own.` Choose a shorter or different app id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `RESOURCE_NAME_CONFLICT`  | 400        | Two bindings of one kind would share a resource name: `Bindings <a> and <b> would share the <kind> "<name>". Rename one of them in everyapp.config.ts.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SHARED_APP_NOT_PLATFORM` | 403        | A shared scope asked for by an organization that isn't the install (platform) organization: `Only the platform organization registers shared apps; "<id>" can't be shared from another organization.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `APP_SCOPE_MISMATCH`      | 409        | The existing row's scope isn't the one asked for: `App "<id>" is a shared app, not this organization's own. Deploy it without asking for another scope, or give the organization's own app an id of its own.` or `App "<id>" is this organization's own app, not a shared one. Shared apps need an app id of their own.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `APP_TIER_MISMATCH`       | 400 or 409 | 400: a shared app on tier `dispatch`: `A shared app is reached over a service binding; "<id>" can't be deployed through the hosted deploy API.` 409: an existing row on another tier than the deploy's: `App "<id>" is deployed through the hosted deploy API; deploy it the same way, or give this app an id of its own.`, `App "<id>" is reached over a service binding, not deployed through the hosted deploy API; give the third-party app an id of its own.`, or for a deploy under a provider app's id (`packages/perimeter/src/registry/providerApps.ts`; the row is on tier `provider`, turned off or not): `"<id>" is the Gateway's provider app of that name; give this app an id of its own.`; and from `provider on` for the id of a deployed app: `"<id>" is an app deployed to this Gateway, not the provider app; the provider app can't take its id.` |
| `PROVIDER_APP_UNKNOWN`    | 400        | `provider on <id>` or `provider off <id>` with an id that isn't a provider app (`PROVIDER_APPS` in `packages/sdk/src/internal/providerApps.ts`): `"<id>" is not a provider app. The Gateway offers: dataforseo.` Run `pnpm everyapp provider list` for the ids.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### ORG_KEY_UNAVAILABLE

Registry (409): the organization has no key yet and every candidate from its slug is taken by another organization on this Gateway: `Every key for organization "<slug>" is taken by another organization on this gateway.` The CLI claims a key the same way the Gateway's deploy API does (`claimOrgKey` in `lib/gateway/registry.ts`: one `INSERT OR IGNORE` statement in the registration batch, so two deploys can't claim two keys), so this means every candidate from the organization's slug is held by another organization.

**Fix:** none for the caller; an operator assigns the key.

Source: `packages/cli/src/lib/gateway/registry.ts`, `apps/every-app-gateway/src/server/deploy/registry.ts`

### APP_NOT_REGISTERED

Registry (409): the app row has no Worker, or no hostname on a tier that needs one: `App "<id>" has no Worker or hostname yet; deploy it again.` The deploy API also answers it (404) for a deploy of an app id that was never registered: `No app "<id>" is registered for this organization; register it first (everyapp deploy --gateway does).`

**Fix:** deploy again.

Source: `packages/perimeter/src/registry/registration.ts`, `apps/every-app-gateway/src/server/deploy/routes.ts`

### HOSTNAME_TAKEN

Registry (409): the hostname the rules give the app is registered to another app on this Gateway: `The hostname "<hostname>" is already registered to another app on this gateway.`

On a self-hosted browser install (`cfRestDeployer.ts`, 409) the same code comes from two Cloudflare-side checks at the publish, not the registry: a Custom Domain on a Worker other than the Gateway's holds the hostname (`Another Worker owns the app's hostname.`), or a DNS record already answers for it (`DNS already answers for this app's hostname. Choose another app id.`).

**Fix:** choose another app id, or free the name.

Source: `packages/perimeter/src/registry/registration.ts`, `apps/every-app-gateway/src/server/deploy/cfRestDeployer.ts`

### GIT_FAILED

`runLogged`'s code from `lib/git.ts` when `git init`, `git add .` or `git commit -m "Starter template"` fails in a new app's directory. `create` catches it and emits the warning `GIT_FAILED` instead (`Couldn't make the first git commit` or `Couldn't start a git repository` / `git: <last line>. Full log: <path>`, `data.fix`: `set git's user.name and user.email, then commit in <dir>` or `start one yourself in <dir>: git init, then commit`), so the app is created either way.

**Fix:** as the warning says.

Source: `packages/cli/src/lib/git.ts`, `packages/cli/src/lib/childLog.ts`, `packages/cli/src/commands/create/index.ts`

## Sources

`packages/cli/src/lib/errors.ts`
`packages/cli/src/lib/output/report.ts`
`packages/cli/src/lib/output/command.ts`
`packages/cli/src/lib/output/prompt.ts`
`packages/cli/src/lib/output/events.ts`
`packages/cli/src/lib/output/time.ts`
`packages/cli/src/lib/cf/account.ts`
`packages/cli/src/lib/cf/deploy.ts`
`packages/cli/src/lib/cf/errors.ts`
`packages/cli/src/lib/cf/access.ts`
`packages/cli/src/lib/checkout.ts`
`packages/cli/src/lib/childLog.ts`
`packages/cli/src/lib/app/buildApp.ts`
`packages/cli/src/lib/app/policy.ts`
`packages/cli/src/lib/app/installBuildOutput.ts`
`packages/cli/src/lib/app/deploySecrets.ts`
`packages/cli/src/lib/app/resources.ts`
`packages/cli/src/lib/app/emailRoutes.ts`
`packages/cli/src/lib/app/release.ts`
`packages/cli/src/lib/access/plan.ts`
`packages/cli/src/lib/access/sync.ts`
`packages/cli/src/lib/access/settings.ts`
`packages/cli/src/lib/cf/plan.ts`
`packages/cli/src/lib/domains/preflight.ts`
`packages/cli/src/lib/domains/zones.ts`
`packages/cli/src/lib/gateway/registry.ts`
`packages/cli/src/lib/gateway/release.ts`
`packages/cli/src/lib/gateway/apply.ts`
`packages/cli/src/lib/gateway/reconcile.ts`
`packages/cli/src/lib/gateway/connect.ts`
`packages/cli/src/lib/gateway/discover.ts`
`packages/cli/src/lib/migrations/postgres.ts`
`packages/cli/src/lib/migrations/localCli.ts`
`packages/cli/src/commands/create/index.ts`
`packages/cli/src/commands/create/steps/appId.ts`
`packages/cli/src/commands/deploy/index.ts`
`packages/cli/src/commands/deploy/deployApp.ts`
`packages/cli/src/commands/release/bundleApp.ts`
`packages/cli/src/commands/deploy/command.ts`
`packages/cli/src/commands/deploy/steps/waitForLive.ts`
`packages/cli/src/commands/deploy/steps/offerGateway.ts`
`packages/cli/src/commands/appGateway.ts`
`packages/cli/src/commands/delete/index.ts`
`packages/cli/src/commands/secret/index.ts`
`packages/cli/src/commands/db/index.ts`
`packages/cli/src/commands/db/restore.ts`
`packages/cli/src/commands/email/index.ts`
`packages/cli/src/commands/dev/index.ts`
`packages/cli/src/commands/dev/gatewayServer.ts`
`packages/cli/src/commands/dev/rerun.ts`
`packages/cli/src/commands/dev/proxy.ts`
`packages/cli/src/commands/setup/runSetup.ts`
`packages/cli/src/commands/setup/deployGateway.ts`
`packages/cli/src/commands/setup/command.ts`
`packages/cli/src/commands/update/command.ts`
`packages/cli/src/commands/login/index.ts`
`packages/cli/src/commands/access/index.ts`
`packages/sdk/src/internal/email.ts`
`packages/perimeter/src/registry/registration.ts`
`packages/cli/src/lib/cf/runner.ts`
`packages/cli/src/lib/cf/privateDir.ts`
`packages/cli/src/lib/runtime.ts`
`packages/cli/src/bin/cli.ts`
`packages/cli/src/argumentErrors.ts`
`packages/cli/src/lib/secretValue.ts`
`packages/cli/src/lib/app/secrets.ts`
`packages/cli/src/lib/app/workflows.ts`
`packages/cli/src/lib/app/localD1.ts`
`packages/cli/src/lib/git.ts`
`packages/cli/src/lib/package-manager.ts`
`packages/cli/src/lib/gateway/lease.ts`
`packages/cli/src/lib/gateway/checkoutRelease.ts`
`packages/cli/src/lib/domains/hostnames.ts`
`packages/cli/src/lib/domains/certificates.ts`
`packages/cli/src/lib/domains/certWait.ts`
`packages/cli/src/lib/domains/localDns.ts`
`packages/cli/src/lib/domains/https.ts`
`packages/cli/src/commands/deploy/steps/checkSchemaDrift.ts`
`packages/cli/src/commands/status/problems.ts`
`packages/cli/src/commands/status/index.ts`
`packages/cli/src/commands/localMigrations.ts`
`packages/cli/src/commands/dev/remoteAuth.ts`
`packages/cli/src/commands/dev/devAppGateway.ts`
`packages/sdk/src/internal/gatewaySettings.ts`
`packages/perimeter/src/manifest/manifest.ts`
`packages/perimeter/src/manifest/deploy.ts`
`apps/every-app-gateway/src/server/deploy/errors.ts`
`apps/every-app-gateway/src/server/deploy/auth.ts`
`apps/every-app-gateway/src/server/deploy/routes.ts`
`apps/every-app-gateway/src/server/deploy/run.ts`
`apps/every-app-gateway/src/server/deploy/pipeline.ts`
`apps/every-app-gateway/src/server/deploy/install.ts`
`apps/every-app-gateway/src/server/deploy/bundle.ts`
`apps/every-app-gateway/src/server/deploy/release.ts`
`apps/every-app-gateway/src/server/deploy/registry.ts`
`apps/every-app-gateway/src/server/deploy/ledger.ts`
`apps/every-app-gateway/src/server/deploy/metadata.ts`
`apps/every-app-gateway/src/server/deploy/browser-install.ts`
`apps/every-app-gateway/src/server/deploy/cfRestDeployer.ts`
`apps/every-app-gateway/src/server/repositories/DeployJobRepository.ts`
`apps/every-app-gateway/src/server/platform-policy.ts`
`apps/every-app-gateway/src/server/errors.ts`
`apps/every-app-gateway/src/middleware/auth.ts`
`apps/every-app-gateway/src/middleware/publicError.ts`
`apps/every-app-gateway/src/routes/api/setup/claim.ts`
`apps/every-app-gateway/src/routes/api/admin/apps/install.ts`
`apps/every-app-gateway/src/routes/api/admin/deploys/$id.ts`
