# Building and deploying org apps from source on the hosted tier

Researcher report, 2026-10-15. Scope: how an organization on everyapp.com gets
its own code (a fork of a catalog app, or an internal tool) built and running
as a Workers for Platforms (WfP) user Worker, and how GitHub fits. Every claim
is anchored to a file in this worktree (`path:line`) or a dated web source
(Sources, at the end).

## TL;DR

- **The seam already exists in the code.** The self-host pipeline in
  `packages/cli/src/commands/app/deploy/deployApp.ts` goes `buildApp()`
  (L344-356) then `prepareAppBuildOutput()` (L357). Everything before that
  line is the *producer* side: install, evaluate the manifest, run the build.
  It is untrusted. Everything after is the *deployer* side: check the policy,
  set bindings, migrate, upload, register, bind, activate, sync tools. It is
  trusted. On the hosted tier, the CLI, a GitHub Action, a cloud build and a
  catalog release all produce the same thing, a **deploy bundle** (cf Build
  Output v0, plus the evaluated manifest, the migrations and metadata), and
  one gateway-side `DeployApp` Workflow consumes it.
- **Make the build tenant-neutral, and set the bindings at upload.** Today a
  production build bakes in org-specific values: the org id, identity keys,
  D1/KV ids and the Worker name, read from `.everyapp/deploy.json` at
  `packages/sdk/src/cloudflare/worker.ts:276-333`. The repo already has the
  fix pattern: `packages/cli/src/lib/gateway/patchBuildOutput.ts` patches a
  neutral gateway Build Output (`__EVERYAPP_PATCH__` placeholders, L39)
  after the build. Doing the same for apps means one catalog build can be
  deployed to N orgs with no rebuild. This is the most valuable single
  change.
- **v1 (prototype, about 3-4 weeks): no cloud builds.** `everyapp deploy`
  against the hosted gateway builds locally (`cf build` needs no
  credentials) and uploads the bundle. A thin `every-app/deploy` GitHub
  Action does the same in the user's repo with a per-app CI token. This is
  the Vercel `vercel build && vercel deploy --prebuilt` model.
- **v2 (GA, about 4-5 more weeks): builds in Cloudflare Sandbox 1.0
  containers, triggered by GitHub webhooks.** The container runs with no
  internet except the npm registry, and outbound handlers inject the GitHub
  token so the container never sees it. Deploys happen from the trusted
  Worker, never from the container. That is VibeSDK's pattern. Check runs go
  back to GitHub, and each PR gets its own preview user Worker. GitHub
  Actions OIDC replaces per-app CI tokens.
- **Workers Builds is not usable as the multi-tenant builder.** Builds
  attach to a Worker in *our* account. Repos connect through Cloudflare's own
  GitHub App. Builds deploy with a user-scoped token that holds account-wide
  `Workers Scripts: Edit`, and the account gets 6 concurrent builds. Running
  tenant build scripts next to that token would let them overwrite the
  gateway.
- **Two Cloudflare facts may change the runtime design and need a live
  check:**
  - Cloudflare's Workflows limits page (2026-09-21) says Workflows cannot be
    deployed to WfP namespaces, but the WfP bindings page (2026-09-16) lists
    Workflows as supported. PR #282 just shipped app Workflows.
  - The WfP script API has no `schedules` (cron) endpoint, while plain
    Workers have one.

---

## 1. What exists today

### 1.1 The self-host deploy pipeline (CLI, `cf` subprocess)

`deployApp()` in `packages/cli/src/commands/app/deploy/deployApp.ts` runs
these steps, in order:

| # | Step | Lines | Runs where / with what |
|---|---|---|---|
| 1 | `whoami` + `cf` login pinned to the gateway's account | L192-196, L510-545 | Developer machine, Cloudflare login |
| 2 | Register (`client.registerApp`): the gateway names the Worker, hostname and resources | L207-216 | Gateway registry. Per ADR-0003 these rules move to `@every-app/perimeter/registry` |
| 3 | Deploy lease | L274-287 | D1 row |
| 4 | Claim the Worker, provision D1/KV | L323-324 | `cf` |
| 5 | `installDependencies` | L326-331 | `pnpm install` on the machine |
| 6 | Identity keys + `DeployInputs` (worker name, org id, gateway URL, issuer, keys, D1/KV ids) | L333-342 | |
| 7 | **`buildApp`**: writes `.everyapp/deploy.json` (0600), runs `cf build` or the manifest's `build` command (`shell: true`), 600 s timeout | L344-356; `packages/cli/src/lib/app/buildApp.ts:18,30-65`; `packages/cli/src/lib/app/deployInputs.ts:23-43` | Arbitrary app code: `vite.config.ts`, `cloudflare.config.ts`, plugins |
| 8 | **`prepareAppBuildOutput`**: checks `config.json` is a production build, then `appPolicyProblems()` on `workers/default/worker.config.json`, lists source maps, validates against `@cloudflare/config`'s `OutputWorkerSchema` | L357; `packages/cli/src/lib/app/policy.ts:80-184, 252-298`; `patchBuildOutput.ts:173-177` | Pure functions over JSON |
| 9 | Workflow ownership and "may replace" checks | L358-374 | `cf` |
| 10 | D1 migrations (Time Travel bookmark, drizzle history carry-over, `cf d1 migrations apply`) | L375, L636-694; `packages/cli/src/lib/migrations/remote.ts:1-10` | `cf` |
| 11 | **`cfDeploy`**: `cf deploy --prebuilt --mode production --secrets-file …` | L383-399; `packages/cli/src/lib/cf/deploy.ts:131-148` | `cf` subprocess |
| 12 | `markDeployed`, gateway rebind (redeploys the gateway with service bindings), activate, tool sync | L428-460 | Gateway |

What this means for hosting:

- **The build artifact is cf's Build Output v0.** I ran
  `vite build --mode development` on `apps/todo-app` here (M-series, 18
  cores). It produced `.cloudflare/output/v0/{config.json,
  workers/default/{worker.config.json,bundle/,assets/}}`: 10 MB, 30 bundle
  files, 16 asset files, `manifest.type: "partial"`, and the
  `UserSyncDO` export. It took 9.3 s wall and 8.8 s user CPU, with 1.8 GB
  peak RSS (`/usr/bin/time -l`). `node_modules` for the app is 580 MB. The
  output is gitignored, and I deleted it afterwards.
- **What makes a build org-specific is all in `worker.config.json` `env`,
  not in the JS bundle.** `everyAppWorker()` reads deploy.json in production
  mode (`packages/sdk/src/cloudflare/worker.ts:276`). It writes the
  following into `env`:
  - `EVERY_APP_GATEWAY` with `props: {organizationId, appId, workerName}`
    (L311-320);
  - identity keys as `text` bindings;
  - D1/KV ids (L332-353);
  - the Worker `name`.

  No app code reads `VITE_GATEWAY_URL` or `VITE_APP_ID`. The only place that
  passes them is `deployApp.ts:350-353`, and they are referenced only by
  scaffolding (`packages/cli/src/lib/file-operations.ts:71`).
- **The policy check is the right gate, but it lives in the CLI.** It
  enforces:
  - an allow-list of binding types (`policy.ts:38-50`);
  - no routes, domains, workers.dev or preview URLs (L89-107);
  - D1/KV ids must be ones the deploy provisioned (L145-154);
  - Durable Object and Workflow names must be the app's own (L138-177,
    L193-244).

  These are pure functions and could move to `@every-app/perimeter` as-is.
- **Post-build patching is an established pattern.** The gateway release is
  built once with placeholders and patched per install (resource ids,
  service bindings, domains), then validated with `OutputWorkerSchema`
  before `cf` sees it (`packages/cli/src/lib/gateway/patchBuildOutput.ts:1-17,
  39, 173-177`).
- **The manifest is TypeScript evaluated with jiti** on the deploying
  machine (`packages/cli/src/lib/manifest.ts:30-32`). On the hosted tier this
  is tenant code, so it must be evaluated in the build environment and only
  its JSON validated on the platform side.
- **Hosted deploys are switched off.** `GATEWAY_DEPLOYMENT_MODE=hosted` makes
  deploy-token auth fail closed
  (`apps/every-app-gateway/src/server/deploy-token-auth.ts:55-56`). The CLI
  redesign deletes the self-host deploy API, and says the hosted tier needs
  "an HTTP deploy API with its own auth … Nothing here should be built for it
  yet" (`docs/cli-redesign.md:132-135, 585-589`). It keeps the rejected
  bearer-token design "because it is the right shape for a hosted API
  someday" (L803-809). ADR-0003 Decision 5 calls for "a browser login …
  issuing an org-scoped session, and per-app CI credentials".
- **The dispatch seam exists in code, unimplemented:**
  - `getAppFetcher()` throws for `tier: "dispatch"`
    (`packages/perimeter/src/getAppFetcher.ts:52-56`);
  - `apps.tier` is reserved (`apps/every-app-gateway/src/db/apps.schema.ts:40-41`);
  - the ToolBus already passes the tier through
    (`apps/every-app-gateway/src/server/toolbus/runtime.ts:86`).
- **Catalog apps are not buildable standalone.**
  - They depend on `"@every-app/sdk": "workspace:*"`
    (`apps/todo-app/package.json:26`, `apps/chef/package.json:23`).
  - The SDK exports `dist/` and needs a `tsc` build
    (`packages/sdk/package.json`).
  - Publishing has been paused since 2026-10-13 (TODO.md, "Paused while we
    work from the checkout").
  - OpenSEO pins `@every-app/sdk ^0.1.14` from npm, while the repo SDK is
    0.3.0.
- **Install-script posture.** pnpm only runs lifecycle scripts for
  `esbuild`, `sharp` and `workerd` (`pnpm-workspace.yaml` `allowBuilds`),
  and each app has its own lockfile (`sharedWorkspaceLockfile: false`). That
  narrows install-time code execution, but `vite build` runs the app's own
  config anyway.

### 1.2 The GitHub side (PR #281, branch `poc/github-integration`)

- **A per-org private GitHub App, created with GitHub's manifest flow**
  (`apps/every-app-gateway/src/server/integrations/github/manifest.ts`).
  - Its permissions are all read-only: `metadata, contents, administration,
    issues, pull_requests` (L13-19).
  - The name is `Every App ${host}` (L26).
  - The webhook URL is `/api/integrations/github/webhook`, set to
    `active: false`, with `default_events: []` (L32-38).
  - `setup_on_update: true` (L30).
- **App JWT signing** with a PKCS#1 to PKCS#8 wrapper (`github/appKey.ts`).
  `createInstallationToken(appJwt, installationId, permissions)` mints
  1-hour tokens narrowed by permission, but not yet by repository
  (`github/api.ts:129-147`).
- **Secrets storage.** `integration_clients` holds the app id, slug and
  encrypted `{privateKey, clientId, clientSecret, webhookSecret}`.
  `integration_accounts` holds installations
  (`src/db/integrations.schema.ts:22-81`). Encryption is AES-GCM under an
  HKDF key per org derived from `BETTER_AUTH_SECRET`, marked "Proof of
  concept … becomes the design's envelope encryption"
  (`src/server/integrations/crypto.ts:1-10`).
- **The grant model is for apps calling GitHub**
  (`app_integration_grants`). Deploy-on-push is a different consumer: the
  gateway itself uses the installation token, not an app.

### 1.3 Design-doc claims that the code or Cloudflare has moved past

- **Wrangler is no longer the deploy path.** The v2 recommendation's
  "Wrangler stays — as an internal compile target"
  (`docs/architecture-v2-recommendation.md` §2.5) predates the move to `cf`
  (#271). The pipeline is now `cf build` / `cf deploy --prebuilt`.
- **The hosted sketch uses retired auth and the wrong artifact.**
  `docs/architecture-v2-overview.md` §5 ("Platform / hosted tier") has the
  CLI upload "code + manifest" with an `eak_` token. ADR-0003 retired `eak_`.
  The artifact should be the Build Output, not source: the platform should
  never run tenant TypeScript in the gateway.
- **One sketch claim is confirmed.** The same sketch says "first upload is
  SYNCHRONOUS → 200 = live". Cloudflare's 2025-02-20 changelog confirms it.
- **Another is incomplete.** "NO binding step exists" is true for routing
  (`dispatcher.get(name)`). Bindings still have to be attached at upload,
  and only through the upload `metadata`: WfP bindings docs, 2026-09-16.

---

## 2. What the hosted tier needs

Requirements, each traced to the founder's vision in the brief:

1. **An org deploys its own code without holding a Cloudflare credential.**
   ADR-0001 §3: "Cloudflare account ownership checks are not a valid tenant
   authorization boundary". The deploy plane is ours.
2. **Isolation at build time and at run time.** A malicious build must not
   reach other tenants, our token, or the gateway. A malicious app must
   receive only the bindings the platform gives it. On the build side, this
   rules out running tenant code anywhere a platform token is readable.
3. **Three ways in, one way out:**
   - (a) a laptop (`everyapp deploy`);
   - (b) CI in the user's repo (a GitHub Action);
   - (c) "connect repo → deploy on push" (cloud build);
   - plus (d) catalog installs and updates, which need no build per org.

   All four end in the same trusted deployer.
4. **Previews per PR** as separate user Worker scripts. WfP user Workers
   have no gradual deployments ("Gradual Deployments is not supported yet
   for user Workers", WfP limits, 2026-10-13), and the WfP script API has no
   `versions` or `deployments` subresources (Cloudflare OpenAPI, queried
   2026-10-15).
5. **Status back to GitHub.** Check runs (which require a GitHub App), plus
   Deployments with a preview URL.
6. **Metering and limits on builds**, so build minutes can sit next to the
   gateway's other metered usage.

### 2.1 Options evaluated (October 2026)

#### Option 1: Workers Builds (Cloudflare's Git CI)

- **What it is:** GitHub, GitLab and Artifacts repos. A root directory for
  monorepos. Custom build and deploy commands. Build variables and secrets.
  Preview builds. Deploy Hooks (since 2026-04-01). A REST API to create
  triggers and start builds.
- **Limits** (limits page, 2026-05-29): 6,000 build minutes on paid, then
  $0.005/min. 6 concurrent builds per account on paid (1 on free). 20-minute
  cap. 4 vCPU, 8 GB memory, 20 GB disk. 64 env vars of up to 5 KB each.
- **Why it doesn't fit multi-tenant:**
  - **Bound to our account and our Workers.** A trigger hangs off a Worker
    tag (`external_script_id`), at most two triggers per Worker. The Builds
    API needs a **user-scoped** token, and account-owned tokens return
    "Invalid token" (API reference, 2026-09-22).
  - **The build token is an account-wide deploy credential.** The default
    build token has Account Settings read, `Workers Scripts edit`, KV edit,
    R2 edit and Workers Routes edit on all zones (configuration page).
    Tenant build scripts run in the same build next to it, so a malicious
    `postinstall` or `vite.config.ts` could take it and overwrite the
    gateway or another tenant.
  - **Repos connect through Cloudflare's own GitHub App.** The repo
    connection (`PUT /builds/repos/connections`) requires "the Cloudflare
    GitHub App" installed through the dashboard. Each tenant's GitHub would
    be linked to *our* Cloudflare account through Cloudflare's app, and we
    would not control its permissions, webhooks or check runs.
  - **No WfP deploy target.** Nothing in the Workers Builds docs mentions
    dispatch namespaces. Cloudflare's own Artifacts CI guide (2026-10-12)
    sends "Workers for Platforms deployment" to its *custom* pipeline rather
    than to Workers Builds.
  - **Six concurrent builds per account** is a platform-wide ceiling.
- **Verdict:** use it, if at all, only for *our* catalog release builds in
  our own account, or for the gateway itself. Not for tenants.

#### Option 2: build it ourselves in Sandbox 1.0 / Containers

- **Status:** Containers and Sandboxes went GA on 2026-04-13. Sandbox SDK
  1.0 preview (`@cloudflare/sandbox@next`) shipped 2026-09-30: your own
  Durable Object owns `this.ctx.container`.
- **Isolation:** "A Container runs in a Firecracker microVM with its own
  kernel and network, which no other workload shares" (Sandbox concepts).
- **Network:** "A Container starts with `enableInternet: false` by default".
  An outbound handler can allow single destinations and "add a credential
  that the container never sees". HTTP/80 and HTTPS/443 go through the
  handlers. "Keep Internet access off when you use an outbound handler"
  (Sandbox security, 2026-09-30).
- **Cold start:** "the median time from `start()` to the first command is
  under 600 ms" on a prepared image, against about 4 s on 0.x (Migrate page,
  2026-09-30).
- **Snapshots:** they capture the writable root filesystem and restore from
  an id. Public beta: no size limits, timings or prices published. Snapshots
  can hold credentials, so "copy only between sandboxes owned by the same
  user" (snapshots page, 2026-09-30). For us that means caches scoped per
  org, never shared across tenants.
- **Instance types** (limits page, 2026-10-12):

  | Type | vCPU | Memory | Disk |
  |---|---|---|---|
  | lite | 1/16 | 256 MiB | 2 GB |
  | basic | 1/4 | 1 GiB | 4 GB |
  | standard-1 | 1/2 | 4 GiB | 8 GB |
  | standard-2 | 1 | 6 GiB | 12 GB |
  | standard-3 | 2 | 8 GiB | 16 GB |
  | standard-4 | 4 | 12 GiB | 20 GB |

  Custom sizes go up to 4 vCPU / 12 GiB / 20 GB, and the disk-to-memory
  ratio was removed on 2026-09-29. Account ceilings are 1,500 concurrent
  vCPU, 6 TiB memory and 50 GB of image storage (raisable).
- **Pricing** (pricing page, 2026-10-05):
  - memory: $0.0000025 per GiB-s, provisioned;
  - CPU: $0.000020 per vCPU-s, *active use only* since 2025-11-21;
  - disk: $0.00000007 per GB-s;
  - egress: $0.025/GB in NA/EU after 1 TB included.
- **Sizing for a TanStack Start app.** Peak RSS of 1.8 GB rules out `basic`.
  Use `standard-3` (2 vCPU, 8 GiB).
- **Estimated cost per cold build** (≈180 s: install about 90 s, build about
  60 s, packaging):
  - memory: 8 GiB × 180 s × $0.0000025 = $0.0036;
  - CPU: about 1.5 busy vCPU × 180 s × $0.00002 = $0.0054;
  - disk: 16 GB × 180 s × $0.00000007 = $0.0002.

  That is **about $0.01 per cold build**, plus Durable Object and Worker
  requests. A warm build restored from a snapshot is roughly a third of
  that. For comparison, Workers Builds overage is $0.005/min, about $0.015
  for 3 minutes. A GitHub-hosted Linux 2-core runner is about $0.006/min in
  2026 (third-party figures; verify).
- **Prior art: `@cloudflare/ci`** (github.com/cloudflare/ci, created
  2026-07-30, v0.2.0, Apache-2.0). It is Workflows plus Sandbox runners
  with a lockfile-keyed snapshot cache, triggered by Artifacts pushes, and
  can deploy to WfP.
  - **Its deploy step is unsafe for tenant code.** It injects
    `CLOUDFLARE_API_TOKEN = env.CF_TOKEN` into the runner's env
    (`src/ci/capabilities.ts:117`), and that runner executes
    `npm exec wrangler deploy` from the tenant's own `node_modules`. That
    is fine for single-tenant CI, and a token leak for us.
  - It still runs on `@cloudflare/sandbox` 0.12.1, not 1.0.
- **Verdict:** this is the v2 builder. Build in the sandbox with no
  credentials; deploy from the trusted Worker.

#### Option 3: the CLI builds locally and uploads (v1)

- **Vercel:** `vercel build` writes `.vercel/output` (the Build Output
  API). `vercel deploy --prebuilt` uploads it, and the docs recommend
  `--archive=tgz` for many files (docs dated 2026-09-18).
- **Netlify:** `netlify deploy` builds by default unless `--no-build`,
  uploads "static files, functions, and edge functions", creates drafts by
  default and uses `--prod` for live (Netlify CLI docs).
- **`cf` already supports this:**
  - `cf build` "does not upload anything and does not need credentials".
  - `cf deploy --prebuilt` deploys an existing `.cloudflare/output/v0`.
  - The modes must match.
  - `--dispatch-namespace <NAMESPACE>` is a documented `cf deploy` option
    (cf Projects, 2026-10-12).
  - The cf CI guide's GitHub Actions example gives secrets "only [to] the
    final deploy step, so the pull request steps also work for forked pull
    requests" (cf CI, 2026-09-29).
- **Caveats:** `cf` is beta: "Commands, configuration, and Build Output can
  change before the stable release" (cloudflare.config.ts page,
  2026-09-29). It needs Node 22.18 or newer, and the repo pins
  `cf 1.0.0-beta.14` (`packages/cli/package.json:51`).
- **Verdict:** this is v1. It needs no build infrastructure from us,
  developers already run `cf build` today, and the bundle format it forces
  us to define is the one v2 reuses.

#### Option 4: Dynamic Workers for tiny single-file apps

- **Status:** open beta since 2026-03-24, Workers Paid only.
- **API:** `env.LOADER.load()` / `get(id, cb)`, with `globalOutbound: null`
  to cut network access. `@cloudflare/worker-bundler` bundles TS plus npm
  dependencies *at runtime inside a Worker*.
- **Pricing:** 1,000 unique Dynamic Workers a month included, then
  **$0.002 per Dynamic Worker per day**. Billing began 2026-05-26.
  Requests and CPU are billed at Workers Standard rates (pricing page,
  2026-06-11).
- **Limits:** no Vite pipeline, so TanStack Start and the catalog apps are
  out of scope. Storage only through bindings the loader hands in, or
  Durable Object Facets. Running org apps as Dynamic Workers would add a
  third runtime tier to `getAppFetcher`.
- **Verdict:** not a hosting tier. Two narrow uses:
  - in-Worker bundling of tiny Hono/HTML tools with `worker-bundler`, then
    a deploy as a normal WfP user Worker through the same deployer;
  - instant previews in an agent edit loop.

#### Reference: Cloudflare VibeSDK (github.com/cloudflare/vibesdk, MIT, pushed 2026-09-22)

VibeSDK is the closest working system. It has two deploy paths.

- **Sandbox path** (`worker/services/sandbox/sandboxSdkClient.ts`):
  - **Container:** class `UserAppSandboxService` from
    `cloudflare/sandbox:0.5.6`, at 4 vCPU / 8 GiB / 10 GB with
    `max_instances` 1400 (`wrangler.jsonc:98-110`).
  - **Build in the sandbox:** it runs `bun run build`, then
    `bunx wrangler build` (L1755-1767).
  - **Deploy from the Worker, credentials outside the sandbox:** it reads
    `dist/index.js`, `dist/assets/*.js` modules and `dist/client` assets out
    of the sandbox. It hashes the asset manifest, then uploads from the
    Worker with the platform's `CLOUDFLARE_API_TOKEN`. The comment reads
    "Get credentials from environment (secure - no exposure to external
    processes)" (L1745-1747).
  - **Bindings come from a trusted copy.** The Wrangler config used for
    bindings is a copy saved in KV right after template resource
    provisioning (L914-920, L1769-1780). It is not re-read from the sandbox
    at deploy time, so code the agent generated can't add bindings.
  - **D1/KV ids** are filled into template placeholders by
    `resourceProvisioner.ts` (L663-771).
  - **Upload:** `deployToDispatch()` (`worker/services/deployer/deploy.ts:100-115`)
    calls `WorkerDeployer.deployWithAssets()`
    (`worker/services/deployer/deployer.ts:30-158`). That does the assets
    upload session, then batch uploads, then the script PUT with bindings,
    migrations and `exported_handlers`, against
    `/workers/dispatch/namespaces/{ns}/scripts/{name}`.
  - **Routing:** `dispatch_namespaces: DISPATCHER → vibesdk-default-namespace`
    (`wrangler.jsonc:85-91`); apps are served at
    `https://{scriptName}.{previewDomain}`.
- **"Space/think" path:**
  - **No container.** It checks out a git branch into
    `@cloudflare/shell`'s filesystem and bundles with
    `@cloudflare/worker-bundler`'s `createApp`/`createWorker` inside the
    Worker (`space/src/space/deploy-engine.ts:3, 199, 216`).
  - **No Durable Object bindings** beyond a platform-defined `App` class
    (L171-175).
  - **Two deploy targets:** WfP (`deployThinkBundleToPlatform`), or the
    user's own account over OAuth (`deployThinkBundleToUserAccount`)
    (`worker/services/deployer/think-user-deploy.ts:178-218`).
- **The pre-deploy gate is about code quality, not security.**
  `preDeploySafetyGate.ts` is a Babel AST scan for React render-loop
  patterns.

What to take from VibeSDK:

- Build in a sandbox that holds no credentials, and deploy from the Worker.
- Take bindings from a platform copy, never from the build tree.
- Port the REST uploader (about 570 lines of TypeScript, MIT) instead of
  running `wrangler` or `cf` near a platform token.

#### Reference: how Val Town and Replit handle builds

- **Val Town:** vals run on Deno with TypeScript/TSX, and import npm
  packages with `npm:` specifiers or esm.sh. There is no filesystem (Val
  Town runtime and import docs). The docs I found don't describe build or
  deploy mechanics, so "no build step: modules resolve at run time" is my
  inference. The lesson for us is Option 4: tiny tools can skip the build
  entirely.
- **Replit:** a deployment type (Autoscale by default, Reserved VM,
  Static, Scheduled) carries its own build and run commands. Static
  deployments take "an optional build command" and a public directory
  (Replit docs). Builds run on Replit's infrastructure from the app's
  workspace. That is the "cloud build from the workspace" model, our v2.

---

## 3. "Connect repo → deploy on push" with the PR #281 GitHub App

### 3.1 The flow

```
GitHub ──push / pull_request──► POST /api/integrations/github/webhook/<integration_client_id>
                                   │ 1. look up the client row → decrypt its webhookSecret
                                   │ 2. verify X-Hub-Signature-256 (HMAC-SHA256 of the body)
                                   │ 3. dedupe on X-GitHub-Delivery (GUID, kept on redelivery)
                                   │ 4. enqueue → 202 within 10 s (GitHub's deadline)
                                   ▼
                         Queue consumer: (installation.id, repository.id, ref)
                                   → app_sources rows (org, app, root dir, prod branch)
                                   → builds row (queued) + check run "queued"
                                   → Workflow BuildApp(buildId)
                                   ▼
 BuildApp Workflow (gateway account)
   a. mint installation token: contents:read + checks:write, narrowed to the repo id
   b. check run → in_progress (details_url = gateway build page)
   c. AppBuilder DO starts a Sandbox 1.0 container (image everyapp-builder:<v>,
      standard-3, enableInternet:false). Outbound handlers allow:
        registry.npmjs.org (GET)
        api.github.com/repos/{o}/{r}/tarball/{sha} (Authorization injected by the handler)
   d. fetch tarball → untar into /workspace (or the root dir in a monorepo)
   e. restore snapshot keyed by sha256(org, image, lockfile) if present
   f. pnpm install --frozen-lockfile → snapshot on a miss
   g. `everyapp bundle` in the container: evaluate everyapp.config.ts → manifest.json,
      `cf build` (tenant-neutral), collect migrations → bundle.tgz
   h. Worker reads bundle.tgz out (Files API) → R2 bundles/<org>/<app>/<sha256>.tgz
   i. destroy the container
   ▼
 DeployApp Workflow (the SAME one the CLI upload and catalog installs use)
   validate → patch bindings from the registry → policy → D1 migrate → WfP upload
   → markDeployed → tool sync
   ▼
 check run → completed (success + URL | failure + log tail)
 GitHub Deployment + status (environment "production" or "preview-pr-<n>")
```

### 3.2 GitHub details that shape the design

- **Webhooks:** "Your server should respond with a 2XX response within 10
  seconds", and the docs recommend a queue. GitHub does not say it
  redelivers failed deliveries automatically; a redelivery keeps the same
  `X-GitHub-Delivery`. Webhooks carry `X-GitHub-Hook-Installation-Target-ID`
  (the GitHub App's id), and payloads are capped at 25 MB (GitHub webhook
  docs).
  - **Fix needed in PR #281.** Every org's GitHub App posts to the same
    path (`manifest.ts:34`). Either put the client id in the URL, or look
    the client up by `X-GitHub-Hook-Installation-Target-ID` *before*
    verifying the signature, because each org has its own webhook secret.
- **Tarball:** `GET /repos/{owner}/{repo}/tarball/{ref}` returns a 302.
  For private repos, "the redirect link is temporary and expire[s] after
  five minutes" (GitHub REST). Two ways to fetch it:
  - inject the token with an outbound handler (preferred);
  - hand the sandbox only the five-minute redirect URL.
- **Check runs:** "To create a check run, you must use a GitHub App." PR
  #281 has a GitHub App, which is a real advantage over a PAT or OAuth.
- **Permissions and events to add** in `githubAppManifest`
  (`manifest.ts:13-19, 32-38`):
  - permissions: `checks: write`, `deployments: write`,
    `pull_requests: write` (for a preview-URL comment, optional),
    `statuses: write` (optional);
  - events: `push`, `pull_request`, `installation`,
    `installation_repositories`, `check_run` (for "Re-run");
  - `active: true` on the webhook.

  `setup_on_update: true` already sends admins back after they accept new
  permissions.
- **Name collision on hosted.** The app is named `Every App ${host}`
  (`manifest.ts:26`). On everyapp.com every org gets the same proposed
  name, and GitHub App names are globally unique, so the second org
  collides. Add the org slug, or see founder question 2.
- **Narrow tokens per build.** Extend `createInstallationToken`
  (`api.ts:129-147`) to pass `repository_ids: [id]` along with the
  permissions, so a build token can't read the org's other repos.

### 3.3 Previews per PR

- **One preview per PR, as its own user Worker:** `<workerName>--pr-<n>`,
  on hostname `{app}--pr<n>-{tenant}.everyapp.host`. This keeps the
  single-label wildcard from architecture-v2 §2.6.
- **Separate data:** a fresh D1/KV per preview, migrated from scratch;
  Durable Objects are per-script already. Never the production database:
  a PR branch's migrations would run against production data.
- **Deleted on** `pull_request.closed`.
- **Fork PRs aren't built until an org member approves.** Even in a
  sandbox, a fork preview would otherwise run outside code with the org's
  gateway grants.
- **Previews get no metered or integration grants by default.** The broker
  sees an `environment: "preview"` prop and denies them unless an admin
  opts in.
- **Status in GitHub:** a GitHub Deployment per preview gives "View
  deployment" in the PR. This needs `deployments: write`.

### 3.4 The GitHub Actions path (user's repo, v1)

A composite action `every-app/deploy@v1` runs:
`setup-node 24 → pnpm install --frozen-lockfile → npx everyapp deploy
--gateway https://everyapp.com`.

- **v1 auth:** a per-app CI token (`EVERYAPP_DEPLOY_TOKEN`). It is hashed in
  the hosted registry, scoped to `apps:deploy` for one (org, app), and
  revocable. This is ADR-0003 Decision 5's "per-app CI credentials".
- **v2 auth: GitHub OIDC.** The job requests an ID token (issuer
  `https://token.actions.githubusercontent.com`, claims `repository_id`,
  `ref`, `sha`, `event_name`, `job_workflow_ref`, about a 5-minute
  lifetime; GitHub OIDC docs). The gateway checks it against an app source
  row `{repository_id, allowed refs}`. No long-lived secret.
- **Forked PRs:** following the cf CI guide, only the deploy step gets
  credentials. Forked PRs run `everyapp deploy --dry-run`, which bundles
  and validates.

---

## 4. Where the two bundle sources converge

**The seam is the boundary between `buildApp()` and `prepareAppBuildOutput()`
at `packages/cli/src/commands/app/deploy/deployApp.ts:356-357`.** On the
hosted tier it becomes a `DeployBundle` object in R2, consumed by one
gateway-side `DeployApp(bundleKey, target)` Workflow.

```
 PRODUCERS (untrusted; run tenant code)            DEPLOYER (trusted; never runs tenant code)
 ─────────────────────────────────────            ───────────────────────────────────────────
 everyapp deploy (laptop)            ─┐
 every-app/deploy GitHub Action      ─┤  DeployBundle   ┌─ validate bundle.json + OutputWorkerSchema
 BuildApp Workflow (Sandbox, v2)     ─┼──(R2, sha256)──►├─ validateManifestStrict(manifest.json)
 catalog release (our CI, once)      ─┘                 ├─ registry: names, resources (perimeter rules)
                                                        ├─ PATCH worker.config.json: name + env from the
                                                        │  registry (bundle's env ignored)
                                                        ├─ appPolicyProblems() on the patched config
                                                        ├─ D1 migrate via REST (bookmark first)
                                                        ├─ upload: self-host = cf deploy --prebuilt
                                                        │          hosted    = WfP REST multipart
                                                        └─ markDeployed → (self-host: rebind) → tool sync
```

**Bundle v1 format** (`.everyapp/bundle.tgz`):

- `bundle.json`: `{ schema: 1, appId, manifest, sdkVersion, cfVersion,
  source: { kind: "cli" | "github-action" | "cloud" | "catalog", repo?,
  sha?, ref?, dirty? } }`. `manifest` is the evaluated JSON of
  `everyapp.config.ts`.
- `output/v0/…`: cf Build Output, built **tenant-neutral**. `env` holds
  only placeholders and binding *shapes*; there are no ids, no org, and no
  keys.
- `migrations/…`: the `manifest.migrations.dir` contents (SQL plus the
  drizzle journal that `readDrizzleJournal` reads).

**Why convergence lands here and not earlier or later:**

- **Earlier won't work:** source upload would mean running tenant
  TypeScript (the manifest, `cloudflare.config.ts`, Vite) on the platform
  side.
- **Later won't work:** an upload that already holds bindings would mean
  trusting tenant-written `env`.
- **Self-host keeps working.** It produces the same neutral Build Output,
  patches it locally the way the gateway release is patched
  (`patchBuildOutput.ts`), and deploys with `cf deploy --prebuilt`. One
  code path; only the target differs.

**What it takes to make builds tenant-neutral:**

- **Production mode stops reading deploy.json.** `everyAppWorker()` in
  `production` mode emits placeholder `text` bindings for the identity keys,
  binding shapes without ids (`{type: "d1"}`, `{type: "kv"}`), and a gateway
  binding without props (`worker.ts:276-353`).
- **The deployer fills them in.** Self-host: `patchAppBuildOutput()`, a
  sibling of `patchGatewayBuildOutput`. Hosted: the gateway does the same
  from the registry.
- **This also stops a `cf build` from embedding real ids.**
  `writeDeployInputs` (`deployInputs.ts:35-38`) exists only to keep a bare
  build from shipping a real Worker. Without ids in the build there is
  nothing to guard.

**Hosted gateway binding.** Two options, depending on what WfP allows (see
§6):

- **(a)** a static `service` binding to the gateway's `AppGateway` with
  props, set at upload. This is self-host parity. The WfP upload schema's
  `service` binding lists `entrypoint, environment, name, service` and no
  `props` field (OpenAPI, 2026-10-15). That needs a live check.
- **(b)** per-request props: the dispatcher passes
  `ctx.exports.AppGateway({props:{org,app}})` as an RPC stub in
  `env.DISPATCHER.get(name, {props})` (Dynamic dispatch, 2026-09-16). The
  stub "is valid only during the request that received it", so crons,
  Durable Object alarms and queue handlers still need (a).

Either way, **no org-specific value ever has to be in the build**, so a
catalog build deploys to N orgs unchanged.

---

## 5. Gaps, and the smallest change that closes each

Sizes are engineer-days for one person working with agents.

| # | Gap | Where | Smallest fix | Days |
|---|---|---|---|---|
| G1 | Builds are org-specific (deploy.json baked into `env`) | `packages/sdk/src/cloudflare/worker.ts:276-353`; `packages/cli/src/lib/app/deployInputs.ts`; `buildApp.ts` | Neutral production build (placeholders) plus `patchAppBuildOutput()` modelled on `patchBuildOutput.ts`; self-host switches to it too | 2 |
| G2 | The policy check and Build Output validation live only in the CLI | `packages/cli/src/lib/app/policy.ts:38-298`; `patchBuildOutput.ts:173` | Move `appPolicyProblems`, `definedWorkflows` and `validateWorkerConfig` into `@every-app/perimeter` (Worker-safe, pure). In hosted mode, reject any bundle `env` entry not in the manifest's declared shapes | 1 |
| G3 | No bundle format; the manifest is evaluated with jiti on the deploying machine | `packages/cli/src/lib/manifest.ts:30-32` | `everyapp bundle` writes `bundle.json` (evaluated manifest) + `output/v0` + `migrations/`; the deployer runs `validateManifestStrict` on the JSON | 1-2 |
| G4 | The deploy path is a `cf` subprocess, and Workers can't spawn | `packages/cli/src/lib/cf/deploy.ts:131-148` | WfP REST uploader in the gateway: assets session, batches, multipart PUT with `main_module`, modules (including source maps), `exports`, `bindings`, `secret_text`, `tags: [org, app]`, `observability`. Port VibeSDK's `deployer.ts` + `cloudflare-api.ts` (MIT) | 4-5 |
| G5 | Migrations go through `cf d1 migrations apply` | `packages/cli/src/lib/migrations/remote.ts`; `deployApp.ts:636-694` | Fetch-based migrator: `GET …/time_travel/bookmark`, the same drizzle-to-`d1_migrations` carry-over, `POST …/d1/database/{id}/query` per pending file (all three exist in the Cloudflare API) | 2 |
| G6 | No hosted deploy API or credentials (hosted mode fails closed) | `apps/every-app-gateway/src/server/deploy-token-auth.ts:55-56`; `docs/cli-redesign.md:132-135` | `POST /api/v1/orgs/:org/apps/:app/deploys` (streams the bundle to R2, starts `DeployApp`), `GET …/deploys/:id` (status + logs). Auth: org session (device login) or a per-app CI token | 3-4 |
| G7 | The CLI has no hosted target | `packages/cli/src/commands/app/deploy/deployApp.ts:150-216` | When the gateway reports `deploymentMode: "hosted"`: skip steps 1, 3, 4 and 9-12, build neutral, bundle, upload, poll. No `cf` login needed | 1-2 |
| G8 | No GitHub Action | none | Composite action `every-app/deploy` (setup-node, pnpm, `npx everyapp deploy`), using the per-app token in v1 and OIDC in v2 | 0.5-1 |
| G9 | GitHub App: read-only, webhooks off, one shared webhook path, repo-unscoped tokens, colliding name on hosted | `poc/github-integration`: `github/manifest.ts:13-38`; `github/api.ts:129-147` | Add write permissions and events; per-client webhook URL; `repository_ids` narrowing; org slug in the name; verify, dedupe and enqueue the webhook | 1-2 |
| G10 | No repo connection model | `src/db/integrations.schema.ts` | `app_sources(org, app_slug, provider, installation_id, repository_id, root_dir, production_branch, preview_policy)` + `builds(id, org, app, source, sha, status, bundle_key, log_key, minutes)` + a connect-repo UI | 2 |
| G11 | No builder | none | `AppBuilder` DO on Sandbox 1.0: image `everyapp-builder` (Node 24, pnpm via corepack pinned, no extra tools); `standard-3`; `enableInternet:false` + outbound allow-list; per-org snapshot cache keyed by the lockfile; 15-minute cap; logs to R2 | 5-7 |
| G12 | No previews | `apps.schema.ts` (one row per app) | Preview rows (`environment` column) → `<worker>--pr-<n>` scripts, ephemeral D1/KV, cleanup on close, fork-PR approval gate, `environment` prop checked by the broker | 3-4 |
| G13 | Catalog apps can't build outside the monorepo | `apps/*/package.json` (`workspace:*`); TODO.md "Publish again" | Resume SDK publishing before forks are supported, *or* build catalog bundles ourselves and let forks build from the monorepo root (root dir + `pnpm -r --filter <app>... build`) | 1 + a decision |
| G14 | Catalog fan-out is unbounded | none | Build each catalog release once (our CI) → `catalog/<app>/<version>.tgz` → a Queue fans `DeployApp` out per install, under the 1,200 requests / 5 min API limit (WfP limits, 2026-10-13); `keep_assets` and asset dedupe mean unchanged files aren't re-sent | 2-3 |
| G15 | Workflows may not deploy to WfP | `deployApp.ts:357-362, 416-427` (PR #282); `worker.ts` workflows block | Live check first. If unsupported: hosted manifests reject `resources.workflows` with a clear error (or adopt `@cloudflare/dynamic-workflows` later) | 0.5-3 |
| G16 | Crons for user Workers: the WfP script API has no `schedules` subresource | `worker.ts` `crons` → `triggers`; `policy.ts:100-107` | Live check. If absent: the gateway's own cron fans out to apps with `crons` in their manifest and invokes the user Worker's `scheduled` through the dispatcher | 2 |
| G17 | Build metering and abuse limits | gateway billing (deferred, TODO.md) | Record `builds.minutes`; a per-org concurrency cap (1-2); a monthly included allowance; report it as a metered feature like the others | 1-2 |

**v1 (prototype): G1-G8 + G13-decision ≈ 15-20 days (3-4 weeks).** It
delivers `everyapp deploy` to everyapp.com from a laptop or CI, catalog
installs from prebuilt bundles, and no builds on our side.

**v2 (GA): G9-G12, G14-G17, plus OIDC (2 days) ≈ 22-30 days (about 5-6
weeks).** It delivers connect repo → deploy on push, PR previews, check runs,
catalog updates fanned out, and metered builds.

**Later (v3):** Artifacts-backed repos for agent-written internal tools with
no GitHub. Artifacts is in beta by request form since 2026-04-16. It can
import only *public* HTTPS remotes (import guide, 2026-04-25), it emits
`repo.pushed` events, and `@cloudflare/ci` triggers on them. The bundle
format plugs in unchanged: "producer = Artifacts push", same deployer.

**Suggested PR order** (each ships alone):

1. G1 + G2: neutral build + perimeter policy (self-host keeps working).
2. G3: `everyapp bundle`.
3. G4 + G5: gateway deployer, behind `GATEWAY_DEPLOYMENT_MODE=hosted`.
4. G6 + G7: hosted deploy API + CLI target.
5. G8: Action.
6. G9 + G10: GitHub App write + webhooks + app_sources.
7. G11: builder.
8. G12: previews.
9. G14: fan-out.
10. G17: metering.

---

## 6. Open questions only the founder can answer

1. **Is v1 "you build, we deploy" acceptable for the prototype, with cloud
   builds in v2?**
   - Why it matters: it saves about 2 weeks of builder, sandbox and cache
     work up front, and it defers every untrusted-build-execution risk.
   - Default: yes. v1 is CLI and GitHub Action only; cloud builds start
     after the bundle and deployer are proven.
2. **On hosted, one platform-owned public GitHub App, or keep PR #281's
   per-org manifest app?**
   - Why it matters:
     - Per-org apps isolate keys (one leak affects one org). But each org
       needs a GitHub owner to create an app, the names collide on one host
       (`manifest.ts:26`), and the gateway verifies N webhook secrets.
     - A single app is the Vercel/Netlify pattern: one key that can mint
       tokens for every installation, but standard UX.
   - Default: a single platform GitHub App for hosted repo-connect and
     deploys. Keep the manifest flow for self-host and as a "bring your own
     GitHub App" option for orgs that want isolation.
3. **Should PRs from forks build and get previews automatically?**
   - Why it matters: a preview runs outside code with the org's gateway
     grants (metered OpenRouter, GitHub integration).
   - Default: no. An org member approves each fork PR build, and previews
     never get metered or integration grants unless an admin enables "use
     production grants in previews".
4. **What data do previews use?**
   - Why it matters: sharing the production D1 lets a PR's migrations
     mutate production. Copying production data leaks it to anyone who can
     see the PR.
   - Default: an empty D1/KV per preview, plus the app's optional seed
     script; never production data.
5. **Do builds count against a plan allowance?**
   - Why it matters: a cold build costs about $0.01 on standard-3, but
     abuse such as crypto-mining in `postinstall` is a real risk. Limits
     need to exist before signup opens.
   - Default: N build-minutes included per org per month, metered with the
     other gateway features; 1-2 concurrent builds per org; a hard
     15-minute cap.
6. **Should catalog updates auto-deploy to every org that installed the
   app?**
   - Why it matters: fan-out is cheap with prebuilt bundles, but a bad
     release hits everyone, and WfP has no gradual rollout for user
     Workers.
   - Default: auto-deploy unforked catalog installs in waves (canary orgs
     first); forks get an "upstream release available" notice, later a PR.
7. **Do hosted apps keep Workflows and crons if WfP can't host them
   natively?**
   - Why it matters: PR #282 just made Workflows a manifest feature, and
     RepoLens uses a cron.
   - Default: crons yes, through a gateway scheduler. Workflows reject at
     deploy on hosted until the live check passes.
8. **Arbitrary build commands and dependencies in org apps?**
   - Why it matters: arbitrary commands are more flexible and need a
     tighter sandbox.
   - Default: allow the manifest `build` command. The only network is the
     npm registry (plus allow-listed private registries with injected
     tokens, in v2), and the output must be a production Build Output v0.

---

## 7. Load-bearing claims (if wrong, the design changes)

1. **`cf deploy --prebuilt` and `--dispatch-namespace` are both real
   options** (cf Projects, 2026-10-12), so self-host and an optional "cf in
   a trusted container" deployer could share code. Build Output v0 may
   change during the beta (cf config page, 2026-09-29). Pin `cf` and
   version the bundle schema.
   - Not verified: the two flags together with Durable Object `exports`.
2. **Workflows support in WfP is contradictory.** "Workflows cannot be
   deployed to Workers for Platforms namespaces" (Workflows limits,
   2026-09-21), against Workflows listed among user-Worker bindings (WfP
   bindings, 2026-09-16). Critical for G15.
3. **Workers Builds is account-bound, with user-scoped, account-wide build
   tokens and 6 concurrent builds per account, and documents no WfP
   target** (Builds API reference 2026-09-22, configuration page, limits
   2026-05-29). This is why Workers Builds is rejected.
4. **Sandbox 1.0 containers:** a Firecracker microVM per instance,
   `enableInternet:false` by default, outbound handlers that inject
   credentials the container never sees, and starts under 600 ms median
   (Sandbox docs and changelog, 2026-09-30). This is the v2 builder's
   security model. Snapshots are public beta with no published limits.
5. **WfP bindings attach only through upload `metadata`; per-request
   capabilities go through dispatcher `props` stubs, which last only for
   the request** (WfP bindings and Dynamic dispatch, 2026-09-16). Whether a
   user Worker can hold a static `service` binding *with props* to the
   gateway is not documented (the OpenAPI `service` binding has no
   `props`). Background handlers depend on it.
6. **The WfP script API has no `schedules` or `versions` endpoints**
   (Cloudflare OpenAPI via MCP, 2026-10-15), and gradual deploys are not
   supported (WfP limits, 2026-10-13). This drives G12 (previews as
   separate scripts) and G16 (crons).
7. **First-time user Worker uploads are synchronous: a 200 means routable**
   (changelog 2025-02-20). Without that, activation would need the polling
   self-host uses today.
8. **Only GitHub Apps can create check runs** (GitHub REST checks). This is
   why the GitHub App, not OAuth or a PAT, is the integration vehicle.

---

## 8. Sources

Cloudflare (dates are the pages' "Last updated" or post dates):

- Workers Builds overview, 2026-10-15: https://developers.cloudflare.com/workers/ci-cd/builds/
- Workers Builds limits and pricing, 2026-05-29: https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
- Workers Builds configuration (API token, build variables): https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- Builds API reference, 2026-09-22: https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/
- Deploy Hooks changelog, 2026-04-01: https://developers.cloudflare.com/changelog/post/2026-04-01-deploy-hooks/
- Default env vars in Workers Builds, 2025-06-10: https://developers.cloudflare.com/changelog/post/2025-06-10-default-env-vars/
- Artifacts: build and deploy on push, 2026-10-12: https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/
- Artifacts import repositories, 2026-04-25: https://developers.cloudflare.com/artifacts/guides/import-repositories/
- Artifacts changelog (beta 2026-04-16, events 2026-05-19): https://developers.cloudflare.com/changelog/product/artifacts/
- Artifacts REST API: https://developers.cloudflare.com/artifacts/api/rest-api/
- cf Projects (build, `--prebuilt`, `--dispatch-namespace`), 2026-10-12: https://developers.cloudflare.com/cf/projects/
- Use cf in CI, 2026-09-29: https://developers.cloudflare.com/cf/ci/
- cloudflare.config.ts (beta caveat), 2026-09-29: https://developers.cloudflare.com/cf/projects/cloudflare-config/
- Sandboxes overview, 2026-09-30: https://developers.cloudflare.com/sandbox/
- Sandbox security, 2026-09-30: https://developers.cloudflare.com/sandbox/concepts/security/
- Sandbox concepts (Firecracker): https://developers.cloudflare.com/sandbox/concepts/
- Sandbox snapshots, 2026-09-30: https://developers.cloudflare.com/sandbox/files/save-and-restore-a-workspace/
- Migrate to Sandbox SDK 1.0 (600 ms start), 2026-09-30: https://developers.cloudflare.com/sandbox/sdk/migrate/
- Sandbox SDK 1.0 changelog, 2026-09-30: https://developers.cloudflare.com/changelog/post/2026-09-30-sandbox-sdk-1-0/
- Containers and Sandboxes GA, 2026-04-13: https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/
- Containers pricing, 2026-10-05: https://developers.cloudflare.com/containers/platform/pricing/
- Containers limits and instance types, 2026-10-12: https://developers.cloudflare.com/containers/platform/limits/
- Active-CPU pricing, 2025-11-21: https://developers.cloudflare.com/changelog/post/2025-11-21-new-cpu-pricing/
- Dynamic Workers open beta, 2026-03-24: https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/
- Dynamic Workers getting started (worker-bundler), 2026-10-12: https://developers.cloudflare.com/dynamic-workers/getting-started/
- Dynamic Workers pricing, 2026-06-11: https://developers.cloudflare.com/dynamic-workers/pricing/
- Dynamic Workflows, 2026-05-01: https://developers.cloudflare.com/changelog/post/2026-05-01-dynamic-workflows/
- WfP bindings, 2026-09-16: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/
- WfP dynamic dispatch (props, RPC stubs), 2026-09-16: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/
- WfP static assets, 2026-10-12: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/
- WfP limits, 2026-10-13: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/
- WfP synchronous first upload, 2025-02-20: https://developers.cloudflare.com/changelog/post/2025-02-20-synchronous-uploads/
- Workflows limits (no WfP), 2026-09-21: https://developers.cloudflare.com/workflows/reference/limits/
- Static assets direct upload, 2026-08-10: https://developers.cloudflare.com/workers/static-assets/direct-upload/
- Cloudflare API OpenAPI (dispatch script subresources, binding schemas, Builds and D1 endpoints), queried through the Cloudflare MCP on 2026-10-15: https://developers.cloudflare.com/api/

Open source (read with `gh api` on 2026-10-15):

- cloudflare/vibesdk (MIT, pushed 2026-09-22): https://github.com/cloudflare/vibesdk
  - `worker/services/sandbox/sandboxSdkClient.ts`
  - `worker/services/deployer/{deploy,deployer,think-user-deploy}.ts`
  - `space/src/space/deploy-engine.ts`
  - `wrangler.jsonc`, `SandboxDockerfile`
- cloudflare/ci (`@cloudflare/ci` 0.2.0, Apache-2.0, created 2026-07-30): https://github.com/cloudflare/ci
  - `src/ci/capabilities.ts`
  - `examples/cloudflare-artifacts/cloudflare.ci.ts`

GitHub:

- Repository tarball: https://docs.github.com/en/rest/repos/contents#download-a-repository-archive-tar
- Webhook best practices (10 s): https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
- Webhook headers and payload cap: https://docs.github.com/en/webhooks/webhook-events-and-payloads
- Check runs (GitHub Apps only): https://docs.github.com/en/rest/checks/runs#create-a-check-run
- Actions OIDC: https://docs.github.com/en/actions/concepts/security/openid-connect
- Actions runner pricing ($0.006/min Linux 2-core in 2026, mostly third-party sources):
  - https://docs.github.com/en/enterprise-server@3.17/billing/reference/actions-runner-pricing
  - https://cicdcalculator.com/github-actions-pricing-changes-2026

Other platforms:

- Vercel `vercel deploy --prebuilt`, 2026-09-18: https://vercel.com/docs/cli/deploy
- Netlify `netlify deploy`: https://cli.netlify.com/commands/deploy/
- Val Town runtime: https://docs.val.town/reference/runtime/
- Val Town imports: https://docs.val.town/reference/import/
- Replit deployment types: https://docs.replit.com/features/publishing/deployment-types

Local measurement: `apps/todo-app`, `npx vite build --mode development`,
2026-10-15, Node 24.20.0, 18-core Apple Silicon: 9.32 s real, 8.83 s user,
1.80 GB max RSS, 10 MB Build Output.
