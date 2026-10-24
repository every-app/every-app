# Threat model

This is the model behind [docs/security-model.md](security-model.md). That
document describes the mechanisms, one by one; this one says what they are
for: what is being protected, from whom, across which boundaries, under which
invariants, and where each invariant is enforced and tested. It is written
for someone who wants to find a hole: pick an invariant, read the code it
points at, and try to make the test's negative case pass.

Every App is alpha software, moving fast, and the operator is root (see
"Actors"). Read the known gaps at the end before relying on anything.

The self-hosted shape is what launches, and is described first. The hosted
shape (our own install of the same code) comes second: its extra boundaries
are built, mostly unverified against a live Workers for Platforms namespace,
and switched off by default.

Verified against the code at commit `c0f916ad` (main on 2026-10-23, after #379); the register's line numbers refer to that commit.

## How to use this document

- Each invariant has a stable id (`perimeter.csrf-private-fail-closed`),
  one testable sentence, the code that enforces it (`path:line`) and the
  test that pins it (`file :: test name`). Line numbers drift; the symbol
  names drift less; the ids don't. Each boundary below quotes the ones to
  try first; the complete register of 317 is
  [docs/threat-model-invariants.md](threat-model-invariants.md).
- "Pinned" means a test fails if the invariant breaks. "Partial" means a
  test covers some cases. "Unpinned" means the code does it and nothing
  tests it. "Not enforced" means the docs say it and the code doesn't.
- The tests run per package: `pnpm -C apps/every-app-gateway exec vitest run
  --silent=true <file>`, `pnpm -C packages/perimeter exec vitest run <file>`,
  and the same for `packages/sdk`, `packages/toolbus` and `packages/cli`.
  `docs/TESTING.md` describes the suites.
- Found something? See "Reporting a problem" at the end.

## The system in one picture

```
                 ┌───────────────────────── your Cloudflare account ─────────────────────────┐
                 │                                                                           │
 browser ──────┐ │  ┌─ Cloudflare Access (optional outer ring) ─┐                           │
 AI client ────┼─┼─►│  bypasses: /mcp, /oauth/token, /oauth/    │                           │
 webhook/API ──┘ │  │  register, /.well-known/*, public routes  │                           │
                 │  └──────────────────┬────────────────────────┘                           │
                 │                     ▼                                                     │
                 │     ┌────────── Gateway Worker (the only public Worker) ──────────┐       │
                 │     │ control plane: sign-in, sessions, organizations, admin,     │       │
                 │     │   setup claim, invitations, /mcp, the OAuth server           │       │
                 │     │ perimeter: per app host, classifies the route, strips       │       │
                 │     │   Cookie / Authorization / x-everyapp-* / cf-access-*,      │       │
                 │     │   checks session + organization + app access + CSRF,        │       │
                 │     │   mints a 2-minute RS256 identity JWT (aud = Worker name)   │       │
                 │     │ D1: users, sessions, organizations, apps registry, tokens,  │       │
                 │     │   connections, audit rows      KV: OAuth server state       │       │
                 │     └──────┬───────────────────────────────────▲──────────────────┘       │
                 │  service binding (private)            AppGateway binding (RPC):           │
                 │  x-everyapp-identity, or               AI proxy, capabilities, email,      │
                 │  x-everyapp-public marker              members, tool catalog              │
                 │            ▼                                   │                           │
                 │     ┌─────────────────────────────────────────┴──────────────────┐       │
                 │     │ app Worker  every-<orgKey>-<appId>   (no routes, no        │       │
                 │     │   workers.dev, no preview URLs; the SDK verifies the JWT)  │       │
                 │     │   its own D1 / KV / R2 / Durable Objects / Workflows /     │       │
                 │     │   Hyperdrive; helper Workers  <worker>--<name>             │       │
                 │     └────────────────────────────────────────────────────────────┘       │
                 │                                                                           │
                 │  operator's laptop or CI ── cf CLI with the Cloudflare login ──► Workers,  │
                 │  (everyapp deploy / setup)                                      D1 writes  │
                 └───────────────────────────────────────────────────────────────────────────┘
                                             │ provider keys stay on the Gateway
                                             ▼
                        OpenAI / OpenRouter / Workers AI / DataForSEO / Context.dev /
                        social networks' token endpoints / Email Sending
```

The one rule everything else hangs on: **a person's credential stops at the
Gateway**. Apps never see a cookie or a bearer token. They see a short-lived
signed statement of who the person is, minted for that app's Worker alone,
or a signed marker saying "nobody". Everything an app wants from the outside
world that needs a credential the operator holds goes back through the
Gateway, attributed to an organization.

## Deployment shapes

| | Self-hosted (launches 2026-10-27) | Hosted (ours; not launching) | Local (`everyapp dev`) |
|---|---|---|---|
| Who runs it | A person or a 3–4 person company, in their own Cloudflare account on Workers Paid | Every App, at `app.everyapp.com` | A developer, on their machine |
| `GATEWAY_DEPLOYMENT_MODE` | `self_hosted` | `hosted` | `self_hosted` (the dev build's default) |
| Sign-up | Invite-only; the setup link makes the first owner | Open into personal organizations once claimed, behind a daily mail budget; `HOSTED_OPEN_SIGNUP=false` keeps it invite-only (the preview default) | A seeded dev user |
| Apps | Private Workers in the same account, one organization | Shared first-party Workers (one per app, every organization) plus, behind a launch gate, third-party Workers in a dispatch namespace | The app under `vite dev` behind a gateway-lite |
| Deploy authority | The Cloudflare login (ADR-0003) | Our CLI for first-party apps; deploy keys or an admin's GitHub install for third-party apps | None |
| Cloudflare Access | Recommended: the outer ring in front of everything, or OIDC sign-in | Ignored (`platformPolicy` refuses it) | A mock (`apps/every-app-gateway/scripts/access-local.mjs`) |
| Identity key | The install's `JWT_PRIVATE_KEY`, `kid: everyapp-identity` | The same | A public dev key pair, `kid: everyapp-dev`, accepted only under `EVERYAPP_DEV` |

Anything but `self_hosted` or `hosted` in `GATEWAY_DEPLOYMENT_MODE` (unset
included) is `invalid` and turns every capability off: no setup claim, no
Access sign-in, no app activation, no dynamic client registration, no account
actions, no outbound mail (`apps/every-app-gateway/src/server/platform-policy.ts`).

## Assets

What an attacker would want, roughly in the order it would hurt.

| Id | Asset | Where it lives | Who may touch it |
|---|---|---|---|
| A1 | The Cloudflare account and its credentials (the operator's login, `CLOUDFLARE_API_TOKEN` in CI, the browser-install token) | Cloudflare; the operator's machine; the Gateway's secrets when browser installs are on | The operator |
| A2 | The Gateway's signing material: `JWT_PRIVATE_KEY` (identity tokens), `BETTER_AUTH_SECRET` (sessions, host sessions through HKDF, the setup and invitation hashes) | Worker secrets | Nobody reads them; the Gateway uses them |
| A3 | Provider keys and OAuth client secrets the operator configured (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `WORKERS_AI_API_TOKEN`, `DATAFORSEO_*`, `CONTEXT_API_KEY`, `LINKEDIN_CLIENT_SECRET`, …, `EMAIL_REST_API_TOKEN`, `RESEND_API_KEY`) | Worker secrets | Apps use them only through the Gateway's proxies, never hold them |
| A4 | Each app's data: its D1 databases, KV, R2, Durable Objects, Postgres through Hyperdrive | The app's own bindings | That app's Worker, for members with access |
| A5 | Accounts and sessions: emails, password hashes, Better Auth sessions, verification and reset tokens | The Gateway's D1 | The person; admins act on members of their organization |
| A6 | Organizations, memberships, roles, app access grants, invitations | The Gateway's D1 | Owners and admins of that organization |
| A7 | Personal access tokens (`epat_…`, only a hash stored), OAuth grants and refresh tokens for connected AI apps, deploy keys (hosted) | The Gateway's D1 and KV | The person who made them; revoked by them, by removal, by deactivation |
| A8 | The app registry: which Worker serves which hostname, with which manifest (public routes, capabilities, tools) | The Gateway's D1 (`apps`) | The operator through the CLI; the Gateway reads and validates it |
| A9 | The Gateway's own code and configuration (what version serves, what settings are set) | The Worker | The operator |
| A10 | What the audit rows and logs record (`mcp_tool_calls`, structured `logEvent` lines) | D1 and Workers logs | Reviewers; never arguments, bodies, addresses or secrets |
| A11 | Email: the operator's sending domain's reputation and the daily budgets | Email Sending / Resend through the Gateway | Apps that list the `email` capability |
| A12 | Availability | Cloudflare | Explicitly the lowest priority here: the design prefers failing closed to staying up |

## Actors

| Actor | Credential | What they may do | What they must not be able to do |
|---|---|---|---|
| **Visitor** | None. Reaches the Gateway's and the apps' hostnames over the internet; behind the outer ring, only the bypassed paths | Sign in with an invitation or a one-time link; use an app's declared public routes; start an OAuth flow that ends at a sign-in page; register an OAuth client (limited) | Reach any private route, the control plane, a tool, a provider, or learn which apps and people exist |
| **Member** | A Better Auth session cookie (`Domain=<APP_BASE_DOMAIN>`), personal access tokens, OAuth grants for AI apps; a member of one or more organizations | Open the apps granted to them in their organizations; call those apps' tools with their scopes; manage their own tokens and connections | Act in an organization they don't belong to; open an app not granted to them; escalate their role; read other members' tokens |
| **Admin** (organization role) | A member's session with the role | Invite and remove members, grant app access, deactivate members (self-hosted), edit app rows' access, revoke sessions | Change Worker secrets or settings (none are in the UI); deploy; act in another organization |
| **Owner** (organization role) | As admin | Everything an admin can, plus owner-only actions (transfer, delete the organization where offered) | As admin. An owner is not an operator |
| **Operator** | The Cloudflare account login or an API token with Workers and D1 edit | Everything: deploy and delete Workers, edit any D1 row, set secrets, mint an owner setup link, redeploy the Gateway (ADR-0003) | Nothing is withheld; the design counts on this person being trusted. Removing them is done in Cloudflare |
| **An app's code** (first-party, or the operator's own app) | A private Worker with the Gateway's `AppGateway` binding carrying its upload-time `{organizationId, appId, workerName}` props; its own bindings | Serve its routes to verified identities; call the AI proxy and the capabilities its manifest lists, attributed to its organization; read its organization's members who can open it; send mail under budgets | Mint identities; act for another organization; learn a provider key; read another app's bindings; reach a helper Worker that isn't its own; see a cookie or a bearer |
| **A helper Worker** | A Worker named `<app worker>--<name>`, bound only by the app's Worker, with the same props | What the app's Worker hands it | Be reached by the Gateway or a browser; verify identities (it has none to verify) |
| **An AI client over MCP** | An OAuth access token the Gateway issued (bound to `${GATEWAY_URL}/mcp`), a personal access token, or (behind Managed OAuth) a verified Access assertion | List and call the tools of the apps the person can open, within the connection's apps and the token's scopes; read-only callers see no write tools; nobody sees destructive tools | Use the token on an app route; call a tool with a scope it lacks; connect accounts or mint tokens at a social network; page through the directory |
| **A third-party app** (hosted only, behind the launch gate) | A Worker in the dispatch namespace, uploaded by a deploy key or an admin's install, reached on `<app>-<org>.<THIRD_PARTY_DOMAIN>` | Serve its organization's members with the per-host session; call the Gateway's proxies as any app | Reach the internet except through the `Outbound` allowlist (empty today); bind anything the deployer didn't rewrite; see the first-party session cookie; run without limits |
| **Cloudflare** | Runs everything | Trusted completely: the runtime, D1, KV, Access, the edge TLS, Email Sending | Out of scope (see below) |
| **A dependency** (npm packages, GitHub Actions) | Runs in the build, the CLI, the Worker, CI | Trusted as installed; floors on known-bad versions in `pnpm-workspace.yaml`, the lockfile audited in CI | Out of scope beyond that (see below) |

Two actors deserve a sentence each. The **operator** is root by design:
ADR-0003 chose one credential (the Cloudflare login) over a second Gateway
token that could only have confirmed what the login already had. Everything
below assumes the operator is honest and their Cloudflare credential is
safe; losing it is losing everything in the account, Gateway included. An
**app's code** is the actor the perimeter is mostly built around: Every App
exists so that people can run code they or an AI wrote without that code
being able to hurt anyone but its own organization. On a self-hosted
Gateway with one organization that means a buggy app can hurt only the data
it was given, and never the Gateway's accounts, the operator's provider
keys, or the Cloudflare account.

## What Cloudflare Access adds, and what it doesn't

Putting Cloudflare Access in front of the Gateway and the apps' hostnames
(the outer ring, `docs/runbooks/cloudflare-access.md`) is strongly
recommended at launch. It is a second, independent sign-in from a company
that does nothing else, in front of alpha software. Concretely, with the
outer ring configured (`CLOUDFLARE_ACCESS_TEAM_DOMAIN`,
`CLOUDFLARE_ACCESS_AUD`, `CLOUDFLARE_ACCESS_APPS_AUD`):

- **A visitor never reaches the Gateway's pages or an app's private
  routes.** Password brute force, the sign-up and reset pages, the setup
  page, the consent page, every server function and every app page are
  behind Access's login before the Gateway sees them. A bug in any of them
  needs an Access-admitted person to reach.
- **A stolen session cookie is not enough.** Behind the outer ring the
  Gateway honours a session only when the same request carries a verified
  Access assertion for the same person (`CLOUDFLARE_ACCESS_AUD` on the
  gateway's host; the apps' AUD vouches for sessions on app hosts). A
  cookie copied to another browser gets nothing without that browser also
  passing Access as that person.
- **Taking someone out of the Access policy ends their browser access**
  when their Access session ends (24 hours by default), whatever Gateway
  session they still hold.
- **With Managed OAuth**, AI apps pass Access too: nothing on the gateway's
  host is bypassed, and a person taken out of the policy loses MCP within
  the access token's lifetime (15 minutes by default).

What Access does **not** cover, by design, so the Gateway's own checks
remain the only thing between these and the data:

- **Personal access tokens and OAuth tokens** never pass through Access
  (the bypassed `/mcp*`, `/oauth/token` and `/oauth/register`). A stolen
  `epat_…` or access token works until it expires or is revoked; removing
  the person from Access changes nothing. Offboarding is **Deactivate** in
  Admin → Users, which revokes tokens and connections at once.
- **Apps' public routes** are bypassed per route, so whatever an app
  declares `public` is reachable by anyone on the internet, with their
  `Authorization` header forwarded for the app's own checks.
- **Deploy authority.** The CLI never calls the Gateway; it talks to
  Cloudflare's API with the operator's login. Access in front of the
  Gateway says nothing about who can deploy, change a row, or redeploy the
  Gateway. That is the Cloudflare account's membership.
- **The Access session itself.** Its cookie is Cloudflare's: keep
  `HttpOnly` and the binding cookie on (the runbook's defaults), and enable
  only identity providers that verify email addresses, since the Gateway
  treats Access's email as verified.
- **One application for everything** (one AUD for the gateway's host and
  the apps' hosts) makes every app host's Access cookie a gateway login
  too. The runbook asks for two applications; the single-AUD setup is
  accepted with that caveat.

With OIDC sign-in only (no outer ring), Access replaces passwords and adds
nothing in front of the pages: the Gateway's own perimeter is the whole
story, as without Access.

## Explicitly out of scope

Things this model does not try to stop. Some are decisions, some are
Cloudflare's job, some are simply not built.

- **A compromised Cloudflare account or credential.** Whoever holds it is
  the operator (ADR-0003). Every app's CI token with D1 write is too. There
  is no second factor inside Every App for deploys, and revocation is
  Cloudflare's.
- **Cloudflare itself**: the runtime, D1, KV, the edge, Access, Email
  Sending, their staff and their bugs. Workers isolation between accounts
  and the dispatch namespace's isolation are taken as given.
- **An honest operator's mistakes with secrets outside the CLI**: a
  `.dev.vars` committed to a public repository, a provider key pasted into
  chat, a `.everyapp/secrets.env` left world-readable. The CLI keeps secrets
  off argv and out of its output; the file system is the operator's.
- **Denial of service and cost.** Nothing meters an organization's provider
  spend; the daily mail and registration budgets exist to protect a
  gateway's standing, not to stop a determined flood. Cloudflare's own
  limits and the Workers Paid bill are the backstop.
- **Timing side channels**, except where a comparison guards a secret (token
  hashes are compared as hashes; the code doesn't try to be
  constant-time everywhere).
- **Supply chain beyond the floors.** `pnpm-workspace.yaml` pins known-bad
  transitive versions (`jose`, `seroval`, `tinypool`), CI fails on critical
  advisories in the lockfile, and the security-review action is
  pinned to a commit; nothing verifies package provenance or reviews each
  dependency's code.
- **The browser.** Extensions, a malware-ridden machine, a shared computer
  left signed in. `HttpOnly`, `Secure`, `SameSite` and the two-minute
  identity token limit what a page can do, not what the machine can.
- **Social engineering of the operator** (a fake invitation, a phished
  Cloudflare login) and physical access.
- **An app's own logic bugs within its organization**: an app that shows one
  member another member's todo is the app's bug. The Gateway gives it the
  identity; scoping the query is the app's job (the skill and AGENTS.md say
  so; the security review checks for it).
- **The local development gateway** (`everyapp dev`): it enforces the same
  perimeter shape with a public dev key, for one seeded user, on localhost.
  It is not a deployment.
- **Postiz** is not part of the launch; its port's findings are in TODO.md
  where they show a platform-level issue.

## Trust boundaries

Eight boundaries, each with what crosses it, the attacks it is there to
stop, the invariants to try first (the complete register, 317 invariants
with every code pointer and test, is
[docs/threat-model-invariants.md](threat-model-invariants.md)), what is
not that boundary's job, and the gaps found in this pass. B1 to B7 are
the self-hosted shape; B8 is the hosted tier.

| | Boundary | Crosses | Code |
|---|---|---|---|
| B1 | Browser → app host | cookies, personal tokens, visitors, webhooks | `packages/perimeter/src/gateway.ts` |
| B2 | Browser → the Gateway's host | sign-in, the setup claim, invitations, admin actions | `apps/every-app-gateway/src/auth/`, `src/server/control-plane-guard.ts`, `src/serverFunctions/` |
| B3 | Gateway → app Worker | the identity JWT, the public marker, tool calls | `packages/sdk/src/internal/identity.ts`, `packages/toolbus/` |
| B4 | App Worker → Gateway | the AI proxy, capabilities, email, members | `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts`, `ai-proxy.ts`, `capabilities/` |
| B5 | AI client → `/mcp` | OAuth tokens, personal tokens, consent, tool policy | `apps/every-app-gateway/src/server/mcp-auth/`, `src/server/toolbus/` |
| B6 | Cloudflare Access ↔ Gateway | assertions, the outer ring, OIDC, membership rules | `apps/every-app-gateway/src/auth/cloudflare-access/` |
| B7 | Operator → Cloudflare | the CLI's deploys and registry writes; the browser install | `packages/cli/src/lib/app/policy.ts`, `packages/perimeter/src/registry/`, `apps/every-app-gateway/src/server/deploy/install.ts` |
| B8 | The hosted tier | deploy keys, the dispatch namespace, egress, third-party hosts | `apps/every-app-gateway/src/server/deploy/`, `outbound.ts`, `host-session.ts` |

### B1. Browser → app host: the perimeter

**What crosses.** Every request to `<app>.<APP_BASE_DOMAIN>`: a member's
browser carrying the Better Auth cookie, a script with a personal access
token, a visitor, a webhook. On the other side, the app's private Worker.
The code is `handleGatewayRequest` in `packages/perimeter/src/gateway.ts`,
wired by `apps/every-app-gateway/src/server.ts`, with the authenticators in
`apps/every-app-gateway/src/perimeter/`.

**What it stops.** A visitor reaching anything the manifest didn't declare
public. A cross-site page riding a member's cookie into an identity (CSRF
on private routes; forced-anonymous on public ones). A client forging
`x-everyapp-identity`, `x-everyapp-org` or an Access header. An app seeing
a cookie or a bearer. A token minted for one Worker being replayed at
another. A sibling subdomain planting a session cookie. A personal token
meant for MCP being used on app pages. The control plane being served on an
app origin. A switched-off, half-deployed, deleted or hand-edited registry
row being routed.

**Invariants.** The full register has 34; these are the ones to try first.

| Id | Invariant | Enforced by | Pinned by |
|---|---|---|---|
| `perimeter.public-default-private` | A request is public only if the manifest declares a route, its method matches (GET by default), and the raw path canonicalizes unambiguously: no control characters, backslashes, encoded separators, invalid or double encoding, encoded traversal. Anything ambiguous is private. | `packages/perimeter/src/publicRoutes.ts:41-113` (`normalizePath`) | `packages/perimeter/src/publicRoutes.test.ts` :: defaults to deny with no routes; :: never treats /\_\_everyapp/\* as public, even via traversal |
| `perimeter.inbound-trust-headers-stripped` | Before any request is proxied, `Cookie`, `Authorization`, `Cloudflare-Workers-Version-Overrides` and every header starting `x-everyapp-` or `cf-access-` are removed, public and private routes alike. | `packages/perimeter/src/headers.ts:44-59` (`stripInboundHeaders`) | `packages/perimeter/src/headers.test.ts` :: removes Cookie, Authorization and all x-everyapp-\* headers; :: removes Cloudflare Access's assertion, email and service-token headers |
| `perimeter.authorization-forwarding` | Inbound `Authorization` reaches the app only on a public route and only when it is neither an Every App bearer (`epat_…` or a gateway OAuth token) nor a credential the gateway consumed. | `packages/perimeter/src/headers.ts:69-120` | `packages/perimeter/src/gateway.test.ts` :: never forwards a gateway OAuth token to the app, even on a public route |
| `perimeter.csrf-private-fail-closed` | A cookie-carrying request with a method other than GET/HEAD/OPTIONS to a private route is proxied only with `Sec-Fetch-Site: same-origin` or, when that header is absent, an `Origin` whose host is the app host. | `packages/perimeter/src/csrf.ts:25-65` (`evaluateCsrf`) | `packages/perimeter/src/csrf.test.ts` :: denies non-GET when Sec-Fetch-Site is cross-site or none |
| `perimeter.csrf-public-downgrade` | On a declared public route a failed CSRF or WebSocket-Origin check never calls the authenticator: the request is served anonymously with the public marker. | `packages/perimeter/src/gateway.ts:383` | `packages/perimeter/src/gateway.test.ts` :: (f3) CSRF: downgrades a failed public request to anonymous |
| `perimeter.identity-jwt` | A proxied private (or member public) request carries exactly one fresh RS256 identity JWT: `iss` = `GATEWAY_URL`, `aud` = the registry row's Worker name, `kid` = `everyapp-identity`, 120 seconds. | `packages/perimeter/src/gateway.ts:196-198` (`audienceOf`) | `packages/perimeter/src/gateway.test.ts` :: (a) a logged-in request reaches the app with a verified identity JWT; `packages/perimeter/src/integration/e2e.test.ts` :: (f) a token for one Worker is refused by another Worker of the same app id |
| `perimeter.public-marker-signed` | Anonymous and non-member public requests carry `x-everyapp-public`, a gateway-signed JWT (`typ: public`, same key, `aud` = Worker name), reused per audience for at most 60 seconds; a bare value fails SDK verification. | `packages/perimeter/src/gateway.ts:135-140` | `packages/perimeter/src/gateway.test.ts` :: (d) a declared public route works unauthenticated, no identity minted |
| `perimeter.app-access-policy` | An organization's own app opens only for a live, non-banned member of the app's organization with a `user_app_access` row; a session under another of the person's organizations is re-resolved as that membership; a token acts only in its own organization and, when bound, its own app. | `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts:55-76` (`resolveLiveOrgRole`) | `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.test.ts` :: opens no app with a deploy key, an owner's included |
| `perimeter.bearer-never-cookie` | A request carrying any `Authorization` bearer is never authenticated by a cookie: an `epat_` token verifies or yields null, any other bearer yields null, without reading the session cookie. | `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts:104-155` | `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.test.ts` :: returns null for epat credentials without falling back (partial: the third-party authenticator has no unit test) |
| `perimeter.duplicate-session-cookie-refused` | A request whose `Cookie` header(s) name the session cookie more than once, in any order or variant, is refused `401 duplicate_session_cookie` before authentication, public routes included. | `packages/perimeter/src/cookies.ts:29-50` | `packages/perimeter/src/cookies.test.ts` :: refuses the same name twice, in either order; `packages/perimeter/src/integration/e2e.test.ts` :: cookie tossing |
| `perimeter.mcp-only-token-scope` | A credential whose scopes are all `mcp:*` is served at exactly `/mcp` and answers `403 token_scope` on every other app route, public ones included. | `packages/perimeter/src/session.ts:32-37` (`isMcpOnlyCredential`) | `packages/perimeter/src/gateway.test.ts` :: refuse every app route but /mcp with 403 token_scope |
| `perimeter.tools-contract-404` | `/__everyapp/tools` and anything under it answers 404 from outside under any spelling (case, dot segments, encoded separators, double encoding, backslashes), before authentication. | `packages/perimeter/src/gateway.ts:297-299` | `packages/perimeter/src/publicRoutes.test.ts` :: finds the tools contract under any spelling; `packages/perimeter/src/integration/e2e.test.ts` :: (d) |
| `perimeter.serverfn-guard` | A request whose path (decoded as TanStack Start decodes it) is under the server-function base answers `403 server_fn_denied` unless it is a non-navigation, same-origin call carrying TanStack's client header. | `packages/perimeter/src/gateway.ts:312-320`; `packages/perimeter/src/serverFunctions.ts` | `packages/perimeter/src/serverFunctions.test.ts` :: matches the server-function prefix the way TanStack Start routes it |
| `perimeter.websocket-origin` | A WebSocket upgrade that carries a cookie and no bearer must present an `Origin` whose host is the app host; bearer-only upgrades are exempt. | `packages/perimeter/src/csrf.ts:68-99` | `packages/perimeter/src/csrf.test.ts` :: allows only the app's own origin |
| `perimeter.host-class-decides-row` | The host class (control plane, first-party, third-party, not found) is decided from the `Host` header before any registry lookup, and a row is served only on its class: service-binding rows on first-party hosts, dispatch rows on third-party hosts; anything else is `503 app_unavailable`. | `packages/perimeter/src/hostRoutes.ts:44-77` | `packages/perimeter/src/hostRoutes.test.ts` :: serves service-binding apps, shared or an organization's, on first-party hosts only; `apps/every-app-gateway/src/server/third-party-hosts.sqlite.test.ts` :: serves customer code on third-party hosts only, and first-party Workers nowhere else |
| `perimeter.unknown-host-404` | An unregistered host below the gateway host or `APP_BASE_DOMAIN` answers 404, never the control plane; a deployed gateway answers 404 on any host but its own. | `apps/every-app-gateway/src/server.ts:299-301, 343-369` | `apps/every-app-gateway/src/server.test.ts` :: serves registered app hosts below APP_BASE_DOMAIN and 404s the rest there; :: answers any host but its own with 404 in a deployed gateway |
| `perimeter.gateway-url-fail-closed` | Without `GATEWAY_URL` the control plane is served on an app-shaped host only while the registry holds no active app; once one exists every such request is `404 gateway_misconfigured`. | `apps/every-app-gateway/src/server.ts:305-328` | `apps/every-app-gateway/src/server.test.ts` :: fails closed without GATEWAY_URL when an active app is registered |
| `perimeter.status-gating` | Only an `active` row is proxied: `disabled` is 503, `pending`/`binding` 503 with `Retry-After`, an unknown status is treated as disabled, a tombstone is 404, an unknown tier or scope is 503 and never coerced. | `packages/perimeter/src/gateway.ts:282-294`; `packages/perimeter/src/registry/apps.ts:109-117` | `packages/perimeter/src/gateway.test.ts` :: 503s for a disabled app |
| `perimeter.one-seam` | An app is reached only through `getAppFetcher`: a service-binding app via its `APP__<worker_name>` binding (never a raw-name binding), a dispatch app via `DISPATCHER` only after re-checking the Worker name is `every-<orgKey>-<appId>`. | `packages/perimeter/src/getAppFetcher.ts:106-108, 219-238` | `packages/perimeter/src/getAppFetcher.test.ts` :: does not fall back to raw worker-name bindings |
| `perimeter.response-hygiene` | Every response but a true 101 carries HSTS, `nosniff`, frame denial, `Referrer-Policy: no-referrer` and, on HTML, the CSP floor; `Domain` is removed from app `Set-Cookie` headers. | `packages/perimeter/src/headers.ts:141-190` | `packages/perimeter/src/headers.test.ts` :: stamps HSTS, nosniff, frame denial on HTML responses |
| `perimeter.cache-bounded-revocation` | Per isolate, a hostname's registry row is cached 30 s (5 s on a miss), a browser session's membership and an organization's status 30 s; a personal token's membership and ban state, `user_app_access` and the session row are read live. | `apps/every-app-gateway/src/server.ts:83-133`; `apps/every-app-gateway/src/server/organization/orgContext.ts:17` | `apps/every-app-gateway/src/server.test.ts` :: caches hostname hits for 30 seconds |
| `perimeter.logs-redacted` | Proxy log lines carry app id, method, status, latency and mode, never the path; every `logEvent` field named cookie/authorization/set-cookie or matching token/secret/password/code is redacted at any depth. | `packages/perimeter/src/log.ts:13-57` | `packages/perimeter/src/gateway.test.ts` :: logs proxy metadata without the request path |

**Public routes.** A route listed under `public` in `everyapp.config.ts`
is open to the internet: the Gateway forwards the visitor's
`Authorization` header untouched, mints a signed public marker instead of
an identity, and whatever authentication the route needs is the app's own
(a webhook signature, a bearer the app verifies). A signed-in member with
access still gets an identity there. The route grammar (methods, patterns,
what can't be public) is on the agent docs' manifest page,
<https://everyapp.com/docs/agent/manifest>; the invariants are
`perimeter.public-default-private`, `perimeter.authorization-forwarding`
and `perimeter.public-auth-optional`.

**Not this boundary's job.** What the app does with a verified identity
(scoping its queries), what a public route does with the `Authorization`
it is handed, egress from a service-binding app (it can fetch anywhere),
and anything on the gateway's own host (B2).

**Gaps.**

- *First-party WebSocket handshakes pass through untouched* (medium, small
  fix). A 101 on a first-party host keeps its `Set-Cookie` `Domain=` and
  `Access-Control-Allow-Credentials`, and gets no security headers, because
  a 101 can't be rewrapped (`packages/perimeter/src/gateway.ts:550-552`;
  the third-party path rebuilds the handshake and strips them). An app that
  sets a parent-domain cookie on its handshake can plant a second session
  cookie for the whole gateway, which the duplicate-cookie rule then turns
  into a lockout of every member.
  `perimeter.first-party-101-cookie-domain` is **not enforced**. TODO:
  "Strip session-named `Set-Cookie` headers from app responses" (Build).
- *An app can set a cookie named like the session cookie on its own host*
  (low, known; same TODO line). The browser then sends two copies and the
  member is locked out of that app until they clear cookies.
- *The duplicate-cookie refusal is a lockout primitive* (low, known). Any
  script on the base domain can write a parent-domain cookie with the
  session cookie's name; from then on every host answers 401 until cookies
  are cleared. The refusal is right; the 401 could expire the gateway's own
  variants to help the browser recover (TODO, Build).
- *Proxy-forwarding headers pass through* (low, small fix).
  `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `X-Forwarded-Host/Proto` reach
  the app as the client sent them; Cloudflare's `cf-connecting-ip` is the
  authoritative address. A ported app that trusts `X-Forwarded-For` for
  rate limiting or audit logs can be fed values.
- *The third-party authenticator has no unit tests* (low, hosted only).
  Its three decisions (a non-`epat_` bearer authenticates nobody, the host
  cookie must name this host and app row, another organization's row is
  refused) are pinned only through the sqlite suite's happy paths.
- *Revocation latency is 30 seconds per isolate* for a disabled app, a
  changed manifest, a removed browser-session member and a suspended
  organization. Documented, not a finding; stated here so nobody expects
  less.

**Merged this week** (the secrets model: #383 the manifest needs,
`apps.secret_names` and the evaluator
`apps/every-app-gateway/src/server/app-setup.ts`; #396 the gate, merged
f43859cc): a
perimeter hook `needsSetup({ app, request, publicRoute })` runs after the
status checks and before authentication; an app whose required settings
are unset answers `503 app_needs_setup` naming only the app id (or, for a
private HTML navigation, a 302 to the gateway's home with `?setup=<app>`),
public routes included. The invariant, pinned
(`perimeter.needs-setup-names-no-setting` in the register): no setting
name or value leaves the perimeter in those responses
(`apps/every-app-gateway/src/server/app-needs-setup.ts`;
`app-needs-setup.test.ts :: answers a public route with a 503 that names
no setting`, and the perimeter's `gateway.test.ts :: the setup gate`). The
`apps.secret_names` column (#383) holds the names of an app's own secrets, never
values, written by the CLI and shown to members who can see the app; the
gateway's `/mcp` leaves a not-ready app's tools out and names the missing
setting in its instructions. One thing to know, not a gap: because the
hook runs before authentication, a visitor learns that an app exists and
is unconfigured where they used to get the sign-in redirect; app ids are
hostnames, so nothing new is disclosed, and Access in front hides it.

**Merged this week** (the teams slice, `docs/design/2026-10-teams.md`;
#384 and #385): effective app access is `user_app_access` ∪
(`group_members` ⋈ `group_app_access`), one union in
`apps/every-app-gateway/src/server/repositories/effective-access.ts`
read at every site (this authenticator, the launcher, the members
capability, the MCP catalogs, the consent page). The invariant, pinned
(`appaccess.groups-same-rule-everywhere` in the register): a group never
holds another organization's user or app, nor a shared app, and removing
a member deletes their group rows in the same batch
(`groups.sqlite.test.ts :: keeps organizations apart: neither their apps,
their people nor their groups cross`).

### B2. Browser → the Gateway's own host: the control plane

**What crosses.** Sign-in, sign-up, password reset and email verification;
the one-time setup claim; invitations; every admin action (members, roles,
app access, app rows, tokens); the organization switcher; the OAuth
consent pages and `/mcp` (B5). On the other side, the Gateway's D1 with
every account and every organization. The code is Better Auth as
configured in `apps/every-app-gateway/src/auth/config.ts`, the request
guard in `src/server/control-plane-guard.ts`, the server functions under
`src/serverFunctions/` with their middleware in `src/middleware/auth.ts`,
and `platformPolicy()` in `src/server/platform-policy.ts`.

**What it stops.** Anyone signing up without an invitation (or before the
owner exists). A cross-site page making a signed-in browser change state. A
member reading invitations, creating organizations, or reaching Better
Auth's admin endpoints over HTTP. A guessed invitation id or setup link
claiming anything. An admin acting outside their organization, on an
owner, or on an account that belongs to another organization too. A
sign-in page redirecting off-site. Error bodies leaking internals. A
misconfigured deployment mode turning anything on.

**Invariants.** The register has 45; the ones to try first:

| Id | Invariant | Enforced by | Pinned by |
|---|---|---|---|
| `policy.fail-closed-on-invalid-mode` | `GATEWAY_DEPLOYMENT_MODE` other than `self_hosted` or `hosted` (unset included) yields a frozen policy with every capability off: no sign-up, no personal organizations, no Access sign-in, no setup claim, no shared apps, no third-party deploys, no account actions, no mail, no registration. | `apps/every-app-gateway/src/server/deployment-mode.ts:9-16`; `platform-policy.ts:158-213` | `apps/every-app-gateway/src/server/platform-policy.test.ts` :: fails closed on a missing or mistyped mode: nothing hosted, nothing self-hosted |
| `signup.invite-or-open-after-claim` | Over HTTP, sign-up without a live invitation token is refused unless the policy has open sign-up (hosted) and an owner already exists. | `apps/every-app-gateway/src/auth/config.ts:109-155` (`enforceSignUpPolicy`) | `apps/every-app-gateway/src/auth/auth.sqlite.test.ts` :: refuses sign-up without an invitation, before and after the claim |
| `invite.token-is-the-credential` | Signing up through an invitation and accepting one both require an `einv_` link token whose SHA-256 maps to a pending, unexpired invitation; the invitation id never works. | `apps/every-app-gateway/src/server/invitation-token.ts:38-54` | `apps/every-app-gateway/src/server/invites-without-email.sqlite.test.ts` :: never accepts the invitation id in place of the link |
| `invite.email-binding` | An invite link only signs up or joins an account whose email equals the invited email (case-insensitive). | `apps/every-app-gateway/src/auth/config.ts:78-94` | `apps/every-app-gateway/src/server/invites-without-email.sqlite.test.ts` :: lets the invitee join through the copied link, and nobody else |
| `invite.secrets-hidden-from-members` | Better Auth's accept-invitation, list-invitations and get-full-organization endpoints answer 404 over HTTP; the gateway's own organization view returns no members or invitations to a member. | `apps/every-app-gateway/src/auth/config.ts:242-257, 455` (`DISABLED_AUTH_PATHS`) | `apps/every-app-gateway/src/server/invites-without-email.sqlite.test.ts` :: gives a plain member no way to read an invitation |
| `ba.admin-plugin-closed` | Every endpoint of Better Auth's admin plugin (ban, impersonate, set password, set role, list and remove users) answers 404 over HTTP in every mode. | `apps/every-app-gateway/src/auth/config.ts:264-278, 455` | `apps/every-app-gateway/src/auth/config.test.ts` :: closes every one of the admin plugin's endpoints over HTTP |
| `ba.org-creation-closed` | No HTTP client can create an organization: the endpoint is disabled, `allowUserToCreateOrganization` is false, and the before-hook refuses creation while no owner exists. | `apps/every-app-gateway/src/auth/config.ts:242, 469, 538-545` | `apps/every-app-gateway/src/auth/auth.sqlite.test.ts` :: closes organization creation over HTTP, before and after the claim |
| `csrf.cookie-state-change-same-origin` | On the gateway host, any non-GET/HEAD/OPTIONS request carrying a cookie needs `Sec-Fetch-Site: same-origin` or an `Origin` on the gateway host, else `403 csrf_denied`; the only exemptions are the token-authenticated `/mcp`, `/oauth/token` and `/oauth/register`, none of which reads the cookie. | `apps/every-app-gateway/src/server/control-plane-guard.ts:26-50, 63-92` | `apps/every-app-gateway/src/server.test.ts` :: rejects a cookie-carrying cross-site POST to any control-plane route |
| `csrf.serverfn-fetch-only` | `/_serverFn/*` is served only to same-origin fetches carrying TanStack's client header that are not navigations; every state-changing server function is a POST. | `apps/every-app-gateway/src/server/control-plane-guard.ts:69-74` | `apps/every-app-gateway/src/server.test.ts` :: rejects a server-function GET reached by navigation |
| `session.duplicate-cookie-refused` | A control-plane request carrying the session cookie name twice is answered `401 duplicate_session_cookie`, `no-store`, before the guard, the rate limits or any handler run. | `apps/every-app-gateway/src/server.ts:184-197, 210-213` | `apps/every-app-gateway/src/server.test.ts` :: refuses a session cookie tossed in by a sibling subdomain, before anything else |
| `setup.one-time-link` | A claim succeeds only with an `est_` token whose SHA-256 equals, in constant time, the hash of an unconsumed, unexpired claim row, consumed by a guarded `UPDATE` as the last step. | `apps/every-app-gateway/src/server/services/SetupService.ts:79-88, 111-115` | `apps/every-app-gateway/src/server/services/SetupService.test.ts` :: rejects a wrong token with 403 and creates nothing |
| `setup.minted-only-by-deployer` | Setup links are minted only by the CLI writing `owner_setup_tokens` in D1 with the operator's Cloudflare credentials (32 random bytes, 24 hours, replacing an unused earlier link); no gateway HTTP route creates one. | `packages/cli/src/lib/gateway/setup-link.ts:13, 66-100` | `apps/every-app-gateway/src/auth/auth.sqlite.test.ts` :: claims the gateway with a link minted by the CLI's own SQL (partial: no test asserts the absence of an HTTP minting route) |
| `setup.refused-once-owner-exists` | A claim is refused `409 ALREADY_CLAIMED` as soon as any owner membership exists, valid link or not, and `403 SETUP_UNAVAILABLE` when the mode is invalid. | `apps/every-app-gateway/src/server/services/SetupService.ts:106-132` | `apps/every-app-gateway/src/server/services/SetupService.test.ts` :: refuses a valid link once the gateway has an owner |
| `setup.one-claim-at-a-time-rollback` | Only one claim runs at a time (a singleton insert); a concurrent claim gets `503 CLAIM_IN_PROGRESS`; a failed claim deletes the user and organization it made. | `apps/every-app-gateway/src/server/organization/owner-membership.ts:8-62` | `apps/every-app-gateway/src/server/services/SetupService.test.ts` :: lets only one of two concurrent claims through |
| `roles.admin-and-owner-gates` | Admin server functions run only for a session whose verified membership in its active, non-suspended organization is owner or admin; deleting a user or an app needs owner; a banned user fails every middleware. | `apps/every-app-gateway/src/middleware/auth.ts:21-80` | `apps/every-app-gateway/src/middleware/auth.test.ts` :: rejects members from admin middleware |
| `roles.owner-immutable-no-self-admin-needs-owner` | No one can change the role of, deactivate, reset or delete an owner or themselves; an admin manages members, only an owner manages another admin; assignable roles are member and admin. | `apps/every-app-gateway/src/server/services/MembershipService.ts:23-57` | `apps/every-app-gateway/src/server/user-management.sqlite.test.ts` :: lets an admin promote a member, and only an owner change an admin |
| `roles.account-actions-single-org-only` | Deactivating, reactivating or minting a reset link for a user is refused when they belong to any other organization, because a ban and a password are account-wide. | `apps/every-app-gateway/src/server/services/MembershipService.ts:84-103` | `apps/every-app-gateway/src/server/user-management.sqlite.test.ts` :: refuses to deactivate someone who also belongs to another organization |
| `ban.deactivation-revokes-all-credentials` | Deactivating a user bans the account, deletes every session and revokes every personal token in one D1 batch, then revokes their MCP connections; the ban is read on every request. | `apps/every-app-gateway/src/server/repositories/UserRepository.ts:62-85` | `apps/every-app-gateway/src/server/user-management.sqlite.test.ts` :: ends sessions and rejects the user's PAT |
| `ban.removal-revokes-org-grants` | Removing a member deletes the membership and their `user_app_access` rows, revokes their tokens and MCP grants for that organization, and deletes the account only when they belong to no other organization. | `apps/every-app-gateway/src/server/repositories/OrganizationMembersRepository.ts:171-204` | `apps/every-app-gateway/src/server/user-management.sqlite.test.ts` :: revokes the deleted user's personal access tokens |
| `org.context-is-verified-membership` | The organization a session acts under is always a members row for that user; an `activeOrganizationId` they aren't a member of resolves to null; without one, only a sole membership is a fallback. | `apps/every-app-gateway/src/server/organization/orgContext.ts:51-120` | `apps/every-app-gateway/src/server/organization/orgContext.test.ts` :: rejects an active organization the user is not a member of |
| `org.suspended-opens-nothing` | A non-active organization fails the member middleware with `ORGANIZATION_SUSPENDED` and is not attributable for background work. | `apps/every-app-gateway/src/middleware/auth.ts:67-72` | `apps/every-app-gateway/src/middleware/auth.test.ts` :: refuses a suspended organization's members |
| `ratelimit.credential-endpoints` | Sign-in, sign-up, reset and the setup claim are counted per client address (IPv6 by /64), per account and per gateway with Workers Rate Limiting bindings. | `apps/every-app-gateway/src/server/auth-rate-limit.ts:30-43, 98-104, 161-201` | `apps/every-app-gateway/src/server/auth-rate-limit.test.ts` :: throttles brute-force sign-in from one IP once its limit is spent |
| `mail.daily-budgets-and-escaping` | Every verification, reset and invitation mail is counted before sending against per-kind daily budgets per recipient (an HMAC of the address) and per gateway; every interpolated value is HTML-escaped and kept to one line. | `apps/every-app-gateway/src/server/email/sendEmail.ts:102-193`; `email/templates.ts:18-32` | `apps/every-app-gateway/src/server/email/sendEmail.test.ts` :: sends a few mails of a kind a day to one address, then refuses |
| `redirect.sign-in-return-paths-safe` | The sign-in, sign-up, verify-email and reset pages follow `redirect` only as a same-origin path (`/` but not `//` or `/\`, no `://`) and `return_to` only as an http(s) URL on a subdomain of the current host that isn't a server-function URL. | `apps/every-app-gateway/src/utils/auth.ts:5-13, 43-72` | `apps/every-app-gateway/src/utils/auth.test.ts` :: rejects absolute URLs and missing values |
| `session.cookie-scope-flags-and-ip` | In production the session cookie is `__Secure-`-prefixed and `Secure`, `Domain`-scoped to `APP_BASE_DOMAIN` (never a parent zone), and Better Auth's base URL is pinned to `GATEWAY_URL`, never derived from the request. | `apps/every-app-gateway/src/auth/config.ts:305-322, 340, 367, 373-397` | `apps/every-app-gateway/src/auth/config.test.ts` :: enables rate limiting, secure cookies and app-subdomain cookies in production |
| `headers.control-plane` | Every control-plane response carries HSTS (no `includeSubDomains`), `nosniff`, frame denial, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` on admin, OAuth, setup and reset pages. | `apps/every-app-gateway/src/server/control-plane-guard.ts:38, 94-121` | `apps/every-app-gateway/src/server.test.ts` :: stamps control-plane security headers and keeps the session cookie domain |
| `errors.no-internal-leak` | Server functions surface only `GatewayError`/`PublicError` codes and `INVALID_INPUT`; any other throw is logged as name, message and stack and answered as an opaque error. | `apps/every-app-gateway/src/middleware/publicError.ts:11-42` | `apps/every-app-gateway/src/middleware/publicError.test.ts` :: hides an unexpected error and logs only its name, message and stack |
| `session.db-read-every-request-no-cookie-cache` | Better Auth's cookie cache is off, so every session check reads the sessions table and a deleted session is dead on the next request everywhere. | `apps/every-app-gateway/src/auth/shared.ts:8-12` | **unpinned** |

**Not this boundary's job.** Who may deploy (B7), what Access adds in
front of these pages (B6), the MCP and OAuth endpoints (B5), the strength
of a person's password beyond the 8-character minimum, and the browser
the session lives in.

**Gaps.**

- *No owner recovery and no ownership transfer* (medium, known). The owner
  the setup claim made is immutable: nobody can change, deactivate, delete
  or reset an owner, and the `recovery` kind in `owner_setup_tokens` is
  unused. A compromised owner account can't be removed by anyone but the
  operator editing D1. TODO: "Setup link expiring mid-wait" is adjacent;
  this needs its own entry.
- *A stolen admin session can take over any single-organization member*
  (medium, medium fix). An admin can mint a one-hour reset link for any
  member who belongs to no other organization and set their password,
  invite admins and promote members to admin, with no fresh-session or
  re-authentication requirement. Behind Access, the admin's browser must
  also pass Access as that person, which is the mitigation at launch.
- *Session lifetime is Better Auth's default and nothing pins it* (low).
  7 days, extended by a day on use, no absolute cap; `cookieCache: false`,
  which every revocation invariant depends on, has no test.
- *Credential rate limiting is silently absent when the Rate Limiting
  bindings are missing* (low, known). A gateway uploaded without the
  `AUTH_RATE_LIMIT_*` bindings has only Better Auth's per-isolate counters
  and nothing logs the absence.
- *Role changes and suspension take up to 30 seconds to reach other
  isolates* (low). Deactivation is immediate.
- *Before `GATEWAY_URL` is set, the control plane and setup claim are
  served on any host* (low). The link is still the credential; the sign-in
  UI and cookie can appear on a `workers.dev` host during that window.
- *Hosted open sign-up has no bot control beyond mail budgets* (medium,
  known, hosted only; the preview stays invite-only for this reason).
- *One invariant has no test*: nothing posts `role: "owner"` to
  `inviteMember` or `updateMemberRole`.

**Docs to fix.** `docs/security-model.md` says a fresh gateway "accepts no
sign-ups" until claimed: a sign-up carrying a live invitation token is
accepted whether or not an owner exists (no invitation can exist before the
claim in practice). The inline comment in `auth/config.ts` about Better
Auth's default per-IP rules describes per-isolate counters; the effective
limits are the Workers Rate Limiting bindings.

### B3. Gateway → app Worker: the identity contract

**What crosses.** One request per proxied call over the app's service
binding, carrying either `x-everyapp-identity` (a fresh RS256 JWT for this
Worker) or `x-everyapp-public` (a signed marker); the tool-call and
catalog requests on `/__everyapp/tools/*`; and, from `everyapp dev` only,
tokens signed by the public dev key. On the other side, the app's code
behind `everyApp()` in `packages/sdk`. The verifier is
`packages/sdk/src/internal/identity.ts`; the claims are
`packages/sdk/src/internal/protocol.ts`; the tool endpoints are
`packages/sdk/src/server/toolsEndpoint.ts`; the ToolBus that mints
per-call identities is `packages/toolbus/`.

**What it stops.** A request that didn't come through the Gateway being
served (no token, a forged one, `alg: none`, HS256 with the public key, an
unknown key, an expired token). A token minted for another Worker, or for
another organization's copy of the same app, being accepted. A public
marker standing in for an identity, or an identity for a system token. The
dev key being accepted by a deployed Worker. A tool running without a
call-bound MCP identity with the exact scope its risk needs. A destructive
tool ever running. An app minting identities, or attributing its gateway
calls to a user or organization it chose.

**Invariants.** The register has 39; 38 are pinned.

| Id | Invariant | Enforced by | Pinned by |
|---|---|---|---|
| `identity.alg-pinned` | A token whose header `alg` isn't RS256 (`none`, HS256, anything) is rejected before any signature work, and `jwtVerify` is restricted to RS256. | `packages/sdk/src/internal/identity.ts:209-213` | `packages/sdk/src/internal/identity.test.ts` :: rejects alg:none; :: rejects HS256 signed with the public key |
| `identity.kid-pinned` | Only `kid: everyapp-identity` is accepted; `everyapp-identity-dev` only under the dev opt-in; no other `kid` ever. | `identity.ts:214-219` | `identity.test.ts` :: rejects a mismatched kid |
| `identity.signature-env-keyset` | A signature is verified only against the SPKI keys in `EVERYAPP_IDENTITY_PUBLIC_KEYS` (current and next), never a runtime fetch; a missing or malformed key set is a 500, never a pass. | `identity.ts:76-106` | `identity.test.ts` :: rejects a token signed by an unknown key |
| `identity.audience-is-worker-name` | A deployed app accepts only tokens whose `aud` equals `EVERYAPP_AUDIENCE`, its Worker name; the app id stands in only under the dev opt-in; unset outside dev is 500. | `packages/sdk/src/server/everyApp.ts:154-162` | `packages/sdk/src/server/everyApp.test.ts` :: takes the audience from EVERYAPP_AUDIENCE, never the app id, outside dev; `packages/perimeter/src/integration/e2e.test.ts` :: (f) |
| `identity.issuer-required-for-user-and-system` | User identities and system tokens verify only with a configured issuer, and `iss` must equal it. | `identity.ts:220-224` | `identity.test.ts` :: rejects a user token with a clear error when issuer is not configured |
| `identity.expiry-required` / `identity.ttl-bounds` | Every token must carry `exp` and be unexpired; identities and markers live 120 s; system tokens at most 60 s. | `identity.ts:229`; `protocol.ts:44-46` | `identity.test.ts` :: rejects an expired token; `protocol.test.ts` :: sets a ~120s expiry |
| `identity.typ-separation` | A token is accepted only for the use its `typ` names: a user identity never passes as a marker or system token, a marker never as an identity. | `identity.ts:239-243` | `identity.test.ts` :: rejects an identity token smuggled into the public header |
| `identity.required-claims` | A user identity must carry `sub`, `email`, `org_id`, `org_role`; a `tc` claim, if present, must name a tool and call id. | `protocol.ts:186-192` | `identity.test.ts` :: rejects a token missing required claims |
| `identity.dev-optin-strict` / `identity.dev-issuer-firewall` | The dev kid is accepted only when `EVERYAPP_DEV` is exactly `1` or `true`, which only development builds set; and only when the expected issuer is `https://gateway.dev.localhost`, so a dev-signed token naming a real gateway never verifies. | `identity.ts:140-146, 312-316`; `packages/sdk/src/cloudflare/worker.ts:565, 703` | `identity.test.ts` :: refuses the dev opt-in with any issuer but the dev one; `worker.test.ts` :: never enables dev identities |
| `identity.public-marker-signed` | A request resolves to public (`user: null`) only after `x-everyapp-public` verifies as a gateway-signed JWT with `typ: public`, `pub: true`, `sub: public` and `aud` = this Worker. | `identity.ts:261-274` | `identity.test.ts` :: returns {user:null, isPublic:true} for a SIGNED public marker |
| `identity.no-token-fails-closed` | A request with neither a verified marker nor a verified identity is answered 401 by `everyApp()` before the handler runs. | `identity.ts:350-357` | `identity.test.ts` :: throws when no identity header is present (not proxied); `e2e.test.ts` :: (b) |
| `identity.misconfig-is-500-never-allow` | A missing key set, missing audience, dev opt-in with a wrong issuer, or an app id that contradicts the manifest answers 500, never 401, never a pass-through. | `everyApp.ts:125-136` | `everyApp.test.ts` :: returns 500 when EVERYAPP_APP_ID contradicts the manifest |
| `identity.build-tenant-neutral-and-installed` | A production build refuses to run outside `everyapp deploy` and carries only sentinel placeholders for the Worker name, organization, gateway URL and key; the installer rewrites them and the policy checks the result. | `packages/sdk/src/cloudflare/worker.ts:750-760` | `worker.test.ts` :: refuses to build unless `everyapp deploy` runs the build |
| `tools.list-needs-system-token` | `/__everyapp/tools/list` answers only a system token with purpose `tools.list`, `aud` = this Worker and the issuer; identities, markers and other apps' tokens are 401. | `toolsEndpoint.ts:176-191` | `toolsEndpoint.test.ts` :: returns the catalog to the gateway's system token |
| `tools.call-needs-call-bound-mcp-identity` | `/__everyapp/tools/call` runs only with a verified identity whose `chan` is `mcp` and whose `tc` claim names exactly the tool and call id in the body. | `toolsEndpoint.ts:234-268` | `toolsEndpoint.test.ts` :: only accepts an identity minted for this exact call |
| `tools.scope-per-risk-no-wildcard` | A tool runs only when the identity's scopes contain the exact scope its declared risk requires; `*` never counts, and `mcp:destructive` is never minted. | `toolsEndpoint.ts:276-283` | `toolsEndpoint.test.ts` :: requires the scope the tool's risk needs, never accepting \* |
| `tools.sdk-validates-arguments` | The SDK validates every call's arguments with the tool's own schema before the handler runs, whatever the gateway checked. | `toolsEndpoint.ts:285-299` | `toolsEndpoint.test.ts` :: validates arguments with the tool's schema |
| `tools.x-mcp-header-hint-dropped` | The `x-mcp-header` schema keyword is removed from every tool schema, so no app can ask clients to mirror an argument into an HTTP header. | `packages/sdk/src/server/tools.ts:474-482` | `packages/toolbus/src/catalog.test.ts` :: strips x-mcp-header hints |
| `toolbus.one-identity-per-call` | Every `tools/call` mints a fresh identity for that call alone (`chan: mcp`, `act.sub` naming the credential, explicit `mcp:*` scopes, `tc`, `aud` = the app row's Worker name). | `packages/toolbus/src/execute.ts:80-91` | `execute.test.ts` :: calls the app once with an identity minted for exactly this call |
| `toolbus.app-answer-bounded` | An app gets 30 s per call, its answer is read to at most 1 MiB, and only MCP result fields are relayed. | `execute.ts:50-52, 234-271` | `execute.test.ts` :: stops waiting for a slow app |
| `toolbus.dev-host-dev-kid-localhost` | The dev ToolBus mints with the dev kid for the app id and serves only localhost-class hosts and origins. | `packages/toolbus/src/dev/index.ts:59-129` | `dev/index.test.ts` :: serves the app's live catalog to the dev user with dev-kid identities |
| `appgateway.caller-props-match-registry` | A call on the AppGateway binding is served only when its upload-time props name a registered active app and equal that row's organization, app id and Worker name. | `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts:112-160` | `app-gateway-entrypoint.test.ts` :: accepts valid props that match an active registry row |
| `sdk.attribution-for-rules` | The SDK's gateway calls carry either the inbound request's identity or a background organization, delete any identity, org, `Authorization` or `Cookie` header the app set, and a shared Worker refuses a call that names neither. | `packages/sdk/src/server/attribution.ts:37-63` | `attribution.test.ts` :: forwards the request's identity and never an organization the app set |
| `sdk.no-direct-provider-outside-dev` | Without the gateway binding, the SDK reaches a provider directly only under `EVERYAPP_DEV` with the developer's own key; a production-shaped env with a key but no binding throws. | `packages/sdk/src/server/gatewayFetch.ts:58-74` | `gatewayFetch.test.ts` :: rejects a production-shaped env even when a provider key is present |

**Not this boundary's job.** Whether the app calls `everyApp()` at all
(nothing at deploy time proves it; the template does, and `pnpm dev`
runs behind the same perimeter so an app that doesn't breaks visibly), and
what the app does with a verified user.

**Gaps.**

- *The AppGateway binding's props are self-asserted by the app build and
  not pinned by the deploy policy* (high, known, medium fix). The
  entrypoint trusts the binding's `{organizationId, appId, workerName}` and
  checks only that a matching registry row exists. The CLI's policy checks
  the binding by name and target only (`packages/cli/src/lib/app/policy.ts`),
  so a hand-written `cloudflare.config.ts` (the deploy warns
  `NONSTANDARD_CLOUDFLARE_CONFIG` and proceeds) can set another
  organization's ids and have its calls attributed there. On a self-hosted
  gateway with one organization the operator deploys everything anyway, so
  this is the operator misattributing to themself; on hosted it is the
  "props pinned on every upload" launch-gate item (built for dispatch
  uploads, a follow-up for CLI deploys: TODO "Redesign stack 2, identity").
- *No volume limit on provider calls through the binding* (medium, known;
  the same gap as B4's).
- *A shared app's Worker may attribute background work to any active
  organization* (medium, known, hosted only): the design trusts first-party
  code; TODO records it.
- *Public markers verify without an issuer check when
  `EVERYAPP_IDENTITY_ISSUER` is unset* (low, small fix). Identities and
  system tokens require the issuer; markers don't, so a Worker deployed
  without the issuer variable would accept a marker from any gateway
  holding a key in its set. The deploy always sets the issuer; a one-line
  change makes the verifier demand it.
- *The production 404 of `/api/dev/identity` is pinned only by
  `import.meta.env.DEV`* (low). Both tests run under vitest where DEV is
  truthy.
- *A missing `scopes` or `chan` claim decodes to full access* (low).
  Only the gateway signs and always writes both; a defensive decode would
  default to nothing.
- *The AppGateway verifies forwarded identities with the single
  `JWT_PUBLIC_KEY`* while apps accept current and next (info): a token
  signed just before a key rotation is refused at the gateway.
- *The identity TTL extends suspension and removal lag* beyond the 30 s
  caches by up to 120 s (low, known): nothing re-checks membership on a
  verified identity.
- *Browser-session and Access-authenticated MCP callers are always write
  principals* (info, known): only tokens and OAuth connections can be
  read-only; roles never narrow tool access.

**Docs to fix.** ADR-0002 and RFC-0001 (both deleted 2026-10-24) said the SDK verifies that the
token's organization matches the deployed Worker's organization; it
doesn't compare `org_id` with `EVERY_APP_ORG_ID`. The guarantee comes from
the audience: each organization's copy has its own Worker name, and the
gateway mints `aud` from the registry row.

### B4. App Worker → the Gateway: the AppGateway binding, AI and capabilities

**What crosses.** Calls an app's Worker makes back to the Gateway over its
`EVERY_APP_GATEWAY` service binding: the AI proxy (`/api/ai/<provider>/…`),
the capability proxy (`/api/integrations/<id>/…`: DataForSEO, Context.dev,
the social networks' and Google's and Microsoft's OAuth clients, email,
members), and the tool-catalog fetch. The binding carries the app's
upload-time props (`organizationId`, `appId`, `workerName`) and the app
forwards the identity of the request it is serving, or names an
organization for background work. On the other side, the operator's
provider keys and client secrets, and the organization's attribution. The
code is `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts`,
`ai-proxy.ts`, `integration-proxy.ts`, `capabilities/` and `email/`, with
the SDK's `createGatewayFetch` and `integrationFetch` on the app side.

**What it stops.** An app learning a provider key, a client secret, or
whether a key exists for a capability it didn't request. An app reaching a
provider endpoint that lists the operator's whole account, another
organization's data, or a non-inference endpoint. An app in one
organization getting its calls attributed to another. An agent's identity
sending mail, listing members or minting OAuth tokens it shouldn't. An
app sending as a domain the operator didn't allow, or reading the
directory of people who can't open it. Provider cookies and credentials
leaking either way.

**Invariants.** The register has 40.

| Id | Invariant | Enforced by | Pinned by |
|---|---|---|---|
| `attr.caller-identity` | Only a registered, active app whose binding props exactly match its registry row reaches any proxy; malformed props are `401 missing_caller_identity`, unknown apps `403 caller_not_registered`. | `apps/every-app-gateway/src/server.ts:228-241`; `app-gateway-entrypoint.ts` | `app-gateway-entrypoint.test.ts` :: accepts valid props that match an active registry row, and refuses the rest |
| `attr.org-app-own-organization` | An organization's own app's call is attributed to its props organization; a forwarded identity names the user only if it verifies for the Worker (`aud` = Worker name) and the same organization; an `x-everyapp-org` naming another organization is `403 caller_org_mismatch`. | `app-gateway-entrypoint.ts:363-373` | `app-gateway-entrypoint.test.ts` :: refuses an x-everyapp-org naming another organization |
| `attr.shared-app-organization` | A shared app's call is attributed to the verified identity's organization (an invalid identity is 401, never a fallback to the platform organization); without one it must name an active organization with a live member in `x-everyapp-org`. | `app-gateway-entrypoint.ts:374-434` | `app-gateway-entrypoint.test.ts` :: attributes the call to the organization of the forwarded identity |
| `attr.sdk-never-app-chosen` | The SDK puts on a gateway call only the inbound request's identity or background work's organization, deleting any `x-everyapp-identity`/`x-everyapp-org` the app set itself; a shared Worker throws `AttributionError` for a call that names neither. | `packages/sdk/src/server/attribution.ts:37-82` | `packages/sdk/src/server/attribution.test.ts` :: forwards the request's identity and never an organization the app set |
| `ai.key-never-reaches-app` | The upstream AI request carries only the gateway's key and none of the app's credentials, account selectors (`x-api-key`, `openai-organization`, `openai-project`), `x-everyapp-*`, cookies or forwarding headers. | `ai-proxy.ts:13-42` | `ai-proxy.test.ts` :: forwards request to OpenAI with gateway-managed key and strips internal headers |
| `ai.inference-only-by-default` | Without both `AI_PROXY_EXTRA_ROUTES` and the manifest's `ai.routes` covering the path, only POST to the provider's exact inference routes is forwarded; files, batches, fine-tunes, assistants and GETs are refused. | `ai-proxy.ts:78-88` | `ai-proxy.test.ts` :: rejects non-inference endpoints (files, batches, stored responses) |
| `ai.extra-routes-openai-only` | Extra routes widen OpenAI only; OpenRouter and Workers AI serve inference and nothing else, so OpenRouter's credits and keys endpoints and Cloudflare's wider API stay closed. | `ai-proxy.ts:97-104` | `ai-proxy.test.ts` :: allows inference only, whatever the operator allows for OpenAI |
| `ai.store-false` | On OpenAI's responses and chat completions the body's `store` is rewritten to false, so no app's completions are retained account-wide. | `ai-proxy.ts:89` | `ai-proxy.test.ts` :: forces store:false on responses and chat completions |
| `ai.model-allowlist` | When the manifest sets `ai.models`, a request naming a model outside the list, or none, is `403 model_not_allowed` before any upstream call. | `ai-proxy.ts:234-246` | `ai-proxy.test.ts` :: enforces the manifest's model allowlist |
| `ai.path-confinement` | The app's path is joined onto the provider's base URL and can never replace or leave it: `//` and backslashes are 400, dot segments are resolved by the parser before matching. | `ai-proxy.ts:396-421` (`buildUpstreamUrl`) | `ai-proxy.test.ts` :: rejects proxy paths that attempt to override upstream host (partial: encoded slashes and dot segments are unpinned) |
| `ai.provider-grant` | An AI call reaches the proxy only for a provider the app's registry-row manifest lists; otherwise `403 provider_not_allowed`, before any key-existence check. | `app-gateway-entrypoint.ts:202-209` | `app-gateway-entrypoint.test.ts` :: denies a provider that is not allowlisted |
| `ai.logs-redacted` | AI logs carry provider, organization, app, route, model, status, request id and token usage, never the prompt, the output or the key. | `ai-proxy.ts:281-295` | `ai-proxy.test.ts` :: logs model, token usage and request id, never the prompt |
| `cap.grant-required` | A capability call is forwarded only when the app's registry-row manifest lists it with the needed access; otherwise `403 capability_not_requested`. | `integration-proxy.ts:164-170` | `integration-proxy.test.ts` :: refuses a capability the app's registry row doesn't list |
| `cap.host-allowlist-https` | The upstream of an API-key call is `https://<host><path>` only for a host in the capability's list, matched before any URL is built; `//`, backslashes and a parse that moves the host are refused. | `packages/sdk/src/internal/capabilities.ts:887-934` | `integration-proxy.test.ts` :: refuses %s before anything leaves the gateway |
| `cap.account-wide-paths-refused` | DataForSEO paths that list the whole account (`tasks_ready`, `tasks_fixed`, `id_list`, `errors`, `appendix/user_data`, `appendix/webhook_resend`) are refused however spelled. | `capabilities.ts:153-159` | `integration-proxy.test.ts` :: refuses DataForSEO's account-wide %s, which would show one app another's tasks |
| `cap.credentials-stripped-no-redirect` | The upstream request carries the gateway's key and none of the app's `Authorization`, `x-api-key`, cookies, `x-everyapp-*` or forwarding headers, and follows no redirect. | `capabilities/forward.ts:4-29` | `integration-proxy.test.ts` :: forwards a call with the gateway's key and nothing the app sent |
| `cap.key-existence-hidden` | Only an app that lists a capability learns whether the gateway holds its key, client or sender. | `integration-proxy.ts:100-127, 164-196` | `integration-proxy.test.ts` :: reports whether calls would go through, without calling the provider |
| `oauth.token-endpoints-only` | An OAuth-client call is completed only for one of the capability's token endpoints: exact https host, exact path, listed method; the network's API hosts and other paths are refused. | `capabilities.ts:906-919` | `capabilities/oauthClient.test.ts` :: refuses %s |
| `oauth.credentials-replaced` | Every client credential the app sent (the `Authorization` header; `client_id`/`client_secret` and the rule's own names, any case, in the query or the body) is removed and the gateway's put where the endpoint takes it; bodies are 64 KiB, form or JSON. | `packages/sdk/src/internal/oauthClient.ts:16, 73-166` | `oauthClient.test.ts` :: form: LinkedIn gets the gateway's client in the body, and nothing the app sent |
| `oauth.agents-refused` | A token call under an agent's identity is `403 integration_agent_not_allowed`, with or without `mcp:write`. | `capabilities/oauthClient.ts:126-133` | `oauthClient.test.ts` :: refuses an agent: agents can't connect accounts or mint tokens |
| `oauth.no-redirect-secret-never-to-app` | The token request follows no redirect; the network's `set-cookie` is dropped; the client secret appears in no response or log; the public client id reaches only an app that lists the network. | `capabilities/oauthClient.ts:160-167` | `oauthClient.test.ts` |
| `email.sender-rule` | Mail goes out as `EMAIL_FROM` unless `from` matches one of the installation's senders on the app's registry row (`*@domain` is that domain exactly); a hosted gateway refuses any app sender. | `capabilities/email.ts:95-101, 216-237` | `capabilities/email.test.ts` :: sends as an app sender the installation allows, by a domain pattern or an address |
| `email.header-refusals-and-message-rules` | Headers that would set From, Sender, To, Cc, Bcc, Reply-To, Subject, Return-Path, Date, MIME-Version, Content-Type, Content-Transfer-Encoding or DKIM-Signature are refused, and so are values with line breaks. | `packages/sdk/src/internal/email.ts:294-396` | `capabilities/email.test.ts` :: refuses a message with %s |
| `email.agent-needs-write-scope` | A send under an agent's identity goes through only with `mcp:write` or `*`. | `capabilities/email.ts:160-169` | `capabilities/email.test.ts` :: refuses an agent's read-only connection, and sends for one with write |
| `email.daily-budgets` | App mail is counted before sending, once per distinct recipient, against daily budgets per address and per gateway (100 and 5,000 self-hosted; 20 and 5,000 hosted; none in an invalid mode). | `email/sendEmail.ts:131-215` | `capabilities/email.test.ts` :: spends one per recipient, per address and for the gateway |
| `members.scoped-to-attributed-organization` | The members list returns only the attributed organization's live members in an active organization who are granted that app; an agent's identity is refused outright. | `capabilities/members.ts:76-90` | `members-capability.sqlite.test.ts` :: lists the organization's live members the app is granted to, and nobody else |

**Not this boundary's job.** What the provider does with a valid call, an
app's own secrets (its `secrets` in the manifest live on its Worker), and
what an app does with the network API tokens it holds (the scope sets bound
which tokens it gets, not the calls it makes with them).

**Gaps.**

- *No default limit on provider spend* (high, known;
  `cap.per-organization-limits` is **enforced only for an app an owner or
  admin capped**, #416). Every AI call, every DataForSEO paid call and
  every Context.dev render is attributed, logged and, since #381, counted
  per organization and app; since #416 an owner or admin may cap an app's
  calls per month (`org_app_settings.monthly_call_cap`, Admin → Usage,
  null by default), refused at the cap with `429 app_monthly_cap_exceeded`
  before any provider call. With no cap set nothing bounds the spend: on a
  self-hosted gateway with one organization this is "an app can spend
  your OpenAI key unless you cap it"; on hosted it is why the preview
  stays invite-only (`docs/design/2026-10-teams.md`).
- *A granted OAuth client is all-or-nothing per app* (medium; the
  OAuth-scopes slice: `docs/design/2026-10-oauth-scopes.md` for the
  design, #398 merged for the registry's `scopePolicy` on
  `google-workspace` and `microsoft-365`, #414 merged for the manifest
  field, #411 merged for the gateway, both 2026-10-24). Before them the
  gateway completed a network's token endpoints without reading scopes:
  the app chose the consent's scopes and kept the tokens, so nothing
  stopped an app granted `google-workspace` for Search Console from
  reading Gmail. With #411 on main the invariants in the table below
  hold. Their honest limits,
  which stay in this model: the network's API calls still don't pass
  through the gateway (the app holds the tokens, so the per-set host and
  path allowlist in `packages/sdk/src/internal/oauthScopes.ts` enforces
  nothing until an outbound Worker or gateway-held tokens use it; the
  boundary is which tokens an app can obtain); Google and Slack narrow per
  app only when the app asks for the status's scopes without
  `include_granted_scopes` (a wider token is refused, not narrowed);
  Microsoft, and Slack installations, may return every scope the person
  consented to any app on the shared client, which the gateway refuses
  (availability lost, not narrowing: the fix is one registered client per
  app); refresh tokens are app-held bearer credentials not bound to an
  app; and the boundary exists only because the client is confidential
  (the registry requires a client secret for a scope policy).

  | Id | Invariant (#411, merged 2026-10-24; lines at its commit 40159f82) | Enforced by | Pinned by |
  |---|---|---|---|
  | `oauth.scopes-declared-or-no-token` | An app that lists `google-workspace` or `microsoft-365` without a valid `scopes` list (missing, empty, duplicated, or a name the registry doesn't define) gets no token at all: `403 integration_scopes_undeclared` before attribution and before any upstream call. | `apps/every-app-gateway/src/server/capabilities/oauthClient.ts:185` | `oauthClient.test.ts` :: refuses an app that lists the client without scope sets (the "scope sets: Google and Microsoft" cases); `oauth-client.sqlite.test.ts` |
  | `oauth.granted-scopes-within-sets` | The gateway never forwards a token whose granted scopes exceed the app's declared sets, on exchange and on refresh, for a person's call and for background calls: the provider's 2xx answer is buffered (64 KiB), its `scope` parsed per provider, and an excess answers `403 integration_scope_exceeded` with the body dropped, never stored, logged or revoked. | `oauthClient.ts:384-437` | `oauthClient.test.ts` :: refuses a token outside the app's sets, dropping it; :: refuses the union include_granted_scopes yields; :: refuses a refresh echoing a scope set the manifest dropped, in the background too; the Microsoft case |
  | `oauth.unverifiable-answer-refused` | A token-bearing answer that names no scopes is `502 integration_scope_unverified`, not forwarded; a non-JSON or oversized 2xx is `502 integration_response_invalid`; a read that breaks off is `502 integration_upstream_failed` with nothing forwarded. | `oauthClient.ts:384, 408, 429` | `oauthClient.test.ts` :: the unverified and broken-read cases |
  | `oauth.request-decided-on-body` | The token request is decided on its body alone: `grant_type`, `scope` or `user_scope` in the query string, or `grant_type` twice in the body, is `400 integration_body_invalid`; the grant must be one the client's policy completes (`authorization_code`, `refresh_token`) on top of #387's user-grant floor (`403 integration_grant_not_allowed`); a request asking for a scope outside the sets is `403 integration_scope_not_allowed`; Microsoft's request `scope` is replaced by the app's allowed list, Google's dropped. | `oauthClient.ts:227-239, 252, 309, 324, 331` | `oauthClient.test.ts` :: the query-string cases; :: the scope-outside-the-sets case |
  | `oauth.scope-logs-names-only` | Logs carry the declared set names and, on a refusal, the scope names in excess (capped), never a token, code, id_token, body or client value, across log, warn and error lines. | `oauthClient.ts` (the logged object) | `oauthClient.test.ts` :: logs no client, code or token across a Google exchange, a Microsoft exchange and a refused answer |

- *The token endpoint signed any grant type* (high before #387; fixed
  there, merged 2026-10-24). Facebook's client-credentials grant returns the
  app access token `<app id>|<app secret>`: the operator's secret itself;
  Discord's, Twitch's and Kick's mint application-level tokens. The proxy
  now completes only a user's grants (`authorization_code`,
  `refresh_token`, the networks' exchanges, RFC 8693) and refuses the rest
  with `integration_grant_not_allowed`.
- *App-mail budgets are per address and gateway-wide only* (medium, known).
  One organization's app can exhaust the gateway's 5,000 a day; on hosted,
  mail from any app goes out as the platform's sender.
- *The AI proxy follows redirects; the other proxies don't* (low, small
  fix). A 3xx from a provider to another origin would be followed with the
  gateway's key in the request.
- *The AI proxy passes provider response headers through, `set-cookie`
  included* (low, small fix). Harmless for a Worker consumer unless the app
  relays the provider's response to a browser.
- *`AI_PROXY_EXTRA_ROUTES` opens every method and sub-path of a route to
  every opted-in app across organizations* (low, hosted; allowing
  `/v1/files` lets any opted-in app list and delete every app's files under
  the shared account).
- *Email budget check is read-then-increment* (low): concurrent sends can
  overrun a budget by the concurrency factor.
- *AI request bodies are fully buffered with no size cap* (low): email caps
  at 5 MiB and OAuth at 64 KiB.
- *Mastodon's client defaults to `mastodon.social`* (low, known) when
  `MASTODON_URL` is unset.
- *`Reply-To` on app mail is unrestricted* while `From` is allowlisted
  (low).

**Merged this week** (the teams slice; #381 the counters, #416 the cap):
usage counters (`usage_daily`, `usage_monthly`; counts only, never bodies
or keys) written from the AppGateway entrypoint under `waitUntil`, and an
opt-in per-app monthly cap in `org_app_settings` (null by default) refused
with `429 app_monthly_cap_exceeded` and a `Retry-After` to the UTC month
end, after attribution and before any provider call, a refused call not
counted, the cap the attributed organization's own (a shared app's is per
organization), the settings cached 30 s per isolate (5 s when none) like
the caller cache, a deleted app's caps gone with it. The first answer to
the first gap above; pinned by `app-cap.sqlite.test.ts` (see
`cap.per-organization-limits` in the register).

**Docs to fix.** `docs/capabilities.md` lists the checks in a different
order than the code runs them (route, then capability, then account-wide
path).

### B5. AI client → `/mcp`: the OAuth server, personal tokens and the ToolBus

**What crosses.** An AI client (Claude, ChatGPT, Claude Code, Cursor, a
script) holding an OAuth access token the Gateway issued, a personal access
token (`epat_…`), or, behind Managed OAuth, a verified Access assertion;
the consent pages a person sees in the browser; the dynamic registration
endpoint anyone can call. On the other side, every app's tools, called
over the app's binding with a per-call identity, and the provider apps'
tools (`docs/design/2026-10-mcp-provider-apps.md`), which the gateway
serves itself and which call the provider through B4's capability proxy.
The code is
`apps/every-app-gateway/src/server/mcp-auth/` (the OAuth 2.1 server on
`@cloudflare/workers-oauth-provider`, consent, registration, validation),
`src/server/toolbus/` and `packages/toolbus/` (the ToolBus: policy,
execution, audit), and `src/server/services/UserPatService.ts`.

**What it stops.** A token for the gateway's `/mcp` being used on an app
host, or forwarded to an app. A client without PKCE, with a redirect on
the platform's own domains, or with an error redirected to its own site. A
consent decision taken by a cross-site form, by a different browser, or
twice. A read-only connection calling a write tool; anyone calling a
destructive tool; a token with API scopes calling tools at all. A revoked
connection, removed member or deactivated user keeping access past the
next request. A page on another origin driving tool calls with a browser's
cookie. A tool receiving a reusable identity, `*` scopes, or arguments the
app's schema refuses. Arguments or results ending up in the audit table.

**Invariants.** The register has 45.

| Id | Invariant | Enforced by | Pinned by |
|---|---|---|---|
| `mcp.one-protected-resource` | Access tokens are issued for and accepted at exactly `${GATEWAY_URL}/mcp`; another resource, a trailing slash, an app host or several resources are `invalid_target`. | `apps/every-app-gateway/src/server/mcp-auth/config.ts:129-132` | `gateway-mcp.e2e.sqlite.test.ts` :: advertises one resource, CIMD and public clients |
| `mcp.app-host-refuses-oauth-tokens` | An app host accepts no gateway-issued OAuth token on any route, never forwards one to the app (public routes included), and its RFC 9728 metadata paths answer 404. | `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts:149-155` | `gateway-mcp.e2e.sqlite.test.ts` :: never lets its token into an app host, nor names an authorization server there |
| `oauth.pkce-s256-required` | Every authorization request, confidential clients included, must carry a PKCE S256 challenge; `plain` is refused. | `apps/every-app-gateway/src/server/mcp-auth/authorize.ts:110-116` | `gateway-mcp.e2e.sqlite.test.ts` :: requires PKCE of every client, confidential ones too |
| `oauth.platform-domain-refused` | A client id or redirect URI on the gateway's host, `APP_BASE_DOMAIN` or any host under either is refused at authorize, in the consent context and at the token endpoint, before anything is fetched. | `apps/every-app-gateway/src/server/mcp-auth/own-domain.ts:30-51, 90-104` | `gateway-mcp.e2e.sqlite.test.ts` :: refuses redirect URIs on the gateway's own domains |
| `oauth.errors-never-redirected` | An invalid authorization request is answered with the gateway's own 400 page, never redirected to the client's redirect URI. | `authorize.ts:95-119` | `gateway-mcp.e2e.sqlite.test.ts` :: shows a bad request's error here, never redirects it |
| `consent.single-use-browser-bound` | A consent transaction lives 10 minutes, is bound to the browser by a `__Host-` cookie, and is spent once; a second approval or a replay from another browser is refused. | `config.ts:145`; `authorize.ts` | `gateway-mcp.e2e.sqlite.test.ts` :: binds the consent to the browser, forbids framing, and spends it once |
| `consent.same-origin-signed-in-post` | The decision is accepted only from a same-origin form (`Sec-Fetch-Site: same-origin`, or `Origin` equal to the issuer) from a signed-in, non-banned user. | `authorize.ts:159-163, 169-183` | `gateway-mcp.e2e.sqlite.test.ts` :: refuses a decision from another site, another browser or a signed-out user |
| `consent.choices-validated-before-spend` | An approval grants only an active organization the user is a member of, and in `selected` mode only apps they can use there; a refused choice spends nothing. | `authorize.ts:216-249` | `gateway-mcp.e2e.sqlite.test.ts` :: only grants organizations the user belongs to and apps they can open |
| `oauth.scopes-are-the-users-choice` | A grant's scopes are `mcp:read`, plus `mcp:write` only when the user chose read & write; whatever else the client asked for grants nothing. | `consent.ts:283-292` | `gateway-mcp.e2e.sqlite.test.ts` :: shows its verified domain and grants read-only when asked |
| `oauth.per-request-recheck` | Every `/mcp` request with an OAuth token re-reads the connection row, the user's live role, their ban state and app access; revoking, removing or deactivating takes effect on the next request. | `validate.ts:160-225` | `gateway-mcp.e2e.sqlite.test.ts` :: stops a revoked connection at once, and its refresh |
| `oauth.refresh-rechecks-connection` | A refresh for a connection that no longer stands fails `invalid_grant` and deletes the grant; D1 unavailable is 503 and keeps the grant. | `config.ts:151-172` | same |
| `oauth.revocation-paths` | A user revokes only their own connections; removing a member revokes that organization's connections and grants; deactivating revokes all of theirs. | `apps/every-app-gateway/src/server/services/McpConnectionService.ts:143-172` | `gateway-mcp.e2e.sqlite.test.ts` :: refuses another user's connection |
| `dcr.bounded-and-budgeted` | A dynamic registration is read under 16 KiB, keeps only the client's name, up to ten redirect URIs, its grant/response types and auth method, lives 60 days unused, and is limited per address per minute (per isolate), per address per day and per gateway per day in D1. | `registration.ts:31-171`; `registration-limit.ts` | `gateway-mcp.e2e.sqlite.test.ts` :: stores only what Every App uses, for 60 days |
| `switches.kill-and-dcr` | With `MCP_OAUTH_ENABLED` off (any unrecognized value fails closed) every `/oauth/*` path and discovery document is 404 and `/mcp` takes personal tokens only; `MCP_DCR_ENABLED=false` closes registration. | `apps/every-app-gateway/src/server/oauth-flag.ts:25-54` | `gateway-mcp.e2e.sqlite.test.ts` :: takes personal tokens only and names no authorization server when OAuth is off |
| `mcp.browser-origin-rule` | A request to the gateway's `/mcp` carrying an `Origin` is served only when that origin is the gateway's own or listed exactly in `MCP_ALLOWED_ORIGINS` (empty by default); behind Managed OAuth the rule runs before the assertion is read. | `apps/every-app-gateway/src/server/toolbus/gateway-mcp.ts:51-77` | `gateway-mcp.e2e.sqlite.test.ts` :: serves only the gateway's origin and MCP_ALLOWED_ORIGINS |
| `pat.format-and-hashing` | A personal token is `epat_` plus 32 random bytes as hex; only an HMAC-SHA256 under `BETTER_AUTH_SECRET` is stored, with a 9-character display prefix. | `UserPatService.ts:18-35, 133` | `UserPatService.test.ts` :: creates and verifies a PAT roundtrip |
| `pat.scopes-decide-mcp-access` | On either `/mcp`, `*` or `mcp:write` is read & write, `mcp:read` read only, any other scope set (API scopes, `deploy`) is `403 token_scope`. | `validate.ts:95-151` | `gateway-mcp.e2e.sqlite.test.ts` :: reads only with mcp:read, sees only its app |
| `pat.bound-to-org-and-app` | A personal token acts only in its own organization, only on its bound app when it has one, and fails when its user is no longer a member, is banned, or the organization is suspended. | `betterAuthAuthenticator.ts:55-76` | `app-host-mcp.sqlite.test.ts` :: refuses a token bound to another app |
| `pat.deploy-key-opens-nothing` | A deploy key opens no app on any host and is refused on the gateway's `/mcp`. | `betterAuthAuthenticator.ts:120-122`; `validate.ts:95-100` | `betterAuthAuthenticator.test.ts` :: opens no app with a deploy key (partial: the gateway `/mcp` refusal has no test) |
| `apphost.mcp-session-or-pat-with-csrf` | An app host's `/mcp` serves a browser session only from the app's own origin (a cookie POST needs `Sec-Fetch-Site: same-origin` or an `Origin` on the app's host) or a personal token; it takes no OAuth token. | `packages/perimeter/src/gateway.ts:350-374, 421-429` | `app-host-mcp.sqlite.test.ts` :: runs a tool for the app's own page and audits it |
| `tools.policy-destructive-hidden-write-gated` | Destructive tools are absent from `tools/list` and refused for every caller; write tools, and tools with no declared risk, are hidden from and refused for read-only callers. | `packages/toolbus/src/policy.ts:25-39` | `packages/toolbus/src/policy.test.ts` :: hides destructive tools from everyone and write tools from read-only callers |
| `tools.per-call-identity` | Each tool call reaches exactly one app with a fresh identity minted for that call: `chan: "mcp"`, explicit `mcp:read`/`mcp:write` (never `*`, never `mcp:destructive`), `act.sub` naming the credential, a `tc` claim naming the tool and call id. | `packages/toolbus/src/execute.ts:69-91, 218-257` | `packages/toolbus/src/execute.test.ts` :: calls the app once with an identity minted for exactly this call |
| `tools.request-shape-limits` | JSON-RPC batches are refused; bodies over 256 KiB; arguments nested more than 64 levels; arguments with more than 1,000 values and recursive schemas are left to the app's own validation; an app gets 30 seconds to answer. | `packages/toolbus/src/http.ts:60-124`; `validation.ts` | `packages/toolbus/src/http.test.ts` :: refuses JSON-RPC batches, whatever their routing headers say |
| `audit.one-row-per-call-no-arguments` | Every tool call on either surface, refused ones included, writes one `mcp.tool_call` log line and one `mcp_tool_calls` row with the caller, credential, tool, decision, outcome, a keyed digest of the arguments and the client's unverified self-description (`client_info`, bounded), never the arguments or result. | `apps/every-app-gateway/src/server/toolbus/runtime.ts:43-105` | `gateway-mcp.e2e.sqlite.test.ts` :: registers as public, connects, calls tools, and audits each call |
| `catalog.system-token-opens-only-the-catalog` | A catalog sync is one invocation of the app carrying the gateway's one-minute system token, which the SDK accepts only on `/__everyapp/tools/list` and never as an identity for a tool call. | `apps/every-app-gateway/src/server/toolbus/catalog-sync.ts:148-160` (fetchAppCatalog with signing; in-process for tier `provider`) | `app-host-mcp.sqlite.test.ts` :: snapshots the app's tools with one invocation and the system token |
| `toolbus.provider-app-in-process` | A provider app (tier `provider`, no hostname, no Worker; `everyapp provider on`) is reached only in-process by the gateway's own SDK app for it, never routed or bound, with every identity minted for `aud` `provider:<row id>` and verified with the gateway's own public key. | `apps/every-app-gateway/src/server/provider-apps/index.ts`; `server/toolbus/catalog-sync.ts` (appFetcherFor); `perimeter/drizzleAppRegistry.ts` | `provider-apps.sqlite.test.ts` :: is never routed by the perimeter, even with a hostname on its row |
| `toolbus.provider-call-through-proxy-key-never-relayed` | A provider tool reaches the provider only through the capability proxy's rules (B4), after the organization's monthly cap on the row is checked, attributed to the member and counted against the provider row; its answer never carries the key or a refusal body. | `apps/every-app-gateway/src/server/provider-apps/call.ts` | `provider-apps.sqlite.test.ts` :: calls the provider through the capability proxy with the gateway's key, tagged with the organization, and counts and audits the call |

**Not this boundary's job.** What a tool does with valid arguments (the
app's code), the AI client's own storage of its tokens, and Access's
Managed OAuth grant lifetime (Access's).

**Gaps.**

- *Refresh token replay is never detected* (medium, known, medium fix;
  `oauth.refresh-rotation-no-reuse-detection` is **not enforced**). The
  library accepts the previous refresh token until the latest is used and
  has no reuse detection, so a stolen refresh token mints access tokens
  alongside the client until it has refreshed twice. Revoking the
  connection ends it at once. `@cloudflare/workers-oauth-provider` 1.2.3
  offers no stricter mode; a wrapper that records the last-used token id
  and revokes the grant on a replay is the fix.
- *Personal tokens default to `*` for 90 days and the UI offers no narrower
  scope* (medium, known, small fix). The create-token dialog offers only
  `access` (stored as `*`: read & write on every app route) or `deploy`, so
  the common case, a read-only or MCP-only token for an AI client, can't be
  made from the UI. TODO: "Access levels for personal access tokens".
- *Anonymous `GET /oauth/authorize` fetches a metadata document before
  sign-in with no per-address limit* (low, small). A client id that is a
  URL is fetched (under `global_fetch_strictly_public`) before the user is
  checked; an SSRF to public URLs only, but unmetered.
- *A deploy key's refusal on the gateway's `/mcp` has no test* (low, known).
- *Dynamic registration accepts redirect URIs on the platform's domains*
  (low, known): refused where used, kept for 60 days where registered.
- *PAT lifetime caps live only in the server-function schema* (low). Another
  caller of `UserPatService` could mint a token that lasts decades.
- *The tokens-only `/mcp` preflight reflects any `Origin`* (info): the POST
  is still refused by the origin rule.
- *Audit rows store an Access caller's email* (info): the only credential
  kind whose id is personal data, kept for the retention period.
- *The tokens page is under `/admin` while the server functions admit every
  member* (info): any member can mint a token for themselves by calling the
  server function, which is the intended rule; the UI hides it.

**Docs to fix.** `docs/security-model.md`: "redirect URIs must be https or
loopback http" holds for the URI an authorization uses; a registration may
list other schemes, which are never usable.

### B6. Cloudflare Access ↔ the Gateway

**What crosses.** With the outer ring: every request to the gateway's and
the apps' hostnames, which Access has already authenticated, carrying
`Cf-Access-Jwt-Assertion` (and the `CF_Authorization` cookie); the
exceptions are the bypassed paths. With OIDC sign-in: an OpenID Connect
code flow between Access and Better Auth. On the other side, Better Auth's
sessions and the membership tables. The code is
`apps/every-app-gateway/src/auth/cloudflare-access/` (the plugin, the JWT
verifier, membership rules) and, for Managed OAuth on
`/mcp`, `src/server/mcp-auth/access-caller.ts`.

**What it stops.** A forged or foreign assertion signing anyone in. A
session being used behind the outer ring by a browser Access didn't
authenticate as that person. The apps' Access application vouching for a
gateway login. A stranger Access admits getting an account when they were
never invited (unless the operator opted into auto-join). An Access
identity being handed an existing password account by email coincidence.
A deactivated member getting back in because Access still admits them. A
site planting a sign-in in someone's browser. The `/mcp` path taking the
Access cookie, which a cross-site POST could ride.

**Invariants.** The register has 36.

| Id | Invariant | Enforced by | Pinned by |
|---|---|---|---|
| `access.jwt.rs256-only` | An Access token verifies only with `alg: RS256`, a non-empty `kid` and a signature by that key from the team's JWKS; `none`, HS256 keyed with the public key and every other algorithm are refused. | `apps/every-app-gateway/src/auth/cloudflare-access/jwt.ts:26` | `apps/every-app-gateway/src/auth/cloudflare-access/jwt.test.ts` :: refuses an unsigned token (alg: none) |
| `access.jwt.issuer-audience-expiry` | A token verifies only with the configured issuer, an `aud` naming an accepted application, a present `exp`, and times within 60 seconds of tolerance. | `apps/every-app-gateway/src/auth/cloudflare-access/jwt.ts:38` | `jwt.test.ts` :: refuses a token for another Access application (aud) |
| `access.jwt.email-required-and-verified` | A token yields an identity only with a well-formed `email` and never with `email_verified: false`; service tokens (no email) sign nobody in. | `apps/every-app-gateway/src/auth/cloudflare-access/jwt.ts:252-256` | `jwt.test.ts` :: refuses a service token, which has no email |
| `access.jwks.fail-closed` | When the JWKS can't be fetched, verification returns null: expired cached keys are dropped rather than reused, nobody waits on a fetch longer than 5 seconds, an unknown `kid` triggers a refetch at most every 30 seconds. | `apps/every-app-gateway/src/auth/cloudflare-access/jwt.ts:28-36` | `jwt.test.ts` :: fails closed when the key set can't be fetched |
| `access.config.two-auds` | Only an assertion whose `aud` includes `CLOUDFLARE_ACCESS_AUD` may sign anyone in; a `CLOUDFLARE_ACCESS_APPS_AUD` assertion only vouches for an existing session; a malformed apps AUD turns the outer ring off. | `apps/every-app-gateway/src/auth/cloudflare-access/config.ts:234-247` | `config.test.ts` :: lets only the gateway application's AUD sign people in |
| `access.outer-ring.sign-in-only-on-gateway-host-get` | The outer ring creates or swaps a session only during the gateway's own session check on `GATEWAY_URL`'s host; on any other host or method a session is only vouched for, never made. | `apps/every-app-gateway/src/auth/cloudflare-access/plugin.ts:69-82` | `access-sign-in.sqlite.test.ts` :: only acts on the gateway's own host |
| `access.outer-ring.session-counts-only-when-vouched` | With the outer ring configured, every session read (the perimeter on app hosts, server functions, the OAuth pages, the host-session handoff) returns null unless the request carries a verified assertion for the session's person. | `apps/every-app-gateway/src/auth/cloudflare-access/plugin.ts:253-288` | `access-sign-in.sqlite.test.ts` :: counts a session only with Access's word for the same person; `outer-ring-perimeter.sqlite.test.ts` |
| `access.outer-ring.sessions-made-only-for-vouched-person` | Behind the outer ring, a user or session created by any other flow (password, invite sign-up, OIDC) is refused unless the request's verified assertion names the same email. | `apps/every-app-gateway/src/auth/cloudflare-access/plugin.ts:147-169` | `access-sign-in.sqlite.test.ts` :: won't sign an account in whose email isn't the one Access asserts |
| `access.outer-ring.someone-elses-session-replaced` | On the gateway's session check, a live session for a different email than the assertion's is deleted and the Access person's own session is made, or the cookie is cleared. | `apps/every-app-gateway/src/auth/cloudflare-access/plugin.ts:290-325` | `access-sign-in.sqlite.test.ts` :: swaps a session that belongs to someone else for the Access person's |
| `access.assertion.never-a-session-on-app-hosts` | On an app host the assertion alone never authenticates: without a Better Auth session the perimeter redirects to the gateway's sign-in. | `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts:157-171` | `outer-ring-perimeter.sqlite.test.ts` :: never treats the assertion itself as a session |
| `access.perimeter.strips-cf-access-headers-and-cookie` | Before proxying, the perimeter removes the cookie header and every `cf-access-*` header; apps see only the gateway's identity. | `packages/perimeter/src/headers.ts:27` | `packages/perimeter/src/headers.test.ts` :: removes Cloudflare Access's assertion, email and service-token headers |
| `access.membership.nothing-before-claim` | Until some organization has an owner, no Access sign-in creates a user or session, whatever the auto-join settings say. | `apps/every-app-gateway/src/auth/cloudflare-access/membership.ts:85-93` | `access-sign-in.sqlite.test.ts` :: creates no account on a gateway nobody has claimed |
| `access.membership.members-invitees-autojoin-only` | An Access identity gets a session only as an existing member, a person with a live pending invitation for that exact email (claimed atomically, with the invited role), an email whose exact domain is in `CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS`, or anyone when the outer ring's auto-join is `everyone`; everyone else is refused and nothing is created. | `membership.ts:95-123` | `access-sign-in.sqlite.test.ts` :: makes an invited person a member, with the invited role |
| `access.membership.deactivated-refused` | A deactivated user is refused at every Access entry (outer ring, OIDC, `/mcp`), whatever Access says. | `membership.ts:214` | `access-sign-in.sqlite.test.ts` :: keeps a deactivated member out |
| `access.linking.verified-local-email-or-signed-in` | An Access identity is linked to an existing account with the same email only when that account's own email is verified, or while the browser is signed in to it as the same email. | `apps/every-app-gateway/src/auth/config.ts:355-364` | `access-sign-in.sqlite.test.ts` :: asks an account whose email isn't verified to sign in with its password once |
| `access.oidc.state-pkce-client-secret` | OIDC sign-in uses Better Auth's browser-bound state and PKCE S256 and redeems the code with the client secret; a callback in a browser that didn't start the sign-in fails `state_mismatch`. | `oidc-provider.ts:50-63` | `access-sign-in.sqlite.test.ts` :: sends the browser to Access with state and PKCE, and refuses a callback it didn't start |
| `access.oidc.id-token-verified-no-posted-tokens` | The ID token is verified in full (signature by the application's JWKS, issuer, audience = client id, expiry, email) before its email is used; posted ID tokens are not a sign-in. | `oidc-provider.ts:76-77` | `access-sign-in.sqlite.test.ts` :: refuses an ID token for another client |
| `access.passwords-off.lockout-protection` | `EMAIL_PASSWORD_SIGN_IN=false` closes the password paths only while an Access sign-in method is validly configured and at least one owner holds an Access identity. | `config.ts:288-308` | `config.test.ts` :: turns password sign-in off only with Access sign-in configured and an owner connected |
| `access.hosted.ignored` | When the mode isn't `self_hosted`, every `CLOUDFLARE_ACCESS_*` setting is ignored with one logged problem and the plugin isn't registered. | `index.ts:19-42` | `access-sign-in.sqlite.test.ts` :: offers passwords alone, and open sign-up, on the hosted gateway |
| `access.mcp.header-only-origin-first-gateway-aud` | On the gateway's `/mcp` an assertion is read from the header only, never the `CF_Authorization` cookie, only with the outer ring configured, only for the gateway application's AUD, and only after the browser `Origin` rule passed. | `apps/every-app-gateway/src/server/mcp-auth/routes.ts:174-202` | `access-mcp.sqlite.test.ts` :: never reads the CF_Authorization cookie |
| `access.mcp.linked-account-only-nothing-created` | `/mcp` serves an Access identity only through the account row a browser sign-in linked; a user row that merely has that email is never a fallback; nothing is created from `/mcp`. | `access-caller.ts:56-73` | `access-mcp.sqlite.test.ts` :: refuses an identity no account is linked to, even when a user has that email |
| `access.settings.secrets-only` | Every Access setting is read from the Worker's environment; no admin UI, server function or route writes one. | `config.ts:311-325` | **unpinned** (nothing asserts the absence of a writer) |

**Not this boundary's job.** Whether the Zero Trust configuration matches
the runbook (two applications, the bypass list, HttpOnly, the binding
cookie): the gateway neither creates nor checks it, it only fails closed on
an assertion it can't verify. `everyapp access on` (PR #379) is the
command that sets it up the runbook's way. Personal tokens and OAuth tokens
(they never pass through Access).

**Gaps.**

- *Signing out of Access is client-side, from one button, untested*
  (medium, small fix). Only the sidebar's sign-out redirects to
  `/cdn-cgi/access/logout`, and only when the cached sign-in-methods answer
  reported an Access email; the consent page's "switch account" and any
  other sign-out path leave the Access session alive, so the next page load
  signs the browser straight back in. The runbook promises more than this.
  `access.sign-out.also-signs-out-of-access` is **partial**.
- *The outer ring's security depends on Zero Trust configuration the
  gateway doesn't verify* (medium, known, large). A single application for
  both hosts, a bypass wider than the list, HttpOnly off, are all silent
  weakenings. `access.bypass-list.machine-endpoints-only` is **not
  enforced** by the gateway (it is operator configuration). `everyapp
  access on` makes the right shape; a `status` check that reads the
  applications back is the follow-up.
- *Access's email claim is trusted whatever identity provider issued it*
  (medium, medium fix). A generic OIDC provider that lets users pick their
  email would let them pick someone else's. The runbook says to enable only
  verifying providers; the gateway could restrict by `idp` claim or the
  operator could pin the identity provider id.
- *Account identity is the email, so a recycled address inherits the
  predecessor's account* (info). Both paths key the account by lowercased
  email, not Access's `sub`.
- *A refused Access sign-in can leave a user row behind in a race* (info).
- *Managed OAuth and the service-token path are unverified against a live
  application* (low, known; TODO "MCP through Cloudflare Access").

**Docs to fix.** `docs/security-model.md`: "The runbook asks for HttpOnly
and the binding cookie on both" is true for the plain outer ring; the
Managed OAuth body sets the binding cookie off for the gateway's
application, as the runbook itself explains. The sign-out promise above.

### B7. Operator → Cloudflare: deploy authority on self-host

**What crosses.** `everyapp setup`, `update`, `deploy`, `install`, `delete`,
`secret`, `email` and `db`, run on the operator's machine or in CI with
the operator's Cloudflare login or an API token: they build the app,
check the Build Output against the policy, provision resources, upload
Workers, write the registry and the owner setup link in the Gateway's D1,
and reconcile the Gateway's bindings. Since #371 (2026-10-23) there is a
second path: the browser install, where the Gateway itself downloads a
public release and uploads it with a `CF_DEPLOY_TOKEN` it holds.
`everyapp teardown --account-id <id>` is the one command that deletes
everything Every App made in an account: it runs only against an id on the
test-account allowlist (`EVERYAPP_TEST_ACCOUNTS` or
`~/.config/everyapp/test-accounts`), never `CLOUDFLARE_ACCOUNT_ID`, and asks
for the id again (`--confirm <id>` unattended). On the other side, the
Cloudflare account: every Worker, every database, the Gateway included.
The code is `packages/cli/src/lib/app/policy.ts` (the policy),
`packages/perimeter/src/registry/` (the registration rules the CLI runs
before every write), `packages/cli/src/lib/gateway/` (discovery, leases,
the downgrade guard, releases) and, for the browser path,
`apps/every-app-gateway/src/server/deploy/install.ts` and
`browser-install.ts`.

**What it stops.** A built Worker that is reachable without the Gateway
(a route, `workers.dev`, a preview URL, a domain), that binds something it
wasn't given (another Worker, a foreign database, the gateway's default
entrypoint), that ships a helper the manifest doesn't declare, that
carries a dev key or the wrong audience, or that deletes Durable Object
data it didn't drop. A registry row that takes another app's hostname or
Worker name (tombstones included), uses a reserved id, or grants a new app
to everyone by default. A secret value on a command line or in output. A
deploy from a checkout older than the live Gateway, or over a Worker
version everyapp didn't record. A release that was tampered with, or a
repository being built from its URL on the operator's machine. Two deploys
racing.

**Invariants.** The register has 38.

| Id | Invariant | Enforced by | Pinned by |
|---|---|---|---|
| `policy.worker-is-private` | A built app or helper Worker must have `workersDev: false`, `previewUrls: false`, no `domains`, and no trigger other than `scheduled`; otherwise `APP_POLICY` refuses before anything is uploaded. | `packages/cli/src/lib/app/policy.ts:165-187` | `packages/cli/src/lib/app/policy.test.ts` :: refuses workers.dev, preview URLs, its own domain, a route, a queue, an email trigger |
| `policy.worker-name-is-registry-name` | An app Worker (and each helper) deploys only under the exact name the registry assigned, `every-<orgKey>-<appId>` (`--<helper>`). | `policy.ts:111-113` | `policy.test.ts` :: refuses another name |
| `policy.binding-allowlist` | Only text, json, secret, version-metadata, assets, d1, kv, r2, durable-object, workflow, worker and hyperdrive bindings may appear; `ai`, `send-email`, `queue`, `dispatch-namespace`, `vpc`, and everything else are refused. | `policy.ts:48-61` | `policy.test.ts` :: refuses a binding type apps can't use |
| `policy.service-binding-only-gateway-and-helpers` | A `worker` binding is allowed only as `EVERY_APP_GATEWAY` → `every-app-gateway#AppGateway`, plus the app's own declared helpers from the app's Worker; a helper binds only the gateway. | `policy.ts:69-75` | `policy.test.ts` :: refuses another Worker, the gateway's default entrypoint |
| `policy.only-own-provisioned-resources` | D1, KV and Hyperdrive bindings must carry exactly the ids this deploy provisioned (the ledger); R2 buckets must be the manifest's or named after the Worker. | `policy.ts:77-82` | `policy.test.ts` :: refuses a D1 database it didn't provision |
| `policy.helpers-declared-and-checked` | Every Worker in the Build Output other than `default` must be a declared helper, every declared helper must be built, and each passes the same rules. | `policy.ts:379-400` | `policy.test.ts` :: checks every Worker in the build, and that each declared helper is there |
| `policy.identity-settings-built-in` | A built Worker must carry `EVERYAPP_IDENTITY_PUBLIC_KEYS`, `EVERYAPP_IDENTITY_ISSUER`, `EVERYAPP_AUDIENCE` equal to its Worker name, and no `EVERYAPP_DEV`. | `policy.ts:116-124` | `policy.test.ts` :: refuses dev mode, no identity keys, no audience, another Worker's audience |
| `policy.durable-object-data-safety` | A Durable Object export may be created or renamed; `deleted` only for classes the deploy dropped with `--allow-delete-durable-object-data`; `transferred` never. | `policy.ts:285-341` | `policy.test.ts` :: refuses deleting a Durable Object's data it didn't drop |
| `policy.checked-before-migration-and-upload` | The policy runs after resources are claimed but before any migration or upload, so a refused Worker leaves the database untouched. | `packages/cli/src/commands/deploy/deployApp.ts:562-566` | `deployApp.test.ts` :: builds and checks the Worker before it migrates the database |
| `registry.reserved-ids-and-worker-names` | An app id may not be `everyapp`, contain `--`, or exceed a DNS label; the Worker name is exactly `every-<orgKey>-<appId>` and never the gateway's name or prefix. | `packages/perimeter/src/registry/registration.ts:183-227` | `registration.test.ts` :: keeps the everyapp id for the gateway's own MCP tools |
| `registry.no-takeover-tombstones-kept` | A registration is refused when its hostname or Worker name is held by another organization's or app's row, tombstones included; a redeploy keeps the row's names, scope and tier. | `registration.ts:514-531` | `registration.test.ts` :: rejects a worker name already registered to another app, tombstones included |
| `registry.initial-access-private-by-default` | A new app is granted only to the deployer (the user whose verified email is the login's), owners and admins; `access: "everyone"` sets the default flag instead. | `registration.ts:415-442` | `registration.test.ts` :: makes a new app private: the deployer, owners and admins only |
| `registry.deploy-actor-recorded` | Every upload records `deployed_by_actor`: the login's email, or `api-token:<account id>`; an API-token deploy grants the app to nobody. | `packages/cli/src/lib/gateway/registry.ts:62-71` | `registry.test.ts` :: is the login's email, or the account's API token |
| `registry.row-revalidated-fail-closed` | The gateway re-validates every row's manifest it reads, maps an unknown status to disabled, and refuses an unknown tier or scope. | `packages/perimeter/src/registry/apps.ts:108-134` | `apps.test.ts` :: maps unknown statuses to disabled so registry reads fail closed |
| `registry.gateway-binds-only-rule-named-workers` | The reconciled Gateway binds `APP__<worker>` only for binding/active/disabled rows whose Worker name is the rule's and whose Worker exists; pending, deleted and odd-named rows get no binding. | `packages/cli/src/lib/gateway/desiredState.ts:19-25` | `apply.test.ts` :: binds the apps that are uploaded, and nothing else |
| `registry.tombstone-on-delete` | `everyapp delete` leaves a tombstone and in the same batch removes every access row, revokes the tokens bound to the app and drops its tool catalog. | `registration.ts:662-675` | `registry.test.ts` :: leaves a tombstone, with nothing of the app's access, tokens, tools, connections |
| `resources.ledger-is-ownership` | An existing Worker, D1, KV or Hyperdrive config is reused only when the ledger records it as this app's; a resource with the app's name that no deploy created is refused. | `packages/cli/src/lib/app/resources.ts:85-113` | `deployApp.test.ts` :: refuses someone else's database on every attempt, not just the first |
| `hyperdrive.own-origin-only` | A Hyperdrive config is created from, or adopted only when it connects to, the origin in the app's `.everyapp/secrets.env`, checked before anything is created. | `resources.ts:207-295` | `deployApp.hyperdrive.test.ts` :: adopts a config of its name that connects to the database, and refuses one that doesn't |
| `secrets.values-never-on-argv` | A secret's value is read from a hidden prompt, stdin or `--from-env`, never the command line, and reaches cf only through a private temp file. | `packages/cli/src/lib/secretValue.ts:17-75` | `deployApp.hyperdrive.test.ts` :: never puts the database password on a command line (partial: the general `secret set` path has no such pin) |
| `secrets.reserved-names-and-routing` | An app's own secret can never be `GATEWAY_URL`, `EVERYAPP_*`, `EVERY_APP_*`, `APP__*`, a Gateway setting or a binding name; `secret set` sets only names the manifest lists. | `packages/sdk/src/internal/gatewaySettings.ts:122-139`; `packages/cli/src/lib/app/secrets.ts` | `secrets.test.ts` :: refuses names the deploy sets, and the platform's namespaces |
| `deploy.never-replaces-unrecorded-version-unattended` | An unattended deploy or secret change stops when the Worker's serving version isn't one everyapp recorded. | `packages/cli/src/lib/cf/deploy.ts:189-230` | `deployApp.test.ts` :: stops unattended over an app Worker version it didn't record deploying |
| `deploy.downgrade-guard` | Deploy, install and delete refuse a checkout or release older than the live Gateway, before the registry is touched. | `packages/cli/src/lib/gateway/apply.ts:182-215` | `deployApp.test.ts` :: refuses a checkout behind the live Gateway, before anything happens |
| `deploy.lease-serializes-writes` | One run at a time holds the app's and the Gateway's lease, taken by insert-on-conflict only when expired. | `packages/cli/src/lib/gateway/lease.ts:111-131` | `lease.test.ts` :: lets one of two deploys hold it (partial) |
| `release.integrity-and-shape` | A release tarball is deployed only if its top level holds exactly its kind's entries, its SHA-256 over every file matches, and it is a production build. | `packages/cli/src/lib/gateway/release.ts:33-36, 146-159` | `release.test.ts` :: refuses a release whose files changed after it was built |
| `release.never-built-from-url` | A GitHub URL fetches only the release's `everyapp-release.tar.gz`, anonymously, over HTTPS with HTTPS-only redirects, a 200 MB cap and a timeout, into a private temp file; a repository without a release is never built from its URL. | `packages/cli/src/lib/release/github.ts:46-98` | `packages/cli/src/commands/install/release.test.ts` :: takes a GitHub repository's latest release, and sends a repository without one to its clone |
| `release.pack-ships-no-local-state` | `release` refuses to pack `.env*`, `.dev.vars*`, `*.pem`, `.cloudflare/state`, `.wrangler`, `.everyapp` or a non-production build. | `packages/cli/src/lib/app/release.ts:124-141` | `packages/cli/src/commands/install/release.test.ts` :: refuses local state, a build that isn't production's, and Prisma migrations |
| `gateway.no-deploy-api-on-self-host` | The HTTP deploy API (`/api/v1/*`) is served only when `thirdPartyDeploys` holds, which is false in `self_hosted` and invalid modes. | `apps/every-app-gateway/src/server.ts:151-157` | `platform-policy.test.ts` :: opens third-party deploys only on a hosted gateway whose gate is on |
| `install.admin-live-gate-before-download` | A browser install needs a Better Auth session of a non-banned user who is, live, an owner or admin of the chosen active organization, behind the control-plane CSRF guard; availability is checked before any download. | `apps/every-app-gateway/src/server/deploy/install.ts:50-104` | `install-api.sqlite.test.ts` :: refuses a member, a signed-out caller and a suspended organization |
| `browser-install.policy-subset-and-intake` | A browser-installed release must be a tenant-neutral build with only the allowed keys, no `workers.dev`, no triggers, no `EVERYAPP_DEV`, bindings from the allowlist (D1, own Durable Objects, assets); helpers, Workflows, KV, R2, Hyperdrive, secrets and crons are refused before anything is provisioned. | `apps/every-app-gateway/src/server/deploy/metadata.ts:119-312` | `metadata.test.ts` :: refuses helper Workers, Workflows, KV, secrets and too many Durable Object classes (partial on self-host, see gaps) |

**Not this boundary's job.** Keeping the operator's Cloudflare login
safe, or revoking it (Cloudflare's). What a trusted release's code does
once deployed (B1–B4 bound it like any app). Reviewing an app's code before
deploying it (the security review helps; the policy checks shape, not
intent).

**Gaps.**

- *The browser install is a deploy path on the public Worker, open to
  every organization owner and admin, untested on self-host* (high, medium
  fix). `docs/security-model.md` "Operator Authority" records it as the
  second deploy authority; ADR-0003 predates #371. Once `CF_DEPLOY_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID` and `APP_BASE_DOMAIN` are set and
  `BROWSER_APP_INSTALLS` isn't `off`, `POST /api/admin/apps/install`
  registers and uploads an account Worker from a public GitHub release or
  an oss.new URL for any signed-in owner or admin of any active
  organization, not only the install organization
  (`install.ts:59-104`). `install-api.sqlite.test.ts` claims the route
  "isn't available on a self-hosted gateway", which passes only because
  its env sets no `APP_BASE_DOMAIN`; `install.self-hosted-default-on` is
  **unpinned** and `gateway.nothing-public-registers-or-deploys-on-self-host`
  is **not enforced**. What stands: the admin gate,
  the CSRF guard, the release intake (integrity, tar refusals, the policy
  subset) and, behind the outer ring, Access in front of the page. What
  needs deciding: whether an admin of a secondary organization should be
  able to deploy at all, or default it off. The security model and this
  threat model record it as the second authority.
- *`CF_DEPLOY_TOKEN` on the public Worker is account-wide authority*
  (high, known, medium fix). The runbook asks for Workers Scripts Edit and
  D1 Edit on the account: the token can rewrite every Worker in the account,
  the Gateway included, and read or write every D1. Whoever reads the
  Gateway's secrets, or finds a way to make the Gateway call Cloudflare's
  API, is the operator. A thin deployer Worker that holds the token and
  accepts only the install's exact operations is TODO "Move
  `CF_DEPLOY_TOKEN` into a thin deployer Worker behind `DeployerPort`".
- *The deploy policy doesn't pin the gateway binding's props or the
  identity settings' values* (medium, known, small fix; B3's first gap
  from this side).
- *Top-level Worker config keys and compatibility flags are unchecked by
  the CLI policy* (low, known). `tailConsumers` (send the app's logs to
  another Worker), `logpush`, `placement`, `limits` and arbitrary
  compatibility flags pass through; the gateway's deployer uses an
  allowlist of keys.
- *A helper Worker the manifest dropped keeps running* with the app's
  data access and secrets until `delete --purge` (low, known).
- *Privacy and `GATEWAY_URL` are enforced at deploy time only* (low,
  medium). After the upload, anyone with the login can enable
  `workers.dev` in the dashboard; nothing checks a live Worker for drift
  until the next deploy. `everyapp status` is the place for it.
- *No test pins that `secret set` values stay off argv* beyond the
  Hyperdrive password (low).
- *`secret set|unset` on a shared app skip the platform-admin check*
  (medium, known, hosted only).

**Docs to fix.** ADR-0003: a note that #371 added a gateway-served deploy
path. `docs/runbooks/browser-app-install.md`: "on by default" is true only
once the token exists; interactive setup defaults to No.

### B8. The hosted tier: the deploy API, the dispatch namespace, egress, third-party hosts, shared apps

Not what launches. Our own install of the same code runs in `hosted` mode;
third-party deploys stay behind `THIRD_PARTY_DEPLOYS=on` until the launch
gate in `docs/hosted-vision.md` passes, and the Gateway's release
config declares no `DISPATCHER`, so every dispatch row answers 503 today.
The boundaries are built and tested against a fake namespace, unverified
live. A self-hoster is affected by none of this except where a code path
is reachable in `self_hosted` mode, which the invariants below rule out.

**What crosses.** A deploy key (`deploy`-scoped personal token) or an
admin's GitHub install bringing customer code into a Workers for Platforms
namespace; a member's browser on `<app>-<org>.<THIRD_PARTY_DOMAIN>` with a
per-host session; a dispatched Worker's `fetch()` to the internet; a
shared first-party app serving every organization. The code is
`apps/every-app-gateway/src/server/deploy/` (the pipeline), `outbound.ts`
(egress), `host-session.ts` and `packages/perimeter/src/hostSession.ts`
(the handoff), `hostSessionAuthenticator.ts`, and `getAppFetcher.ts`.

**What it stops.** Customer code binding anything the deployer didn't
choose, or serving with bindings that differ from what was sent. Customer
code on the same site as the control plane's cookie. The first-party
session reaching customer code, or a per-host session opening a
first-party app. A dispatched Worker reaching a provider with the
operator's key, the gateway's own hosts, or anything not on its allowlist
(empty today). A deploy key opening an app or `/mcp`. A tar entry escaping
its directory. A handoff code being replayed, used from another browser,
or sent to the app in a `Referer`.

**Invariants.** The register has 40.

| Id | Invariant | Enforced by | Pinned by |
|---|---|---|---|
| `gate.routes-absent-unless-on` | The deploy API's `/api/v1/*` routes exist only on a hosted gateway whose `THIRD_PARTY_DEPLOYS` is exactly `on`; otherwise they are the control plane's 404s. | `apps/every-app-gateway/src/server/platform-policy.ts:199` | `deploy-api.sqlite.test.ts` :: has no deploy API without the launch gate, or on a self-hosted gateway |
| `gate.no-deploy-keys-while-shut` | No deploy key can be made while the gate is shut, and `everyapp secret set` refuses to set `THIRD_PARTY_DEPLOYS`. | `UserPatService.ts:76-81` | `UserPatService.test.ts` :: makes no deploy key where third-party deploys are off |
| `deploy-key.scope-exactly-deploy` / `deploy-key.live-owner-admin-active-org` | A deploy API request authenticates only a token whose scopes are exactly `["deploy"]`, whose owner is, live, an owner or admin of an active organization. | `apps/every-app-gateway/src/server/deploy/auth.ts:48-75` | `deploy-api.sqlite.test.ts` :: refuses a member's deploy key, an access token and a `*` token |
| `deploy-api.key-org-and-bound-app` | A path naming any organization but the key's is 404; an app-bound key registers or deploys that app only. | `routes.ts:40-42` | same |
| `bundle.policy-refuses-before-anything-created` / `manifest.policy-at-registration` | A bundle declaring anything outside the allowlist, or a manifest declaring helpers, Workflows, KV, R2, Hyperdrive, secrets, inbound mail or too many Durable Object classes, is refused before any row is written or resource created. | `metadata.ts:48-69, 119-175` | `deploy-api.sqlite.test.ts` :: refuses a bundle with a binding outside the allowlist; :: refuses a manifest that declares inbound mail, before any row |
| `deployer.rewrites-every-binding` | The uploaded Worker's bindings are built from the manifest and the row only: app id, `aud` = the row's Worker name, the gateway's key and issuer, the organization, the gateway service binding with `{organizationId, appId, workerName}` props, its own D1 and Durable Objects, assets. | `metadata.ts:395-446` | `deploy-api.sqlite.test.ts` :: registers, deploys and verifies a third-party app |
| `deployer.read-back-or-delete` | After the upload the deployer reads the bindings back and, on any difference, deletes the Worker and fails the job. | `pipeline.ts:251-263` | `deploy-api.sqlite.test.ts` :: deletes the Worker and fails the job when the bindings read back differ |
| `deployer.never-drops-live-class` | A redeploy that drops a live Durable Object class, or whose live Worker carries a migration tag the deployer didn't write, is refused before anything is migrated. | `metadata.ts:341-369` | `deploy-api.sqlite.test.ts` :: refuses a bundle that drops a live Durable Object class |
| `registry.third-party-domain-never-the-gateways` | A `THIRD_PARTY_DOMAIN` equal to, under or above `APP_BASE_DOMAIN` refuses every registration; one sharing its last two labels with the gateway's host yields no third-party hosts at all. | `deploy/registry.ts:147-161`; `app-hosts.ts:66-79` | `deploy-api.sqlite.test.ts` :: refuses a third-party domain on, under or above the gateway's; `third-party-hosts.sqlite.test.ts` |
| `hosts.self-hosted-has-no-third-party-class` | On a self-hosted or invalid-mode gateway there is no third-party host class whatever `THIRD_PARTY_DOMAIN` says, and no handoff routes. | `app-hosts.ts:67` | `hostRoutes.test.ts` :: has no third-party class in the self-hosted profile |
| `dispatch.seam-rechecks-name-fails-closed` | `getAppFetcher` dispatches only to a Worker named exactly `every-<orgKey>-<appId>` for the row's app id, never the gateway's script or an ambiguous name; a missing `DISPATCHER` or script is 503. | `packages/perimeter/src/getAppFetcher.ts:120-149` | `getAppFetcher.test.ts` :: re-checks the registry naming rule before dispatching |
| `dispatch.limits-and-outbound-parameters-on-every-call` | Every dispatch passes per-invocation limits (5,000 ms CPU, 200 subrequests) and the outbound parameter naming the app, organization, Worker and allowlist. | `getAppFetcher.ts:85-88` | `getAppFetcher.test.ts` :: passes the limits and the app's egress allowlist to the outbound Worker |
| `egress.default-deny` / `egress.reserved-hosts-and-token-endpoints` | The Outbound entrypoint forwards a dispatched Worker's `fetch()` only over https to a hostname on the app's allowlist (empty today), and never to the providers whose keys the gateway holds, the OAuth clients' token endpoints, the gateway's hosts or any third-party host; a dispatch that passed no app is refused everything. | `apps/every-app-gateway/src/server/outbound.ts:37-90` | `outbound.test.ts` :: always denies the providers whose keys the gateway holds, and the gateway's own hosts |
| `cookie-boundary.credentials-never-cross` | On a third-party host the authenticator reads only `__Host-everyapp_s` (or a personal token) and never the Better Auth cookie; any other bearer authenticates nobody. | `hostSessionAuthenticator.ts:98-113` | `third-party-hosts.sqlite.test.ts` :: never honours the gateway's cookie on a third-party host |
| `handoff.code-bound-single-use-60s` | A handoff code is an HMAC token (HKDF of `BETTER_AUTH_SECRET`) naming the session, user, app row, host, nonce hash and return path, valid 60 s, claimed once in D1. | `packages/perimeter/src/hostSession.ts:39, 114-135` | `third-party-hosts.sqlite.test.ts` :: uses a code once, in the browser that started the handoff |
| `handoff.issued-only-to-entitled-signed-in-person` | A code is issued only for an https return URL on a third-party host whose row is a live dispatch app, to a signed-in live member with the app installed. | `host-session.ts:132-145` | `third-party-hosts.sqlite.test.ts` :: issues no code to a member without the app, or to a signed-out browser |
| `host-session.live-recheck-every-request` | Every request on a third-party host verifies the host cookie and then re-reads, live, the gateway session row, the ban, the membership, the organization's status and the app grant. | `hostSessionAuthenticator.ts:64-83` | `third-party-hosts.sqlite.test.ts` :: ends the host session with the gateway session, the membership and the access |
| `responses.third-party-app-may-not-grant-credentials` | On third-party hosts the perimeter removes `Access-Control-Allow-Credentials` and every `Set-Cookie` named `__Host-everyapp_*` from app responses, 101 handshakes included. | `hostSession.ts:50, 253-293` | `third-party-hosts.sqlite.test.ts` :: keeps an app from granting credentialed CORS or setting the perimeter's cookies |
| `tar.refuses-everything-but-files-and-dirs` / `release.integrity-and-shape` | The tar reader refuses bad checksums, links, devices, absolute or `..` paths, duplicates and anything but `release.json`, `.cloudflare` and `migrations` at the top; the SHA-256 over every file must match. | `deploy/tar.ts:26-43`; `release.ts:31` | `release.test.ts` :: refuses a release whose files don't match its sha256; :: refuses links, devices, absolute paths |
| `shared.platform-organization-only` / `shared.opens-for-active-members-hosted-only` | A shared app registers only in the platform organization, never changes scope, is never on the dispatch tier, and opens for members of every active organization only when `platformPolicy.sharedApps` (hosted) holds. | `registration.ts:465-500`; `betterAuthAuthenticator.ts:175-180` | `registration.test.ts` :: refuses a shared app from any organization but the platform's; `shared-apps.sqlite.test.ts` :: opens a shared app for members of every organization |

**Gaps.** (ranked for the hosted shape; none affects a self-hosted gateway
unless marked)

- *Any organization's owner or admin can deploy public code into the
  operator's account through the browser install, by default* (medium,
  **self-hosted too**, small fix): the install accepts any organization the
  user administers, not only the install organization. See B7.
- *The browser install on self-host has no test* (high, **self-hosted
  too**): see B7.
- *`connect()` from a dispatched Worker is unverified* (medium). Outbound
  Workers intercept `fetch()`; whether `cloudflare:sockets` connections
  pass through them is undocumented. If not, a dispatched app can open raw
  TLS to any host. Needs a live check before the gate opens.
- *Capability and AI-proxy calls are neither refused nor metered for
  dispatch-tier callers* (medium, known): the launch gate's "capability
  calls refused for dispatch-tier rows" item.
- *The org key in a dispatched Worker's name is never compared with the
  row's organization at read time* (low, known;
  `dispatch.org-key-matches-row-organization` is **not enforced**): rows
  are written only by the pipeline with the organization's own key.
- *`secret set|unset` on a shared app skip the platform-admin check*
  (low, known; `shared.secret-set-checks-platform-admin` is **not
  enforced**).
- *`PROVIDER_HOSTS` is a hand-kept list* (low): a provider added later
  stays reachable from dispatched code until someone adds it.
- *The GitHub release download in the gateway has no timeout* (low,
  self-hosted too through the browser install).
- *An app-bound deploy key can read any deploy job of its organization*
  (info).
- *The egress allowlist ignores ports, and no manifest `egress` list
  exists yet* (info, known).
- *Deleting a dispatch app leaves its namespace script and D1 behind*
  (info, known).
- *No sign-out on third-party hosts* (info, known): the server refuses the
  cookie as soon as the gateway session ends.
- *The tier is unverified against a live namespace* (known, the launch
  gate).

## Credentials: lifetime and revocation

Every credential in the system, how long it lives, what ends it, and how
fast. Verified in the code on 2026-10-23; the pinning tests are in the
register under the boundary named.

| Credential | Lives | Checked | Ended by | Not ended by |
|---|---|---|---|---|
| Better Auth session (`__Secure-better-auth.session_token`) | 7 days, extended by a day on use, no absolute cap | Read from D1 on every request (cookie cache off); the membership and role it acts under cached 30 s per isolate; app access and ban read live | Sign-out, the holder's revoke-session endpoints (reachable, no UI yet), deactivation, the outer ring replacing someone else's session, and (#405) a password reset | Member removal (the session lives on in the person's other organizations) |
| Third-party host session (`__Host-everyapp_s`) | 24 hours | Every request re-reads the gateway session row, the ban, the membership (live) and app access; organization status 30 s | Anything that ends the gateway session | A sign-out on the app host (none exists; TODO) |
| Handoff code | 60 seconds, single use, bound to the browser's nonce | At the exchange | Use, expiry | Presenting it in the wrong browser (refused but not consumed; B8) |
| Identity JWT (`x-everyapp-identity`) | 120 seconds, minted per request | By the SDK at the app, by the AppGateway when forwarded | Expiry only | Revocation: a removed or suspended person's in-flight identity works at the app for up to 120 s |
| Public marker / system token | 120 s (reused 60 s) / 60 s, catalog only | By the SDK | Expiry | |
| Personal access token (`epat_…`) | 90 days by default, 30 for a deploy key, 1 day to 1 year | Live on every request: owner's membership, ban, organization status, scopes | The holder's revoke, member removal (that organization's tokens), deactivation (all), app deletion (tokens bound to it) | An admin acting on another member's token (none can; B5) |
| OAuth access / refresh token (connected AI apps) | 1 hour / 30 days idle and absolute | Every `/mcp` request and every refresh re-reads the connection row, role, ban, organization status, app access | The holder (Connected AI apps), member removal, deactivation, re-consent (replaces), the hourly cron after 31 idle days | A replayed refresh token (no reuse detection; B5); a held app-host `subscriptions/listen` stream for up to 10 minutes (B5; the gateway's own ends at the token's expiry and rechecks the connection every poll) |
| Consent transaction | 10 minutes, single use, bound to the browser | At the decision | Use, expiry | |
| Setup link (`est_…`) | 24 hours, single use | At the claim (constant-time hash compare) | Use, expiry, a newer link minted by `setup` | The CLI giving up waiting after 15 minutes: the link stays valid (B2, listed) |
| Invitation link (`einv_…`) | 72 hours, single use, bound to the invited email | At sign-up and accept | Use, expiry, an owner or admin cancelling it | The inviter's deactivation or removal (listed) |
| Email verification link | 24 hours; signs in only while unverified; hosted only | At the click | Use, expiry | |
| Password reset link | 1 hour, single use | At the reset | Use, expiry | An admin-minted link survives that admin's deactivation (listed) |
| Deploy key (hosted) | 30 days | Live per request: owner/admin role, membership, organization status | Revoke, removal, deactivation | A deploy job already started: it runs to its 5-minute deadline under `waitUntil` |
| Cloudflare Access assertion / session | Assertion with 60 s skew; the Access session as the application sets it (`everyapp access on` sets 720 h) | A session counts only with an assertion on that request; JWKS cached 10 minutes | Access's own logout, the application's session end, deactivation here | Taking someone out of the Access policy (the gateway never reads the policy; their Access session runs to its end); bearer credentials, which never pass through Access |
| `CF_DEPLOY_TOKEN` (browser installs) | No expiry | Never by the gateway | Revoking it at Cloudflare, `BROWSER_APP_INSTALLS=off`, `secret unset` | Anything in the Gateway's own tables |
| Organization suspension | Until lifted | Honoured within 30 s per isolate everywhere | Nothing in the code sets it yet (the platform's lever) | |
| Registry row (a disabled or deleted app, its senders) | Until changed | 30 s per isolate (5 s on a miss) | The CLI's writes, Admin → Apps | |

## Known gaps, ranked

Everything this pass found that isn't closed, ranked for the self-hosted
launch: what a stranger, a member, an app or an AI client could do that the
model says they shouldn't, then what the operator is exposed to, then the
hosted tier. Each line names the boundary and, where one exists, the
invariant id and the TODO entry. "Fixed" names the pull request; "merged"
means it is on main (every boundary fix from this pass merged on
2026-10-24).

**Self-hosted, before Monday if possible**

1. **The browser install lets any organization owner or admin deploy into
   the operator's account** (B7, high; `install.self-hosted-default-on`,
   `gateway.nothing-public-registers-or-deploys-on-self-host`). Once
   `everyapp setup` has stored a `CF_DEPLOY_TOKEN`, `POST
   /api/admin/apps/install` registers and uploads a public release for any
   owner or admin (on a self-hosted gateway that is the one organization
   the setup claim made, so: anyone the owner made an admin), with a token
   that can rewrite every Worker and database in the account; the release's
   manifest then grants it the operator's provider keys, sender and members
   list, which the operator never read. Behind Access the
   page is behind Access; the token's reach is the problem either way.
   Decision for Ben (TODO "Threat model and security scanning"): restrict
   it to the install organization's owners, default it off, or move the
   token into a thin deployer Worker. It also has no self-hosted test.
2. **The OAuth-client proxy signed any grant** (B4, high; fixed in #387,
   merged). Facebook's client-credentials grant returns the app access
   token, which is `<app id>|<app secret>`: the operator's secret handed
   to the app. Discord, Twitch and Kick mint application-level tokens.
   The proxy now completes only a user's grants.
3. **A release tarball could carry symbolic links, hard links and module
   paths outside its bundle** (B7, high; fixed in #386, merged). The
   system `tar` extracted them and cf would have uploaded the operator's
   private files into the Worker's bundle.
4. **The AppGateway binding's props aren't pinned by the deploy policy**
   (B3, B7, high, known; TODO "Redesign stack 2, identity"). On a
   self-hosted gateway only the operator deploys, so this is the operator
   misattributing their own app; it is the hosted launch gate's "props
   pinned on every upload" item.
5. **Nothing bounds an app's spend on the operator's provider keys unless
   a cap is set** (B4, high, known; `cap.per-organization-limits` is
   enforced only for an app an owner or admin capped, #416). A buggy loop
   in any app runs on the operator's OpenAI or DataForSEO account until the
   operator notices, or until the app's monthly cap (Admin → Usage; null,
   unlimited, by default under Ben's 2026-10-16 ruling) stops it
   (`docs/design/2026-10-teams.md`).
6. **A read-only MCP token could run write tools on an app that answers
   `/mcp` itself** (B3, B5, medium; mostly closed by #447, which deleted
   the SDK's `createMcpHandler`, the only in-repo way an app served `/mcp`
   itself; #404, which patched it, closed unmerged). What remains, by
   Ben's decision to keep it through launch: the manifest's `mcp: "app"`
   escape hatch and the perimeter branch that skips the ToolBus for it
   (`packages/perimeter/src/gateway.ts:421-429`) still forward an identity
   carrying the token's `mcp:read` scopes to whatever handler the app
   wrote, so the read-only promise there rests on the app honouring the
   scopes. No in-repo app does this and the starter never did; a
   post-launch perimeter PR may remove the hatch.
7. **A password reset didn't end existing sessions** (B2, medium; fixed in #405,
   merged). Better Auth's `revokeSessionsOnPasswordReset` was
   unset, so the standard remedy for a stolen session did nothing to it
   for up to 7 days.
8. **The AI proxy forwarded encoded separators inside an opened extra
   route, and checked only the first `model` part of a multipart body**
   (B4, medium; fixed in #403, merged). With `/v1/files` opened,
   `/v1/files/x/..%2F..%2Fbatches` reached OpenAI, which decodes `%2F`
   before routing, so the shared key listed the account's batches.
9. **An app response's `Set-Cookie` could keep `Domain=` past the
   perimeter**: on a first-party WebSocket 101 handshake (B1, medium,
   known; `perimeter.first-party-101-cookie-domain` is not enforced; TODO
   "Strip session-named Set-Cookie headers") and, if the attribute matcher
   is strict about whitespace and case, on any response: `Domain =example.com` slipped
   past the matcher (B1; fixed in #406, merged). A parent-domain session cookie locks
   every member out until they clear cookies.
10. **A stolen admin session can take over any single-organization
    member and entrench itself** (B2, medium): reset links for members,
    admin invitations, member-to-admin promotion, with no fresh-session
    requirement. Behind the outer ring the browser must also pass Access
    as that person, which is the launch mitigation.
11. **Script on any first-party app host can overwrite the session cookie
    and sign the victim's browser in as the attacker** (B1, B2, medium;
    Access in front mitigates). The cookie is `Domain=<APP_BASE_DOMAIN>` and
    every app host is one label below, so a page on a sibling host (an XSS,
    or an app the operator installed) writes a cookie with the same name,
    domain and path and replaces the member's: a login CSRF across the
    control plane and every app. The duplicate-cookie refusal catches two
    copies, not a replacement. A property of the shared cookie (TODO
    "First-party hosts share the control plane's cookie"); the remedy is
    per-host sessions as the third-party tier has.
12. **Invitations and admin-minted reset links outlive the admin who
    issued them** (B2, medium; Access mitigates). Deactivating or removing
    an admin cancels nothing they created; an invitation they sent still
    joins someone, a reset link they minted still resets. Small: cancel
    pending invitations and reset tokens on deactivation and removal.
13. **Nobody but the holder can revoke a personal token** (B5, low). An
    admin who learns a member's token leaked must remove or deactivate the
    member; and a member has no page to end their own other sessions.
14. **An unclaimed setup link stays valid for 24 hours after the CLI stops
    waiting**, and the agent flow prints it into the agent's output (B2,
    low; Access mitigates). The link is the whole credential for becoming
    owner; `setup` run again replaces it.
15. **Public routes are invisible where the operator looks** (B1, low):
    the deploy summary says "Private to you, owners and admins" whatever
    the manifest makes public, and `everyapp access on` punches those
    paths through Access. Fixed in #424: the deploy summary lists them
    ("Open to the internet without sign-in: GET /t/*, …") and
    `everyapp status` shows a PUBLIC column per app.
16. **DataForSEO's `tasks_fixed` was account-wide and served** (B4, medium;
    fixed in #402, merged).
17. **No owner recovery and no ownership transfer** (B2, medium, known).
    A compromised owner account can't be removed by anyone but the
    operator editing D1.
18. **Signing out doesn't reliably sign out of Access** (B6, medium;
    `access.sign-out.also-signs-out-of-access` is partial): only the
    sidebar's button redirects to Access's logout, and only when the
    cached sign-in-methods answer knew the Access email; the consent
    page's "switch account" and any other sign-out leave the Access
    session alive on a shared browser.
19. **Access's email is trusted whatever identity provider issued it**
    (B6, medium). The runbook tells operators to enable only verifying
    providers; nothing in the gateway checks which one signed.
20. **Refresh tokens for connected AI apps have no replay detection**
    (B5, medium, known; `oauth.refresh-rotation-no-reuse-detection` is not
    enforced). A stolen refresh token mints access tokens alongside the
    client until the client has refreshed twice; revoking the connection
    ends it.
21. **Personal tokens default to `*` for 90 days and the UI offers no
    narrower scope** (B5, medium, known; TODO "Access levels for personal
    access tokens"). The read-only token an AI client should get can't be
    made from the UI.
22. **An admin could mail a reset link to the owner, another admin,
    themselves or a deactivated member** (B2, low; fixed in #407, merged).
23. **With `GATEWAY_URL` missing, the outer ring stops vouching as well as
    signing in, while the config still reports it on** (B6, low). Every
    session check then honours a cookie with no assertion. A one-line
    separation of the two uses in the plugin.
24. **A held `subscriptions/listen` stream on an app host's `/mcp`
    outlives the token or session that opened it** for up to ten minutes
    (B5, low); the gateway's own `/mcp` re-checks on every poll, ends the
    stream at the access token's or Access assertion's expiry, and since
    2026-10-24 holds it for 30 minutes (Claude Code parks re-listening
    after five reopens an hour), keeping the stream open through up to
    three polls whose D1 read fails, during which it pushes nothing.
25. **Any member can read the whole member directory** through Better
    Auth's open `/organization/list-members` and `get-organization` (B2,
    low): emails and roles of the organization. Fine for a four-person
    company; a decision for teams.
26. **`everyapp://` was a wildcard-authority trusted origin, and
    verify-email appended the session cookie to custom-scheme redirects**
    (B2, low; closed by #442). The mobile shell went with #427, and
    #442 removed the Expo plugin, the `everyapp://` trusted origin, the
    native-origin exemption in the control-plane guard and the Access
    mobile handoff, so the control plane's same-origin rule has no
    exceptions left but the token endpoints.
27. **An app could publish OAuth authorization-server metadata on its
    host** (`/.well-known/oauth-authorization-server`,
    `openid-configuration`) that legacy MCP discovery honours (B1, low; fixed in #406, merged: both paths are reserved like
    the protected-resource one).
28. **`ai.models` checks only the JSON `model` field; OpenRouter's `models`
    fallback list is forwarded unchecked** (B4, low).
29. **Consent grants `mcp:write` to a client that asked for `mcp:read`**
    (B5, low): the form preselects read & write and the grant follows the
    person's choice, not the client's request.
30. **Proxy-forwarding headers reach apps as the client sent them** (B1,
    low): `X-Forwarded-For` and friends; `cf-connecting-ip` is the
    authoritative address.
31. **Revocation windows**: 30 s per isolate for memberships, organization
    status and registry rows; 120 s for an already-minted identity; up to
    7 days for a session no one revokes (B1, B2, B3; documented, listed so
    nobody expects less).

**The operator's own exposure**

32. **`CF_DEPLOY_TOKEN` on the public Worker is account-wide authority**
    (B7, high, known; TODO "Move `CF_DEPLOY_TOKEN` into a thin deployer
    Worker"). Whoever reads the Gateway's secrets is the operator.
33. **The old gateway era's Workers still run in the dogfood account**
    (`every-todo-app`, `every-open-seo`, `every-simple-todo` and a dozen
    more with `workers.dev` on; TODO "Paused"): pre-#267 code behind
    nothing. Not this repository's code, but the account that launches.
34. **The published npm versions carry the holes this repository fixed**
    (`everyapp` 0.2.2, `@every-app/sdk` 0.2.0; TODO "Paused"): deprecate
    them.
35. **`everyapp dev` served any name pointed at 127.0.0.1, and its cron
    trigger took a page's POST** (dev only, medium; fixed in #409, CLI).
    A DNS-rebinding page read and wrote the local app as the seeded owner
    and could spend the developer's own provider key from `.dev.vars`.
36. **Privacy and `GATEWAY_URL` are enforced at deploy time only** (B7,
    low): a dashboard change (workers.dev on, a route added) goes unnoticed
    until the next deploy. `everyapp status` is the place to read the live
    Workers back.
37. **The Zero Trust configuration isn't verified by the gateway** (B6,
    medium, known): one application instead of two, a bypass wider than
    the list, HttpOnly off, are silent weakenings. `everyapp access on`
    makes the right shape; a read-back in `status` is the follow-up.
38. **Hygiene before the public copy** (the launch-review thread's scan):
    no LICENSE file. The rest of its list is done: `docs/research/` (deleted, #433) and
    `apps/mobile-native/app.json` deleted, `/docs/internal` unpublished,
    the Postiz fixture's AGPL schema replaced with our own SQL (#458), all
    2026-10-24. `docs/launch-2026-10-27.md` section G.

**Hosted only** (nothing here reaches a self-hosted gateway)

39. A dispatch-tier Worker sends mail from the platform's own sender and
    spends the platform's provider keys with no per-organization bound
    (B8, medium; the launch gate's "capability calls refused for
    dispatch-tier rows").
40. With open sign-up, anyone with an invite link can plant an account for
    someone else's email, which the victim's own verification click then
    hands over (B2, medium; `HOSTED_OPEN_SIGNUP=false` keeps the preview
    invite-only, where the invite link's email binding stops it).
41. `connect()` from a dispatched Worker is unverified against the egress
    policy; the org key in a dispatched Worker's name isn't compared with
    the row's organization; `secret set` on a shared app skips the
    platform-admin check; the platform-domain refusal doesn't cover
    `THIRD_PARTY_DOMAIN`; an organization's app may take a shared app's
    slug and the gateway's `/mcp` routes the tool call to the first; a
    handoff code presented in the wrong browser isn't consumed; there is
    no sign-out on third-party hosts (B8, low). All recorded in TODO.md's
    hosted sections or the launch gate.

**Roadmap, not gaps** (cited, not restated): per-member token scopes,
approvals for destructive tools, per-app roles in the identity, read-only
members, SSO-only guarantees, audit export and IdP group mapping are the
teams design's roadmap (`docs/design/2026-10-teams.md`); per-app provider
scope narrowing is the OAuth-scopes design (`docs/design/2026-10-oauth-scopes.md`).

## Verification

- **The tests named in this document.** Each invariant's `pinned_by` names
  the file and test. `docs/TESTING.md` lists every suite and the end-to-end
  perimeter test (`packages/perimeter/src/integration/e2e.test.ts`) that
  wires the real proxy core to a real app built with the real SDK.
- **Anthropic's security review for Claude Code.** `/security-review` in
  Claude Code reviews the branch's pending changes against this model (the
  repository's additions to its prompt are in `.github/security-review/`),
  and `.github/workflows/security-review.yml` runs the same review on
  every pull request once `ANTHROPIC_API_KEY` is in the repository's
  secrets. New apps get it too (`starter/.github/`).
- **Dependency audit.** `pnpm audit` runs in CI on the lockfile
  and fails on critical advisories (`.github/workflows/pr-checks.yml`).
- **A live Gateway.** `everyapp status` says whether the live Gateway was
  built from the checkout's sources; `docs/runbooks/mcp-oauth.md` and
  `docs/runbooks/cloudflare-access.md` each end with a checklist for a
  deployed gateway.

## Reporting a problem

Every App is alpha and open source. If you find a hole, we'd rather know:

- Open a private vulnerability report on the repository (**Security → Report
  a vulnerability**) so it isn't public before a fix is out.
- Say which invariant breaks (its id from this document), the shape it
  affects (self-hosted, hosted, both; with or without Access in front), and
  how to reproduce it. A failing test is the best report.
- Expect a fast, informal reply from a very small team. There is no bounty.
