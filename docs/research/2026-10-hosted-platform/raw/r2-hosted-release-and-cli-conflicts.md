# R2: How the hosted control plane ships, and three conflicts with the CLI redesign

Research round 2, 2026-10-15. The worktree is at `e1d9d3c6`. Code is cited from
`origin/main`, where PRs #284-#294 are merged, written as `main:<path>:<line>`.
"README" means `docs/research/2026-10-hosted-platform/README.md`. Anything not
backed by a dated source or code is marked UNVERIFIED and listed in §6.

## 1. The question

1. How do the hosted `every-app-gateway` (with `DISPATCHER`, a wildcard route,
   new Durable Objects and a minute cron) and `every-app-deployer` get built,
   staged, deployed and rolled back? How do their D1 migrations run once
   hosted D1 holds real data? Who holds which token? Do the install row and
   `olderThanInstalled` apply to an install we run ourselves? And what is the
   staging gateway that the `everyapp-staging` namespace needs?
2. The hosted plan (README H7, H11, H12) conflicts with three decisions in the
   merged CLI redesign:
   - (a) `secret set` redeploys from `cwd` in self-host, but uses the
     Workers for Platforms (WfP) secrets API in hosted.
   - (b) The redesign deleted `login`; H12 adds it back.
   - (c) H7 and H11 change self-host CLI files, and the tier names disagree.
3. What text should change in the README, and what does the founder need to
   decide?

## 2. Findings with sources

### 2.1 What the code does today

- **There is no deploy workflow.** `.github/workflows/` holds only
  `pr-checks.yml` and `cf-dry-run.yml`. The dry run builds the gateway
  release, patches it as an install would, and runs
  `cf deploy --prebuilt --dry-run` with no account or credentials
  (`main:.github/workflows/cf-dry-run.yml:11-16,36-41`). README §7 (line 826)
  says "the hosted gateway has its own pipeline", but nothing defines it.
- **The gateway release is one tarball that names no tenant.** It holds the
  Build Output v0, `drizzle/*.sql` and `release.json` (with a sha256 and the
  migration journal) (`main:apps/every-app-gateway/scripts/build-release.ts:1-17,67-115`).
  - The build refuses domains, non-scheduled triggers, `APP__*` bindings and
    resource ids. It requires the `__EVERYAPP_PATCH__` placeholder on
    `EVERYAPP_RELEASE` and `APP_BASE_DOMAIN` (`:146-204`).
  - cf refuses `--mode` for TanStack Start (`:286`), so a separate "hosted
    build mode" is not available. The config's only switch is
    `mode === "production"` (`main:apps/every-app-gateway/cloudflare.config.ts:89-92`).
- **Gateway config today.**
  - `GATEWAY_DEPLOYMENT_MODE` is an optional plain secret
    (`cloudflare.config.ts:27-54`, at `:34`).
  - Compatibility date is `2025-09-02` (`:97`).
  - There is one hourly cron, `17 * * * *` (`:116`).
  - Rate-limit namespaces `4180`-`4182` are shared across the whole account
    (`:134-152`).
- **How self-host deploys the gateway.** `applyGateway` runs these steps in
  order: take the lease, check for a downgrade, write the install row before
  the first upload, take a bookmark and run `cf d1 migrations apply`, patch,
  run `cf deploy --prebuilt`, record (`main:packages/cli/src/lib/gateway/apply.ts:1-43,299-375`).
  - `olderThanInstalled` orders releases by the newest migration's `when`,
    then by when the sources were last committed
    (`apply.ts:198-207`; `main:packages/cli/src/lib/gateway/release.ts:191-231`).
  - Builds are not reproducible: two builds of the same tree differ
    (`apply.ts:174-179`).
- **Discovery could find the hosted gateway.** Any cf login that sees an
  account with a D1 database named `every-app-gateway` finds its install row
  and uses it (`main:packages/cli/src/lib/gateway/discover.ts:1-22,129-149`).
  The install row has no mode column (`main:packages/cli/src/lib/gateway/install.ts:17-36`).
  - Nothing today stops the founder's own cf login, which will see the hosted
    account, from running self-host `deploy` or `setup` against production.
    That would write the hosted registry through D1 and redeploy the hosted
    gateway from a laptop checkout.
- **cf aborts unattended deploys of API-edited Workers.** cf 1.0.0-beta.14
  prompts when `last_deployed_from === "api"`, and an unattended run aborts
  (`apps/every-app-gateway/node_modules/cf/dist/containers-ncw3bd3a.mjs`;
  `main:packages/cli/src/lib/cf/deploy.ts:1-10`; `docs/cli-redesign.md:817-823`).
- **cf already has the commands a hosted pipeline needs.** cf 1.0.0-beta.14 ships:
  - `cf workers versions create --prebuilt` (upload a version without
    deploying it);
  - `cf workers deployments create --strategy percentage --versions`;
  - `cf workers triggers deploy`;
  - `cf d1 time-travel get-bookmark|restore`;
  - `cf workers-for-platforms dispatch-namespaces scripts secrets update|bulk`.

  Sources: `apps/every-app-gateway/node_modules/cf/dist/_meta/commands.json`
  and https://developers.cloudflare.com/cf/projects/ (fetched 2026-10-15).
- **`secret set` is a full deploy.** On main it is still `app secret set`
  (the flat verb comes with redesign step 5, which has not merged). It calls
  `deployApp()` with one more secret, so it also ships the code and pending
  migrations from `cwd` (`main:packages/cli/src/commands/app/secret/index.ts:19-55`).
- **Every app command starts with a Cloudflare login.** `connectToGateway`
  calls `ensureCfAuth` first, then discovery
  (`main:packages/cli/src/lib/gateway/connect.ts:75-108,127-162`).
  `--gateway` and `EVERYAPP_GATEWAY_URL` today only pick among the installs
  discovery found, and a host that doesn't match is an error
  (`connect.ts:1-11`; `discover.ts:177-189`).
- **Tier, worker name and org keys in the schema.**
  - `apps.tier` defaults to `service_binding`, with the comment "'dispatch'
    reserved" (`main:apps/every-app-gateway/src/db/apps.schema.ts:35-36`).
  - `Tier` is `"service_binding" | "dispatch"`, and unknown tiers are coerced
    to `service_binding` (`main:packages/perimeter/src/registry/apps.ts:11,77`;
    a test asserts this at `apps.test.ts:45-47`).
  - `planRegistration` writes `tier: "service_binding"`
    (`main:packages/perimeter/src/registry/registration.ts:475`).
  - `getAppFetcher` throws for `dispatch`
    (`main:packages/perimeter/src/getAppFetcher.ts:16-21,42-56`), and the
    gateway coerces the tier again at `toolbus/catalog-sync.ts:57` and
    `toolbus/runtime.ts:86`.
  - `worker_name` is `.unique()` (`apps.schema.ts:34`).
  - `organization_keys.organization_id` is a primary key with
    `onDelete: "cascade"`
    (`main:apps/every-app-gateway/src/db/organization-keys.schema.ts:11-15`).
- **The device login returns a full user session.** Better Auth 1.7.7's
  `device-authorization` plugin returns `access_token: session.token`. That
  is a session for the whole account, not a token scoped to one organization
  (`apps/every-app-gateway/node_modules/better-auth/dist/plugins/device-authorization/routes.mjs:455-473`).
  `UserPatService` already issues `epat_` personal access tokens bound to one
  organization, with an optional `appRowId`, scopes and a 90-day default TTL
  (`main:apps/every-app-gateway/src/server/services/UserPatService.ts:7-21`).
- **GitHub plan.** `every-app/private-every-app` is a private repo, and the
  org is on the `team` plan (`gh api`, 2026-10-15).

### 2.2 Cloudflare and GitHub facts the design rests on

| # | Fact | Source (fetched 2026-10-15) |
|---|---|---|
| F1 | A gradual deployment splits traffic between at most two versions. Only the last 100 uploaded versions can be used. Each request is routed independently unless you set version affinity with the `Cloudflare-Workers-Version-Key` header, which a zone Transform Rule can set. | https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/ (2026-07-03); .../gradual-deployments/version-affinity/ |
| F2 | Each Durable Object is pinned to one version per deployment. "Versions of Worker bundles that change Durable Object class lifecycle cannot be uploaded"; after such a change "rollbacks cannot take place to any version prior to the one that included the change". | https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/ |
| F3 | The `Cloudflare-Workers-Version-Overrides` header reaches a version in the current deployment even at 0%. It works for `fetch()` only, not RPC. | https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/ (2026-07-03) |
| F4 | You can roll back to any of the 100 most recent versions. Rollback is blocked across a Durable Object lifecycle change, or when a bound R2 bucket, KV namespace or queue is gone. "Resources connected to your Worker will not be changed during a rollback." | https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/ ; changelog 2025-09-11 |
| F5 | `POST /accounts/{a}/workers/scripts/{s}/versions` uploads a version. `POST .../deployments {strategy:"percentage", versions:[{version_id, percentage}]}` creates a deployment. | Cloudflare OpenAPI (via `mcp__cloudflare-api__search`) |
| F6 | WfP: `PUT .../dispatch/namespaces/{ns}/scripts/{s}/secrets` will "Add a secret to a Workers for Platforms script by creating a new version with that secret". `PATCH .../secrets-bulk` "creates a single version". The upload metadata field `keep_bindings` is a "List of binding types to keep from previous_upload". For regular Workers, `wrangler secret put` "creates a new version of the Worker and deploys it immediately". | OpenAPI; https://developers.cloudflare.com/workers/configuration/secrets/ |
| F7 | D1 Time Travel keeps 30 days on Workers Paid (7 on Free). A restore "overwrites the database in place", cancels "queries in flight", and returns a bookmark that undoes it. | https://developers.cloudflare.com/d1/reference/time-travel/ (2026-04-21) |
| F8 | API tokens can hold a per-Worker Editor role. "Creating a new Worker requires Workers Admin." Changing Routes or Custom Domains needs Zone > Workers Routes > Write on each zone. Workers roles do not grant D1. Nothing scopes a token to a dispatch namespace (README A4, 2026-10-12). | https://developers.cloudflare.com/workers/authorization/workers/ (2026-09-15) |
| F9 | You cannot create a Custom Domain "on a zone you do not own". | https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ (2026-09-29) |
| F10 | WfP Paid costs "$25 monthly" and includes 20M requests, 60M CPU ms and 1,000 scripts. The page doesn't say whether this is per account. | https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/ (2026-04-21) |
| F11 | Environment secrets reach only the jobs that reference the environment. On private repos they need Pro, Team or Enterprise. On Free, Pro and Team, required reviewers and wait timers "are only available for public repositories". Deployment-branch rules on private repos need Pro or Team. | https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments (no date shown) |

### 2.3 What follows

- **Staging in the production account collides with fixed names.**
  - The Worker `every-app-gateway` (`GATEWAY_WORKER_NAME`) is the target of
    every app's gateway binding.
  - The D1 database is `every-app-gateway` (`lib/gateway/resources.ts`).
  - The rate-limit namespaces `4180`-`4182` are shared across the account.
  - The deployer's token can't be confined to one namespace (F8).

  A second Cloudflare account keeps every name identical and keeps the tokens
  apart.
- **The production gate has to be a manual trigger.** On the Team plan with
  a private repo, a required reviewer can't gate production (F11). The gate
  has to be a manual trigger plus a branch rule. Agent PRs are auto-merged
  (standing rule), so deploying production on every merge would ship
  unreviewed code to every tenant.
- **Gradual deployments have limits here.** The gateway is a regular account
  Worker, so gradual deployments work for it. Two exceptions:
  - A release that adds or renames Durable Object classes can't be a version
    (F2). `OrgWallet` and `EveryAgent` arrive this way.
  - cf's strict-mode prompt may fire after `cf workers deployments create`
    (UNVERIFIED, R24).
- **Hosted data can't survive a regenerated baseline.** The database's
  `d1_migrations` table already lists the old `0000_*`, so
  `cf d1 migrations apply` would run the new `0000_*.sql`, whose CREATEs
  fail against existing tables. Moving hosted-only tables into their own D1
  doesn't help. Better Auth, `apps`, `organization_keys`, `user_app_access`
  and the MCP tables hold hosted's real data too.
- **The WfP secret API already does "redeploy the stored bundle".** Per F6,
  Cloudflare builds a new version from the live code plus the new secret.

## 3. Recommendation

### 3.1 The hosted control-plane release pipeline (new README H27)

```
push to main ─► build once ─────────► staging (automatic) ─────────► production (manual promote of that run)
 pr-checks       gateway release.tgz   account "Every App Staging"    account "Every App" (D7)
 cf-dry-run      deployer release.tgz  namespace everyapp-staging     namespace everyapp-prod
 (+ hosted       sha256 recorded       100% deploys, smoke + N-1      gradual once R24 passes:
  profile)                                                            0% → override smoke → 10% → 50% → 100%
```

**One workflow, `hosted-release.yml`.**
- The build job runs on every push to main. It builds the SDK, runs
  `build:release` and builds the deployer's release. It uploads one artifact
  per run.
- The `staging` job runs on its own after the build.
- The `production` job runs only on `workflow_dispatch` with
  `promote: <run id>`. It deploys that run's artifact, never a rebuild:
  builds aren't reproducible (`apply.ts:174-179`), so "the bytes staging
  tested" requires a single build.
- Concurrency group `hosted-<env>`.
- Both deploy jobs call one internal entry point,
  `packages/cli/src/ops/hostedRelease.ts`. It is not a user command. It
  reuses `applyGateway` with a `hosted` profile.

**Steps for each environment:**

1. Take the D1 `gateway` lease (`apply.ts:128-156`).
2. Read the install row. Refuse if `olderThanInstalled`, which catches a
   re-run of an old workflow or the promotion of a stale run. Never pass
   `allowDowngrade`.
3. Take a bookmark with `cf d1 time-travel get-bookmark`, then run
   `cf d1 migrations apply` through `migrateRemoteD1`
   (`main:packages/cli/src/lib/migrations/remote.ts:1-60`). Migrations stay
   expand-only, which `release-migrations.test.ts` already enforces.
4. Deploy `every-app-deployer` at 100%, before the gateway, because the
   gateway calls it. Its RPC methods only ever get added.
5. Patch the same release with a new `patchHostedGatewayBuildOutput()`,
   which sits next to `patchGatewayBuildOutput`. It sets:
   - `GATEWAY_DEPLOYMENT_MODE` as a text binding (`hosted`; the self-host
     patcher writes `self_hosted`, and H6 makes this a patched value);
   - `DISPATCHER`, the dispatch-namespace binding (`everyapp-staging` or
     `everyapp-prod`), plus the `Outbound` entrypoint;
   - a `* * * * *` cron next to `17 * * * *`;
   - one Custom Domain for the control-plane host, plus the route
     `*.<content domain>/*`. Never a Custom Domain per app: the cap is 100
     per zone.
   - `APP__*` service bindings only for `tier='platform'` rows, from
     `readDesiredState` filtered by tier.

   Everything else goes in `cloudflare.config.ts` for both modes: the
   Durable Object classes, the compatibility date of 2025-11-17 or later, and
   the `AI` binding. That keeps one Build Output as the contract.
   `cf-dry-run.yml` dry-runs both profiles.
6. Upload:
   - **Staging, or any release whose Build Output `exports` change Durable
     Object class lifecycle:** one `cf deploy --prebuilt` at 100% (F2).
   - **Production otherwise, once R24 passes:**
     1. `cf workers versions create --prebuilt --tag <sha256[0:12]>`.
     2. `cf workers deployments create` with the new version at 0% and the
        old at 100%.
     3. Smoke-test the new version through `Cloudflare-Workers-Version-Overrides`
        (F3).
     4. Move to 10% for 10 minutes, then 50%, then 100%. Each step waits
        while the new version's 5xx rate stays at or below the old one's.
        The thresholds are tuning, UNVERIFIED.
   - **Version affinity:** a Transform Rule on the control-plane zone sets
     `Cloudflare-Workers-Version-Key` from the session cookie (F1). That
     stops the SPA's hashed assets and a user's session from switching
     between versions.
   - **Trigger changes** (routes, domains, crons) are applied with
     `cf workers triggers deploy --prebuilt` when they differ.
7. Record:
   - write the install row with `mode='hosted'` and
     `updated_by: hosted-release <run url>`;
   - append a row to a new CLI-owned table `_everyapp_releases`
     `{version_id, release_sha256, version, order, bookmark, run_url, deployed_at}`.
8. Run the smoke suite (`apps/every-app-gateway/scripts/hosted-smoke.ts`)
   in both environments:
   - `GET /__everyapp/release`, a new endpoint returning `EVERYAPP_RELEASE`
     and `CF_VERSION_METADATA.id`. It proves an override reached the new
     version.
   - Sign up and verify against a test inbox.
   - Deploy the template through the hosted CLI branch with a staging
     deploy key.
   - Open it through the per-host handoff (H8).
   - Make one metered broker call on a capped OpenRouter key.
   - Wait for one scheduler tick (H15).
   - Call `/mcp` initialize.
   - **N-1 check:** the previous run's template build still works against
     the new gateway.

**Rollback (a manual `hosted-rollback` job):**
1. Pick the previous `_everyapp_releases` row.
2. Run `cf workers deployments create` with that version at 100%.
   - Cloudflare refuses across a Durable Object lifecycle change (F4).
   - The job itself refuses a version older than the last
     `-- everyapp:contract <release>` migration.
3. Rewrite the install row from that row.

The database stays migrated: migrations are expand-only, so old code runs on
the new schema. `cf d1 time-travel restore --bookmark` is for data corruption
only, and only the founder runs it. It overwrites in place, cancels in-flight
queries and loses every write since the bookmark: sign-ups, grants, apps. It
returns an undo bookmark (F7). Durable Object SQLite migrations, such as
`OrgWallet`'s own baseline, follow the same expand-only rule: a rollback runs
old Durable Object code on new storage.

**The install row for an install we run ourselves:**
- **Keep the row.** It gives the pipeline the same lease, the same refusal
  of an older checkout, `jwt_public_key` for the deployer, and
  `live_version_id` for `assertReplaceable`.
- **Add `mode TEXT NOT NULL DEFAULT 'self_hosted'` to `_everyapp_install`**
  (`install.ts:17-36`).
  - Self-host `requireInstall` (`connect.ts:110-124`) refuses
    `mode='hosted'` with `HOSTED_INSTALL`: "This account runs hosted Every
    App, deployed by .github/workflows/hosted-release.yml. Deploy apps to it
    with --gateway https://app.everyapp.com."
  - `setup` refuses to install into an account that already holds a hosted
    install.
  - This refusal is the only thing between the founder's cf login and a
    laptop redeploy of production.
- **Never on hosted:** `--allow-downgrade` and `setup --redeploy`. Rollback
  goes through Cloudflare's version history, not a rebuild of an old
  checkout.

**Migrations once hosted holds data.**
- **Default:** one migration history for both modes, frozen at the first
  production deploy that opens sign-up beyond the team.
  - `apps/every-app-gateway/drizzle/frozen.json` lists the sha256 of every
    frozen file.
  - `release-migrations.test.ts` fails if a frozen file changes or
    disappears.
  - New files are numbered `0001_*` onward and stay expand-only. Drops carry
    `-- everyapp:contract <release>`.
  - Until the freeze, the staging and production hosted D1s are dropped and
    recreated whenever the baseline is regenerated. They hold nothing.
- **Self-host follows the same history after the freeze.** Its only cost is
  that drops wait one release behind a contract marker. There are no
  self-host users, and thecomeup.cc is disposable.
- **Rejected: splitting hosted-only tables into their own D1 so the shared
  baseline can keep being regenerated.** The shared tables are where
  hosted's real data lives. A second D1 for `usage_daily` and
  `audit_events` may still pay off for write throughput (R22); it would be
  append-only from the start.
- **Alternative if the founder wants self-host to keep regenerating:** a
  second drizzle output folder, `drizzle-hosted/`, generated from the same
  schema. drizzle-kit keeps one snapshot chain per output folder. The
  release packs both folders, and the patch profile picks one. Costs about
  0.5 day plus a CI check that both are current. Not recommended: two
  histories of one schema drift apart.

**Who holds which credential:**

| Credential | Held by | Scope | Used for |
|---|---|---|---|
| Founder's `cf auth login` | Founder's laptop | Account owner | Once per account: buy WfP; create zones, D1, KV and the dispatch namespace; the first `cf deploy` of each Worker (creating a Worker needs product-level Admin, F8); the Transform Rule; mint the tokens below |
| `CLOUDFLARE_API_TOKEN` in GitHub environment `staging` | GitHub environment secret | Account-owned token on the staging account: Workers Editor on `every-app-gateway` and `every-app-deployer` only, D1 Edit, Workers Routes Write on the two staging zones | Staging releases and smoke tests |
| `CLOUDFLARE_API_TOKEN` in GitHub environment `production` | GitHub environment secret, branch-restricted to `main`; the job runs only on `workflow_dispatch` | Same scopes on the production account | Production releases and rollbacks |
| Deployer runtime token | A secret on the `every-app-deployer` Worker only. Never in GitHub, never in the public gateway. | WfP script write and D1 Edit. Account-wide, because nothing scopes to a namespace. | Tenant deploys (H10) |
| Platform secrets (`BETTER_AUTH_SECRET`, the KEK, `AUTUMN_*`, `OPENROUTER_*`, email) | GitHub environment secrets, one set per environment | n/a | Sent through `--secrets-file` on each release; cf keeps any secret the file doesn't list. Never set through the secrets API, which marks the Worker API-edited and makes cf abort the next unattended deploy. |
| Gateway identity keypair | Generated by the first deploy (`apply.ts:459-464`); the private half lives only in the Worker | n/a | Public half in the install row, read by the deployer |
| Staging deploy key (`epat_`, scope `deploy`) and a capped OpenRouter key | GitHub environment secret `staging` | One test org and app | The smoke suite |

**The staging gateway:**
- **Account:** a second Cloudflare account, "Every App Staging", with
  Workers Paid and WfP. WfP is $25 a month (F10); whether that adds to
  Workers Paid is R18.
- **Names:** identical to production. Workers `every-app-gateway` and
  `every-app-deployer`, D1 `every-app-gateway`, the OAuth KV. The namespace
  is `everyapp-staging`; `everyapp-prod` lives in the production account.
  The release bytes are identical, and only the patched values differ.
- **Domains:** two zones in the staging account, one for the control plane
  and one for content, mirroring production's split (README D1, scheme C).
  A Custom Domain can't sit on another account's zone (F9), and Universal
  SSL covers only one wildcard level (README A3). Domain names are the
  founder's choice; cost UNVERIFIED.
- **Data and outside services:** Autumn sandbox `everyapp` (D5), an
  OpenRouter key with a small `limit`, email only to an allowlist, and a
  test org with a deploy key.
- **When it deploys:** automatically on every merge to main. Before the
  freeze it is wiped whenever the baseline is regenerated. After the freeze
  it rehearses every new migration over the previous schema before
  production does.

**Cost to change later.** The workflow and the ops script are about one day
of rework. Moving staging into the production account means renaming and
patching every fixed name, about 1-2 days. Undoing the migration freeze is
impossible once real data exists, which is the point of it.

**Size.** About 3.5 days: workflow 1 d; hosted patch profile, ops entry
point and dry run 1 d; release history, rollback and smoke suite 1 d; mode
refusal and the frozen-baseline test 0.5 d.

### 3.2 The three conflicts

**(a) `secret set`: per-target semantics under one verb, stated on the first line.**

- **Self-host stays as decided** (`docs/cli-redesign.md:740-745`).
  - It redeploys from `cwd`.
  - First line: "Redeploying todo with GITHUB_TOKEN (code and pending
    migrations from this directory)".
- **Hosted dispatch apps use the WfP secrets API.**
  - Cloudflare builds a new version from the live code plus the secret (F6).
  - First line: "Setting GITHUB_TOKEN on todo in acme: the running code
    stays as it is".
  - Under `--json`, `done.data.codeFrom` is `"cwd"` or `"live"`.
  - It needs no checkout: it takes `--app <id>`, or the manifest's id from
    `cwd` when there is one.
  - Every hosted upload sends `keep_bindings: ["secret_text"]`, as H10 and
    H12 already say.
- **Hosted platform-tier installs (one shared catalog Worker)** store the
  secret in the gateway's `app_secrets`, envelope-encrypted (H20), not as a
  Worker secret.
- **Hosted `--for gateway` is refused:** "the hosted Gateway's settings are
  Every App's".

Why not "hosted redeploys from `cwd` too":
- An org that installed a catalog app, or an admin working in the UI, has no
  source checkout.
- Self-host redeploys because of cf's strict mode, which doesn't exist in
  hosted: the deployer calls the REST API, not cf.
- The secrets API already is "redeploy the stored bundle with the new
  secret".

Cost to change: some copy and one branch. Cheap.

**(b) Login: one credential per target, never both.**

- **Self-host:** the cf login only, unchanged.
- **Hosted:** an Every App token scoped to one organization, only. The
  hosted branch never calls `ensureCfAuth`, `resolveAccount` or
  `discoverGateway`. cf runs only locally, for `cf build` and
  `cf workers types`. Whether `cf build` runs with no login is checked in
  R28.
- **The target is chosen locally, before any cf call,** by a new
  `packages/cli/src/lib/target.ts`. Hosted is chosen when any of these hold:
  - `EVERYAPP_TOKEN` is set;
  - the host in `--gateway` or `EVERYAPP_GATEWAY_URL` is a hosted host
    (built in: `app.everyapp.com`; staging hosts come from
    `EVERYAPP_HOSTED_HOSTS`);
  - a token is stored for that host.

  Otherwise the command is self-host as today, and `--gateway` still picks
  among the discovered installs.
- **Drop H12's "branch on the gateway's reported mode".** It would make the
  CLI call the gateway over HTTPS for every self-host run with `--gateway`,
  which the redesign removed (`docs/cli-redesign.md:60`).
- **No `login` verb**, which keeps the redesign's list of deleted commands
  intact (`docs/cli-redesign.md:28-29`).
  1. The first hosted command that needs a token runs the device flow
     itself, as `ensureCfAuth` does with `onDeviceLogin`. Under `--json` it
     emits `action_required authorize_device {verificationUri, userCode}`
     and waits.
  2. The flow returns a full Better Auth session. The CLI immediately
     exchanges it at `POST /api/v1/cli/tokens {organizationId}` for an
     `epat_` token: scopes `deploy` and `apps:read`, 30-day expiry, revoked
     when the membership ends. Then it signs the session out.
  3. The token is stored at
     `${XDG_CONFIG_HOME:-~/.config}/everyapp/hosted-tokens.json` (directory
     0700, file 0600), keyed by host. An OS keychain can come later.
- **`everyapp logout [--gateway]`** is the one new verb, hosted-only. It
  revokes the token and forgets it.
- **CI** sets `EVERYAPP_TOKEN` and `EVERYAPP_GATEWAY_URL` and writes
  nothing.
- **This fits the existing decisions.** ADR-0003 Decision 5 already gives
  the hosted tier its own credentials and says nothing in that ADR applies
  there (`main:adr/ADR-0003-self-host-authority.md:41-43`). It only needs a
  one-paragraph "Hosted target" note in `docs/cli-redesign.md` §1.
- **Cost to change:** adding a `login` verb later is additive; moving to a
  keychain is local.

**(c) Self-host files on main that H7 and H11 change, and the tier names.**

H7 (schema):
- `packages/perimeter/src/registry/registration.ts`:
  - `AppRow` (`:39-56`);
  - `RegistrationInput` (`:308-329`) gains `tier` (default
    `service_binding`) and `source` (default `org`), which `planRegistration`
    writes (`:475`);
  - `markDeployedUpdate` (`:521-538`) takes `tier`: `dispatch` goes
    `pending → active`, every other tier is unchanged.
  - Test: `registration.test.ts`.
- `packages/perimeter/src/registry/apps.ts`: `Tier` (`:11`) gains
  `platform`. `rowToRegisteredApp` (`:77`) stops coercing unknown tiers; a
  row with an unknown tier can't be routed. `apps.test.ts:45-47` flips.
- `packages/perimeter/src/getAppFetcher.ts` (`:16-21,42-56`): `platform`
  takes the `APP__<worker>` branch. Test: `getAppFetcher.test.ts`.
- `packages/cli/src/lib/gateway/registry.ts`:
  - `APP_COLUMNS` and the row mapping (`:86-120`);
  - the `register` INSERT (`:364-376`) writes `tier` and `source`;
  - the Worker-name takeover SELECT (`:311`) gains `AND tier <> 'platform'`;
  - `markDeployed` (`:469-505`) passes the row's tier.
  - Test: `registry.test.ts`.
- `packages/cli/src/lib/gateway/desiredState.ts`: `DESIRED_APPS`
  (`:19-25`) takes a `tiers` option. Self-host binds `service_binding`;
  hosted binds `platform`.
- `packages/cli/src/lib/gateway/install.ts` (`:17-36,84-166`) gets the
  `mode` column. `connect.ts` `requireInstall` (`:110-124`) refuses hosted.
  Tests: `discover.test.ts`, `apply.test.ts`.
- `apps/every-app-gateway/src/db/apps.schema.ts` (`:34-36`): a partial
  unique index on `worker_name`, excluding `platform` rows.
- `apps/every-app-gateway/src/db/organization-keys.schema.ts` (`:12-14`):
  drop the foreign key and keep the primary key, so the tombstone survives
  org deletion.
- Regenerate `drizzle/0000_*.sql` and `meta/`.
- Gateway callers (not the CLI): `src/test/registry.ts:107-186`,
  `toolbus/catalog-sync.ts:57`, `toolbus/runtime.ts:86`,
  `perimeter/drizzleAppRegistry.ts` and its test.
- Tests that seed SQL (`deployApp.test.ts:1177`, `apply.test.ts:121`) keep
  passing as long as the new columns have defaults.

H11 (builds that name no tenant):
- `packages/sdk/src/cloudflare/worker.ts` (the production branch) and
  `worker.test.ts`: emit placeholders.
- `packages/sdk/src/cloudflare/deployInputs.ts` and `deployInputs.test.ts`:
  delete `.everyapp/deploy.json` outright. A neutral build needs no inputs,
  so README H11's "schema 2 `target`" is unnecessary.
- `packages/cli/src/lib/app/buildApp.ts` and its test drop
  `writeDeployInputs`. `packages/cli/src/lib/app/deployInputs.ts` goes.
- New `packages/cli/src/lib/app/patchAppBuildOutput.ts` and test. It fills
  the Worker name, D1 and KV ids, Workflow names, identity text bindings and
  gateway binding props, and refuses any placeholder that survives.
- `packages/cli/src/lib/app/policy.ts` and `policy.test.ts` move to
  `packages/perimeter/src/policy/`. The self-host profile runs on the
  patched output; the hosted profile runs on the neutral one.
- `packages/cli/src/lib/app/workflows.ts` and `resources.ts`: names and ids
  feed the patch.
- `packages/cli/src/commands/app/deploy/deployApp.ts` (the
  build, provision and deploy steps, `:341-413`), `deployApp.test.ts` and
  `stdout.test.ts`.
- `packages/cli/src/lib/cfDryRun.test.ts` and the comment in
  `cf-dry-run.yml`.

**Tier naming, settled.**
- Keep the column `tier` and the value `service_binding`, which is the
  self-host default; about 20 tests already use it.
- The three values:
  - `service_binding`: one org's Worker, reached over a service binding
    (self-host).
  - `dispatch`: one org's Worker in the dispatch namespace (hosted).
  - `platform`: one shared catalog Worker for many orgs, reached over a
    service binding (hosted).
- The synthesis's "`tier` (`dispatch`, `platform`)" therefore means "add
  `platform` and start writing `dispatch`".
- One column, not two (transport and tenancy). Only three combinations
  exist, and a second column would allow a fourth (shared and dispatched)
  that can't.
- Cost to change: renaming later is a data migration on a live column.
  Cheap now.

## 4. Text to change in README.md

**§5 Phase 2: insert this row after H7.**

> | H27 | **Hosted control-plane release pipeline** | `hosted-release.yml`: build once on push to main (SDK, `build:release`, deployer release, sha256); `staging` job automatic, `production` job only on `workflow_dispatch` promoting a green staging run (branch-restricted to main; GitHub Team private repos have no required reviewers); both run `packages/cli/src/ops/hostedRelease.ts` (reuses `applyGateway`). Per env: D1 lease → `olderThanInstalled` refusal → bookmark → `cf d1 migrations apply` (expand-only) → deployer at 100% → gateway patched by `patchHostedGatewayBuildOutput()` (`GATEWAY_DEPLOYMENT_MODE=hosted` text binding, `DISPATCHER` + `Outbound`, `* * * * *` beside `17 * * * *`, control-plane Custom Domain + `*.<content>/*` route, `APP__*` only for `tier='platform'`; DO classes, compat date ≥ 2025-11-17 and `AI` stay in `cloudflare.config.ts` for both modes) → upload: staging and DO-lifecycle releases `cf deploy` 100%, else `cf workers versions create` → `deployments create` 0% → smoke via `Cloudflare-Workers-Version-Overrides` → 10/50/100% with a 5xx gate, version affinity from a Transform Rule on the session cookie; `cf workers triggers deploy` when triggers change. Install row gains `mode='hosted'` (self-host `connectToGateway`/`setup` refuse it); `_everyapp_releases` history; `hosted-rollback` job (`deployments create` previous version at 100%, never past a DO lifecycle change or a contract migration; D1 `time-travel restore` founder-only). `drizzle/frozen.json` + `release-migrations.test.ts` freeze the baseline at the first public hosted deploy. Staging = second Cloudflare account, same names, namespace `everyapp-staging`, own control + content zones, Autumn sandbox, capped OpenRouter key, email allowlist. Smoke suite incl. new `/__everyapp/release` and an N-1 template check. Tokens: per-env account-owned token (per-Worker Editor, D1 Edit, Workers Routes Write) as a GitHub Environment secret; deployer token only as its Worker secret; platform secrets via `--secrets-file`, never the secrets API. `cf-dry-run.yml` dry-runs the hosted profile. | H6, H7, D7, D13, D14 (H10 adds the deployer step) | 3.5 | Unchanged; self-host commands refuse a `mode='hosted'` install |

**H7: replace** "`apps` gains `tier='platform'`, … `markDeployedUpdate` →
`active` for dispatch." **with:**

> `Tier = 'service_binding' | 'dispatch' | 'platform'` (no rename; `service_binding` stays the self-host default; `platform` is a shared catalog Worker reached over a service binding and `getAppFetcher` maps it to `APP__<worker>`; unknown tiers fail closed instead of coercing); `apps` gains `source`, `catalog_app_id`, `limits`, `disabled_reason`, `current_version_id`; partial unique `worker_name` excluding `platform`; `organization_keys` FK dropped (PK kept, tombstone survives org deletion); regenerate the one baseline; `RegistrationInput.tier`/`source`; `markDeployedUpdate(tier)` → `active` for dispatch. Self-host files that change: perimeter `registry/registration.ts`, `registry/apps.ts`, `getAppFetcher.ts` (+ tests; `apps.test.ts:45-47` flips); CLI `lib/gateway/registry.ts` (takeover SELECT excludes `platform`), `desiredState.ts` (`tiers` option), `install.ts` (`mode`), `connect.ts` (refuse hosted) (+ `registry.test.ts`, `discover.test.ts`, `apply.test.ts`).

Self-host column for H7: "Tables created empty; the CLI writes
`tier='service_binding'` as today".

**H11: replace** "deploy inputs schema 2 `target: "self-host" \| "hosted"`"
**with:**

> `.everyapp/deploy.json` and `deployInputs.ts` (SDK and CLI) deleted: the neutral build needs no inputs; `patchAppBuildOutput()` fills Worker name, ids, Workflow names, identity text bindings and gateway props and refuses a surviving placeholder

Append to Contains: "Self-host files: SDK `cloudflare/worker.ts`; CLI
`lib/app/{buildApp,patchAppBuildOutput,workflows,resources}.ts`,
`lib/app/policy.ts` → `perimeter/src/policy/`,
`commands/app/deploy/deployApp.ts`, `lib/cfDryRun.test.ts`."

**H12: replace** "`everyapp login --gateway` device flow issuing an
org-scoped token (hashed, 30-day sliding, revocable, dies with membership)"
**with:**

> no `login` verb: the first hosted command runs the device flow (Better Auth's plugin returns a full session, `routes.mjs:455-473`), the CLI exchanges it at `POST /api/v1/cli/tokens` for an org-bound `epat_` (`deploy`, `apps:read`, 30 days, dies with membership) and signs the session out; stored per host in `~/.config/everyapp/hosted-tokens.json` (0600); `everyapp logout` (hosted-only) revokes; CI uses `EVERYAPP_TOKEN` and stores nothing

Also in H12:
- Replace "`PUT .../secrets/{name}` (WfP secrets API, …, no redeploy)" with:
  "`PUT|DELETE|GET .../secrets` (dispatch apps: WfP secrets API, a new
  version of the live code; platform-tier installs: `app_secrets`, H20);
  `secret set` says on its first line whether code comes from `cwd`
  (self-host) or stays live (hosted)".
- Replace "CLI hosted branch (skip `cf` login, …)" with: "CLI hosted branch
  chosen locally by `lib/target.ts` (`EVERYAPP_TOKEN`, a hosted host in
  `--gateway`/`EVERYAPP_GATEWAY_URL`, or a stored token), never calling
  `ensureCfAuth` or discovery; `cf` only for `build`/`workers types`; build
  neutral, bundle, direct asset upload with the session JWT, follow SSE".
- Self-host column: replace "(branch on the gateway's reported mode)" with
  "untouched; no HTTPS call to choose the target".
- Size: 5 → 5.5.

**§4 Defaults list:**
- Replace the bullet starting "One dispatch namespace (`everyapp-prod`)
  plus `everyapp-staging`" with: "One dispatch namespace per account:
  `everyapp-prod` in the hosted account, `everyapp-staging` in a separate
  staging account (D14); untrusted mode, never `trusted_workers`. …" (the
  rest unchanged).
- Replace the bullet "Hosted tables ship in self-host, … then append-only."
  with: "Hosted tables ship in self-host, empty, under `src/db/hosted/`. One
  regenerated baseline until the first public hosted deploy; then
  `drizzle/frozen.json` freezes it for both modes and new migrations are
  numbered and expand-only (D15)."
- Add: "`tier` values `service_binding` (self-host), `dispatch`, `platform`;
  no rename."
- Add: "One credential per target: cf login for self-host, an org-bound
  `epat_` for hosted; the target is chosen locally."

**D7:** append "A second account holds staging (H27, D14)."

**§5 "The first outside org":** add H27 to the list and about 3.5 d to the
total.

**§1 diagram, line 100:** "`everyapp-prod (untrusted) + everyapp-staging`"
becomes "`everyapp-prod (untrusted); staging in its own account`".

**§2 table, "Gateway Worker config" row:** replace "Hosted build adds …"
with:

> One build for both modes (cf refuses `--mode` for TanStack Start, `build-release.ts:286`): DO bindings, compat date ≥ 2025-11-17 and `AI` in `cloudflare.config.ts`; hosted-only parts (`DISPATCHER` + outbound, minute cron, wildcard route, mode) are the H27 patch profile.

**§6: add these rows.**

| # | Risk or unknown | Status today | Live check | If it goes the wrong way |
|---|---|---|---|---|
| R24 | After `cf workers deployments create`, the next unattended `cf deploy`/`versions create` aborts on `last_deployed_from: api` | `unverified`; cf beta.14 prompts on `api` | In CI mode: versions create → deployments create 50/50 → `cf deploy --prebuilt </dev/null` | Gradual steps via `wrangler versions deploy`, or 100% deploys with rollback only |
| R25 | Which version runs `scheduled` (the minute cron) during a split; whether `versions create --prebuilt` ignores routes, domains and crons in the Build Output | `unverified` | Split 50/50 and log `CF_VERSION_METADATA.id` in `scheduled`; compare triggers before and after | Scheduler claims must be idempotent (they already must be); apply triggers only with `triggers deploy` |
| R26 | A patched `dispatch_namespace` binding with `outbound` passes `OutputWorkerSchema` and `cf deploy --prebuilt` | `unverified` | `cf-dry-run` with the hosted profile | Upload the hosted gateway through the REST API from the ops script |
| R27 | D1 Edit can be scoped to one database; creating dispatch scripts needs Workers product Admin (so the deployer token can also overwrite the gateway) | `unverified` | Create both tokens in the dashboard and try both operations | Accept the account-wide token; watch the gateway with a version alert |
| R28 | A WfP secret PUT is live immediately and survives the next upload with `keep_bindings: ["secret_text"]`; `cf build`/`cf workers types` run with no Cloudflare login; WfP $25 on a second account | `unverified` (F6 says "creating a new version") | Secret PUT then request; upload; request; `HOME=$(mktemp -d) cf build`; read the staging invoice | Hosted `secret set` re-uploads the stored bundle; hosted users need cf only for build |

**§7 Appendix: add these rows.**

| Claim (where) | Status | Correction |
|---|---|---|
| `docs/cli-redesign.md:740-745`: "`secret set` keeps redeploying" | self-host only | Hosted `secret set` sets the secret on the live version (WfP "creating a new version with that secret"); platform-tier installs use `app_secrets`; the first line names which (r2-hosted-release) |
| `docs/cli-redesign.md:28,48`: `login` deleted; "the Cloudflare login is the only credential" | per target | One credential per target. Hosted uses an org-bound `epat_` from the device flow; no `login` verb, hosted-only `logout`; the hosted branch never calls `ensureCfAuth` (r2) |
| README H12: "branch on the gateway's reported mode" | contradicts `docs/cli-redesign.md:60` | The target is resolved locally, with no HTTPS call (r2) |
| `docs/cli-redesign.md:772-790`: "No backwards compatibility", "One migration" | end at the hosted freeze | `drizzle/frozen.json` for both modes; N-1 compatibility for SDK↔gateway, gateway↔deployer, CLI↔`/api/v1` (D15) (r2) |
| `docs/cli-redesign.md:137-154,733`: discovery through the account; the gateway built from the checkout | holds, with one gap | CI builds main once and promotes the same bytes. Without a `mode='hosted'` install row, the founder's cf login discovers production and can redeploy it from a laptop (r2) |
| README §7 line 826: "the hosted gateway has its own pipeline" | was undefined | H27 (r2) |

## 5. New founder decisions

**D13. Does a merge to main deploy hosted production?**
- Why it matters: agent PRs auto-merge, and on a private repo the Team plan
  can't require a reviewer on an environment (F11).
- Options: production on every merge; manual promotion; a tag.
- Default: staging deploys on every merge. Production deploys only on a
  `workflow_dispatch` that promotes a green staging run, restricted to main.
- Cost to change: one trigger line.

**D14. Staging in a second Cloudflare account?**
- Why it matters: fixed names (Worker, D1, rate-limit ids) and token scopes
  that can't be narrowed to a namespace make staging in the production
  account either collide with production or reach into it.
- Default: yes. Its own WfP subscription ($25 a month, F10) and two cheap
  domains.
- Cost to change later: 1-2 days to rename and patch.

**D15. When the first outside org arrives, do migrations freeze for both
modes, and do hosted contracts become compatible with the previous
release?**
- Why it matters: the redesign's "one migration" and "no backwards
  compatibility" can't hold over real data, or over org apps built against
  an older SDK.
- Contracts in scope: the D1 schema, SDK↔gateway (`minSdk`),
  gateway↔deployer, and CLI↔`/api/v1`.
- Default: yes to both, at the first production deploy that opens sign-up.
  Self-host follows the same frozen history.
- Alternative: a separate `drizzle-hosted/` history (+0.5 d, and two
  histories to keep in step).
- Cost to change: none before the freeze; impossible after it.

**D16. What does a bare `everyapp deploy` do for someone with no Cloudflare
login, once hosted exists?**
- Why it matters: today it starts `cf auth login`, and the newcomer path is
  `create` → `dev` → `deploy`.
- Default: self-host stays the default target. When there is no cf login and
  no Gateway, `deploy` offers "sign in to everyapp.com" next to "install your
  own Gateway"; under `--json` it emits `action_required choose_target`.
  Otherwise hosted is reached only through `--gateway`, the env vars or a
  stored token.
- Cost to change: copy and one branch.

## 6. UNVERIFIED items and the live check that settles each

1. **cf strict mode after a deployment change.** Does
   `cf workers deployments create` mark the Worker `last_deployed_from: api`,
   so the next unattended cf upload aborts? (R24) Check: in CI mode, run
   versions create → deployments create → `cf deploy --prebuilt </dev/null`.
2. **Crons and triggers during a split.** Which version runs `scheduled`
   during a split deployment, and does `versions create --prebuilt` apply
   triggers? (R25) Check: a 50/50 split logging the version id in
   `scheduled`; compare triggers before and after.
3. **Patching the dispatch binding.** Does a `dispatch_namespace` binding
   with `outbound`, patched into Build Output v0, validate and deploy? (R26)
   Check: `cf-dry-run` with the hosted profile.
4. **Token scopes.** Can D1 Edit be scoped to one database? Does creating
   WfP scripts need product-level Workers Admin? (R27) Check: build both
   tokens and try.
5. **WfP secrets and builds without a login.** Is a WfP secret PUT live at
   once, and does it survive the next upload? Do `cf build` and
   `cf workers types` run without a login? (R28) Check: as in R28.
6. **WfP cost on a second account.** Is WfP $25 per account, and does it add
   to Workers Paid? (R18) Check: the staging account's invoice.
7. **Gate thresholds.** The 10% → 50% → 100% steps, the 10-minute dwell and
   the 5xx-rate comparison are tuning, not sourced. Check: the first three
   production releases, compared against Workers analytics by version.
8. **Durable Object cost in self-host.** An unused DO namespace in self-host
   costs nothing. Check: the self-host account's bill after adding the
   classes.
9. **Staging domain cost and names.** Check: a registrar quote.
10. **Session exchange and revocation.** Better Auth can sign out the
    device-flow session right after the PAT exchange, and PATs can be
    revoked when the membership ends. Check: a unit test against
    `UserPatService` and the plugin.
11. **Cloudflare OIDC for GitHub Actions.** No source found either way, so
    the design uses long-lived account-owned tokens stored as GitHub
    environment secrets. Check: Cloudflare's API token docs or a support
    ticket.
