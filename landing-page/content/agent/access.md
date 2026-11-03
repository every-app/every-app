---
title: Cloudflare Access
description: "How Cloudflare Access fronts a self-hosted Gateway: the two Access applications, the policy that asks the Gateway who is a member (External Evaluation), every CLOUDFLARE_ACCESS_* setting, what everyapp access on, off and show change, which paths stay bypassed and why, how MCP clients reach the Gateway, and how to get back in."
metaDescription: "Put Cloudflare Access in front of a self-hosted EveryApp Gateway: the fixed recipe, the membership check, every setting, the bypassed paths, and recovery."
---

Cloudflare Access is a second wall in front of a self-hosted Gateway and its apps: everyone signs in to Access first (Sign in with Cloudflare for the members of the operator's Cloudflare account, a one-time PIN emailed to everyone else), then lands signed in to the Gateway. `everyapp setup` turns it on by default once the owner exists ([Setup](/docs/agent/setup#recommended-put-cloudflare-access-in-front)); `everyapp access on` turns it on, or puts it back as it should be, any time. The person's page is [Sign in through Cloudflare Access](/docs/access).

Better Auth stays the system of record for users, sessions, organizations, roles, invitations, personal access tokens and the OAuth server MCP clients use; an Access sign-in ends in an ordinary Better Auth session, so everything after it (the perimeter, the identity tokens apps get, app access, `/mcp` and its OAuth, personal tokens, deactivation) works as after a password.

Three checks stand between a stranger and an app, and the Gateway's member list is the one list behind all of them:

1. **Access's sign-in**, then Access's policy, whose one rule asks the Gateway whether the person is a member or has a pending invitation (an External Evaluation rule, below).
2. **The Gateway's membership check** on every sign-in (`apps/every-app-gateway/src/auth/cloudflare-access/membership.ts`): members who aren't deactivated, and invitees, whose invitation is accepted then.
3. **The assertion on every request**: on an app host a Gateway session counts only alongside Access's signed header for the same person on that same request (`plugin.ts`), so a stolen Gateway cookie alone opens nothing there.

Inviting someone needs no change in Access: they get past it as soon as they are invited. Removing or deactivating someone takes effect in the Gateway at once (sessions, tokens, connections), and Access refuses them at their next Access sign-in.

Every Access setting is a Worker secret on the Gateway (`everyapp secret set <NAME>`; see [the secrets page](/docs/agent/secrets)), never something the admin UI changes, so a stolen admin session cannot add a way in (`apps/every-app-gateway/src/auth/cloudflare-access/config.ts`). A malformed setting turns its feature off and logs `access.config_problem` (level `warn`, once per isolate) rather than half-configuring it.

Access sign-in exists only in `self_hosted` mode. `apps/every-app-gateway/src/server/platform-policy.ts` sets `accessSignIn: true` for `self_hosted` and `false` for `hosted` and `invalid`; where it is false the plugin is not registered, and `accessConfigFromEnv()` (`apps/every-app-gateway/src/auth/cloudflare-access/index.ts`) reads an empty configuration and, only when some `CLOUDFLARE_ACCESS_*` or `EMAIL_PASSWORD_SIGN_IN` value is set on the Worker anyway, logs one problem: "The Cloudflare Access settings and EMAIL_PASSWORD_SIGN_IN are ignored: this gateway's GATEWAY_DEPLOYMENT_MODE has no Access sign-in.". The CLI refuses `access on` and `access off` on a hosted Gateway with `ACCESS_HOSTED` (`This Gateway can't be put behind Cloudflare Access` / `Hosted Gateways ignore the Access settings.`); `access show` answers `hosted: true` and reads nothing from Access.

The operator runbook is `docs/runbooks/cloudflare-access.md`, mirrored at [/docs/agent/repo/runbooks/cloudflare-access](/docs/agent/repo/runbooks/cloudflare-access). What Access adds to the platform's trust boundaries is in `docs/threat-model.md`, mirrored at [/docs/agent/repo/threat-model](/docs/agent/repo/threat-model).

## The two Access applications

Two hostname-based (`type: "self_hosted"`) Access applications, both attached to the reusable allow policy `Every App gateway members`:

| Application                                     | Destination           | AUD tag goes in              | Its assertions                                                        |
| ----------------------------------------------- | --------------------- | ---------------------------- | --------------------------------------------------------------------- |
| "Every App gateway" (the name `access on` uses) | the Gateway's host    | `CLOUDFLARE_ACCESS_AUD`      | Sign people in on the Gateway's host, and vouch for sessions anywhere |
| "Every App apps"                                | `*.<app base domain>` | `CLOUDFLARE_ACCESS_APPS_AUD` | Only vouch for a session on an app host; never a Gateway login        |

Why two (`apps/every-app-gateway/src/auth/cloudflare-access/outer-ring.ts`): the Gateway's host is where sign-in happens, so an app host's Access token, should it ever leak out of a browser, must never be a Gateway login. `verifyOuterRingAssertion()` accepts an assertion whose `aud` is any configured tag, and sets `maySignIn` only when one of its `aud` values is in `CLOUDFLARE_ACCESS_AUD`. One application covering both hosts (made by hand) is kept as one by `access on`, knowing any app host's Access cookie is then a Gateway login too.

Both are made with hostname destinations, never "Protect this Worker" (Worker-level Access answers WebSocket upgrades with 403), a `720h` session (the most Access allows), the `CF_Authorization` cookie HttpOnly and the binding cookie on, so a copied cookie is useless outside the browser it was issued to. They allow two sign-in methods, Sign in with Cloudflare restricted to the operator's account members and the one-time PIN (`allowedSignInProviders()` in `packages/perimeter/src/install/access-plan.ts`), so Access shows its chooser; a method the operator allowed besides in the dashboard is kept.

## The membership question (External Evaluation)

The policy `Every App gateway members` has one include rule:

```json
{
  "external_evaluation": {
    "evaluate_url": "https://<gateway>/access-evaluation/evaluate",
    "keys_url": "https://<gateway>/access-evaluation/keys"
  }
}
```

(`externalEvaluationRule()` in `packages/perimeter/src/install/access-plan.ts`: an `external_evaluation` rule whose two URLs are `/access-evaluation/evaluate` and `/access-evaluation/keys` on the Gateway's host.) After a person signs in, Access POSTs `{ "token": "<JWT>" }` to the evaluate URL: a JWT it signed with the team's key, carrying the person's `identity` (their email) and a `nonce`. The Gateway (`apps/every-app-gateway/src/server/access-evaluation.ts`):

- verifies the token: RS256, a key id in the team's JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, the keys the outer ring's assertions use, cached the same way), an unexpired `exp` (60 s clock tolerance) and a `nonce`. Anything else is `400 {"error":"invalid_token"}` and no answer (`access.evaluation_refused`, level `warn`);
- answers `success: true` only for an email that is an account belonging to an organization here and not deactivated, or that has a pending, unexpired invitation; nobody before the Gateway is claimed (`isGatewayMember()`);
- replies `{ "token": "<JWT>" }`, signed RS256 with its own key: `{ success, nonce (Access's), iat, exp: iat + 60 }`. Logged `access.evaluated` with `member` (never the email).

Access checks the answer against the keys URL, its expiry and its nonce, and lets the person in only on `true`. `GET /access-evaluation/keys` publishes the public key as a JWKS (`{ keys: [{ kty: "RSA", kid, alg: "RS256", use: "sig", n, e }] }`), `cache-control: no-store`. The key pair is made on first use and kept in the Gateway's D1 (`access_evaluation_key`, one row; the private half sealed with a key derived from `BETTER_AUTH_SECRET`, `apps/every-app-gateway/src/server/secrets/sealed.ts`); Access takes RSA keys only. Both paths answer 404 until the outer ring is configured (`CLOUDFLARE_ACCESS_TEAM_DOMAIN` and `CLOUDFLARE_ACCESS_AUD`), and both are bypassed in Access (Access calls them from its own servers).

External Evaluation is an identity selector, checked when a person signs in to Access, not on every request (Cloudflare's policy docs, "Selectors"); it is available on every Zero Trust plan (the policy docs name only User Risk Score as Enterprise-only). So a removed member's Access session lasts until it expires (`720h`), while the Gateway refuses them at once; deactivate in the Gateway, and revoke their Access session in Zero Trust → My Team → Users to end it sooner.

## Settings reference

All are in `SETTABLE_GATEWAY_SETTINGS` (`packages/sdk/src/internal/gatewaySettings.ts`), so `everyapp secret set <NAME>` routes them to the Gateway Worker. Parsing is `readAccessConfig()` in `apps/every-app-gateway/src/auth/cloudflare-access/config.ts`.

| Name                                   | Holds                                                                                                                                                                                                                                                                                                        | Problem when wrong                                                                                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCESS_TEAM_DOMAIN`        | `<team>.cloudflareaccess.com` (a scheme is allowed; the path must be empty or `/`). Its origin is the expected `iss`; keys come from `<origin>/cdn-cgi/access/certs`. `access on` writes it.                                                                                                                 | `CLOUDFLARE_ACCESS_TEAM_DOMAIN must be <team>.cloudflareaccess.com; the outer ring is off.` Set without `CLOUDFLARE_ACCESS_AUD`: `The outer ring needs both CLOUDFLARE_ACCESS_TEAM_DOMAIN and CLOUDFLARE_ACCESS_AUD; it is off.`                                      |
| `CLOUDFLARE_ACCESS_AUD`                | The AUD tag(s) of the application on the Gateway's host; comma or space separated; each `[A-Za-z0-9._:-]{1,256}`. Only assertions for these tags sign people in. `access on` writes it.                                                                                                                      | `CLOUDFLARE_ACCESS_AUD must be the AUD tag of the Access application on the gateway's host (several: comma separated); the outer ring is off.`                                                                                                                        |
| `CLOUDFLARE_ACCESS_APPS_AUD`           | The AUD tag(s) of the application on `*.<app base domain>`. Its assertions only vouch for a session on an app host. `access on` writes it.                                                                                                                                                                   | `CLOUDFLARE_ACCESS_APPS_AUD must be the AUD tag of the Access application on the apps' hosts (several: comma separated); the outer ring is off.` Set while the outer ring isn't: `CLOUDFLARE_ACCESS_APPS_AUD is set but the outer ring isn't (...); it does nothing.` |
| `CLOUDFLARE_ACCESS_IDP_IDS`            | The ids of the Access identity providers whose tokens count (comma or space separated, each `[A-Za-z0-9_-]{1,128}`; `access show` lists them). Set, an assertion or ID token from another provider, or one with no `idp.id` claim, is refused (`access.idp_refused`). Unset: any provider the policy admits. | `CLOUDFLARE_ACCESS_IDP_IDS: "<entry>" isn't an identity provider id; skipped.`                                                                                                                                                                                        |
| `CLOUDFLARE_ACCESS_OIDC_ISSUER`        | OIDC sign-in only (below): `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>`; the endpoints derive from it.                                                                                                                                                                          | `CLOUDFLARE_ACCESS_OIDC_ISSUER must be https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>; OIDC sign-in is off.`                                                                                                                                 |
| `CLOUDFLARE_ACCESS_OIDC_CLIENT_ID`     | The Access for SaaS application's client id.                                                                                                                                                                                                                                                                 | With any of the three OIDC values missing: `OIDC sign-in needs CLOUDFLARE_ACCESS_OIDC_ISSUER, CLOUDFLARE_ACCESS_OIDC_CLIENT_ID and CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET; it is off.`                                                                                  |
| `CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET` | Its client secret, used with PKCE (S256).                                                                                                                                                                                                                                                                    | As above.                                                                                                                                                                                                                                                             |
| `CLOUDFLARE_ACCESS_OIDC_LABEL`         | The button's label, `Continue with <label>`; trimmed to 40 characters; default `Cloudflare Access`.                                                                                                                                                                                                          | None.                                                                                                                                                                                                                                                                 |
| `EMAIL_PASSWORD_SIGN_IN`               | On: `true`, `1`, `on`, `yes` or unset. Off: `false`, `0`, `off`, `no`. Turns password sign-in off once an owner can sign in another way (Access or a [sign-in provider](/docs/agent/signin)).                                                                                                                | `EMAIL_PASSWORD_SIGN_IN is neither on nor off, so password sign-in stays on. Use "false".`; with no other sign-in configured: `EMAIL_PASSWORD_SIGN_IN=false is ignored: ...`                                                                                          |

`EMAIL_PASSWORD_SIGN_IN=false` takes effect only while some owner has a linked Access identity or sign-in provider identity (`isPasswordSignInOn()` in `membership.ts`), so it cannot lock the owner out; behind the outer ring an owner's identity is linked on their first Access sign-in. In effect, the Better Auth password paths answer `403 PASSWORD_SIGN_IN_DISABLED` and the sign-in page shows only the other methods. Set it to `true` to turn passwords back on.

Locally, the settings go in `.dev.vars`; loopback URLs are accepted only in `vite dev` builds, for the mock Access in `apps/every-app-gateway/scripts/access-local.mjs`.

### OIDC sign-in

Besides the outer ring, Access for SaaS can be a "Continue with <label>" button on the sign-in page (an OIDC provider, `oidc-provider.ts`). `access on` doesn't make it; the runbook's "OIDC sign-in" section has the `cf zero-trust access applications create` body (redirect URI `https://<gateway>/api/auth/callback/cloudflare-access`, scopes `openid email profile`, PKCE). An existing account is linked through Better Auth's rules: only when its email is verified, else after one password sign-in (`account_not_linked`).

## Bypassed paths

Only machine endpoints, which check their own credentials, are let through (Access path overrides with `behavior: "public"`). The list is `GATEWAY_BYPASS_PATHS`, `MCP_PATHS` and `appsDestinations()` in `packages/perimeter/src/install/access-plan.ts`:

| Path                                                                  | On which destination                                                        | Why it is bypassed                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/mcp`, `/mcp/*`                                                      | the Gateway's host                                                          | MCP clients authenticate with an OAuth token or a personal access token, not a browser session; Access would answer them with an HTML login. An app host serves no MCP                                                                                                         |
| `/oauth/token`, `/oauth/register`                                     | the Gateway's host                                                          | The OAuth server's token, revocation and dynamic registration endpoints: clients call them from servers                                                                                                                                                                        |
| `/linked-dev/*`                                                       | the Gateway's host                                                          | `everyapp dev --gateway` ([dev](/docs/agent/dev#mode-linked-a-real-gateways-services-as-you)); bearer only, a cookie there is `401`                                                                                                                                            |
| `/.well-known/*`                                                      | the Gateway's host                                                          | OAuth discovery documents, fetched before any login                                                                                                                                                                                                                            |
| `/health`                                                             | the Gateway's host                                                          | Uptime monitors ("Uptime monitoring" below); reads no session, names no version                                                                                                                                                                                                |
| `/api/auth/callback/apple`                                            | the Gateway's host                                                          | Sign in with Apple returns with a cross-site POST that only redirects to the same URL as a GET, which Access checks as usual (`/docs/agent/signin`)                                                                                                                            |
| `/access-evaluation/*`                                                | the Gateway's host                                                          | Access's own call asking who is a member, and the key it checks the answer with (above)                                                                                                                                                                                        |
| Each app's `public` routes                                            | that app's host (its own destination)                                       | Whatever the app's `everyapp.config.ts` declares `public` (webhooks, a tracking script and its collector) must be reachable by strangers                                                                                                                                       |
| Each app's bearer routes, and `/.well-known/oauth-protected-resource` | that app's host, when its manifest has a `public` entry with `bearer: true` | Native apps signed in with "Sign in with Every App" call these paths with a Gateway OAuth token; the perimeter refuses a cookie there. The discovery document is written by the Gateway, never proxied (`PROTECTED_RESOURCE_METADATA_PATH`; [Native apps](/docs/agent/native)) |

Everything else stays behind Access, `/oauth/authorize` and the consent pages included: they are pages for people. The CLI needs no bypass: it reads and writes the Gateway's D1 through the Cloudflare API, never through the Gateway. Access path overrides don't cover subpaths, so the `/*` forms are used; a destination takes at most 25 overrides. The Gateway answers every other spelling of a bypassed path its routes don't serve (`/HEALTH`, `/MCP`, an unclaimed `/.well-known/<name>`) with a JSON 404, never the control plane (`ACCESS_BYPASSED_EXACT` in `apps/every-app-gateway/src/server.ts`).

An app gets a destination of its own on its host when its manifest has public routes (bearer ones included), because Access picks the most specific matching destination: `/.well-known/oauth-protected-resource` and the bearer routes first, then the public routes, each in manifest order, each once. A manifest path becomes an Access `path_pattern` by `accessPathPattern()`: `**` collapses to `*`, a `:name` segment becomes `*`, and a segment left with two wildcards (`/a*b*`) has no equivalent. The Gateway still enforces the route (its globs are narrower and methods count). What the plan leaves out is a warning on step `access.routes`: `ACCESS_ROUTE_NOT_EXPRESSIBLE` (no Access pattern; the route stays behind Access; a bearer route is marked `bearer: true` in `data.routes`), `ACCESS_TOO_MANY_PUBLIC_ROUTES` (past the 25th override), `ACCESS_APP_OUTSIDE_BASE` (an app whose host isn't one label below the app base domain).

### Only `access on` writes them

A deploy never changes Access. `access on` reads every served app's public surface (`readPublicSurfaces()` in `packages/cli/src/lib/access/applications.ts`: `apps` rows with status `binding`, `active` or `disabled`, from the manifest each was last deployed from) and writes the apps application from it. When a deploy changes an app's public routes (its `public` entries, `publicAssets` or `mcp`, compared with the manifest it replaces) and the Gateway Worker has all three Access settings, `deploy` ends with the warning `ACCESS_RERUN_NEEDED` on step `app.access`: `Cloudflare Access doesn't know <app>'s new public routes yet` / `Until pnpm everyapp access on runs again, they need an Access sign-in.`, `data: { appId, rerun: "pnpm everyapp access on" }`. A browser install that changes them logs `access.rerun_needed` on the Gateway. A deleted app's destination stays until the next `access on`; its host serves nothing, and `delete` of an app that had public routes ends with the same warning (`Cloudflare Access still lets <app>'s public routes through on <host>`).

Run `access on` again after such a deploy, after a Gateway release whose notes say the Gateway's bypass list changed, and after changing Access by hand. Never for an invitation.

#### Uptime monitoring

The Gateway: `GET https://<gateway>/health`, public and bypassed; `200 {"status":"ok"}` when the Gateway reaches its database within two seconds, `503 {"status":"error","database":"down"}` otherwise, `cache-control: no-store` (`apps/every-app-gateway/src/server/health.ts`). Point the monitor there; it needs no credential.

One app: its routes are private, so either keep `public: [{ path: "/health" }]` in its manifest and let the monitor fetch it without a credential (then run `access on`), or send a personal access token of a dedicated monitoring member bound to that app, plus an Access service token (`CF-Access-Client-Id`, `CF-Access-Client-Secret`) from a reusable Service Auth policy on the "Every App apps" application (`access on` keeps a policy it finds there beside its own). The service-token path is unverified live.

## What the Gateway does with the assertion

The Gateway verifies the assertion itself (it serves static assets, so Cloudflare doesn't hand it `ctx.access`), with `verifyAccessJwt()` in `apps/every-app-gateway/src/auth/cloudflare-access/jwt.ts`:

- The token is the `Cf-Access-Jwt-Assertion` header, else the `CF_Authorization` cookie.
- RS256 with a `kid` found in the team's JWKS: cached 10 minutes per isolate, refetched for an unknown `kid` at most every 30 seconds, a fetch given up after 5 seconds. A failed fetch fails closed (`access.jwks_fetch_failed`, level `error`).
- `iss` the team domain's origin, `aud` one of the configured tags, `exp` present (60 s clock tolerance).
- A non-empty `email` (a service token has none) and not `email_verified: false`; the email is lowercased.
- `type` must be `"app"`: Access's organization token is never a vouch for an application.

The Better Auth plugin (`apps/every-app-gateway/src/auth/cloudflare-access/plugin.ts`) then applies these rules:

- **Sign-in** happens only on the Gateway's own host, on a browser's `GET /api/auth/get-session`, with an assertion whose `maySignIn` is true. No session, or an expired one: the person is signed in (`access.signed_in`, `mode: "outer-ring"`): the account with that email, linked to the Access identity on its first sign-in and its email marked verified (`access.account_linked`), else a new account for an invitee. A session for someone else: it is deleted (`access.session_replaced`) and the Access person signed in.
- **Everywhere else** (the perimeter on app hosts, server functions, the OAuth pages; any other host; non-GET), a session counts only with a verified assertion for the same email on that request; otherwise `get-session` answers `null` (`access.session_unvouched`, `access.session_mismatch`). Better Auth's other endpoints over HTTP, except `/get-session` and `/sign-out`, have an unvouched session cookie stripped first (`access.session_ignored`). Personal access tokens and OAuth tokens don't pass through this.
- **Nothing is made for anyone else.** Behind the outer ring an account or session created over HTTP is refused unless Access vouches for the same email on the request: `403 ACCESS_REQUIRED` ("This gateway signs people in through Cloudflare Access, and this request didn't come through it.") without an assertion, `ACCESS_EMAIL_MISMATCH` with someone else's. The sign-in page explains both, using `accessEmail` from `GET /api/auth/sign-in-methods`, with a **Not you? Sign out of Access** link to `/cdn-cgi/access/logout`.
- **Sign out** goes to `/cdn-cgi/access/logout` when the browser came through the outer ring (`Sidebar.tsx`).
- **Apps never see Access.** The perimeter strips every `cf-access-*` header and the cookie header before proxying (`packages/perimeter/src/headers.ts`).

Linking an existing account by email on its first Access sign-in is safe behind the outer ring because no session there counts without Access's word for that same email on the request: an account registered under someone else's address is of no use to whoever registered it.

## `everyapp access on|off|show`

`packages/cli/src/commands/access/command.ts` defines the three verbs, `packages/cli/src/commands/access/index.ts` runs them, over `packages/perimeter/src/install/access-plan.ts` (the plan, pure, re-exported as `packages/cli/src/lib/access/plan.ts`), `packages/cli/src/lib/access/applications.ts` and `packages/cli/src/lib/cf/access.ts` (the Zero Trust API through `cf`). Step by step for an agent: `packages/cli/skills/everyapp/setup/access.md`. All three verbs take `--gateway`, `--account-id`, `--json` and `--verbose`. Every call to Access needs a Cloudflare login with Access: Apps and Policies (edit) and Access: Organizations, Identity Providers, and Groups (edit); without them cf's refusal becomes `ACCESS_PERMISSION_MISSING` (`This Cloudflare login can't manage Access`) with `data.url` `https://dash.cloudflare.com/profile/api-tokens`. Nothing is kept on the machine: the applications are found again by what they cover, the policy by its name.

### `access on`

`pnpm everyapp access on [--team <name>]` is one fixed recipe, safe to run again any time; it changes only what differs in Access and leaves alone what it didn't set up. In the `--json` stream it runs as step `access.update` (`start` `Checking Cloudflare Access...`, a `progress` event per create or update, then `ok`), with the plan warnings on `access.routes`.

1. **Refuses until the Gateway has an owner**: `ACCESS_NOBODY_ALLOWED` (`Claim the Gateway first` / `Access lets in the Gateway's members and invitees, and it has none yet, so nobody could open the setup link.`). **And until the live Gateway answers Access's membership question**: `GATEWAY_OUTDATED` (`The Gateway predates Access's membership check`, `data.rerun` `pnpm everyapp update`) when its D1 has no `access_evaluation_key` table, since a policy asking a Gateway that can't answer would refuse everyone.
2. **The Zero Trust team.** None in the account: at a terminal it asks for the name (the zone's first label is suggested); unattended without `--team` it fails with `ACCESS_TEAM_REQUIRED` (`data.suggested`). Not a name (lowercase letters, digits and dashes): `ACCESS_TEAM_INVALID`. Refused by Cloudflare (names are shared): `ACCESS_TEAM_CREATE_FAILED`. A new team gets a `720h` global session; an existing team's is left alone, and `--team` is ignored once a team exists. The team domain is permanent once used.
3. **The two ways to sign in**: Sign in with Cloudflare (type `cloudflare`, `restrict_to_account_members: true`) and the one-time PIN (`onetimepin`), each created when the team lacks one. The applications allow these two; the team's other providers are listed in `done.data.signInMethods` with `allowed: false`.
4. **The policy** `Every App gateway members` (reusable, `decision: allow`, found by name): created, or its include list set to the one External Evaluation rule when it says anything else (an email list from an earlier version is replaced).
5. **The two applications**: the apps' first, so its AUD exists before the settings name it. Created with the destinations above, the policy, `720h`, HttpOnly and the binding cookie, the two sign-in methods and `app_launcher_visible` true for the Gateway's, false for the apps'. An existing one is updated only in what `on` owns (our destinations, with foreign ones kept; our policy beside its others; the two cookie settings; our sign-in methods beside what it allowed), and only when something differs.
6. **The Gateway's settings** `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `CLOUDFLARE_ACCESS_APPS_AUD` and `CLOUDFLARE_ACCESS_AUD`, all three in one new Worker version, every run (values can't be read back, so writing them is how an application recreated by hand, with a new AUD tag, is picked up), through `applyGatewaySettings()` in `packages/cli/src/commands/secret/index.ts`.

`access.changed` is queued for the install organization's event subscribers when the run changed something in Access or a setting was missing. An earlier choice to leave Access off (below) is cleared.

The `done` event's `data`: `{ team: { domain, created }, signInMethods: [{ id, type, name, allowed, restrictToAccountMembers? }], policy: { id, name, outcome }, applications: { gateway, apps, combined }, settings: { names }, signIn: { url } }`, each application `{ id, aud, name, outcome: "created" | "updated" | "unchanged", destinations: [{ uri, public: [path patterns] }], allowedIdps }`.

### `access off`

`pnpm everyapp access off` asks first (`Turn Cloudflare Access off for <host>?`); unattended it fails with `CONFIRMATION_REQUIRED` unless `--yes` (`-y`), and a "no" is `CANCELLED` ("Cancelled. Access stays on."). First the three settings are removed in one Worker version (the Gateway stops requiring an assertion at once), then the two applications are deleted; one that also covers something else keeps only the destinations that aren't EveryApp's. The team, its identity providers and the policy stay. Running it records the choice to leave Access off in the Gateway's D1 (`_everyapp_access_off`), so an unattended `setup` doesn't put it back on. Nothing to remove: `Cloudflare Access isn't in front of <host>. Nothing changed.`, `data.removed: false`. Otherwise `data` is `{ removed: true, settings: [names removed], applications: { deleted: [ids], trimmed: [ids] } }`.

### `access show`

`pnpm everyapp access show` changes nothing. It reports whether Access is on (all three settings on the Worker and an application on the Gateway's host), the team, whether the policy asks the Gateway (`policy.asksGateway`), the sign-in methods, both applications and which settings the Worker has. `data`: `{ on, hosted, team: { domain } | null, policy: { id, name, asksGateway } | null, signIn: { methods } | null, applications: { gateway, apps, combined }, settings: { names }, fixes? }`; `fixes` holds `pnpm everyapp access on` when Access isn't on, the policy doesn't ask the Gateway, or the apps' application is missing.

`pnpm everyapp status` says whether Access is on from the Gateway Worker's secret names alone (`accessStateOf()` in `packages/cli/src/lib/access/settings.ts`): `data.access` is `{ on }`, the row reads `on · everyone signs in through Cloudflare Access first` or `off`; it asks nothing of Zero Trust. When the Worker's secrets couldn't be listed the row reads `! couldn't check` and the problem `ACCESS_UNKNOWN` is one of `data.fixes`.

### The `ACCESS_IN_FRONT` warning

Raised when the CLI's own HTTPS probe finds Access answering before the Gateway (`probeHttps()` in `packages/cli/src/lib/domains/https.ts`: a 3xx to `cloudflareaccess.com` or `/cdn-cgi/access/`).

- `everyapp setup`, step `setup.owner`: `Cloudflare Access protects <host>` / `Whoever opens the setup link signs in to Access first.`
- `everyapp deploy`, step `app.live`, only when the wait runs out. Behind Access the step stops probing and reads the app's row, while the Gateway's per-minute cron sweeps every `binding` app over its service binding and makes it active (`activateDeployingApps` in `apps/every-app-gateway/src/server/app-activation.ts`); a person opening the app makes it live at once, and the launcher, which polls while an app is deploying, shows it go ready. The `progress` line meanwhile is `Waiting for the Gateway to make <app> live`. After 10 minutes still `binding`: the warning, `data: { hostname, rerun: "pnpm everyapp status", rerunNote: "then deploy again" }`, outcome `first_visit`. A brand-new Gateway's cron can take some minutes to start running.

## Membership rules

Access says who someone is (a verified email) and, through the Gateway's answer, whether they may reach it at all; the Gateway decides again on every sign-in, with Better Auth database hooks in `apps/every-app-gateway/src/auth/cloudflare-access/membership.ts`, for both ways in:

| Who                                                             | Result                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A member who isn't deactivated                                  | Signs in.                                                                                                                                                                                                                            |
| A deactivated member                                            | Refused, `ACCESS_ACCOUNT_DEACTIVATED` ("This account has been deactivated."); Access refuses them too at their next Access sign-in.                                                                                                  |
| Someone with a pending, unexpired invitation for that email     | Joins: every such invitation is accepted (status flipped first, so two sign-ins at once can't both use it), with the invited role (they open the apps available to everyone); `invitation.accepted` with `via: "cloudflare_access"`. |
| Everyone else                                                   | Refused, `ACCESS_NOT_INVITED` ("You don't have an account on this gateway. Ask an admin to invite you."); nothing is created. Access refuses them first.                                                                             |
| Anyone, before the Gateway has been claimed with its setup link | Refused, `ACCESS_NOT_SET_UP` ("This gateway hasn't been set up yet: its owner signs in first.").                                                                                                                                     |

After an OIDC sign-in the code comes back to the sign-in page as `?error=<code>` and is explained there (`accessSignInErrorMessage()` in `apps/every-app-gateway/src/client/sign-in-methods.ts`); a refused outer-ring sign-in logs `access.sign_in_refused` with the code as `reason` and makes no session.

Deactivate in **Manage workspace → Users → ⋯ → Deactivate** (or `everyapp workspace deactivate`): that signs the person out everywhere at once and revokes their personal access tokens and AI app connections. Deleting (removing) a member works the same with Access on; since Access asks the Gateway, a removed person is no longer let in at their next Access sign-in.

## MCP and API clients behind Access

The Gateway's `/mcp`, `/oauth/token`, `/oauth/register` and `/.well-known/*` are bypassed, so MCP clients are unaffected: `/mcp` takes an OAuth token the Gateway issued or a personal access token (`epat_…`); an app host serves no MCP. Connecting an AI app shows Access's login in the browser at `/oauth/authorize`, because that page is for people: the person signs in to Access, then reaches the Gateway's consent page. An Access assertion is never a credential on `/mcp`: a request carrying only one is asked for a token (`401`, `WWW-Authenticate: Bearer`). What claude.ai and Claude Code need is nothing beyond the bypasses ([MCP](/docs/agent/mcp)).

A native app signed in with "Sign in with Every App" ([Native apps](/docs/agent/native)) passes Access's login once, in the system browser, at `/oauth/authorize`; its token exchange uses `/oauth/token`, bypassed, and its calls to the app host reach only the app's bearer routes, which `access on` bypasses with the discovery document.

Personal access tokens and service tokens: a script's `Authorization: Bearer epat_…` works on every bypassed path. Elsewhere on an app host it also needs an Access service token (`CF-Access-Client-Id` and `CF-Access-Client-Secret`) from a reusable Service Auth policy on that application; the service token alone opens nothing (its assertion names no person, so the Gateway ignores it and checks the personal token).

## Recovery

All Access settings are Worker secrets, so getting back in is removing or changing one; each is a new Worker version, live at once.

- **Locked out behind the outer ring** (a wrong AUD tag, Access misconfigured, the owner's email isn't the one Access asserts): `pnpm everyapp access off` removes the three settings and the applications; `pnpm everyapp secret unset CLOUDFLARE_ACCESS_AUD` removes just that one (the outer ring is off at once; Access still guards the hostnames). Without a checkout, `cf workers secrets delete CLOUDFLARE_ACCESS_AUD --worker every-app-gateway` uploads a new version without it.
- **Nobody gets past Access** ("You don't have access" after the PIN): the policy asks the Gateway, so the Gateway must answer. Check the Gateway is up (`/health`), that the person is a member or invited, and the Worker's logs for `access.evaluated` (`member: false`) or `access.evaluation_refused`. `pnpm everyapp access show` says whether the policy still asks the Gateway; `access on` puts it back.
- **Passwords turned off and Access down:** `pnpm everyapp secret set EMAIL_PASSWORD_SIGN_IN` with `true`.
- **Access signed the browser in as the wrong person:** **Not you? Sign out of Access** on the sign-in page, or `/cdn-cgi/access/logout`.
- **"This gateway signs people in through Cloudflare Access, and this request didn't come through it."** (`ACCESS_REQUIRED`): Access isn't in front of that hostname, the path is bypassed, or the AUD tag is wrong (an application recreated in the dashboard has a new one): run `pnpm everyapp access on`, which writes the settings again.
- **Apps send people back to the sign-in page:** the app hosts' Access application isn't one the Gateway knows; `access on` writes its AUD to `CLOUDFLARE_ACCESS_APPS_AUD`.
- **An app's webhook or public page gets Access's login:** the app's public routes changed since the last `access on` (`deploy` said `ACCESS_RERUN_NEEDED`); run it again.
- **WebSocket 403 behind the outer ring:** the application is attached to the Worker; use hostname destinations.

Logs to grep: `access.config_problem`, `access.jwks_fetch_failed`, `access.evaluated`, `access.evaluation_refused`, `access.signed_in` (`mode: "outer-ring"`), `access.sign_in_refused`, `access.session_ignored`, `access.session_unvouched`, `access.session_mismatch`, `access.session_replaced`, `access.account_linked`, `access.account_link_skipped`, `access.idp_refused`, `access.rerun_needed`, `invitation.accepted` (`via: "cloudflare_access"`).

## Sources

- `docs/runbooks/cloudflare-access.md`
- `docs/security-model.md`
- `apps/every-app-gateway/src/server/access-evaluation.ts`
- `apps/every-app-gateway/src/auth/cloudflare-access/config.ts`
- `apps/every-app-gateway/src/auth/cloudflare-access/index.ts`
- `apps/every-app-gateway/src/auth/cloudflare-access/jwt.ts`
- `apps/every-app-gateway/src/auth/cloudflare-access/outer-ring.ts`
- `apps/every-app-gateway/src/auth/cloudflare-access/membership.ts`
- `apps/every-app-gateway/src/auth/cloudflare-access/plugin.ts`
- `apps/every-app-gateway/src/auth/cloudflare-access/oidc-provider.ts`
- `apps/every-app-gateway/src/server/app-activation.ts`
- `apps/every-app-gateway/src/server.ts`
- `packages/perimeter/src/install/access-plan.ts`
- `packages/perimeter/src/headers.ts`
- `packages/sdk/src/internal/gatewaySettings.ts`
- `packages/cli/src/commands/access/command.ts`
- `packages/cli/src/commands/access/index.ts`
- `packages/cli/src/lib/access/applications.ts`
- `packages/cli/src/lib/access/record.ts`
- `packages/cli/src/lib/access/settings.ts`
- `packages/cli/src/lib/cf/access.ts`
- `packages/cli/src/commands/deploy/deployApp.ts`
- `packages/cli/src/commands/deploy/steps/waitForLive.ts`
- `packages/cli/src/commands/setup/runSetup.ts`
- `packages/cli/skills/everyapp/setup/access.md`
- `landing-page/content/docs/access.mdx`
