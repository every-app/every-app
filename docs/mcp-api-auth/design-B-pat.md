I have what I need — grounded in the actual code, which materially sharpens this design. Notably, the `app_tokens` table, `hashAppToken`, `AppTokenRepository`, and an `/admin/tokens` reveal/revoke UI already exist as machine-token infrastructure, which both enables heavy reuse and makes the "don't recreate the deleted plane" tension concrete. Here is the design doc.

---

# Design: Gateway-issued scoped, revocable Personal Access Tokens (PAT model)

## 1. One-paragraph summary

A user creates named, scoped, revocable **Personal Access Tokens** (`epat_…`) in the gateway admin UI. External clients that support custom headers (Claude Code, Cursor, generic API/CI clients) send `Authorization: Bearer epat_…` to `https://<app>.<domain>/mcp` or `/api/*`. The **gateway** validates the token against a D1 table, resolves it to a **specific user + that user's org + per-app access**, and then mints the *exact same* short-lived (120s) fail-closed identity JWT the cookie path already mints — with `chan="mcp"` and `act={sub:"pat:<id>"}` — before proxying to the private app worker. The token **terminates at the gateway and never reaches the app**; the app keeps verifying `x-everyapp-identity` via the SDK and needs zero auth code. This is deliberately the 80/20 play: it unblocks three of the four target clients today with a subsystem that is ~one new table and one authenticator branch, and it is honestly *not* a spec-compliant OAuth surface, so **claude.ai connectors remain unsupported** (they need the OAuth/DCR/PKCE approach explored separately). The crucial discipline: a PAT authenticates a *user* and is exchanged for a per-request identity — it is the opposite of the app-held ambient machine token Wave 2 retired, and this design must not let it decay back into one.

## 2. End-to-end request/auth flow + token lifecycle

**Issue.** An authenticated org member opens `/admin/tokens` → "Create personal token". They pick: a name, an optional target app (or "all my apps"), an optional scope (`read` | `write`, advisory today), and an expiry (default 90 days). The server generates 32 bytes of CSPRNG entropy, formats `epat_<base62>`, computes `hashUserPat(token, BETTER_AUTH_SECRET)` (HMAC-SHA256, domain-separated context `every-app-gateway:user-pat:v1`), and inserts a row storing **only the hash + a display prefix** (`epat_a1b2…`), `userId`, `organizationId`, optional `appRowId`, `scopes`, `expiresAt`, `createdBy=userId`. The plaintext is shown **once** in the existing reveal modal and never persisted.

**Present.** The user configures their client once, e.g.
`claude mcp add myapp --transport http --header "Authorization: Bearer epat_…" https://myapp.acme.everyapp.host/mcp`
Every request carries `Authorization: Bearer epat_…`. No refresh, no discovery round-trip.

**Validate (per request, at the perimeter).**
1. Gateway resolves app from Host (unchanged, `gateway.ts:132`).
2. Gateway detects a **PAT bearer** early: `Authorization` present and value starts with `Bearer epat_`. This flags the request as *credentialed-non-cookie*, which (a) **exempts CSRF** (bearer auth is structurally immune to CSRF — there is no ambient cookie to ride) and (b) forces the authenticate step to run even on routes where a CSRF-failing request would otherwise downgrade.
3. The prod authenticator's `authenticate(request)` (which already receives the full request) checks for the PAT bearer *before* the Better Auth cookie path. It hashes the presented token, does one indexed lookup on `token_hash`, and rejects if: not found, `revoked_at` set, or `expires_at` past. On success it returns the standard `AuthenticatedSession {sub, email, orgId, orgRole}` — populated from the token's `userId`/`organizationId` (it does **not** call `resolveOrgContext`; a PAT binds its org at creation, so there is no `activeOrganizationId` ambiguity) — plus an optional `credential:{kind:"pat", tokenId, channel:"mcp", appRowId}` marker.
4. `hasAppAccess(session, app)` runs **unchanged** (`betterAuthAuthenticator.ts:41`): `session.orgId === app.organizationId` **and** a live `user_app_access` row. Additionally, if the PAT is app-scoped (`appRowId` set), the gateway requires `appRowId === app.id`. This means access is re-evaluated on **every** request — losing app access or org membership instantly invalidates the token's reach without touching the token row.
5. Gateway mints the identity JWT exactly as today (`gateway.ts:194`), passing `channel` and `act` through from the credential marker. The app receives `x-everyapp-identity` with `chan="mcp"`, `act={sub:"pat:<tokenId>"}`, `sub=<real userId>`, correct `org_id`/`org_role`, `aud=<appId>`, 120s TTL.
6. `touch last_used_at` is fired-and-forgotten (async, non-blocking) for anomaly detection, mirroring `AppTokenRepository.touchLastUsed`.

**Refresh.** None. PATs are long-lived-with-expiry like GitHub PATs. "Rotation" = create a new token, update the client, revoke the old one. This is a deliberate simplicity choice; no refresh-token machinery, no token endpoint.

**Revoke.** Owner or the creating user clicks revoke → `revoked_at = now`. Because validation reads the row on every request, revocation is effective within the token-cache TTL (see §7; **zero** cache in the POC → immediate). Expiry is enforced the same way. A future secret-scanning webhook can auto-revoke on `epat_` prefix match in public repos.

## 3. Gateway changes (concrete, with file refs)

**D1 — new table `user_access_tokens`** (new `db/user-tokens.schema.ts`, migration). I recommend a **separate table** from `app_tokens` (`apps.schema.ts:107`) rather than adding a `kind` column, precisely to keep principal semantics from bleeding (see §10/tension). Columns mirror the proven `app_tokens` shape but the **principal is a user, not a machine**:
`id, userId → users.id (cascade), organizationId → organizations.id (cascade), appRowId → apps.id nullable (cascade), tokenHash (unique idx), tokenPrefix (idx), scopes (default "[]"), createdAt, expiresAt, revokedAt (idx), lastUsedAt`. Unique index on `tokenHash`; composite FK `(appRowId, organizationId) → apps(id, organizationId)` reused from the app_tokens pattern.

**Reuse (not rebuild):**
- Hashing: clone `app-token-hash.ts` with a new domain-separation context (`user-pat:v1`) → `user-pat-hash.ts`. Same HMAC-SHA256/`BETTER_AUTH_SECRET` construction.
- Repository: new `UserPatRepository` mirroring `AppTokenRepository` (`findActiveByTokenHash`, `touchLastUsed`, `create`, `revoke`, `listForUser`).
- Admin UI: the `/admin/tokens` page (`routes/admin/tokens.tsx`), `CreateAppTokenModal`, `AppTokenRevealModal`, `AppTokensTable`, and `serverFunctions/appTokens.ts` already exist — extend with a "Personal tokens" section / a `tokenType:"user"` branch and `createUserPat`/`listUserPats`/`revokeUserPat` server functions. Personal tokens list only the caller's own; owners can list/revoke org-wide.

**Authenticator (`apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts`):** add a PAT branch at the top of `authenticate`:
```
const bearer = readPatBearer(request); // "Bearer epat_…"
if (bearer) return this.authenticatePat(bearer); // hash → UserPatRepository → AuthenticatedSession + credential marker
// else existing Better Auth cookie path (unchanged)
```
`hasAppAccess` gains the app-scope check (`pat.appRowId == null || pat.appRowId === app.id`).

**Perimeter core (`packages/perimeter/src/gateway.ts`) — three small, surgical edits:**
1. Compute `patBearer = hasPatBearer(request.headers)` right after app resolution.
2. CSRF gate (`gateway.ts:158`): change to `if (!csrf.allowed && !publicMatch.public && !patBearer) return 403`. And run `authenticate` whenever `csrf.allowed || patBearer` (widen the `gateway.ts:178` guard). PAT requests bypass CSRF; cookie requests are unchanged.
3. After building `outboundHeaders`, if `patBearer` was consumed, **unconditionally delete `Authorization` from the outbound request** (even on public routes). This is the one place PR #220's public-route forwarding must be overridden — see §10.

**Session shape (`packages/perimeter/src/session.ts`):** extend `AuthenticatedSession` with optional `credential?: { kind:"session"|"pat"; channel:"web"|"mcp"|"agent"; actor?:string }`. Gateway passes `channel`/`actor` into the existing `mintIdentityJwt` call (`gateway.ts:194-206`) instead of the hardcoded `channel:"web"`. Requires `mintIdentityJwt` to accept an `actor` override (protocol already carries `act` per brief §4 — a ~5-line plumbing addition if not already exposed).

Net gateway surface: 1 table + migration, 1 hash module, 1 repository, 1 authenticator branch, ~3 perimeter edits, admin UI extension. **No new routes** — `/mcp` and `/api/*` are just app paths that now authenticate via the token; no OAuth endpoints, no `/.well-known/*`.

## 4. App / SDK / manifest changes (near-zero)

**None required.** The app is a private worker that already verifies `x-everyapp-identity` via `everyApp()` / `getIdentityFromRequest` (`packages/sdk/src/server/everyApp.ts`). A PAT-authenticated request arrives as a normal minted identity — the app sees an `EveryAppUser {id, email, orgId, orgRole, channel:"mcp", actor:"pat:…"}`. The app's `/mcp` handler and `/api/*` handlers work unchanged.

Two optional niceties:
- The SDK's `EveryAppUser` already exposes `channel`/`actor` — apps that want to *behave differently* for token-driven access (e.g., disable destructive tools when `channel==="mcp"`) can branch on it. Purely opt-in.
- **`/mcp` and `/api/*` do NOT need to be declared `public` in the manifest.** This is a real advantage over the PR #220 public-route path: because the PAT mints a full identity JWT, these stay *private* routes and the app never rolls its own bearer auth. The manifest (`manifest.ts`) is untouched.

## 5. MCP-client compatibility matrix

| Client | Works out of the box? | User config |
|---|---|---|
| **claude.ai connectors** (web/Desktop/mobile) | **No.** The connector UI exposes only OAuth client id/secret (no static-bearer field; `anthropics/claude-ai-mcp#112`). It will attempt OAuth discovery — `WWW-Authenticate` / RFC 9728 metadata — which this design does not serve. | Not supportable with a PAT. Needs the OAuth-AS approach. This is the honest, headline limitation. |
| **Claude Code** | **Yes.** | `claude mcp add myapp --transport http --header "Authorization: Bearer epat_…" https://myapp.<domain>/mcp`. One command. |
| **Cursor** | **Yes.** | Add the server to MCP config JSON with a `headers: { "Authorization": "Bearer epat_…" }` map. |
| **Generic HTTP/API client / CI / SDK** | **Yes — the dominant path.** | Send `Authorization: Bearer epat_…` on requests to `/api/*` (or `/mcp`). No discovery, no dance. |

So: 3 of 4, plus the entire generic-API-client universe. The one gap is the highest-value consumer surface (claude.ai connectors), which is *why* this is framed as complementary to, not a replacement for, an OAuth surface.

## 6. Security analysis

**Threat model & blast radius.** A PAT is a **bearer credential that mints the real user's identity** for its scoped apps. A leaked `epat_` therefore grants an attacker the same reach as that user's interactive session *for the token's scope*, until revoked/expired. That is strictly *narrower* than a stolen session cookie only if the token is app-scoped and short-lived — so the design **defaults to a 90-day expiry and nudges app-scoping** in the create UI. Exposure surface is *higher* than a cookie (tokens sit in plaintext client configs, shell history, CI secrets), which is the core risk of any PAT model and must be stated plainly. Mitigations: distinctive `epat_` prefix for secret-scanning; `last_used_at` for anomaly detection; per-app scoping to shrink blast radius; `chan="mcp"`/`act={sub:"pat:<id>"}` so the app and audit log can always distinguish token-driven from interactive access and apply stricter policy.

**Revocation.** Immediate in the POC (per-request D1 read, no cache). App-access and org-membership revocation are *also* immediate and independent, because `hasAppAccess` re-runs every request against `user_app_access` — a revoked token and a revoked grant are both enforced continuously, not just at issue time.

**How each perimeter invariant is preserved:**
- *Default-private routing* — preserved and **strengthened**: `/mcp` and `/api/*` stay private; the token doesn't require widening the public surface. `assertPublicPathIsSafe`/`matchPublicRoute` untouched.
- *Fail-closed identity JWTs* — preserved verbatim: the PAT path mints the identical RS256, kid-pinned, `aud`-bound, 120s JWT via `mintIdentityJwt`. The app's `verifyPinnedJwt` (`identity.ts:154`) is unchanged and still rejects anything not gateway-signed.
- *Inbound trust-header stripping* — preserved and **extended**: `stripInboundHeaders` still deletes `cookie` and all `x-everyapp-*`; we add unconditional stripping of a consumed `epat_` `Authorization` so it never reaches the app (including on public routes). A client cannot forge identity.
- *Private app workers* — unchanged: proxying still goes through the `getAppFetcher` `APP__<workerName>` service binding; apps remain unreachable except via the gateway.
- *First-user signup lock* — unchanged: PAT creation requires an existing authenticated session in the admin UI, so tokens cannot bootstrap around invite-only signup.
- *CSRF* — the bearer exemption is safe: CSRF defends cookie-ambient auth; a bearer token is never auto-attached by a browser, so exempting it introduces no cross-site vector. Cookie requests keep the existing fail-closed CSRF behavior.

**Residual risks:** confused-deputy if an app-scoped PAT were honored for the wrong app (mitigated by the `appRowId === app.id` check); token substitution across orgs (mitigated by `session.orgId === app.organizationId`, same invariant as cookie path); and the inherent PAT-in-plaintext exposure noted above.

## 7. Hosted multi-tenancy

**Scales cleanly to many orgs.** The table is org-scoped (`organizationId` FK) exactly like `app_tokens`, and validation is a single indexed lookup on `token_hash` (globally unique) followed by the same org/app-access checks the cookie path already does. No per-app OAuth client registrations, no per-app authorization-server state — a PAT is pure gateway/control-plane state, which is the right side of the trust boundary for the ~100k-untrusted-apps future: **auth stays at the perimeter and never enters the tenant isolate.** On the dispatch tier, the PAT is validated on the public gateway before `dispatcher.get(...)`; the minted JWT becomes tenant-scoped (`aud=t_<tenant>_<app>`) with no change to the PAT mechanism.

**What accumulates / per-request cost.** Two things to watch: (a) token rows accumulate per user — bounded by mandatory expiry plus a periodic sweep of `revoked_at`/`expires_at` rows; (b) a D1 read per API/MCP request. The per-request read is fine at POC scale (the legacy AI proxy already does exactly this), but at 100k-apps throughput it becomes a hot path. Mitigation when needed: a short-TTL (e.g. 10–30s) cache keyed by `token_hash` in KV or a Durable Object, with revoke writing an invalidating tombstone — matching the existing 30s org-context/registry cache tolerance for revocation lag. This is a later optimization, explicitly out of POC scope.

**Per-org vs per-gateway:** all state is per-org rows in one gateway D1 (self-host) / one control-plane D1 (hosted). Nothing is per-gateway-global except the HMAC secret (`BETTER_AUTH_SECRET`), already the case.

## 8. Effort estimate

**Size: S–M.** The unusual leverage here is that ~60% of the machinery already exists as machine-token infra. Rough LOC:
- Migration + `user_access_tokens.schema.ts`: ~60
- `user-pat-hash.ts` + `UserPatRepository`: ~120
- Authenticator PAT branch + app-scope check: ~80
- Perimeter edits (CSRF exempt, header strip, channel/actor passthrough) + `mintIdentityJwt` actor plumbing: ~60
- Admin UI extension + server functions (largely reusing existing modals/table): ~200
- Tests (perimeter unit, authenticator, e2e proxy): ~250
**Total ≈ 650–800 LOC.** Net-new subsystems: **one** (user PAT issuance/validation). **Zero** new protocols, zero new routes, zero OAuth surface.

## 9. Failure modes / what could go wrong

- **claude.ai connectors silently don't work** — users may expect them to; the create-token UI must say "for Claude Code / Cursor / API clients; claude.ai connectors need the OAuth connector (coming separately)".
- **Plaintext token sprawl** — the model's inherent weakness; leaked tokens = user-level access until revoked. Countered by expiry defaults, app-scoping, prefix scanning, `last_used_at` monitoring.
- **Prefix collision / passthrough confusion** — a legit non-Every-App bearer that an app *wants* forwarded (PR #220) must not start with `epat_`; the reserved prefix makes this deterministic, but it must be documented and enforced (reject app manifests/tokens that collide is unnecessary since `epat_` is gateway-minted only).
- **Org binding staleness** — a PAT binds its org at creation; if a user is removed from that org, `hasAppAccess`'s `orgId` check fails closed (good), but the token row lingers until expiry/sweep. Acceptable; the token is inert.
- **Revocation lag once caching is added** — the future KV/DO cache introduces up-to-TTL lag; must be bounded and documented, matching existing 30s caches.
- **`mintIdentityJwt` actor plumbing** — if the current mint path doesn't yet accept an `actor`, `chan="mcp"`/`act` won't populate and audit loses the token distinction; small but must be verified against `protocol.ts:167`.
- **DoS via bad tokens** — each invalid `epat_` still costs an HMAC + a D1 miss; rate-limit unauthenticated bearer attempts at the perimeter.

## 10. Composition with the just-merged Wave 2 primitives

**The crucial tension — why a user-facing PAT is a different animal than the retired `eat_`/`x-every-app-token` plane.** Wave 2 moved app→gateway calls onto **service bindings** and marked the long-lived app-token AI proxy *legacy* (`ai-proxy-token-policy.ts:1`) because an **app holding a long-lived, ambient-authority token that *is* the app's identity** contradicts the perimeter model: the credential outlives requests, grants standing capability, and the app is the principal. A PAT inverts every one of those properties:

| Retired app-token (`x-every-app-token`) | This PAT (`epat_`) |
|---|---|
| Principal = an **app/machine** | Principal = a **specific user** |
| Held by the **app**, used to call **out** through the gateway (egress capability) | Held by a **user's external client**, used to reach an app (ingress) |
| Ambient standing authority; the token *is* the access | Exchanged per-request for a **120s identity JWT**; the token is never authority the app sees |
| Reaches app/provider surface | **Terminates at the gateway**; app only sees the minted identity |
| `createdBy` is audit metadata | `userId` is the acting principal, re-checked against `user_app_access` every request |

**The hard rule that keeps them from re-merging:** the PAT must never grant egress/provider scope, and must never be forwarded to the app. It lives in its own table with user-principal semantics, its own `epat_` namespace, and is always gateway-consumed. If it ever gained a `provider:*` scope or got passed through to an app, it would become the thing Wave 2 deleted.

**Composition with the three primitives:**
- **AppGateway service binding + props (`getAppFetcher` `APP__<workerName>`):** orthogonal and unchanged. PAT is purely ingress auth; after minting the identity JWT it proxies through the exact same `getAppFetcher` seam as the cookie path. The (aspirational, per brief §3) props/entrypoint work is unaffected.
- **Provider allowlist (legacy AI proxy):** kept strictly separate. The PAT plane grants no provider scope and does not touch egress. The two never share a credential or a scope namespace.
- **Public-route `Authorization` forwarding (PR #220):** this is the one genuine interaction, resolved by **prefix namespacing**. PR #220 forwards inbound `Authorization` to the app on public routes so apps can run their own bearer auth. This design **reserves the `epat_` prefix**: when `Authorization` is a recognized Every-App PAT, the gateway *consumes and strips it on every route, including public ones* (the §3 edit #3). Any *non-*`epat_` `Authorization` retains PR #220's exact passthrough behavior. The two coexist without ambiguity: `epat_` = gateway-terminated Every-App identity; everything else = app's own credential, forwarded on public routes only.