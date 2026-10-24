# CLI redesign: fewer concepts, less state, calmer output

Status: implemented. Proposed 2026-10-15 and revised twice the same day
(an adversarial review of every claim against the code and cf
1.0.0-beta.14's dist, then the maintainer's decisions in §6), then built on
2026-10-16 as ten stacked pull requests: #284 (this document and ADR-0003),
#286 (one migration per project), #288 (the 3-minute lease and the
schema-drift check), #289 (one routing mode), #290 (dev without files),
#291 (calm output), #292 (the Gateway's shared registry rules,
self-activation and no deploy API), #293 (the CLI writes the registry
through D1), #294 (the checkout is the truth) and #295 (nine flat verbs,
the skill and the docs), plus #296 (a docs build fix). The ground rules
held throughout: a proof of concept with no users, so nothing keeps
backwards compatibility, ships a transition release, or preserves the one
pre-cf install.

The sections below are the proposal as decided. Line numbers are as of
commit acad8b29 and the code has moved since. Where the implementation
differs from the text, §8 says how, and TODO.md's "Decide" list holds every
default the builders chose.

## 1. The end state on one screen

### Commands

| Command | Does | Replaces |
|---|---|---|
| `everyapp setup [--domain D]` | Installs or upgrades the Gateway; when the checkout's release already matches the install row, reconciles instead (binds and publishes every registered app); mints the owner link the first time. Idempotent; re-run to resume or repair. `deploy` and `delete` keep reconciling the Gateway themselves; `setup` is the repair path. | `setup`, `gateway deploy`, `gateway upgrade`, `gateway reconcile`, `gateway claim-link` |
| `everyapp status [--json]` | One screen: Gateway, owner, apps with hostnames and certificates, running deploys, and `fixes`: what to run if something is off. The one command an agent needs to learn the state. | `gateway status` |
| `everyapp dev` | Runs the app in `cwd` behind the local gateway. Binds 127.0.0.1 unless `--host`. | `dev` (modes hidden) |
| `everyapp create <id> [--deploy]` | New app from the template: copy, `pnpm install`, `cf workers types`, `git init` outside the checkout. No Gateway contact; `dev` works at once. | `app create`, `app setup-local` |
| `everyapp deploy` | Deploys the app in `cwd`. With no Gateway in any account the login sees: at a terminal it offers to install one; under `--json`, `action_required install_gateway`. | `app deploy` |
| `everyapp delete [id] [--purge]` | Removes an app. | `app delete` |
| `everyapp secret set\|unset\|list NAME [--for gateway]` | App secrets; the Gateway's settings with `--for gateway` (`--gateway <url>` keeps its hosted-tier meaning). `set` redeploys the app from `cwd` and says so on its first line (§6). `unset` supersedes TODO.md's `secret delete`. (The flag went on 2026-10-19: a name that is a Gateway setting goes to the Gateway, any other to the app in `cwd`, which lists its own under `secrets` in everyapp.config.ts.) | `app secret set`, `gateway secret set` |
| `everyapp db migrate\|query "<sql>" [--local]` | `migrate` applies migrations to the local database `dev` uses (production migrations stay inside `deploy`); `query` runs against production D1, `--local` for the dev database. | `app d1 …` |
| `everyapp workflow …` | Renamed from `workflows`. | `app workflow …` |
| hidden: `setup --redeploy`, `setup --allow-downgrade` | The key-rotation runbook's forced redeploy; a deliberate Gateway rollback past the downgrade guard. | |

Deleted outright, with no hidden aliases and no overlap release: `login`,
`logout`, `login --resume`, `app setup-local`, `gateway adopt`,
`gateway use-per-app-domains`, `setup --release` (there is no tarball to
pass once the Gateway is built from the checkout), `--printSetupLink`,
`--allow-free-plan`, `--no-open`, `--break-lease` (§6), `--access` on
deploy (access is managed in the UI, as its help already says),
`reconcile --dry-run`.

What the fold into `setup` loses, and what replaces it: `reconcile --force`
stays an internal pipeline option (`bindIfNeeded` and `secret set` pass it)
and the key-rotation runbook gets hidden `setup --redeploy`;
`claim-link --domain D` for a Gateway without an install row becomes
`setup --domain D`; the upgrade's "already runs this release" becomes
`setup`'s `done` line. `setup`'s nothing-to-do test is the install row
(`release_sha256` against `hashReleaseTree` of the checkout,
`live_app_workers` and `live_domains` against the registry) and
`cf workers deployments list`. Nothing is asked of the Gateway over HTTPS.

### One credential, and no deploy API

The Cloudflare login is the only credential, on every machine and in CI.
There is no deploy token to create, paste, store or renew, and no
credential derived from the login either.

- **People:** `cf auth login` (device code; works over SSH). Any command
  that needs it starts it and waits, as `setup` does today
  (`lib/cf/account.ts` `ensureCfAuth` with `onDeviceLogin`; `deploy`,
  `status` and `delete` gain the same, so under `--json` they wait instead
  of stopping with exit 2).
- **CI and agents without a browser:** `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`, as today.

**The CLI never calls the Gateway.** Everything it reads or writes lives in
the Gateway's D1, which it already reaches through `cf d1 query --body @file`
for the lease, the install row, the resource ledger and the owner link
(`lib/cf/d1.ts` `queryD1` takes `{sql, params}` statements, several per
call as one batch, through a private temp file). The app registry joins
them:

- **Register.** The naming helpers already live in
  `@every-app/perimeter/manifest` (`registryWorkerNameFor`,
  `resourceNameFor`, `isReservedAppId`, `isRegistryWorkerName`,
  `validateManifest`), and the CLI already depends on perimeter. The rest
  of `AppRegistrationService.register` (`services/AppRegistrationService.ts`
  L337-460) becomes pure functions in `@every-app/perimeter/registry` over
  rows the caller supplies: the hostname label (`<id>.<base>` for the
  install's organization, `<id>-<orgKey>.<base>` for others; the wildcard
  branch of `hostnameFor` goes with wildcard routing), the organization-key
  claim (`orgKeyFor`, L229-252), the hostname and Worker-name takeover
  checks against `apps` including tombstones, `assertDistinctResources`,
  and the initial-access policy (`initialAccess`, L305-335: the deployer
  plus owners and admins, or everyone when the manifest says so). The CLI
  SELECTs the rows those need, runs them, and writes the result in one
  batch: upsert `apps`, claim `organization_keys`, insert `user_app_access`
  grants. The deployer is the `users` row whose verified email equals the
  cf login's email, if there is one.
- **Deployed.** `UPDATE apps SET manifest, version_id, deployed_at,
  deployed_by_actor, status = 'binding'` (`markDeployed`, L562-580).
- **Activate: the Gateway does it.** In `handleGatewayRequest`
  (`packages/perimeter/src/gateway.ts` L195-203) a `binding` app answers
  503 `app_deploying`. Instead, when this isolate's env has the app's
  service binding and `probeAppBinding` (`server/deploy-api.ts` L63-79)
  answers, the Gateway flips the row to `active` and serves the request. An
  isolate still on the previous Gateway version has no such binding and
  keeps answering 503, which is exactly the propagation window
  `BINDING_NOT_READY` covered. The CLI's verify step becomes one loop:
  fetch `https://<hostname>/` until the answer is not 503 `app_deploying`
  (200, 302 or 401 all mean the app is active and its certificate works).
  That one loop replaces today's `/api/deploy/status` digest poll, the
  `activate` retries and the separate certificate wait.
- **Tools.** The Gateway already snapshots an app's tool catalog on first
  use of `/mcp` (`toolbus/app-host-mcp.ts` `syncOnFirstUse`) and on drift
  (`toolbus/runtime.ts:91` `scheduleCatalogResync`). The CLI's post-deploy
  sync call goes. So a redeploy refreshes the catalog promptly, the catalog
  records the `version_id` it was taken from and `servingCatalog` resyncs
  when `apps.version_id` differs (~15 lines).
- **Delete.** The tombstone update (`deleteApp`, L624-650), then the CLI
  rebinds the Gateway as it does today.
- **Identity keys.** The CLI generates the Gateway's keypair at install
  (`lib/gateway/secretsFile.ts` `firstDeploySecrets`) and never keeps it;
  from now on it also writes the public key into
  `_everyapp_install.jwt_public_key`, and app deploys read it from the row.
  `/api/deploy/identity-keys` goes.
- **Status.** The registry through `lib/gateway/desiredState.ts`
  `readDesiredState` (already a D1 SELECT), the install row's
  `live_app_workers`, `live_domains` and `live_version_id`, and
  `cf workers deployments list`; `fixes` come from their disagreements.
- **The owner link** stays what it is: how a person gets the first account.
  It no longer gates deploys. An app can be registered and deployed before
  the Gateway has an owner (a CI-first install works); the claim step
  grants the new owner access to every app that has no grants yet
  (~10 lines), since `initialAccess` ran when there were no members.

Why this is sound: `docs/security-model.md` and ADR-0002 L48 define the
self-hosted root of trust as the Gateway account's Cloudflare credential,
and `mintSetupLink` already turns it into Gateway authority by writing D1.
The rules live once, in perimeter, imported by the CLI and by the Gateway
(whose own writers to `apps` are `AppService.update` for the admin UI and
the activate flip). The CLI and the Gateway ship from one checkout, and
`deploy` redeploys the Gateway from that same checkout whenever bindings
change, so the schema both sides agree on is the checkout's; `deploy`
refuses to run against an install row newer than the checkout
(`apply.ts:224` `olderThanInstalled`) and says `git pull`.

Hosted tier (ADR-0001): it needs an HTTP deploy API with its own auth, and
the deploy API already doesn't exist there (`GATEWAY_DEPLOYMENT_MODE`
returns 404). The rules in perimeter are what such an API would call; the
API is new code either way. Nothing here should be built for it yet.

### Finding the Gateway

No local record: an account holds one Gateway with fixed resource names
(`lib/gateway/resources.ts`). `cf auth whoami` (no account) → for each
account in `whoami.accounts`, in parallel,
`cf d1 list --name every-app-gateway --per-page 100` with
`CLOUDFLARE_ACCOUNT_ID=<id>` set explicitly on that call (otherwise cf falls
back to its own cached last-used account) → the install row gives URL, base
domain, zone and account. A `CfError` of kind `auth` or `not_found` on one
account means "no Gateway here" (a CI token scoped to one account must not
abort the others). Exactly one hit: use it; an explicit `--account-id`
naming another account is an error. Several: `--account-id`, env, or a
prompt. None: `setup` picks where to install through today's
`resolveAccount`; every other command fails with `GATEWAY_NOT_FOUND`
listing the accounts probed, except `deploy`, which offers to install.
`--gateway` and `EVERYAPP_GATEWAY_URL` stay for the hosted tier; a URL that
isn't the discovered install's host is `GATEWAY_URL_MISMATCH`. The
`ACCOUNT_MISMATCH` family shrinks to those two errors.

### Where the Gateway's code comes from

The checkout. Binding a new app means redeploying the Gateway Worker (cf
has no "change bindings only" for plain Workers; §7), and that Gateway is
built from the checkout the command runs in: `commands/gateway/shared.ts`
`buildReleaseFromCheckout` (the SDK build, then `build:release`; one to
two minutes). The tarball is cached under the checkout's gitignored
`node_modules/.cache/everyapp/<tree-hash>.tar.gz`, keyed by
`hashReleaseTree` (`lib/gateway/release.ts:59`), so a bind after the first
build takes seconds and a `git pull` invalidates it. The cache is a build
artefact, not state: deleting it costs one build.

Two consequences, both wanted: the live Gateway always matches the checkout
that last touched the account, so `deploy` upgrades it as a side effect,
with the install row's migrations and bookmark as today; and a checkout
older than the live Gateway refuses to deploy (`olderThanInstalled`,
`downgradeRefused`, `apply.ts:224-260`, both existing) with "run git pull",
or `setup --allow-downgrade` for a deliberate rollback.

Gone: the KV namespace `every-app-gateway-deploy`, `cacheRelease`,
`fetchCachedRelease`, `RELEASE_CACHE_MISMATCH`, `servingReleaseSha256` and
the release-identity probe, `INSTALL_RECORD_STALE`, `refuseDowngradeOfServing`,
the reconcile confirm, `setup --release`.

### State that remains, and why

| Where | What | Why it can't be derived |
|---|---|---|
| Gateway D1 `_everyapp_install` | zone, gateway host, base domain, resource ids, live release (`release_sha256`, `live_version_id`), what the last deploy bound and published (`live_app_workers`, `live_domains`), and now `jwt_public_key` | Cloudflare has no place to record "this install's domain and which release is meant to be live". Written before the first upload, so a resume after an early failure needs no `--domain`. The `routing` column goes with wildcard routing. |
| Gateway D1 `_everyapp_deploy_lease` | who is deploying what | A lock. Cloudflare has none. 3-minute TTL (§6). |
| Gateway D1 `_everyapp_app_resources` | which D1/KV/Worker each app created | Names prove nothing; this stops an app from adopting a look-alike resource and `--purge` from deleting someone else's database. |
| Gateway D1 registry (`apps`, `user_app_access`, `organization_keys`, …) | the apps, their names, access, who deployed them | The product's own data. |
| cf's own login, profiles and account cache | | cf's, not ours. The runner passes `--profile` on every call and sets `CLOUDFLARE_ACCOUNT_ID` once the account is known, because `cf auth activate` binds a profile to a directory and its ancestors (live check 7). |
| Checkout: `node_modules/.cache/everyapp/` | built Gateway releases by tree hash | A build cache. |
| Per app: `.everyapp/secrets.env` (the app's secrets), `.everyapp/registry` (dev), `.cloudflare/state`, `.cloudflare/types` | | Build and dev artefacts, all gitignored already. |

Gone: `~/.everyapp/installs.json`, `~/.everyapp/credentials.json`,
`~/.everyapp/pending-claims/`, per-app `.everyapp/dev-keys.json`, the lines
the CLI writes into `.dev.vars` and `.env.local`, the KV release cache, the
`app_tokens` table, the `cli_secret_hash` and `deploy_token_issued_at`
columns, the `legacy_names` column and the `deploying` status value.

### What people see (the spec)

A fresh install:

```
$ pnpm everyapp setup --domain apps.example.com
Cloudflare: ben@example.com · Example Inc
Building the Gateway … done (1m 20s)
Installing the Gateway at https://apps.example.com … done (40s)
Create your owner account with this one-time link (opened in your browser):
  https://apps.example.com/setup#token=est_…
Waiting … owner created: ben@example.com
Your Gateway is ready: https://apps.example.com
Next: pnpm everyapp create my-app
      AI for apps, any time: pnpm everyapp secret set OPENAI_API_KEY
```

On a brand-new account the install stops once, before the upload:

```
✗ This Cloudflare account has no workers.dev subdomain yet. Pick one at
  https://dash.cloudflare.com/<acct>/workers/onboarding, then run: pnpm everyapp setup --domain apps.example.com
```

(cf beta.14 has no `workers subdomain` command, so the CLI can't check this
earlier. The quickstart's prerequisites and the skill's "only a person can"
list gain "a workers.dev subdomain, one click the first time".)

Running it again, with nothing to do:

```
$ pnpm everyapp setup
Cloudflare: ben@example.com · Example Inc
Gateway 0.4.0 at https://apps.example.com is up to date.
```

An upgrade with migrations (after `git pull`):

```
$ pnpm everyapp setup
Cloudflare: ben@example.com · Example Inc
Upgrading the Gateway 0.3.0 → 0.4.0 · 2 migrations applied · uploaded 9c2e1b0d
  restore point: CLOUDFLARE_ACCOUNT_ID=… npx cf@1.0.0-beta.14 d1 time-travel restore <db> --bookmark <b> --force
Gateway 0.4.0 at https://apps.example.com is up to date.
```

A repair after a failed bind or a stray registry change:

```
$ pnpm everyapp setup
Cloudflare: ben@example.com · Example Inc
Gateway 0.4.0 up to date · binding 3 apps (was 2) · uploaded 1a7f33c9
```

`setup --json` in CI with no owner yet (exit 2; the link is never printed
into a log; deploys from CI work regardless, the owner is for people):

```
{"v":1,"type":"action_required","action":"claim_owner","message":"The Gateway has no owner yet. Run `everyapp setup` at a terminal on any machine with this Cloudflare login.","data":{"rerun":"everyapp setup"}}
```

An app's first deploy:

```
$ pnpm everyapp deploy
todo → https://todo.apps.example.com (Example Inc), first deploy
Registered todo: private to you, owners and admins (change it in Admin → Apps)
Built · schema in sync · 2 migrations applied · uploaded 3f9c1a2e
  restore point: CLOUDFLARE_ACCOUNT_ID=… npx cf@1.0.0-beta.14 d1 time-travel restore <db> --bookmark <b> --force
Binding to the Gateway · uploaded 7d20c4e1
Live: https://todo.apps.example.com
```

("private to owners and admins" when the login's email is no Gateway user
yet; "Binding to the Gateway" is the Gateway redeploy from the checkout's
cached build, a few seconds, or "Building the Gateway … 1m 10s" the first
time after a `git pull`.)

A redeploy:

```
$ pnpm everyapp deploy
todo → https://todo.apps.example.com (Example Inc)
Built · schema in sync · database up to date · uploaded 8a01d4f7
Live: https://todo.apps.example.com
```

Setting a secret:

```
$ pnpm everyapp secret set GITHUB_TOKEN
Value for GITHUB_TOKEN: ••••••••
Redeploying repolens with GITHUB_TOKEN (code and pending migrations from this directory)
Built · schema in sync · database up to date · uploaded 5c2a9e10
Live: https://repolens.apps.example.com
```

A second machine (nothing to set up; the first command asks for the login,
in cf's own words):

```
$ pnpm everyapp deploy
Log in to Cloudflare: https://dash.cloudflare.com/…/device   code ABCD-EFGH   (waiting)
Cloudflare: ben@example.com · Example Inc
todo → https://todo.apps.example.com (Example Inc)
…
```

A checkout behind the live Gateway:

```
$ pnpm everyapp deploy
✗ This checkout's Gateway (0.3.0) is older than the one live at https://apps.example.com (0.4.0).
  Run git pull, then: pnpm everyapp deploy
```

Something in the way (an error that names a flag which takes something
over; an agent asks before using it):

```
$ pnpm everyapp deploy
todo → https://todo.apps.example.com (Example Inc), first deploy
✗ todo.apps.example.com already has a DNS record (A 203.0.113.7); publishing the app would replace it.
  Pick another app id, or keep going with: pnpm everyapp deploy --force-dns
```

Status:

```
$ pnpm everyapp status
Gateway   https://apps.example.com · release 0.4.0 · Example Inc
Owner     ben@example.com
Apps      3 live: chef, todo, workout · all bound · certificates ready
Deploys   none running
```

The same setup, as an agent sees it (`--json`, abridged):

```
{"v":1,"type":"step","step":"cloudflare","status":"ok","data":{"email":"ben@example.com","accountId":"…"}}
{"v":1,"type":"step","step":"gateway","status":"ok","message":"Gateway 0.4.0 is live at https://apps.example.com","data":{"versionId":"…"}}
{"v":1,"type":"action_required","action":"claim_owner","message":"Create the owner account with this link.","data":{"url":"https://apps.example.com/setup#token=est_…","expiresAt":"…","waiting":true}}
{"v":1,"type":"step","step":"owner","status":"ok","data":{"email":"ben@example.com"}}
{"v":1,"type":"done","message":"Your Gateway is ready: https://apps.example.com","data":{"gatewayUrl":"https://apps.example.com","next":["pnpm everyapp create my-app"]}}
```

## 2. What a person sees vs. what an agent sees

The NDJSON protocol stays (`lib/output/events.ts`); the human view becomes
a filter over it instead of a one-to-one print.

Default human output:

- `step … ok|fail` lines for milestones only, chosen by a sink-side
  allow-list keyed on step name (`createHumanSink` is the one choke point;
  `step` is a free string with 31 names today), so no emit site changes.
  About 15 steps are milestones. The transcripts above need four emits that
  don't exist yet (`app.build ok`, `app.bind ok`, `app.live ok`,
  `defaultAccess` in `app.register`'s data; today `app.build`/`app.bind`
  emit only `start`, and bind completion surfaces as `gateway.deploy ok`)
  and a per-step renderer that formats from `data` ("2 migrations applied"
  from `data.applied`, "uploaded 3f9c1a2e" from `data.versionId`); the sink
  prints `event.message` verbatim today.
- `step … start`: a spinner at a TTY, nothing when piped. Adjacent short
  milestones join on one line (`Built · migrated · uploaded`).
- `progress`: `--verbose` only, except what a person must see: lease waits
  (`app.lease`, `gateway.lease`, holder shown), the live wait (`app.live`,
  which includes the certificate), the Gateway build (`gateway.release`,
  one to two minutes when the cache misses), the new-app privacy notice.
  The D1 restore command stops being `progress`: it goes into the migration
  step's `ok` as `data.rollbackCommand` and its message, and is repeated in
  any `error` raised after the migration. Bookmarked migrations are a hard
  constraint; a bookmark nobody sees is useless.
- Child output: pnpm, the manifest's install and build commands, `cf build`
  and every non-interactive cf call never write to stdout. cf's output is
  already captured in memory (`lib/cf/runner.ts` accumulates it into
  `CfResult`; `CfError` keeps `stderr`; `buildApp.ts` holds
  `result.stdout`), so "last 20 lines on failure" comes from there; only
  the execa paths (`lib/formatting.ts` for pnpm and the manifest build,
  `commands/gateway/shared.ts` for the release build) write
  `$TMPDIR/everyapp/<command>-<time>.log`. Secrets travel in
  `--secrets-file`, so cf output needs no scrubbing.
- The one exception: `cf deploy` stays attached to the terminal whenever
  `canPromptInTerminal` is true, as `lib/cf/deploy.ts:135` does today. cf
  asks its deploy questions only when stdin and stdout are both TTYs, it
  has no `--yes`, and piping stdout turns the questions into the
  strict-mode abort (`rerun_interactive`) that the attended rerun would hit
  again. Unattended, `cf deploy` is piped and captured. `dev` keeps
  `stdio: inherit`.
- `warning`, `action_required`, `error`, `done`: always, problems on
  stderr, each ending with the exact next command (`data.rerun`).
  `setup.extras` (the AI and email guidance) moves into `done.data.next`
  and prints once under `Next:`; filtered as bookkeeping it would be lost.
- Prompts remaining at a terminal: the Cloudflare account when several have
  a Gateway (or a fresh `setup` has several to install into); the
  zone/hostname when `setup` has no `--domain`; cf's own deploy questions
  (a Worker changed in the dashboard or through the API, a config value
  over an existing secret, a Workflow owned by another Worker, a Custom
  Domain or DNS record held by something else); everyapp's
  `assertReplaceable` confirm before migrating (it is what stops an
  unattended run before D1 is touched); the hidden value prompt of
  `secret set` (values never go on the command line); `delete --purge`
  typing the id. Removed: the install confirm and the routine
  `Deploy X to Y?` become the first line of output; `secret set`'s deploy
  confirm goes with it (its first line says what will be redeployed); the
  Workers Paid confirm becomes a warning only, with `upgrade_workers_paid`
  fired from cf's `free_plan` error; the lease confirm goes with the flag
  (§6).
- `--yes`, per command: skips the first-line confirms and `delete`'s
  confirmation (including `--purge`'s typed id, as today); never skips cf's
  deploy questions (unattended they become `rerun_interactive`),
  `assertReplaceable`, or the hidden secret prompt.

Agent contract (`--json`):

- Every command is safe to re-run. Three outcomes: `done` (exit 0);
  `action_required` (exit 2: do what it says, then run the same command
  again; `waiting: true` means keep reading, up to 15 minutes for a device
  login or the owner link); `error` (exit 1). Errors whose `data.rerun`
  carries a flag that takes something over (`DNS_RECORD_CONFLICT` →
  `--force-dns`, `CONFIRMATION_REQUIRED`, `--allow-downgrade`) carry
  `data.authorize: true`: an agent shows them and asks, never retries with
  the flag.
- `action_required.action` set: `cloudflare_login`,
  `register_workers_subdomain`, `claim_owner`, `install_gateway`,
  `upgrade_workers_paid`, `add_domain`, `rerun_interactive`.
  `create_deploy_token` goes. `action_required` stays on stdout (an agent
  reads it); the setup-link gate (`maySetupLinkBeShown`: never when `CI` is
  set) stays, so a CI run gets the exit-2 transcript above instead of the
  link.
- stdout is pure NDJSON. Today `app deploy --json` prints the CLI's own
  framing lines there (`formatting.ts:44-47`, `buildApp.ts:50`,
  `package-manager.ts:43`) and, with `--verbose`, streams pnpm/vite/cf
  build output there too. One new test JSON-parses every stdout line of a
  faked deploy (`deployApp.test.ts` reads the sink today, not stdout).
- `create <id> --yes --json` never prompts (today `promptUserInput.ts`
  always does; it validates a given id with `validateAppId` and prompts
  only with no id at a TTY). `create`, `dev` and `db migrate` (today it
  builds a sink but calls `migrateLocal` outside `runReported`) move under
  `runReported`; the six `process.exit` sites go (`bin/cli.ts:12`,
  `lib/gateway.ts` ×3, `checkIsEveryAppProject.ts:31`,
  `checkNotNestedApp.ts:27`, `checkPnpm.ts:17`).
- `status --json` is the one state query, all of it from D1 and cf. New
  over today's `done.data`: the owner's email (from `users` and `members`);
  per-app rows `{id, hostname, workerName, status, bound, live, deployedBy}`
  joined from the registry and the install row's `live_app_workers`;
  `upToDate` from `hashReleaseTree` of the checkout against the install
  row; `fixes` derived from `!claimed → setup`, `registry ≠ live_app_workers
  → setup`, `checkout newer than row → setup`, `missing Worker →
  deploy|delete <id>`, `status binding → wait`, `lease held → wait`.

The one-page skill, `packages/cli/skills/everyapp/SKILL.md`, shipped with
the CLI (`skills` added to `packages/cli/package.json` `files`), linked by
`create` into `.claude/skills/` and `.agents/skills/` (asking before it
touches an existing AGENTS.md, as Void's `init` does), and referenced from
`templates/simple-todo/AGENTS.md`:

```
everyapp: self-hosted platform for private web apps on Cloudflare.
Pass --json. One JSON event per line; "done" = success; exit 2 = show the
user the last action_required (url, code) and re-run the same command;
exit 1 = show the error; if data.authorize is set, ask before using data.rerun.
waiting: true = keep reading (up to 15 min: device login, owner link).
State:   everyapp status --json
Gateway: everyapp setup --domain <host> --yes   (install, upgrade, repair)
New app: everyapp create <id>   then edit src/; manifest is everyapp.config.ts
Run:     everyapp dev   (long-running, human-facing: start it in the
         background and read the printed URL; no --json)
Ship:    everyapp deploy --yes   (from the app directory; safe to repeat;
         also upgrades the Gateway to this checkout when it has to rebind)
Data:    everyapp db migrate (local)   everyapp db query "<sql>" [--local]
Secrets: everyapp secret set NAME --from-env VAR --yes   (redeploys the app)
Remove:  everyapp delete <id>   never add --purge, --force-dns,
         --allow-delete-*, --allow-downgrade, or --yes to delete unless the
         user asked.
Only a person can: approve the Cloudflare login, open the owner link, pick
a workers.dev subdomain, pay for Workers Paid, buy a domain. There are no
tokens to paste. While publishing is paused the command is `pnpm everyapp`.
Full reference: landing-page/content/docs/reference/cli.mdx
```

## 3. What gets deleted, what gets added

Deleted (non-test lines, approximate; test lines in parentheses):

| Path | Lines | Why |
|---|---|---|
| `commands/login/`, `commands/logout/`, `lib/gateway/credentials.ts`, `autoLogin.ts`, `pendingClaims.ts`, the `ecs_`/pending-claim half of `setup-link.ts`, `ensureLogin` and the pending-claim reads in `ensureOwnerLink` (`runSetup.ts`) | ~700 (+~600) | No deploy tokens |
| `lib/gateway/api.ts` (`GatewayClient`, 415), `commands/app/deploy/steps/syncTools.ts`, `commands/gateway/deploy/steps/syncAppTools.ts`, `gatewayCall`/`explainGatewayError` users in `deployApp.ts`, `src/test/fakeGateway.ts` (323, test) | ~650 (+~900) | The CLI never calls the Gateway |
| Gateway: `routes/api/deploy/**` (nine routes: `register`, `status`, `whoami`, `identity-keys`, `apps/$appId/{activate,delete,deployed,info}`, `apps/$appId/tools/sync`), `server/deploy-api.ts`, `server/deploy-token-auth.ts`, `AppRegistrationService.ts` as a service (its ~300 lines of rules move to perimeter, the ~370 of repository orchestration go), `routes/api/setup/deploy-token.ts`, `SetupService.retrieveDeployToken`, `findClaimsAwaitingDeployToken`, `markDeployTokenIssued`, `unmarkDeployTokenIssued`, the two columns, `/api/setup/deploy-token` and `/api/deploy/*` in `control-plane-guard.ts` and the Access bypass docs | ~1,350 (+~1,800) | same |
| Gateway: `AppTokenService.ts`, `AppTokenRepository.ts`, `app-token-scopes.ts`, `app-token-hash.ts`, the `app_tokens` table and its migration; the Admin → Tokens deploy-token UI (`routes/admin/tokens.tsx` half, `AppTokensTable.tsx`, `CreateAppTokenModal.tsx`, `AppTokenRevealModal.tsx`, `serverFunctions/appTokens.ts`). Personal access tokens (`epat_`) stay. Also fix `gateway-files.mdx` L116/L157, `user-experience.mdx` L50, `security-boundary.mdx` L72, which describe `eat_` tokens no code mints | ~1,100 (+~1,000) | No issuer, no consumer |
| `lib/install/state.ts`, `rememberedInstall`, `resolve.ts` (its `--gateway`/env precedence moves to `discover.ts`); 6 `resolveGatewayUrl` callers, 9 `rememberedInstall` callers, `writeCachedInstall` in `apply.ts record()` | ~120 | Gateway found through the account |
| `release.ts`: `cacheRelease`, `fetchCachedRelease`, `servingReleaseSha256`, `RELEASE_CACHE_MISMATCH`; `INSTALL_RECORD_STALE`, `refuseDowngradeOfServing`, the reconcile confirm, the `/status` polls in `reconcile.ts` and `apply.ts`; the KV namespace in `resources.ts` and `install.ts`; `setup --release` | ~300 (+~300) | Built from the checkout; the install row is the truth |
| `deployUntilSettled`'s redeploy loop: `MAX_DEPLOYS`, `REGISTRY_CHANGING`, `sameBindings` | ~60 | app deploys and deletes reconcile the Gateway themselves under the same lease; a Gateway deploy never has to chase the registry |
| `commands/app/setupLocal/`, `setupLocalEnvironment.ts` (`cf workers types` and the local migration move into `create`; `dev` runs `cf workers types` when `.cloudflare/types/index.d.ts` is missing), `createEnvFiles`, the dead `VITE_*`/`EVERYAPP_*` build env in `deployApp.ts` L349-353 | ~140 | the lines written into `.env.local` are read by nothing; the file stays a developer-owned secrets file |
| `commands/dev/devEnv.ts` | ~100 | well-known dev keypair in the SDK |
| `getLocalD1Url.ts` in the template, chef, workout-tracker and the Gateway, plus the inline copy in `apps/todo-app/drizzle.config.ts` | ~220 | `localD1Path()` in the SDK |
| `commands/gateway/{deploy,upgrade,reconcile,claimLink,adopt,usePerAppDomains}/index.ts`, `deployGateway()`'s body, their definitions in `commands.ts`, `lib/gateway/adopt.ts` (272); `presentSetupLink`/`setupLinkForDeploy` (replaced by `runSetup`'s `action_required claim_owner` emit plus the browser-open side effect). `deployGatewayRelease`, `reconcileGateway` stay | ~1,000 | one operator verb; no pre-cf install to adopt |
| `checkIsEveryAppProject.ts`, `checkPnpm.ts`, `printNextSteps.ts`, `requireGatewaySetup`, `checkNotNestedApp.ts`, the always-prompt in `promptUserInput.ts` | ~210 | one error path |
| `--break-lease` on nine commands, `confirmLeaseBreak` and its 8 call sites, the `LEASE_HELD` texts in `lease.ts:183` and `deployApp.ts:747` | ~80 | §6 |
| `lib/interrupt.ts` shrinks to child-kill and temp-file cleanup | ~150 (+268) | its upload record and lease release become unnecessary |
| Wildcard routing: `lib/dnsInstructions.ts`, `lib/dns.ts`, the wildcard branches in `patchBuildOutput.ts`, `install.ts`, `deployGateway.ts`, `runSetup.ts`, `status`, `reconcile.ts`, the `routing` column; the Gateway's `app-hosts.ts` route-mode branch and `hostnameFor`'s wildcard branch; `whoami.ts`'s null base domain | ~500 | one routing mode |
| `backfillD1Migrations`, `readDrizzleJournal`, `MIGRATION_HISTORY_MISMATCH`, `migratedByDrizzleKit`; `migrateRemoteD1` becomes bookmark + `cf d1 migrations apply` | ~90 (+~100) | drizzle-kit-migrated databases exist only pre-cf |
| `apps/every-app-gateway/drizzle/0000_…0032_*.sql` (33 files, 799 lines of SQL) and `drizzle/meta/`, regenerated as one `0000_*.sql` of the current schema; `FIRST_CHECKED_MIGRATION` in `db/release-migrations.test.ts` becomes 0; the comments that name migrations (`OrganizationRepository.ts:32`, `McpConnectionService.ts:248`, `setup-link.ts:43,89`), `docs/runbooks/mcp-oauth.md:101`, `cli-deployment.mdx:36`; the apps' histories the same way (todo-app 5 files, workout-tracker 3, chef 2; the template already has 1) | ~800 SQL + the snapshots | no database to carry forward (§6) |
| `legacyNames` / `legacy_names` in `manifest.ts`, `AppRepository.ts`, `apps.schema.ts`, `types/app.ts`, `lib/app/resources.ts`, `desiredState.ts`, `commands/app/d1/index.ts`; `WORKER_NAME_MISMATCH`, the `workerName` field of the register payload; the `deploying` status value in `perimeter/registry.ts` | ~80 | names are assigned one way |
| `lib/domains/caa.ts` and `checkCertificateAuthorities` in `preflight.ts`; `preflight.ts` and `records.ts` stay as the hostname-takeover check | ~260 (+188) | §6 |
| Docs: `troubleshooting.mdx`, `reference/cli.mdx`, `manage-your-gateway.mdx`, `architecture/cli-deployment.mdx`, `gateway-files.mdx`, `user-experience.mdx`, `security-boundary.mdx`, `reference/cloudflare-access.mdx`, `quickstart.mdx`, both READMEs, `docs/runbooks/cloudflare-access.md`, `key-rotation.md`, `docs/TESTING.md`, `docs/security-model.md` L107 and L289-295, ADR-0002 (amended by ADR-0003) | 15 files | |

Added:

| Path | Lines | What |
|---|---|---|
| `packages/perimeter/src/registry/` | ~300 moved, ~40 new | `AppRegistrationService`'s rules as pure functions over rows: hostname label, org-key candidate, takeover checks, distinct resources, initial access, tombstone reuse; `RegistrationError` with the same codes |
| `lib/gateway/registry.ts` (CLI) | ~200 | `register`, `markDeployed`, `deleteApp`: SELECT the rows, run the rules, write one `queryD1` batch; `deployed_by_actor` from the cf login's email or `api-token:<account>` |
| Gateway: activate flip in the app-host path (`perimeter/gateway.ts` + a `deps.activate` the Gateway supplies), catalog `version_id` and the resync-on-mismatch check, first-owner grants in the claim step | ~60 | §1 |
| Gateway: `apps.deployed_by_actor`, `_everyapp_install.jwt_public_key` | ~20 (the baseline migration is regenerated, §6) | attribution (§6); identity keys without an endpoint |
| `lib/gateway/discover.ts` | ~60 | account → Gateway database → install; `--gateway`/env precedence |
| `release.ts`: build cache by tree hash under `node_modules/.cache/everyapp/` | ~40 | §1 |
| `lease.ts`: 3-minute TTL, heartbeat that aborts, holder re-check before migrations and before `cf deploy` | ~40 | §6 |
| `lib/output/events.ts` allow-list + renderer, four emits, ~60 surviving `console.*` calls → `out.emit` (`commands/dev/index.ts` 24, `dev/migrations.ts`, `lib/gateway.ts`, `formatting.ts`, `create/index.ts`, `buildApp.ts`), `rerun?`/`authorize?` on `EveryAppError`/`ActionRequiredError` through `report.ts`, `childLog.ts` for the execa paths | ~250-300 | §2 |
| `deployApp.ts`: the single live wait (fetch the hostname until not 503) replacing the status poll, activate retries and certificate wait | ~40 (−~150) | §1 |
| Well-known dev keypair and `DEV_ISSUER` in the SDK next to `IDENTITY_DEV_KEY_ID` (`@every-app/sdk/dev`); `everyAppWorker`'s dev branch turns `EVERYAPP_IDENTITY_PUBLIC_KEYS`/`EVERYAPP_IDENTITY_ISSUER` from `secret` into `text` bindings carrying the key and `DEV_ISSUER`; `@every-app/perimeter/dev` and the CLI import the private PEM from the SDK | ~40 | |
| `localD1Path(root, databaseId)` = `.cloudflare/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite` in `@every-app/sdk/cloudflare`, on `localD1Id`; five `drizzle.config.ts` edits | ~15 | live check 5 |
| `create`: `--json`, `validateAppId`, `pnpm install`, `cf workers types`, skill linking | ~30 | |
| `deploy` schema-drift preflight (§6) | ~60 | |
| `packages/cli/skills/everyapp/SKILL.md`, `adr/ADR-0003-self-host-authority.md` | 2 pages | |
| Tests: `registry.test.ts` (CLI, over a sqlite file), perimeter registry rule tests (ported from the service's), rewrites of `runSetup.test.ts`, parts of `deployApp.test.ts`, `apply.test.ts`; the strict-abort fixture moved to stdout | | |

Net, all approximate: about 5,800 non-test lines out, about 1,000 in (300
of them moved rather than written), and roughly 6,500 test lines rewritten
or deleted (`runSetup.test` 507, `deployApp.test` 1,161, `apply.test`
1,065, `fakeGateway` 323, the deploy-route, token and registration-service
tests on the Gateway side). Six concepts gone from the docs: deploy token,
login, setup-local, reconcile, claim link, and the deploy API itself.

## 4. Security

- **The trust model, stated once.** `docs/security-model.md` and ADR-0002
  L48 define the self-hosted root of trust as the Gateway account's
  Cloudflare credential, and `mintSetupLink` already turns it into Gateway
  authority by writing D1. This design makes that permanent and complete:
  in `self_hosted`, write access to the Gateway's D1 *is* operator
  authority, and there is no Gateway-issued credential at all. It
  supersedes ADR-0002 Decisions 2-3 ("de-emphasize direct DB writes",
  "Cloudflare checks are transitional"), so ADR-0003 records it: "D1 write
  access to the Gateway's account is operator authority in `self_hosted`;
  the hosted tier has its own API and credentials."
- **What that means, honestly.** Revocation is Cloudflare's: removing,
  banning or deactivating a Gateway member does not stop them deploying if
  they still hold the Cloudflare login or a token (today
  `findActiveDeployByTokenHash` joins `users` and `members`, and
  `OrganizationMembersRepository` revokes a leaver's tokens; the three test
  groups in `user-management.sqlite.test.ts` that assert this go). Any
  Cloudflare API token with D1 write on the account is an operator,
  including every app's CI token (`lib/cf/account.ts` asks for Workers, D1
  and KV; D1 permission is account-scoped; live check 8). Such a token
  could already redeploy the Gateway Worker and write `owner_setup_tokens`,
  so nothing widens. This is the self-host limitation the hosted tier
  addresses, not a strength.
- **Less exposed surface.** The public Gateway Worker loses `/api/deploy/*`
  (nine routes, one of them unauthenticated) and `/api/setup/deploy-token`;
  there is no bearer scheme left to get wrong. With Cloudflare Access in
  front, the bypass set shrinks to what browsers and MCP clients need;
  `/api/admin/has-owner` goes with `gateway adopt`.
- **Blast radius for a stolen laptop:** today `credentials.json` plus cf's
  login; after, cf's login only, revoked in the Cloudflare dashboard.
- **Attribution (§6).** `apps.deployed_by_actor` and `deployed_at` are
  written with every deploy: the cf login's email, or `api-token:<account>`
  in CI. Admin → Apps and `status --json` show it. No event log yet.
- **The rules can't be skipped by accident.** The CLI runs the same
  perimeter functions the Gateway ships, and the Gateway still validates
  the manifest it reads from the row (`parseStoredManifest`). A hand-written
  D1 row that breaks a rule is an operator's doing, as a hand-edited
  Worker is today.
- **The dev keypair is public by design.** The SDK accepts the dev key id
  only behind the explicit dev opt-in (`identity.ts` L124, L275), which
  `everyAppWorker` sets in dev and the deploy never sends. Add one refusal
  in `resolveVerifyOptions`: with `allowDevIdentities`, require
  `issuer === DEV_ISSUER` and throw `ConfigurationError` otherwise, so a
  dev-kid token whose `iss` names a real gateway never verifies. A
  well-known key lets any process that reaches the local dev ports mint a
  dev identity, including a real user's in mirror mode; that is the
  existing local-dev trust boundary, so `dev` binds 127.0.0.1 unless
  `--host` (today `server.listen(gatewayPort)` binds every interface).
- **Identity keys** move from an endpoint to the install row: the public
  key is public, and the CLI that generated it is the CLI that needs it.

Hosted tier (ADR-0001): the deploy API doesn't exist there today and this
design doesn't bring one back. Hosted deploy authorization is a browser
login to the Gateway (device-code style, SSH-friendly) issuing an
org-scoped session, and per-app CI credentials, in front of an HTTP API
that calls the perimeter registry rules. Nothing here blocks that, and
nothing here should be built for it yet.

## 5. Migration path

Each step ships alone and nothing waits for a transition release.
Estimates are engineer-days for one person who knows the code.

0. **One migration (an hour).** Delete `drizzle/*.sql` and `drizzle/meta/`
   in the Gateway and run `pnpm db:generate`: one `0000_*.sql` of the
   current schema. Set `FIRST_CHECKED_MIGRATION` to 0, reword the three
   comments and two docs that cite migration numbers, and do the same in
   todo-app, workout-tracker and chef. From here until the redesign lands,
   every schema change regenerates that baseline instead of appending a
   file (step 2 removes `app_tokens` and the two token columns and adds
   `deployed_by_actor` and `jwt_public_key`; step 6 removes `routing` and
   `legacy_names`). Any database migrated by the old history is left
   behind; the only one, thecomeup.cc, is reinstalled.
1. **Calm output, pure JSON, no prompts (3 days).** Sink allow-list and
   renderer; the four missing emits; `console.*` → `out.emit`; execa output
   to a log file; `create`/`dev`/`db migrate` under `runReported`; delete
   `checkIsEveryAppProject.ts`, `checkPnpm.ts`, the deploy and secret
   confirm prompts; `create <id>` honours its id; `rerun`/`authorize` on
   errors (the ~80-100 messages that embed command names in prose are
   rewritten in step 5 with the rename). Also: `CF_DELEGATION=1` in
   `runner.ts` `childEnv` (cf otherwise hands off to any `cf` it resolves
   from the working directory), and run the `strict_conflict` rule over
   stdout and stderr together (cf's abort goes to stdout with no stderr
   box, so today it classifies as `unknown` and `rerun_interactive` never
   fires; move the `fakeCloudflare.ts:508-511` fixture to stdout).
2. **The registry through D1 (4 days).** ADR-0003 first. Move the rules
   into `@every-app/perimeter/registry` with their tests; `lib/gateway/
   registry.ts`; the Gateway's activate flip, catalog version check and
   first-owner grants; `jwt_public_key` and `deployed_by_actor`; the single
   live wait in `deployApp.ts`; `setup` waits for the owner by polling D1
   for *its own minted row* (a claim creates the membership before
   consuming the link and rolls both back on failure) every 5-10 s, after
   one plain fetch of the Gateway URL so Access/TLS problems surface in
   `setup`. Then delete in one go: `/api/deploy/**`, `deploy-api.ts`,
   `deploy-token-auth.ts`, `AppRegistrationService.ts`, `GatewayClient`,
   `fakeGateway.ts`, both sync-tools steps, `login`, `logout`,
   `credentials.ts`, `autoLogin.ts`, `pendingClaims.ts`,
   `/api/setup/deploy-token`, the `eak_` service, repository, table and
   admin UI, `legacyNames`, and the docs that describe them.
3. **The checkout is the truth (2 days).** `lib/gateway/discover.ts`;
   delete `installs.json`; write the install row before the first upload;
   the build cache by tree hash; delete the KV release cache, the
   release-identity probe, `INSTALL_RECORD_STALE`, `refuseDowngradeOfServing`
   and the reconcile confirm; `olderThanInstalled` gets the "run git pull"
   message and `--allow-downgrade` moves to `setup`.
4. **Dev without files (2 days).** Land the `text` bindings in
   `everyAppWorker` *before* removing `.dev.vars` writing (otherwise
   `cf dev` without `.dev.vars` looks for the identity secrets in
   `.env*`/process.env and fails); well-known keypair; `dev` on 127.0.0.1;
   delete `devEnv.ts`, `setup-local`, the `.env.local` lines, the
   `getLocalD1Url` copies (`localD1Path` in the SDK, live check 5); keep
   `cf workers types` in `create` and `dev`; fix the root
   `.worktreeinclude` (drop `.wrangler`, add `**/.dev.vars*` and
   `**/.cloudflare/state`) and the five per-project ones (add `.dev.vars`,
   keep `.env.local` for the Gateway).
5. **Command tree (3 days, mostly deletion and docs).** `setup` absorbs
   deploy/upgrade/reconcile/claim-link and gains the reconcile branch
   (reuse `reconcile.ts:105-128`'s digest+hosts check); flat `deploy`,
   `dev`, `create`, `delete`, `secret`, `status`, `db`; delete `adopt`,
   `use-per-app-domains`, the `app`/`gateway` route maps outright (no
   hidden aliases); `deploy` offers to install when no Gateway exists;
   ~300 spelled occurrences in ~100 files (8 `package.json` scripts, 4
   `AGENTS.md`, 11 landing-page pages, both READMEs, 5 runbooks, 2 SDK
   error strings at `worker.ts:279,526`, 5 Gateway UI strings, ~60 CLI
   strings); rewrite `reference/cli.mdx` and the README from §1's
   transcripts.
6. **One routing mode, one naming scheme (1 day).** Delete wildcard
   routing, the `routing` column, the drizzle-kit history carry-over, the
   CAA preflight. thecomeup.cc is reinstalled with `setup`, not adopted.
7. **Lease and drift (1 day).** 3-minute TTL with the heartbeat hardening;
   delete `--break-lease`; the schema-drift preflight.

About 16 engineer-days. Steps 1 and 4 touch no auth or state and can land
in any order; 2 before 3 (the install row carries the public key the
registry writes need); 5 and 6 after 2.

### Live checks

All against a real account, in one session. Command → outcome → decision.
The checks about version annotations, secrets and settings PATCHes under
strict mode, and Access in front of a bearer are gone: nothing depends on
them any more.

1. **Abort stream and dashboard edit.** Edit the Worker in the dashboard,
   then `cf deploy --prebuilt --mode production </dev/null >out.log 2>err.log`.
   "Aborting…" in `out.log` is what the dist predicts (step 1's rule).
2. **Several accounts and the probe.** With a login seeing two or more
   accounts, and with a `CLOUDFLARE_API_TOKEN` scoped to one:
   `cf auth whoami --json`, then per account
   `time CLOUDFLARE_ACCOUNT_ID=<id> cf d1 list --name every-app-gateway --per-page 100 --json`.
   The out-of-scope account's error code decides the "auth means no
   Gateway" rule; latency decides the probe timeout.
3. **workers.dev subdomain missing.** On a brand-new account, the first
   `cf deploy --prebuilt`. Error text matches
   `/workers\.dev subdomain|\/workers\/onboarding/` → `register_workers_subdomain` fires.
4. **Workers Paid detection.** `cf accounts subscriptions get --json` on a
   paid account; `hasWorkersPaid` false there → the check is noise.
5. **`localD1Path` matches cf.** After `db migrate`,
   `ls .cloudflare/state/v3/d1/miniflare-D1DatabaseObject/` equals
   `localD1Path(root, localD1Id(workerName, 'DB'))`.
6. **Hostname-only changes without a version.**
   `cf workers triggers deploy --prebuilt --worker every-app-gateway` from
   the release Build Output; versions list unchanged and the Custom Domain
   present → `delete` and `setup`'s repair need no Gateway upload for
   hostname changes.
7. **cf profiles vs. discovery.** `cf auth activate <other-profile>` in an
   app directory, then `pnpm everyapp deploy`. Deploys under the other
   login → pass `--profile` on every runner call.
8. **D1 token scope.** An API token with D1 edit only:
   `CLOUDFLARE_API_TOKEN=$T cf d1 query <gateway-db> --body @insert.json`
   succeeds → ADR-0003's "any D1-write token is an operator" is literally
   true, and the wording stays.
9. **Activation latency.** Time from `cf deploy` of the Gateway with a new
   binding to the first non-503 answer from the app's hostname, against the
   live wait's timeout (today's `VERIFY_TIMEOUT_MS`, 120 s), including the
   certificate on a brand-new hostname.
10. **Batch atomicity** of several statements in one `cf d1 query --body @file`
    (the lease, setup link, install row and now the register batch rely on
    it).
11. **D1 time-travel.** `cf d1 time-travel get-bookmark <id>` shape, and
    the printed restore command works.
12. **Build cache.** `hashReleaseTree` is stable across two clean checkouts
    of the same commit on two machines (so a cache hit on one machine means
    the same bytes as a build on the other), and changes on any edit under
    the Gateway, the SDK or perimeter.

## 6. Decisions (made 2026-10-15)

Each was an open question in the first draft; the maintainer's answers and
the reasons recorded here are the design.

**The CLI writes the registry through D1; there is no deploy API in
self-host.** Chosen over the HTTP API plus a derived operator credential.
One transport, zero credentials, apps deployable before an owner exists,
and about 1,500 fewer lines of routes, auth and client. The cost accepted:
the registration rules move into a shared package so the Gateway and the
CLI agree, the Gateway activates apps and syncs tools on its own, and the
hosted tier writes its own API later (which ADR-0001 already requires).

**The Gateway is built from the checkout, cached by tree hash.** Chosen
over the KV release cache and over waiting for a settings-PATCH check. The
live Gateway always matches the checkout that last deployed; an older
checkout refuses with "git pull". The right answer changes once there are
published versions and people on different ones; that is when a release
cache comes back, if ever.

**`secret set` keeps redeploying, and says so.** (Reversed on 2026-10-17 by
Ben: `secret set|unset` now change the live Worker with `cf workers secrets
bulk`, record the version, and say which command deploys the code, so
several secrets no longer cost a build each.) It is `deploy` with one
more secret: one mental model, works unattended, secrets travel in
`--secrets-file`, no strict-mode gamble. Its first line names the app and
the secret and says the code and pending migrations come from this
directory. The confirm goes. Supersedes TODO.md's "re-upload only the live
version" idea.

**The install row is the source of truth for the live release.** Chosen
over cf's version annotations (unverified) and over probing the running
Gateway. Deploying the Gateway any other way is unsupported.

**The CAA preflight goes.** The certificate wait already ends with
`CERT_PENDING` and the same CAA hint, and `status` lists hosts without a
certificate. The rare zone with a blocking CAA record waits ten minutes to
hear why.

**The waits resolve new hostnames at the zone's nameservers.** The
certificate wait, the live wait and setup's one request before the owner
link look each hostname up at its zone's authoritative nameservers (found
through 1.1.1.1), not through the operating system's resolver, and connect
to those addresses with the hostname as SNI and Host. A resolver on the way
(the computer's, the router's) asked for a name before its record existed,
as between a teardown and a reinstall, remembers "no such name" for up to
the zone's SOA minimum (30 minutes on Cloudflare), and the wait sat out
those minutes labelled as a certificate wait. The nameservers that hold the
zone serve a new Custom Domain's record at once, so the first probe goes out
with no pause. Any failure on that path (UDP 53 blocked, no zone found)
falls back to the operating system's resolver, and the path has a 3 s
deadline: servers that fail without ever having answered aren't asked again
in that run, so a network that drops DNS packets costs the first probe 3 s
and every later one nothing. Each progress line says what
the last probe waited for: a certificate (TLS fails), DNS (no record at the
zone's nameservers yet) or an answer. A hostname that answers while the
operating system still can't resolve it gets `LOCAL_DNS_STALE`, a warning:
it works, a browser with its own DNS such as Chrome opens it now, and the
remembered answer clears within the SOA minimum.

**The lease stays: 3-minute TTL, 30-second heartbeat, no flag.** With the
work that makes a short TTL safe: today `renew()` swallows failures
(`lease.test.ts` asserts warn-and-continue), runs on an unguarded
`setInterval`, and each renew is a `cf d1 query` subprocess with the
runner's 120 s timeout, so two hung heartbeats would expire a live deploy's
lease. Required: a renew that returns no row, or has failed for longer than
TTL/2, aborts before the next irreversible step (re-check the holder before
migrations and before `cf deploy`); guard `renew()` against overlap with a
~20 s heartbeat timeout; keep `WAIT_MS` ≥ TTL + heartbeat. Legitimate holds
of 5-10 minutes stay normal; the TTL only governs dead-holder detection,
and `status` shows the holder.

**Attribution: the actor on the app row.** `deployed_by_actor` and
`deployed_at` written with every deploy; no event log until the hosted tier
needs one.

**No backwards compatibility.** No hidden `app`/`gateway` aliases, no
overlap release for `eak_`, no adoption of the pre-cf install, no
`legacyNames`, no wildcard routing. thecomeup.cc is reinstalled.

**One migration.** The Gateway's 33 migrations (799 lines of SQL, plus
drizzle's snapshot files) collapse into one generated file of the current
schema, and stay one file through the redesign: each schema change
regenerates the baseline rather than appending, because no database the
project cares about exists to migrate. The expand-only test keeps running
(a single CREATE-only file passes trivially) and matters again the day a
`0001` lands over a live database. The apps' histories collapse the same
way. Release ordering (`releaseOrder`: the newest migration's `when`, then
build time) is unaffected, since the baseline's `when` is newer than any
release that existed. What it buys is less the 800 lines than the free
hand: tables and columns the redesign removes are deleted from the schema
outright instead of being dropped by a numbered migration that waits a
release.

Carried from the first draft, confirmed: `create` scaffolds only
(`--deploy` for the quickstart); flat verbs with `setup` as the one
operator verb; a public dev keypair in the SDK with the issuer refusal;
`eak_` tokens, their admin UI and the `app_tokens` table go; `setup` does
not deploy the starter app (the docs change to match; the newcomer path is
`create` → `dev` → `deploy`, with `deploy` offering to install the
Gateway); a schema-drift preflight on `deploy` for
`migrations.engine === "drizzle"` (~60 lines; judge by new files, not
stderr; the transcripts' "schema in sync" is this); TODO.md's
`gateway access enable` becomes `everyapp access on` (built 2026-10-23: `access on|off|show`).

## 7. Rejected

- **An HTTP deploy API with a credential derived from the Cloudflare
  login** (the first revision's design: a one-hour bearer row in D1,
  minted through `cf d1 query`, looked up by `requireDeployTokenAuth`). It
  worked and added no power beyond D1 access, which is exactly why it was
  unnecessary: the CLI already had the authority it was asking the Gateway
  to confirm. Kept here because it is the right shape for a hosted API
  someday, with a real login behind it.
- **The Gateway as the deployer for self-host** (the CLI uploads a build;
  a Worker calls Cloudflare). A Worker can't run `cf`, so the pipeline (D1
  migrations with bookmarks, Custom Domains, strict-mode uploads,
  Workflows) would be rewritten against the REST API inside the Gateway,
  which would then hold a Cloudflare API token. More code, more state, a
  bigger blast radius, and it only matters when deployers must not have
  Cloudflare access, which is the hosted tier's problem.
- **Changing bindings without redeploying the Gateway.** cf beta.14
  exposes no settings command for plain Workers and no generic request
  command (its `/settings` calls are internal to auth, containers and
  Workers for Platforms); Void reads cf's OAuth token out of cf's credential
  store to call such endpoints directly, and we prefer not to hold a raw
  token. An API-side change also marks the Worker `last_deployed_from: api`,
  which cf's strict mode aborts on at the next unattended deploy. With the
  build cache, a rebind costs seconds, so the question stops mattering.
  Separately, `cf workers triggers deploy --prebuilt` applies Custom
  Domains, routes, crons and Workflows from a Build Output without a new
  version (live check 6), which would spare hostname-only changes an upload.
- **A KV cache of the live release.** Right for a world of published
  versions; wrong for a checkout-is-the-truth world, where it makes a
  stale machine deploy a release its own code doesn't match.
- **Signing requests with `JWT_PRIVATE_KEY`.** The key is generated by the
  CLI at the first deploy and never kept (`secretsFile.ts`).
- **Binding inference from imports** (Void). The explicit manifest is one
  file, typed, and what the Gateway snapshots; inference would add a
  scanner and make the agent's job less predictable.
- **Keychain storage, platform tokens, several credentials** (Void). The
  whole point here is one credential.
- **An app rollback command.** Redeploying the previous commit keeps the
  manifest, migrations and secrets consistent; a rollback of the Worker
  alone doesn't.
- **A `--plan`/dry-run for `setup`.** With fixed names and an idempotent
  run, the plan is the run.
- **A destructive-SQL gate on migrations** (Void). drizzle's routine
  table-recreate migrations contain `DROP` and `RENAME`; the D1 Time Travel
  bookmark is the better safety net.
- **Secrets as `NAME=value` on the command line** (Void). Values never go
  on argv.

## 8. Implementation notes (2026-10-16)

What the build changed against the text above, beyond the defaults listed
in TODO.md:

- **The Gateway's identity is its source tree, not the release SHA-256.**
  Builds are not reproducible (client chunk names differ per build), so the
  install row records `source_tree_sha256`, `status`'s `upToDate` and
  `setup`'s nothing-to-do compare tree hashes, and releases are ordered by
  newest migration then the last commit touching the Gateway's sources
  (`release_committed_at`, not build time). The build cache keeps the three
  most recently used builds; without git there is no cache.
- **The live wait is confirmed by D1, not by an HTTP status.** Fetching the
  app's URL triggers the Gateway's activation; `apps.status` decides. A
  redirect to Cloudflare Access means the Gateway never saw the request:
  once TLS answers, the deploy warns that the app goes live on its first
  visit and exits 0. `--no-wait` skips the whole wait.
- **An organization exists before the owner does.** The seeded "Default
  Organization" went with the migration squash, so the first registration
  on an ownerless Gateway creates one named after the Cloudflare account,
  and the setup claim adopts the oldest organization that has live apps and
  no members. Deployer access requires a verified email; password accounts
  never are, so without Cloudflare Access a new app is private to owners
  and admins.
- **The schema-drift check runs under the app's lease**, after the build
  (the build needs the lease's resources and the deploy's installed
  dependencies). drizzle-kit 0.31 refuses `--out` with `--config`, so the
  check writes a two-line config extending the app's into an ignored
  `.everyapp/schema-check-*` directory; a drizzle-kit run that fails stops
  the deploy with `SCHEMA_CHECK_FAILED`, because drizzle-kit exits 0 on its
  own errors.
- **The lease re-checks itself**: `Lease.check()` runs before migrations
  and before every `cf deploy`, and `status` lists every live lease
  (`data.leases`), not only the Gateway's.
- **Registry writes are per case, not one upsert**, so a concurrent admin
  change or Gateway activation is never overwritten; a redeploy updates
  only name and description.
- **Removed beyond the plan**: the SDK and CLI minimum-version checks (they
  came from the deleted `whoami` route), the `schema_version` column and
  the added-columns shim on the install table, `deploying` as a status
  value, and the reconcile confirm. Kept against the plan:
  `lib/interrupt.ts` (its upload record on Ctrl+C keeps the install row
  naming the live version, and freeing the lease spares the rerun a wait).
- **Smaller choices**: `secret unset` deletes with cf and then redeploys;
  `secret list` prints every name; `deploy -y` installs the Gateway without
  asking at a terminal and never unattended; the install offer proposes
  `apps.<zone>` only; the skill is copied into new apps rather than
  symlinked; `status` reads certificates from Cloudflare's certificate
  packs.
- **Migrations**: the single baseline was regenerated at each schema change
  during the build; the unique index on `accounts (provider_id,
  account_id)` that a hand-written migration had added now lives in the
  Cloudflare Access plugin's schema so regenerating keeps it.
- **Still to do on a real account**: TODO.md's live checks (two new ones:
  cf's strict mode after `cf workers secrets delete`, and a probe timeout
  for Gateway discovery), and the reinstall of thecomeup.cc after its old
  resources are deleted.
