# Hosted Every App: how it was built (2026-10-15/16)

What the overnight build shipped, every default it took without Ben and how to
walk it back, what it cut, and what still needs a live account. The open
questions are also in `TODO.md` (Decide, Build, Check on the first live deploy).
The plan the build started from is
[research/2026-10-hosted-platform/final-plan-2026-10-16.md](research/2026-10-hosted-platform/final-plan-2026-10-16.md);
§9 says where the build left it.

State when written (2026-10-16): the build is complete and no lane failed.
Fourteen PRs merged on `main`, in this order: #300, #301, #303, #302, #308,
#304, #305, #306, #307, #310, #309, #311, #313 and #314. This PR (#312) is the
only one open here; three OpenSEO PRs are open for Ben to merge, stacked
open-seo #983 → #984 → #990. The build workflow ran 46 agents, plus a follow-ups
workflow. Nothing has run against a live Cloudflare, Google or PlanetScale
account: every claim below about Cloudflare's behaviour is from docs and fakes
unless marked otherwise.

## 1. What the hosted platform is now

Hosted and self-hosted Every App are one codebase. One secret,
`GATEWAY_DEPLOYMENT_MODE`, is read once into `platformPolicy(env)` (#302), and
every hosted behaviour asks that object; anything but `self_hosted` or `hosted`
turns everything off. `everyapp setup --mode hosted` installs our gateway at
`app.everyapp.com`, and the setup claim makes the install organization, which on
hosted is the platform organization, always named Every App. Anyone may sign up
(#305) into exactly one personal organization after verifying their email, under
daily mail budgets, unless `HOSTED_OPEN_SIGNUP=false` keeps sign-up invite-only
(the preview default). First-party apps are shared (#307): one `apps` row with
`scope = 'shared'` owned by the platform organization, one Worker for every
organization at `<app>.app.everyapp.com` on the control plane's cookie, opened
by any live member of any active organization, with the member's own
organization in the identity token. `everyapp deploy --shared` deploys one from
this repository and `everyapp register` records one deployed elsewhere
(OpenSEO's Alchemy stage). Provider keys (OpenAI, OpenRouter, DataForSEO,
Context.dev) live only at the gateway, behind the AI proxy and the capability
proxy (#303), and a per-organization daily request cap stands in for metering
until a wallet exists (AI in #307, capabilities in #310). Apps may ship helper
Workers with their own Durable Objects and Workflows (#306) and Postgres through
Hyperdrive (#309). Background work in a shared Worker names its organization
with `x-everyapp-org`, which the gateway accepts only for an active organization
with a live member (#310).

For third-party apps the gateway reaches a Workers for Platforms namespace
through the same `getAppFetcher` seam, with per-invocation limits and a
default-deny `Outbound` entrypoint (#304), and every identity token's audience
is now the Worker name, so one organization's copy of an app refuses a token
minted for another's. The deploy API (#311) takes a third-party app's bundle
with a deploy key (a personal access token scoped `deploy`), rewrites every
binding it allows and refuses the rest, uploads into the namespace through the
REST client (#301), and deletes the upload when `GET /bindings` doesn't read
back what it sent. Its routes (`/api/v1/*`) exist only when the gate is open,
which takes a hosted gateway plus `THIRD_PARTY_DEPLOYS=on` set by hand (the CLI
refuses that name); until the launch gate below passes it stays shut. #313 fixed
the six findings of #311's second review. Third-party apps live on their own
registrable domain, at `<app>-<orgKey>.<THIRD_PARTY_DOMAIN>` (`everyapp.dev`),
with a session per host (#314): the gateway classifies every request's host,
admits only dispatch rows on third-party hosts and only service-binding rows on
first-party ones, and hands a signed-in person to an app host with a single-use
code bound to a nonce cookie; the host's `__Host-everyapp_s` session is
re-checked against the gateway's session, membership, organization and app
access on every request. OpenSEO gets `AUTH_MODE=everyapp` (open-seo #983):
identity from the gateway, organization rows created from the token when
`EVERY_APP_ORG_ID` is unset (first-party) or pinned when it is set (a fork), a
deployment tier separate from the auth mode, OpenSEO's Autumn off, keys at the
gateway, and Google off until the gateway holds it. An Alchemy stage `everyapp`
deploys it on Postgres through Hyperdrive (open-seo #984), and open-seo #990
says whose every gateway call is and names the Workers as the gateway's registry
does. OpenSEO cannot serve a request through the hosted gateway until all three
merge; Ben merges them.

### The rulings the build follows

Ben, 2026-10-15, as recorded in the research README's "Founder answers so far":

> **D2, answered.** Two kinds of apps. _First-party_ apps (OpenSEO, and by
> default the rest of our catalog) are deployed by us into our own Cloudflare
> account as ordinary Workers with normal observability, use Every App identity
> and org membership, and are **multi-tenant on the back end** (OpenSEO: one
> Postgres database, org-scoped authorization in the app). Customers never own
> or touch that infrastructure. _Third-party_ apps are the only thing deployed
> to Workers for Platforms. [...] **OpenSEO must work on day one.**
>
> **D5 and D7, narrowed.** `app.openseo.so` production is not moved, migrated or
> touched. The Every App version of OpenSEO is a **second, separate deployment**
> (its own database, its own customers). Phase 3 (H35-H42, the cutover) is
> **dropped** [...].

Ben, 2026-10-16 07:02 UTC, in the thread "Port OpenSEO Auth to Every App"
(quoted in that thread's handoff):

> app.openseo.so will continue to operate as normal. On everyapp.com, we'll
> offer OpenSEO as one of the first-party apps. People will also be able to
> deploy forks of OpenSEO as third-party apps. This will likely mean 1-2 new
> AUTH_MODEs for OpenSEO; there may be slightly different logic for each. The
> first-party version will use 1 Postgres database; 3rd-party forks hosted on
> Workers for Platforms will use D1. Ideally the Google Client & Secret will be
> handled in the Gateway for both these new auth modes.

Standing rules from earlier briefs: billing and metering happen at the gateway,
not in the app; self-host keeps working from the same code; Every App is a
prototype with no backward compatibility (thecomeup.cc is reinstalled, not
migrated).

### The launch gate for third-party deploys

The switch is `platformPolicy(env).thirdPartyDeploys`: a hosted gateway with the
`THIRD_PARTY_DEPLOYS` secret exactly `on` (#311). Set it only when every row
below holds.

| Gate                                                                       | State                                                                                           |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Per-invocation limits and the default-deny `Outbound` on every dispatch    | Built (#304); the egress allowlist is always empty                                              |
| Identity audience = Worker name                                            | Built (#304)                                                                                    |
| A dispatched Worker's name bound to its row's organization                 | Follow-up from the #304 review                                                                  |
| The gateway binding's props pinned on every upload                         | Built for dispatch uploads (#311 rewrites them); a follow-up for CLI deploys (redesign stack 2) |
| Deployer binding allowlist and post-upload `GET /bindings` check           | Built (#311, merged), unverified live                                                           |
| Per-host sessions on third-party hosts                                     | Built (#314, merged), unverified live                                                           |
| `everyapp.dev` zone, wildcard DNS and the `*.everyapp.dev/*` Workers route | Not provisioned; set up by hand for now                                                         |
| `everyapp.dev` on the Public Suffix List                                   | Follow-up (submission)                                                                          |
| Capability calls refused for dispatch-tier rows by the row's tier          | Not built                                                                                       |
| The live Workers for Platforms checks in §7                                | Needs a live account                                                                            |

## 2. PR ledger

| PR            | Lane               | Title                        | Merge / state    | Scope                                                                                                          | Tests                               |
| ------------- | ------------------ | ---------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| #300          | hardening          | Tenancy hardening            | `49260eea`       | Duplicate session cookie refused; platform-domain OAuth checks; MCP supersede per org                          | gateway 525, perimeter 244          |
| #301          | cf-rest            | Cloudflare REST client       | `b6995272`       | `packages/cf-rest` for the deployer; dispatch namespaces in the fake Cloudflare                                | cf-rest 34, CLI 470                 |
| #303          | capabilities       | Phase 0, part 1              | `2456f4d3`       | Capability proxy, `integrationFetch`, OpenRouter in the AI proxy, `capabilities`                               | gateway 556, SDK 198                |
| #302          | foundations        | Hosted foundations           | `33c04d66`       | `platformPolicy(env)`, `setup --mode`, `apps.scope`, `organizations.status`                                    | gateway 539, CLI 456                |
| #308          | review fixes       | Reviewer follow-ups          | `2c834f1f`       | Cookie names required; D1 returns every result; blocklist by whole segment                                     | gateway 587, SDK 235                |
| #304          | dispatch-seam      | Dispatch seam and audience   | `5ac645f0`       | `DISPATCHER` branch, `Outbound` default-deny, `aud = workerName`                                               | gateway 588, perimeter 268          |
| #305          | signup             | Hosted sign-up               | `77b3638d`       | Open sign-up, personal orgs, email verification, mail budgets                                                  | gateway 627                         |
| #306          | helper-workers     | Phase 0, part 2              | `2d3d0b12`       | Helper Workers and their Durable Objects and Workflows                                                         | SDK 249, CLI 499                    |
| #307          | shared-apps        | Shared first-party apps      | `bbf904a8`       | `scope = 'shared'`, `deploy --shared`, `register`, AI cap per org, suspension                                  | gateway 653, CLI 512                |
| #309          | hyperdrive         | Hyperdrive and Postgres      | `aa75ddf4`       | `hyperdrive` resource, `database` provider, Postgres migrations, placement, `cpuMs`                            | CLI 518, SDK 256                    |
| #310          | background-org     | Background attribution       | `6b251463`       | `for:` on gateway calls, `x-everyapp-org` checked, capability cap per org                                      | gateway 668, SDK 261                |
| #311          | deploy-api         | Hosted deploy API            | `e328a5ce`       | Deploy keys, `/api/v1` deploy routes, binding rewrite and read-back, `deploy_jobs`                             | gateway 670, CLI 522                |
| #313          | deploy-api fixes   | #311 review fixes            | `1cf11f45`       | The six findings of #311's second review                                                                       | one failing-first test each         |
| #314          | 3p-hosts           | Third-party hosts            | `49ecb5b2`       | Host classifier, per-host sessions (nonce-bound single-use code), `HostSessionAuthenticator`, header stripping | perimeter 316, gateway 715, CLI 541 |
| open-seo #983 | openseo-mode       | `AUTH_MODE=everyapp`         | open, Ben merges | Ported mode, first-party tenancy switch, deployment tier, Google off                                           | 1,674                               |
| open-seo #984 | openseo-deploy     | Alchemy stage `everyapp`     | open, on #983    | Postgres and Hyperdrive stage, gateway binding script, runbook                                                 | 1,682                               |
| open-seo #990 | openseo-follow-ups | Attribution and Worker names | open, on #984    | `for` on every gateway call, `EVERYAPP_SHARED`, audience, Worker renames, SAM socket lifetime                  | 1,713                               |

Tests are the counts of the suites each PR touched most, at merge (or at the
last push for open PRs). Every PR also ran the whole repository's tests,
`types:check`, `knip` and `format:check` green, and CI was green at every merge.

How the night ran. A critique workflow (5 critics, 60 proposals, 80 adversarial
verdicts) produced the plan; the build workflow ran the lanes in worktrees under
`/tmp/ea`, each PR reviewed by a separate agent (approve, or fix and review
again: #302 and #307 took one fix round each, the other merged PRs were approved
on the first round; the findings on #309 and #310 are in §8; #311 was approved
in its second review at `961ad2b2` and merged as `e328a5ce` after a one-file
rebase conflict in the CLI's fake Cloudflare; its six findings were fixed in
#313, each with a test that fails on `e328a5ce`; the remaining nits of #313's
and #314's reviews go to a host-session follow-ups PR, branch
`hosted/host-session-followups`, number pending) and merged by a serialized
merge step after CI. No lane failed: the build workflow ran 46 agents, plus a
follow-ups workflow for #308, #313 and open-seo #990. Non-blocking review
findings went into #308 or into §8. Merge-time repairs, all test-only or
conflict resolutions recorded in each PR: #302 gave #303's integration-proxy
test a `scope`; #304 minted that test's identity for the Worker name; #305 added
`sessionCookieNames: []` to a test authenticator, which also repaired `main`'s
`types:check` after #308; #306 re-placed `EVERYAPP_AUDIENCE` in the refactored
`worker.ts` and updated two snapshots; #307 resolved seven conflicting files and
wired the capability route through its single `attributeCall`. GitHub
auto-closed #304 when its base branch was deleted; it was reopened and
retargeted to `main`. #314 merged after #313: `registerDispatchApp` takes both
the raw `THIRD_PARTY_DOMAIN` (which #313's `assertOwnDomain` checks, 503 on
overlap with `APP_BASE_DOMAIN`) and #314's validated one (null when it shares
the gateway's site, and then the app gets no hostname); the runbook and security
model state both.

## 3. Decisions taken without the founder

Grouped by PR. Each is what shipped, why, and how to walk it back. Decisions
that change no behaviour (names of internal helpers, test layout) are left out;
the PR bodies have them.

### #300 Tenancy hardening

- **A session cookie sent twice is refused with 401 `duplicate_session_cookie`**
  before CSRF and authentication, on every app route (public and bearer requests
  included) and on the gateway's host; both names (with and without `__Secure-`)
  count as one, and commas separate cookies. Why: fail closed; a browser
  carrying a planted cookie is locked out until it clears cookies. Walk back:
  skip public routes or bearers, count each name on its own, or treat a
  duplicate as signed out.
- **The 401 expires no cookie.** Why: the gateway can't know the planted
  cookie's domain or path. Walk back: add `Set-Cookie` expiries for the
  host-only and configured-domain variants.
- **MCP connections are superseded per organization** (rows and grants): a
  member of two organizations keeps one connection per organization for the same
  AI client. Walk back: drop the `organizationId` filter in `supersedeEarlier`.
- **`onPlatformDomain` replaces the gateway-host check**: OAuth clients on the
  gateway's host, `APP_BASE_DOMAIN` or their subdomains are refused, even when
  the gateway is loopback, and a trailing dot no longer slips past. Walk back:
  restore the gateway-host-only check in `mcp-auth/own-domain.ts`.
- **The ToolBus validator cache is keyed by registry row, reported catalog hash
  and tool name**, reused only for an identical schema text, since no
  gateway-computed hash exists. Walk back: drop the schema comparison, or add a
  hash column.

### #301 Cloudflare REST client

- **API token only**: the OAuth token source, refresh and PKCE from #257 were
  dropped. Why: the hosted deployer uses our own account's token. Walk back:
  restore `TokenSource` from `origin/claude/deploy-for-users`.
- **Retries**: 429 for every method; 5xx and network failures only for GET, PUT,
  DELETE and PATCH. Why: a failed POST may already have created a database or
  run SQL. Walk back: drop the `IDEMPOTENT_METHODS` check in
  `packages/cf-rest/src/client.ts`.
- **Client-side refusals before anything is sent**: an upload whose main module
  is missing or duplicated, tags containing `,`, `&` or `:`, more than 10 tags
  (#308), and `deleteByTags` without at least one required tag. Walk back:
  remove `assertTag` or the `deleteByTags` guard.
- **Delete-by-tag accepts a response with or without the envelope**
  (`envelopeOptional`), unverified live. Walk back: remove it once a live call
  shows the shape.

### #303 Capability proxy (phase 0, part 1)

- **Names**: the manifest key is `capabilities` (entries `{ access, why }`; the
  strict schema refuses `as`, `background` and `integrations`), while
  `/api/integrations`, `integrationFetch`, `integrationStatus` and the
  `integration_*` codes keep theirs. Walk back: rename in one sweep; nothing
  persists the names.
- **No background gate**: an org app's call without an identity, or with one
  that fails or names another organization, is served and counted to the app, as
  the AI proxy did. Shared apps no longer follow this (#307, #310). Walk back:
  401 `identity_invalid` for a bad identity.
- **DataForSEO's account-wide endpoints are refused** (`tasks_ready`, `id_list`,
  `errors`, `appendix/user_data`, `appendix/webhook_resend`). Since #308 the
  path is decoded until it stops changing and compared by whole segment, and
  non-ASCII paths are refused for DataForSEO. Why: one key serves every
  organization. Walk back: empty `accountWidePaths` in
  `packages/sdk/src/internal/capabilities.ts`.
- **The status probe tells only an app that lists a capability whether the
  gateway holds its key.** Walk back: compute `configured` without `requested`
  in `integration-proxy.ts`.
- **The proxy strips every `x-everyapp-*`, `x-api-key` and `x-user-*` header**,
  not only the identity headers. Walk back: trim `STRIPPED_HEADERS` and
  `STRIPPED_HEADER_PREFIX`.
- **The strict manifest accepts only the access levels a capability offers**
  (`read` for both providers) rather than downgrading `write`. Walk back: drop
  the access branch of the `superRefine` in `manifest.ts`.
- **AppGateway errors carry `x-everyapp-error`** in both modes, and the SDK owns
  the header and a `gatewayRefusal()` helper. Walk back: remove the header from
  `errorResponse` in `app-gateway-entrypoint.ts`.

### #302 Hosted foundations

- **An invalid or missing mode turns self-hosted behaviour off too**: no setup
  claim, Access sign-in, dynamic registration, app activation or account
  actions. Eleven test env mocks gained `GATEWAY_DEPLOYMENT_MODE`. Walk back:
  make `invalid` mirror `self_hosted` for existing capabilities in
  `platformPolicy`.
- **Local dev builds default the mode to `self_hosted`** (a dev-only text
  binding that a locally set `GATEWAY_DEPLOYMENT_MODE` overrides, checked with
  `vite dev`). Walk back: remove the binding and document the mode in
  `.dev.vars`.
- **The hosted gateway activates binding apps on their first request**, as
  self-host does. Walk back: `bindingActivation: false` for hosted.
- **`/api/auth/sign-in-methods` is its own Better Auth plugin** registered in
  every mode and also reports `signUp` and `emailVerification`. Walk back: move
  it back into the Access plugin.
- **Cloudflare Access is registered only on self-hosted**; a hosted gateway
  ignores `CLOUDFLARE_ACCESS_*` and `EMAIL_PASSWORD_SIGN_IN` and logs it, rather
  than refusing to start. Walk back: refuse to start when they are set.
- **Better Auth's 15 `/admin/*` endpoints are closed over HTTP in both modes.**
  Why: nothing calls them; admin pages go through the gateway's own server
  functions. Walk back: remove them from `DISABLED_AUTH_PATHS`.
- **On hosted an organization admin's Delete removes the membership and keeps
  the account**; deactivate, reactivate and password resets are refused
  (`ACCOUNT_ACTIONS_UNAVAILABLE`). Walk back: refuse `deleteUser` too through
  `requireTenantAdminUserActions()`.
- **The hosted claim names the install organization Every App** (slug
  `every-app`) whatever the claimant types. Walk back:
  `platformOrganizationName: null` for hosted.
- **A daily-cap override that isn't a whole number means 0** (that proxy stops
  for everyone). Walk back: fall back to the default in `dailyLimit()`.
- **The mode is recorded in `_everyapp_install.deployment_mode` and wins on
  every re-upload** (a deleted gateway Worker comes back hosted); `--mode` must
  match a live gateway's (`MODE_CHANGE_UNSUPPORTED`). Older install tables
  aren't migrated: thecomeup.cc's must be recreated. Walk back: use
  `options.deploymentMode` in `apply.ts`.
- **A row whose `tier` or `scope` the gateway doesn't know answers 503
  `app_unavailable`** instead of being coerced to `service_binding`. Walk back:
  restore the coercion in `rowToRegisteredApp`.
- **The schema change is a regenerated single baseline**
  (`0000_thankful_hex.sql`) adding `apps.scope` (default `org`),
  `organizations.status` (default `active`, not writable over HTTP) and a unique
  `members (organization_id, user_id)`. Walk back: an additive migration
  instead.

### #308 Reviewer follow-ups

- **Every authenticator must name its session cookies** (a type error otherwise,
  not a silent exemption from the duplicate-cookie refusal); the control plane
  logs `session.duplicate_cookie` too, and the app-host 401 tells the person to
  clear cookies. Walk back: make `sessionCookieNames` optional again.
- **`d1.query()` throws unless the API returns exactly one result**;
  `d1.queryAll()` returns them all. Walk back: return the first result again.
  (The blocklist change is under #303.)

### #304 Dispatch seam and audience

- **`aud` is the Worker name for every token the gateway mints**, first-party
  and self-hosted apps included (the plan kept the app id for those). The SDK
  answers 500 without `EVERYAPP_AUDIENCE` outside dev and the CLI refuses a
  build whose audience isn't the Worker name; no compatibility window, so a
  gateway upgraded before its apps are redeployed has them refuse identities
  until `everyapp deploy`. Walk back: let `audienceFor()` in
  `packages/sdk/src/server/everyApp.ts` fall back to the app id, and drop the
  policy check.
- **The dev gateway and dev ToolBus keep minting for the app id.** Walk back:
  emit a dev Worker name as `EVERYAPP_AUDIENCE` in dev.
- **The outbound option uses the Workers for Platforms parameter map**
  (`{ everyapp: {...} }`, service declared on the namespace binding) rather than
  the brief's `{ service, parameters }`. Walk back: one object literal in
  `dispatchFetcher()`.
- **Default dispatch limits are 5,000 ms of CPU and 200 subrequests, and the
  egress allowlist is empty**, so a dispatched app has no internet egress. Walk
  back: change `DEFAULT_DISPATCH_LIMITS`, or pass limits and egress from the row
  or manifest.
- **Egress allows only HTTPS to exact hostnames** (any port); the gateway-held
  providers' hosts and the gateway's own hosts are denied with their subdomains
  even when listed. Walk back: extend `decide()` in
  `apps/every-app-gateway/src/server/outbound.ts`.
- **The dispatch re-check reads the org key from the Worker name itself**
  instead of joining the row's organization (no schema change). Walk back: join
  `organization_keys` in `DrizzleAppRegistry` and check the real key.

### #305 Hosted sign-up

- **A personal organization is marked in `organizations.metadata`** as
  `{"personalFor": <user id>}`. Walk back: a column, backfilled from the
  metadata.
- **Exactly one personal organization per account**; members still can't create
  organizations, and people grow by invitation. Why: more organizations would
  multiply the per-organization caps. Walk back: allow creation behind a policy
  field with a count limit.
- **The personal organization and owner membership are one D1 batch in Better
  Auth's `user.create.after` hook**; on failure the user is deleted and sign-up
  answers 500 (an already-sent verification link then fails). Walk back:
  `createOrganization` with compensating deletes.
- **Open sign-up is refused until the setup claim**, so a stranger can't become
  the first owner. Walk back: make the claim look for the platform organization
  instead of any owner.
- **A hosted gateway without email refuses every sign-up with 503
  `EMAIL_NOT_CONFIGURED`** at first use, not at startup. Walk back: add a
  startup or `status` check.
- **The setup claim's owner is marked verified**, and server-side sign-ups get
  no verification mail. Walk back: send verification at the claim.
- **Verification mail failures are logged and swallowed**, and the resend
  answers the same whether or not it sent. Walk back: surface errors on the
  resend only.
- **Mail is counted before it is sent** (failed sends count), and unreadable
  counters send nothing. Walk back: count after success.
- **Mail budgets apply in both modes**: hosted 5 per address per kind per day
  and 2,000 verification, 1,000 reset and 2,000 invitation emails per gateway;
  self-hosted 10 and 1,000; invalid 0. Walk back: `Infinity` for self-hosted in
  `platformPolicy`.
- **Every session starts in an organization** in both modes: the personal one,
  else the last active one still held, else the first joined. Self-hosted users
  in several organizations now start in their last active one. Walk back: guard
  the session hook with `policy.personalOrgs`.
- **`HOSTED_OPEN_SIGNUP` opens sign-up only when unset or `"true"`**; any other
  value keeps it invite-only. Walk back: parse only `"false"`.
- **Verification links last 24 hours** (Better Auth's default is one hour) and
  sign the account in once. Walk back: `EMAIL_VERIFICATION_TTL_SECONDS`.
- **On hosted, invited sign-ups verify their email too, and only a verified
  account may invite** (`EMAIL_NOT_VERIFIED`). Why: an admin can hand an invite
  link to anyone. Walk back: mark the email verified when an emailed invitation
  is accepted.

### #306 Helper Workers (phase 0, part 2)

- **A helper's Workflows are named after the app's Worker**
  (`<worker>--<binding>`). Walk back: name them after the defining Worker in
  `classBindings` and `appWorkflows`.
- **Helpers share the app's D1 and KV, call the gateway with the app's props,
  and receive the app's secrets** on deploy and `secret set|unset`;
  `GATEWAY_URL` and `EVERY_APP_ORG_ID` go only to the app's Worker. Walk back:
  drop `secrets` from the helper deploy and the helper unset loop in
  `deployApp.ts`.
- **A deploy never deletes a helper the manifest dropped**; it warns
  `HELPER_WORKER_KEPT` and `delete --purge` removes it. Walk back: delete it
  after the upload behind a flag.
- **Moving a Durable Object class or Workflow between Workers, or dropping a
  helper's class, is refused** (`DURABLE_OBJECT_MOVED`, `WORKFLOW_NAME_TAKEN`,
  `HELPER_DURABLE_OBJECT_REMOVED`, which `--allow-delete-durable-object-data`
  doesn't cover). Walk back: helper tombstones and a move path.
- **In dev, `everyAppWorker()` declares the developer's provider and capability
  keys itself** (a copy of the key list, checked against the SDK's by a test),
  so apps no longer list them in `secrets`. Walk back: apps list the keys again.
- **The dev KV id is `<binding>-<worker>` only when an app declares helpers.**
  The claim that this is the Vite plugin's own default is unverified. Walk back:
  always set it in `storageBindings`.
- **`delete --purge` deletes the app's Worker before its helpers.** Walk back:
  change the order in `purgeApp`.
- **A helper uploads with `cf deploy --prebuilt --worker <full helper name>`**;
  the reviewer confirmed in cf's help that `--worker` selects by the config
  name, unverified live. Walk back: pass the output directory name.
- **Apps may keep `frame-ancestors 'self'` and `base-uri 'none'`** (both modes),
  for OpenSEO's report viewer. Walk back: force `'none'` again in `headers.ts`.

### #307 Shared first-party apps

- **An org app opens for a browser session acting under another of the person's
  organizations**, as their membership in the app's organization, in both modes
  (it was a 403). The authenticator returns the session to mint for. Walk back:
  a separate `sessionForApp` hook, or the old 403.
- **An app's scope never changes**: a deploy or `secret set|unset` that names no
  scope keeps the row's, an explicit contradiction is `APP_SCOPE_MISMATCH`, and
  a deleted shared app comes back shared. Walk back: fall back to `org` in
  `planRegistration`, or inherit only from rows that aren't deleted.
- **Only owners and admins of the platform organization deploy, redeploy,
  register or delete a shared app**, matched by the Cloudflare login's verified
  email; an API token passes as the account's own authority (so CI can deploy).
  Walk back: refuse API tokens in `assertPlatformAdmin`.
- **`register` requires the registry's Worker name**,
  `every-<platform org key>-<appId>` (`every-everyapp-openseo`), else
  `WORKER_NAME_MISMATCH`. Why: the gateway binds only names that follow the
  rule. Walk back: accept any non-reserved name for shared rows and let
  `desiredState` bind it.
- **`register` writes no ownership record**, so `delete --purge` keeps the
  Worker and a later `deploy --shared` of the same id is refused
  (`WORKER_NAME_TAKEN`). Walk back: record ownership at register.
- **Shared Workers get no `EVERY_APP_ORG_ID`** (SDK deploy input
  `shared: true`). Why: a pin to the platform organization would refuse everyone
  else. Walk back: send it again (two lines).
- **Suspension is a separate query cached 30 seconds** and applies to the
  organization acted under; a member of a suspended organization still opens
  their other organizations' apps. Walk back: fold status into the membership
  query, or refuse anyone with a suspended membership.
- **A shared app's provider calls (AI and capability) count against the
  organization in the verified forwarded identity**: invalid is 401, missing is
  403 (until #310). Walk back: attribute to the binding's props as for org apps.
- **The AI cap counts a request when it is let through, before the upstream
  call**, read then incremented: not atomic, and a call the app's own AI policy
  then refuses still counts. An unreadable counter is 500; an invalid mode is a
  cap of 0 (429). Walk back: an atomic `UPDATE ... WHERE count < limit` after
  the policy check, and 503.
- **Other organizations see shared apps read-only in Admin → Apps**, labelled
  "Every organization". Walk back: hide them there.

### #309 Hyperdrive and Postgres

- **Database URLs come from `.everyapp/secrets.env`** (gitignored):
  `POSTGRES_DATABASE_URL` for migrations, `<BINDING>_ORIGIN_URL` per config (an
  app with one config may use `POSTGRES_DATABASE_URL` for it); never in the
  Worker, argv, events or the ledger. Walk back: the constants in
  `lib/app/deploySecrets.ts`.
- **A config is named `<worker>--<binding>`; an unrecorded one of that name is
  adopted only if host, port, database and user match**, else
  `RESOURCE_NAME_TAKEN`. Walk back: remove the adopt branch in
  `provisionHyperdrive`.
- **A recorded config is updated only when host, port, database or user
  change**; a password-only rotation needs a manual `cf hyperdrive update`. Walk
  back: always update when an origin is present.
- **A Hyperdrive config binds every Worker of the app unless it names one
  helper.** Walk back: change the filter in the SDK's `addDatabaseBindings`.
- **A manifest field `database { provider, region }`**: `DATABASE_PROVIDER` as a
  text binding on every Worker of the app, and `region` as targeted placement
  (open-seo #984 chose smart placement; they disagree until OpenSEO moves to
  `everyapp deploy`). Walk back: `runtimeSettings` in `worker.ts`.
- **The dispatch tier refuses Hyperdrive, and an unknown tier is refused**
  (`manifestTierProblems`, `TIER_POLICY`). Walk back: delete the function and
  its call.
- **Postgres migrations have no rollback command**; the database's own backups
  are the way back.

### #310 Background attribution

- **`for` replaces `request` on `createGatewayFetch` and `integrationFetch`**,
  with no alias: `for: request` forwards the identity,
  `for: { background: true, organizationId }` sends `x-everyapp-org`. Walk back:
  re-add `request` as a synonym.
- **`for` is optional; only a shared Worker must give it**, detected by
  `EVERYAPP_SHARED=1` (set by the SDK builder on shared deploys and printed by
  `register`), and the SDK refuses when the fetch is created. Walk back: make
  `for` required, or delete the shared check.
- **A background organization must be active and have a member who isn't
  banned** (pending or unverified members count); cached 30 seconds for a yes
  and 5 for a no. Walk back: add a status or `emailVerified` condition in
  `OrganizationRepository.isAttributable`.
- **An org app's `x-everyapp-org` naming another organization is 403
  `caller_org_mismatch`**, and an identity and a header that disagree are
  refused too. Walk back: ignore the header for org apps.
- **Attribution and the capability cap run right before the provider call**, so
  status requests and the proxy's own refusals need no organization and spend
  nothing; a shared caller with a bad identity asking for an unlisted capability
  now gets 403, not 401. Walk back: attribute and count before the proxy.
- **One capability cap (500 a day) covers DataForSEO and Context.dev together**,
  sharing `org_daily_cap_exceeded` with the AI cap; an invalid mode refuses
  capability calls with 429. Walk back: a cap per capability, or a `kind` field
  in the body.

### #311 Hosted deploy API (`e328a5ce`)

As of its fix round (second review approved at `961ad2b2`).

- **The gate is a hand edit**: `thirdPartyDeploys` needs a hosted gateway and
  `THIRD_PARTY_DEPLOYS` exactly `on`, which `secret set --for gateway` refuses
  to set; without it `/api/v1/*` falls through to the control plane as before,
  so self-host is unchanged. Walk back: add the name to
  `SETTABLE_GATEWAY_SECRETS`.
- **A deploy key is a personal access token whose only scope is `deploy`**, for
  owners and admins only, 30 days by default, with live membership, ban and
  suspension checks; it opens no app and no `/mcp`, even its owner's, and can be
  created only where the gate is open. Why: a leaked CI key must not act as the
  person. Walk back: drop the deploy-scope refusal in
  `betterAuthAuthenticator.ts`.
- **`GET /api/v1/deploy-key` was added beyond the spec's three routes**, so the
  CLI learns the key's organization. Walk back: an organization flag or
  variable.
- **Registration is a separate call before the build**; the deploy route answers
  404 for an app that isn't registered. Why: the hosted policy refuses a
  manifest before a long build. Walk back: register inside the deploy route.
- **No queue or Durable Object**: the deploy runs in the POST with `waitUntil`,
  returning the finished job under 20 seconds or `running` for the CLI to poll;
  one running job per app (a conditional insert into the new `deploy_jobs`
  table); a job still running past its 5-minute deadline reads as
  `DEPLOY_ABANDONED`, and the CLI polls for up to 6 minutes. Walk back: a
  deployer Durable Object or a Queue consumer.
- **The deployer rewrites every binding it allows and refuses the rest**:
  identity keys, audience, `EVERY_APP_GATEWAY` with props
  `{ organizationId, appId, workerName }`, the D1 it created, its own Durable
  Objects, assets and version metadata; anything else (other service bindings,
  KV, R2, Hyperdrive, AI, email, foreign Durable Objects, crons, routes,
  placement, Workflows, helper Workers) is refused. Walk back:
  `buildUserWorkerMetadata()` and `bundleProblems` in
  `server/deploy/metadata.ts`.
- **A `GET /bindings` read-back that differs from what was sent deletes the
  script and fails the job.** It compares only the fields the deployer sent,
  plus a Durable Object binding's `script_name`. Unverified live: if Cloudflare
  echoes bindings in another shape, every upload is deleted. An `assets` binding
  with no asset files is refused. Walk back: log instead of delete.
- **Third-party limits**: 5,000 ms of CPU, 200 subrequests, at most 2 Durable
  Object classes (migrations tagged `everyapp-v<n>`, a dropped class refused);
  static assets allowed; compatibility flags limited to `nodejs_compat`,
  `nodejs_compat_v2`, `nodejs_als` and `global_fetch_strictly_public`. Walk
  back: `THIRD_PARTY_LIMITS` in `platform-policy.ts` and
  `ALLOWED_COMPATIBILITY_FLAGS`.
- **Only `GATEWAY_URL` and `EVERY_APP_ORG_ID` are written, as plain text**; any
  other secret or variable in the build is refused. Why: third-party secrets
  aren't designed yet. Walk back: allow `text` and `json` in `bundleProblems`
  and add a secrets API.
- **The app's D1 is recorded in the CLI's resource ledger**
  (`_everyapp_app_resources`), not a new column, so `everyapp delete --purge`
  sees it, and found by name (`findDatabase` over cf-rest's `d1.findByName`)
  under the CLI's rules: a database of that name the app didn't create is
  `RESOURCE_NAME_TAKEN`, and one that replaced the recorded database is
  `RESOURCE_REPLACED`. Walk back: an `apps.resources` column.
- **Without `THIRD_PARTY_DOMAIN` a deploy is accepted with no hostname**; a
  later deploy names it. Walk back: refuse deploys without a domain.
- **An app's tier never changes** (`APP_TIER_MISMATCH` in `planRegistration`,
  shared plus dispatch included). Walk back: allow an explicit tier change.
- **Bundles are built with the sentinel Worker name `every-hosted--sentinel`**
  (never a registry name), which the deployer requires; the version id is the
  upload's etag and the actor `deploy-key:<token id>`. Walk back: the hosted
  deploy contract in `packages/perimeter/src/manifest/deploy.ts`.
- **`EVERYAPP_DEPLOY_TOKEN` switches `everyapp deploy` to the hosted deploy**,
  and then refuses self-host-only flags and a missing gateway URL. The fix round
  renamed it from `EVERYAPP_TOKEN`, which the docs use for the MCP bearer. Walk
  back: a `--hosted` flag instead of the variable.
- **`CF_DEPLOY_TOKEN` lives in the public gateway Worker** for the preview,
  behind `DeployerPort`; the plan put it in a thin deployer Worker. Walk back:
  that Worker (a follow-up).

### #313 Deploy API review fixes (`1cf11f45`)

All six findings of #311's second review, each with a test that fails on
`e328a5ce`.

- **The hosted pipeline runs every static check, then creates or adopts the D1,
  uploads assets and builds the whole upload metadata, before `migrate()` and
  the Worker upload**, as the self-host deploy does, so a refused bundle no
  longer leaves the schema advanced. Walk back: move `uploadAssets` and
  `buildUserWorkerMetadata` after `migrate()`.
- **A deploy key must have exactly the scopes `["deploy"]` when it is used**,
  not merely include `deploy`. Walk back: the old "includes" check in
  `server/deploy/auth.ts`.
- **The job starts before `register()` changes the row**, and a registration
  that fails after that records the job as failed (an audit trail of the
  attempt). Walk back: register first, as before.
- **A failure to record a job's outcome logs `deploy_api.deploy_unrecorded`**,
  and the job reads `DEPLOY_ABANDONED` at its 5-minute deadline. Walk back:
  retry the write.
- **`assertOwnDomain` refuses a `THIRD_PARTY_DOMAIN` equal to, under or above
  `APP_BASE_DOMAIN`** with 503 `DEPLOYER_NOT_CONFIGURED`; the check is skipped
  when `APP_BASE_DOMAIN` is unset, and it doesn't compare `GATEWAY_URL`'s host.
  Siblings on one registrable domain need a Public Suffix List check (a
  follow-up). Walk back: drop the check.
- **The CLI's success line says the app takes bearer tokens only, until per-host
  sessions exist**; the runbook says the namespace must be in the gateway's own
  account. #314 has since added per-host sessions, and the line still says
  bearer only (a follow-up).

### #314 Third-party hosts (`49ecb5b2`)

- **The gateway classifies every request's host first** (`routeHost` in the
  perimeter: control plane, first party, third party one label below
  `THIRD_PARTY_DOMAIN`, or not found). Only dispatch, organization-scoped rows
  open on third-party hosts and only service-binding rows on first-party hosts;
  a row on the wrong class of host is a 503, in both modes, and an unknown
  third-party host is a 404. Walk back: `hostAdmitsApp` in `hostRoutes.ts`.
- **"A different site" means the last two labels of `THIRD_PARTY_DOMAIN` differ
  from the gateway host's and `APP_BASE_DOMAIN`'s** (no Public Suffix List, so a
  `co.uk` pair may be refused), and only on hosted. Walk back: a PSL lookup in
  `thirdPartyDomain(env)`.
- **The handoff**: an unauthenticated navigation on an app host sets a nonce
  cookie (`__Host-everyapp_n`) and goes to the gateway's `/app-session`, an
  auto-posting page under a nonce CSP, so the control plane's CSRF guard covers
  the POST; `/app-session/start` checks the row, membership and access and
  returns a 60-second code bound to the nonce; the app host exchanges it once
  and sets `__Host-everyapp_s`. Other unauthenticated requests get 401, a failed
  exchange is a 400 page (no loop), and tabs reuse the nonce for 10 minutes.
  Walk back: mint on GET, or show a "Continue to <app>?" button instead of
  auto-submitting.
- **Host tokens and codes are HMACs keyed by HKDF from `BETTER_AUTH_SECRET`**
  (no new secret; rotating it ends every host session). Walk back: a separate
  `HOST_SESSION_SECRET`.
- **Codes are stateless, single use through `rate_limit_counters`
  (`claimOnce`)**, with no new table. Walk back: an `app_session_codes` table.
- **Host sessions last 24 hours, but revocation is immediate**:
  `HostSessionAuthenticator` re-reads the gateway session row, ban, membership,
  organization status and `user_app_access` on every request. Walk back: shorter
  sessions, or cache the reads.
- **Personal access tokens work on third-party hosts under first-party rules**;
  any other bearer is nobody. Walk back: refuse bearers on third-party hosts.
- **Responses from third-party hosts lose `Access-Control-Allow-Credentials` and
  any `__Host-everyapp_*` `Set-Cookie`.** Walk back:
  `stripThirdPartyAppHeaders`.
- **`Outbound` denies `THIRD_PARTY_DOMAIN` and everything under it.** Walk back:
  drop it from the reserved hosts in `outbound.ts`.
- **Third-party hosts are served by one hand-made Workers route
  `*.<THIRD_PARTY_DOMAIN>/*` and a proxied wildcard DNS record**, not per-app
  Custom Domains, so the gateway's release config is unchanged. Unverified
  whether `everyapp setup` or a gateway redeploy keeps a hand-made route. Walk
  back: per-app Custom Domains through the CLI.

### open-seo #983 `AUTH_MODE=everyapp` (open)

- **One `AUTH_MODE=everyapp` with two shapes chosen by `EVERY_APP_ORG_ID`**, not
  a second mode. Why: identity is the same, and each mode is a separate client
  build. Walk back: an `everyapp_fork` mode.
- **First-party organization rows use the gateway's organization id**, the name
  `Organization <first 8 characters>` and the slug `everyapp-<hex>`. Why: the
  token has no organization name. Walk back: an `org_name` claim.
- **The member row only mirrors the gateway**; organization and role come from
  the signed token on every request, and tool calls stay pinned to the
  organization. Walk back: remove the `upsertMember` call.
- **`DEPLOYMENT_TIER` is read only under `AUTH_MODE=everyapp`.** Walk back: let
  it override in every mode.
- **A new `every_app` audit tier**: 10,000 pages, 100,000 capacity units, 2
  running audits per organization, for first party and forks. Walk back: edit
  `AUDIT_LIMITS.every_app`.
- **Plan gates the gateway can meter stay open** (paid-plan checks on rank
  checks and AI search, and credit checks); the gateway's daily cap bounds the
  preview. Walk back: make `requireRankCheckAccess` and `assertPaidAiSearchPlan`
  read the tier.
- **Scheduled rank checks and AI visibility are off in first party unless
  `FIRST_PARTY_SCHEDULED_CHECKS=on`.** Why: background calls carried no
  organization before #310. open-seo #990 reverses this default (below).
- **Research spend is a `[research-spend]` log line per organization**, not an
  Autumn charge. Walk back: delete `logGatewayMeteredSpend`.
- **OpenSEO's own MCP, API keys, invitations, ownership transfer, organization
  switcher, Autumn and Google connect are off** in `everyapp` mode; its Google
  callbacks answer 404. Walk back: per feature, once the gateway provides it.
- **Every `Set-Cookie` is dropped behind the gateway.** Walk back: filter by
  cookie name in `src/server/everyapp/cookies.ts`.
- **"Sign out on Every App" opens the gateway home**, which has no GET sign-out
  URL. Walk back: point it at a gateway `/sign-out` page once one exists.

### open-seo #984 Alchemy stage `everyapp` (open)

- **A script patches both Workers' settings after every Alchemy deploy to add
  the `EVERY_APP_GATEWAY` binding with its props**, because Alchemy can't
  express service-binding props and replaces the whole binding set. Walk back:
  bind it in the stage once Alchemy supports props, and delete the script.
- **The stage builds from `wrangler.jsonc`** (the Every App Vite plugin only
  when mode isn't `everyapp`). Walk back: drop the clause when OpenSEO moves to
  `everyapp deploy`.
- **`AUTH_MODE=everyapp` and the `everyapp` stage must come together**; the
  deploy dies otherwise. Walk back: delete the check in `readEveryAppStage`.
- **The stage keeps its KV, R2, Workers and Hyperdrive on destroy**, like
  production. Walk back: retain only for prod.
- **No D1 and no `OAUTH_KV`**: it runs on Postgres and the gateway serves MCP.
  Walk back: bind them.
- **The audit Worker's gateway props name the app Worker** as `workerName`, and
  both Workers get the binding. Walk back: name the audit Worker.
- **Smart Placement**, because the database region is unknown (conflicts with
  #309's targeted placement). Walk back: targeted placement for the stage.
- **The runbook is at `docs/EVERY_APP_DEPLOYMENT.md`**, a public docs path in
  that repository. Walk back: move it to `docs/maintainers/`.

### open-seo #990 OpenSEO follow-ups (open)

Stacked #983 → #984 → #990; Ben merges. It links the SDK from `main` at
`6b251463`.

- **Attribution is two async-context scopes ("the request being served" and "the
  organization named"), not a `for` argument on every fetcher.** Request paths
  forward the identity (`src/server/lib/gateway-attribution.ts`); the Workflows
  name their payload's organization around `run()` and `pgStep` carries it into
  each step; SAM names its session's organization; the DataForSEO metering seam
  and the services that hold a customer name it; the crons start Workflows that
  carry the organization; status checks send none. Why: the DataForSEO transport
  sits three layers below the code that knows the organization (about 40
  fetchers). A missed path throws `AttributionError` before the call leaves, so
  it fails closed rather than misattributing. Walk back: an `organizationId` on
  `DataforseoRequestOptions` and the fetchers, and delete the scopes.
- **Inside a request, a call naming another organization is refused.** Walk
  back: delete the check in `gatewayCallFor`.
- **A request still working within 15 seconds of its identity's 120-second
  expiry goes on as background work for its own verified organization**
  (`x-everyapp-org`) instead of meeting the gateway's 401. Walk back: forward
  the request regardless of expiry.
- **SAM resolves its organization on each model call**, because the model is
  built before the turn loads its session; a missing binding now fails the turn
  when the model calls out. Walk back: return the model from `beforeTurn` with
  the loaded organization.
- **The gateway's daily-cap refusal reaches people as `RATE_LIMITED`**, not
  retried; an unconfigured key is `DATAFORSEO_AUTH_FAILED`, anything else
  `AUTH_CONFIG_MISSING`. Walk back: drop that branch in `gatewayRefusalError`.
- **Scheduled rank checks and AI visibility run by default in first party**;
  `FIRST_PARTY_SCHEDULED_CHECKS=off` holds them (reversing #983). The caps don't
  fit this yet: one 300-keyword, two-device rank tracker is 600 capability calls
  against 500 a day, and one SAM turn can be 40 of the 200 AI-proxy requests.
  Either the caps rise before launch or the launch setting is `off` (in
  `TODO.md`, Decide). Walk back: `=== "on"` in `scheduledChecksEnabled`; the
  caps are `INTEGRATION_ORG_DAILY_LIMIT` and `AI_PROXY_ORG_DAILY_LIMIT` on the
  gateway, with their defaults in `platform-policy.ts`.
- **Both Workers get `EVERYAPP_SHARED=1`; only the app Worker gets
  `EVERYAPP_AUDIENCE=every-everyapp-openseo`**, since the audit helper verifies
  no tokens. Walk back: set the audience on both.
- **The Workers are `every-everyapp-openseo` and
  `every-everyapp-openseo--audit`**, and `EVERYAPP_WORKER_NAME` overrides the
  name when the platform organization's key isn't `everyapp`; Hyperdrive, KV,
  R2, Durable Object and Workflow names keep `open-seo-everyapp`. Walk back:
  drop the override and hard-code the name.
- **Each SAM WebSocket closes 15 minutes after it connects** (a Durable Object
  alarm, close code 1000, so the client reconnects through the gateway, which
  re-checks the member), instead of a membership check per turn. Walk back:
  delete `samSocketLifetime.ts` and its hooks.
- **The runbook's platform-organization query follows the CLI's rule** (the
  oldest organization with an owner), and its identity-key SQL stays as it was
  (correct for `main`).
- **The preflight requires `EVERYAPP_AUDIENCE`** (or `EVERYAPP_DEV`), so it no
  longer passes a Worker that answers 500. Walk back: the old `EVERYAPP_APP_ID`
  check.

## 4. What was cut or deferred and why

- **The money lane and the wallet.** Keys sit at the gateway, OpenSEO's Autumn
  is off, and a per-organization daily request cap (AI 200, capabilities 500)
  stands in for metering. Why: about 20 engineer-days that cannot be tested
  without Autumn and provider accounts, and nothing in the rulings needs money
  before the invite-only preview. This replaced the plan's "OpenSEO keeps its
  own Autumn" after the handoff restated that billing happens at the gateway.
  Walk back: re-enable OpenSEO's Autumn in `everyapp` mode (one predicate), or
  build the `BillingPort` the plan pins.
- **The grants table.** A manifest's capability listing is the grant, as for AI
  providers. Why: approvals have no reader until third-party code exists. Walk
  back: `app_capability_grants` keyed by the app row (redesign stack 1).
- **Install rows for first-party apps.** Shared apps are `apps.scope = 'shared'`
  rows owned by the platform organization; access is live membership in an
  active organization. Why: an install row was only a per-organization off
  switch nobody needs on day one. Walk back: `org_app_settings (org_id, app_id)`
  when per-organization hide or caps are wanted.
- **An organization column on catalog apps.** Todo, chef and workout stay keyed
  per user, so a person in two organizations sees the same data in both. Walk
  back: add `organization_id` the day an app gains organization-shared data.
- **The tenant-neutral bundle refactor** (plan PR 9). Why: the deployer rewrites
  bindings at upload anyway, and the refactor would have collided with the other
  thread's `worker.ts` work. Walk back: placeholder bindings patched at upload,
  as the plan describes.
- **Per-host sessions only on third-party hosts.** First-party apps share the
  control plane's cookie (`Domain=app.everyapp.com`, today's self-host shape);
  `__Host-` sessions per host exist only on third-party hosts under
  `everyapp.dev` (#314). Walk back: none needed for first party.
- **Google at the gateway.** Designed in
  [design/2026-10-google-integration.md](design/2026-10-google-integration.md)
  (PR 0 to 11, about 19 agent-days); OpenSEO's own Google is off in `everyapp`
  mode. Why: Google verification is the external critical path, and nothing can
  be tested without the project. It is the next large piece of work.
- **The agent.** Deferred by the plan, although it is the vision's first
  sentence.
- **Organization deletion, export, leave and transfer.** Deletion is a support
  action; personal organizations can't be left or deleted. Why: the customers
  this protects don't exist yet.
- **Publishing the SDK and CLI.** Paused since 2026-10-13; work from the
  checkout. Third-party apps need it back on npm.
- **Also not built**: Turnstile, disposable-domain and social sign-in; legal
  pages (Terms, AUP); email bounce handling; the scheduler and step runner for
  third-party background work; the reserved labels of plan PR 5 (#314 built its
  host classifier); `usage_events` and `audit_events` tables.

## 5. Rejected by the adversarial pass

- **Per-organization hostnames for shared apps** (`<app>-<orgKey>.…`): they
  break OpenSEO's Google OAuth redirect URIs and the single-host assumption of
  first-party apps.
- **Keeping OpenSEO's own `/mcp` and API keys live in `everyapp` mode**: they
  authorize from OpenSEO's member rows, so a member the gateway removes would
  keep access.
- **Replacing a grants table with an `approved_manifest` column** as written:
  nothing populates it on self-host, so chef's AI calls would fail. Grants were
  deferred entirely instead.
- **An `EVERY_APP_ORG_ID` pin instead of `aud = workerName`**: the pin is set on
  every deploy and would refuse every other organization of a shared Worker, and
  alone it fails open for dispatch. The audience change stays.
- **"OpenSEO's mode is one auth branch, no gateway change"**: without the
  shared-app row and access rule every customer organization is refused on day
  one.
- **Org-from-host for every tier**: per-organization hosts break OAuth, and
  dropping `x-everyapp-org` leaves cron-driven Workflows with no organization.

## 6. How to install the hosted gateway and deploy OpenSEO

In order. Each step points at the document that has the commands.

1. **Decide the Cloudflare account** (existing or a new one for everyapp.com,
   §7). The gateway, every first-party Worker and OpenSEO's Hyperdrive config
   must be in the same account: service bindings don't cross accounts.
2. **Install the gateway**:
   [runbooks/hosted-install.md](runbooks/hosted-install.md) §1,
   `pnpm everyapp setup --domain app.everyapp.com --mode hosted`. Until a first
   upload has succeeded, pass `--mode hosted` on every run: a resumed run
   without it installs `self_hosted` and keeps it (the runbook now says so; the
   fix is a follow-up from the #302 review).
3. **Gateway settings**: the same runbook §2. Email (`EMAIL_FROM`,
   `EMAIL_FROM_NAME`, `EMAIL_REST_API_TOKEN`), the provider keys
   (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `DATAFORSEO_API_KEY`,
   `CONTEXT_API_KEY`) and `HOSTED_OPEN_SIGNUP=false` for the preview, each with
   `pnpm everyapp secret set <NAME> --for gateway`.
4. **Claim the owner** (§3): the platform organization is created and named
   Every App; `pnpm everyapp status` shows `Mode: hosted`.
5. **First-party apps from this repository** (§4):
   `pnpm everyapp deploy --shared` in `apps/todo-app`, `apps/chef` and
   `apps/workout-tracker`, from a Cloudflare login that is an owner or admin of
   Every App by verified email, or with an API token.
6. **OpenSEO**: after Ben merges open-seo #983, #984 and #990, follow the
   OpenSEO repository's `docs/EVERY_APP_DEPLOYMENT.md`: a new PlanetScale
   database migrated with `POSTGRES_DATABASE_URL=<url> pnpm db:migrate:pg`
   (never without the variable: it falls back to `.env.local`), `.env.everyapp`
   with the gateway's identity key
   (`SELECT jwt_public_key FROM _everyapp_install WHERE id = 'install'`, which
   matches `main`'s install table), then `pnpm deploy:everyapp:first-party`.
7. **Register OpenSEO**:
   `pnpm everyapp register openseo --worker every-everyapp-openseo --shared --manifest ../open-seo/everyapp.config.ts`,
   and again after every OpenSEO deploy so the registry records the new version.
8. **Worker names**: the registry names a shared app's Worker
   `every-<platform org key>-<appId>`, and the Every App organization's key is
   `everyapp`, so OpenSEO's app Worker must be `every-everyapp-openseo` and its
   audit helper `every-everyapp-openseo--audit` (the helper rule
   `<worker>--<name>`). open-seo #990 names them so (#984 alone still says
   `open-seo-everyapp`, which `register` refuses with `WORKER_NAME_MISMATCH`);
   `EVERYAPP_WORKER_NAME` in `.env.everyapp` overrides the name if the platform
   organization's key turns out not to be `everyapp`.
9. **Checks**: the runbook's "Checks" section, then §7 below.

Later, OpenSEO moves to `everyapp deploy` from its manifest, now that #309 has
merged (the manifest additions are in §8), and the Alchemy stage goes.

## 7. Needs a live account, and the morning ops list

Nothing below could be verified tonight: the only Cloudflare connection was
read-only and no namespace, Hyperdrive config, PlanetScale database or Google
project exists.

Morning ops list, in order:

1. **Google** (the external critical path): create the Every App Google Cloud
   project and Web client, DNS-verify everyapp.com in Search Console, host the
   homepage and privacy policy on everyapp.com, record the demo video, and
   submit brand and scope verification (`webmasters.readonly`,
   `analytics.readonly`). Brand review takes 2 to 3 business days plus up to 10
   for scopes.
2. **Cloudflare account**: decide the existing account or a new dedicated one
   (the build assumed the existing one; the other thread's default is a new
   one), then create a write-scoped API token for it.
3. **Workers for Platforms** in that account, and a dispatch namespace, for the
   third-party live checks; then `CF_DEPLOY_TOKEN`, `DISPATCH_NAMESPACE` and
   `THIRD_PARTY_DOMAIN` as gateway settings. Then the `everyapp.dev` zone with a
   proxied wildcard DNS record and a Workers route `*.everyapp.dev/*` to the
   gateway, both by hand for now. Leave `THIRD_PARTY_DEPLOYS` unset until those
   checks pass.
4. **PlanetScale**: a new Postgres database for the first-party OpenSEO (not
   app.openseo.so's), and its region (decides placement).
5. **Hyperdrive**: created by the OpenSEO deploy from the database URL; needs
   the token above.
6. **Email Sending** onboarded for the gateway's sender domain
   ([runbooks/email-sending-setup.md](runbooks/email-sending-setup.md)).
7. **Gateway secrets**: `DATAFORSEO_API_KEY`, `CONTEXT_API_KEY`,
   `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, and the email settings.
8. **Public Suffix List**: submit `everyapp.dev` (a lead-time item, needed
   before outside organizations get third-party hosts).

What each live account then checks (also in `TODO.md`, "Check on the first live
deploy"):

- **Cloudflare write token**: the hosted install end to end, Custom Domain
  certificates for each `<app>.app.everyapp.com`, `deploy --shared` and
  `register`, a shared app opening for members of two organizations, suspension
  within 30 seconds, the daily caps' 429 with `Retry-After`.
- **Email Sending**: verification mail over the REST path, the `/verify-email`
  redirect and one-time sign-in on the real domain and cookie scope.
- **Workers for Platforms**: the `DISPATCHER` binding with the gateway's
  `Outbound` entrypoint as the namespace's outbound Worker (whether a named
  entrypoint of the gateway Worker is accepted), outbound parameters reaching
  it, the "Worker not found" wording, dispatch limits, props on an upload-time
  service binding from a namespaced script (a namespaced Worker binding
  `AppGateway` with props), `GET /bindings` echoing props and bindings in the
  shape the deployer sent, Durable Object migrations and the assets upload
  session for namespaced scripts, real `cf build` output passing the deploy
  API's bundle checks, and the REST client's unverified shapes (delete-by-tag
  response, missing or duplicate namespace codes, tag filters with colons,
  boolean D1 parameters).
- **Hyperdrive and PlanetScale**: `cf hyperdrive create --body @file` output and
  duplicate-name wording, list pagination, a deploy with `placement.region` and
  `limits.cpuMs`, `cf dev` with a Hyperdrive binding, OpenSEO's Postgres
  migrations and its organization and member upserts on Postgres (never run on
  Postgres), the 30-connection origin limit.
- **OpenSEO stage**: `PATCH /workers/scripts/:name/settings` accepting props on
  a service binding while `inherit` keeps the Durable Object, Workflow, assets,
  Hyperdrive, rate-limit and version-metadata bindings; SAM's WebSocket through
  the gateway with the identity header; a background call with `x-everyapp-org`
  from a cron or Workflow.
- **Helper Workers**: the Vite build's auxiliary Worker output and
  `cf deploy --prebuilt --worker`.
- **Browsers**: #314's handoff in real browsers (`__Host-` cookies,
  `SameSite=Lax` on the 303 back to the app host, the CSP's `form-action` on the
  redirect after the POST, Safari), and cookie-tossing variants on real hosts.
- **Third-party domain**: whether `everyapp setup` or a gateway redeploy keeps
  the hand-made `*.everyapp.dev/*` route.

## 8. Follow-ups

### Done

- [x] #308: authenticators must name their session cookies, the control plane
      logs the duplicate-cookie refusal, and the app-host 401 tells the person
      to clear cookies (from the #300 review).
- [x] #308: `d1.query()` returns exactly one result or throws, `d1.queryAll()`
      returns all, and more than 10 tags are refused (from the #301 review).
- [x] #308: the DataForSEO blocklist matches whole segments after repeated
      decoding; `integrationStatus` guards unknown ids like `integrationFetch`;
      the SDK's `env.d.ts` and two docs pages name the new keys (from the #303
      review).
- [x] This PR: the CLI reference's shared-app paragraph describes the final
      scope rule (a redeploy without `--shared` keeps a shared app shared;
      deletes need a platform owner or admin), from the #307 round-2 review.
- [x] This PR: `docs/security-model.md` says how identity is bound to an
      organization since shared apps, how a shared app's capability calls are
      attributed, and what the dispatch re-check checks.
- [x] This PR: the hosted-install runbook warns that `--mode hosted` must be
      passed on every run until the first upload succeeds, and no longer says
      three provider keys await the integration proxy.
- [x] #313: the six findings of #311's second review, each with a test that
      fails on `e328a5ce` (§3).
- [x] #314: third-party host sessions name their cookie (`__Host-everyapp_s`) to
      the duplicate-cookie refusal.
- [x] Checked: the OpenSEO runbook's SQL for the identity key matches `main`'s
      install table, and `everyapp secret set NAME --for gateway` is `main`'s
      command; the #984 reviewer read the older handed-over CLI.

### The OpenSEO follow-up PR: open-seo #990 (open)

Built, as listed for it here before: every gateway call says whose it is (§3),
`EVERYAPP_SHARED=1` on both Workers, the SDK linked from `main` with
`EVERYAPP_AUDIENCE` on the app Worker and the tests minting for the Worker name,
the Workers renamed with the binding props, runbook and env example to match,
the Cloudflare API error read as text first, `CapabilityId` in place of
`IntegrationId`, scheduled checks on by default, and SAM sockets closed after 15
minutes. Tests: 1,713 passed (31 new); types, lint, knip and format clean; the
`everyapp` build passes.

Still to do on the OpenSEO side:

- Decide the daily caps against OpenSEO's real volume before launch (`task_get`
  polling for rank checks and AI visibility, SAM's per-step AI calls): raise the
  caps, count free `task_get` reads differently, or launch with
  `FIRST_PARTY_SCHEDULED_CHECKS=off`.
- Move OpenSEO to `everyapp deploy` (#309 has merged):
  `resources.hyperdrive [{ name: "HYPERDRIVE" }]`,
  `database { provider: "postgres", region }`, Postgres `migrations` with
  `dir: drizzle/pg` and its config,
  `workers [{ name: "audit", binding: "AUDIT_ENGINE", limits: { cpuMs: 300000 } }]`;
  then delete the stage, `.env.everyapp`, the binding script and the
  `vite.config.ts` clause.
- Chain `pnpm everyapp register openseo ...` after each stage deploy so the
  registry records the new version, and decide whether the runbook moves to
  `docs/maintainers/`.
- A membership check per SAM turn at the gateway, if 15 minutes is too long.
- Copy: the SAM setup gate and banners say "an admin sets it on the gateway",
  which fits self-host better than the hosted preview; and a gateway GET
  sign-out page for the account menu.

### Every App code follow-ups

Shared apps, attribution and caps:

- `everyapp register` lists `EVERYAPP_AUDIENCE` (the Worker name) in
  `data.worker`, next to the identity keys and binding props: an externally
  built Worker needs it since #304 (found while writing this).
- Count the AI daily cap after the app's AI policy check, atomically; run
  `assertSharedApps` before `register()` writes for an inherited shared scope.
- A UI or CLI command to suspend and reactivate an organization (today a D1
  `UPDATE`).
- On a mismatch, log the asserted `x-everyapp-org` and the identity's
  organization; tighten the `orgSource` type (#310 nits).
- `everyapp dev`'s gateway-lite serves `/api/integrations` and `/api/ai`, so the
  `x-everyapp-org` path runs locally.
- Once the wallet exists, metering replaces `orgDailyCaps` for both kinds.

Install and policy:

- A hosted install resumed before its first upload keeps `--mode hosted` (record
  the mode with the pre-upload row), and `assertModeUnchanged` words the no-mode
  case; `everyapp setup` resends a missing mode secret from the install row.
- Admin → Users hides or rewords the account actions the hosted policy refuses.
- The CLI's gateway test fake applies the setup claim and the mode.

Sign-up and mail:

- A per-organization (or per-inviter) daily invitation budget, so one
  organization can't spend the gateway's 2,000.
- Validate the install organization's name at the setup claim as personal
  organizations are; clear the verification row when a failed personal
  organization deletes the user; the sign-up page waits for `sign-in-methods`
  before rendering the invitation form.
- `everyapp status` or a health check warns when a hosted gateway has no email;
  a fixed subject line for invitation mail.
- Turnstile, disposable-domain lists and ASN budgets before open sign-up;
  organization leave, transfer and delete.

Hardening:

- The perimeter drops an app response's `Set-Cookie` that uses the session
  cookie's name.
- If `APP_BASE_DOMAIN` ever differs from the gateway host, the mobile shell
  scopes its session cookie as the server does.
- A gateway-computed catalog fingerprint stored with the snapshot (a schema PR);
  optionally, the control plane's 401 expires the gateway's own cookie variants.

Third-party tier:

- The hosted install's patch profile adds
  `dispatch_namespaces = [{ binding: "DISPATCHER", namespace, outbound: { service: "every-app-gateway", entrypoint: "Outbound", parameters: ["everyapp"] } }]`
  and updates the gateway config fixture on purpose (needs a namespace).
- A manifest `egress: string[]` snapshotted into the registry row, and per-app
  or per-plan dispatch limits.
- Bind a dispatched Worker's name to its row's organization key before
  dispatching; decide whether the egress allowlist names ports; fold
  `getAppFetcher`'s copy of `appBindingName()`.
- Deploy policy validates the gateway binding's props for the app and its
  helpers before customer code is deployed (redesign stack 2).
- From #313: a Public Suffix List check, so `THIRD_PARTY_DOMAIN` can't be a
  sibling of `APP_BASE_DOMAIN` on one registrable domain; and the CLI's deploy
  success line still says bearer tokens only, though #314 added browser sessions
  on app hosts.
- From #314: the CLI's hosted install manages the third-party route and DNS; the
  `everyapp.dev` Public Suffix List submission; sign-out on app hosts (the host
  cookie lingers until it expires, though the session is revoked server-side);
  cache or fold the per-request reads; a path for the mobile shell to
  third-party hosts.
- Review nits of #313 and #314, for a host-session follow-ups PR (branch
  `hosted/host-session-followups`, number pending):
  `Referrer-Policy: no-referrer` on the code exchange's 303 and on the
  expired-link page; rebuild a WebSocket 101 response after stripping
  third-party headers; log a registration failure after the job started once,
  not twice.
- From #311: move `CF_DEPLOY_TOKEN` into a thin deployer Worker behind
  `DeployerPort`; a secrets API and app delete and purge through the API
  (namespace script and D1); wallet metering of deploys; a stale-job sweep on
  the hourly cron (reads already treat a stale job as failed).

Tests:

- `packages/cli`'s `interrupt.test.ts` failed once on timing during #311 and
  didn't reproduce in 8 parallel runs; the likely cause is its "stop cf's
  process group" case taking about 4 seconds under vitest's 5-second timeout.

Helper Workers:

- `HELPER_DURABLE_OBJECT_REMOVED` names the real way out (keep the helper and
  its class until tombstones exist); a Build Output directory without
  `worker.config.json` is an `APP_POLICY` error; the lenient manifest schema
  drops the helper-name format rules.
- `delete --purge` reports unrecorded helper-named Workers; `secret list` shows
  helpers; `everyapp dev` with helpers is tested.

Hyperdrive (#309 merged with these review findings open):

- `migrate()` stops after the Postgres migration, so an app that also declares
  D1 never migrates it: run both or refuse the combination.
- Adopting an unrecorded config can't compare the password: record the risk or
  require an explicit flag; detect password-only rotation with a hash in the
  ledger.
- The schema-drift check's environment lacks `POSTGRES_DATABASE_URL`;
  `<worker>--<binding>` has no length check; `sdk.mdx` omits the new outputs.
- The gateway's tolerant manifest schema is strict on `migrations.dialect`:
  redeploy the gateway with this release first, or make that schema tolerant.
- `everyapp db query` for Postgres.

## 9. Where the build diverged from the synthesized plan

- **Keys at the gateway, not in OpenSEO.** The plan had OpenSEO keep its own
  Autumn, DataForSEO and OpenRouter, the gateway bill nothing, the AI proxy off
  on hosted and chef out of the catalog. The build put DataForSEO and
  Context.dev behind the capability proxy and OpenRouter behind the AI proxy,
  turned OpenSEO's Autumn off, kept the AI proxy on with a per-organization cap,
  and kept chef. Why: the handoff restated that billing happens at the gateway.
- **The OpenSEO mode was ported, not rewritten**: open-seo `t3/every-app-mode`
  (`6fd225a3`) onto OpenSEO's `main`, plus the tenancy switch and deployment
  tier. The plan's OS-1 (a fourth mode keeping hosted billing) and OS-2 (Autumn
  customer id = organization id) were dropped.
- **No `everyapp hosted apply` or `hosted/catalog.json`.** The hosted gateway
  installs with `everyapp setup --mode hosted`; shared apps deploy with
  `everyapp deploy --shared` or, built elsewhere, `everyapp register`; their
  Workers follow the registry's naming rule (`every-everyapp-<app>`), not
  `every-shared-<app>` or `open-seo-everyapp`.
- **`aud = workerName` for every app**, first-party and self-host included; the
  plan kept the app id for those forever and deferred the rename to the dispatch
  lane.
- **No tenant-neutral bundle refactor** (plan PR 9) and no publish prep (plan PR
  10). The deploy API (#311) builds third-party bundles with a sentinel Worker
  name and rewrites the bindings at upload instead.
- **The deployer lives in the gateway**, holding `CF_DEPLOY_TOKEN`, rather than
  in a thin deployer Worker; its gate is a hand-set secret rather than
  `Boolean(env.DEPLOYER)`. Deploy keys, the `deploy` scope and the `deploy_jobs`
  row follow the plan.
- **Schema**: a regenerated single baseline with three additions, not an
  additive `0001_hosted.sql` with `organization_platform`, `audit_events`,
  `usage_events` and terms columns.
- **Built beyond the plan**: phase 0 from the other thread (#303, #306), the
  dispatch branch and `Outbound` behind fakes (#304; the plan left the branch a
  throw), org-scoped MCP supersede (#300; the plan deferred it), Postgres and
  Hyperdrive in the CLI (#309), and background attribution (#310; the plan
  reserved `x-everyapp-org` for the money lane).
- **Third-party hosts follow the plan's per-host handoff** (its 9b): a 60-second
  single-use code bound to a `__Host-` nonce, an HMAC host cookie keyed by HKDF
  from `BETTER_AUTH_SECRET`, no session table. The build's own choices: single
  use through `rate_limit_counters`, PATs on app hosts, and one hand-made
  wildcard route instead of per-app certificates.
- **Smaller**: the duplicate-cookie refusal is a 401 without clearing cookies
  (the plan had a redirect that cleared them); no sign-up budgets beyond mail
  budgets; no Terms or AUP drafts; no reserved labels (plan PR 5; #314 built its
  host classifier); `AI_PROXY_EXTRA_ROUTES` is still honoured on hosted (the
  operator is us).
- **Hostnames** are as planned (`<app>.app.everyapp.com`, one cookie on
  `app.everyapp.com`), and needed no code.

## 10. The other thread

The thread "Port OpenSEO Auth to Every App" handed its remaining work over at
07:40 UTC on 2026-10-16 (`/tmp/ea/handoff-from-openseo-thread-2026-10-16.md`)
and stood down. Everything it handed over is absorbed:

- Its Every App branch `t3/port-openseo-to-gateway` (`78609657`) landed as #303
  and #306, with the manifest key renamed `capabilities` and `as` and
  `background` removed. Its design records
  (`docs/design/2026-10-redesign-review.md`,
  `docs/design/2026-10-google-integration.md`) are on `main`.
- Its OpenSEO branch `t3/every-app-mode` (`6fd225a3`) became open-seo #983.
- Its work items: background attribution (#310), Hyperdrive and Postgres in the
  toolchain (#309), the per-organization daily cap (#307, #310). Still open from
  its list: Google at the gateway, redesign stacks 1 to 3 (partly), the fork
  tier for OpenSEO, the gateway replay step runner and scheduler, fork egress,
  and its live checks.
- Its unconfirmed defaults (handoff §5) are in `TODO.md` under Decide.

Its branches and worktrees (`t3/port-openseo-to-gateway` and
`/Users/bensenescu/.t3/worktrees/private-every-app/t3-c75b66d8` here;
`t3/every-app-mode` and
`/Users/bensenescu/.t3/worktrees/open-seo/every-app-mode` in open-seo) can be
deleted once Ben confirms nothing else on them is wanted (check them for
uncommitted work first; this build did not open them). Nothing in this build
reads from those worktrees: open-seo #990 links the SDK from `main` at
`6b251463`, and only #983 and #984 on their own still link a detached worktree
of the same commit `78609657` (`/tmp/ea/private-every-app`).
