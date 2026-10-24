---
title: First-party and third-party apps
description: How shared, multi-tenant first-party apps differ from single-tenant, per-organization third-party apps, with OpenSEO as the worked example.
---

Internal notes, 2026-10-18. Read this before you put an app behind the Every
App gateway, or make one ready for the hosted platform. OpenSEO is the worked
example because it is the hardest case: it uses everything the platform
offers.

## The short version

On the hosted platform (everyapp.com) there are two kinds of apps.

|                                     | First-party app                                                                         | Third-party app                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Who writes and ships it             | Us                                                                                      | An organization (its own app, or a fork of one of ours)                                                                    |
| Tenancy                             | **Multi-tenant**: one deployment serves every organization                              | **Single-tenant**: one deployment per organization                                                                         |
| Workers                             | One Worker per app (plus its helpers) in our Cloudflare account                         | One Worker per organization, in a Workers for Platforms namespace                                                          |
| Database                            | One shared database, rows scoped by organization (OpenSEO: Postgres through Hyperdrive) | The organization's own D1                                                                                                  |
| Which organization a request is for | From each request's signed identity                                                     | Fixed at deploy time (`EVERY_APP_ORG_ID`)                                                                                  |
| Registry row                        | `scope = 'shared'`, `tier = 'service_binding'`, owned by the platform organization      | `scope = 'org'`, `tier = 'dispatch'`, owned by the organization                                                            |
| Host                                | `<app>.app.everyapp.com`, on the control plane's cookie                                 | `<app>-<orgKey>.everyapp.dev`, with a session per host                                                                     |
| Trust                               | Our code: may assert which organization background work is for                          | Untrusted code: sandboxed, limited, default-deny egress                                                                    |
| What it may use                     | Everything: helper Workers, Workflows, crons, KV, R2, Hyperdrive                        | D1, up to 2 Durable Object classes, static assets. No KV, Workflows, crons, helpers, Hyperdrive or inbound mail; no R2 yet |

Ben settled the split on 2026-10-15 and 2026-10-16
([hosted-platform-build.md §1](https://github.com/every-app/private-every-app/blob/5ef30882/docs/hosted-platform-build.md), "The rulings the
build follows"). First-party apps are deployed by us and are multi-tenant on
the back end. Third-party apps are the only thing deployed to Workers for
Platforms. app.openseo.so is a separate product and is never touched by any of
this.

## Why two kinds

A third-party app is code we didn't write. Giving every organization its own
copy, its own database and a sandboxed Worker means a bug or a hostile app can
only ever hurt the organization that deployed it. Workers for Platforms gives
us that isolation plus per-invocation CPU and subrequest limits.

First-party apps are ours, and the catalog apps every organization uses. One
copy per organization would mean thousands of Workers to deploy and migrate
for every release. Workers for Platforms also can't host Workflows or crons
today, which apps like OpenSEO depend on. So a first-party app runs once, like
a normal SaaS app, and keeps each organization's data apart in its own code.

The cost of multi-tenancy is that the app itself is now responsible for
keeping organizations apart. Most of this doc is about doing that right.

## Where things stand today

- **Self-hosted gateways** (everyapp.team, thecomeup.cc) have only one kind of
  app: an organization's own app (`scope = 'org'`, `tier = 'service_binding'`).
  Every app there is single-tenant, pinned to one organization with
  `EVERY_APP_ORG_ID`, and reached over a service binding. That is the same
  tenancy shape as a hosted third-party app, without the sandbox.
- **The hosted gateway** is built but not installed. Shared first-party apps
  (#307), background attribution (#310), helper Workers (#306) and Postgres
  through Hyperdrive (#309) are merged.
- **Third-party deploys** are built (#304, #311, #313, #314) and switched off.
  They open only when every row of the launch gate in
  [hosted-platform-build.md §1](https://github.com/every-app/private-every-app/blob/5ef30882/docs/hosted-platform-build.md) holds.
- **No usage limits** at the gateway in any mode (#316). Every provider call
  is attributed to an organization and logged; the wallet will meter it later.

## What the gateway does for both kinds

None of this changes between the two kinds. An app gets it for free and must
not rebuild it.

- **Sign-in, organizations, roles and who may open the app.** The gateway
  signs a 120-second identity token onto every request it forwards
  (`x-everyapp-identity`: `sub`, `org_id`, `org_role`, audience = the app's
  Worker name). The app verifies it with `getEveryAppUser()` from
  `@every-app/sdk/server`. It never runs its own login.
- **Cookies.** The gateway strips inbound cookies before the app sees the
  request. Session state lives at the gateway.
- **Provider keys.** OpenRouter, OpenAI, DataForSEO, Context.dev and the rest
  live only at the gateway. The app calls them over its `EVERY_APP_GATEWAY`
  binding with `createGatewayFetch()` (AI) or `integrationFetch()`
  (capabilities), and the gateway puts the key on. An app never holds a key.
- **Agent tools.** The app defines tools with `defineTools()`; the gateway
  serves them on its one `/mcp` connector as `<app>_<tool>`.
- **Attribution.** The gateway decides which organization each provider call
  counts against, and logs it. The rules differ by kind, below.

## Where they differ

### Data

A third-party app has one organization's data in its own D1. It can't see
anyone else's even if its code is wrong.

A first-party app has every organization's data in one database. Every table
that holds customer data must hang off an organization (directly, or through a
parent such as a project), and every query must filter by it. There is no
platform safety net here: a missing `WHERE organization_id = ?` leaks across
organizations.

### Identity: which organization a request is for

Both read the organization from the signed token. What they do with it
differs.

- **Third-party (pinned).** `EVERY_APP_ORG_ID` is set at deploy. A token for
  any other organization is refused. Everyone the gateway lets in works in the
  one organization.
- **First-party (from the token).** `EVERY_APP_ORG_ID` is unset. The token's
  `org_id` is the organization for this request. The app creates its own
  organization, user and membership rows the first time it sees them, but
  authorizes from the token on every request, never from those rows. When the
  gateway removes a member, it stops signing tokens for them, and nothing in
  the app still lets them in.

### Attribution: whose provider call it is

The gateway attributes every AI and capability call to an organization
([security-model.md](https://github.com/every-app/private-every-app/blob/main/docs/security-model.md), "Organizations and Shared Apps").

- **An organization's own app** (self-hosted apps, and third-party apps on
  hosted): the call is for the organization in the binding's upload-time
  props. The app doesn't need to say anything. Naming another organization in
  `x-everyapp-org` is refused with 403 `caller_org_mismatch`.
- **A shared first-party app** serves everyone, so every call must say whose
  it is:
  - While serving a request, forward the request's identity:
    `for: request`.
  - For work no request started (a Workflow step, a cron, a queue), name the
    organization: `for: { background: true, organizationId }`, sent as
    `x-everyapp-org`. The gateway accepts it only for an active organization
    with a live member. This header is trusted only because the app is our
    code.
  - A call that names neither throws `AttributionError` in a shared Worker
    (`EVERYAPP_SHARED=1`), so a missed code path fails closed instead of
    spending on nobody's account.

[packages/sdk/README.md](https://github.com/every-app/private-every-app/blob/main/packages/sdk/README.md), "Whom a call is for", has
the API.

### Deploy

|                      | First-party                                                                                                                             | Third-party                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command              | `everyapp deploy --shared` from its repo, or `everyapp register` for one deployed another way (OpenSEO's Alchemy stage)                 | `everyapp deploy` to the hosted deploy API with a deploy key                                                                                      |
| Who may run it       | Owners and admins of the platform organization, by their Cloudflare login's email; a Cloudflare API token also passes, so CI can deploy | A live owner or admin of the organization, with a personal access token whose only scope is `deploy`; refused while the organization is suspended |
| Worker name          | `every-everyapp-<app>` (the platform organization's key)                                                                                | `every-<orgKey>-<app>`, written by the deployer                                                                                                   |
| Bindings             | Whatever the app's config declares, within the binding policy                                                                           | Rewritten by the deployer; anything outside the allowlist is refused                                                                              |
| What the deploy sets | `GATEWAY_URL` as a secret; installing the build adds `EVERYAPP_SHARED=1` as plain text; no `EVERY_APP_ORG_ID`                           | `GATEWAY_URL` and `EVERY_APP_ORG_ID`, as plain text                                                                                               |

An app's scope and tier never change after its first registration.

## Building a first-party app: the checklist

1. **Manifest and Worker config.** `everyapp.config.ts` declares resources,
   helper Workers, providers and capabilities. `cloudflare.config.ts` builds
   the Worker with `everyAppWorker()`, and each helper with
   `everyAppAuxiliaryWorker()`. The SDK adds the identity settings and the
   gateway binding (placeholders the deploy installs), and the deploy adds
   `EVERYAPP_SHARED` to a shared app's Workers.
2. **Scope every table by organization.** Decide the tenant key up front and
   make it non-nullable. Index it. Review every query for it.
3. **Map the token to your rows.** Verify with `getEveryAppUser()`, then
   create the organization, user and membership on first sight. Authorize
   from the token's `org_id` and `org_role`, not from your rows.
4. **Say whose every gateway call is.** `for: request` while serving a
   request. `for: { background: true, organizationId }` everywhere else.
   Carry the organization into Workflow payloads and Durable Object state so
   background work can name it.
5. **No keys, no login, no cookies.** Request capabilities in the manifest.
   Turn off the app's own auth, billing, team management and API keys in this
   mode.
6. **Long-lived connections re-check.** A WebSocket authorized once at
   connect outlives a removed member. Close it on a timer so the client
   reconnects through the gateway.
7. **Tools.** Define them once with `defineTools()`. Pin tool calls to the
   token's organization.
8. **Test with two organizations.** Sign in as members of two organizations
   and check neither sees the other's data, in the UI, the tools and
   background work.

If the app should also be forkable as a third-party app, keep the same code
and switch on `EVERY_APP_ORG_ID`. OpenSEO does exactly this, below.

## OpenSEO: the worked example

OpenSEO's Every App mode lives in the private scratch repo
`bensenescu/open-seo-everyapp` until Ben merges it back upstream. Its own
write-up is
[docs/maintainers/every-app.md](https://github.com/bensenescu/open-seo-everyapp/blob/main/docs/maintainers/every-app.md);
ask Ben for access if you can't open it. The first-party runbook is
[docs/EVERY_APP_DEPLOYMENT.md](https://github.com/bensenescu/open-seo-everyapp/blob/main/docs/EVERY_APP_DEPLOYMENT.md).

### Three deployments, one codebase

| Deployment              | Kind                                              | Tenancy       | Database                 | Status                                                                       |
| ----------------------- | ------------------------------------------------- | ------------- | ------------------------ | ---------------------------------------------------------------------------- |
| app.openseo.so          | Not Every App                                     | Multi-tenant  | Postgres                 | Production; never touched by this work                                       |
| OpenSEO on everyapp.com | First-party, shared                               | Multi-tenant  | One Postgres, Hyperdrive | Built; waits for the hosted gateway                                          |
| An organization's fork  | Third-party (hosted), or an org app (self-hosted) | Single-tenant | The organization's D1    | Live on everyapp.team as an org app; hosted forks wait for the dispatch tier |

One switch, `AUTH_MODE=everyapp`, turns on the Every App mode. Three
settings pick the shape:

|                     | First-party                                        | Fork                                                  |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| `EVERY_APP_ORG_ID`  | Unset: the organization comes from each token      | Set by the deploy: pinned to one organization         |
| `EVERYAPP_SHARED`   | `1` on both Workers: every gateway call says whose | Unset: a call that names nobody is the organization's |
| `DATABASE_PROVIDER` | `postgres`, through `HYPERDRIVE` on both Workers   | `d1`                                                  |

### How each concern maps to code

| Concern                  | Where in OpenSEO                                                                      | What it does                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode switch              | `src/lib/auth-mode.ts`                                                                | `AUTH_MODE=everyapp` turns the mode on everywhere, client and server                                                                                                                                                |
| Identity to rows         | `src/middleware/ensure-user/everyApp.ts`, `src/server/auth/delegated-organization.ts` | First-party: creates the organization with the token's id on first sight, then a user and member row. Fork: one `shared-workspace` organization, other tokens refused. Authorization always reads the token         |
| Data scoping             | The existing schema                                                                   | Every product table already hangs off `organization_id` or `project_id`, as on app.openseo.so, so no new code was needed                                                                                            |
| Whose gateway call it is | `src/server/lib/gateway-attribution.ts`                                               | `serveEveryAppRequest()` forwards the request's identity; `forOrganization()` names the organization for background work; `gatewayCallFor()` picks which, and refuses a named organization that isn't the request's |
| Workflows                | `src/server/workflows/pgStep.ts`                                                      | Each Workflow names its payload's organization around `run()`, and `pgStep` carries it into every step                                                                                                              |
| Provider access          | `src/server/lib/provider-access.ts`                                                   | DataForSEO and Context through `integrationFetch`; `hasProviderAccess()` asks the gateway whether a key is set                                                                                                      |
| Plan limits              | `src/server/lib/deployment-tier.ts`                                                   | Limits read the deployment tier (`first_party` or `fork`), not the auth mode                                                                                                                                        |
| Cookies                  | `src/server/everyapp/cookies.ts`                                                      | Drops any `Set-Cookie` behind the gateway                                                                                                                                                                           |
| Tools                    | `src/server/everyapp/tools.ts`                                                        | One tool list feeds OpenSEO's own MCP server and the gateway's catalog; tool calls are pinned to the token's organization                                                                                           |
| SAM chat sockets         | `src/server/features/sam/samSocketLifetime.ts`                                        | Closes each socket after 15 minutes so the client reconnects through the gateway                                                                                                                                    |
| Worker config            | `cloudflare.config.ts`, `vite-plugin-every-app.ts`                                    | The app Worker from `everyAppWorker()`; the site-audit engine as a helper from `everyAppAuxiliaryWorker()`                                                                                                          |
| Manifest                 | `everyapp.config.ts`                                                                  | D1 and KV for the fork shape, the audit helper, three Workflows, OpenRouter, and the DataForSEO and Context capabilities                                                                                            |

### A lesson from the live fork: helpers are tenants too

On 2026-10-18 every rendered page of a site audit on everyapp.team failed.
The audit helper Worker had no `EVERY_APP_ORG_ID`, so its Context calls named
OpenSEO's internal `shared-workspace` id instead of the organization's, and
the gateway refused them as `caller_org_mismatch`. The deploy had sent the
organization pin only to the app's Worker. #331 fixed it: every helper now
gets `GATEWAY_URL` and `EVERY_APP_ORG_ID` like the app's Worker.

The rule this teaches: any Worker that calls the gateway needs the same
tenancy settings as the app's Worker. In a shared first-party app that means
every helper also has `EVERYAPP_SHARED=1` and names an organization on every
call.

### What a hosted fork can't do yet

Two checks stand between a fork and the dispatch tier. The manifest check
(`manifestTierProblems` in `packages/perimeter`, run by the CLI, and the
hosted deploy API's `manifestProblems`) refuses Hyperdrive, R2 and the
inbound-mail declaration (`email: { inbound: true }`). The hosted deploy
API also refuses KV, Workflows, crons and helper Workers. Internet egress is blocked by default. OpenSEO's fork shape uses KV, R2, Workflows, a cron and a helper, and it fetches arbitrary customer sites.
So hosted forks ship in tiers (TODO.md, "OpenSEO in Every App"):

1. **Tier 0**: research tools, SAM chat and Google through the gateway, with
   audits, rank tracking and AI visibility hidden. Needs a manifest without
   Workflows, crons, KV, R2 or the audit helper, and a `crawl` egress
   capability.
2. **Rank tracking** once the gateway has a scheduler and a job runner.
3. **AI visibility** next.
4. **Audits** last, after a spike decides between one Worker and a helper.

The first-party deployment keeps its Workflows, cron and helper Worker as
they are. None of these limits apply to it.

## Open questions

- **Google.** Designed to live in the gateway for both kinds; not built.
  OpenSEO shows Search Console and Analytics as coming.
- **Metering.** Calls are attributed and logged per organization; nothing
  bounds spend until the wallet exists. The hosted preview stays invite-only.
- **Third-party launch gate.** The rows still open in
  [hosted-platform-build.md §1](https://github.com/every-app/private-every-app/blob/5ef30882/docs/hosted-platform-build.md), among them the
  `everyapp.dev` zone, the Public Suffix List entry, and checking a dispatched
  Worker's name against its row's organization.
- **R2 on the dispatch tier.** Refused until the hosted deployer accepts R2
  bindings.

## Read next

- [hosted-platform-build.md](https://github.com/every-app/private-every-app/blob/5ef30882/docs/hosted-platform-build.md): how the hosted
  platform was built, every decision and its walk-back.
- [security-model.md](https://github.com/every-app/private-every-app/blob/main/docs/security-model.md): "Organizations and Shared Apps",
  "Dispatch Tier and Egress", "Third-Party Hosts and Per-Host Sessions",
  "Hosted Deploy API".
- [research/2026-10-hosted-platform/README.md](https://github.com/every-app/private-every-app/blob/5ef30882/docs/research/2026-10-hosted-platform/README.md):
  the research behind it, with the end-state diagram.
- [gateway/cli-deployment.md](/docs/internal/gateway/cli-deployment): what
  `everyapp deploy` does step by step.
- [packages/sdk/README.md](https://github.com/every-app/private-every-app/blob/main/packages/sdk/README.md): helper Workers,
  Hyperdrive, capabilities, "Whom a call is for".
