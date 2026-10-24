# Hosted Every App: the alignment contract

Written 2026-10-24, three days before the self-host-only launch. The hosted tier is post-launch.
This file replaces the hosted planning documents deleted the same day (listed in section 4) and is
the one thing future work has to agree with: the rulings Ben made, the invariants the code keeps
today, where the cut code lives, and what is still open. It is meant to be short and checkable. A
pull request that touches one of the invariants in section 3 cites this file and says which rule it
keeps or changes.

Everything hosted that the gateway already does stays in the code (section 4). Only the CLI's
hosted-only surface was cut, and it is restorable from one commit.

## 1. What hosted Every App is

Hosted Every App is our own install of the same gateway at `app.everyapp.com`, with
`GATEWAY_DEPLOYMENT_MODE=hosted` and nothing else different in the build. `platformPolicy(env)`
turns on open sign-up with verified email into one personal organization per person, shared
first-party apps and tenant rules an operator's install doesn't have. First-party catalog apps
(OpenSEO first, then the rest of the catalog) run as one shared Worker per app in our Cloudflare
account, reached over a service binding at `<app>.app.everyapp.com`, over a multi-tenant database
(OpenSEO: one Postgres through Hyperdrive) that the app scopes by the organization in each identity
token. Third-party apps, an organization's own code or a fork of one of ours, run as one Worker per
organization in a Workers for Platforms dispatch namespace, deployed through the gateway's
deploy-key API, with per-invocation limits, default-deny egress and a session per host on a separate
domain. Provider keys and the Google OAuth client live in the gateway for both kinds; apps call
through their AppGateway binding and every call is attributed to an organization. Metering (the
organization wallet) comes later; until it exists the hosted preview is invite-only. app.openseo.so
is a separate product and is never touched by any of this.

## 2. Rulings that stand

Each row is a decision Ben made, with the date and where it was recorded. Deleted sources are
readable from git: `git show 5ef30882:<path>` (origin/main on 2026-10-24,
`5ef30882`).

| Date                          | Ruling                                                                                                                                                                                                                                                                      | Recorded in                                                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-03-02                    | One repository and one gateway codebase, split at runtime by `GATEWAY_DEPLOYMENT_MODE` (`self_hosted`, `hosted`). Hosted differences are policy, not forked logic. Hosted provider credentials are platform-managed; apps and users never receive them.                     | `adr/ADR-0001-hosted-vs-self-hosted-topology.md` (kept). Its decision 6, one Worker per organization for every hosted app, was narrowed on 2026-10-15 to third-party apps only.                            |
| 2026-10-15                    | Self-host authority is the Cloudflare account. The registration rules live once, in `@every-app/perimeter/registry`, and run in the CLI for self-host and in a hosted API later. The hosted tier gets its own HTTP control plane and credentials.                           | `adr/ADR-0003-self-host-authority.md` (kept)                                                                                                                                                               |
| 2026-10-15                    | Two kinds of apps. First-party apps are deployed by us into our account, use Every App identity and membership, and are multi-tenant on the back end. Third-party apps are the only thing deployed to Workers for Platforms. OpenSEO must work on day one.                  | Research README, "Founder answers so far", D2 (deleted; `git show 5ef30882:docs/research/2026-10-hosted-platform/README.md`); quoted in `docs/hosted-platform-build.md` §1 (deleted)                       |
| 2026-10-15                    | `app.openseo.so` is not moved, migrated or touched. The Every App OpenSEO is a second, separate deployment with its own database and customers. The cutover phase (H35 to H42) is dropped.                                                                                  | Same, D5 and D7                                                                                                                                                                                            |
| 2026-10-15                    | Google: the operator holds the OAuth client; each organization connects its own accounts. A manifest capability entry is `{ access, why }`: the approval is of the app, attribution comes from the identity header, and an organization's connection allows background use. | `TODO.md` Decide, "Google: the operator holds the OAuth client" and "Manifest integration entries lose `as` and `background`" (kept); the design was `docs/design/2026-10-google-integration.md` (deleted) |
| 2026-10-16 07:02 UTC          | On everyapp.com OpenSEO is a first-party app, and people may deploy forks of OpenSEO as third-party apps. The first-party version uses one Postgres database; forks on Workers for Platforms use D1. The Google client and secret are handled in the gateway for both.      | `docs/hosted-platform-build.md` §1 (deleted); `TODO.md` Decide, "OpenSEO in Every App" (kept)                                                                                                              |
| 2026-10-16, evening           | Per-organization usage limits are a later feature and are not on by default; the daily caps left the code entirely (#316, `31a85593`). Every provider call is still attributed to an organization and logged, so the wallet can count against it later.                     | `docs/hosted-platform-build.md` §3 "Walked back" (deleted); `TODO.md` Build, "Per-organization usage limits and metering (the wallet) are a later feature" (kept)                                          |
| Standing, restated 2026-10-16 | Billing and metering happen at the gateway, not in the app. Self-host keeps working from the same code. Every App is a prototype with no backward compatibility.                                                                                                            | `docs/hosted-platform-build.md` §1, "Standing rules from earlier briefs" (deleted)                                                                                                                         |
| 2026-10-17                    | OpenSEO's `AUTH_MODE=everyapp` is a mode, not a fork. It is prototyped in the scratch repository `bensenescu/open-seo-everyapp` and comes home to open-seo as one PR when Ben says so.                                                                                      | `TODO.md` Decide, "OpenSEO: a mode, not a fork" (kept)                                                                                                                                                     |
| 2026-10-23                    | The 2026-10-27 launch is self-host only: no `setup --mode hosted` (removed since), no `THIRD_PARTY_DEPLOYS=on`, no dispatch namespace, no `app.everyapp.com`. The hosted build's defaults in `TODO.md` stay unconfirmed and harmless.                                                       | `docs/launch-2026-10-27.md`, "Do not start the hosted tier"                                                                                                                                                |
| 2026-10-24                    | The historical hosted documents are deleted and the CLI's hosted-only surface is cut. The gateway's hosted internals stay. This file is the contract future work aligns with.                                                                                               | `docs/simplify-2026-10-24.md` §1 (settled decisions); this file                                                                                                                                            |

Defaults the overnight build took without Ben are not rulings. They are listed, unchecked, under
"Hosted build (2026-10-16)" in `TODO.md`; section 5 picks the ones that shape the hosted build.

## 3. Invariants every self-host change must keep

Each rule names the code that enforces it today (symbol and file, as of `5ef30882`) and a way to
check it. Line numbers drift; symbol names less.

1. **One codebase, one mode switch, fail closed.** Hosted and self-hosted are one gateway build. The
   only read of `GATEWAY_DEPLOYMENT_MODE` is `platformPolicy(env)`; every hosted or self-hosted
   behaviour asks that frozen object, never the env. An unset or mistyped mode is `invalid` and
   turns everything off in both modes. A new mode-dependent behaviour is a new field on
   `PlatformPolicy`, not an `if` somewhere else.
   - Enforced by: `resolveDeploymentMode()` in
     `apps/every-app-gateway/src/server/deployment-mode.ts`; `platformPolicy()` and `PlatformPolicy`
     in `apps/every-app-gateway/src/server/platform-policy.ts`; readers such as
     `app-gateway-entrypoint.ts` (`policy.sharedApps`), `server.ts` (`thirdPartyDeploys`),
     `app-activation.ts` (`bindingActivation`), `tenant-user-actions.ts`.
   - Check: `grep -rn GATEWAY_DEPLOYMENT_MODE apps/every-app-gateway/src --include='*.ts'` finds one
     read (`platform-policy.ts`); the rest are env type declarations and two error messages.
     `platform-policy.test.ts`.

2. **The install row records the mode.** `_everyapp_install.deployment_mode` stays, a nullable text
   column holding `self_hosted` or `hosted`. The CLI writes `self_hosted` at first upload, together
   with the `GATEWAY_DEPLOYMENT_MODE` secret, and a later upload keeps what is recorded. The column
   is never reused for anything else, and a gateway is never switched from one mode to the other in
   place.
   - Enforced by: `CREATE_INSTALL_TABLE`, `InstallRecord.deploymentMode` and `writeInstall()`
     (COALESCE on `deployment_mode`) in `packages/cli/src/lib/gateway/install.ts`;
     `DEPLOYMENT_MODES` and `DeploymentMode` in `packages/cli/src/lib/gateway/secretsFile.ts`, which
     writes the secret; `packages/cli/src/lib/gateway/apply.ts` defaults a missing mode to
     `self_hosted`.
   - Check: `grep -n deployment_mode packages/cli/src/lib/gateway/install.ts`;
     `SELECT deployment_mode FROM _everyapp_install` on the live gateway's D1 reads `self_hosted`.

3. **Identity audience is the Worker name.** Every identity JWT, public marker and system token the
   gateway mints has `aud` equal to the registry row's `worker_name`, and an app verifies against
   `EVERYAPP_AUDIENCE` (answering 500 when it is unset). Two organizations' copies of one app id
   never accept each other's tokens. No mint site uses the app id outside `everyapp dev`. A
   provider app's row (tier `provider`, #489) has no Worker: its tokens carry `provider:<row id>`
   (`providerAudience()` in `apps/every-app-gateway/src/server/provider-apps/index.ts`).
   - Enforced by: `audienceOf()` in `packages/perimeter/src/gateway.ts` (returns `app.workerName`);
     `AUDIENCE_ENV` and the minters in `packages/sdk/src/internal/protocol.ts`; `audienceFor()` in
     `packages/sdk/src/server/everyApp.ts`; `verifyForwardedIdentity()` in
     `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts` (`audience: props.workerName`);
     the ToolBus mints in `toolbus/catalog-sync.ts`, `toolbus/gateway-mcp.ts` and
     `toolbus/app-host-mcp.ts` (all `workerName`).
   - Check:
     `grep -rn "audience:" apps/every-app-gateway/src packages/perimeter/src --include='*.ts' | grep -v test`
     shows only `workerName` and `providerAudience(…)` sources, apart from the Cloudflare Access
     OIDC client, its JWT verifier and the outer ring, and the MCP OAuth resource in
     `mcp-auth/validate.ts` (different tokens). `packages/perimeter/src/gateway.test.ts`
     :: stamps every token with the app's Worker name as its audience.

4. **`x-everyapp-org` is for shared Workers, and only for them.** An organization's own app (every
   self-hosted app, every dispatched app) is attributed to the organization in its binding's
   upload-time props; naming another in `x-everyapp-org` is 403 `caller_org_mismatch`. A shared
   Worker (`scope = 'shared'`) forwards the request's identity or, for background work, names an
   active organization with a live member in `x-everyapp-org`; both present must agree, neither is
   403 `caller_identity_required`. The perimeter strips every inbound `x-everyapp-*`, so a browser
   can't send it. The SDK sends it only through `for: { background: true, organizationId }` and
   throws `AttributionError` in a shared Worker (`EVERYAPP_SHARED=1`) for a call that names nobody.
   - Enforced by: `ORG_HEADER` and `SHARED_ENV` in `packages/sdk/src/internal/protocol.ts`;
     `attributeCall()` and `isAttributable()` in
     `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts`; `isAttributable` in
     `apps/every-app-gateway/src/server/repositories/OrganizationRepository.ts`;
     `stripInboundHeaders()` in `packages/perimeter/src/headers.ts`; `AttributionError` in
     `packages/sdk/src/server/attribution.ts`.
   - Check: `apps/every-app-gateway/src/server/background-org.sqlite.test.ts`;
     `packages/perimeter/src/headers.test.ts` :: removes x-everyapp-org.

5. **Three tiers and two scopes, in the registry and the manifest.** `apps.tier` is `service_binding`,
   `dispatch` or `provider` (#485: a provider app's row has no Worker or hostname; the gateway serves
   it in-process, `providerAppFetcher()` in `apps/every-app-gateway/src/server/provider-apps/index.ts`);
   `apps.scope` is `org` or `shared`. Any other value is unroutable (503), never
   coerced. A row's tier and scope never change after registration, and a shared app is never
   `dispatch`. `getAppFetcher()` is the only place that knows how a Worker is reached. A first-party
   host admits only service-binding rows; a third-party host only dispatch rows of scope `org`.
   `manifestTierProblems()` is where a dispatch-tier manifest is told what it may not declare
   (Hyperdrive, R2, inbound mail, secrets of its own). Self-host writes `service_binding` and
   `provider` rows, all of scope `org`, and must not add another way to reach a Worker.
   - Enforced by: `Tier`, `AppScope` and `rowToRegisteredApp` in
     `packages/perimeter/src/registry/apps.ts`; `packages/perimeter/src/registry/providerApps.ts`
     (the provider rows); `apps.tier` and `apps.scope` in
     `apps/every-app-gateway/src/db/apps.schema.ts`; `planRegistration()` in
     `packages/perimeter/src/registry/registration.ts` (`APP_SCOPE_MISMATCH`, `APP_TIER_MISMATCH`,
     `SHARED_APP_NOT_PLATFORM`); `getAppFetcher()` in `packages/perimeter/src/getAppFetcher.ts`;
     `hostAdmitsApp()` in `packages/perimeter/src/hostRoutes.ts`; `manifestTierProblems()` in
     `packages/perimeter/src/manifest/manifest.ts`.
   - Check: `packages/perimeter/src/gateway.test.ts` :: answers 503 for a registry row with a tier
     or scope it doesn't know; `hostRoutes.test.ts`; `registration.test.ts`.

6. **Capabilities: the gateway holds the credential, the manifest entry is the grant.** Every
   provider an app uses is one entry in one registry, with a `mode` (`api_key`, `oauth_client`,
   `service`), reached through the app's AppGateway binding at `/api/integrations/<id>/...`. The key
   or client is a gateway secret, never a secret on an app's Worker. An app that doesn't list the
   capability learns nothing (`configured: false`), and account-wide provider paths are refused for
   every app. A new provider is a new registry entry, not a new app secret. AI providers
   (`providers`, `/api/ai/<provider>`) follow the same rule until they fold into the registry. The
   dispatch tier's `Outbound` refuses provider hosts even when an egress list names them.
   - Enforced by: `CAPABILITIES` and `isAccountWidePath()` in
     `packages/sdk/src/internal/capabilities.ts`;
     `apps/every-app-gateway/src/server/integration-proxy.ts`;
     `apps/every-app-gateway/src/server/capabilities/{email,members,oauthClient}.ts`;
     `apps/every-app-gateway/src/server/ai-proxy.ts`; the `Outbound` entrypoint in
     `apps/every-app-gateway/src/server/outbound.ts`; the `capabilities` validation in
     `packages/perimeter/src/manifest/manifest.ts`.
   - Check: `docs/capabilities.md`'s tables are drift-tested (`capabilitiesDoc.test.ts`);
     `integration-proxy.test.ts`; `outbound.test.ts`.

7. **The hosted deploy protocol and the deploy-key API stay.** `HOSTED_DEPLOY_PROTOCOL`,
   `MIN_HOSTED_DEPLOY_PROTOCOL`, `HOSTED_DEPLOY_PARTS` and `bundleModuleType()` are the one shape
   the gateway reads a bundle in. The app release tarball (`everyapp install <url>`, the browser
   install) is parsed into the same `DeployBundle` and stamped with the same protocol, so the
   constants are load-bearing on self-host too. A change to the bundle shape bumps the protocol and
   the floor together. `/api/v1/*` exists only while `platformPolicy(env).thirdPartyDeploys`; a
   deploy key is a personal access token whose only scope is `deploy`, and it opens no app.
   - Enforced by: `packages/perimeter/src/manifest/deploy.ts`; in
     `apps/every-app-gateway/src/server/deploy/`: `bundle.ts` (refuses a stamp below the floor),
     `release.ts` (stamps `HOSTED_DEPLOY_PROTOCOL` on a release), `pipeline.ts`, `routes.ts`
     (`serveDeployApi`), `auth.ts` (`authenticateDeployKey`); the gate in
     `apps/every-app-gateway/src/server.ts` (`serveGatewayHost`); `DEPLOY_SCOPE` in
     `apps/every-app-gateway/src/server/user-pat-scopes.ts`;
     `packages/cli/src/commands/secret/index.ts` refuses to set `THIRD_PARTY_DEPLOYS`.
   - Check: `deploy-api.sqlite.test.ts`, `install-api.sqlite.test.ts`, `release.test.ts` under
     `apps/every-app-gateway/src/server/deploy/`.

8. **MCP tokens, connections and catalogs are organization-scoped.** A personal access token acts
   only in its organization. An AI connection is per user and organization, and a request's props
   must name the connection's organization. The gateway `/mcp` catalog is built for the principal's
   organization, and tool snapshots are keyed by organization. A suspended organization is refused
   everywhere. No self-host feature may give a token or a catalog gateway-wide reach.
   - Enforced by: `user_access_tokens.organization_id` in
     `apps/every-app-gateway/src/db/user-tokens.schema.ts`; `mcp_connections`, `app_tools` and
     `mcp_tool_calls` in `apps/every-app-gateway/src/db/mcp.schema.ts`;
     `apps/every-app-gateway/src/server/mcp-auth/validate.ts` (the connection's organization must
     equal the props'; a PAT carries its organization); `principal.organizationId` in
     `apps/every-app-gateway/src/server/toolbus/gateway-mcp.ts`; `isMcpOnlyCredential` in
     `packages/perimeter/src/session.ts` and the access policy in
     `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts` (app-bound tokens, the
     `deploy` scope opens no app).
   - Check: `betterAuthAuthenticator.test.ts` :: returns null when the token user is no longer a
     member of the token org; the org-scoped supersede tests from #300.

9. **The schema never assumes one organization per gateway.** The launch promise is one organization
   per Gateway; the data model is not. Every table that holds tenant data carries `organization_id`
   with a foreign key to `organizations`. Worker, D1 and KV names carry the organization key
   (`every-<orgKey>-<appId>`). A session has an active organization and a person may belong to
   several. `organizations.status` gates everything. New tables, caches and resource names follow
   the same shape, and nothing reads "the" organization.
   - Enforced by: `apps.organization_id` (not null, unique with `app_slug`) and
     `user_app_access.organization_id` in `apps/every-app-gateway/src/db/apps.schema.ts`;
     `apps/every-app-gateway/src/db/organization-keys.schema.ts`; `registryWorkerNameFor()` in
     `packages/perimeter/src/manifest/manifest.ts`; `sessions.active_organization_id`, `members` and
     `organizations.status` in `apps/every-app-gateway/src/db/auth.schema.ts`;
     `resolveLiveOrgRole()` in `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts`.
   - Check: `grep -n organization_id apps/every-app-gateway/src/db/*.schema.ts`; a schema change
     adding a tenant table without it fails review.

## 4. What was cut from the code and where to get it back

Restore from commit `5ef30882` (origin/main on 2026-10-24):
`git show 5ef30882:<path>` to read, `git checkout 5ef30882 -- <path>` to bring a file back. Line
numbers are as of that commit.

The CLI surface removed (`--gateway <url>` stays: on self-host it names one Gateway when the login sees
several; `status` keeps its mode line, which reads the install row):

| Path (as of `5ef30882`)                                                                                                                                                                                                                                                                         | What it was                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/cli/src/commands/setup/command.ts:19-25`, `runSetup.ts` (`assertModeUnchanged()`, the mode plumbing at 320, 392, 639)                                                                                                                                                                 | `everyapp setup --mode self_hosted\|hosted` (removed)                        |
| `packages/cli/src/commands/deploy/command.ts:54-59`, `deployApp.ts:371-381`, the shared check in `commands/appGateway.ts` ("Shared apps need a hosted Gateway"), the shared scope in `lib/gateway/registry.ts` and `lib/app/installBuildOutput.ts` (`EVERYAPP_SHARED=1`, no `EVERY_APP_ORG_ID`) | `everyapp deploy --shared` (removed)                                         |
| `packages/cli/src/commands/register/*` (359 lines)                                                                                                                                                                                                                                              | `everyapp register` (removed): a Worker deployed elsewhere put behind a hosted Gateway |
| `packages/cli/src/commands/deploy/deployToGateway.ts` (+ test), `lib/app/hostedBundle.ts`, `deploy/index.ts:63-66,110-119`, `deploy/command.ts:139-145`, `--no-wait`'s hosted meaning                                                                                                           | `EVERYAPP_DEPLOY_TOKEN` deploys to `/api/v1` with a deploy key (removed)     |

The documents deleted, all readable at `5ef30882`:

- `docs/hosted-platform-build.md` (deleted)
- `docs/research/2026-10-hosted-platform/**` (deleted; the research round, synthesis, plan H0 to
  H42, live checks; first landed as `beae4bfe`, #299)
- `docs/research/2026-10-integrations-hub/**` (deleted)
- `docs/design/2026-10-google-integration.md` and `docs/design/2026-10-redesign-review.md` (deleted)
- `adr/ADR-0002-cli-and-control-plane-auth.md` and `adr/RFC-0001-org-rearchitecture-phase-1.md` (deleted)

What stays in the gateway and the packages, untouched this week:

- `apps/every-app-gateway/src/server/deployment-mode.ts` and `platform-policy.ts`: the mode switch
  and every hosted policy field (open sign-up, personal organizations, verified email, shared apps,
  third-party deploys and limits, mail budgets).
- The dispatch tier: `apps.tier`, the dispatch branch of `getAppFetcher()`, the `DISPATCHER` binding
  shape and the `Outbound` entrypoint (`src/server/outbound.ts`).
- Third-party hosts and per-host sessions: `src/server/app-hosts.ts`, `src/server/host-session.ts`,
  `packages/perimeter/src/hostRoutes.ts`, `packages/perimeter/src/hostSession.ts`.
- Shared apps: `scope = 'shared'` in the registry rules, the perimeter's shared-app access policy,
  `attributeCall()` and `x-everyapp-org` in the AppGateway entrypoint, the shared-app rows in the
  ToolBus catalog.
- Hosted sign-up: the `SetupService` platform organization, verified-email sign-in, mail budgets,
  tenant admin limits.
- `src/server/deploy/**`: the `/api/v1` deploy-key API (`routes.ts`, `auth.ts`, `bundle.ts`), the
  pipeline, `cfRestDeployer.ts` and the browser install (`install.ts`, `browser-install.ts`), which
  shares that pipeline and is a launch feature. The PAT `deploy` scope and the "Deploy key" kind in
  the tokens UI stay with it.
- `apps/every-app-gateway/src/server/deploy/cf-rest/`: the Cloudflare REST client the deployer and
  the browser install use (moved from `packages/cf-rest` on 2026-10-24, #448); it does not go.
- `_everyapp_install.deployment_mode` and `DEPLOYMENT_MODES` in the CLI (invariant 2);
  `docs/runbooks/hosted-install.md` and the hosted sections of `docs/security-model.md`, each with a
  banner saying the CLI surface is restored from the commit above.

## 5. Open questions for the hosted build

Taken from "Hosted build (2026-10-16)" in `TODO.md`, where each is an unchecked default with its
walk-back. One line each.

- A new dedicated Cloudflare account for everyapp.com, or the existing one: the gateway, the
  first-party Workers and OpenSEO's Hyperdrive config must share one account; decide before the
  first live provisioning.
- First-party hosts share the control plane's cookie at `<app>.app.everyapp.com` and the host never
  picks the organization; third-party apps get a session per host on `everyapp.dev`, which goes on
  the Public Suffix List.
- No install rows for shared apps: every organization gets every shared app and none can hide or cap
  one; `org_app_settings (org_id, app_id)` is the walk-back when that is wanted.
- Keys at the gateway, metering later: nothing bounds an organization's provider spend until the
  wallet, so public sign-up waits for the wallet and verified Google, and the preview stays
  invite-only (`HOSTED_OPEN_SIGNUP=false`).
- The third-party launch gate: `THIRD_PARTY_DEPLOYS=on` is a hand edit, only after the
  `everyapp.dev` zone, wildcard DNS and route, the PSL entry, a dispatched Worker's name checked
  against its row's organization, and the live Workers for Platforms checks.
- Deploy keys: a personal access token with the single scope `deploy`, owners and admins only, 30
  days; a deploy runs inside its POST with no queue, one running job per app, abandoned after 5
  minutes.
- Third-party limits: 5 seconds of CPU, 200 subrequests, 2 Durable Object classes and static assets;
  no KV, Workflows, helper Workers, crons, Hyperdrive, R2 or secrets of their own; no internet
  egress until the manifest gains an `egress` list.
- `CF_DEPLOY_TOKEN` lives in the public gateway Worker for the preview, not in a thin deployer
  Worker behind `DeployerPort` as the research preferred.
- Google at the gateway: one Cloud project owned by Ben's account, a consent screen reading "Every
  App" for every app and fork, Search Console and Analytics read-only scopes; verification is the
  external critical path.
- OpenSEO as a first-party app deploys through `everyapp deploy` from its manifest (Hyperdrive,
  Postgres migrations) rather than an Alchemy stage registered by hand; forks ship in tiers,
  research tools first and audits last.
