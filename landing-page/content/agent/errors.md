---
title: Error codes
description: Every code an everyapp command can end with (errors, the reporter's and cf's, argument errors), the codes the Gateway's deploy API and browser install answer, every warning, and every problem status reports, each with what it means and how to fix it.
---

Codes are stable strings for scripts; messages are for people. With `--json` a code arrives on an `error` event (`code`, `message`, `retryable`, `data.fix`, `data.rerun`, `data.rerunNote`, `data.authorize`), a `warning` event (`code`) or in `status --json`'s `data.fixes[]` ([the protocol](/docs/agent/json)). An entry's anchor is its code, lowercased (`#dns_record_conflict`); `DEPLOY_ABANDONED` is described under [`DEPLOY_FAILED`](#deploy_failed), and the registry rules under [Codes raised with a dynamic value](#codes-raised-with-a-dynamic-value) in prose and a table; neither has an anchor of its own. Where a fix is a command that takes something over (`--force-dns`, `--allow-delete-*`, `--yes`, `--enable-email-routing`), the event carries `data.authorize: true`: show it to the person and ask before running it.

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

### AI_DEFAULT_INVALID

`ai default <provider>[/<model>]` with something the default model provider can't be: text that isn't a provider id (`Open Router`), an id the catalog doesn't have, an API provider (`stripe`), an entry without an OpenAI-shaped chat route (`cohere`: an app pins it under `providers`), or `ai-gateway` (it fronts the providers and serves no models; `ai gateway on` turns it on). The message says which.

**Fix:** `fix`: pick one of the providers `pnpm everyapp ai list` shows, as `<provider>` or `<provider>/<model>`. Nothing was written. Not retryable.

Source: `packages/cli/src/lib/gateway/aiDefault.ts` (`setAiDefault`, `parseAiDefaultArgument`).

### AI_GATEWAY_ID_INVALID

`ai gateway on --id <name>` with a name Cloudflare refuses for an AI Gateway: anything but lowercase letters, digits and single hyphens, or over 64 characters (`bad--id`, `under_score`).

**Fix:** `fix`: `pnpm everyapp ai gateway on --id <name>` with a valid name (the default, `everyapp`, is one). Not retryable.

Source: `packages/cli/src/commands/ai/index.ts` (`turnGatewayOn`).

### ALREADY_INVITED

`workspace invite <email>`: the address has a pending invitation to the organization that hasn't expired (`invitations.status = 'pending'`, `expires_at` still to come). Checked before the write and again on it (the insert's `WHERE NOT EXISTS`), so an invite racing this one loses; a second raise after the write is `retryable`. An expired invitation doesn't count: a new one is made beside it. Headline: `<email> has a pending invitation to <organization> already`.

**Fix:** `rerun`: `pnpm everyapp workspace invite-link <email>`, `rerunNote`: `prints a new link for it`. Cancel it first with `workspace uninvite` to invite with another role.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`invite`, `refuseKnownAddress`).

### ALREADY_MEMBER

`workspace invite <email>`: a member of the organization has that email (letter case aside). Checked before the write and again on it. Headline: `<email> is a member of <organization> already`.

**Fix:** `rerun`: `pnpm everyapp workspace users`, `rerunNote`: `lists the members`.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`refuseKnownAddress`).

### APP_CHANGING

After the Worker is uploaded, the deploy records its version on the app's registry row with an `UPDATE … WHERE id = ? AND status = ?` over the status it just read, so an admin switching the app off meanwhile keeps it off; when that write matches no row three times running (`MARK_DEPLOYED_ATTEMPTS = 3`), the row is changing under the run. Headline: `The app's registry row keeps changing while this deploy records its upload`, then `The upload is kept.` Raised by `deploy` (under the app's lease, after the `app.email` step and before the Gateway rebind).

`mcp on` and `mcp off` raise it the same way for an MCP app whose status changed between the read and the write (`UPDATE … WHERE id = ? AND status = ?`): `<id> changed while this ran` then `Nothing was written; run it again.`; `mcp tool` when the app's manifest changed under it three times running (each write is `… WHERE manifest = ?` over the manifest it read): `<id> keeps changing while this writes its tool settings`, `Nothing was written; run it again.`

**Fix:** `retryable: true`, so `rerun` is this same command. No takeover.

Source: `packages/cli/src/lib/gateway/registry.ts` (`markDeployed`), `packages/cli/src/lib/gateway/remoteMcpApps.ts` (`setMcpAppStatus`, `setRemoteMcpTool`).

### APP_DIR_EXISTS

`create <name or path>` found the directory the new app would go in already there: `apps/<name>` inside the EveryApp checkout, `./<name>` anywhere else, or the directory a path named. Headline: `<dir> already exists` (`./<name>` for a directory under the current one, a relative path otherwise, the whole path when it was given absolute or from `~`).

**Fix:** `fix`: `pick another name, or move <dir> away`. No rerun; not retryable.

Source: `packages/cli/src/commands/create/index.ts`.

### APP_DIR_IN_CHECKOUT

`create <path>` was given a path that resolves inside the EveryApp checkout but not directly in its `apps/` folder (`placeOf` in `packages/cli/src/lib/app/starter.ts`): `./my-app` from the checkout's root, `../my-app` from `packages/cli`, `apps/` itself. Headline: `<dir> is inside your EveryApp checkout but not in its apps/ folder`, then `An app inside the checkout goes in apps/<name>; one anywhere else is its own git repository.` Nothing is created. A bare name never raises it: from inside the checkout it goes in `apps/<name>` wherever it is run.

**Fix:** `fix`: `use <apps/name> (inside the checkout) or <../name> (beside it)`, both said from the current directory (whole when the path was given absolute or from `~`). No rerun; not retryable.

Source: `packages/cli/src/commands/create/index.ts`.

### APP_ID_REQUIRED

`create` was given no name and can't ask for one: under `--json`, under `--yes`, or with no terminal. Headline: `No app name given`, then `--yes means nothing is asked.` or `There's no terminal to ask for one.` At a terminal the name is prompted for instead (default `my-app`); a name that is given but invalid is `INVALID_APP_ID`.

**Fix:** `rerun`: `pnpm everyapp create <name>` (with ` --yes` appended when `--yes` was given). Not retryable.

Source: `packages/cli/src/commands/create/steps/appId.ts` (`resolveAppId`).

### APP_NAME_INVALID

`workspace app set <app> --name <name>`: the name is empty once trimmed, or longer than 255 characters (the rule Admin → Apps → Edit applies, `schemas/app.ts`). The command line's parser refuses it first, as `INVALID_VALUE` (exit 252: `--name can't be ""`); this is the library's own check behind it. Headline: `An app's name is 1 to 255 characters, not empty` (or `(<n> given)`). Nothing is written.

**Fix:** `fix`: `give --name the name the app library should show, or leave --name off`. Not retryable.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`appName`, `updateApp`), `packages/cli/src/commands/workspace/command.ts` (the `--name` parser).

### APP_NOT_FOUND

The app the command acts on has no usable row in the Gateway's registry (never deployed, deleted, or gone mid-run). Each raise site says it its own way:

| Raised by                                                                                                                                                                                                                                         | Headline                                                                                                                                                                                             | Next step                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `db query` (production), `db restore`, `email set`, `email unset`, `secret list <app>` (registry `readApp`, `writeAppEmail`)                                                                                                                      | `<app> isn't deployed to this Gateway yet`                                                                                                                                                           | `rerun`: `pnpm everyapp deploy`, `rerunNote`: `in the app's directory`                                    |
| `deploy` and `email set/unset` reading the row's email lists under the lease (registry `readAppEmail`)                                                                                                                                            | `The app is no longer registered on this Gateway`                                                                                                                                                    | `rerun`: `pnpm everyapp deploy`, `rerunNote`: `in the app's directory`                                    |
| `delete <app>` (registry `deleteApp`): no row, or a row with no Worker name                                                                                                                                                                       | `No app named <app> on this Gateway`                                                                                                                                                                 | `rerun`: `pnpm everyapp status`, `rerunNote`: `lists its apps`                                            |
| `delete <id>` for an MCP app (a provider-tier row, built in or added by URL), before anything changes                                                                                                                                             | `<id> is an MCP app, not an app deployed to this Gateway`                                                                                                                                            | `rerun`: `pnpm everyapp mcp remove <id>`, `rerunNote`: `removes an MCP app`                               |
| `mcp on`, `mcp show`, `mcp refresh`, `mcp tool` for a remote MCP app that was removed (`removedRemoteApp`)                                                                                                                                        | `<id> was removed from this Gateway` / `Adding it again starts fresh: nobody's access or tools are kept.`                                                                                            | `rerun`: `pnpm everyapp mcp add <its url> --name <id>`, `rerunNote`: `adds it again`                      |
| `secret set`, `secret unset` for an app's names, before any value is read                                                                                                                                                                         | `<app> isn't deployed yet` / `Its secrets can be set after its first deploy. Nothing was changed.`                                                                                                   | `rerun`: `pnpm everyapp deploy`                                                                           |
| `secret set --app <id>`, `secret unset --app <id>`: no registered app by that id                                                                                                                                                                  | `<app> isn't deployed to this Gateway` / `An app's secrets can be set after its first deploy. Nothing was changed.`                                                                                  | `rerun`: `pnpm everyapp status`, `rerunNote`: `lists its apps`                                            |
| `configure <app>`: no registered app by that id, or a row whose first deploy never finished (`status: "pending"`)                                                                                                                                 | `<app> isn't deployed to this Gateway` / `An app is configured by name after its first deploy; in its directory, configure works before that too (for the Gateway's settings). Nothing was changed.` | `rerun`: `pnpm everyapp status`, `rerunNote`: `lists its apps`                                            |
| `configure` in the app's directory before its first deploy, a name of the app's own on stdin                                                                                                                                                      | `<app> isn't deployed yet` / `Its own <NAME> can be set after its first deploy. Nothing was set.`                                                                                                    | `rerun`: `pnpm everyapp deploy`                                                                           |
| `deploy` recording the upload (`markDeployed`): the row is gone, or is a tombstone                                                                                                                                                                | `The app's registry row is gone; deploy it again.` / `No app "<app>" is registered for this organization.`                                                                                           | No fix or rerun; `retryable: false` (a `RegistrationError` with status 404, wrapped by `asEveryAppError`) |
| `deploy` in step `app.live`: the row was deleted while the run waited for the app to go live                                                                                                                                                      | `<app> was deleted during this run`                                                                                                                                                                  | `retryable: true`, so `rerun` is this same command; `rerunNote`: `to put it back`                         |
| `workspace app set/access/cap`, `workspace group apps --add/--set`, `workspace activity --app` (`findApp`): no app of the organization by that id or row id (a deleted app's tombstone doesn't count; `cap` and `activity` take a shared app too) | `No app named <app> in <organization>`                                                                                                                                                               | `rerun`: `pnpm everyapp workspace apps`, `rerunNote`: `lists them`                                        |

**Fix:** as the table says; for an app (not an MCP app) in every case but the last three, deploy the app first. No takeover.

Source: `packages/cli/src/lib/gateway/registry.ts`, `packages/cli/src/lib/gateway/remoteMcpApps.ts`, `packages/cli/src/lib/gateway/workspace.ts`, `packages/cli/src/commands/deploy/steps/waitForLive.ts`, `packages/cli/src/commands/secret/index.ts`, `packages/perimeter/src/registry/registration.ts` (`assertLiveApp`).

### APP_NOT_LIVE

The last step of `deploy` (`app.live`) sends `GET https://<hostname>/` every 3 seconds and reads the registry after each, until the row says `active` or 10 minutes pass (`DEFAULT_MAX_WAIT_MS = 600_000`). This code is the timeout in the case where the Gateway did answer the probe at some point, so a certificate isn't what's missing: the Gateway can't reach the app's Worker. Headline: `<app> isn't live after <Nm NNs>: the Gateway can't reach its Worker yet`, then `<app> stays uploaded and bound.` A timeout with no answer at all is the `CERT_PENDING` warning instead, and the run ends normally; `--no-wait` skips the wait.

**Fix:** `retryable: true`; `rerun`: `pnpm everyapp status`, `rerunNote`: `then deploy again`. No takeover.

Source: `packages/cli/src/commands/deploy/steps/waitForLive.ts`, called through `awaitLive` in `packages/cli/src/commands/appGateway.ts`.

### APP_POLICY

The app's Build Output (`.cloudflare/output/v0`) fails the app policy, checked before anything is uploaded: in `deploy` (step `app.build`) and `release`. Three headlines:

- ``The app's Build Output isn't a production build. The manifest's build command must run `cf build` (production by default).``
- `The app's Build Output has no default Worker. Build it from everyAppWorker() in cloudflare.config.ts.`
- `The built Worker can't be deployed as an EveryApp app:` followed by one `  - <problem>` line each, then `Build it from everyAppWorker() in cloudflare.config.ts.` The problems a Worker can have: its `name` isn't the Worker name the registry assigned; `workersDev` or `previewUrls` isn't `false`; it declares `domains`, routes (a `fetch` trigger) or any trigger other than `scheduled`; `EVERYAPP_DEV` is set; `EVERYAPP_IDENTITY_PUBLIC_KEYS` or `EVERYAPP_IDENTITY_ISSUER` isn't a built-in `text` binding; `EVERYAPP_AUDIENCE` isn't the Worker's name; a binding type outside `text`, `json`, `secret`, `version-metadata`, `assets`, `d1`, `kv`, `r2`, `durable-object`, `workflow`, `worker`, `hyperdrive`, `ai`, `browser`, `images`, `vectorize`, `send-email` and `analytics-engine-dataset`; an `analytics-engine-dataset` (Analytics Engine) binding under a name `resources.analyticsEngine` doesn't declare, or to a dataset other than the one it declares; a `send-email` binding under a name `resources.sendEmail` doesn't declare, or with other addresses than it declares; an `ai` (Workers AI) binding under a name `resources.ai` doesn't declare; a `browser` (Browser Rendering) binding under a name `resources.browser` doesn't declare; an `images` (Images) binding under a name `resources.images` doesn't declare; a `worker` binding to anything but the Gateway's `AppGateway` (binding `EVERY_APP_GATEWAY`) or, from the app's own Worker, its helper Workers; a `durable-object` or `workflow` binding to another Worker's; a `d1`, `kv` or `hyperdrive` binding the deploy didn't provision; a `vectorize` binding whose `name` isn't an index the deploy provisioned (`<BINDING> is Vectorize index "<name>", which isn't one the deploy provisioned`); an `r2` bucket outside the manifest's `resources.r2` (or, with none declared, not named after the Worker); a Workflow not named `<worker>--<name>`; a Durable Object export that is `transferred`, `expecting-transfer`, container-backed, or `deleted` without `--allow-delete-durable-object-data`; an export that isn't a Worker, Workflow or Durable Object; a built Worker `workers` doesn't declare, or a declared helper the build lacks.

The install step raises the same code when a Durable Object class the deploy would tombstone is still exported by the build: `Durable Object class <name> is both exported by the build and being deleted; declare it in everyapp.config.ts, or stop exporting it.`

**Fix:** none offered by the error: build the Worker from `everyAppWorker()` in `cloudflare.config.ts` and correct what the list names. No rerun; not retryable.

Source: `packages/cli/src/lib/app/policy.ts` (`prepareAppBuildOutput`, `appPolicyProblems`, `helperPolicyProblems`), `packages/cli/src/lib/app/installBuildOutput.ts` (`installWorkerConfig`).

### BUILD_FAILED

The app's production build failed (step `app.build` of `deploy` and `release`). The build runs with `EVERYAPP_BUILD=1`: `cf build` by default, or the manifest's `build` command. With `cf build`, the headline is `Build failed`, then `cf build's last lines:` and the tail of what it printed. With a manifest `build` command, the headline is `Build failed`, then `<command> exited with code <n>. Its last lines:`, the tail, and `Full log: <path>` (`$TMPDIR/everyapp/<name>-<time>-<pid>.log`), with `data.command`, `data.exitCode`, `data.tail` and `data.log`. A `cf build` that runs past 10 minutes is a `CfTimeoutError`, reported as `CF_TIMEOUT`, not this code.

**Fix:** none offered: fix the build error in the tail or the log. No rerun; not retryable. `--verbose` streams the build's output to stderr.

Source: `packages/cli/src/lib/app/buildApp.ts`, `packages/cli/src/lib/childLog.ts` (`runLogged`).

### CAPABILITY_UNKNOWN

`deploy` (and `install`), right after the Gateway is reached and before anything is registered: the manifest lists a capability id that neither the built-in catalog nor the providers registered on this Gateway (`everyapp provider list`) have. Before connecting, everyapp accepts any well-formed id, since it may be a registered provider. Message `<app> lists <ids> under capabilities, which <gateway host> doesn't offer` then `Neither the built-in catalog nor the providers registered on this Gateway has it. It offers: <ids>.`

**Fix:** `data.fix`: `register it with pnpm everyapp provider add <spec.json or https URL> (or fix the id in everyapp.config.ts), then deploy again`; `data.unknown` (the ids), `data.offered`. No rerun, not retryable.

Source: `packages/cli/src/commands/deploy/deployApp.ts` (`checkCapabilitiesOffered`)

### CHECKOUT_MISSING

everyapp isn't running from a checkout of the EveryApp repository: no directory above the CLI's module holds both `apps/every-app-gateway/scripts/build-release.ts` and `packages/cli/package.json`. Raised by `create` (the starter template it copies comes from the checkout) and by every Gateway deploy (`checkoutGateway` in `lib/gateway/checkoutRelease.ts` builds the Gateway's release from the checkout: `setup`, `update`, and the rebind `deploy` and `delete` run). `status` uses the nullable `findCheckoutRoot` and skips the checkout comparison outside one. Headline: `everyapp has to run from a checkout of the EveryApp repository`, then `This copy is installed in <package dir>, outside any checkout.`

**Fix:** `fix`: `in your checkout, run pnpm everyapp <the same arguments>`. No rerun; not retryable.

Source: `packages/cli/src/lib/checkout.ts` (`checkoutRoot`, `findCheckoutRoot`), called from `packages/cli/src/commands/create/index.ts`, `packages/cli/src/lib/gateway/checkoutRelease.ts`, `packages/cli/src/commands/status/index.ts`.

### CLI_TOO_OLD

A release's `release.json` names a `minCli` newer than this everyapp (`compareVersions`: dotted parts compared numerically, a leading `v` and prerelease suffixes ignored), so it is refused before anything changes. Headline: `<what> needs everyapp <minCli> or newer (this is <cliVersion>)`, where `<what>` is `Gateway <version>` for a Gateway release and `<appId> <version>` for an app release; `data.minCli`, `data.cliVersion`. Raised by `setup` and `update` (the source's `minCli` before anything is asked, then the opened release), by the Gateway rebind that `deploy` and `delete` run (`lib/gateway/reconcile.ts`), and by `install <source>` opening an app release (`lib/app/release.ts`; app releases are packed with `minCli: "0.3.0"`).

**Fix:** `fix`: `update everyapp (in a checkout: git pull), then run this again`. No rerun; not retryable.

Source: `packages/cli/src/lib/gateway/release.ts` (`refuseNewerThanCli`), called from `packages/cli/src/commands/setup/runSetup.ts`, `packages/cli/src/lib/gateway/reconcile.ts`, `packages/cli/src/lib/app/release.ts`.

### CLOUDFLARE_LOGIN_FAILED

cf's login didn't leave cf logged in. Raised anywhere a command logs in (`login`, `setup`, and every Gateway command through `lib/gateway/connect.ts`), in two situations:

- After `cf auth login` at a terminal, or the device login, `cf auth whoami` still says `authenticated: false`. Headline: `Cloudflare login didn't complete`. `rerun`: `pnpm everyapp login`; not retryable.
- The unattended device login (`cf auth login --no-browser`) failed or ran out of time. `logIn` runs it whenever nobody is at a terminal and the caller passed `onDeviceLogin`: `setup` (`runSetup.ts`) and the Gateway commands (`lib/gateway/connect.ts`) pass it only under `--json`; `login` passes it always, so `pnpm everyapp login` piped or under `CI` runs it without `--json` too (a Gateway command with no terminal and no `--json` gets the `cloudflare_login` action instead, and no login runs). cf's link and code go out first as the `cloudflare_login` action (`data.url`, `data.code`, `data.expiresAt`, `waiting: true`), then cf waits 5 minutes for the approval (`DEVICE_LOGIN_TIMEOUT_MS`, cf's own cap). Headline: `Cloudflare login timed out after 5m`, then `Or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.`, or `Cloudflare login didn't complete` with the error under it. `retryable: true`, `rerun`: `pnpm everyapp login`.

**Fix:** run `pnpm everyapp login` again, or for unattended runs set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. No takeover.

Source: `packages/cli/src/lib/cf/account.ts` (`logIn`, `deviceLogin`), `packages/cli/src/commands/login/index.ts`.

### CLOUDFLARE_TOKEN_REJECTED

`CLOUDFLARE_API_TOKEN` is set, and `cf auth whoami` says cf isn't authenticated with it, so no login is attempted (cf would use the token). Headline: `Cloudflare didn't accept CLOUDFLARE_API_TOKEN`, then `It may be mistyped, expired or revoked.` and `A token needs Account › Workers Scripts › Edit, Account › D1 › Edit, Account › Workers KV Storage › Edit, Zone › Zone › Read and Zone › DNS › Read: https://dash.cloudflare.com/profile/api-tokens`. Raised by every command that logs in.

**Fix:** `fix`: `set a valid token, or unset CLOUDFLARE_API_TOKEN and run pnpm everyapp login`. No rerun; not retryable.

Source: `packages/cli/src/lib/cf/account.ts` (`logIn`).

### CONFIRMATION_REQUIRED

A step needs a person's yes, `--yes` wasn't given, and nobody is at a terminal (`--json`, `CI` set, or stdin/stderr not a TTY): the run refuses instead of guessing. The message is the step's own `unattended` text. At a terminal the same step asks a `(y/N)` question, and No is `CANCELLED` (exit 1), not this code.

| Command                                                 | Headline                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `access off`                                            | `Turning Access off needs confirmation at a terminal, or --yes` (raised after connecting and reading the Gateway's settings and the Access applications; with nothing to turn off the run ends with `Cloudflare Access isn't in front of <host>. Nothing changed.` instead. At a terminal: `Turn Cloudflare Access off for <host>?`, No is `Cancelled. Access stays on.`)                                                     |
| `signin remove <id>`                                    | `Turning Sign in with <label> off needs confirmation at a terminal, or --yes` (raised after connecting and reading which of the provider's settings the Gateway holds; with none, the run ends with `Sign in with <label> isn't set up; nothing changed.` instead; `data.provider`, `data.names`. At a terminal: `Turn Sign in with <label> off?`, No is `Cancelled. Sign in with <label> stays as it was.`)                  |
| `db query` against production, SQL that isn't read-only | `This SQL can change <app>'s production database` / `A person at a terminal confirms it first, or --yes does.`                                                                                                                                                                                                                                                                                                                |
| `db restore`                                            | `Restoring <app>'s database needs a person at a terminal to confirm, or --yes` / `It undoes <n> migration(s) (<names>) applied <time> ago by <who>; anything written to it since is lost too.` (`the Gateway's database` instead of `<app>'s database` with `--gateway`; `<who>` is `an API token` for a restore point an API token saved; `data`: `appId`, `databaseId`, `bookmark`, `migrations`, `createdAt`, `createdBy`) |
| `delete <app>`                                          | `Deleting an app needs confirmation at a terminal, or --yes`                                                                                                                                                                                                                                                                                                                                                                  |
| `secret unset`                                          | `Removing secrets needs confirmation, and there's no terminal to ask in`                                                                                                                                                                                                                                                                                                                                                      |
| `workspace remove <email>`                              | `Removing a member needs confirmation at a terminal, or --yes` (raised after the member is found; `data`: `userId`, `email`. At a terminal: `Remove <email> from <organization>?`, No is `Cancelled. Nothing removed.`)                                                                                                                                                                                                       |
| `workspace group delete <group>`                        | `Deleting a group needs confirmation at a terminal, or --yes` (raised after the group is found; `data`: `groupId`, `name`. At a terminal: `Delete the group <name>?`, No is `Cancelled. Nothing deleted.`)                                                                                                                                                                                                                    |

**Fix:** takeover: `rerun` is this same command with `--yes`, and `data.authorize: true`. Show the message and ask the person before rerunning with `--yes`. Not retryable.

Source: `packages/cli/src/lib/output/prompt.ts` (`confirmUnlessYes`), called from `packages/cli/src/commands/access/index.ts` (`turnAccessOff`), `packages/cli/src/commands/db/index.ts`, `packages/cli/src/commands/db/restore.ts`, `packages/cli/src/commands/delete/index.ts`, `packages/cli/src/commands/secret/index.ts`, `packages/cli/src/commands/workspace/index.ts` (`removeMember`), `packages/cli/src/commands/workspace/groups.ts` (`deleteGroup`).

### CONNECTION_NOT_FOUND

`workspace connection revoke <id>`: no AI connection (`mcp_connections` row) with that id belongs to the organization. One revoked already is not an error: the command says so (`data.already: true`). Headline: `No AI connection <id> in <organization>`.

**Fix:** `rerun`: `pnpm everyapp workspace connections`, `rerunNote`: `lists them by id`.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`revokeConnection`).

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

### EVENT_DELIVERY_NOT_FOUND

`events redeliver <delivery>`: no delivery with that id in the organization the command acts on (`--org`, else the install organization), within the 30 days the log is kept: a mistyped id, another organization's, or one the hourly maintenance has deleted. Every read carries the organization's id, so another organization's delivery reads as missing. Headline: `No delivery <id> in <organization>`, then `Deliveries are kept 30 days, under the organization of their subscription.`

**Fix:** `rerun`: `pnpm everyapp events deliveries` (`rerunNote` `lists the last ones`). Not retryable.

Source: `packages/cli/src/lib/gateway/events.ts` (`redeliver`).

### EVENT_SECRET_INVALID

`events add <url> --secret` (or `--secret-from-env <VAR>`): the signing secret read from the hidden prompt, stdin or the variable won't do: shorter than 16 or longer than 128 characters (`EVENT_SECRET_MIN_LENGTH`, `EVENT_SECRET_MAX_LENGTH` in `@every-app/sdk/internal`), or not all printable ASCII without spaces (`!` to `~`), so that every receiver's HMAC reads the same bytes. Checked after the URL and before anything is written; the secret is never shown back. Headline: `That signing secret won't do`, then `A signing secret is 16 to 128 characters (this one is <n>).` or `A signing secret is printable ASCII with no spaces, so every receiver's HMAC reads the same bytes.`

**Fix:** `fix`: `leave --secret out and the CLI makes one, or give one of 16 to 128 printable characters`. Not retryable.

Source: `packages/cli/src/lib/gateway/events.ts` (`checkedSecret`).

### EVENT_SINK_CONFLICT

`events add`: the arguments don't name one way to deliver. Three headlines, checked before anything connects:

- A URL and `--email` together: `Give a webhook URL or --email, not both`, then `A subscription delivers one way: a signed POST to a URL, or mail to the organization's owners (and admins).`; `fix`: `add one subscription for each`.
- `--email` with `--secret` or `--secret-from-env`: `An email subscription has no signing secret`, then `Only a webhook is signed; mail goes from the Gateway's own sender to the organization's members.`; `fix`: `leave --secret out`.
- Neither a URL nor `--email`: `Name where events go: a webhook URL, or --email owners|admins`; `rerun`: `pnpm everyapp events add https://hooks.example.com/everyapp` (`rerunNote` `or --email admins`).

**Fix:** as each says. Not retryable.

Source: `packages/cli/src/commands/events/add.ts` (`addEvents`).

### EVENT_SUBSCRIPTIONS_LIMIT

`events add` in an organization that has 25 subscriptions already (`EVENT_SUBSCRIPTIONS_MAX`), built-in and disabled ones included. The insert counts them itself (`INSERT … SELECT … WHERE (SELECT COUNT(*) …) < 25`), so two adds at once can't make a 26th. Nothing is written. Headline: `<organization> has 25 subscriptions, the most an organization may have`, then `Nothing was added.`

**Fix:** `fix`: `remove one you no longer need (pnpm everyapp events remove <id>), or widen one's --events instead of adding another`; `rerun`: `pnpm everyapp events list` (`rerunNote` `lists them`). Not retryable.

Source: `packages/cli/src/lib/gateway/events.ts` (`addSubscription`).

### EVENT_SUBSCRIPTION_DISABLED

`events test <id>` on a subscription that is disabled, or `events redeliver <delivery>` of a delivery whose subscription is: the Gateway drops what is queued for a disabled subscription (`subscription_gone`), so the ping or the redelivery would go nowhere. Nothing is written. Headline: `<name> (<id>) is disabled`, then `The Gateway drops what is queued for a disabled subscription, so a test|sending it again would go nowhere.`

**Fix:** `rerun`: `pnpm everyapp events enable <id>` (`rerunNote` `then run this again`). Not retryable.

Source: `packages/cli/src/lib/gateway/events.ts` (`subscriptionDisabled`), `packages/cli/src/commands/events/ping.ts`.

### EVENT_SUBSCRIPTION_NOT_FOUND

`events remove|enable|disable|test <id>` or `events deliveries <id>`: no subscription with that id in the organization the command acts on (`--org`, else the install organization). Every read and write carries the organization's id, so another organization's subscription reads as missing. Headline: `No subscription <id> in <organization>`, then `Subscriptions belong to one organization; --org names another.` From `events redeliver <delivery>`, when the delivery's subscription was removed since: `<delivery> was for <subscription>, which is removed`, then `There is nowhere to send it again.`

**Fix:** `rerun`: `pnpm everyapp events list` (`rerunNote` `lists them`, or `lists the subscriptions there are`). Not retryable.

Source: `packages/cli/src/lib/gateway/events.ts` (`findSubscription`, `redeliver`).

### EVENT_TARGET_REFUSED

`events add <url>`: the URL breaks the Gateway's target rules (`checkEventTarget` in `packages/cli/src/lib/gateway/eventTarget.ts`, the CLI's copy of the Gateway's `server/events/target.ts`, which checks the stored URL again before every attempt). Checked after connecting (the rules need the install row's Gateway host and apps' domain, and the names of the Gateway Worker's settings) and before a secret is read or anything is written. Headline: `The Gateway won't deliver to that URL`, then one reason; the URL is never repeated, so a password typed into one isn't shown:

| The URL                                                                                                                                                 | Reason                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| longer than 2,048 characters                                                                                                                            | `A webhook URL is at most 2,048 characters.`                                                                               |
| not a URL                                                                                                                                               | `It isn't a URL: give the whole address, like https://hooks.example.com/everyapp.`                                         |
| `http:`                                                                                                                                                 | `A webhook URL starts with https://: the event and its signature would cross the internet in the clear.`                   |
| another scheme                                                                                                                                          | `A webhook URL starts with https://, not <scheme>//.`                                                                      |
| a user name or password                                                                                                                                 | `A webhook URL carries no user name or password: the subscription's secret signs each delivery instead.`                   |
| a fragment                                                                                                                                              | `A webhook URL has no fragment (#…): it is never sent to the receiver.`                                                    |
| an IPv4 (in any spelling) or IPv6 literal                                                                                                               | `A webhook URL names its host, not an IP address.`                                                                         |
| the Gateway's host, or the apps' domain or anything under it                                                                                            | `<host> is the Gateway's own host, or under its apps' domain <domain>: a delivery there would loop back into the Gateway.` |
| `localhost`, `local`, `internal`, `home.arpa`, `onion`, `localdomain`, `intranet`, `lan`, `corp`, `private` or a name under one, or a name of one label | `<host> is a local or internal name, which the Gateway's Worker can't reach.`                                              |

With `EVENTS_ALLOW_PRIVATE_TARGETS` set on the Gateway Worker (the CLI can read only that it is set; the Gateway honours it when its value is `true`), `http:`, IP literals and the private names are let through; the Gateway's own hosts never are. A hosted Gateway also refuses its third-party domain (`THIRD_PARTY_DOMAIN`), a setting whose value the CLI can't read, so a URL under it is added and each attempt is refused with `target_refused`.

**Fix:** for `http:`, an IP literal or a private name, `fix`: `use a public https:// receiver; for one on a private network, set EVENTS_ALLOW_PRIVATE_TARGETS on the Gateway (pnpm everyapp secret set EVENTS_ALLOW_PRIVATE_TARGETS, value true; self-host only)`; otherwise `fix`: `give the receiver's full https:// URL (Slack's, Zapier's, n8n's, your own)`. Not retryable.

Source: `packages/cli/src/lib/gateway/eventTarget.ts` (`checkEventTarget`), `packages/cli/src/lib/gateway/events.ts` (`webhookUrl`); the private names are `EVENT_PRIVATE_NAME_SUFFIXES` in `packages/sdk/src/internal/events.ts` (`isPrivateEventTargetName`), the one list the Gateway's rules use too.

### EVENT_TEST_TIMEOUT

`events test <id>` without `--no-wait`: the ping it queued wasn't attempted within 90 seconds (`TEST_WAIT_MS`). The CLI never calls the receiver: the Gateway's per-minute sweep sends queued deliveries, and a Gateway installed before events (no per-minute trigger) sends them hourly at best, or not at all before `update`. The ping stays queued. Headline: `The Gateway hasn't sent the test event in 1m 30s`, then `It stays queued. The Gateway sends queued events every minute; one installed before events were added sends them hourly at best until it is updated.`; `data.subscriptionId`, `data.eventId`, `data.deliveryId`.

**Fix:** `fix`: `if the Gateway is older than this CLI, update it (pnpm everyapp update)`; `rerun`: `pnpm everyapp events deliveries <id>` (`rerunNote` `shows whether it went since`). Not retryable: running the test again queues another ping.

Source: `packages/cli/src/commands/events/ping.ts` (`testEvents`), `packages/cli/src/lib/gateway/events.ts` (`waitForDelivery`).

### EVENT_TYPE_UNKNOWN

`events add --events <types>`: an entry that is no event type in the catalogue (`EVENT_TYPES` in `@every-app/sdk/internal`), no prefix of one (`member.*`), not an app's own events (`app.<app id>.*`, `app.<app id>.<name>`) and not `*` (`eventPatternProblem`). Every entry is checked before anything connects, and all the refused ones are named. Headline: `<entry> isn't an event type` (or `<n> of --events aren't event types`), then each entry's reason; `data.patterns` lists them.

**Fix:** `fix`: `name types (member.joined), prefixes (member.*), an app's own events (app.crm.*) or * for everything`; `rerun`: `pnpm everyapp events types` (`rerunNote` `lists the types`). Not retryable.

Source: `packages/cli/src/lib/gateway/events.ts` (`eventPatterns`), `packages/sdk/src/internal/events.ts` (`eventPatternProblem`).

## Error codes F–R

The codes below follow the defaults in `packages/cli/src/lib/errors.ts`: an error event has no `data.rerun` unless its raise site sets one or the error is `retryable: true` (then `data.rerun` is this same command as typed, `--json` included when the run had it, built by `thisCommand()`: run it as it is); `data.authorize: true` is set only for the takeover flags in `TAKEOVER_FLAGS`, and no code in this range is one of them, so none of these reruns needs a person's yes. Each entry says whether the code is `retryable`; a `data.fix` is a remedy in words, `data.rerun` a command to run, `data.rerunNote` what follows it. Angle brackets inside quoted messages stand for values filled in at run time.

### FLAGS_CONFLICT

`workspace group members`, `workspace group apps` and `workspace app access`: `--set` was given with `--add` or `--remove`. `--set` replaces the whole list; `--add` and `--remove` change it, and may go together. Checked before anything connects. Headline: `--set replaces the whole list: give it alone, or --add and --remove without it`.

**Fix:** none offered; no rerun; not retryable.

Source: `packages/cli/src/commands/workspace/shared.ts` (`listChange`).

### GATEWAY_BUILD_FAILED

Building the Gateway's release from this checkout failed (step `gateway.release`; raised by `setup`, and by `deploy`, `install` and `delete` when they rebind a Gateway from the checkout). The build is two children, `pnpm --filter @every-app/sdk build` at the root, then `pnpm run build:release` in `apps/every-app-gateway`; the first to exit non-zero raises this. Headline: `Building the Gateway failed`, then `<command> exited with code <n>. Its last lines:` (or `was stopped by <signal>`), the last 20 lines indented, and `Full log: $TMPDIR/everyapp/gateway-build-<time>-<pid>.log`; `data.command`, `data.exitCode`, `data.tail`, `data.log`. Under `--json`, after the `gateway.release` start event (`Building the Gateway from this checkout (usually 1–2m)`) nothing more arrives until the build ends: give it the time.

**Fix:** `fix`: `fix the build error above, then run this again` (a type error in the checkout, a missing dependency after `git pull` without `pnpm install`, a blocked build script). No rerun; not retryable. `--verbose` echoes the child's output as it runs. On Linux, `connect ECONNREFUSED 127.0.0.1` inside the build is on [troubleshooting](/docs/agent/troubleshooting), "Build fails with `connect ECONNREFUSED 127.0.0.1` on Linux".

Source: `packages/cli/src/lib/gateway/checkoutRelease.ts` (`buildReleaseFromCheckout`), `packages/cli/src/lib/childLog.ts` (`runLogged`).

### GATEWAY_NOT_FOUND

`requireGateway()` found no Gateway to act on after probing every Cloudflare account the login lists (`cf auth whoami`, then `cf d1 list --name every-app-gateway` per account; an account cf refuses or doesn't know counts as having none). Raised by every self-host command that connects to the Gateway through `connectToGateway()` (`deploy`, `install`, `delete`, `db query` without `--local`, `db restore`, `secret`, `email`, `access on|off|show`, `mcp` (every subcommand), `events` but `events types`), by `status`, and by `update`. When the login lists accounts and none has a Gateway, `deploy` and `install` offer to install one instead, whether or not `--account-id` named one (at a terminal; otherwise `action_required install_gateway`; `connectToGateway()`'s `onNoGateway`), and `status` emits `install_gateway` unless an account was named (`existingGateway()`); so from `deploy` or `install` this code means the login lists no accounts, or the named account has none while another account does; from `status`, also that `--account-id` named an account and no account has one. Three messages:

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

### GATEWAY_OUTDATED

An `events` command (every one but `events types`) against a Gateway whose D1 predates migration `0012_events` (2026-10-25): it has no `events`, `event_subscriptions` or `event_deliveries` table (`hasEventsTables`, one `PRAGMA table_info(events)` per run). Also `workspace audit` against a Gateway whose D1 predates migration `0015_audit_actor`: its `events` table has no `actor_kind` and `actor_id` columns (`hasAuditColumns`, the same PRAGMA). Headline then: `The Gateway predates the audit log`, then `Its events table has no actor columns until the Gateway is updated to a release that has them.` Raised after connecting, before anything is read or written. The commands that only queue an event alongside their own change (`deploy`, `install`, `delete`, `access on|off`, `mcp on|off`, `configure`, `secret set|unset`) never raise it: on such a Gateway they queue nothing and go on. Headline: `The Gateway predates events`, then `Its database has no event tables until the Gateway is updated to a release that has them.`

**Fix:** `rerun`: `pnpm everyapp update` (`rerunNote` `then run this again`), which applies the Gateway's migrations. Not retryable.

Source: `packages/cli/src/lib/gateway/events.ts` (`requireEventsTables`, `requireAuditColumns`).

### GATEWAY_PREDATES_AI_DEFAULT

`ai default` against a Gateway whose D1 predates migration `0017_ai_default_and_usage_models` (2026-10-25): `org_settings` has no `ai_default` column, so there is nowhere to store the choice (`ai show` reads it as no choice meanwhile).

**Fix:** `rerun`: `pnpm everyapp update` (`rerunNote` `then run this again`), which applies the Gateway's migrations. Not retryable.

Source: `packages/cli/src/lib/gateway/aiDefault.ts` (`requireAiDefault`).

### GATEWAY_PREDATES_COST_CAPS

`workspace app cap --usd` and `workspace cap default --usd` against a Gateway whose D1 predates migration `0018_cost_caps` (2026-10-25): it has no `org_app_settings.monthly_cost_cap_micros` or `org_settings.default_monthly_cost_cap_micros` column (`hasCostCaps`, one batch of two `PRAGMA table_info` per run). Raised after connecting, before anything is written; a number of calls, `off` and `--unlimited` never raise it, and `workspace usage` reads the dollar fields as null there. Headline: `The Gateway predates dollar caps`, then `Its database has no monthly cap in dollars until the Gateway is updated to a release that has it.`

**Fix:** `rerun`: `pnpm everyapp update` (`rerunNote` `then run this again`), which applies the Gateway's migrations. Not retryable.

Source: `packages/cli/src/lib/gateway/costCaps.ts` (`requireCostCaps`).

### GATEWAY_PREDATES_DEFAULT_CAPS

`workspace cap default`, `workspace app cap --unlimited` and `workspace usage` against a Gateway whose D1 predates migration `0014_caps_defaults` (2026-10-25): it has no `org_settings` table and no `org_app_settings.unlimited` column (`hasDefaultCaps`, one batch of two `PRAGMA table_info` per run). Raised after connecting, before anything is written; `workspace app cap <app> <n|off>` never raises it (on such a Gateway it writes the cap alone, as before the column). Headline: `The Gateway predates default caps`, then `Its database has no workspace default cap and no no-cap override until the Gateway is updated to a release that has them.`

**Fix:** `rerun`: `pnpm everyapp update` (`rerunNote` `then run this again`), which applies the Gateway's migrations. Not retryable.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`requireDefaultCaps`).

### GATEWAY_URL_MISMATCH

`--gateway` and `EVERYAPP_GATEWAY_URL` only pick among several Gateways; the URL a command uses always comes from the install row. `checkGatewayUrl()` raises this when the host they name (compared lowercase) isn't the found Gateway's `gateway_host`. Raised by every command through `connectToGateway()` (`deploy`, `install`, `delete`, `db query`, `db restore`, `secret`, `email`, `access on|off|show`, `mcp` (every subcommand), `events` but `events types`). Message `The Gateway here is <found host>, not <requested host>` then `Found in <account>. For <requested host>, pass its account with --account-id.`

**Fix:** when the host came from `--gateway` on the command line, `data.rerun` is this command without `--gateway` and its value (`thisCommandWithout()`), `data.rerunNote` `to use <found host>`; when it came from the environment, `data.fix` is `unset EVERYAPP_GATEWAY_URL to use <found host>`. Not retryable.

Source: `packages/cli/src/lib/gateway/discover.ts`, `packages/cli/src/lib/gateway/connect.ts`

### GROUP_NAME_INVALID

`workspace group create <name>` and `workspace group set --name <name>`: the name, trimmed, is empty or longer than 60 characters, the Gateway's own rule. Checked before the write. Headline: `A group name is 1 to 60 characters (<n> given)`.

**Fix:** none offered; no rerun; not retryable.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`groupName`).

### GROUP_NAME_TAKEN

`workspace group create <name>` and `workspace group set --name <name>`: the organization has a group with that name, letter case aside (the Gateway's `groups_organization_name_unique` index is on `lower(name)`). Held on the write (`INSERT … WHERE NOT EXISTS`, `UPDATE … WHERE NOT EXISTS`), so two creates racing each other make one group. Headline: `A group named "<name>" exists already in this organization`.

**Fix:** `rerun`: `pnpm everyapp workspace groups`, `rerunNote`: `lists them`.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`createGroup`, `updateGroup`).

### GROUP_NOT_FOUND

`workspace group set/delete/members/apps <group>`: no group of the organization has that name (letter case aside) or `grp_` id. Headline: `No group named <group> in <organization>`.

**Fix:** `rerun`: `pnpm everyapp workspace groups`, `rerunNote`: `lists them`.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`findGroup`).

### HELPER_DURABLE_OBJECT_REMOVED

`deploy`, in `checkDurableObjects()` right after taking the app's lease and before any resource is touched: the last deployed manifest declared a Durable Object class with a `worker` (a helper Worker), and the new `everyapp.config.ts` no longer declares that class. Removing a helper Worker's class isn't supported, and `--allow-delete-durable-object-data` doesn't cover it (that flag covers classes on the app's own Worker: `DURABLE_OBJECT_REMOVED`). Message `The helper Worker <worker> still defines <class>` then `Removing a helper Worker's Durable Object class isn't supported yet.`

**Fix:** `data.fix`: `keep declaring <class> in everyapp.config.ts`. No rerun, not retryable.

Source: `packages/cli/src/commands/deploy/deployApp.ts`

### HYPERDRIVE_ORIGIN_MISSING

Self-host `deploy` (step `app.resources`) has to create the Hyperdrive config for a `resources.hyperdrive` binding and the app's secrets file `.everyapp/secrets.env` holds no origin for it: neither `<BINDING>_ORIGIN_URL` nor, when it is the app's only Hyperdrive config, `POSTGRES_DATABASE_URL`. The origin is the binding's required setting, read only on the machine that deploys. The deploy creates a config whenever no config under the binding's name can be used: none is recorded as the app's and none in the account has the name; the recorded one (by id) was deleted and nothing else has the name (a `RESOURCE_RECREATED` warning comes first); or the record has no id (a claim whose create was never recorded) and nothing has the name. A first deploy stops here after registering the app, so `pnpm everyapp status` lists it as [`APP_NOT_UPLOADED`](#app_not_uploaded) with the same variable and file. Message `<binding> needs the database its Hyperdrive config connects to` then `Creating the config needs its URL, from .everyapp/secrets.env on the machine that deploys; nothing in that file reaches the Worker.`

**Fix:** `data.fix` names the variable for this app: `set POSTGRES_DATABASE_URL (or <BINDING>_ORIGIN_URL) in .everyapp/secrets.env to postgres://<user>:<password>@<host>:<port>/<database>` when the binding is the app's only config, `set <BINDING>_ORIGIN_URL in .everyapp/secrets.env to …` when it has several. `data.binding` is the binding, `data.variables` the variables in that order (the first is the one to set), `data.file` `.everyapp/secrets.env`; `data.rerun` is this same command. Not retryable. The person writes the file (`everyapp configure` doesn't); never ask for or print the value. Which URL and why: [Postgres](/docs/agent/manifest#postgres).

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

Installing the Build Output for a self-host deploy (`installWorkerConfig()`, step `app.build`): a Worker's config binds a D1, KV, Hyperdrive or R2 resource whose `name` (D1, R2) or `id` (KV, Hyperdrive) is still that binding's build placeholder (`resourceSentinel(binding)`), but the deploy provisioned no resource of that kind under that binding, which is what happens when `cloudflare.config.ts` binds something `everyapp.config.ts` doesn't declare. Message `The build binds <D1 database|KV namespace|Hyperdrive config|R2 bucket> <binding>, which the deploy didn't provision`. The same for a `json` binding whose `value.id` is its binding's placeholder (an AI Gateway's) when `resources.aiGateway` declares no gateway of that binding: `The build binds AI Gateway <binding>, which the deploy didn't provision`, `data.fix` `declare it in everyapp.config.ts's resources.aiGateway`.

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

`everyapp create <name or path>`: the name given isn't a valid app id (without a name, the prompt validates inline instead). A path (`../My_App`) is named after its last part, checked the same way; the message then has a second line, `An app is named after the last part of its path, <path as given>.` Rules: at most 64 characters; no `--` (it separates a Worker's name from its resources' names); `^[a-z]([a-z0-9-]*[a-z0-9])?$`; not reserved (`everyapp`, which prefixes the Gateway's own MCP tools, or a name whose Worker name is the Gateway's `every-app-gateway`: `workerNameFor()` prefixes `every-` unless the name already starts with it, so `app-gateway` and `every-app-gateway` are both reserved). Headline `"<name>" isn't a valid app name`, or `"<name>" is reserved for the platform`.

**Fix:** `data.fix` names the rule: `use 64 characters or fewer`; `don't put two dashes in a row, e.g. <name with each dash run collapsed>`; `use lowercase letters, digits and dashes, e.g. <slug>` when a slug can be made, else `use lowercase letters, digits and dashes, starting with a letter`; `pick another name` for a reserved one. No rerun, not retryable.

Source: `packages/cli/src/commands/create/steps/appId.ts`, `packages/perimeter/src/manifest/manifest.ts`

### INVALID_BUILD_OUTPUT

`validateWorkerConfig()` refused a `worker.config.json`. It runs on the Gateway's patched config before `cf` sees it, and on every app Worker's config in the app policy (`prepareAppBuildOutput()`: `deploy`, `release`, release deploys). Three messages: `The patched Worker config isn't valid Build Output: <path>: <issue>; …` (`@cloudflare/config`'s `OutputWorkerSchema`, every issue listed); `The Worker config still has a deploy-time placeholder.` (the string `__EVERYAPP_PATCH__` is still in it); and, for the Gateway only, `The gateway has no domain to deploy to.`

**Fix:** none offered; not retryable.

Source: `packages/cli/src/lib/gateway/patchBuildOutput.ts`, `packages/cli/src/lib/app/policy.ts`

### INVALID_CAP

`workspace app cap <app> <n|off>` and `workspace cap default <n|off>`: the cap isn't a whole number from 1 to 1,000,000,000 (`MONTHLY_CALL_CAP_MAX`, the Gateway's bound), or `off`; or `--usd` isn't dollars from 0.01 to 1,000,000 in whole cents, or `off` (`A monthly dollar cap is from $0.01 to $1,000,000 in whole cents, or off`). The command line's parser refuses most such values first, as `INVALID_VALUE` (exit 252); this is the library's own check behind it. Headline: `A monthly cap is a whole number from 1 to 1,000,000,000, or off`. The library also raises it when a cap and `unlimited` reach it together (`An app has a cap or no cap, not both`), or neither cap nor `unlimited` (`Missing the cap`, `Missing the default`), which the command refuses first as `INVALID_VALUE` and `MISSING_ARGUMENT`.

**Fix:** none offered; no rerun; not retryable.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`setMonthlyCap`, `setDefaultMonthlyCap`), `packages/cli/src/lib/gateway/costCaps.ts` (`costCapMicros`), `packages/cli/src/commands/workspace/command.ts` (`parseCap`, `parseUsd`).

### INVALID_DEV_MODE

`everyapp dev`: `--mode`, or `EVERYAPP_DEV_MODE` when the flag is absent, isn't `stub` or `mirror` (compared lowercase). Message `--mode must be stub or mirror, not "<value>"` (or `EVERYAPP_DEV_MODE must be stub or mirror, not "<value>"`) then `stub signs you in as a seeded dev user; mirror uses real login through a local Gateway.`

**Fix:** pass one of the two. No `data.fix`, no rerun, not retryable.

Source: `packages/cli/src/commands/dev/mode.ts`

### INVALID_DOMAIN

`normalizeHostname()` refused a hostname. The input is trimmed, lowercased and stripped of `http://` or `https://`, anything from the first `/`, `?` or `#`, and a trailing dot; what is left must be at least two labels of `[a-z0-9]` and `-` (1 to 63 characters each, no leading or trailing dash), 253 characters at most. `normalizeHostname()`'s own message is `<value> isn't a full hostname`, but its only callers are in `setup`'s `runSetup.ts`, and the form that surfaces is `domainFlag()`'s re-raise under the same code, `--domain <value> isn't a full hostname`: from `everyapp setup --domain <value>`, and from the Gateway install that `deploy` offers, which passes `apps.<zone>` (always a hostname) the same way. The interactive address prompt's `validate` catches it and asks again (`Enter a hostname like apps.<zone>`), and the call on the prompt's answer runs after that check.

**Fix:** `data.fix`: `use a name like apps.example.com`. No rerun, not retryable.

Source: `packages/cli/src/lib/domains/hostnames.ts`, `packages/cli/src/commands/setup/runSetup.ts`

### INVALID_GATEWAY_URL

`--gateway <value>`, or `EVERYAPP_GATEWAY_URL` without the flag, isn't a URL `new URL()` parses (a valid one is normalized: trailing slashes, query and fragment dropped). Raised by every command that reads them (`deploy`, `install`, `delete`, `db query`, `db restore`, `secret`, `email`, `access on|off|show`, `mcp` (every subcommand)). Messages: `--gateway must be a full URL, not "<value>"` then `For example https://apps.example.com.`; or `EVERYAPP_GATEWAY_URL must be a full URL, not "<value>"`.

**Fix:** for the environment variable, `data.fix`: `set it to https://<value without its scheme>, or unset it`; for the flag, nothing beyond the message. No rerun, not retryable.

Source: `packages/cli/src/lib/gateway/connect.ts`

### INVALID_MANIFEST

`everyapp.config.ts` loaded, but `validateManifestStrict()` (`@every-app/perimeter/manifest`) threw a `ManifestError`. `everyapp dev` raises it itself: `everyapp.config.ts isn't valid` then the validator's message. In every other command the `ManifestError` propagates and `reportFailure()` reports it under this code with the validator's message alone (`knownFailure()` in `lib/output/report.ts`).

The registry raises the same code (a `RegistrationError`, status 400, passed through `lib/gateway/registry.ts` and answered by the Gateway's deploy API) when the manifest it is handed fails `validateManifest` (the validator's message, else `Invalid manifest`), when its `id` isn't the app id being registered (`manifest.id "<id>" does not match appId "<appId>"`), or when a `resources.r2` binding's bucket name is one Cloudflare refuses (`resources.r2: <binding> would be the R2 bucket "<name>", which Cloudflare refuses (at most <n> lowercase letters, digits and hyphens, starting and ending with a letter or digit). Rename the binding in everyapp.config.ts.`).

**Fix:** correct what the message names in `everyapp.config.ts`. No `data.fix`, no rerun, not retryable.

Source: `packages/cli/src/commands/dev/index.ts`, `packages/cli/src/lib/output/report.ts`, `packages/cli/src/lib/manifest.ts`, `packages/perimeter/src/registry/registration.ts`

### INVALID_MONTH

`workspace usage --month <month>`: the month isn't written `YYYY-MM`. The command line's parser refuses it first, as `INVALID_VALUE` (exit 252); this is the library's own check behind it. Headline: `--month <month> isn't a month: use YYYY-MM`.

**Fix:** none offered; no rerun; not retryable.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`usage`), `packages/cli/src/commands/workspace/command.ts` (`parseMonth`).

### INVALID_EVENT_TYPE

`workspace audit --type <type>`: the filter isn't an event type (`member.joined`), a prefix (`member.*`, `app.crm.*`) or `*`: lowercase letters, digits and underscores in dot-separated parts, at most 80 characters. The command line's parser refuses it first, as `INVALID_VALUE` (exit 252); this is the library's own check behind it. Headline: `--type is an event type (member.joined), a prefix (member.*, app.crm.*) or *`. Nothing is read.

**Fix:** `fix` is absent (an argument error). Not retryable.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`audit`).

### INVITATION_NOT_PENDING

`workspace invite-link <email|id>` and `workspace uninvite <email|id>`: no pending invitation of the organization matches the id or the invited email (it was accepted, canceled or never made), or, for `invite-link`, the pending one has expired (`expires_at` passed), or it was used or canceled between the read and the write (the insert's `WHERE EXISTS`, the update's `AND status = 'pending'`). Headline: `No pending invitation for <x> in <organization>`, or `The invitation for <email> expired on <time>`, or `… was used or canceled meanwhile`.

**Fix:** `rerun`: `pnpm everyapp workspace users`, `rerunNote`: `lists the pending invitations`; for an expired one, `rerun`: `pnpm everyapp workspace invite <email>`, `rerunNote`: `makes a new one`.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`findPendingInvitation`, `inviteLink`, `uninvite`).

### LAST_OWNER

`workspace role <email> admin|member` named an owner while no other owner of the workspace can act (step `workspace.role`): they are the only owner, or every other owner is deactivated (`users.banned` with no expiry or one still to come). The workspace always keeps at least one owner who can act, so the guarded `UPDATE` changed nothing and the row is as it was. Headline: `<email> is the last owner of <workspace>`, then `The workspace always keeps one owner, so their role stays until someone else is an owner.` The Gateway's Users page refuses the same move with the same code, and its write carries the same guard.

`workspace remove <email>` refuses the organization's last owner who can act the same way (the predicate is the one `role` holds, `anotherLiveOwnerSql` in members.ts). `workspace deactivate <email>` bans the account, which is account-wide (every session, token and AI connection goes with it), so it keeps the rule in every organization the member owns: refused when they are the last live owner of the organization acted on or of any other, naming the one that would be left without an owner (`data.organization`). The Gateway refuses such a person to an admin outright (`USER_IN_OTHER_ORGANIZATION`); the operator, root everywhere, is held to the rule itself. Both are checked on the read and held on the write: every statement of the batch carries the same condition, so an owner left alone between the read and the write is refused too (nothing is written, and the read is repeated to say so). Headline: `<email> is the last owner of <organization> who can act, so they can't be deactivated` (or `removed`); for another organization of theirs, `<email> is the last owner of <organization> who can act, and a deactivation is account-wide: it would leave <organization> without one`; then `Make someone else an owner of <organization> first, then try again.`

**Fix:** `data.rerun`: `pnpm everyapp workspace role <email> owner` (literal `<email>`: another member's), `data.rerunNote`: `for someone else, then this command again`, when the organization is the install one (the one `workspace role` acts on); for another organization, `fix`: `an owner of <organization> makes someone else an owner under Manage workspace → Users, then run this again`. From `role`, `data.workspace` (`id`, `name`), `data.member` (`id`, `email`, `name`), `data.role` (the role asked for); from `deactivate` and `remove`, `data.organization` (`id`, `name`, `slug`) and `data.member` (`id`, `email`, `name`). Not retryable.

Source: `packages/cli/src/commands/workspace/index.ts` (`setRole`), `packages/cli/src/lib/gateway/members.ts` (`setMemberRole`, `anotherLiveOwnerSql`), `packages/cli/src/lib/gateway/workspace.ts` (`lastOwner`, `lastLiveOwnerOf`, `MANAGEABLE_MEMBER`, `DEACTIVATABLE_MEMBER`).

### LEASE_HELD

A deploy lease (a row in the Gateway's D1 table `_everyapp_deploy_lease`, id `gateway`, `app:<workerName>` or `access`) was still held after 5 minutes of waiting (`WAIT_MS`, retried every 5 s; the rebind passes its own `leaseWaitMs`, and the Access sync after `deploy` and `delete` waits 60 s, `SYNC_LEASE_WAIT_MS`). A lease expires 3 minutes after its last renewal and is renewed every 30 s, so a dead holder frees it within 3 minutes; a live one holds it as long as it runs and nothing takes it over. While waiting, `progress` events on the step (`app.lease`, `gateway.lease`, `db.lease`) say who holds it. Takers: `deploy` (the app's lease, then the Gateway's for the rebind), `delete` (the Gateway's, for the rebind that unbinds the app), `secret set|unset`, `email set|unset`, `db restore`, `setup`, `update`, and `access on` plus the Access sync after `deploy` and `delete` (the `access` lease, step `gateway.lease`). Message with a holder: `<activity> is still running after 5m`, where `<activity>` is `A deploy of <app>`, `A Gateway upgrade`, `An update of Cloudflare Access`, `A restore of <app>'s database`, … (from the row's `purpose` and `app`) then `It's from <deployer on >machine. If it stopped without cleaning up, it's released within <time>.`; without one: `Couldn't take hold of <the Gateway|app id|this app> after 5m` (`this app` for the `access` lease, whose row names no app). When the Gateway's lease is held during an app's rebind (step `app.bind`), `bindIfNeeded()` rethrows with one more line, `This app's upload is kept; deploying again binds it and makes it live.`, and `data.rerunNote` `once the other deploy finishes`. The Access sync after `deploy` and `delete` catches it and emits the `ACCESS_SYNC_FAILED` warning (step `app.access`, with the message's first line) instead; from `access on` it is this error.

**Fix:** `retryable: true`: `data.rerun` is this same command, `data.rerunNote` `once it's done (pnpm everyapp status shows it)`. `data.holder`, when there is one, is the row: `id`, `holder`, `purpose` (`app.deploy`, `app.register`, `app.secrets`, `app.email`, `gateway.deploy`, `gateway.upgrade`, `gateway.reconcile`, `gateway.secrets`, `access.sync`, `db.restore`), `acquiredAt`, `expiresAt`, `app`, `deployer`, `machine`. No `data.fix`.

Source: `packages/cli/src/lib/gateway/lease.ts`, `packages/cli/src/commands/appGateway.ts`, `packages/cli/src/lib/access/sync.ts`

### LEASE_LOST

`lease.check()`, called right before each step that can't be undone (an app's migrate, each `cf deploy` of its Workers and its email routes; the Gateway's migrate and upload in `applyGateway()`; the D1 restore; the app's email settings row and then its routes in `email set|unset`; the Access applications in the Access sync), renewed the lease and found it no longer this run's: the renewal returned no row (the row is gone, or another run took it after it expired), or renewals had been failing for more than half the TTL (90 s). A `LEASE_HEARTBEAT` warning precedes it when renewals fail. Message `Stopped: this run lost its hold on <the Gateway|app id>` then `Its hold expired, so it stopped before its next change to avoid overlapping another run.` The Access sync after `deploy` and `delete` catches it and emits the `ACCESS_SYNC_FAILED` warning instead.

**Fix:** `retryable: true`: `data.rerun` is this same command. No `data.fix`.

Source: `packages/cli/src/lib/gateway/lease.ts`, `packages/cli/src/lib/access/sync.ts`

### MANIFEST_NOT_FOUND

`loadEveryAppManifestFile()` found no manifest file. From the working directory (`dev`, `deploy`, `release`, `db migrate`, `db query`, `db restore` without an app argument or `--gateway`): `No everyapp.config.ts in this directory`, `data.fix` `run this from the app's directory`. `configure` with no app named: `No everyapp.config.ts in this directory, and no app named`, `data.fix` `name the app: pnpm everyapp configure <app> (pnpm everyapp status lists them), or run this from its directory`. `email set|unset|show` without `--manifest`: the same message, `data.fix` `run this from the app's directory, or pass --manifest <path>`; with `--manifest <path>`: `No manifest at <path>`, no fix. `delete` without an app id: `Which app? There's no everyapp.config.ts here`, `data.fix` `run this from the app's directory, or name it: pnpm everyapp delete <id>`. `secret` reads the manifest only when one is there. `dev` raises it like every other command, through `loadEveryAppManifest` (its `loadManifest` in `commands/dev/index.ts` rewraps only an invalid manifest, as `INVALID_MANIFEST`).

**Fix:** as above. No rerun, not retryable.

Source: `packages/cli/src/lib/manifest.ts`, `packages/cli/src/commands/email/index.ts`, `packages/cli/src/commands/delete/index.ts`, `packages/cli/src/commands/dev/index.ts`

### MCP_APP_BUILTIN

`mcp tool <id> <tool>` named a built-in MCP app (`dataforseo`, `PROVIDER_APPS` in `packages/sdk/src/internal/providerApps.ts`): its tools and their risks are the Gateway's own, compiled into it, so there is no override to write. Message `<name> is the Gateway's built-in MCP app` then `Its tools and their risks are the Gateway's own, and can't be changed here. pnpm everyapp mcp off <id> stops serving it.` Raised after connecting, before anything is written.

**Fix:** none for the tool; `pnpm everyapp mcp off <id>` stops serving the whole app. No rerun, not retryable.

Source: `packages/cli/src/commands/mcp/index.ts` (`changeTool`)

### MCP_TOOL_CHANGE_INVALID

`mcp tool <id> <tool>` was given nothing to change, or `--on` with `--off`. Messages: `Nothing to change about <tool>` then `Give --risk read|write|destructive|annotations, --on or --off.` (`rerun`: `pnpm everyapp mcp show <id>`, `rerunNote`: `lists its tools with their risks`); or `--on and --off say opposite things; give one` (`fix`: `drop one of them`). Raised before connecting.

**Fix:** as the message says. Not retryable.

Source: `packages/cli/src/commands/mcp/index.ts` (`changeTool`)

### MEMBER_NOT_FOUND

`workspace role <email> <role>` found no member with that address in the workspace (matched without case; step `workspace.role`), or the Gateway has no workspace at all. Headline: `No member <email> in <workspace>`, then `Someone still invited isn't a member until they accept.`; with no organization on the Gateway yet: `This Gateway has no workspace yet`, then `Nobody has claimed its owner link, so it has no members.`

**Fix:** `data.fix`: `check the address against Manage workspace → Users, or invite them first`; `data.workspace` (`id`, `name`), `data.email`. Without a workspace, `data.rerun`: `pnpm everyapp setup`, `data.rerunNote`: `to claim it`. Not retryable.

Source: `packages/cli/src/commands/workspace/index.ts` (`setRole`).

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

The app has no `cloudflare.config.ts`. Self-host `deploy` of the app in the directory (not of a release) raises it with the headline `No cloudflare.config.ts in this app`, a sample config (`defineConfig` from `cf/config`, `everyAppWorker` from `@every-app/sdk/cloudflare`, the entrypoint imported `with { type: "cf-worker" }`, the manifest from `./everyapp.config.ts`) and `starter/ has the full setup (package.json, vite.config.ts).` `everyapp dev` raises it only when the manifest has no `dev` command either: `No cloudflare.config.ts in this directory` then `EveryApp apps build their Worker in cloudflare.config.ts with everyAppWorker() from @every-app/sdk/cloudflare.`

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

### NOTHING_TO_SET

`workspace app set <app>` without `--name`, `--description` or `--everyone`, and `workspace group set <group>` without `--name` or `--description`: there is nothing to change. Checked before the write (`group set` before anything connects). Headline: `Nothing to set: give --name, --description or --everyone on|off` (or `give --name or --description`).

**Fix:** none offered; no rerun; not retryable.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`updateApp`), `packages/cli/src/commands/workspace/groups.ts` (`updateGroup`).

### NO_D1

`everyapp db query` on an app whose manifest declares no `resources.d1` (checked before `--local` or production is decided). Message `<app> declares no D1 database`.

**Fix:** `data.fix`: `add a binding to resources.d1 in everyapp.config.ts`; `data.rerun` is `pnpm everyapp deploy` (the deploy that creates the database). Not retryable.

Source: `packages/cli/src/commands/db/index.ts`

### NO_RELEASE

`everyapp install <github.com repository URL>` (the repository, its `/releases` or `/releases/latest`, or `/releases/tag/<tag>`): that release has no `everyapp-release.tar.gz` an anonymous download can get (GitHub answers 404; a private repository looks the same). It is the download's `RELEASE_NOT_FOUND`, rewrapped for a repository; the CLI never builds a repository from source. Message `<owner/repo> publishes no everyapp release` (then ` <tag>` when one was named) then `Its GitHub releases have no everyapp-release.tar.gz.`

**Fix:** `data.fix`: `clone it, then run pnpm install in it and this checkout's pnpm everyapp deploy from its directory`. No rerun, not retryable.

Source: `packages/cli/src/lib/app/release.ts`, `packages/cli/src/lib/release/github.ts`

### NO_RESTORE_POINT

`everyapp db restore [app]` or `db restore --gateway`: the Gateway's registry holds no restore point for that database. One is recorded only by a migrating deploy (an app's) or a migrating `setup` or Gateway upgrade (the Gateway's) when the database already held some of the migrations; a fresh database's is forgotten, an app's is forgotten once it is restored, and the Gateway's row goes with the restore itself. Message `No restore point for <app>'s database` (or `the Gateway's database`) then `everyapp saves one when a deploy migrates a database that has data.` (or `when setup or a Gateway upgrade migrates …`).

**Fix:** none offered; not retryable.

Source: `packages/cli/src/commands/db/restore.ts`, `packages/cli/src/lib/migrations/remote.ts`

### ORG_AMBIGUOUS

Every `workspace …` command that takes `--org`, and every `events …` command but `events types`, when the value is no organization's id or slug and matches more than one by name (letter case aside). Names aren't unique (the `organizations` table is unique on `slug` only) and any owner or admin can rename their organization, so a script's `--org <name>` could land on an organization someone renamed; the command refuses rather than take the older one. Headline: `<n> organizations are named <x>: <slug> (<id>) and <slug> (<id>)`, then `A name isn't unique, and any owner or admin can rename their organization; a slug or id is one organization's.`; `fix`: `name it by its slug or id with --org`; `data.organizations` lists the candidates (`id`, `name`, `slug`). Nothing is read or written past this. Scripts should pass the slug or the id.

**Fix:** as above. Not retryable.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`resolveOrganization`, through `openWorkspace` and `organizationFor`).

### ORGANIZATION_NOT_FOUND

Every `workspace …` command, and every `events …` command but `events types`, when the organization it acts on can't be found. Raised after connecting (for `events`, after the event tables are checked), before anything else is read or written. Without `--org`, the install organization (the oldest with an owner, or the oldest of all) and the Gateway has none yet: headline `The Gateway has no organization yet`, then `Its owner creates the first one by claiming it.`; `rerun`: `pnpm everyapp setup`, `rerunNote`: `prints the owner link`. With `--org <x>`, no organization has that id, slug or name (letter case aside): headline `No organization named <x> on this Gateway`, then `The Gateway has: <slug> (<name>) and …`; `fix`: `name one by its slug, id or name with --org`; `data.organizations` lists them (`id`, `name`, `slug`). A name two organizations share is `ORG_AMBIGUOUS` instead.

**Fix:** as above. Not retryable.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`openWorkspace` for `workspace`, `organizationFor` for `events`, `resolveOrganization` for both).

### PASSWORD_RESET_REQUIRES_ACTIVE_USER

`workspace reset-link <email>`: the member is deactivated (`users.banned`, with `ban_expires` unset or still to come), and a password-reset link is only made for an active account, the Gateway's own rule. Headline: `<email> is deactivated, and a password-reset link is only for an active account`.

**Fix:** `rerun`: `pnpm everyapp workspace reactivate <email>`, `rerunNote`: `first, if they should be back`.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`resetLink`).

### PIPED_LINE_INVALID

`configure <app>` with something piped on stdin: a line that isn't `NAME=value` (a bare value, the `echo "$KEY" | …` habit, or anything else). Message: `Line <n> of the piped input isn't NAME=value` / `Nothing was set.` The line itself is never shown: it may be a secret. Checked before anything is written; a blank line or one starting with `#` is skipped, an `export ` prefix is allowed, one pair of matching quotes around the value is dropped, and the value is otherwise taken as it is (a `#` or an `=` inside it is part of it).

**Fix:** `fix`: `pipe NAME=value lines, one per line; a bare value goes to pnpm everyapp secret set NAME`. No rerun.

Source: `packages/cli/src/commands/configure/index.ts` (`parsePipedLines`)

### POSTGRES_URL_MISSING

`deploy` of an app whose manifest sets `migrations.dialect: "postgresql"`: `.everyapp/secrets.env` has no `POSTGRES_DATABASE_URL`. Checked right after the manifest loads, before the Gateway is contacted or anything is created. Message `<app> needs a Postgres URL to migrate its database` then `Format: postgres://<user>:<password>@<host>:<port>/<database>`.

**Fix:** `data.fix`: `set POSTGRES_DATABASE_URL in .everyapp/secrets.env, then deploy again`. No rerun, not retryable.

Source: `packages/cli/src/commands/deploy/deployApp.ts`, `packages/cli/src/lib/app/deploySecrets.ts`

### PRISMA_MISSING

Self-host `deploy` of an app with `migrations.engine: "prisma"` (dialect `postgresql`), step `app.migrations`: the app's own `prisma` package isn't installed, so `prisma migrate deploy` can't run. Message `Prisma migrations need prisma, which isn't installed` then `Nothing was migrated or uploaded.`

**Fix:** `data.fix`: `add prisma to devDependencies, then deploy again`. No rerun, not retryable.

Source: `packages/cli/src/lib/migrations/prisma.ts`

### PROVIDER_APP_UNKNOWN

The id given to an `mcp` command (`on`, `off`, `remove`, `show`, `refresh`, `tool`) isn't an MCP app of the install organization: neither a built-in (`PROVIDER_APPS`) nor a remote MCP server added with `mcp add` (a provider-tier row with a `remote` block, tombstones included, so `on` and `show` can say how to add a removed one again). Raised by `resolveMcpApp` before anything is written. Messages: `"<id>" is not an MCP app on this Gateway` then `Built in: dataforseo. Added: <the remote ids, or none yet>.`, `rerun` `pnpm everyapp mcp list` (`rerunNote` `lists the MCP apps`), or for an id that looks like a URL `rerun` `pnpm everyapp mcp add <id>` (`rerunNote` `adds the server at that address`); for a deployed app's id: `"<id>" is an app deployed to this Gateway, not an MCP app` then `pnpm everyapp delete <id> removes a deployed app.` The registry rules raise the same code from `mcp on` for an id that isn't a built-in (`providerAppId` in `packages/perimeter/src/registry/providerApps.ts`: `"<id>" is not an MCP app. The Gateway offers: dataforseo.`, 400 on the Gateway's own surfaces).

**Fix:** `pnpm everyapp mcp list` for the ids; a server by URL is added with `mcp add <url>`. Not retryable.

Source: `packages/cli/src/lib/gateway/remoteMcpApps.ts` (`resolveMcpApp`), `packages/perimeter/src/registry/providerApps.ts`

### PROVIDER_BUILTIN

`provider add` with a spec whose id is a built-in provider's (or `everyapp`): `<id> is built in` / `A registered provider can't take a built-in provider's id.`, `data.fix` naming `provider show <id>`. `provider remove <id>` of a built-in id: only a registered provider can be removed (`data.rerun` `pnpm everyapp provider list`). `provider show <id> --save` of a built-in provider: `everyapp dev reaches it without a file`, `data.fix` naming the settings to put in `.dev.vars`. Not retryable.

Source: `packages/cli/src/lib/gateway/providers.ts`, `packages/cli/src/commands/provider/index.ts`

### PROVIDER_CLIENT_INCOMPLETE

`provider add --oauth` was given one half of the client (the id by `--client-id` or a piped line, or the secret) without the other: `<Provider>'s client needs <NAME> too` / `Nothing was set; the provider is registered.` The row was written; set the client with the command in `data.fix` (`pnpm everyapp secret set <ID>_CLIENT_ID <ID>_CLIENT_SECRET`), or pipe both as `NAME=value` lines.

Source: `packages/cli/src/commands/provider/oauth.ts`

### PROVIDER_CONNECTION_NOT_FOUND

`provider disconnect <id>` found no connection to the provider for the person (`--user`), the organization (`--organization`) or at all (`--all`): `No connection to <Provider> for <who>` / `Nothing was changed.` `data.rerun`: `pnpm everyapp provider connections --provider <id>`.

Source: `packages/cli/src/commands/provider/oauth.ts`

### PROVIDER_CONNECTION_WHICH

`provider disconnect <id>` without exactly one of `--user <email>`, `--organization` and `--all`: `Say whose connection to <id> to remove` (or the flags given `name different connections`) / `Nothing was changed.` `data.fix` names the three.

Source: `packages/cli/src/commands/provider/oauth.ts`

### PROVIDER_EXISTS

`provider add` with a spec whose id is registered on this Gateway already. Nothing is written. `data.rerun` is the same command with `--replace` (`authorize: true`: replacing writes the new spec and leaves the row unbound, so its key must be set again with `secret set` before the Gateway sends it). Also raised when the row changed between the read and the write (`data.rerun` `pnpm everyapp provider list`).

Source: `packages/cli/src/lib/gateway/providers.ts`

### PROVIDER_HOST_REFUSED

`provider add`: a host in the spec isn't one a key may be sent to: an IP address, `localhost` or a name under `.localhost`, `.local`, `.internal` or `.arpa`, this Gateway's own host, or a host under its apps' domain. Message `<id>'s key can't be sent there: <why>`, `data.fix` `list only the provider's own public API hosts under hosts`. The Gateway applies the same rule every time it reads the row.

Source: `packages/cli/src/lib/gateway/providers.ts`, `packages/sdk/src/internal/providerRegistry.ts` (`publicHostProblem`, `gatewayHostRefusal`)

### PROVIDER_IN_USE

`provider remove <id>` of a registered provider a registered app's manifest lists under `capabilities`: `<apps> list <id> under capabilities` / `Removing it stops their calls to it at once …`. Nothing is removed. `data.rerun` is the same command with `--force` (`authorize: true`).

Source: `packages/cli/src/lib/gateway/providers.ts`

### PROVIDER_NOT_FOUND

`provider remove <id>` of an id with no row (`No provider <id> is registered on this Gateway`), or `provider show <id>` of an id the Gateway doesn't offer (or a Gateway service such as `email`, or a row the Gateway refuses, with why). `data.rerun`: `pnpm everyapp provider list`.

Source: `packages/cli/src/lib/gateway/providers.ts`, `packages/cli/src/commands/provider/index.ts`

### PROVIDER_PRESET_UNKNOWN

`provider add --oauth <value>` where `<value>` is neither an OAuth preset (`github-oauth`, …), a built-in client with a Gateway flow (`google-workspace`), nor a path or URL to a spec: `No OAuth preset <value>` with the presets listed, or `<value> is a built-in provider, not an OAuth one`. Nothing was changed. `data.rerun`: `pnpm everyapp provider presets`.

Source: `packages/cli/src/commands/provider/oauth.ts`

### PROVIDER_SECRET_TAKEN

`provider add`: a setting the spec names isn't the provider's to hold: it doesn't start with the provider's id upper-cased (`STRIPE_` for `stripe`), or it is one of the Gateway's own, a local-development or reserved name, a setting the Gateway or a built-in provider reads, another registered provider's (`<id> can't use that setting: <why>`), or a secret a registered app's manifest lists as its own (`<names> is <app>'s own secret`). Nothing is written.

Source: `packages/cli/src/lib/gateway/providers.ts`, `packages/sdk/src/internal/providerRegistry.ts` (`rowSecretProblem`)

### PROVIDER_SPEC_INVALID

`provider add <spec>`: the spec couldn't be read (no file there, not JSON, over 64 KiB, a URL that isn't https, didn't answer 2xx or couldn't be fetched) or the parser refused it: `The spec isn't one this Gateway takes` then every problem as `<field>: <problem>` (`parseProviderSpec`, `describeSpecProblems`). Nothing is written; `data.fix` says what to change.

Source: `packages/cli/src/commands/provider/index.ts` (`readSpecSource`), `packages/cli/src/lib/gateway/providers.ts`, `packages/sdk/src/internal/providerSpec.ts`

### QUERY_FAILED

`everyapp db query` (local or production): D1 refused the SQL with a SQLite error, recognized by a `SQLITE_…` code in cf's message. Message `Query failed: <problem>` then `<SQLITE_CODE> from the <local|production> database.` A cf failure without such a code is reported as cf's own (`CF_…`).

**Fix:** correct the SQL. No `data.fix`, no rerun, not retryable.

Source: `packages/cli/src/commands/db/index.ts`, `packages/cli/src/lib/cf/d1.ts`

### QUEUE_HANDLER_MISSING

Self-host `deploy` and `install` (step `app.upload` or `app.helper`): the Worker's new version went live, then Cloudflare refused to make it the consumer its `queue` trigger declares (`resources.queues[].consumer`), because its bundle exports no `queue()` handler. cf exits 1 after the upload with `Trigger configuration for "<worker>" was only partially updated: Queue consumers: … Queue handler is missing. [code: 11001] … Successful trigger changes were not rolled back.` (seen live on 2026-10-24). Headline: `<worker>'s new version is live without its queue consumers`, then `Its bundle exports no queue() handler, which Cloudflare needs before it delivers a message.` `data.workerName` is the Worker, `data.cloudflare` cf's message. The version is recorded as everyapp's upload (so the next deploy replaces it unattended); the registry keeps the manifest it had.

**Fix:** `fix`: `export async queue(batch, env) from the Worker's entry beside everyApp()'s fetch, then deploy again`; `rerun`: this same command. Not retryable until the handler is exported: `export default { ...everyApp(handler, { tools }), async queue(batch, env) { … } }` ([the manifest's Queues](/docs/agent/manifest#queues)).

Source: `packages/cli/src/lib/cf/deploy.ts` (`explainDeployFailure`)

### QUEUE_NAME_INVALID

Self-host `deploy` and `install` (step `app.resources`, before anything is created): a queue's name, the Worker's name plus `--` and the binding lowercased with `_` as `-` (`queueNameFor()`), is one Cloudflare refuses: longer than 63 characters, or not lowercase letters, digits and hyphens starting and ending with a letter or digit (`isValidQueueName()`). The strict manifest already refuses a binding ending in `_`, so in practice the name is too long. Headline: `<BINDING> would be the queue "<name>", which Cloudflare refuses`, then `A queue's name is at most 63 lowercase letters, digits and hyphens, starting and ending with a letter or digit.`

**Fix:** `fix`: `shorten its binding name in everyapp.config.ts`; `rerun`: this same command. Not retryable.

Source: `packages/cli/src/lib/app/resources.ts` (`assertQueueNames`), `packages/perimeter/src/manifest/manifest.ts` (`queueNameFor`, `MAX_QUEUE_NAME_LENGTH`)

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

A release carries SQL files, which only the D1 migration applies by itself; Postgres migrations run the app's own drizzle-kit or Prisma with its config, which a release doesn't have. Two raise sites: self-host `install <release>` of a manifest with `migrations.dialect: "postgresql"` (`deployApp.ts`, before anything else): `<app> can't deploy from a release: its Postgres migrations need the source`, `data.fix` `clone it, then run pnpm install in it and this checkout's pnpm everyapp deploy from its directory`; and `release` of a manifest with `migrations.engine: "prisma"` (`lib/app/release.ts`): `<app> migrates with Prisma, which a release can't carry` then `Prisma migrations (migrations.engine "prisma") need the app's source and its Prisma CLI.`, `data.rerun` `pnpm everyapp deploy`, `data.rerunNote` `from the app's checkout`.

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

### REMOTE_MCP_INVALID

`mcp add` was given something a remote MCP app can't be. From the flags, before connecting (`authFromFlags`): `--header names the header of --auth header` (with another `--auth`; `fix` `drop --header, or use --auth header`), `--auth header needs --header <name>: the header the server reads the credential from` (`fix` `add --header X-Api-Key (the name the server's docs give)`), `--secret names a credential, and --auth none|oauth sends none` (likewise `--from-env`; `fix` `drop --secret, or use --auth bearer, header or basic`). From the registry rules (`planRemoteMcpAppAdd` in `packages/perimeter/src/registry/remoteMcpApps.ts`, status 400, nothing written): no id could be read from the URL's host (`give one with --name`), an id that isn't kebab-case, is over 32 characters, is `everyapp`, or is a built-in's (`"dataforseo" is the Gateway's built-in MCP app; a remote server can't take its id`), a `--risk` outside `annotations`, `read`, `write`, a credential name outside the `_MCP_TOKEN` family (`the credential's name must end in _MCP_TOKEN (letters, digits and underscores), like TREG_MCP_TOKEN`), a header name the Gateway sets or routes by (`auth.header can't be Authorization; use kind "bearer" or "basic" for Authorization`). `mcp tool` and the Gateway's own surfaces raise the registry's for an empty tool name or a bad risk.

**Fix:** as the message says, then the same `mcp add` again. Not retryable.

Source: `packages/cli/src/commands/mcp/index.ts` (`authFromFlags`), `packages/perimeter/src/registry/remoteMcpApps.ts`, `packages/sdk/src/internal/remoteMcp.ts`

### RESOURCE_NAME_MISSING

Self-host `deploy` (step `app.resources`): the registration plan the Gateway's rules produced has no name for a D1, KV or R2 binding, or a reserved one (`every-app-gateway`, or a name starting with `every-app-gateway-`, the Gateway's own resources). Message `The Gateway assigned no usable <D1 database|KV namespace|R2 bucket> name for binding <binding>`.

**Fix:** `data.rerun`: `pnpm everyapp setup`, `data.rerunNote` `to upgrade the Gateway`. No `data.fix`, not retryable.

Source: `packages/cli/src/lib/app/resources.ts`, `packages/perimeter/src/manifest/manifest.ts`

### RESOURCE_NAME_TAKEN

Self-host `deploy` (step `app.resources`) found a resource under the app's assigned name that no deploy of this app recorded as its own in `_everyapp_app_resources`; a name proves nothing, so it is refused on every attempt. D1, KV, Vectorize, AI Gateway or a Secrets Store secret (`resources.secretsStore`, in the account's store): `A <D1 database|KV namespace|Vectorize index|Secrets Store secret> named "<name>" already exists in this Cloudflare account` (`An AI Gateway named "<id>" …`) then `No deploy of this app created it; it may belong to another Gateway, app or project.`, `data.fix` `delete or rename it` (a Vectorize index is refused whatever its shape: its vectors are whoever wrote them's). Hyperdrive, when the existing config doesn't connect to the origin in `.everyapp/secrets.env` (one that does is adopted): `A Hyperdrive config named "<name>" already exists in this Cloudflare account` then `No deploy of this app created it.`, `data.fix` `to use it, set <BINDING>_ORIGIN_URL in .everyapp/secrets.env to the URL of the database it connects to; otherwise delete or rename it`. A race, when Cloudflare says the name was taken between the lookup and the create: `<Kind> "<name>" was created by someone else while this deploy was creating it`, `data.fix` `delete or rename it`. (The Worker's equivalent is `WORKER_NAME_TAKEN`.)

**Fix:** as above; each sets `data.rerun` to this same command. Not retryable.

Source: `packages/cli/src/lib/app/resources.ts`

### R2_NOT_ENABLED

Self-host `deploy` and `install` (step `app.build`, after the policy check) make every R2 bucket the app's Workers bind that doesn't exist yet, and the account has never enabled R2: Cloudflare answers `[10042] Please enable R2 through the Cloudflare Dashboard.` to every bucket call. `R2 isn't enabled in this Cloudflare account, and <app> needs an R2 bucket (<name>)` then `Enable it once in the dashboard: R2 Object Storage → Get started (free until something is stored).`, `data.fix` `enable R2 in the Cloudflare dashboard (R2 Object Storage)`, `data.rerun` this same command.

**Fix:** enable R2 in the dashboard once (the account's R2 Object Storage page; no bucket needs making by hand), then run the command again. Not retryable until then.

Source: `packages/cli/src/lib/app/buckets.ts`

### RESOURCE_OWNED

Recording a resource as the app's in `_everyapp_app_resources` hit one of its unique indexes: another app already records that resource id, or that name, under the same kind (Worker, D1, KV, Hyperdrive, Vectorize, AI Gateway). Raised while claiming the Worker and provisioning resources in a self-host `deploy` (step `app.resources`). Message `<Kind> "<name>" is recorded as another app's` then `<workerName> can't use it.` For an Email Routing address the same violation is reported as `EMAIL_ADDRESS_TAKEN`.

**Fix:** `data.fix`: `rename the binding in everyapp.config.ts`. No rerun, not retryable.

Source: `packages/cli/src/lib/app/ownership.ts`, `packages/cli/src/lib/app/emailRoutes.ts`

### RESOURCE_REPLACED

Self-host `deploy` (step `app.resources`): the app's record names a D1, KV or Hyperdrive resource by id, that id no longer exists, and a different resource now has the name. A Vectorize index's id is its name, so it never reads as replaced: one of the name is the app's while the record stands. (When nothing has the name, the deploy recreates it empty with a `RESOURCE_RECREATED` warning.) Message `<Kind> "<name>" isn't the one this app created` then `That one (<recorded id>) was deleted, and this one was created by someone else since.`

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

**Fix:** `retryable: true`; `rerun`: `pnpm everyapp secret <set|unset> <left names>`, with ` --app <id>` when the command ran with `--app` and a name of the app's own is left. Raised through `configure <app>` the message and `data` are the same, but the rerun is `pnpm everyapp configure <app>` (`rerunNote` `to set what is left`; before the app's first deploy, `pnpm everyapp configure` with `in the app's directory, to set what is left`), which reads what is set and asks only for what is still missing.

Source: `packages/cli/src/commands/secret/index.ts`

### SECRETS_STORE_MISSING

Self-host `deploy` and `install` (step `app.resources`, before anything is created) for an app that declares `resources.secretsStore`, in a Cloudflare account with no Secrets Store: `cf secrets-store stores list` answered none, and cf 1.0.0-beta.14 can't create one. `This Cloudflare account has no Secrets Store, and <app> binds a Secrets Store secret (<BINDING>)` then `Make one once in the dashboard: Secrets Store → Create store (cf can't create a store).`, `data.fix` `create a store in the Cloudflare dashboard (Secrets Store)`, `data.rerun` this same command.

**Fix:** make a store once in the Cloudflare dashboard (Secrets Store → Create store; any name, `everyapp` if the account will have several), then run the command again. Not retryable until then.

Source: `packages/cli/src/lib/app/resources.ts`, `packages/cli/src/lib/cf/secretsStore.ts`

### SECRETS_STORE_VALUE_MISSING

Self-host `deploy` and `install` (step `app.resources`, before anything is created) have to create the Secrets Store secret for a `resources.secretsStore` binding (none of its name is in the store: never created, or the recorded one was deleted) and the app's secrets file `.everyapp/secrets.env` holds no value for it under the binding's own name. `<BINDING> needs its Secrets Store secret's value` (several: `<A>, <B> need their Secrets Store secrets' values`) then `Creating the secret in the store "<store>" needs it.`, `data.fix` `set <BINDING> in .everyapp/secrets.env` (every missing name), `data.rerun` this same command. A secret that exists needs no value: a redeploy binds it as it is.

**Fix:** add `<BINDING>=<value>` to `.everyapp/secrets.env` (kept out of git; the value goes to Cloudflare in a private body file and is never printed or recorded), then run the command again. Not retryable until then.

Source: `packages/cli/src/lib/app/resources.ts`, `packages/cli/src/lib/app/deploySecrets.ts`

### SECRET_EMPTY

`secret set <name> --from-env <VAR>` where `$VAR` is unset or empty: `$<VAR> is empty or not set`. Raised when the value is read, after the names were routed and the app found. `mcp add <url> --from-env <VAR>` reads the credential the same way (`readSecretValue`), before it connects or writes anything, so an empty variable adds nothing. `events add <url> --secret-from-env <VAR>` raises the same, after the URL is checked, with `fix` `export <VAR> first, or name another variable with --secret-from-env`. From `configure <app>`, a `NAME=` line on stdin with nothing after it: `<NAME> is empty in the piped lines`, before anything is written (`configure --from-env` skips an unset or empty variable instead). `signin add <id> --client-secret-from-env <VAR>` raises it too (the value trimmed), before it connects, with `fix` `export <VAR> first, or name another variable with --client-secret-from-env` and `data.name` the provider's `<ID>_SIGNIN_CLIENT_SECRET`.

**Fix:** `fix`: `export <VAR> first, or name another variable with --from-env`; from `configure`: `give <NAME> a value, or leave the line out`.

Source: `packages/cli/src/lib/secretValue.ts`, `packages/cli/src/commands/configure/index.ts`, `packages/cli/src/commands/events/add.ts`, `packages/cli/src/commands/signin/index.ts`

### SECRET_NAME_INVALID

A secret name that isn't `/^[A-Za-z_][A-Za-z0-9_]*$/`: `"<name>" isn't a valid secret name`. Checked by `assertAppSecretName`, which `secret set|unset` (`notRoutable`) runs on a name the manifest's `secrets` doesn't list, after the `didYouMean` check against the Gateway settings (`SETTABLE_GATEWAY_SETTINGS` in `packages/sdk/src/internal/gatewaySettings.ts`) and the `SECRET_NOT_SETTABLE` checks, and before the Gateway is reached. A declared name is never checked here: the manifest validator already refused a bad one.

**Fix:** `fix`: `use letters, digits and underscores, starting with a letter, e.g. GITHUB_TOKEN`.

Source: `packages/cli/src/lib/app/secrets.ts`

### SECRET_NAME_RESERVED

`secret set|unset` of a name an app's secret can't take, checked without regard to case: `GATEWAY_URL`, `CF_VERSION_METADATA`, or any name starting `EVERYAPP_`, `EVERY_APP_` or `APP__` (the deploy sets `GATEWAY_URL` itself and builds in the identity settings and the gateway binding). Message: `<name> is a reserved name` / `everyapp manages GATEWAY_URL, CF_VERSION_METADATA and the EVERYAPP_*, EVERY_APP_* and APP__* names.` The manifest's own `secrets` follow the same rule.

**Fix:** `fix`: `pick another name`.

Source: `packages/cli/src/lib/app/secrets.ts`, `packages/sdk/src/internal/gatewaySettings.ts`

### SECRET_NOT_DECLARED

`secret set|unset`: a name that goes nowhere, refused before anything is read or the network used. From `configure <app>`: a `NAME=value` line on stdin whose name the app's manifest doesn't declare (no provider, capability or secret reads it, and no capability reads it when set): `<app> doesn't declare <NAME>` / `The piped lines set what its deployed manifest lists (a provider, a capability or one of its secrets). Nothing was set.` (in the app's directory: `its everyapp.config.ts lists`), `data.fix` `leave it out, or declare it in everyapp.config.ts[ and deploy again]; a bare value goes to pnpm everyapp secret set NAME`. The name is shown only when it looks like one (upper case, digits and underscores); otherwise the headline reads `<app> doesn't declare line <n> (not shown: it may be a value)`, since a bare value with an `=` in it (a base64 key's padding) parses as a name. For `secret set`, three situations, in the order `notRoutable` checks them:

- The name differs only in case or underscores from a Gateway setting or one of the manifest's secrets: `<name> isn't a Gateway setting[ or one of <app>'s secrets]`; `rerun` is the same command with the name corrected and `data.didYouMean` is the match.
- There is no `everyapp.config.ts` in the working directory and no `--app`: `<name> isn't a Gateway setting, and there's no app here` / `An app's own secrets are set|removed from the app's directory (where everyapp.config.ts is), or from anywhere with --app <id>.` / `Gateway settings: pnpm everyapp secret list`; `fix`: `cd into the app's directory and run this again, or add --app <id>`.
- `set` of a name the manifest's `secrets` doesn't list: `<app> doesn't list <name> as a secret`, then either `It's one of the Gateway's own keys; listing it under secrets gives <app> a secret of its own.` (an install-owned setting) or `It isn't a Gateway setting either.`; `fix`: `add it to secrets in everyapp.config.ts: secrets: [<declared>, "<name>"],`, `rerun`: `pnpm everyapp secret set <name>`. `unset` takes an undeclared name (a secret dropped from the manifest can still be removed). With `--app <id>` the second line is `Its deployed manifest (what --app <id> reads) doesn't list it, and it isn't a Gateway setting either.`, the `fix` ends `and deploy <app> again`, and the `rerun` (the first bullet's too) carries `--app <id>`.

**Fix:** as above; a validation error, never retryable.

Source: `packages/cli/src/commands/secret/index.ts`

### SECRET_NOT_SETTABLE

`secret set|unset` of a Gateway setting the command doesn't change. Outside an app directory, an install-owned setting (`GATEWAY_URL`, `APP_BASE_DOMAIN`, `BETTER_AUTH_SECRET`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `GATEWAY_DEPLOYMENT_MODE`, `CLOUDFLARE_ACCOUNT_ID`, `THIRD_PARTY_DEPLOYS`): `<name> can't be changed with secret <set|unset>` / `It's one of the Gateway's own keys, written once by setup.` (for `THIRD_PARTY_DEPLOYS`: `It's the hosted Gateway's launch gate, opened by hand.`), with no fix. A dev-only setting (`MCP_ACCESS_TOKEN_TTL`, `DATAFORSEO_SANDBOX`): `<name> only works in local development` / `A deployed Gateway doesn't read it.` A name of the sign-in family (`<ID>_SIGNIN_<FIELD>`, `isSignInSettingName`) that no sign-in provider reads, checked after the `didYouMean` check: for an id that isn't a provider, `<ID> isn't a sign-in provider (google, microsoft, github, apple, cloudflare, oidc): pnpm everyapp signin list` (`data.providers`); for a provider's id with a field it doesn't read (`OIDC_SIGNIN_TENANT`), `<name> isn't a setting of Sign in with <label>` / `It reads <its settings>.` (`data.provider`, `data.names`). The family is reserved for the catalog, so it is never an app's secret either.

**Fix:** dev-only: `fix`: `set it in the Gateway's .dev.vars`. Install-owned: none (run `setup`). Sign-in family, unknown id: `fix` `<set|unset> a provider's own settings, as pnpm everyapp signin show <id> names them`; known id: `rerun` `pnpm everyapp signin show <id>`.

Source: `packages/cli/src/commands/secret/index.ts`, `packages/sdk/src/internal/gatewaySettings.ts`

### SECRET_SEVERAL_NAMES

`secret set A B ... --from-env VAR`, or two or more names with a value piped on stdin: a source that holds one value can't set several names. Message: `--from-env sets one secret at a time, and you named <n>` or `A piped value sets one secret at a time, and you named <n>`. Checked first, before any other check. At a terminal (stdin a TTY, no `--from-env`) several names are fine: each gets its own hidden prompt.

**Fix:** `fix`: `run it once per name, e.g. pnpm everyapp secret set A --from-env VAR` or `echo "$A" | pnpm everyapp secret set A`.

Source: `packages/cli/src/lib/secretValue.ts`

### SECRET_VALUE_REQUIRED

`secret set <name>` with no way to get a value: stdin was piped but empty, or there is no terminal to prompt at (`canPromptInTerminal` in `packages/cli/src/lib/output/prompt.ts`: stdin or stderr isn't a TTY, `--json`, or `CI` is set). Message: `Can't ask for <name>'s value without a terminal` / `Or pipe it in: echo "$<name>" | pnpm everyapp secret set <name>`. A value never comes from the command line.

`events add <url> --secret` raises it when stdin was piped but empty, or there is no terminal to prompt at: `Can't ask for the signing secret without a terminal` / `Pipe it in, or name the environment variable holding it with --secret-from-env.`; `fix`: `leave --secret out to have one made, or add --secret-from-env <VAR>`.

`configure <app>` raises it too, when nothing could be read (no terminal, nothing piped, and `--from-env` found no variable) and a required setting is unset: `Can't ask for <app>'s settings without a terminal` / `<app> needs <names>. Run this at a terminal, pipe NAME=value lines in (one per line), or export them under those names and add --from-env (which also takes the variable of any unset optional setting).`; `data.names` lists the names still missing (of a setting with several names, only the ones not set). An app that is ready ends `done` instead.

**Fix:** `rerun`: `pnpm everyapp secret set <name> --from-env <name>`; from `configure`: `pnpm everyapp configure <app> --from-env` (`rerunNote` `with the variables exported`), or before the app's first deploy `pnpm everyapp configure --from-env` with `in the app's directory, with the variables exported` (the name form is refused until then).

Source: `packages/cli/src/lib/secretValue.ts`, `packages/cli/src/commands/configure/index.ts`, `packages/cli/src/commands/events/add.ts`

### SETTING_VALUE_INVALID

`secret set <name>` of a plain Gateway setting (a name `isPlainGatewaySetting` knows, such as `EMAIL_FROM`, `EMAIL_PASSWORD_SIGN_IN` or `CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS`) with a `--from-env` or piped value the Gateway wouldn't read, checked after the value is trimmed and before anything is written. Message: `<name> can't be "<value>"` (the value as typed, on one line, at most 64 characters: a plain value is never hidden), then one line saying what is wrong, such as `Not one of true, false, 1, 0, on, off, yes or no.` or `"hello" isn't an address or Name <address>.`; `data.name` is the setting. At a terminal the same check re-asks the visible prompt with that line instead of failing; a credential (any other name) is never checked or trimmed. Each setting's rule, as the Gateway parses it, is listed in secrets.md under "Plain settings are shown and checked". The sign-in providers' plain settings are checked the same way (`lib/signinValues.ts`): `OIDC_SIGNIN_ISSUER` an https URL without a query, fragment, credentials or a loopback host; `MICROSOFT_SIGNIN_TENANT` a GUID or `common`, `organizations`, `consumers`; `OIDC_SIGNIN_LABEL` at most 40 characters. `signin add` raises this code for a `--label` over 40 characters (the issuer and the tenant have codes of their own there: [`SIGNIN_ISSUER_INVALID`](#signin_issuer_invalid), [`SIGNIN_TENANT_INVALID`](#signin_tenant_invalid)), before it connects.

**Fix:** `fix`: `use <what the setting takes>`, the line the prompt shows as `Takes …`: e.g. `use true or false; false turns password sign-in off (only while Cloudflare Access sign-in is on)`, `use an address, or Name <address>`, `use email domains whose people join without an invitation, comma separated, e.g. example.com`. A validation error: no rerun.

Source: `packages/cli/src/lib/secretValue.ts`, `packages/cli/src/lib/signinValues.ts`, `packages/cli/src/commands/signin/index.ts`

### SHARED_APP_ACCESS

`workspace app set <app> --everyone on`, `workspace app access <app>` (listing or changing), and `workspace group apps <group> --add/--set <app>`: the app is a shared app (`apps.scope = 'shared'`), which every member of every organization can open already, so its access is nobody's to change and it is never an organization's default or a group's app. Checked before the write; the group insert checks it again (`WHERE EXISTS (… scope != 'shared' …)`). Headline: `<app> is a shared app: every member of every organization can open it, so its access can't be changed`.

**Fix:** none offered; no rerun; not retryable.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`sharedAppAccess`).

### SHARED_APP_FORBIDDEN

A Cloudflare login whose verified email isn't an owner or admin of the platform organization tried to `deploy` or `delete` a shared app (a row whose scope is `shared`; a redeploy keeps the row's scope), or to change its email lists with `email set|unset`: `Only <organization> owners and admins can <deploy|delete|change the email of> shared apps` / `<email> isn't an owner or admin of <organization>, the platform organization.` An API token (`CLOUDFLARE_API_TOKEN` set, so the deployer has no email) is the account's own authority and is never checked.

**Fix:** `fix`: `ask an owner of <organization> to make you an admin, or to do it for you`.

Source: `packages/cli/src/lib/gateway/registry.ts`

### SIGNIN_FLAG_NOT_APPLICABLE

`signin add <id>` with a flag for a setting the provider doesn't have: `--issuer` or `--label` for anything but `oidc`, `--tenant` for anything but `microsoft`. Checked first, before anything connects; nothing is written. Headline: `<flags> isn't a setting of Sign in with <label>` (or `aren't settings`), then which provider each flag belongs to and the settings this one reads; `data.provider`, `data.flags`.

**Fix:** `fix`: `drop <flags>`. No rerun; not retryable. Check the id: `pnpm everyapp signin show <id>` lists the provider's settings.

Source: `packages/cli/src/commands/signin/index.ts`

### SIGNIN_ISSUER_INVALID

`signin add oidc` with an issuer (`--issuer`, or typed at the prompt) the Gateway wouldn't read: not a URL, not `https:`, with a user name or password, a query or a fragment, or on `localhost`/`127.0.0.1` (a deployed Gateway can't reach it; the Gateway's loopback allowance is for local development only). The same rule as `normalizeIssuer` in `apps/every-app-gateway/src/auth/sign-in-providers/config.ts`, which keeps the provider off for such a value. Checked before anything connects (a flag) or before anything is written (a typed value). Headline: `OIDC_SIGNIN_ISSUER can't be "<value>"`, then what is wrong; `data.name`.

**Fix:** `fix`: `use the issuer's https URL, which serves /.well-known/openid-configuration (no query, fragment or user:password@)`. No rerun. The issuer is the `issuer` value of the provider's discovery document (`curl -s <issuer>/.well-known/openid-configuration | jq -r .issuer`).

Source: `packages/cli/src/lib/signinValues.ts`, `packages/cli/src/commands/signin/index.ts`

### SIGNIN_TENANT_INVALID

`signin add microsoft --tenant <x>` (or a typed tenant) that is neither a GUID nor `common`, `organizations` or `consumers`, the Gateway's `TENANT` rule; a domain such as `acme.onmicrosoft.com` is refused, since the Gateway would keep Microsoft sign-in off for it. Checked before anything connects or is written. Headline: `MICROSOFT_SIGNIN_TENANT can't be "<value>"`; `data.name`.

**Fix:** `fix`: `use the Directory (tenant) ID, a GUID like 72f988bf-86f1-41af-91ab-2d7cd011db47, or common, organizations or consumers`. The Directory (tenant) ID is on the app registration's Overview page in the Entra admin center. No rerun.

Source: `packages/cli/src/lib/signinValues.ts`, `packages/cli/src/commands/signin/index.ts`

### SIGNIN_UNKNOWN_PROVIDER

`signin add|show|remove <id>` with an id that isn't in the sign-in catalog (`packages/sdk/src/internal/signInProviders.ts`), compared lowercased: `<id> isn't a sign-in provider` / `The Gateway offers google, microsoft, github, apple, cloudflare and oidc; oidc is any OpenID Connect issuer (Okta, Entra ID, Keycloak, Auth0…).` Checked before anything connects; `data.providers` lists the ids.

**Fix:** `rerun`: `pnpm everyapp signin list`. For an identity provider not in the list, use `oidc` with its issuer URL.

Source: `packages/cli/src/commands/signin/index.ts`

### SIGNIN_VALUE_REQUIRED

`signin add <id>` with a required setting of the provider neither given by a flag nor set on the Gateway already, and no terminal to ask at (`--json`, `CI`, or stdin/stderr not a TTY); checked after connecting and reading which names the Gateway holds, before anything is written. Headline: `Sign in with <label> needs <names>, and there's no terminal to ask at` / `Give <flags> (the secret from an environment variable, never the command line), or run this at a terminal.`; `data.provider`, `data.missing` (the setting names), `data.flags` (the flags that give them), `data.callbackUrl` (the redirect URL to register). At a terminal, an empty answer to a required setting's prompt raises it too: `Sign in with <label> needs <name>` / `Nothing was changed.`

**Fix:** `rerun`: the command with the flags, the values given kept and the missing ones as placeholders: `pnpm everyapp signin add github --client-id <client id> --client-secret-from-env <VAR> --json` (`--issuer <issuer url>` for oidc). The person exports the secret in hidden first (the setup file `setup/signin-<id>.md`), or runs `pnpm everyapp signin add <id>` in their own terminal.

Source: `packages/cli/src/commands/signin/index.ts`

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

`teardown --account-id <id>` where `<id>` isn't on the allowlist of dedicated test accounts: `EVERYAPP_TEST_ACCOUNTS` (ids separated by commas or whitespace) and the file `~/.config/everyapp/test-accounts` (`$XDG_CONFIG_HOME/everyapp/test-accounts` when set; one id per line, `#` starts a comment), read together. Checked before the token and before any read. Headline: `Cloudflare account <id> isn't on the teardown allowlist`, then `teardown deletes everything EveryApp made in an account, so it runs only against accounts listed as dedicated test accounts.`; `data.accountId`, `data.file`.

**Fix:** `fix`: `only for a dedicated test account that holds nothing else (docs/runbooks/onboarding-loop-test-accounts.md): set EVERYAPP_TEST_ACCOUNTS=<id> for this one command, or add a line <id> to <file>`; no rerun; not retryable. Never add an account to the list on the person's behalf.

Source: `packages/cli/src/lib/teardown/guards.ts` (`checkAccountEligible`, `readAllowlist`).

### TEARDOWN_TOKEN_TOO_BROAD

`teardown`: `cf auth whoami` under `CLOUDFLARE_API_TOKEN` lists an account that isn't on the allowlist, or a forbidden one, so there would be a path from this run to a live account. Checked before any read of the account. Headline: `CLOUDFLARE_API_TOKEN sees <n> account(s) that isn't a test account|aren't test accounts: <name (id), …>`, then `A teardown token must be scoped to the test account alone (Account Resources → Include → that account), so there is no path from here to a live account.`; `data.accountId`, `data.accounts` (the accounts outside the list).

**Fix:** `fix`: `mint a token for the test account only (runbook step 5)`; no rerun; not retryable.

Source: `packages/cli/src/lib/teardown/guards.ts` (`checkTokenScope`).

### TIER_POLICY

`deploy` (self-host), after the registration and before the `app.register` step is reported (a `--json` run shows no `app.register` step before this error): `manifestTierProblems(manifest, plan.app.tier)` returned problems. Message: `<app> can't be deployed as configured` followed by one problem per line. For tier `service_binding` (the tier the CLI registers every app on) there are never any; for tier `dispatch` the problems are `resources.hyperdrive: Hyperdrive isn't available to apps in a dispatch namespace (an account holds at most 25 configs)`, `resources.r2: R2 buckets aren't available to apps in a dispatch namespace yet`, `resources.ai: the Workers AI binding isn't available to apps in a dispatch namespace (it bills the platform's account); list the workers-ai provider instead`, `resources.browser: Browser Rendering isn't available to apps in a dispatch namespace (it bills the platform's account)`, `resources.images: the Images binding isn't available to apps in a dispatch namespace (it bills the platform's account)`, `resources.vectorize: Vectorize indexes aren't available to apps in a dispatch namespace yet`, `resources.aiGateway: AI Gateways aren't available to apps in a dispatch namespace yet`, `resources.analyticsEngine: Analytics Engine datasets aren't available to apps in a dispatch namespace (their names are account-wide and their writes bill the platform's account)`, `email.inbound: apps in a dispatch namespace don't receive mail` and `secrets: third-party apps can't have secrets of their own yet`; any other tier is `apps on tier "<tier>" can't be deployed`.

**Fix:** `fix`: `change everyapp.config.ts, then deploy again`.

Source: `packages/cli/src/commands/deploy/deployApp.ts`, `packages/perimeter/src/manifest/manifest.ts` (`manifestTierProblems`)

### TOKEN_NOT_FOUND

`workspace token revoke <id>`: no personal access token (`user_access_tokens` row) with that id belongs to the organization. One revoked already is not an error: the command says so (`data.already: true`). Headline: `No personal access token <id> in <organization>`.

**Fix:** `rerun`: `pnpm everyapp workspace tokens`, `rerunNote`: `lists them by id`.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`revokeToken`).

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

### USER_IN_OTHER_ORGANIZATION

`workspace reset-link <email>`: the member also belongs to another organization of the Gateway. A password is account-wide, so a reset link made through one organization sets the password that signs in to the others too; the Gateway's own rule (`requireAccountWideManageable` in MembershipService) refuses it to every admin, and the CLI keeps it (the design's parity row for `admin.createPasswordResetLink`). Checked after the member is found and before anything is written. Headline: `<email> also belongs to <organization> and <organization>, and a password is account-wide`, then `The Gateway's own rule: a password-reset link is never made for someone in another organization, since it would reach that one too.`; `data.member` (`id`, `email`, `name`), `data.organizations` (the others: `id`, `name`, `slug`).

**Fix:** `fix`: `they reset it themselves with Forgot password (the Gateway's email must be configured), or they are removed from the other organization first`. Not retryable. (`deactivate` and `remove` don't carry this code: the operator is root in every organization, and their account-wide rule is `LAST_OWNER` across every organization the person owns.)

Source: `packages/cli/src/lib/gateway/workspace.ts` (`resetLink`).

### USER_NOT_FOUND

`workspace deactivate/reactivate/remove/reset-link <email>`, `workspace group members --add/--remove/--set`, `workspace app access --add/--remove/--set`, and the `--user` of `workspace activity/tokens/connections` given an email: no member of the organization has that email (letter case aside) or user id. A member of another organization only is not found here: `--org` names the organization. The group and grant inserts check membership again on the write (`WHERE EXISTS (SELECT 1 FROM members …)`). Headline: `<x> isn't a member of <organization>`. On the three trails, a `--user` that isn't an email and isn't a member's id is taken as the id of someone who has since left (the trails keep their rows, named by id, as Admin → Activity shows them), so it lists their rows or none, and the headline says `<id> (no longer a member)`.

**Fix:** `rerun`: `pnpm everyapp workspace users`, `rerunNote`: `lists the members and invitations`.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`findMember`), `packages/cli/src/commands/workspace/shared.ts` (`userFilter`).

### VALUE_ON_COMMAND_LINE

A value typed on the command line where everyapp never takes one: it lands in the shell's history and the process list, and it is never shown back. Three raise sites, each before the Gateway is reached:

- `configure NAME=value`: the app argument looks like a value. Message: `<NAME>=… looks like a value on the command line, which configure never takes` / `It lands in the shell's history and the process list: rotate it if it was real. Nothing was set.`; `fix`: `pipe NAME=value lines in (one per line), or export <NAME> and add --from-env`. Exit 1.
- `events add --secret <value> …` or `events add <url> --secret=<value>`, caught by the argument parser (`VALUE_SWITCHES` in `packages/cli/src/argumentErrors.ts`: a switch that stands for a value read elsewhere): `--secret takes no value on the command line`, then the note the argument errors give a value (`A value never goes on the command line: …`); `fix`: `give --secret alone: it asks at a hidden prompt, or reads the value piped in or from --secret-from-env <VAR>`. Exit 252, like the [argument errors](#argument-errors-exit-251-and-252).
- `events add --secret <value>` with no URL, so the value took the URL's place: `--secret takes no value on the command line` / `It lands in the shell's history and the process list: rotate it if it was real. Nothing was added.`; the same `fix`. Exit 1.

**Fix:** as each says. No rerun; rotate the value if it was real.

Source: `packages/cli/src/commands/configure/index.ts`, `packages/cli/src/argumentErrors.ts`, `packages/cli/src/commands/events/add.ts`

### VECTORIZE_CONFIG_MISMATCH

`deploy`, step `app.resources`: the Vectorize index the app recorded for a `resources.vectorize` binding has another shape than the manifest now declares (other dimensions or metric, or not the declared preset; a preset's dimensions and metric are Cloudflare's, so a preset is compared by name). An index can't be reshaped, and the deploy never deletes one to make it again. Checked before the build is installed: nothing is uploaded. Message `Vectorize index "<name>" has <768 dimensions, cosine|the preset <preset>>, but everyapp.config.ts declares <its shape> for <BINDING>` then `An index can't be reshaped once it is created.`

**Fix:** `data.fix`: `rename the binding in everyapp.config.ts to make a new one, or change <BINDING> back to <the index's shape>`; `data.rerun` is this same command. Not retryable. Renaming makes a new, empty index; the old one stays the app's until `delete --purge` (or delete it in the dashboard, AI → Vectorize).

Source: `packages/cli/src/lib/app/resources.ts`, `packages/cli/src/lib/cf/vectorize.ts`

### VECTORIZE_NAME_TOO_LONG

`deploy`, step `app.resources`, before any index is looked up or made: a `resources.vectorize` binding's index name (`<worker>--<binding>`, the binding lowercased with `_` as `-`) is longer than Cloudflare's 64 characters: `<BINDING> would be the Vectorize index "<name>", longer than Cloudflare's 64 characters`.

**Fix:** `data.fix`: `shorten its binding name in everyapp.config.ts`. No rerun, not retryable.

Source: `packages/cli/src/lib/app/resources.ts`, `packages/perimeter/src/manifest/manifest.ts` (`vectorizeNameFor`, `MAX_VECTORIZE_NAME_LENGTH`)

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

### WORKSPACE_NAME_INVALID

`workspace rename <name>` with a name the shared rule refuses (`validOrganizationName` in `packages/sdk/src/internal/organizationName.ts`, the rule the Gateway's own Manage workspace → Rename applies): empty, over 64 characters, or carrying a control or invisible formatting character (a line break, a bidirectional override, a zero-width character). A name is trimmed and its runs of spaces made one before the check. Refused before any login or network. Headline: `Use 1 to 64 characters with no line breaks`.

**Fix:** `fix`: give the name as one argument, quoted when it has spaces. Not retryable.

Source: `packages/cli/src/commands/workspace/index.ts` (`renameWorkspace`).

### WORKSPACE_NOT_A_MEMBER

`workspace invite <email>`: an invitation records who sent it (`invitations.inviter_id`), so the operator needs an account on the Gateway that is a member of the organization, found by the Cloudflare login's verified email as the registry finds a deployer. Raised when the login is an API token (no email), when no verified account has the login's email, or when that account isn't a member of the organization. Nothing is written. Headline: `Only a member can invite: an invitation records who sent it`, then which of the three it is.

**Fix:** `fix`: `claim the Gateway (pnpm everyapp setup) or get invited to <organization>, or invite from Admin → Users` (for an API token: `log in with your Cloudflare account (pnpm everyapp login), claim the Gateway …`). No rerun; not retryable.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`requireOperatorMembership`).

### WORKSPACE_NOT_CLAIMED

`workspace rename` on a Gateway nobody has claimed yet: its install organization has no owner (`installOrganization` in `packages/cli/src/lib/gateway/registry.ts` finds no organization with an owner). The setup claim names the workspace after its owner, so a name written before it would be overwritten. Headline: `The Gateway has no owner yet`.

**Fix:** `fix`: open the Gateway in a browser and claim it, then run the command again. Not retryable.

Source: `packages/cli/src/lib/gateway/workspace.ts` (`claimedWorkspace`).

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

`not_found`: API code `10007` (Worker), `10009` (KV key), `7404` (D1 database), `10200` (Workflow) or `11000` (queue), Vectorize's `vectorize.index.not_found` (`[3000]`, 404) or `vectorize.index.deleted` (`[3005]`, 410: an index deleted a moment ago, whose name a create takes at once), or the text `not found` or `does not exist` (an AI Gateway's `[7002] Not Found`). Most callers catch this kind themselves (`isCfError(error, "not_found")`); it is reported only where none did.

**Fix:** none; not retryable.

Source: `packages/cli/src/lib/cf/errors.ts`

### CF_ALREADY_EXISTS

`already_exists`: API code `7502` (D1), `10014` (KV) or `11009` (a queue: `Queue name '<name>' is already taken.`), Vectorize's `vectorize.index.duplicate_name` (`[3002]`, 409), or the text `already exists`: a second resource with the same name was refused. The deploy's resource creation turns this into `RESOURCE_NAME_TAKEN`; it is reported raw elsewhere.
`already_exists`: API code `7502` (D1) or `10014` (KV), or the text `already exists` (an AI Gateway's `[7001] An object with this id already exists`): a second resource with the same name was refused. The deploy's resource creation turns this into `RESOURCE_NAME_TAKEN`; it is reported raw elsewhere.

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

`free_plan`: the text `Workers Paid` or `paid plan` (case-insensitive). `reportFailure` checks this kind before anything else and emits the `upgrade_workers_paid` action instead (`Cloudflare refused, for the Free plan: <message>` / `EveryApp needs Workers Paid ($5 a month, then usage). Subscribe, then run this command again.`, `data.url`: `https://dash.cloudflare.com/?to=/:account/workers/plans`, `data.rerun`: this command), so a run never ends with `CF_FREE_PLAN`; the kind is how callers recognize it.

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

### CF_ACCESS_NOT_ENABLED

`access_not_enabled`: the message carries `access.api.error.not_enabled` (API code `9999`, 403): the account never opened Zero Trust, so every Access endpoint but `organization create` refuses (seen on a fresh account on 2026-10-24, on `access/organizations`). `teardown` reads it as a service with nothing of EveryApp's in it (a skipped `teardown.found` step, see `TEARDOWN_READ_FAILED`). `access on` and `access show` read it as "no team yet" (`getAccessOrganizationOrNone()` in `packages/cli/src/lib/cf/access.ts`) and `on` creates the team, which works on such an account without the dashboard's onboarding, plan pick or payment details (checked live on the loop's test account, 2026-10-24, `docs/onboarding-loop`); so the code surfaces from `access on` only when the create itself failed and something else refused after it.

**Fix:** none given. Run `access on` again; if Cloudflare keeps answering it after the team was created, open Zero Trust once in the dashboard.

Source: `packages/cli/src/lib/cf/errors.ts`

### CF_D1_ID_REJECTED

`d1_id_rejected`: the text `Expected a D1 database ID`: cf was given a database name or binding where it wanted an id.

**Fix:** none; not retryable (a CLI bug if it happens).

Source: `packages/cli/src/lib/cf/errors.ts`

### CF_QUEUE_CONSUMER_WORKER

`queue_consumer_worker`: API code `10064`, `Cannot delete this Worker as it is a consumer for a Queue. Remove it from the Queue's consumers first, then retry.` (403; cf adds "Check your API token permissions", which is not the cause). Cloudflare refuses to delete a Worker that consumes a queue, even with `--delete-with-references`. `delete --purge` and `teardown` detach the app's Workers' consumers first (`cf queues consumers delete <consumer-id> --queue-id <queue-id> --force`), so it is reported only for a consumer added outside everyapp to a queue the app never recorded.

**Fix:** none offered; not retryable. Remove the Worker from the queue's consumers (dashboard: Compute (Workers) → Queues → the queue's Settings), then run the command again.

Source: `packages/cli/src/lib/cf/errors.ts`

### CF_QUEUE_IN_USE

`queue_in_use`: API code `11005`, `Cannot delete queue '<name>' that is still referenced by a binding in a Worker.` A queue a Worker binds can't be deleted. `delete --purge` deletes the app's queues after its Workers and keeps one that a Worker outside the app still binds (`RESOURCES_KEPT`); `teardown` keeps it with a warning.

**Fix:** none offered; not retryable. Remove the binding from that Worker, or delete the Worker, then delete the queue.

Source: `packages/cli/src/lib/cf/errors.ts`

### CF_UNKNOWN

`unknown`: cf failed (non-zero exit) and no rule above matched. The message is cf's.

**Fix:** none; not retryable. Run with `--verbose` to see cf's output as it comes.

Source: `packages/cli/src/lib/cf/errors.ts`

## Argument errors (exit 251 and 252)

What stricli's router and parser refuse, reported as an `error` event through the run's sink (so `--json` gets NDJSON) with a code from `ArgumentErrorCode`, a headline, and in `data`: `didYouMean` (a close match: within two edits, case-insensitive), `usage` (`pnpm everyapp <command> <args> [flags]`), `help` (`pnpm everyapp <command> --help`) or `fix`. The exit code stays stricli's: 251 for a command it can't find, 252 for arguments. None has a rerun. A value typed with `events add --secret` is [`VALUE_ON_COMMAND_LINE`](#value_on_command_line) from the parser too (exit 252), described with the command's own raise.

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

Also raised by `workspace app cap <app> [<n|off>] [--unlimited]` itself, before it connects, when `--unlimited` comes with a number or `off`: `--unlimited takes no number and no off`, `data.fix` gives the command with `--unlimited` alone (the parser cannot see the conflict).

**Fix:** as the message says.

Source: `packages/cli/src/argumentErrors.ts`

### MISSING_ARGUMENT

Exit 252. A required positional is missing: `Missing the <argument>` (named by the parameter's brief when it is 30 characters or shorter, else its placeholder), or for a list parameter `Name at least one <brief>`. `data.usage`.

Also raised by `workspace app cap <app>` itself, before it connects, when neither a cap nor `--unlimited` is given (the second argument is optional for `--unlimited`'s sake): `Missing the cap`, `data.usage`.

**Fix:** pass the argument.

Source: `packages/cli/src/argumentErrors.ts`

### MISSING_FLAG_VALUE

Exit 252. `--<flag> needs a value` when the flag was typed without one; `<command> needs --<flag> <placeholder>` when a required flag wasn't given at all. `data.usage` (required flags shown in it), `data.help`.

**Fix:** give the flag, with a value.

Source: `packages/cli/src/argumentErrors.ts`

### TOO_MANY_ARGUMENTS

Exit 252. `<command> takes no arguments (got "<input>")`, or `<command> takes one argument|<n> arguments, but got another: "<input>"`. `data.usage`.

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

- Manifest (`manifestProblems`, `apps/every-app-gateway/src/server/deploy/metadata.ts`): helper Workers (`workers`); Workflows; KV namespaces (`use D1`); R2 or Hyperdrive (`which the browser deployer can't provision; use the CLI`); Email sending bindings (`resources.sendEmail`; `send through the Gateway's email capability`); migrations with a `dialect` other than `sqlite` or an `engine` other than `drizzle` (`browser installs support D1 SQL migrations only`); `secrets`; `email.inbound`; a Durable Object class that names a helper Worker; more Durable Object classes than the policy's limit (`thirdPartyLimits.durableObjectClasses`; 2 for self-hosted browser installs).
- Worker config (`bundleProblems`): a Worker name other than the tenant-neutral build's sentinel (`a deploy through the gateway uploads the tenant-neutral build, uninstalled (everyapp deploy --gateway)`); any `worker.config.json` key outside `name`, `compatibilityDate`, `compatibilityFlags`, `workersDev`, `previewUrls`, `observability`, `env`, `exports`, `manifest`, `assets`, `triggers`; `workersDev` or `previewUrls` not `false`; any `triggers`; no compatibility date; compatibility flags that aren't a list (`its compatibility flags aren't a list`); a compatibility flag outside `nodejs_compat`, `nodejs_compat_v2`, `nodejs_als`, `global_fetch_strictly_public`; no main module; `assets` keys outside `htmlHandling`, `notFoundHandling`, `runWorkerFirst`; `EVERYAPP_DEV` set.
- Bindings: the platform's text bindings (`EVERYAPP_APP_ID`, `EVERYAPP_AUDIENCE`, `EVERYAPP_IDENTITY_PUBLIC_KEYS`, `EVERYAPP_IDENTITY_ISSUER`) not of type `text`, or `EVERYAPP_APP_ID` not the manifest's id; `GATEWAY_URL` and `EVERY_APP_ORG_ID` not declared as `secret`; a `worker` binding other than `EVERY_APP_GATEWAY` to `every-app-gateway`'s `AppGateway` export; a `d1` binding the manifest doesn't declare; a `durable-object` binding to another Worker or to an undeclared class; an `assets` binding with no assets uploaded; any `secret`. A `version-metadata` binding (`CF_VERSION_METADATA`) is accepted; any other binding type (service bindings other than the Gateway's, dispatch namespaces, KV, R2, Hyperdrive, rate limits, secrets store, mTLS, Workers AI, email, queues, variables) is refused. Exports that aren't `worker` or a declared Durable Object class, or whose `state` isn't `created`.
- Pipeline (`pipeline.ts`): no ES module at the Worker's main module; `migrations.binding` not one of its D1 databases; dropping a Durable Object class the live Worker has (`which deletes its data; third-party deploys never do`); a live migration tag the deployer didn't write (not `everyapp-v<n>`). A GitHub or oss.new release whose Build Output has helper Workers (`release.ts`).
- Self-host, same intent: `manifestTierProblems` (`TIER_POLICY` above) refuses Hyperdrive, R2, Workers AI, Browser Rendering, Images, Vectorize, AI Gateways, Analytics Engine, `email.inbound` and `secrets` on tier `dispatch`.

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

Status 403, browser install: the session's live role in the chosen organization isn't `owner` or `admin`: `Only the organization's owners and admins install apps.` On a self-hosted Gateway also when the chosen organization isn't the install organization (the oldest with an owner), the only one whose owners and admins may spend the account-wide `CF_DEPLOY_TOKEN`, or when no organization has an owner yet: `On a self-hosted Gateway only the install organization's owners and admins install apps.` `GET /api/admin/apps/install` answers it when the signed-in person owns or administers no organization the install accepts (by the person, not the session's active workspace); the install and the job poll check the workspace they name, and a refusal of another organization is logged as `app_install.refused` (warn).

**Fix:** ask an owner or admin; on a self-hosted Gateway, one of the install organization, or deploy with `pnpm everyapp install <url>` from the terminal.

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

| Code                  | Status  | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_NOT_REGISTERED`  | 404/409 | Deploying an app id that isn't registered (or is deleted) for the organization; a job for an app row with no Worker name (409). Below, under [Codes raised with a dynamic value](#codes-raised-with-a-dynamic-value).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MIGRATION_FAILED`    | 422     | Job: a migration's statements failed: `Migration <name> failed: <error>. Nothing was uploaded; the version that is serving keeps running.` Documented above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `APP_NOT_FOUND`       | 404     | Job: the app's registry row is gone; also a registry refusal for a deleted app. Documented above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `APP_CHANGING`        | 409     | Job: the registry row changed while the deploy recorded its upload; self-hosted browser install: the row changed before the lease was taken. Documented above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `RESOURCE_OWNED`      | 409     | Ledger: the D1 database's name is recorded as another app's. Documented above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `RESOURCE_REPLACED`   | 409     | Ledger: the recorded database was deleted and another created under its name. Documented above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `LEASE_LOST`          | 409     | Self-hosted browser install: the install lease couldn't be renewed. Documented above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ORG_KEY_UNAVAILABLE` | 409     | Every candidate key for the organization's slug is taken. Below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `RELEASE_INVALID`     | 422     | Browser install: the archive isn't gzip or tar, has entries beyond `.cloudflare`, `migrations` and `release.json`, or `release.json` / `worker.config.json` is missing or malformed. The CLI's own code of the same name is above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `RELEASE_UNSUPPORTED` | 422     | Browser install: `release.json` `schema` isn't 1, `kind` isn't `app`, or `buildOutputVersion` isn't `v0`. Documented above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `RELEASE_TOO_LARGE`   | 413     | Browser install: over 100 MB compressed or unpacked. Documented above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `NO_RELEASE`          | 404     | Browser install: the repository's latest release has no `everyapp-release.tar.gz`. Documented above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Registry rules        | 400–409 | `RegistrationError` codes (`packages/perimeter/src/registry/registration.ts`) pass through unchanged: `INVALID_APP_HOSTNAME`, `RESERVED_APP_ID`, `INVALID_APP_ID`, `INVALID_WORKER_NAME`, `INVALID_MANIFEST`, `RESOURCE_NAME_CONFLICT` (400); `SHARED_APP_NOT_PLATFORM` (403); `APP_SCOPE_MISMATCH`, `HOSTNAME_TAKEN`, `WORKER_NAME_TAKEN` (409); `APP_TIER_MISMATCH` (400 or 409); `PROVIDER_APP_UNKNOWN` (400, from `mcp on`); `REMOTE_MCP_INVALID`, `REMOTE_MCP_URL_REFUSED` (400) and `REMOTE_MCP_EXISTS`, `REMOTE_MCP_SECRET_TAKEN` (409), from adding a remote MCP server. Each except `INVALID_APP_ID`, `INVALID_MANIFEST`, `WORKER_NAME_TAKEN`, `PROVIDER_APP_UNKNOWN` and `REMOTE_MCP_INVALID` (documented above) is described under [Codes raised with a dynamic value](#codes-raised-with-a-dynamic-value). |

## Warnings

A `warning` event (`{ type: "warning", code, message, step?, data? }`) is something a run went on past. The terminal shows it as a `!` headline with the message's further lines dim and, from `data`, `rerun` (with `rerunNote`), `fix` or `url` after it; `--json` gets the event as is. `QUIET_WARNINGS` in `packages/cli/src/lib/output/events.ts` names the ones the terminal renderer skips without `--verbose`: only `CUSTOM_DOMAIN_OWNER_UNCHECKED`. The `ACCESS_*` warnings come from `access on` (`packages/cli/src/commands/access/index.ts`) and from the Access sync `deploy` and `delete` run afterwards (`syncAppsAccessAfter` in `packages/cli/src/lib/access/sync.ts`), except `ACCESS_IN_FRONT`, which the live wait and `setup` emit; the command is documented at [/docs/agent/access](/docs/agent/access), and the agent-driven Access setup step by step in `packages/cli/skills/everyapp/setup/access.md` (in an app `.claude/skills/everyapp/setup/access.md`).

### ACCESS_APPLICATION_MISSING

After `update` and `setup` on a live self-hosted Gateway, step `gateway.access`: one of the two Access applications is there and the other isn't (deleted in the dashboard), so the Gateway requires an Access login that nothing asks for on those hosts: `Cloudflare Access has no application in front of <host | *.<base>>` / `The Gateway requires an Access login, and nothing there asks for one: run access on to put it back.` `data.hosts`, `data.rerun`: `pnpm everyapp access on`. The reconcile never creates an application (that is `access on`'s job, and it needs people to let in).

Source: `packages/cli/src/lib/access/applications.ts`

### ACCESS_APP_OUTSIDE_BASE

Step `access.routes` (`access on`; the sync after `deploy` and `delete`): an app whose hostname isn't under the apps' domain gets no Access destination: `<apps> isn't|aren't under the apps' domain, so Access isn't set up for it|them.` `data.apps` (the app ids). Nothing to do short of giving the app a host under the base domain.

Source: `packages/cli/src/lib/access/sync.ts` (`emitPlanWarnings`), `packages/cli/src/lib/access/plan.ts`

### ACCESS_EMAIL_NOT_INVITED

`access on --email …`, step `access.update`: an address that has no account on this Gateway (neither a member nor invited): `<emails> has|have no account on this Gateway` / `Access will let them through, but the Gateway refuses anyone it doesn't know. Invite them in Manage workspace → Users.` `data.emails`.

Source: `packages/cli/src/commands/access/index.ts`

### ACCESS_FOREIGN_DESTINATION

Step `access.routes`: an Access application everyapp manages also covers destinations that aren't EveryApp's; they are kept: `The Access application "<name>" also covers <uris>` / `That destination isn't EveryApp's and stays as it is. access off won't delete this application.` (several: `Those <n> destinations aren't EveryApp's and stay as they are. …`). `data.application` (its name, else id), `data.uris`.

Source: `packages/cli/src/lib/access/sync.ts`, `packages/cli/src/commands/access/index.ts`

### ACCESS_IDP_ANY_CLOUDFLARE_ACCOUNT

`access on` and `access show`, step `access.update`: a Sign in with Cloudflare provider (type `cloudflare`) whose "Restrict to account members" is off: `<name> (cloudflare) is open to any Cloudflare account, so left off the EveryApp applications` (or `… are open …`) / `Restrict to account members is off, so anyone with a Cloudflare account could sign in there, and Cloudflare doesn't promise the address it asserts is verified: someone who registers a Cloudflare account under a member's address could sign in as that member. Turn Restrict to account members on (Zero Trust → Settings → Authentication → the provider), then run access on again; an application that allowed it before keeps it.` `data.providers`: `[{ id, type, name }]`. The setting is read, never changed: the provider `access on` creates has it on, and only a restricted one is allowed on the applications (`allowedSignInProviders` in `packages/cli/src/lib/access/plan.ts`); until then the PIN alone signs people in.

Source: `packages/cli/src/commands/access/index.ts` (`warnIfOpenToAnyCloudflareAccount`)

### ACCESS_IDP_UNVERIFIED_EMAILS

`access on`, step `access.update`: a provider of the team is of a type that doesn't verify the address (`UNVERIFIED_EMAIL_IDP_TYPES`); it is left off the applications: `<name> (<type>) is a generic provider, left off the EveryApp applications` (or `… are generic providers, left off the EveryApp applications`) / `The Gateway signs people in as the email Access asserts. A provider that lets people choose their own address would let them choose someone else's; allow only providers that verify addresses (runbook: "Verified emails").` `data.providers`: `[{ id, type, name }]`.

Source: `packages/cli/src/commands/access/index.ts`

### ACCESS_INLINE_POLICIES

`access on` (step `access.update`) and the reconcile after `update` and `setup` (step `gateway.access`): the existing Access application has policies of its own (`reusable: false`), so the reusable policy `Every App gateway members` can't be attached and the application is left as it is (outcome `skipped`): `The Access application "<name>" has a policy|policies of its own: <names>` / `It is left as it is: Access takes either application policies or reusable ones, not both, so the policy "Every App gateway members" can't be attached and its paths aren't managed here. Make its policies reusable in the dashboard, or manage it there.` `data.application` (its id), `data.policies` (their ids).

Source: `packages/cli/src/lib/access/applications.ts`

### ACCESS_IN_FRONT

The probe of `https://<hostname>/` got a 3xx redirect to Cloudflare Access's login (a `location` matching `cloudflareaccess.com` or `/cdn-cgi/access/`). From `deploy`, step `app.live`, only after the 10-minute wait ran out behind Access (in the normal case the Gateway's per-minute cron makes the app live within a minute and the deploy ends live, with no warning): `Cloudflare Access answers before the Gateway, and the Gateway hasn't made <app> live after 10m 00s` / `The deploy stalled: the Gateway should have reached <app>'s Worker within a minute of the upload. <app> stays uploaded and bound; opening https://<hostname> signed in through Access finishes it when the Gateway can reach it.`, `data.hostname`, `data.rerun` `pnpm everyapp status`, `data.rerunNote` `then deploy again`; the wait ends with outcome `first_visit`. Fix as for [`APP_NOT_LIVE`](#app_not_live): run `status`, do what it says, deploy again. From `setup`, step `setup.owner`, before the owner link is printed: `Cloudflare Access protects <host>` / `Whoever opens the setup link signs in to Access first.` Nothing to do.

Source: `packages/cli/src/commands/deploy/steps/waitForLive.ts`, `packages/cli/src/commands/setup/runSetup.ts`, `packages/cli/src/lib/domains/https.ts`

### ACCESS_LOGIN_NOT_MEMBER

`access on`, step `access.update`: the Cloudflare login's email (`cf auth whoami`; nothing is said for an API token) is neither a member nor an invitee of the Gateway, nor an `--email`: `Sign in with Cloudflare signs you in as <email>, which has no account on this Gateway` / `Access asserts your Cloudflare login's address, and the Gateway refuses anyone it doesn't know. Sign in with the code Access emails to your Gateway account's address instead, or invite <email> in Manage workspace → Users.` `data.email`. Nothing changes: the PIN works for the Gateway account's address.

Source: `packages/cli/src/commands/access/index.ts`

### ACCESS_NOT_CHECKED

Two steps raise it. After `update` and `setup` on a live self-hosted Gateway, step `gateway.access` (`keepAccessAfterGatewayDeploy` in `packages/cli/src/lib/access/applications.ts`): the Access applications couldn't be listed for a reason other than missing permissions (a login without them, and an account that never opened Zero Trust, are silent: Access can't be on without them): `Couldn't check Cloudflare Access after the Gateway deploy` / `<first line of the error>` / `If the Gateway is behind Access, the paths it lets through may be out of step with this release until it is updated.`; `data.rerun`: `pnpm everyapp access on`, `data.rerunNote`: `if the Gateway is behind Access`.

After `deploy` and `delete`, step `app.access` (`syncAppsAccessAfter`): the Access applications couldn't be listed, so whether the Gateway is behind Access, and whether the app's public surface is let through, wasn't checked. A login without the Access permissions (`ACCESS_PERMISSION_MISSING` above) says so only when the app has public routes or `mcp` in its manifest: `This Cloudflare login can't read Cloudflare Access, so <app> wasn't checked against it`; any other failure: `Couldn't check Cloudflare Access for <app>` / `<first line of the error>`; then `If the Gateway is behind Access, <app>'s <public routes | /mcp | public routes and /mcp> need a login there until it is updated.` (on `delete`: `If the Gateway is behind Access, <app>'s host stays listed there until it is updated.`). `data.appId`, `data.rerun`: `pnpm everyapp access on`, `data.rerunNote`: `with a login that can manage Access, if the Gateway is behind it` or `if the Gateway is behind Access`.

Source: `packages/cli/src/lib/access/sync.ts`, `packages/cli/src/lib/access/applications.ts`

### ACCESS_ONE_APPLICATION

`access on` (step `access.update`) and the reconcile after `update` and `setup` (step `gateway.access`): one Access application covers both the Gateway host and `*.<base>`: `One Access application covers <gateway host> and *.<base>` / `It is kept and updated. The runbook recommends two, so an app host's Access cookie is never a Gateway login.` No data.

Source: `packages/cli/src/lib/access/applications.ts`

### ACCESS_RECONCILE_FAILED

After `update` and `setup` on a live self-hosted Gateway behind Cloudflare Access, step `gateway.access` (`keepAccessAfterGatewayDeploy` in `packages/cli/src/lib/access/applications.ts`): the applications were found but bringing them in line with this release failed (the lease wait, a refused update); the run doesn't fail for it: `Couldn't bring Cloudflare Access in step with this Gateway` / `<first line of the error>` / `Until it is updated, the paths Access lets through are the previous release's.` `data.rerun`: `pnpm everyapp access on`.

Source: `packages/cli/src/lib/access/applications.ts`

### ACCESS_ROUTE_NOT_EXPRESSIBLE

Step `access.routes` (`access on`; the sync after `deploy` and `delete`): a public route with no Access path equivalent stays behind Access: `A public route stays behind Access: <app> <path>` (or `<n> public routes stay behind Access: …`) / `Access path patterns take one * per segment, so these have no equivalent. People signed in to Access still reach them.` `data.routes`: `[{ appId, path, reason: "not_expressible" }]`.

Source: `packages/cli/src/lib/access/sync.ts`, `packages/cli/src/lib/access/plan.ts`

### ACCESS_SETUP_SKIPPED

Interactive `setup` (and a `deploy` that installs a Gateway), step `setup.access`: the person answered Yes to "Put Cloudflare Access in front of your Gateway?" and `access on`'s code failed (a login without the Access permissions, a team name Cloudflare refused, anything it raises): `Cloudflare Access wasn't turned on` / `<the error's first line>` / `The Gateway works without it: passwords sign people in.` `data.rerun`: `pnpm everyapp access on`, `data.rerunNote`: `to try again`. Setup goes on to `done` with `data.accessOn: false`; exit 0.

Source: `packages/cli/src/commands/setup/runSetup.ts` (`offerAccessInFront`)

### ACCESS_SYNC_FAILED

Step `app.access` after `deploy` and `delete`: the Access applications were listed and the apps application exists, but updating it failed; the run doesn't fail for it: `Couldn't update Cloudflare Access for <app>'s <public routes | /mcp | public routes and /mcp>` / `<first line of the error>` / `Until it is updated, they need an Access login.` (on `delete`: `<app>'s host stays listed there until it is updated.`). `data.appId`, `data.rerun`: `pnpm everyapp access on`.

Source: `packages/cli/src/lib/access/sync.ts`

### ACCESS_TOO_MANY_PUBLIC_ROUTES

Step `access.routes`: more public paths on one host than Access takes; the rest stay behind Access: `A public route stays behind Access: <app> <path>` (or `<n> public routes stay behind Access: …`) / `Access lets through at most 25 paths per host (two of them for /mcp where the manifest sets mcp). Merge routes under one prefix, or keep these behind the login.` `data.routes`: `[{ appId, path, reason: "too_many" }]`.

Source: `packages/cli/src/lib/access/sync.ts`, `packages/cli/src/lib/access/plan.ts`

### APP_DISABLED

`deploy`, step `app.live`: `<app> is switched off in Admin → Apps`; the Gateway serves it once an admin turns it on. The wait ends with outcome `disabled`.

Source: `packages/cli/src/commands/deploy/steps/waitForLive.ts`

### APP_HOST_OUTSIDE_BASE

`deploy`, step `app.domain`, and the Gateway rebind: the app's hostname isn't one label below the Gateway's app base domain, so it is never published and the app can't be reached. `data.hosts` on the rebind.

Source: `packages/cli/src/commands/deploy/deployApp.ts`, `packages/cli/src/lib/gateway/apply.ts`

### APP_NEEDS_SETUP

`deploy`, after the upload: the app's manifest declares a required provider, capability or secret that isn't set (the settings model, [`/docs/agent/manifest`](/docs/agent/manifest#required-optional-or-one-of-a-group)), so the Gateway won't open it: `<app> won't open until <names> is set` (or `are set`), the second line the first unmet setting's `why`. The one command that opens it is the `done` event's `next` entry (`pnpm everyapp configure <id>`, note `asks for each; <app> opens once they are set`), not `data.rerun`. `configure` itself raises the same warning when the app is still not ready at its end (values from stdin or `--from-env` covered only some of the settings); its `done.data.next` names the command again. Step `app.secrets`; `data.setup` is the app's `AppSetup` (`ready`, `settings`, `unmet`, `groups`, `command`), the shape [`/docs/agent/json`](/docs/agent/json#done) describes.

Source: `packages/cli/src/commands/deploy/deployApp.ts`, `packages/cli/src/commands/configure/index.ts`

### APP_NOT_BOUND

The Gateway rebind (any command that redeploys the Gateway: `setup`, and `deploy`/`delete` when they rebind), for each registered app whose Worker exists but isn't the one everyapp registered (`desired.skipped`): `Skipping <app>: its Worker isn't the one everyapp registered` / `So the Gateway won't route to it.` `data.appId`, `data.workerName`, `data.fix`: `deploy <app> again, or remove it with pnpm everyapp delete <app>`. `status` reports the same as the fix `APP_NOT_BOUND (status)` below.

Source: `packages/cli/src/lib/gateway/apply.ts`

### CAPABILITY_NOT_IN_CATALOG

`dev`, once per capability id the manifest lists outside the built-in catalog: `everyapp dev` can't ask the Gateway, so it runs with the id and says where it is reached from. With `.everyapp/providers/<id>.json` in the app (written by `provider add` in the app's directory or `provider show <id> --save`), the dev Worker reaches it from that spec with the key in `.dev.vars`; without, `data.fix` is `pnpm everyapp provider show <id> --save`. `data.id`, `data.file`, `data.found`. The deploy checks the id against the Gateway's registry (`CAPABILITY_UNKNOWN`).

Source: `packages/cli/src/commands/dev/index.ts`

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

### EVENT_EMAIL_NOT_CONFIGURED

`events add --email owners|admins`, step `events.add`: the Gateway Worker has no `EMAIL_FROM` setting (read by name only), so it can't send the mails yet: each delivery is dead at once with `email_not_configured` until a sender is set. The subscription is added all the same. `The Gateway has no sender (EMAIL_FROM), so these mails can't go out yet` / `Each one is dead at once with email_not_configured until a sender is set.`; `data.rerun`: `pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME`.

Source: `packages/cli/src/commands/events/add.ts`

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

`mcp on` (and the hidden `provider on` through launch week), step `provider.update`, and `mcp add`, step `mcp.add`: the MCP app is on, but the Gateway setting holding its key (a built-in's, `DATAFORSEO_API_KEY`) or its credential (a remote server's, `<ID>_MCP_TOKEN`) isn't set: `<NAME> isn't set on the Gateway` / `<provider>'s tools answer "not set up" until it is.` (a built-in) or `<name>'s tools stay out of /mcp until it is.` (a remote server); `data.fix`: `pnpm everyapp secret set <NAME>`, `data.name`: the setting. The `done` event's `data.key.set` is false and `data.next` names the same command. `mcp add` at a terminal first asks `Set <NAME> now?` and, on yes, reads the value with `secret set`'s own hidden prompt (`--from-env <VAR>` reads it from a variable instead); it warns only when the credential is still unset after that. Set the key (the setup skill's file: `setup/dataforseo.md`, `setup/remote-mcp.md`) and nothing else needs rerunning: the Gateway reads the setting on its next request.

Source: `packages/cli/src/commands/mcp/index.ts`

### REMOTE_MCP_GATEWAY_OUTDATED

`mcp add`, step `mcp.add`: the app is written, but the Gateway's D1 has no `remote_mcp_tools` table (migration 0011), so the Gateway running there predates MCP apps by URL and serves none of the server's tools: `This Gateway predates MCP apps by URL` / `It serves a remote MCP server's tools once it is updated to this checkout.`; `data.rerun`: `pnpm everyapp update`. Until then `secret set` records no credential pin and `mcp show` lists no tools.

Source: `packages/cli/src/commands/mcp/index.ts`

### REMOTE_MCP_PROBE_FAILED

`mcp add`, step `mcp.probe`: the one look at the server from this machine, without the credential (`probeRemoteMcp` in `packages/cli/src/lib/gateway/remoteMcpProbe.ts`: a 2026-07-28 `tools/list`, then a 2025 `initialize` when that isn't a JSON-RPC result, 10 seconds, no redirect followed), found something the operator may want to change. The app is added either way. `data.probe` is what it found (`outcome` `needs-credential`, `redirected` or `unreachable`, with `status`, `location` or `reason`). Three messages: `<url> asks for a credential, and <id> sends none` / `The Gateway's listing of its tools will fail the same way until it has one.` (`--auth none` and a 401 or 403; `data.fix` names `pnpm everyapp mcp remove <id>`, then `pnpm everyapp mcp add <url> --name <id> --auth bearer`); `<url> redirects to <location>` / `The Gateway follows no redirects; register the address it redirects to.` (a 3xx); `Couldn't reach <url> from here: <reason>` / `The Gateway may still reach it; pnpm everyapp mcp show <id> says whether its tools listed.` (no answer in time, a host that doesn't resolve, a refused connection or TLS, or an answer that isn't MCP). A server the Gateway reaches and this machine doesn't (a VPN, an allowlist) is fine: `mcp show` after the first `/mcp` request says whether the tools listed.

Source: `packages/cli/src/commands/mcp/index.ts`, `packages/cli/src/lib/gateway/remoteMcpProbe.ts`

### REMOTE_MCP_SECRET_AMBIGUOUS

`secret set <NAME>_MCP_TOKEN`, step `secrets.gateway`: the value is set, but live MCP apps at more than one origin declare the name (only a row edited by hand can: `mcp add` refuses a second origin with `REMOTE_MCP_SECRET_TAKEN`), so the credential is pinned to none of them and the Gateway sends it to none: `MCP apps at <origins> all declare <NAME>` / `It isn't pinned to any of them, so the Gateway sends it to none until one is removed.`; `data.name`, `data.origins`, `data.rerun` `pnpm everyapp mcp list`. Remove the wrong app (`mcp remove`), then `secret set` again.

Source: `packages/cli/src/commands/secret/index.ts`, `packages/cli/src/lib/gateway/remoteMcpApps.ts` (`bindRemoteMcpCredentials`)

### REMOTE_MCP_SECRET_BOUND_ELSEWHERE

`mcp add`, step `mcp.add`: the credential name the new app declares is set, but pinned (`remote_mcp_credentials`) to another origin, where it was set for an app since removed: `<NAME> was set for <origin>, not <new origin>` / `The Gateway sends a credential only to the origin it was set for; set it again for <name>.`; `data.fix` `pnpm everyapp secret set <NAME>`, `data.boundOrigin`. The app needs setup (`mcp list` says so) until `secret set` pins the name to its origin; only the operator can do that, so an owner or admin who re-points a server never moves a credential.

Source: `packages/cli/src/commands/mcp/index.ts`

### REMOTE_MCP_SECRET_UNDECLARED

`secret set <NAME>_MCP_TOKEN` (any name ending in `_MCP_TOKEN` goes to the Gateway), step `secrets.gateway`: the value is set, but no live MCP app declares the name, so there is no origin to pin it to: `No MCP app declares <NAME>` / `The Gateway pins it to the first MCP app that uses it.`, or when an earlier pin exists, `No MCP app declares <NAME> now` / `It stays pinned to <origin>, where it was set before; the Gateway sends it nowhere else.`; `data.name`, `data.pinnedTo` (that origin, or null), `data.fix` `pnpm everyapp mcp add <url> --secret <NAME>`. Add the server first (`mcp add` offers to set the credential itself), or check the name's spelling against `mcp show <id>`.

Source: `packages/cli/src/commands/secret/index.ts`, `packages/cli/src/lib/gateway/remoteMcpApps.ts` (`bindRemoteMcpCredentials`)

### REMOTE_MCP_TOOL_NOT_LISTED

`mcp tool <id> <tool>`, step `mcp.tool`: `<tool>` is neither a server name nor a listed name in the app's last listing (`remote_mcp_tools`), so the override is written under that name verbatim, as the server's: `<tool> isn't in <id>'s last tool listing` / `The override is kept under the server's name <tool> and applies once the server lists a tool by that name.`; `data.rerun` `pnpm everyapp mcp show <id>`. A typo here overrides nothing: check `mcp show`, then `mcp tool` with the right name (the stray entry is harmless; the Gateway ignores overrides for tools the server doesn't list).

Source: `packages/cli/src/commands/mcp/index.ts`

### REMOTE_MCP_WANTS_OAUTH

`mcp add`, step `mcp.probe`: the server answered 401 or 403 with a `WWW-Authenticate` naming `resource_metadata=`, the MCP authorization spec's sign of an OAuth-protected server. The Gateway doesn't sign in to MCP servers with OAuth this week (`--auth oauth` is recorded and serves no tools). With `--auth none` or `oauth`: `<url> wants OAuth` / `The Gateway doesn't sign in to MCP servers with OAuth yet. If the server also takes an API key, add it with --auth bearer and set the key.` (`data.fix` names the remove and the add with `--auth bearer`); with a credential: `<url> asks for OAuth` / `The Gateway doesn't sign in to MCP servers with OAuth yet; it sends <NAME> as you set it, which works only if the server also takes an API key.` `data.probe` has `oauth: true`.

Source: `packages/cli/src/commands/mcp/index.ts`

### RESOURCES_KEPT

`delete --purge`, step `app.purge`: resources with the app's names that no deploy recorded creating were kept (its Worker, the D1 databases and KV namespaces the registry names, the queues and Vectorize indexes the last deployed manifest declares, Workflows another Worker runs), and any recorded queue a Worker outside the app still binds (`<Queue "name"> (a Worker that isn't <app>'s binds it)`); `data.kept`, `data.fix` (delete them in the dashboard if they are the app's; a Vectorize index under AI → Vectorize).

Source: `packages/cli/src/commands/delete/index.ts`

### RESOURCE_RECREATED

`deploy`, step `app.resources`: a recorded database, namespace, bucket, Hyperdrive config, Vectorize index or AI Gateway no longer exists in the account; a new, empty one is created.

Source: `packages/cli/src/commands/deploy/deployApp.ts`

### SCHEMA_CHECK_SKIPPED

`deploy`, step `app.schema`: the drift check (`SCHEMA_CHECK_FAILED` above) couldn't run: `Can't check the schema against the migrations: drizzle-kit isn't installed` (`data.fix`: `add drizzle-kit to devDependencies`); `… : no drizzle.config.ts` (with the detail `An app that writes its SQL by hand sets migrations.engine to "d1-sql".`); or, when `migrations.config` names the file, `… : no <value> (migrations.config)`, where `<value>` is `migrations.config`'s value.

Source: `packages/cli/src/commands/deploy/steps/checkSchemaDrift.ts`

### TEARDOWN_ALLOWLIST_IGNORED

`teardown`, while reading the allowlist: an entry of `EVERYAPP_TEST_ACCOUNTS` or `~/.config/everyapp/test-accounts` isn't 32 hex characters and was ignored. `Ignored <n> entry|entries of the teardown allowlist that isn't|aren't account ids: <entries>` / `An account id is 32 hex characters (EVERYAPP_TEST_ACCOUNTS, <file>).`; `data.ignored`, `data.file`. The run goes on with the ids that parsed.

Source: `packages/cli/src/lib/teardown/guards.ts`

### TEARDOWN_DELETE_FAILED

`teardown`, step `teardown.delete`: one resource couldn't be deleted (Cloudflare refused: an R2 bucket with objects in it, say), or the DNS records at a published name couldn't be read. `Couldn't delete the <kind "name">` / `<Cloudflare's reason>` (`data.kind`, `data.described`, `data.reason`, `data.fix`: `delete it in the Cloudflare dashboard (<place>)`), or `Couldn't read the DNS records at <name>` / `<reason>` (`data.kind: "dns"`, `data.name`, `data.fix`). The resource is listed under `done.data.kept` with its place in the dashboard; the other kinds are still deleted, and a run after the cause is fixed removes it. A certificate pack is the exception: Cloudflare removes a hostname's pack together with its Custom Domain (which went with the Worker a step earlier) and refuses to delete one on its way out (`[1406] Bad response certificate service`), so a refused pack is listed again, and one no longer in the zone's list, or pending deletion, is no warning: it is counted under `done.data.removed` as `certificate pack <id> for <host> (gone with its Custom Domain)`. A pack still listed and active is kept, its `reason` ending with the note that Cloudflare removes it with the Custom Domain, so the dashboard finishes it. Only a kept DNS record holds the Gateway's D1 database back (`kept on purpose: the next run reads the hostnames of the <n> kept DNS record(s) above from it`); a kept pack never does, so the next install starts from an empty account.

Source: `packages/cli/src/lib/teardown/delete.ts`

### TEARDOWN_READ_FAILED

`teardown`, step `teardown.inventory`: one kind of resource couldn't be listed (a permission the token lacks, say). `Couldn't list <what>; whatever is there is kept` / `<reason>`; `data.what`, `data.reason`, `data.fix`: `check the token's permissions (runbook step 5), then run again`. The kind is reported kept; the inventory, the confirmation and the other kinds go on. A service the account never enabled is not a failed read: Cloudflare answers 403 with the service's own code (Access `[9999] access.api.error.not_enabled` on `access/organizations`, R2 `[10042] Please enable R2 through the Cloudflare Dashboard.` on `r2/buckets`, both seen on a fresh account), there is nothing of EveryApp's in it, and the run says so as a `teardown.found` step with `status: "skip"` (`<Cloudflare Access|R2> isn't enabled in this account: nothing of its to delete`; `data.what`, `data.service`, `data.reason`) and counts zero of that kind, with no warning and nothing under `kept`.

Source: `packages/cli/src/lib/teardown/inventory.ts`

### TOOLS_CATALOG

`dev`, step `dev.mcp`: `Agent tools: <problem>` with the app's MCP tool catalog; `data.appId`.

Source: `packages/cli/src/commands/dev/devAppGateway.ts`

### UPLOAD_UNRECORDED

`cfDeploy`, under the upload's step (`gateway.deploy`, `app.upload`, `app.helper`): cf failed after its upload went live (publishing a Custom Domain, the workers.dev subdomain) and the version that went live couldn't be recorded either: `The version cf uploaded of <worker> couldn't be recorded` then why; `data.workerName`, `data.error`. The run still ends with cf's failure. The next run finds a Worker version the install row or registry doesn't name: the Gateway's own, when it holds the row's hostname as a Custom Domain (resumed without asking: `gateway.resume`); otherwise a confirmation at a terminal (`rerun_interactive`).

Source: `packages/cli/src/lib/cf/deploy.ts`

### WORKERS_PAID_UNVERIFIED

`setup`, step `setup.plan`: the account's subscriptions (`cf accounts subscriptions get`, `workersPlan` in `lib/cf/plan.ts`) were listed, but no live Workers subscription among them reads as Paid (`paid`, `standard`, `bundled` or `unbound` in its name) or Free: `Couldn't confirm this account is on Workers Paid` / `EveryApp needs it ($5 a month, then usage). On Free, the Gateway stops once D1 hits its daily limit.` `data.url` (the account's Workers plans page), `data.plan`: `unknown`. Free is the `upgrade_workers_paid` action; a list cf couldn't read at all (`unreadable`, a token without the permission) is a skipped step (`Couldn't read this account's plan; Cloudflare refuses the upload if it's on Free`). Subscribe if the account isn't on Paid.

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

`everyapp status` ends with a `done` event whose `data.fixes` is one entry per problem: `{ code, severity, message, run, note?, fix? }`, where `message` is the headline and detail lines joined by newlines, `run` the command to run (or `null`), `note` what follows it, and `fix` a remedy that isn't one command. `severity` is `error` (✗, broken), `warning` (!, something to do or something the report couldn't check), `info` (a dim i: good to know, nothing to fix; listed last) or `settling` (no glyph: it resolves by itself); only errors and warnings count in the one-line summary (`Gateway <url>: <n> apps live, <n> problems to fix` or `nothing to fix`). The codes are `ProblemCode` in `packages/cli/src/commands/status/problems.ts`. `data.access` is `{ on, teamDomain }`: whether all three Access settings are on the Gateway Worker and the team domain `access on` recorded (`accessStateOf` in `packages/cli/src/lib/access/settings.ts`, from the Worker's secret names and the Gateway's D1 record; Zero Trust itself isn't asked), or `null` for a hosted Gateway, before the first upload, or when cf couldn't list the settings (then `ACCESS_UNKNOWN` below). A Gateway whose database exists but has no install row gets only `GATEWAY_NOT_INSTALLED`, with `data.installed: false`.

### CHECKOUT_BEHIND

Warning. `This checkout is behind the live Gateway`, `This checkout has <version>; <live> is live.` (when they differ), `Deploys from here are refused until it catches up.` (`DOWNGRADE_REFUSED` above). Run: `git pull`.

Source: `packages/cli/src/commands/status/problems.ts`

### GATEWAY_OUTDATED

Info. The install row's tree hash isn't this checkout's Gateway sources' and the Gateway has been uploaded: `Your every-app folder has a newer Gateway than the one online` / `Run update now, or leave it: the next new app's deploy updates it too.` Run: `pnpm everyapp update`, `note`: `updates it now`. Not a problem to fix: it is listed after the others and doesn't count in the summary.

Also an error: `provider add` and `provider remove` on a Gateway whose database predates the `providers` table (migration 0013): `This Gateway predates the provider registry`, nothing changed, `data.rerun` `pnpm everyapp update`, `data.rerunNote` `then run this again`. Every other reader treats such a Gateway as having no registered providers.

Source: `packages/cli/src/commands/status/problems.ts`, `packages/cli/src/lib/gateway/providers.ts`

### NO_OWNER

Warning. The Gateway is uploaded but nobody has claimed it: `No owner yet, so nobody can sign in` / `Apps still deploy. Setup prints a one-time link that creates the owner account.` Run: `pnpm everyapp setup`.

Source: `packages/cli/src/commands/status/problems.ts`

### APP_NEEDS_SETUP (status)

Warning. A served app (active, or binding and bound) whose required settings aren't all set, so it doesn't open; its APP cell reads `! needs setup` and the SETTINGS table shows each setting: `<app> needs setup`, one detail line per unmet setting (`<NAME>: <why>`, then the provider's `hint`, `Get it at <docs>` and `Guide: .claude/skills/everyapp/<setup>` once per distinct guide, or `Guide: pnpm everyapp provider show <id>` for a provider registered on the Gateway). Run: `pnpm everyapp configure <id>` (the app's `setup.command`: it asks for each unmet setting, which member of an any-of group, then offers the optional ones). The same report is `data.apps[].setup` ([`/docs/agent/json`](/docs/agent/json#done)).

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

Warning. The app's row is `pending`: `<app> was registered, but none of its deploys finished`. When its registered manifest declares Hyperdrive bindings with no config recorded as the app's yet, one line per binding follows with the origin its next deploy needs first ([`HYPERDRIVE_ORIGIN_MISSING`](#hyperdrive_origin_missing)): `<BINDING> needs the database its Hyperdrive config connects to: POSTGRES_DATABASE_URL (or <BINDING>_ORIGIN_URL) in .everyapp/secrets.env, on the machine that deploys it.` (the binding's own variable alone when the app has several configs). Run: `pnpm everyapp deploy from the app's directory, or pnpm everyapp delete <app>`.

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

### ACCESS_DRIFT (status)

Warning. Cloudflare Access is on (all three settings on the Worker) and what Zero Trust has isn't what this Gateway release wants (`accessDrift` in `packages/cli/src/lib/access/plan.ts`, the same read `access show` and the reconcile after `update` make): `Cloudflare Access is out of step with this Gateway`, then one line per difference: `No Access application in front of <hosts>.`, `The paths let through without a login differ on <hosts>.`, `The sign-in methods differ on <hosts>.`, `The Gateway's settings name other applications than the ones found: nobody can sign in until they are written again.` (the D1 record of `access on` against the applications' AUD tags and the team domain). `run`: `pnpm everyapp access on`, `note`: `brings Access in step with this Gateway`. `data.access.drift` carries the same as `{ paths, signIn, missing, settings }`.

Source: `packages/cli/src/commands/status/problems.ts`, `packages/cli/src/commands/status/index.ts`

### ACCESS_DRIFT_UNKNOWN (status)

Warning. Access is on, but Zero Trust refused the read that tells whether it is in step, for a reason other than a login without the Access permissions (that one is silent: `data.access.driftUnread.permission: true`, the row reads `in step? this login can't read Access`): `Couldn't check whether Cloudflare Access is in step with this Gateway` / `Cloudflare said: <error>.` Nothing to run; `data.access.drift` is `null` and `data.access.driftUnread` is `{ permission: false, error }`.

Source: `packages/cli/src/commands/status/problems.ts`, `packages/cli/src/commands/status/index.ts`

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
- `packages/cli/src/lib/gateway/registry.ts`: every registry call turns a `RegistrationError` from `packages/perimeter/src/registry/registration.ts` into an `EveryAppError` with the same code and message, `retryable` when its HTTP status is 500 or more (none is). The Gateway's deploy API answers the same codes with the same statuses (`run.ts` and `routes.ts` re-raise them as `DeployError`s). Of the `RegistrationErrorCode`s, `INVALID_APP_ID`, `APP_NOT_FOUND`, `INVALID_MANIFEST`, `WORKER_NAME_TAKEN`, `PROVIDER_APP_UNKNOWN` and `REMOTE_MCP_INVALID` are documented above, `ORG_KEY_UNAVAILABLE`, `APP_NOT_REGISTERED` and `HOSTNAME_TAKEN` have headings below, and the ten others are in the table after this list.
- `packages/cli/src/lib/childLog.ts`: `runLogged` raises `options.code ?? "COMMAND_FAILED"` when a child everyapp runs itself exits non-zero: `<what> failed` / `<command> exited with code <n>.` (or `was stopped by <signal>`) `Its last lines:`, the last 20 lines indented, `Full log: $TMPDIR/everyapp/<name>-<time>-<pid>.log`; `data.command`, `data.exitCode`, `data.tail`, `data.log`. Every caller passes a code: `INSTALL_FAILED` (`lib/package-manager.ts`, above), `BUILD_FAILED` (`lib/app/buildApp.ts`, above), `GIT_FAILED` (`lib/git.ts`, below) and `GATEWAY_BUILD_FAILED` (`lib/gateway/checkoutRelease.ts`, above), so `COMMAND_FAILED` is the default nobody uses.

The registry rules without a heading of their own (`packages/perimeter/src/registry/registration.ts`; none retryable, every status below 500):

| Code                      | Status     | Message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_APP_HOSTNAME`    | 400        | The app's host label (`<appId>` for the install organization, `<appId>-<orgKey>` otherwise) isn't a DNS label of at most 63 lowercase letters, digits and hyphens: `The app id must form a valid DNS label of at most 63 characters; received "<label>".` (or `The app id and organization key must form …`). Choose a shorter or simpler app id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `RESERVED_APP_ID`         | 400        | `The app id "everyapp" is reserved for the platform.` (it prefixes the Gateway's own MCP tools). Choose another id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `INVALID_WORKER_NAME`     | 400        | `App id "<id>" is too long: its Worker name "<name>" would exceed 63 characters.` or `App id "<id>" can't be registered: its Worker would be "<name>", which is reserved for the gateway or isn't the app's own.` Choose a shorter or different app id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RESOURCE_NAME_CONFLICT`  | 400        | Two bindings of one kind would share a resource name: `Bindings <a> and <b> would share the <kind> "<name>". Rename one of them in everyapp.config.ts.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SHARED_APP_NOT_PLATFORM` | 403        | A shared scope asked for by an organization that isn't the install (platform) organization: `Only the platform organization registers shared apps; "<id>" can't be shared from another organization.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `APP_SCOPE_MISMATCH`      | 409        | The existing row's scope isn't the one asked for: `App "<id>" is a shared app, not this organization's own. Deploy it without asking for another scope, or give the organization's own app an id of its own.` or `App "<id>" is this organization's own app, not a shared one. Shared apps need an app id of their own.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `APP_TIER_MISMATCH`       | 400 or 409 | 400: a shared app on tier `dispatch`: `A shared app is reached over a service binding; "<id>" can't be deployed through the hosted deploy API.` 409: an existing row on another tier than the deploy's: `App "<id>" is deployed through the hosted deploy API; deploy it the same way, or give this app an id of its own.`, `App "<id>" is reached over a service binding, not deployed through the hosted deploy API; give the third-party app an id of its own.`, or for a deploy under an MCP app's id (`packages/perimeter/src/registry/providerApps.ts`; the row is on tier `provider`, turned off or not): `"<id>" is the Gateway's MCP app of that name; give this app an id of its own.`; and from `provider on` for the id of a deployed app: `"<id>" is an app deployed to this Gateway, not the MCP app; the MCP app can't take its id.` |
| `REMOTE_MCP_URL_REFUSED`  | 400        | `mcp add <url>` (and the Gateway's Add an MCP server form) with an address the Gateway never fetches (`remoteMcpUrlProblem` in `packages/sdk/src/internal/remoteMcp.ts`): not `https://` (`http://` on localhost only while the Gateway itself runs on `http://`), an IP address, credentials or a fragment in the URL, the Gateway's own address or a host under its app domain (`the URL is on this Gateway's app domain (<domain>)`), or a provider whose key the Gateway holds (`<host> is a provider this Gateway holds a key for; apps reach it through the Gateway's capabilities, not as an MCP app`). Nothing is written; give the server's own MCP address.                                                                                                                                                                               |
| `REMOTE_MCP_EXISTS`       | 409        | `mcp add` for an id that is a remote MCP app already, on or off: `"<id>" is an MCP app on this Gateway already (on\|off); remove it first, or change it in place.` Its tools are changed with `mcp tool`; another address is `mcp remove <id>` then `mcp add <url> --name <id>`, or another `--name`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `REMOTE_MCP_SECRET_TAKEN` | 409        | `mcp add` whose credential name (`--secret`, or the default `<ID>_MCP_TOKEN`) a live MCP app at another origin already uses: `<NAME> is the credential of an MCP app at <origin>; a server at <origin> takes another name (--secret <NAME>_MCP_TOKEN).` A credential is pinned to one origin; give this server a name of its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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
