# Linked dev: `everyapp dev --gateway https://everyapp.team`

Date: 2026-10-28. Status: built on `feature/linked-dev` (PR #866, on main since native sign-in #855 merged), reviewed the same day; not merged, nothing deployed, no live check (Ben's rule). Section 11 says where the build departs from the text. Decisions and questions: TODO.md "Linked dev".

## 1. The problem

A person building an app against a Gateway that already has providers set up (everyapp.team: OpenRouter, DataForSEO, email senders, members) has to copy every key into the app's `.dev.vars` to run it locally. `everyapp dev` today:

| Mode | Who you are | AI, email, capabilities, members |
| --- | --- | --- |
| stub (default) | a seeded `dev@everyapp.localhost` | your own keys in `.dev.vars`, or "not set up" |
| mirror | your real session on a Gateway running *on this laptop* | same: your own keys |

Ben's goal: "local dev will get a lot easier for making apps that require the same secrets as we already have set up." The app should run on the laptop, as you, and reach the real Gateway's services, with **no provider key on the laptop**.

## 2. The idea in one sentence

`everyapp dev --gateway <url>` signs the CLI in to that Gateway once (the native sign-in flow, bound to one app), and the SDK's missing `EVERY_APP_GATEWAY` binding becomes a shim that forwards AI, capability, email, members and event calls to one new Gateway endpoint, authorized by that token; the app's data, identity signing and its own secrets stay local.

## 3. The picture

```
 laptop                                                          Gateway (everyapp.team)
 ┌──────────────────────────────────────────────────┐            ┌──────────────────────────────┐
 │ everyapp dev --gateway https://everyapp.team     │            │                              │
 │                                                  │ 1. once:   │  /oauth/authorize + consent  │
 │   token store ~/.config/everyapp/linked-dev.json │ ◄────────► │  resource = /linked-dev/<app>│
 │   (refresh token, 0600; never in the app)        │  browser   │  owner/admin, app access     │
 │                                                  │            │                              │
 │   gateway-lite  http://<app>.localhost:8787      │ 2. whoami  │  GET /linked-dev/<app>/whoami│
 │     identity: real user + org, signed with the   │ ◄────────► │  (re-read: role, access,     │
 │     DEV key (production apps never trust it)     │   bearer   │   org status, row revoked?)  │
 │                                                  │            │                              │
 │     /__everyapp/gateway/*  (loopback, nonce)     │ 3. calls   │  ANY /linked-dev/<app>/api/… │
 │       ──► strips x-everyapp-identity/-org        │ ─────────► │  ──► handleAppGatewayRequest │
 │       ──► adds Authorization: Bearer <token>     │   bearer   │      as that app, that user  │
 │                                                  │            │      keys stay here          │
 │   app Worker (cf dev, Miniflare)                 │            │      counted + rate-limited  │
 │     EVERY_APP_GATEWAY missing → SDK shim ───────►│            │      audit event tagged dev  │
 │     D1 / KV / R2 local; app secrets in .dev.vars │            │                              │
 └──────────────────────────────────────────────────┘            └──────────────────────────────┘
```

What never crosses the wire: provider keys (they stay Worker secrets on the Gateway), the app's own secrets (`.dev.vars`, read-only as today), the local dev identity JWT (stripped before forwarding), local data.

## 4. The pieces

### 4.1 Sign-in: a third grant kind on the existing OAuth server

The native sign-in branch already makes the Gateway's OAuth server issue tokens for one app (RFC 8707 `resource` = the app host's origin). Linked dev adds **one more resource per active first-party app**: `${GATEWAY_URL}/linked-dev/<app id>`. Same server, same PKCE, same KV, same `mcp_connections` row, same revocation paths. Differences from a native grant:

| | native (`kind: "native"`) | linked dev (`kind: "dev"`) |
| --- | --- | --- |
| resource / audience | `https://<app host>` | `${GATEWAY_URL}/linked-dev/<app id>` |
| opens | the app itself, as the member | the Gateway's services for that app, as the member |
| who may consent | anyone who can open the app | owners and admins who can open the app, in an organization with linked dev **on** |
| client | a native app (CIMD or DCR) | the CLI: a dynamically registered public client, `client_name: "everyapp dev on <hostname>"`, loopback redirect |
| scope | `*` | `*` (ignored by the endpoint: the resource binds everything) |
| consent page | "wants to use OpenZen as you" | "everyapp dev on this computer wants to use OpenZen's AI, email, providers and members **as you** while you develop. Calls bill this workspace. Data stays on your computer." |
| lifetimes | 1 h access, 30 d sliding refresh | same (question 2 in TODO) |
| listed under | Settings → Connections, "Apps on your devices" | same table, labelled "Linked dev", revocable there |

The CLI's flow (`packages/cli/src/lib/linkedDev/`): discover `/.well-known/oauth-authorization-server`, register once per gateway (client id kept beside the token), bind a free loopback port, open the browser (`open`), exchange the code with PKCE, store `{ gateway, appId, clientId, refreshToken, accessToken, expiresAt }` in `~/.config/everyapp/linked-dev.json` (mode 0600, one entry per gateway + app). On a terminal with no browser it prints the URL. `everyapp dev unlink [--gateway]` revokes (RFC 7009) and forgets.

Dynamic registration off on the gateway (`MCP_DCR_ENABLED=false`) means linked dev can't sign in: `LINKED_DEV_REGISTRATION_OFF`, with the switch named.

### 4.2 Identity: the real person, the dev key

The gateway-lite keeps minting the identity JWT with the SDK's well-known dev key (`kid: everyapp-identity-dev`), which only a development build of the app accepts and no deployed app ever will. What changes is **who** it names: `GET /linked-dev/<app>/whoami` answers the token's user id, email, organization id and name, and role, and whether they can open the app now. The gateway-lite caches that for 60 seconds, then re-reads it, so a revoked token, a lost role or lost app access stops the local app within a minute (and at once on the next Gateway call, which fails closed).

Everyone who reaches the gateway-lite's loopback port is that person, as stub mode makes everyone the seeded user. `--host 0.0.0.0` prints the same warning as today, stronger: whoever reaches it spends on your Gateway.

Mirror mode's "per-app access not enforced" does not carry over: the consent refuses a person who can't open the app, `whoami` re-checks it, and the endpoint re-checks it on every call. `everyapp dev token` is unchanged (dev-kid tokens for scripts).

### 4.3 Gateway services: the shim and the endpoint

**SDK.** Every SDK service (`createGatewayFetch`, `integrationFetch`, `sendEmail`, `listMembers`, `emit`, `aiStatus`) reads `env.EVERY_APP_GATEWAY` today. They go through one helper, `gatewayBinding(env)`: the binding when deployed; under `EVERYAPP_DEV` with `EVERYAPP_LINKED_DEV` set, a `{ fetch }` that rewrites `http://every-app-gateway.internal/<path>` to `http://127.0.0.1:<gateway-lite port>/__everyapp/gateway/<path>` and adds `x-everyapp-linked-dev: <run nonce>`. The `.dev.vars` provider-key fallback stays for stub and mirror modes and for linked mode when the Gateway refuses (the shim answers the Gateway's refusal as is; the SDK never silently falls back to a local key when linked).

`everyAppWorker()` gets the loopback URL and nonce from the process environment the CLI starts `cf dev` with (`EVERYAPP_LINKED_DEV_URL`, `EVERYAPP_LINKED_DEV_NONCE`), as it gets `EVERYAPP_DEV_GATEWAY_URL` today; nothing is written into the app.

**Gateway-lite (CLI).** `/__everyapp/gateway/*` accepts loopback requests carrying the run nonce and no browser markers (`isBrowserRequest`, as the cron trigger does), strips `x-everyapp-identity`, `x-everyapp-org` and `authorization`, adds the bearer, and forwards to `${gateway}/linked-dev/<app id>/<path>`, streaming both ways. A 401 from the Gateway refreshes the token once and retries; `invalid_grant` prints "run `everyapp dev --gateway …` again to sign in" and answers 401 to the app.

**Gateway.** `ANY /linked-dev/<app id>/…` on the Gateway's host (`apps/every-app-gateway/src/server/linked-dev.ts`, mounted from `server.ts` beside the OAuth routes), bearer only:

1. Off unless `MCP_OAUTH_ENABLED` is on → 404; with it on but the organization's `linked_dev` setting off, every token is 401 (`resolveDevCaller` reads the switch on each call).
2. `validateToken("${issuer}/linked-dev/<app id>", token)` → props must be `kind: "dev"`; `resolveDevCaller` re-reads the row (not revoked, same user/org/app), the live role (owner or admin **now**), ban, organization active, and `user_app_access` now. Anything else → 401, never anonymous.
3. The app row from the props: active, first-party tier, in the token's organization, slug equal to the path's app id. Else 403.
4. Rate limit per connection: 120 calls a minute, 2 000 a day (the `rate_limit_counters` table), 429 with `Retry-After`.
5. Headers `x-everyapp-identity`, `x-everyapp-org`, `authorization` are dropped. `handleAppGatewayRequest` runs with the row's `{ organizationId, appId, workerName }` as props and a **trusted attribution** `{ organizationId, user }` built from the row and the member (new option; `attributeCall` is skipped, since a dev identity JWT must never be verified here). So AI, capability, email, members and emit paths work exactly as for the deployed app, with the same manifest checks, provider allow-list, caps and usage counting.
6. `/whoami` (GET) answers the resolved member and `hasAccess`.
7. Audit: a `dev.session_used` event (the events table, the audit log) per connection per UTC day, with the app, user and client name, when the row's `last_used_at` is older than a day; plus `linked_dev.call` in the Worker's logs per call. Usage rows carry `source: "dev"` so Usage can split development spend (question 3).

Behind Cloudflare Access: `/linked-dev/*` joins the Gateway application's bypass list (`gatewayDestination` in `packages/cli/src/lib/access/plan.ts`), beside `/mcp`, `/oauth/token`, `/oauth/register`: a bearer-only path that checks its own credential. `everyapp access on`/`status` reconcile it as they do the others.

### 4.4 Data stays local

Nothing about the app's storage changes: D1, KV, R2, Vectorize are Miniflare's local ones. The endpoint serves only the three route families the service binding serves today (`/api/ai/*`, `/api/integrations/*`, `/api/events/emit`) plus `/whoami`. There is no route to any app's data, to `/mcp`, to the control plane, or to another organization's members.

### 4.5 The app's own secrets stay in `.dev.vars`

Unchanged. There is **no** endpoint that returns a secret value, for the app's secrets or the Gateway's providers; the manifest's `secrets` are read from `.dev.vars` as today, and the ready block keeps naming the missing ones. A later "fetch my app's secrets" convenience would break the write-only secrets model and is out.

## 5. The ready block

```
  Linked to https://everyapp.team as ana@acme.com (owner of Acme) for open-zen
  AI, email, providers and members go through the Gateway: calls bill Acme's providers.
  Data (D1, KV, R2) is local. Secrets: .dev.vars (OPENZEN_SIGNING_KEY missing).
  Sign out: everyapp dev unlink
```

## 6. Threats

| Threat | Answer |
| --- | --- |
| **Stolen token** (laptop, disk) | Audience is one app's linked-dev resource: it opens no app host, not `/mcp`, no control plane. What it can do: spend on that app's allowed providers as that person, send email as the app from its registered senders, read that app's members, emit that app's events. Access token 1 h; refresh revocable under Settings → Connections; `everyapp dev unlink`; rate-limited; every day of use is an audit event naming the client. File is 0600. |
| **Spend** | Real: counted against the organization and the app, under the organization's monthly caps as production calls; rate-limited per connection; usage tagged dev. |
| **A page on the laptop calling the loopback forwarder** | Browser markers refused (Sec-Fetch, Origin, Referer); custom header required (no simple cross-origin request can send it); run nonce. |
| **The dev identity JWT reaching production** | Stripped by the gateway-lite; the endpoint never calls `attributeCall` and never verifies an identity header: attribution is the token's. |
| **A member who isn't owner/admin, or lost access since** | Consent refuses; `resolveDevCaller` re-checks role and app access on every call; `whoami` within a minute. |
| **Another organization's app or members** | The app row must be in the token's organization; members come from `listAppMembers` for that app; a shared app on the hosted tier is attributed to the token's organization. |
| **Token replay on an app host or `/mcp`** | Wrong audience → null → fails closed (the native branch pins both directions; linked dev adds its own cases). |
| **Registration flood** | Existing per-address and per-gateway budgets. |
| **A gateway that didn't opt in** | 401 to every token on the endpoint and `invalid_target` at authorize (the resource isn't listed) until an owner turns it on; 404 only with the OAuth server off. |
| **Access outer ring** | `/linked-dev/*` is bypassed by path, like `/mcp`, and takes a bearer only; a cookie there is 401. |

Threat-model rows added under B5: `dev.audience-is-one-app`, `dev.owner-admin-only`, `dev.off-by-default`, `dev.identity-never-forwarded`, `dev.no-secret-read-path`, `dev.no-production-data`, `dev.rate-limited-and-audited`, `dev.revocation-paths`.

## 7. What it costs

One new resource shape in `resources.ts`, a `kind: "dev"` branch in consent and validation (`resolveDevCaller`), one Gateway route module, one `org_settings` column + migration, one trusted-attribution option on `handleAppGatewayRequest`, one SDK helper + env pair, a CLI sign-in library and the forwarder in the gateway-lite, `workspace linked-dev on|off`, docs (`dev.md`, `workspace.md`, `errors.md`) and tests. Three to four agent-days.

## 8. Alternatives considered

- **Reuse the native grant as is** (resource = the app host). Simpler, but the dev token would also open the production app's API as the person: broader than development needs. Rejected.
- **Copy provider keys down with the token** ("fetch my keys"). Breaks the write-only secrets model and puts production keys on laptops. Rejected, and out for good.
- **A personal access token instead of OAuth.** 90 days, `*` on every app, no consent page, no audience. Rejected.
- **Mirror mode against a tunnel to the real Gateway.** Needs the Gateway's dev-only `/api/dev/identity` in production. Rejected.
- **A per-Gateway env var switch** (`LINKED_DEV_ENABLED`) instead of an organization setting. Needs a redeploy to flip and can't be seen in Manage workspace. The organization setting is chosen; on a one-team gateway it is the same thing.

## 9. Not in this version

A device name on the row; an admin revoking a member's linked dev; Manage workspace UI for the switch (CLI only first); the hosted tier's third-party (dispatch) apps; `everyapp dev token` minting production-shaped tokens; a Usage page split by source (the column is written, the page is a follow-up).

## 10. Proof

1. Unit and scoped tests: the e2e sqlite suite issues a dev grant, uses it on the endpoint, refuses it on `/mcp` and on the app host, refuses a member, a lost role, a revoked row, an organization with the switch off, and the rate limit; the CLI's forwarder strips headers and refuses browser requests; the SDK's shim rewrites the origin.
2. Local proof, no Cloudflare account: the Gateway from the checkout on `http://localhost:3000` (its `.dev.vars` holds an OpenRouter key), OpenZen registered on it, `everyapp dev --gateway http://localhost:3000` in `~/workspaces/open-notes/web` with an empty `.dev.vars`: the app's AI call answers through the local Gateway.
3. Live check: **not run** (Ben's rule, 2026-10-28). What it would be, for Ben to approve: a second onboarding test account (never everyapp.team, never Ben's login), `everyapp setup` from this branch, deploy OpenZen there, `workspace linked-dev on`, then the same local run against that Gateway; cost about the account's Workers Paid plus a few cents of OpenRouter; nothing created outside that account; teardown by the loop's own script.

## 11. As built (2026-10-28)

Where the code departs from the sections above, and what it pinned:

- **The resource list holds dev resources only for organizations with the switch on** (`readDevResources` joins `org_settings.linked_dev`), so a Gateway that didn't opt in answers `invalid_target` at authorize, as §6 promised; the route also 404s without the OAuth server and 401s any token once the switch goes off.
- **`whoami`** is a route of its own (`GET /linked-dev/<app>/whoami`), counted against the minute's budget but not the day's, answering the member, organization, role, app, connection and the limits; the CLI reads it before the app starts and every minute after.
- **The review's fixes (2026-10-28):** `--gateway` must be https, or http on this machine alone; every endpoint the Gateway's OAuth metadata names must be on the issuer's origin before the browser is opened or anything is posted; the loopback callback checks `state` before honouring an `error`; the forwarder buffers the request body and retries once only on the route's own `realm="every-app-linked-dev"` challenge, so a provider's 401 reaches the app as it is.
- **Local proof (2026-10-28):** the Gateway from this checkout on `http://localhost:3000` (with a fake `OPENAI_API_KEY`), OpenZen registered on it, `everyapp workspace linked-dev on` by hand in the local D1, `everyapp dev link --json` driven to the consent page with the owner's session, then `everyapp dev --mode linked --gateway http://localhost:3000` in `open-notes/web` with no `.dev.vars`: `/health` answered the real member, `POST /api/v1/meetings/<id>/transcription-token` went app → forwarder → Gateway (`linked_dev.call`, attributed to the member) → OpenAI with the Gateway's key (`ai.proxy.usage … status: 401`, no spend) and back to the app as "OpenAI answered 401"; the local audit log holds `connection.created` (kind dev) and `connection.used`; `everyapp dev unlink` revoked the row and the running app's next call was refused.
- **The daily audit event is deduplicated by a claimed key** in `rate_limit_counters` (`linked-dev:used:<connection>:<day>`), not by `last_used_at`: issuing the token is already a use (the library runs the exchange callback on the code grant too), so the row's timestamp can't tell the first call of a day.
- **Rate limits** are two D1 counters per call (minute, UTC day), 120 and 2,000, in `LINKED_DEV_LIMITS`.
- **Usage rows carry no `source` column** (TODO question 3): dev calls count as the app's, under the organization's caps, with the audit event and the per-call log line telling them apart. Built once Ben answers.
- **Mode selection**: `--gateway` with a host that isn't this machine selects `linked`; `--mode linked` says it; mirror keeps the loopback default. `dev link` and `dev unlink` sign in and out without running the app.
- **The CLI forgets a refused token** (a 401 from `whoami`, or `invalid_grant` at refresh) so the next run signs in again rather than retrying forever.
- **The consent page** reuses the native variant with its own copy ("wants to develop <app> as you … calls bill <workspace>'s providers … data stays on your computer"); Settings → Connections lists the row under "Apps on your devices" with "Linked dev" in place of the host.
- **Shared apps are out** (TODO question 5): `devGrantFor` offers only organizations that own the app, and the route refuses a shared row.
- Pinned: `apps/every-app-gateway/src/server/mcp-auth/linked-dev.e2e.sqlite.test.ts` (13 cases through the real worker entry), `packages/cli/src/commands/dev/linked.test.ts`, `index.test.ts` (a whole linked run with a fake Gateway), `packages/cli/src/lib/linkedDev/*.test.ts`, `packages/sdk/src/server/gatewayFetch.test.ts`, `packages/sdk/src/cloudflare/worker.test.ts`, `packages/cli/src/commands/workspace/index.test.ts`.
