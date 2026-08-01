# Every App v2 — Auth Design Exploration: Session-Derived Short-Lived Tokens

*Approach: "the cookie workaround, done right." Formalize browser-session → bearer credential. Ships TODAY for Claude Code / Cursor / generic HTTP; explicitly a bridge to the OAuth end-state, not a replacement for it.*

*Basis: current-state brief @ `e235a0f`. Where the brief and the task spec disagree (the non-existent `AppGateway` WorkerEntrypoint, §3), I build on what's actually in the code.*

---

## 1. One-paragraph summary

Add one gateway-owned credential type: an **Every App access token (`eak_…`)** — an opaque, app-scoped, user-scoped, org-scoped, expiring bearer token that a logged-in org member mints from the gateway dashboard for a specific app. The perimeter learns to **terminate** this token: when a request arrives with `Authorization: Bearer eak_…`, the gateway validates it against a D1 table, re-checks live entitlement (`user_app_access`), and then runs the *exact same downstream path it already runs for a cookie session* — access check, mint a fresh 120 s identity JWT, inject `x-everyapp-identity`, strip the inbound credential, proxy to the private app worker. The app sees nothing new: just an identity JWT, same as a browser user. This unlocks today's private `/mcp` and `/api/*` routes for Claude Code, Cursor, and generic HTTP clients with a paste-one-header setup, with per-app blast radius that is *tighter* than the cross-subdomain session cookie it replaces. It does **not** serve claude.ai connectors (they require full OAuth 2.1 + RFC 9728, which this does not provide) — that is the honest boundary and the reason this is framed as the bridge, not the destination.

---

## 2. End-to-end request/auth flow

### Credential lifecycle

**Issue.** Logged-in org member opens the gateway dashboard → app detail → "Access tokens" → "Create token" (name, optional TTL). The gateway server handler:
1. Runs the existing cookie authenticator + `resolveOrgContext` (this is a state-changing POST under cookie auth, so the existing `evaluateCsrf` in the dashboard applies — `csrf.ts:25`).
2. Calls `hasAppAccess(session, app)` (`betterAuthAuthenticator.ts:41`) — you can only mint a token for an app you can already reach in the browser.
3. Generates `secret = base64url(random(32 bytes))` and a short public `tokenId`. Plaintext token shown **once**: `eak_<tokenId>_<secret>`.
4. Stores a row: `id, tokenId, secret_hash = HMAC-SHA256(secret, BETTER_AUTH_SECRET), org_id, app_id, user_id, name, created_at, expires_at, revoked_at NULL, last_used_at NULL`. (Hashing with `BETTER_AUTH_SECRET` mirrors the legacy `app_tokens` pattern in `ai-gateway-auth.ts:13`.)

**Present.** Client sends `Authorization: Bearer eak_<tokenId>_<secret>` on every request to `https://<app>.<domain>/mcp` or `/api/*`. No cookie, no CSRF token.

**Validate (per request, at the perimeter).** New step in `handleGatewayRequest`, *before* the cookie authenticator:
- If `Authorization` is absent or does **not** start with `eak_` → skip entirely, fall through to today's cookie path (and today's #220 public-route forwarding). This is the clean split from app-owned bearer tokens.
- If it starts with `eak_`: parse `tokenId`, D1 lookup by `tokenId`, constant-time compare `HMAC(secret)` vs `secret_hash`, check `revoked_at IS NULL`, `expires_at > now`, and **`app_id === resolvedApp.appId`** (a token for app A presented to app B fails closed). Re-check `user_app_access` for `(user_id, app_id)` — live entitlement, so removing a user from an app kills their tokens' effect within cache TTL. On success, synthesize an `AuthenticatedSession {sub, email, orgId, orgRole}` (`session.ts:11`) from the token's `user_id`/`org_id` (email/role resolved via the same org-context lookup or denormalized onto the row at mint time).

**Downstream — unchanged.** The synthesized session flows into the existing `hasAppAccess` → `mintIdentityJwt` path (`gateway.ts:189-207`). The minted JWT carries `chan` and `act` (already in the protocol, `protocol.ts:78`): perimeter sets `chan="mcp"` when the matched route is the app's MCP endpoint, else `chan="agent"`; `act={sub:"token:<tokenId>"}`. This is finally what populates the `mcp`/`agent` channels the protocol was built for.

**Outbound credential handling.** The `eak_` token is **terminated, never forwarded**. `stripInboundHeaders` already deletes `authorization` unconditionally (`headers.ts:23`). The one change: the #220 "re-add Authorization on public routes" branch (`headers.ts:41-44`) must **skip re-adding when the token is an `eak_` token**. So an `eak_` token never reaches the app, on public *or* private routes — "no token passthrough" (§6 of brief) holds.

**Refresh.** None. Opaque tokens with a bounded TTL; the user re-mints (or we offer one-click rotate → new secret, same row id). No refresh-token machinery — deliberately minimal for the POC.

**Revoke.** `UPDATE … SET revoked_at = now` (or delete). Dashboard lists a user's tokens with `last_used_at`; owner/admin can revoke any token in their org. Propagation is bounded by the per-isolate validation cache (30–60 s, matching the existing registry/org caches, `orgContext.ts` / `registry.ts`).

### Request diagram

```
Claude Code / Cursor / curl
        │  Authorization: Bearer eak_<id>_<secret>
        ▼
[Public Gateway Worker] handleGatewayRequest (gateway.ts:122)
  1. parseHost → resolveApp                         (unchanged)
  2. matchPublicRoute                               (unchanged)
  3. NEW: eak_ token? → validate in D1 + entitlement → AuthenticatedSession
         │ (if valid: skip cookie authenticate, skip CSRF downgrade)
  4. CSRF / cookie authenticate                     (only if no eak_ token)
  5. hasAppAccess                                   (unchanged)
  6. mintIdentityJwt → x-everyapp-identity          (unchanged; chan=mcp/agent)
  7. prepareOutboundHeaders: strip cookie + all x-everyapp-* + eak_ token
  8. getAppFetcher(env, app).fetch()                (unchanged)
        ▼
[Private App Worker]  reads x-everyapp-identity via SDK  (zero change)
```

---

## 3. Gateway changes (concrete)

**D1 — one new table** (single table on the one multi-tenant gateway; org-scoped rows):
```sql
CREATE TABLE app_access_tokens (
  id           TEXT PRIMARY KEY,
  token_id     TEXT NOT NULL UNIQUE,        -- public lookup handle in eak_<token_id>_<secret>
  secret_hash  TEXT NOT NULL,               -- HMAC-SHA256(secret, BETTER_AUTH_SECRET)
  org_id       TEXT NOT NULL,
  app_id       TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX idx_aat_lookup ON app_access_tokens(token_id);
CREATE INDEX idx_aat_owner  ON app_access_tokens(org_id, app_id, user_id);
```
Model + indexing mirror `user_app_access` and `RegisteredApp` (`registry.ts:14`).

**New module** `packages/perimeter/src/appTokens.ts`: `parseEveryAppToken(header) → {tokenId,secret}|null`, `validateEveryAppToken(deps, app, secret) → AuthenticatedSession|null` (D1 read + HMAC compare + expiry/revoke/app-scope + `user_app_access` recheck), plus a per-isolate cache keyed by `secret_hash` with 30–60 s TTL. Reuse the HMAC helper from `ai-gateway-auth.ts`.

**Perimeter change** `packages/perimeter/src/gateway.ts`: insert the token step between `matchPublicRoute` (`:142`) and `evaluateCsrf` (`:152`). If a valid token yields a session, set a `viaBearer` flag → skip CSRF (no ambient cookie ⇒ no CSRF vector) and skip the cookie `authenticate` call. Everything from `hasAppAccess` onward is untouched.

**Perimeter change** `packages/perimeter/src/headers.ts`: `prepareOutboundHeaders` gains awareness that an `eak_`-prefixed `Authorization` must **never** be re-added (guard the #220 branch at `:41-44`). Non-`eak_` Authorization still forwards on public routes exactly as #220 does.

**New gateway routes** (dashboard-authenticated, under the reserved `/__everyapp` prefix so they can never be shadowed by an app public route — `manifest.ts` `EVERYAPP_INTERNAL_PREFIX`):
- `POST /__everyapp/apps/:appId/tokens` — mint (returns plaintext once).
- `GET /__everyapp/apps/:appId/tokens` — list (metadata only, never the secret).
- `DELETE /__everyapp/apps/:appId/tokens/:id` — revoke.
- Small dashboard UI panel on the app detail page.

**Cron** (Cloudflare scheduled): nightly `DELETE FROM app_access_tokens WHERE expires_at < now OR revoked_at IS NOT NULL` — bounds table growth (§7).

**No change** to: identity protocol (`protocol.ts`), verification (`identity.ts`), `getAppFetcher`, manifest schema, public-route matching, or the legacy AI proxy.

---

## 4. App / SDK / manifest changes (near-zero)

**App author: zero required changes.** An app that already reads identity via the SDK `everyApp()` wrapper (`packages/sdk/src/server/everyApp.ts`) works unchanged. To make `/mcp` and `/api/*` reachable by token, the app keeps them **private** (the default) — the token unlocks private routes by producing a real session. The app never sees the token, only `x-everyapp-identity`.

**SDK: zero required, one optional.** `EveryAppUser` already exposes `channel` and `actor` (`protocol.ts:97`). An app that wants to treat programmatic callers differently (e.g. deny destructive tools when `channel !== "web"`) reads existing fields — no SDK API change. Optionally add a convenience `user.isProgrammatic = channel !== "web"`.

**Manifest: zero required.** No new manifest key. (Optional future hardening: a `tokenAuth: false` opt-out per route if an app wants a route reachable only by live browser sessions — not needed for the POC.)

This is the approach's strongest property: **the entire mechanism lives in the gateway/perimeter. App authors do nothing.**

---

## 5. MCP-client compatibility matrix

| Client | Works out of the box? | User config |
|---|---|---|
| **claude.ai connectors** (web/Desktop/mobile) | **No.** The custom-connector UI exposes only OAuth client id/secret — no static-bearer field (brief §7, `claude-ai-mcp#112`). A gateway-minted `eak_` token cannot be attached. Requires the OAuth end-state (RFC 9728 challenge + auth server + PKCE + consent), which this approach deliberately does not build. | — (blocked; see §10 / end-state) |
| **Claude Code** | **Yes.** Supports arbitrary headers on Streamable HTTP. | `claude mcp add <name> --transport http --header "Authorization: Bearer eak_…" https://<app>.<domain>/mcp` |
| **Cursor** | **Yes.** `headers` map in the MCP server JSON config. | `{"url":"https://<app>.<domain>/mcp","headers":{"Authorization":"Bearer eak_…"}}` |
| **Generic HTTP / API client / CI / SDK** | **Yes.** Plain bearer against `/api/*` and `/mcp`. | `Authorization: Bearer eak_…` |

Honest headline: **3 of 4 work today; claude.ai connectors do not.** That single gap is the reason to keep this scoped as a bridge and to prioritize the OAuth authorization-server surface (§6 of brief) for connector parity.

---

## 6. Security analysis

**Threat model & blast radius.** An `eak_` token is bound to `(user, app, org)`. Compromise lets the attacker act as that one user in that one app until expiry or revoke. This is **narrower than the artifact it replaces**: the Better Auth session cookie is `Domain=<gateway host>` cross-subdomain (`auth/config.ts:169-173`), i.e. valid for *every* app in the org. The "paste your cookie into Claude Code" workaround today leaks an org-wide, browser-grade credential; an `eak_` token leaks one app's worth of one user's access. Strictly better.

**Credential exposure.** Plaintext shown once, stored only as `HMAC(secret, BETTER_AUTH_SECRET)`; 256-bit secret ⇒ guessing infeasible; lookup by `token_id` then constant-time hash compare (no timing oracle); transport is TLS-only (HSTS already set, `headers.ts:106`). At rest on the client it is exactly as exposed as any API key in a Claude Code / Cursor config file — the accepted norm for these clients.

**Revocation.** D1 flag, dashboard-driven, bounded by the 30–60 s validation cache — same staleness envelope as the existing registry/org caches, so no new consistency model to reason about.

**Perimeter invariants — each preserved:**
- *Default-private routing:* unchanged. The token produces a session; routing/`matchPublicRoute` logic is untouched. Private stays private; the token is just another way to prove entitlement.
- *Fail-closed identity JWTs:* unchanged. Still minted per-request, RS256, `aud=appId`, 120 s TTL, verified by the SDK with kid-pinning (`identity.ts:154`). The token path feeds the *same* minting call.
- *Inbound trust-header stripping:* strengthened. `x-everyapp-*` still stripped (`headers.ts:23`); the `eak_` token is additionally terminated and never forwarded (public or private). No new trust header is introduced — the token is validated *by* the gateway, not *trusted from* the client to the app.
- *Private app workers:* unchanged. Still reachable only via `getAppFetcher`'s `APP__` service binding (`getAppFetcher.ts:38`).
- *First-user signup lock:* unchanged. Tokens are only mintable *through* an authenticated Better Auth session that already passed invite-only signup. No token can bootstrap access a browser session couldn't.

**New attack surface (named honestly):**
- The mint endpoint — a state-changing POST; protected by the existing cookie auth + CSRF (`csrf.ts`). No new auth surface, reuses the dashboard's.
- The token table — one D1 read on the hot path; indexed; cached.
- Prefix confusion with app-owned bearer tokens (post-#220): mitigated by the reserved, namespaced `eak_` prefix and the terminate-not-forward rule. Documented edge case: if an app runs its *own* bearer auth on a *public* route and a user mistakenly presents an `eak_` token, the app sees no Authorization (we terminated it) → app-auth fails cleanly rather than leaking.
- **Session-derived but standalone:** revoking the user's *browser* session does **not** auto-revoke their tokens (they're independent rows). This can surprise. Mitigation: (a) dashboard lists all tokens with last-used, (b) removing the user from the app via `user_app_access` *does* kill token effect (live recheck), (c) optional "session-bound" token mode (store the originating session id, invalidate on session revoke) — deferred, more complex, not in the POC.

---

## 7. Hosted multi-tenancy

**Scales to many orgs; scales to ~100k apps.** State is a single `app_access_tokens` table on the one multi-tenant gateway, org- and app-scoped by column (same shape as `user_app_access` / the app registry). Rows are **sparse**: only `(user, app)` pairs where someone actually minted a token, not one-per-app. Even generous adoption is thousands–low-millions of rows — trivial for D1 with the two indexes.

**Per-gateway vs per-org.** All state is per-gateway (single D1), partitioned logically by `org_id`/`app_id`. No per-org infrastructure. Validation is one indexed read + HMAC, cached 30–60 s per token per isolate — the same cost class as the existing registry/org lookups already on every request.

**What accumulates (and the fix):**
- Expired/revoked rows → nightly cron GC (§3). Bounded.
- `last_used_at` write amplification: naively, one D1 write per authenticated request. **Mitigation:** update `last_used_at` at most once/hour per token (compare-and-skip in the isolate cache), or drop it from the hot path and derive freshness from request logs. This is the one real scaling watch-item; call it out explicitly.

**Dispatch / Workers-for-Platforms future.** No blocker. The token carries `app_id`; when internal JWT audiences become tenant-scoped (`aud = t_<tenant>_<app>`, brief §5), the mint step and validation use the same `(org, app, user)` tuple — only the audience string the perimeter passes to `mintIdentityJwt` changes, which is a gateway-side concern already anticipated by `getAppFetcher`'s `tier:"dispatch"` seam.

---

## 8. Effort estimate

**Size: M (borderline S).** No new protocol, no new crypto, no OAuth state machine — it reuses the identity minting path wholesale.

| Component | LOC (rough) | Net-new? |
|---|---|---|
| D1 migration + `app_access_tokens` | ~30 | new table |
| `appTokens.ts` (parse/validate/cache) | ~150 | new module |
| `gateway.ts` token step + `viaBearer` wiring | ~40 | edit |
| `headers.ts` `eak_` terminate guard | ~15 | edit |
| Mint/list/revoke routes | ~120 | new routes |
| Dashboard UI panel | ~150 | new UI |
| Cron GC | ~20 | new |
| Tests | ~200 | new |
| **Total** | **~700 LOC** | **1 net-new subsystem (the token store)** |

No new dependencies (no `workers-oauth-provider`, no OAuth server). Everything sits in `packages/perimeter` + the gateway app.

---

## 9. Failure modes / what could go wrong

1. **claude.ai connectors stay unsupported** — the biggest gap; users who expect to add an Every App MCP as a claude.ai connector cannot. Must be documented loudly and paired with a committed OAuth follow-up, or it reads as a dead end.
2. **`last_used_at` write amplification** at high request rates — throttle or drop (§7).
3. **Token sprawl** — 30-day tokens treated as permanent; orgs accumulate stale credentials. Mitigate with expiry + a dashboard that surfaces unused tokens and lets admins bulk-revoke.
4. **Session-revoke ≠ token-revoke surprise** (§6) — an offboarded user's tokens keep working until `user_app_access` is removed or the token expires. The `user_app_access` live recheck is the real backstop; make offboarding remove the access row, not just the session.
5. **Prefix/policy collision with app-owned bearer auth on public routes** — an app expecting its *own* token on a public route won't receive an `eak_` token (terminated). Document that `eak_` is gateway-reserved and always terminated.
6. **Cache staleness on revoke** — up to 60 s window where a revoked token still works. Acceptable and consistent with existing caches; for high-stakes revoke, offer a cache-bust (bump a per-org token-generation counter).
7. **Channel heuristic imprecision** — inferring `chan="mcp"` from the route path is a guess; a mislabeled channel weakens per-channel policy an app might build. Prefer letting the *token* record an intended channel at mint time over path-sniffing if apps start relying on `channel`.
8. **`BETTER_AUTH_SECRET` rotation** invalidates all token hashes at once (they're HMAC'd with it). Same coupling the legacy `app_tokens` already has; document that secret rotation forces token re-mint, or store a per-token salt.

---

## 10. Composition with the just-merged Wave 2 primitives

The task lists "AppGateway service binding + props, provider allowlist, public-route Authorization forwarding." Per the brief §3, the **`AppGateway` `WorkerEntrypoint` with deploy-time props `{organizationId, appId, workerName}` does not exist in `main`** — that triple is the `RegisteredApp` D1 row shape (`registry.ts:14`), and the real gateway→app seam is `getAppFetcher`'s `APP__<workerName>` service binding (`getAppFetcher.ts:38`). I compose with what actually shipped:

- **`getAppFetcher` / `APP__` service binding (gateway→app):** untouched. Token validation and identity minting complete *before* the proxy call; `getAppFetcher(env, app).fetch()` (`gateway.ts:226`) receives a request that already carries `x-everyapp-identity` and no `eak_` token. The binding never learns tokens exist. When `tier:"dispatch"` lands, the token path needs no change — it terminates upstream of the fetcher.

- **Public-route `Authorization` forwarding (PR #220, `headers.ts:41-44`):** this is the primitive that most directly interacts, and the composition is a **clean prefix split**. `eak_` tokens → terminated (never forwarded), on public *and* private routes. Non-`eak_` `Authorization` → forwarded verbatim on public routes exactly as #220 does, so an app's own bearer auth is unaffected. One credential space, two disjoint namespaces, one guard.

- **Provider allowlist / scopes (legacy AI proxy — `app-token-scopes.ts:42`, `hasProviderScope`):** the token store deliberately mirrors that table's shape, so the *scope* concept is a natural forward extension. Today `eak_` tokens are unscoped (full app-user access). Later they can carry `scopes` (`tool:read`, `tool:write`, or per-route scopes) enforced at the perimeter — the same pattern the AI proxy uses for `provider:<name>`, and the same place the doc's ToolBus risk-classification (brief §6) would hook in. Building the token store now lays the row/scope groundwork the OAuth end-state reuses.

**Bridge framing.** The identity protocol already carries `chan`/`act` for `mcp`/`agent` precisely because the roadmap expects a token-terminating MCP surface (brief §4/§6). This approach populates those fields *today* with the minimum machinery, using the existing minting path — and leaves the OAuth authorization-server surface (RFC 9728 challenge, PKCE, DCR/CIMD, consent) as an additive layer that, when built, mints the *same* internal identity JWTs. Nothing here is thrown away when OAuth lands; the token store becomes the credential backend the OAuth grant writes into.