# Hosted deploy pipeline: deploying app Workers into Workers for Platforms

Researcher: deploy-pipeline reader. Date: 2026-10-15. Worktree commit `e1d9d3c6`.
Scope: how an org app (and a catalog app) gets from a developer's laptop or our CI
into a Workers for Platforms (WfP) dispatch namespace, with the gateway doing every
Cloudflare call. Routing, billing, the broker and cloud builds are other researchers'
subjects; this report names the handoff points to them.

Line numbers are as of `e1d9d3c6`. PR #257 refs are `claude/deploy-for-users:<path>:<line>`
(branch head `5ba8049d`, 2026-07-23, still OPEN, based on `313c8f09` from 2026-03).

---

## 0. The answer in one screen

```
 everyapp deploy  (CLI, hosted)                      gateway (one Worker, ours)                    Cloudflare
 ───────────────────────────────                     ─────────────────────────                     ──────────
 1 validate manifest (perimeter)  ──POST /deploys──▶ 2 authz (org session | app deploy key)
                                                       registry rules → workerName, hostname
                                  ◀── deployId, hosted deploy inputs (org-agnostic)
 3 cf build  (target:"hosted")
   local policy pre-check
 4 package Build Output + migrations + assets.json
                                  ──PUT artifact───▶  5 stage in R2, authoritative policy check
                                                        assets-upload-session ───────────────────▶ jwt + buckets
                                  ◀── jwt, buckets
 6 upload missing asset files DIRECTLY to /workers/assets/upload (Bearer = session JWT) ─────────▶ completion jwt
                                  ──POST start {completionJwt}─▶ 7 AppDeployer DO (one per app):
                                                        a provision D1/KV (REST, ledger first)   ─▶ /d1/database, /storage/kv/namespaces
                                                        b bookmark + migrations (REST)          ─▶ /time_travel/bookmark, /query
                                                        c build metadata FROM REGISTRY          
                                                        d PUT script to namespace               ─▶ /workers/dispatch/namespaces/{ns}/scripts/{name}
                                                        e apps row: status active, tier dispatch
                                  ◀── SSE progress, live URL      (no gateway redeploy, no bind step)
```

Key positions this report takes:

1. **The gateway generates the bindings; the build does not carry them.** Self-host trusts
   the build to carry D1/KV ids and the gateway binding, then polices it
   (`packages/cli/src/lib/app/policy.ts:80-184`). Hosted inverts that: the CLI builds an
   org-agnostic bundle, and the gateway writes the upload metadata from its own registry.
   This is what makes catalog bundles "build once, instantiate per org" possible, and it
   shrinks the trust surface of the build to "modules + exports + assets config".
2. **PR #257's REST transport is worth extracting (~35-40% of `packages/deployer`); its
   engine is not.** The engine targets wrangler output, plain account scripts, workers.dev,
   routes and DO migration-tag diffing, none of which exist in a WfP + cf-Build-Output world.
3. **Four Cloudflare facts decide the design and are not yet verified**: the gateway service
   binding with `props` on a WfP user Worker; Workflows in WfP (the docs contradict each
   other); crons on user Workers; the 1,000-KV-namespace account cap (verified, and it bites).
   Run the live checks (gap 0) before writing the pipeline.

---

## 1. What exists today

### 1.1 The self-host pipeline, step by step (`everyapp app deploy`)

`packages/cli/src/commands/app/deploy/deployApp.ts` (header comment `:1-27`), in order:

| # | Step | Where | Hosted fate |
|---|---|---|---|
| 1 | Load manifest; refuse secret names that collide with bindings | `deployApp.ts:159-177`, `lib/app/secrets.ts:8-29` | **Share** (pure) |
| 2 | Require `cloudflare.config.ts` built from `everyAppWorker()` | `deployApp.ts:178-189`, `lib/app/cloudflareConfig.ts:25-34` | Share |
| 3 | `whoami` over the deploy API, `cf` login, account match, find gateway D1 | `deployApp.ts:191-196, 510-568` | **Replace** with hosted session/deploy key |
| 4 | SDK/CLI min-version gates | `deployApp.ts:198-204, 548-567` | Share (same `minSdk`/`minCli` idea) |
| 5 | Register: gateway assigns Worker, resource and host names | `deployApp.ts:206-235`; rules in `AppRegistrationService.ts:337-460`; naming in `packages/perimeter/src/manifest/manifest.ts:379-427` | **Share** via `@every-app/perimeter/registry` (ADR-0003 §2) |
| 6 | Domain preflight for a new hostname | `deployApp.ts:241-271` | Drop (wildcard host under our zone) |
| 7 | Per-app deploy lease in gateway D1, CLI heartbeat | `deployApp.ts:274-287`; `lib/gateway/lease.ts` | Replace with a Durable Object per app |
| 8 | Refuse dropped DO classes / Workflows without `--allow-delete-*` | `deployApp.ts:290-300, 579-634` | **Share** (pure over previous vs new manifest) |
| 9 | Claim the Worker name; find-or-create D1/KV under the ownership ledger | `lib/app/resources.ts:65-235`, `lib/app/ownership.ts:19-153` | **Port** logic; transport becomes REST |
| 10 | Install deps | `deployApp.ts:326-331` | Stays on the builder (CLI/CI) |
| 11 | Fetch identity public keys from the gateway | `deployApp.ts:333` | Gateway injects them itself |
| 12 | Write `.everyapp/deploy.json`, run `cf build` (or `manifest.build`) | `lib/app/buildApp.ts:30-65`, `lib/app/deployInputs.ts:23-43`, SDK `cloudflare/deployInputs.ts:14-88` | **Share**, with a `target: "hosted"` flavour |
| 13 | `everyAppWorker()` turns manifest + deploy inputs into bindings/exports | `packages/sdk/src/cloudflare/worker.ts:265-451` | Share for exports/modules; bindings move to the gateway |
| 14 | Policy check of the built `worker.config.json`, add sourcemaps, validate with `OutputWorkerSchema` | `lib/app/policy.ts:252-298`, `lib/gateway/patchBuildOutput.ts:173-198` | **Move to perimeter** and run in both places |
| 15 | Refuse a Workflow name another Worker holds | `lib/app/workflows.ts:45-63` | Mostly moot (namespace is ours) |
| 16 | `assertReplaceable` (cf strict mode / dashboard edits) | `lib/cf/deploy.ts:182-215` | Drop (only the gateway uploads) |
| 17 | Migrate D1: bookmark → drizzle backfill → `cf d1 migrations apply` | `deployApp.ts:636-694`, `lib/migrations/remote.ts:120-167`, `lib/cf/d1.ts:129-162` | **Port** to REST; drop the drizzle backfill |
| 18 | `cf deploy --prebuilt` with `--secrets-file` (GATEWAY_URL, EVERY_APP_ORG_ID, app secrets); record the version at once | `deployApp.ts:383-413`, `lib/cf/deploy.ts:75-171`, `ownership.ts:86-98` | **Replace** with `PUT .../dispatch/namespaces/{ns}/scripts/{name}` |
| 19 | Delete dropped Workflows | `deployApp.ts:416-427` | Port if WfP supports Workflows |
| 20 | `markDeployed` (`pending` → `binding`) | `deployApp.ts:428-430` | Gateway writes the row itself |
| 21 | Rebind: redeploy the whole gateway with `APP__<worker>` service bindings rebuilt from the registry | `deployApp.ts:437-447, 701-753`; `lib/gateway/reconcile.ts:85-188`; `patchBuildOutput.ts:108-110`; `desiredState.ts:23-29` | **Gone**: `DISPATCHER.get(name)` is dynamic |
| 22 | Activate, retrying `BINDING_NOT_READY` for 90 s | `deployApp.ts:756-784`; probe `server/deploy-api.ts:63-79` | Gone (first WfP upload is synchronous) |
| 23 | Tools sync; certificate wait | `deployApp.ts:453-493` | Tools: first-use sync (cli-redesign.md:98-103); certs: wildcard |

What `everyAppWorker()` emits in production (`worker.ts:298-451`), i.e. the binding contract
the hosted metadata must reproduce:

- text `EVERYAPP_APP_ID`, `version-metadata` `CF_VERSION_METADATA` (`:298-301`);
- text `EVERYAPP_IDENTITY_PUBLIC_KEYS` (JSON array) and `EVERYAPP_IDENTITY_ISSUER` (`:303-310`);
- service binding `EVERY_APP_GATEWAY` → Worker `every-app-gateway`, entrypoint `AppGateway`,
  `props: {organizationId, appId, workerName}` (`:311-320`); the gateway trusts these props
  and cross-checks them against the registry (`apps/every-app-gateway/src/server/app-gateway-entrypoint.ts:72-113`,
  `server.ts:152-163`); the SDK reads the binding at `packages/sdk/src/server/gatewayFetch.ts:32`;
- secrets `GATEWAY_URL`, `EVERY_APP_ORG_ID`, sent through `--secrets-file` (`:321-323`);
- D1 `{name, id}` and KV `{id}` from deploy inputs (`:330-352`);
- DO bindings to its own classes + `exports` `{type:"durable-object", storage:"sqlite"}` (`:362-372`);
- Workflow binding + export named `<worker>--<binding>` (`:376-395`, `workflowNameFor` `:459-461`);
- DO tombstones `state: "deleted"` for classes dropped with the flag (`:396-403`);
- `triggers: scheduled` from `crons` (`:425-432`);
- `compatibilityFlags: ["nodejs_compat"]`, `workersDev:false`, `previewUrls:false`, observability (`:434-450`).

### 1.2 State the self-host pipeline keeps

- Ownership ledger `_everyapp_app_resources` (worker_name, kind, binding, name, resource_id,
  version_id), created ad hoc by the CLI, unique on `(kind, resource_id)` and `(kind, name)`
  (`ownership.ts:19-40`). Claim-before-create so a retry finds an orphaned create
  (`resources.ts:185-193, 209-234`).
- Registry `apps` row incl. `tier TEXT NOT NULL DEFAULT 'service_binding'`, "'dispatch'
  reserved for the hosted tier" (`apps/every-app-gateway/src/db/apps.schema.ts:40-41`;
  read in `packages/perimeter/src/registry.ts:63-77`).
- Lease table (TTL + heartbeat), install row. cli-redesign.md:180-196.

### 1.3 The seams the hosted tier was designed to plug into

- `getAppFetcher()`: the only place that knows how an app is invoked; the `dispatch` tier
  throws "deferred" today (`packages/perimeter/src/getAppFetcher.ts:38-56`), called from the
  perimeter at `packages/perimeter/src/gateway.ts:396`.
- `GATEWAY_DEPLOYMENT_MODE: "self_hosted" | "hosted"` (`apps/every-app-gateway/src/env.d.ts:18`);
  the current deploy-token API answers 404 in `hosted` (`server/deploy-token-auth.ts:55-67`).
- The sketched hosted deploy (`docs/architecture-v2-overview.md:359-392`): CLI uploads a
  bundle to the gateway deploy API, the gateway (holding the CF token) provisions per-tenant
  D1/KV, PUTs the script into the namespace with tags, "first upload is SYNCHRONOUS → 200 =
  live", no binding step.
- cli-redesign.md:132-135: "Hosted tier ... needs an HTTP deploy API with its own auth ...
  The rules in perimeter are what such an API would call; the API is new code either way."
  ADR-0003 §5 (`adr/ADR-0003-self-host-authority.md:41-43`): "a browser login to the gateway
  issuing an org-scoped session, and per-app CI credentials".

### 1.4 What PR #257 built, and what survives

`packages/deployer` (2,868 src lines) + `apps/deployer` (OAuth bootstrap Worker that deploys a
*gateway* into a *customer's* account, 1,033 src lines). Judged file by file for a deploy
service running inside our gateway against our own account and a dispatch namespace:

| File | Lines | Verdict | Why |
|---|---|---|---|
| `api/client.ts` | 168 | **Reuse as is** | fetch-only, Worker-safe; 429 `Retry-After` + exponential backoff (`:92-100`), 401 refresh hook, envelope parsing, per-call `authorizationToken` override (`:16-18, 60-61`) used for the assets JWT |
| `api/errors.ts` | 62 | Reuse | `CloudflareApiError` with `code`; known-error table |
| `auth/tokens.ts` `apiTokenSource` | ~5 | Reuse | The gateway uses a static account token. OAuth/PKCE (`auth/oauth.ts`, 219) is irrelevant to hosted |
| `api/assets.ts` | 161 | **Adapt** | Session + bucket upload protocol is right (`:39-74`; uploads authenticate with the session JWT, `:65-71`). Needs the dispatch-namespace session path and a split so the CLI, not the gateway, uploads bytes |
| `api/scripts.ts` | 173 | Adapt | Multipart PUT (`:38-69`) and secrets (`:131-171`) target `/workers/scripts/{name}`; add `/workers/dispatch/namespaces/{ns}/scripts/{name}` variants, tags, settings PATCH, bulk delete by tag |
| `api/resources.ts` | 219 | Adapt (create/delete only) | `ensureD1Database`/`ensureKvNamespace` (`:152-207`) adopt any same-named resource and list with `per_page=1000` without paging; both contradict the ownership-ledger rule (`resources.ts:139-235`) and break past 1,000 databases. Keep create/delete |
| `api/d1sql.ts` | 204 | Adapt (~half) | `queryD1` (`:33-49`) has no batch/params-array; `runWranglerD1Migrations` (`:56-103`) uses cf's exact `d1_migrations` DDL and "file + INSERT in one request", which matches self-host bookkeeping (`lib/migrations/remote.ts:29-33`). `runDrizzleD1Migrations` (`:122-172`) is obsolete: the repo moved to cf's table and is deleting the drizzle carry-over (cli-redesign.md:660-662). No bookmarks |
| `bundle/serialize.ts` | 145 | Reuse for catalog | R2-friendly manifest + independent blobs, no base64 (`:26-67`); `listSerializedBundleBlobKeys` for integrity |
| `bundle/types.ts` | 106 | Replace | Wrangler-shaped `ParsedWorkerConfig`; the repo now emits cf Build Output (`OutputWorkerSchema`) |
| `engine/metadata.ts` | 181 | **Rewrite** | Wrangler config → metadata (`:31-164`); hosted needs Build Output + registry → metadata, and DO lifecycle now travels as declarative `exports` |
| `engine/migrations.ts` | 50 | Drop | DO migration-tag diffing; superseded by `exports` + server-side `exports_reconciliation` (Cloudflare OpenAPI, dispatch upload metadata) |
| `engine/deploy.ts` | 291 | Drop | Two-pass upload for cross-script service bindings, workers.dev subdomain, routes, account scripts (`:46-266`). None apply to WfP |
| `api/domains.ts`, `api/accounts.ts` | 249 | Drop | Routes/custom domains/workers.dev: hosted uses one wildcard host on the gateway |
| `node/index.ts` | 248 | Drop | Loads `wrangler deploy --dry-run` output; cf Build Output is read with `@cloudflare/build-output-utils` `readBuildOutput()` (installed at 0.9.0 under `packages/cli/node_modules/.pnpm`) |
| `apps/deployer/scripts/publish-bundle.ts`, `src/manifest.ts` | 365 | **Pattern reuse** for the catalog | Build in CI → serialize → R2 objects + `manifest.json` index (`publish-bundle.ts:53-91`); load + verify blob index in a Worker (`manifest.ts:62-99`) |
| `apps/deployer` OAuth/SSE/crypto | ~650 | Not for hosted | Self-host bootstrap. Its SSE helper is a fine model for deploy progress |

Net: roughly 1,000-1,100 lines worth extracting into a Worker-safe `packages/cf-rest`; the
rest is either wrangler-era or self-host bootstrap. PR #257 also names its ADR
`ADR-0003-oauth-bootstrap-and-rest-deployer.md`, colliding with today's ADR-0003; anything
extracted needs a new number.

---

## 2. What the hosted tier needs

### 2.1 Facts about Cloudflare the design rests on (checked 2026-10-15)

- Dispatch-namespace script API exists for upload, settings, secrets (single + bulk PATCH),
  tags, bindings read, content, assets upload session, and **bulk delete by tags**; there is
  no `/versions`, `/deployments` or `/schedules` under dispatch namespaces (Cloudflare OpenAPI,
  `paths` under `/accounts/{account_id}/workers/dispatch/namespaces/...`, queried via the
  Cloudflare API MCP).
- Dispatch upload metadata keys: `assets, bindings, compatibility_date, compatibility_flags,
  exports, keep_assets, keep_bindings, limits{cpu_ms,subrequests}, logpush, main_module,
  migrations, observability, placement, tags, tail_consumers, usage_model` (same source).
  Binding types include `d1`, `kv_namespace`, `durable_object_namespace`, `service`
  (`service`, `entrypoint`, `environment`; **no `props` in the schema**), `workflow`,
  `assets`, `plain_text`, `json`, `secret_text`, `version_metadata`, `r2_bucket`, `inherit`.
- `exports` is declarative and drives DO namespace reconciliation (`created`, `deleted`,
  `renamed`, `transferred`, `expecting-transfer`); the response carries
  `exports_reconciliation` (same source). This is the same `exports` shape cf's Build Output
  carries and `policy.ts:193-244` already checks.
- Gradual deployments are not supported for user Workers: every upload goes to 100% at once.
  Max 8 tags per script. Unlimited scripts and DO namespaces. API: 1,200 requests / 5 min per
  token (https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/, updated 2026-10-13).
- Dynamic dispatch can pass `props` per request, including an RPC stub built with
  `ctx.exports.<Entrypoint>(...)` whose props the user Worker cannot read; "An RPC stub
  passed through dynamic dispatch props is valid only during the request that received it"
  (https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/).
- Static assets direct upload: the upload call is authenticated "as a bearer token, using the
  JWT (upload token)"; upload and completion JWTs are valid one hour; already-uploaded files
  are skipped "if they have recently been uploaded in previous versions of your Worker"
  (per Worker, not per account); dispatch-namespace variants exist
  (https://developers.cloudflare.com/workers/static-assets/direct-upload/, updated 2026-08-10).
- D1 REST: `POST /d1/database/{id}/query` takes `{sql, params}` or `{batch:[...]}`, and a
  `sql` with several `;`-joined statements runs as a batch; `GET .../time_travel/bookmark`,
  `POST .../time_travel/restore?bookmark=`; create takes `primary_location_hint`,
  `jurisdiction` (OpenAPI). So **bookmarks work over REST**; nothing about migrations needs `cf`.
- D1: 50,000 databases per account on Paid, raisable on request; 10 GB per DB; 30-day Time
  Travel (https://developers.cloudflare.com/d1/platform/limits/, updated 2026-04-21).
- KV: **1,000 namespaces per account** on Paid (https://developers.cloudflare.com/kv/platform/limits/, updated 2026-10-08).
- Workers Paid: 10,000 subrequests per invocation by default (up to 10M), 128 MB memory,
  request body 100 MB on Free/Pro zones (https://developers.cloudflare.com/workers/platform/limits/;
  changelog 2026-02-11).
- `cf deploy --dispatch-namespace <NAMESPACE>` exists (https://developers.cloudflare.com/cf/projects/,
  updated 2026-10-12): useful for our own CI and for the live checks, not inside a Worker.
- **Contradiction**: the WfP bindings page (updated 2026-09-16) lists Workflows among user
  Worker bindings; the Workflows limits page (updated 2026-09-21) says "Workflows cannot be
  deployed to Workers for Platforms namespaces"
  (https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/,
  https://developers.cloudflare.com/workflows/reference/limits/).

### 2.2 The hosted flow for an org app, step by step

Assumptions from the brief and ADR-0001: one gateway Worker in Every App's account,
`GATEWAY_DEPLOYMENT_MODE=hosted`, one dispatch namespace (say `everyapp-prod`), app hosts
`<appId>-<orgKey>.<base>` single-label under a wildcard (another researcher owns routing),
"hosted app workers are single-tenant ... scoped to one organization" (`adr/ADR-0001-hosted-vs-self-hosted-topology.md:34-36`).

**Step 1. CLI: validate locally (shared code).**
`validateManifestStrict` (`manifest.ts:303`), secret-name rules (`secrets.ts:12-29`),
dropped-DO/Workflow checks need the previous manifest, so they run in the gateway (step 2).

**Step 2. CLI → gateway: open a deploy.**
`POST /api/v1/orgs/{orgId}/apps/{appId}/deploys`
`{ manifest, cliVersion, sdkVersion, source: {kind:"cli", gitSha?, dirty?} }`.
Gateway: authenticate (§2.3), authorize (`owner|admin` member of `orgId`, or a deploy key
bound to this app), run the `@every-app/perimeter/registry` rules (ADR-0003 §2: reserved ids,
`registryWorkerNameFor` `manifest.ts:379-387`, `resourceNameFor` `:417-427`, hostname,
org-key claim, initial access), run `checkDurableObjects`/`checkWorkflows` against the stored
manifest (`deployApp.ts:579-634` logic, made pure), insert a `deploys` row
(`created`), and answer
`{ deployId, workerName, hostname, deployInputs: {schema:2, target:"hosted", workerName, gatewayUrl, identityIssuer} }`.
No org id and no resource ids go to the builder (see 2.4).

**Step 3. CLI: build.** Same as today (`buildApp.ts:30-65`): write `.everyapp/deploy.json`,
`cf build` (or `manifest.build`), with `VITE_GATEWAY_URL`/`VITE_APP_ID` (`deployApp.ts:349-354`;
both org-agnostic in hosted: one gateway URL, the manifest id). Then the policy check, moved
to perimeter, as a fast local failure (authoritative copy runs in step 5).

**Step 4. CLI: package and upload the artifact.**
Read `.cloudflare/output/v0` with `readBuildOutput()` (`@cloudflare/build-output-utils`;
per Worker: `config`, `bundleDir`, `assetsDir`). Send
`PUT /api/v1/deploys/{id}/artifact` as one tar (or multipart) holding:
`worker.config.json`, `bundle/**` (incl. sourcemaps listed as modules, `policy.ts:287-294`),
`migrations/**` (the manifest's `migrations.dir`, default `drizzle`, flat `<tag>.sql` or nested
`<tag>/migration.sql`, `remote.ts:169-187`) and `assets.json` = `{"/path": {hash, size}}`.
**No asset bytes.** OpenSEO's whole `dist/` is 26 MB today, under the 100 MB body cap, but the
gateway should stream the tar into R2 rather than buffer it (128 MB memory).

**Step 5. Gateway: stage + check + open the assets session.**
Store under R2 `deploys/{deployId}/`. Parse `worker.config.json` with `OutputWorkerSchema`
(`patchBuildOutput.ts:173-198`), run the hosted policy (2.4), compute the modules list. Call
`POST /accounts/{acct}/workers/dispatch/namespaces/{ns}/scripts/{workerName}/assets-upload-session {manifest}`
and return `{jwt, buckets}` to the CLI.

**Step 6. CLI: upload asset bytes straight to Cloudflare.**
For each bucket, `POST https://api.cloudflare.com/client/v4/accounts/{acct}/workers/assets/upload?base64=true`
with `Authorization: Bearer <session jwt>` (the pattern at
`claude/deploy-for-users:packages/deployer/src/api/assets.ts:50-74`). The account token never
leaves the gateway; the session JWT is single-purpose and expires in an hour. Then
`POST /api/v1/deploys/{id}/start {assetsCompletionJwt, secrets?}`. (Fallback if handing the
JWT out fails a live check: the CLI includes asset files in the artifact and the gateway
uploads from R2, as it must for catalog installs anyway.)

**Step 7. Gateway: run the deploy job** in an `AppDeployer` Durable Object keyed
`{orgId}:{appId}` (serializes deploys of one app, which replaces the D1 lease and its
heartbeat hazards in cli-redesign.md:756-766; keeps step state so a CLI that disconnects
does not abort the deploy; the CLI follows `GET /api/v1/deploys/{id}/events` as SSE mapped
onto today's `app.resources` / `app.migrations` / `app.upload` steps).

- **7a. Provision per-app D1/KV via REST.** Claim in the ledger, then
  `POST /accounts/{acct}/d1/database {name: "every-<orgKey>-<appId>[--<binding>]"}` and
  `POST /accounts/{acct}/storage/kv/namespaces {title}`; record the id. The ledger logic of
  `provisionOne` (`resources.ts:139-235`) ports almost unchanged once its `find`/`create`
  are REST calls; "taken by a stranger" cannot happen in our own account except through our
  own crashed create, which the null-`resource_id` claim already handles (`:185-193`).
  Never list all databases to find one (`d1sql`/`resources` in PR #257 do; it breaks at
  1,000+). Optional: `primary_location_hint`/`jurisdiction` per org later.
- **7b. Migrate D1 via REST, before the upload.** Same order as self-host: everything that
  can stop the upload (policy, metadata build, assets completion) is done first, then the DB
  changes (`deployApp.ts:364-375`).
  1. `GET .../d1/database/{id}/time_travel/bookmark` → store on the `deploys` row.
  2. `POST .../query {sql: CREATE TABLE IF NOT EXISTS "d1_migrations"(...)}` with cf's exact
     DDL (`remote.ts:29-33`), then `SELECT name FROM d1_migrations`.
  3. For each pending file in name order: `POST .../query {sql: "<file>;\nINSERT INTO d1_migrations (name) VALUES ('<name>')"}`,
     fail on any `success:false` (cf's own rule, `d1.ts:155-160`). Names exactly as cf names
     them (`<tag>.sql` / `<tag>/migration.sql`, `remote.ts:140`), so a database could move
     between self-host and hosted without re-running anything.
  4. On failure: deploy row `failed`, bookmark kept; a later `everyapp db restore <deployId>`
     calls `POST .../time_travel/restore?bookmark=`.
  The drizzle `__drizzle_migrations` backfill (`remote.ts:48-99`) is not needed: hosted
  databases are born under cf's table, and self-host is deleting it (cli-redesign.md:660-662).
- **7c. Build the upload metadata from the registry, not from the build** (2.4 has the table).
- **7d. Upload.** `PUT /accounts/{acct}/workers/dispatch/namespaces/{ns}/scripts/{workerName}`
  multipart: `metadata` + one part per module with cf's module types mapped to content types
  (`claude/deploy-for-users:packages/deployer/src/api/scripts.ts:12-19, 38-69`). Record the
  returned version/etag on the ledger row at once (the self-host rule, `ownership.ts:81-98`).
  First uploads are synchronous (architecture-v2-overview.md:380; Cloudflare changelog per
  the web search), so 200 means it serves.
- **7e. Post-upload.** Delete Workflows the app dropped (if Workflows exist in WfP). Register
  cron schedules (2.5). Update `apps`: `tier='dispatch'`, `status='active'`, `version_id`,
  `manifest`, `deployed_by_actor`, `deployed_at`. There is no `binding` state and no gateway
  redeploy: `getAppFetcher` gains a `dispatch` branch that calls
  `env.DISPATCHER.get(workerName, {props}, {limits, outbound})`. Tools sync on first use
  (cli-redesign.md:98-103).
- **7f.** Answer the CLI with `https://<hostname>`; nothing to wait for (wildcard
  certificate, no Custom Domain).

### 2.3 What the CLI sends and how it authenticates (ADR-0003 §5)

**People: browser login, org-scoped session.**
`everyapp login --gateway https://everyapp.com` runs a device-authorization flow (RFC 8628
style: CLI shows a code, opens `https://everyapp.com/device`, user signs in with their normal
Better Auth session and picks the organization). Better Auth 1.7.7 is the gateway's version
(`apps/every-app-gateway/package.json:45`) and it ships a `device-authorization` plugin
(present in `apps/every-app-gateway/node_modules/better-auth/dist/plugins/`). The resulting
token is org-scoped (`{userId, organizationId, scopes:["deploy","apps:read"]}`), hashed at rest,
30-day sliding TTL, revocable from the org's admin UI, and revoked when the membership ends,
which is exactly what ADR-0003 says self-host cannot do (`ADR-0003...:73-77`). Stored by the
CLI in the OS keychain or `~/.config/everyapp/hosted.json` (0600). This is the "one-hour
bearer row" design cli-redesign.md rejected for self-host and kept "because it is the right
shape for a hosted API someday" (`docs/cli-redesign.md:803-809`), with a real login behind it.

**CI: per-app deploy keys.** Reuse the user-PAT machinery rather than resurrecting `eak_`:
`UserPatService` already models `{userId, organizationId, appRowId, scopes, expiresAt}`,
hashed, prefix-identified, 90-day default TTL (`apps/every-app-gateway/src/server/services/UserPatService.ts:7-21`).
A deploy key = PAT with `appRowId` set and scope `deploy`, created by an org admin in
"Apps → <app> → Deploy keys", passed as `EVERYAPP_TOKEN`. Authorization rule:
`token.organizationId == app.organizationId && token.appRowId == app.id && "deploy" ∈ scopes`.
A key can deploy one app and nothing else, and cannot read data.

**The wire protocol** (all JSON unless noted, `Authorization: Bearer <session|key>`):

| Call | Body | Answer |
|---|---|---|
| `POST /api/v1/orgs/{org}/apps/{app}/deploys` | manifest, cliVersion, sdkVersion, source | deployId, workerName, hostname, deployInputs (hosted) |
| `PUT /api/v1/deploys/{id}/artifact` | tar: `worker.config.json`, `bundle/**`, `migrations/**`, `assets.json` | `{assets:{jwt,buckets}}` or `{assets:null}` |
| (direct to Cloudflare) `POST /client/v4/accounts/{acct}/workers/assets/upload?base64=true` | bucket files, Bearer = session JWT | completion JWT |
| `POST /api/v1/deploys/{id}/start` | `{assetsCompletionJwt, secrets?}` | 202 |
| `GET /api/v1/deploys/{id}/events` | | SSE: step events, then `done {url, versionId}` or `error` |
| `PUT /api/v1/orgs/{org}/apps/{app}/secrets/{name}` | `{value}` | 204, via WfP secrets API, **no redeploy** |
| `DELETE /api/v1/orgs/{org}/apps/{app}?purge=1` | | script delete + ledger-driven D1/KV delete |

The existing `GatewayClient` (`packages/cli/src/lib/gateway/api.ts`) is being deleted for
self-host (cli-redesign.md:627-632). The hosted client is new but small; the CLI's
`deployApp()` gets a hosted branch after "load manifest" that skips `cf` login entirely.

### 2.4 Build vs. registry: who decides each part of the metadata

The hosted `everyAppWorker()` output (with `target: "hosted"`) should contain only what the
gateway cannot know: modules, entrypoint, export classes, assets runtime config, crons, and
compatibility settings. Everything that names a resource or a tenant comes from the gateway.

| Metadata field | Source in hosted | Self-host today |
|---|---|---|
| `main_module` + module parts | Build Output `manifest` + `bundle/` | same, uploaded by cf |
| `compatibility_date`, `compatibility_flags` | Build, checked against an allow-list (OpenSEO uses `global_fetch_strictly_public`, `open-seo/wrangler.jsonc:6`) | build |
| `bindings[d1]` `{name: binding, id}` | **Registry ledger** | build (deploy.json ids), policed `policy.ts:145-154` |
| `bindings[kv_namespace]` `{name, namespace_id}` | **Registry ledger** | build |
| `bindings[durable_object_namespace]` `{name, class_name}` (own script) | Manifest `resources.durableObjects` | build, policed `policy.ts:138-144` |
| `exports` (DO created / deleted tombstones) | Build `exports`, policed by `exportProblems` (`policy.ts:193-244`) against the gateway's own dropped-class list | build |
| `bindings[workflow]` | Manifest `resources.workflows`, named by `workflowNameFor` (`worker.ts:459-461`) | build; cf creates the Workflow |
| `bindings[plain_text]` `EVERYAPP_APP_ID`, `EVERYAPP_IDENTITY_PUBLIC_KEYS`, `EVERYAPP_IDENTITY_ISSUER`, `GATEWAY_URL`, `EVERY_APP_ORG_ID` | **Gateway** (the last two stop being secrets: they are not secret and the gateway sets them) | build + `--secrets-file` |
| `bindings[version_metadata]` | Gateway (fixed) | build |
| `bindings[service]` `EVERY_APP_GATEWAY` → `every-app-gateway`/`AppGateway` with props `{organizationId, appId, workerName}` | **Gateway** (if the live check passes; see 2.6) | build, policed `policy.ts:127-137` |
| `bindings[secret_text]` app secrets | `keep_bindings: ["secret_text"]` on every upload; values only via the secrets API | `--secrets-file` on `secret set` redeploys |
| `bindings[assets]` + `assets {jwt, config}` | completion JWT + build `assets` config (`htmlHandling`, `notFoundHandling`, `runWorkerFirst`) | cf |
| `tags` | Gateway: `org_<orgId>`, `app_<appId>`, `src_org` or `src_catalog`, `rel_<slug>_<ver>` (≤ 8; no `:` because the delete-by-tag filter uses `tag:yes` pairs, no `,`/`&` per the limits page) | none |
| `limits {cpu_ms, subrequests}` | Gateway, by org plan | none |
| `observability` | `EVERYAPP_OBSERVABILITY` (`worker.ts:226-243`) | build |
| `placement` | Build, allow `smart` only | build |
| triggers `scheduled` | Not uploadable (no dispatch `/schedules`); gateway scheduler (2.5) | build; cf publishes |
| `domains`, `fetch` routes, queue/email triggers, `workersDev`, `previewUrls` | Refused (same as `policy.ts:89-107`) | refused |

Consequence for the SDK: `EveryAppDeployInputs` (`packages/sdk/src/cloudflare/deployInputs.ts:14-33`)
gets `schema: 2` with `target: "self-host" | "hosted"`; in hosted, `everyAppWorker()` emits
D1/KV bindings without ids, no gateway binding, no identity values (the gateway fills them),
and refuses nothing else. Because `parseDeployInputs` is shared by the CLI and the SDK
(`lib/app/deployInputs.ts:22-31`), both sides stay in lockstep.

### 2.5 Crons, Workflows and the gateway binding in WfP

- **Crons.** No dispatch-namespace schedules endpoint exists in the OpenAPI, and the WfP docs
  say nothing either way. Recommended: the gateway records each app's schedules from the
  build's `triggers` into an `app_schedules` table, runs one `* * * * *` cron of its own, and
  invokes due apps through the dispatcher on an internal path (`/__everyapp/scheduled`,
  next to the existing `/__everyapp/health` and `/__everyapp/tools/*`, `deploy-api.ts:73`,
  `packages/sdk/src/server/everyApp.ts:13`) that the SDK's `everyApp()` routes to the app's
  `scheduled` handler. Self-host keeps native crons. This also gives the gateway a metering
  point for cron CPU, which the founder wants at the gateway.
- **Workflows.** If WfP rejects Workflows, the hosted policy refuses `resources.workflows`
  until it is supported, and apps that need durable background work use a DO alarm-based
  runner. OpenSEO needs Workflows (rank-check, site-audit; `open-seo/wrangler.jsonc:22-37`),
  so this decides whether OpenSEO can be a hosted app in phase 1.
- **The gateway binding.** Two designs, in order of preference:
  1. Service binding with `props` in the upload metadata, as self-host does today. Covers
     every invocation type (fetch, cron, DO, Workflow). Trust holds because only the gateway
     uploads, and props "can only be set by someone who has permission to edit and deploy
     the worker" (Cloudflare `ctx` docs, quoted in the web search). Unverified for WfP: the
     dispatch upload schema lists `service` without `props`, and no page says user Workers
     may bind a Worker outside their namespace.
  2. Fallback: the dispatcher passes an `AppGateway` RPC stub per request
     (`env.DISPATCHER.get(name, {props: {gateway: ctx.exports.AppGateway({props: {...}})}})`),
     which is documented. It is request-scoped, so crons, DO alarms and Workflows get no
     gateway. Then `createGatewayFetch` (`gatewayFetch.ts:28-45`) must read `ctx.props.gateway`
     before `env.EVERY_APP_GATEWAY`, and background work has to reach the gateway another way
     (the cron path above passes a fresh stub on each tick, which covers crons).

### 2.6 Catalog apps (OpenSEO, todo, chef) per org

Same pipeline; different builder and artifact source.

1. **Build once in CI** (this repo's GitHub Actions; OpenSEO's in its repo) with hosted
   deploy inputs. Because the bundle carries no org id and no resource ids (2.4), one build
   serves every org. Produce the same artifact as step 4 *including asset files*, plus a
   SHA-256 of the whole.
2. **Publish** to R2 `catalog/{slug}/{version}/` with the `serializeBundle` layout or a tar
   and an index (the `apps/deployer` pattern: `publish-bundle.ts:53-91`, verify on load
   `src/manifest.ts:62-99`), and a `catalog_releases` row `{slug, version, sha256,
   manifest, migrations list, r2Key, minGatewayVersion, publishedAt}` via a platform-admin
   credential.
3. **Install into org X** = `POST /api/v1/orgs/{org}/catalog/{slug}/install` → the same
   `AppDeployer` job with `source = catalogRelease`. Differences from an org app: the gateway
   uploads assets itself from R2 (dedup is per Worker, so each org's first install uploads
   all of them; later upgrades with unchanged files upload nothing); the policy check ran at
   publish time and is re-checked against the stored hash only; tags `src_catalog`,
   `rel_<slug>_<ver>`; resources named exactly like org apps (`every-<orgKey>-<slug>`).
4. **Upgrade** = a fan-out job (Cloudflare Queue, or a gateway Workflow) over every org with
   the app installed: per org, migrations then upload, as in 7b-7d. Budget: one install is
   ~10-15 API calls; the token allows 1,200 per 5 min, so ~80-120 org upgrades per 5 min per
   token before 429s (the reused client already honours `Retry-After`,
   `claude/deploy-for-users:packages/deployer/src/api/client.ts:92-100`). Migrations must be
   expand-only within a major so old code keeps working mid-fan-out; the expand-only test
   already exists for the gateway (cli-redesign.md:781-783).
5. **Uninstall/org delete**: `DELETE .../dispatch/namespaces/{ns}/scripts?tags=org_<id>:yes`
   (bulk delete by tag, OpenAPI) + ledger-driven D1/KV deletes.

Catalog specifics found in the code:
- todo, chef, workout-tracker and the template all declare `kv: ["KV"]`
  (`apps/*/everyapp.config.ts`), but none of their `src/` reads `env.KV` (grep, no hits).
  With a 1,000-namespace account cap, per-org KV for three catalog apps caps us at ~333
  orgs. Drop KV from those manifests before the first hosted org.
- OpenSEO is not an Every App app yet and is the hardest case: two Workers (`open-seo` +
  `open-seo-audit`), a cross-script Workflow binding (`script_name: "open-seo-audit"`,
  `wrangler.jsonc:32`), a service binding between them (`:58-63`), a DO (`:45-52`), two crons
  (`:95-99`), two KV namespaces (`:109-118`), D1 (`:119-126`), R2 (`:143-148`) and Smart
  Placement (`:19-21`). The manifest models one Worker per app and the policy forbids every
  cross-Worker binding except the gateway (`policy.ts:127-176`). A multi-Worker app is a
  manifest extension (`workers: [{name, entrypoint}]`, bindings allowed only between Workers
  of the same app in the same namespace), not a pipeline rewrite.

### 2.7 Handoff to "build in the cloud" (another researcher)

The pipeline's input contract is the **artifact** of step 4 (Build Output + migrations +
assets manifest, or asset files for server-side builders). A cloud builder (GitHub repo →
container/Sandbox/Workers Builds) needs only the hosted deploy inputs from step 2, which
contain no secrets and no org ids, and hands the artifact to `PUT /deploys/{id}/artifact`.
Everything from step 5 on is identical for CLI, catalog CI and cloud builds. The one rule
for that researcher: the builder must not be able to choose bindings, which this design
already guarantees because the gateway writes them.

---

## 3. Gaps and the smallest change that closes each

Sizes are engineer-days for one person working with agents.

| # | Gap | Where | Smallest fix | Days |
|---|---|---|---|---|
| 0 | Four load-bearing WfP facts unverified (gateway service binding + props; Workflows; crons; assets JWT handed to another client) | Cloudflare | Live check in a test account: add a `--dispatch-namespace` passthrough to `cfDeploy` (`lib/cf/deploy.ts:138-147`; the flag exists in cf, docs 2026-10-12), deploy `todo` with its gateway binding into a namespace, dispatch to it from a scratch dispatcher, call `AppGateway`; add a Workflow and a cron; hand an assets session JWT to a second process | 1 |
| 1 | No Worker-safe Cloudflare transport | new `packages/cf-rest` | Extract `client.ts`, `errors.ts`, assets, scripts, D1/KV create/delete, D1 query from PR #257; add dispatch-namespace paths, `{batch}` + params, bookmark/restore, tags, secrets-bulk, delete-by-tag | 2 |
| 2 | No Build Output → upload-metadata translator; bindings come from the build | new `perimeter/deploy/metadata.ts` | Pure function `(OutputWorkerConfig, registryBindings, assets, plan) → metadata`, golden-file tests from todo/chef builds; replaces `engine/metadata.ts` | 2.5 |
| 3 | App policy only runs in the CLI | `packages/cli/src/lib/app/policy.ts:80-244` | Move `appPolicyProblems`/`exportProblems` into perimeter (they are pure over JSON); add a hosted profile (no ids/gateway binding expected in the build) | 1 |
| 4 | Migrations need `cf d1 migrations apply` | `lib/migrations/remote.ts`, `lib/cf/d1.ts:129-162` | `restD1Database()` implementing the existing transport-agnostic `D1Database` interface (`lib/cf/d1.ts:29-35`), a shared pure `pendingMigrations(files, applied)`, REST bookmark/restore | 1 |
| 5 | No hosted deploy API or credentials (`eak_` is being deleted; `requireDeployTokenAuth` 404s in hosted) | gateway `routes/api/v1/*`, `auth/config.ts` | Better Auth `device-authorization` plugin for the CLI session; deploy keys = `UserPatService` PATs with `appRowId` + `deploy` scope; six routes in 2.3 | 4 |
| 6 | Deploy orchestration lives in the CLI with a D1 lease | `deployApp.ts`, `lib/gateway/lease.ts` | `AppDeployer` DO per app (state machine + SSE), `deploys` table, R2 bucket for staged artifacts with a lifecycle rule | 2.5 |
| 7 | `getAppFetcher` has no dispatch tier | `packages/perimeter/src/getAppFetcher.ts:52-56` | `DISPATCHER` binding on the gateway; `dispatch` branch calling `get(workerName, {props}, {limits})` | 1 |
| 8 | Builds bake org and resource ids into the Worker | `packages/sdk/src/cloudflare/deployInputs.ts:14-33`, `worker.ts:302-352` | Deploy inputs schema 2 with `target: "hosted"`; `everyAppWorker()` emits id-less D1/KV and no gateway binding in hosted | 1 |
| 9 | App secrets ride `--secrets-file` and need a redeploy | `lib/cf/deploy.ts:137-145`, cli-redesign.md:740-745 | Hosted `secret set` → WfP secrets API; every upload sends `keep_bindings: ["secret_text"]` | 0.5 |
| 10 | Crons cannot be uploaded to user Workers (pending gap 0) | `worker.ts:425-432` | `app_schedules` table + one gateway cron that dispatches `/__everyapp/scheduled`; SDK routes it to `scheduled` | 1.5 |
| 11 | CLI has no hosted path | `packages/cli/src/commands/app/deploy/deployApp.ts` | Hosted branch: login token, open deploy, `cf build`, `readBuildOutput()` → tar, direct asset upload, follow SSE | 2.5 |
| 12 | No catalog artifact store or release registry | gateway + CI | `catalog_releases` table, R2 `catalog/`, CI job adapted from `apps/deployer/scripts/publish-bundle.ts`, install route reusing gap 6 | 2.5 |
| 13 | No fan-out upgrade of a catalog app across orgs | gateway | Queue consumer running the gap-6 job per org with 429 backoff; per-org pin/auto-upgrade flag | 1.5 |
| 14 | Per-org-per-app KV hits the 1,000-namespace cap | `apps/*/everyapp.config.ts`, hosted policy | Remove the unused `kv` from todo/chef/workout/template; hosted policy caps KV per app; ask Cloudflare for an increase before launch | 0.5 |
| 15 | Multi-Worker apps (OpenSEO) are not in the manifest model | `manifest.ts:150-224`, `policy.ts:127-176` | `workers: [...]` manifest extension; bindings allowed between Workers of one app; same pipeline uploads N scripts | 3.5 |
| 16 | Delete/purge assumes cf and the account ledger | `commands/app/delete` | Script delete (or delete-by-tag for an org) + ledger-driven D1/KV deletes over REST | 0.5 |

Total: ~29 days with OpenSEO's multi-Worker support (gap 15), ~25 without. Order: 0 first
(it can flip 2.5 and gap 10), then 1-4 and 8 in parallel (pure code, no gateway changes),
then 5-7 and 11 (the vertical slice: `everyapp deploy` of todo into a namespace), then
9-10, 12-14, 16, and 15 last.

---

## 4. Open questions only the founder can answer

1. **Does the Cloudflare API token live in the public gateway Worker, or in a private
   deployer Worker the gateway calls over RPC?**
   Why it matters: the token can create, read and delete every tenant's database and Worker.
   The public gateway parses untrusted traffic from every org's users; cli-redesign.md
   rejected "the Gateway as the deployer" for self-host partly for this blast radius
   (`docs/cli-redesign.md:810-816`), and architecture-v2-overview.md:370 puts the token in the
   gateway. Recommended default: same codebase, separate Worker (`every-app-deployer`, no
   routes, `workers_dev:false`) holding the token and the `AppDeployer` DO; the gateway
   reaches it through a service binding. Cost: about half a day more than gap 6.

2. **Who may deploy an org app: owners/admins only, or any member?**
   Why it matters: deployed code runs with the org's data and grants. Recommended default:
   owners and admins, plus per-app deploy keys an admin creates for CI.

3. **Per-org KV and D1 at scale.** Each org app gets its own D1 (50,000/account, raisable)
   and KV (1,000/account). Accept "drop KV from catalog apps now, request a limit increase,
   cap KV per app" or move per-org state to DO SQLite?
   Why it matters: three catalog apps with KV hit the cap at ~333 orgs.
   Recommended default: remove the unused KV declarations now; keep D1 per org-app; request
   both increases before opening sign-ups.

4. **Must hosted day one run OpenSEO (two Workers, Workflows, crons, R2), or start with
   single-Worker apps?** Why it matters: it adds gap 15 and depends on the Workflows answer
   from gap 0. Recommended default: phase 1 = single-Worker apps with D1/KV/DO/assets and
   gateway-driven crons; OpenSEO in phase 2.

5. **Catalog upgrades: automatic for every org, or pinned per org with opt-in?**
   Why it matters: no gradual deployments in WfP, so a bad release hits every org at once.
   Recommended default: automatic within a major version with a canary batch (our own org
   first, then 10%, then all), pinned across majors; migrations expand-only within a major.

6. **Is a fork of a catalog app a new app next to it, or a replacement that keeps its data?**
   Why it matters: replacement needs the fork to reuse the catalog instance's D1 and DO
   namespaces (same script name), which the naming scheme allows but the UX must explain.
   Recommended default: a fork is a new app id with fresh resources; data import is later.

7. **Do org plans set per-app CPU/subrequest limits?** Why it matters: the pipeline writes
   `limits` on every upload and the dispatcher can enforce per request.
   Recommended default: one platform-wide default (e.g. `cpu_ms: 30000`) in v1, plan-based
   later, recorded on the org row so it travels with each deploy.

---

## 5. Load-bearing claims (if wrong, the design changes)

1. A WfP user Worker can carry a `service` binding to `every-app-gateway`'s `AppGateway`
   entrypoint with `props`. **Unverified.** The dispatch upload schema lists `service`
   without `props`; no WfP page covers bindings outside the namespace. If false, the
   per-request RPC stub (documented) covers requests only, and crons/DOs/Workflows need
   another path to the broker (2.5).
2. Workflows run in WfP user Workers. **Contradicted** in Cloudflare's own docs (bindings page
   2026-09-16 yes; Workflows limits 2026-09-21 no). Decides app Workflows (`acad8b29`) and
   OpenSEO in hosted.
3. KV allows 1,000 namespaces per account (verified, 2026-10-08) and D1 50,000 (verified,
   2026-04-21). Drives the per-org resource model and the KV cleanup.
4. User Workers cannot have cron triggers through the API (no `/schedules` under dispatch
   namespaces in the OpenAPI; docs silent). Drives the gateway scheduler.
5. D1's REST `query` runs a multi-statement `sql` as one batch, so "migration file + its
   `d1_migrations` row" is all-or-nothing, as with `cf d1 migrations apply`. The OpenAPI says
   "executed as a batch"; atomicity on failure should be confirmed in the live check.
6. A Cloudflare assets upload-session JWT works from a client other than the one that
   created the session (it is a bearer JWT; the docs and PR #257 authenticate uploads with it
   alone). If false, asset bytes go through the gateway, as they must for catalog installs
   anyway.
7. The upload metadata's declarative `exports` (with DO tombstones) is accepted on dispatch
   uploads and matches cf's Build Output `exports`, so no migration-tag bookkeeping is
   needed (OpenAPI lists `exports` and `exports_reconciliation` for dispatch uploads).

---

## 6. Sources

Code (this worktree unless noted):
- `packages/cli/src/commands/app/deploy/deployApp.ts:1-806`
- `packages/cli/src/lib/app/{buildApp,cloudflareConfig,deployInputs,ownership,policy,resources,secrets,workflows}.ts`
- `packages/cli/src/lib/cf/{d1,deploy,plan,resources,workers,workflows}.ts`
- `packages/cli/src/lib/migrations/remote.ts:1-205`
- `packages/cli/src/lib/gateway/{apply,desiredState,patchBuildOutput,reconcile}.ts`
- `packages/sdk/src/cloudflare/{worker,deployInputs}.ts`; `packages/sdk/src/server/gatewayFetch.ts:28-45`
- `packages/perimeter/src/{getAppFetcher,registry,gateway}.ts`; `packages/perimeter/src/manifest/manifest.ts`
- `apps/every-app-gateway/src/server/{app-gateway-entrypoint,deploy-api,deploy-token-auth}.ts`, `src/server.ts:152-163`, `src/db/apps.schema.ts:40-41`, `src/server/services/UserPatService.ts`, `src/env.d.ts:18`, `package.json:45`
- `apps/{todo-app,chef,workout-tracker}/everyapp.config.ts`, `templates/simple-todo/everyapp.config.ts`
- `docs/cli-redesign.md` §1 (`:46-135`), §5 (`:592-668`), §6-7 (`:720-847`); `docs/architecture-v2-overview.md:140-165, 359-392`
- `adr/ADR-0001-hosted-vs-self-hosted-topology.md:30-36`; `adr/ADR-0003-self-host-authority.md:22-48`
- PR #257 (https://github.com/every-app/private-every-app/pull/257, OPEN), branch `claude/deploy-for-users`:
  `packages/deployer/src/{api,auth,bundle,engine,node}/*`, `apps/deployer/{README.md,src/*,scripts/publish-bundle.ts}`,
  `adr/ADR-0003-oauth-bootstrap-and-rest-deployer.md`
- OpenSEO: `/Users/bensenescu/workspaces/open-seo/wrangler.jsonc`, `wrangler.audit.jsonc`

Cloudflare (fetched 2026-10-15; page "last updated" dates in the text):
- Cloudflare API OpenAPI spec (via the Cloudflare API MCP): dispatch-namespace script paths, upload metadata schema, assets session, D1 query/raw/time_travel, Workflows PUT
- https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/ (2026-09-16)
- https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/
- https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/ (2026-10-13)
- https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/ (2026-04-21)
- https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
- https://developers.cloudflare.com/workflows/reference/limits/ (2026-09-21)
- https://developers.cloudflare.com/workers/static-assets/direct-upload/ (2026-08-10)
- https://developers.cloudflare.com/d1/platform/limits/ (2026-04-21)
- https://developers.cloudflare.com/kv/platform/limits/ (2026-10-08)
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/
- https://developers.cloudflare.com/cf/projects/ (2026-10-12) and https://developers.cloudflare.com/cf/ci/
- https://developers.cloudflare.com/cf/projects/cloudflare-config/ (exports, workflow schedules)
- https://developers.cloudflare.com/workers/configuration/cron-triggers/ (2026-09-04)
- https://developers.cloudflare.com/changelog/product/workers-for-platforms/ (synchronous first uploads, via search)
