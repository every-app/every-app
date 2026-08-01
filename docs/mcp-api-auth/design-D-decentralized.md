# Every App v2 — Auth Exposure Design: **Decentralized (public routes + gateway-issued, app-verified tokens)**

*Approach owner's note up front, because the constraint demands honesty: a **pure** decentralized model — "gateway forwards `Authorization`, each app validates however it likes" — does **not** satisfy "the gateway handles authentication." It relocates auth into every app and quietly re-opens the exact hole PR #220's forwarding created. The only version of this approach worth shipping is a **narrow hybrid**: the gateway remains the sole **issuer, consent authority, and revocation authority** (centralized), but stays **off the request hot path** — the app's SDK does **local, cryptographic verification** of a gateway-signed token that arrives via the already-merged public-route `Authorization` forwarding. That is the design below. Where it is weaker than a token-terminating gateway, I say so.*

---

## 1. One-paragraph summary

The gateway becomes a **credential authority but not a request-path validator**. It exposes an issuance surface (a dashboard "API keys" flow and, for spec-compliant MCP clients, a small OAuth 2.1 authorization server) that mints **Every App Tokens (EATs)** — short-lived, audience-bound, gateway-signed **RS256 JWTs** reusing the existing identity keypair and key-distribution channel (§4 of the brief). The app author declares `/mcp` and `/api/*` as **public manifest routes**, which — post-PR #220 — causes the gateway to **forward the client's `Authorization: Bearer <EAT>` untouched** while still stripping `cookie` and every `x-everyapp-*` trust header. A first-class **SDK auth toolkit** verifies the EAT **locally** against the gateway's public keys (no per-request gateway round-trip), maps its claims to the same `EveryAppUser` object app code already gets from `x-everyapp-identity`, and — critically — **fails closed by default** so a route declared public but not explicitly opted into anonymous access returns `401` rather than serving unauthenticated. The gateway "handles auth" in the senses that matter (issuance, user consent, org binding, scoping, revocation, key rotation); the app only runs a verify call it cannot get wrong because the SDK owns it. The cost, paid honestly: verification is local, so **revocation is TTL-bounded**, and the security of a public route now depends on the SDK guard actually running in the app worker.

---

## 2. End-to-end request/auth flow + credential lifecycle

### 2a. The credential: Every App Token (EAT)

An EAT is a gateway-signed JWT, **same alg/keys/kid infrastructure as the identity JWT** (`packages/sdk/src/internal/protocol.ts`, `identity.ts`), so no new crypto and no new key distribution is needed. Claims:

```
{ typ:"eat", sub:<user-id | "client:"+client_id>, email?, org_id, org_role?,
  chan:"mcp"|"agent"|"api", act:{sub:"mcp:<client_id>"|"apikey:<key_id>"},
  scope:"app:read app:write mcp:tools", aud:<app-id>, iss:<gateway-url>,
  jti:<uuid>, iat, exp }
```

Two flavors, both signed, both locally verifiable:

| | **Access EAT** (OAuth path) | **API-key EAT** (static path) |
|---|---|---|
| TTL | 10 min | 24 h (re-minted by a background refresh, or long-lived opaque → see §9) |
| Refresh | opaque refresh token, stored & revocable in D1 | none (static) — client re-fetches from dashboard, or key rotates |
| For | claude.ai connectors, Claude Code OAuth login | Claude Code `--header`, Cursor `headers`, curl/CI |

### 2b. Issuance lifecycle

- **API-key EAT:** org member opens the app's page in the dashboard → "Create API key" → gateway authenticates them via the **existing Better Auth session** (`betterAuthAuthenticator.ts:23`), checks `hasAppAccess` (`gateway.ts:189`), writes a row to `app_credentials` (D1), and returns the token **once**. The token is either (a) a signed EAT with a long TTL, or (b) an opaque `eak_...` secret hashed into D1 (reusing the legacy `app_tokens` hashing precedent, `ai-gateway-auth.ts:13`) that the SDK introspects — see §9 for the trade-off and my recommendation.
- **Access EAT (OAuth):** MCP client hits the gateway's OAuth authorization server. Consent is the **Better Auth login + an approval screen** ("Claude wants to access <app> as <you> with scopes X"). On approval the gateway issues an authorization code (KV, 60 s), the client redeems it at `/oauth/token` with PKCE, and receives an access EAT + refresh token. **No `client_credentials` grant** — every grant is a real user consenting (matches the claude.ai constraint in brief §7).

### 2c. Request path (client → gateway → app)

1. Client sends `GET https://<app>.<domain>/mcp` with `Authorization: Bearer <EAT>`.
2. `handleGatewayRequest` (`gateway.ts:122`) resolves the app, then `matchPublicRoute(app.manifest.public, "POST", "/mcp")` (`gateway.ts:142`) — **matches**, because the author declared `/mcp` public.
3. CSRF: for a `POST` with no `Origin`/`Sec-Fetch-Site` (typical API client), `evaluateCsrf` fails → but on a **public** route this only **downgrades to anonymous** (`gateway.ts:178` guard), it does not reject. Good — programmatic path stays open.
4. Session lookup finds no cookie (API client) → anonymous. No `x-everyapp-identity` minted.
5. `prepareOutboundHeaders(request.headers, publicMatch.public=true)` (`gateway.ts:167`, `headers.ts:36`) strips `cookie` + all `x-everyapp-*`, then **re-adds the inbound `Authorization` verbatim** (PR #220, `headers.ts:41-44`). The EAT reaches the app.
6. Gateway proxies via `getAppFetcher(env, app).fetch()` (`getAppFetcher.ts:38`) over the `APP__<workerName>` service binding.
7. **In the app worker**, the SDK toolkit runs: read `Authorization`, `verifyEat(token, { audience: EVERYAPP_APP_ID, keys: EVERYAPP_IDENTITY_PUBLIC_KEYS })` — the **same `verifyPinnedJwt` machinery** as `identity.ts:154` (alg-pinned RS256, kid-allowlisted, audience-bound, fail-closed), with `typ:"eat"` and a revocation-jti check. On success it yields the `EveryAppUser`; on failure/absence it returns `401` **with a `WWW-Authenticate: Bearer resource_metadata=…` challenge** (RFC 9728) so MCP clients can discover the OAuth AS.

### 2d. Validate / refresh / revoke

- **Validate:** entirely local in the app (no gateway call). Signature + `aud` + `exp` + `typ` + jti-not-revoked.
- **Refresh:** access EAT expires in 10 min; client presents refresh token to `/oauth/token` (gateway round-trip, revocable). Refresh token rotates.
- **Revoke:** user deletes an API key or revokes an OAuth grant in the dashboard → gateway (a) deletes/marks the D1 row, (b) adds `jti` (or a key-id predicate) to a **revocation list served alongside the public keys** at `routes/api/deploy/identity-keys.ts`. Apps already fetch keys from there; the SDK caches the revocation list for 60 s (same order as the 30 s org cache, `orgContext.ts`). Effect: revocation is **bounded by TTL + 60 s cache**, not instant. This is the central honesty cost of local verification.

---

## 3. Gateway changes (concrete)

**Perimeter — near zero.** The forwarding this design needs already merged (PR #220). The only perimeter-adjacent change:

- **Nothing required in `gateway.ts`/`headers.ts`/`publicRoutes.ts`.** The design deliberately rides existing seams. (Optional hardening in §6: an allow-list so only `mcp`/`api`-typed public routes get `Authorization` forwarded, if you don't want it on *every* public route.)

**New routes on the gateway Worker (`apps/every-app-gateway/src/routes/...`):**

- `api/keys/*` — CRUD for API-key EATs (session-authenticated, org-scoped). Mirrors the legacy `app_tokens` issuance shape but org/user-scoped, not app-secret-scoped.
- **OAuth AS surface (for claude.ai connectors):**
  - `/.well-known/oauth-authorization-server` (RFC 8414 metadata)
  - `/oauth/register` (DCR, RFC 7591) **and/or** CIMD acceptance (brief §7: CIMD now preferred)
  - `/oauth/authorize` (consent UI, reuses Better Auth session + `hasAppAccess`)
  - `/oauth/token` (code+PKCE exchange, refresh)
- Extend `routes/api/deploy/identity-keys.ts` to also serve the **revocation list** (`{ revoked_jti: [...], revoked_before: <ts-per-key-id> }`).

**New D1 tables:**

```sql
app_credentials(       -- issued API keys / OAuth grants
  id, org_id, app_id, kind('api'|'oauth'),
  subject_user_id?, oauth_client_id?, scopes,
  hashed_secret?,      -- only for opaque path
  created_at, expires_at, last_used_at, revoked_at)

oauth_clients(         -- DCR/CIMD registrations
  client_id, org_id?, redirect_uris, name, client_uri, created_at)

revoked_jti(jti, app_id, expires_at)   -- pruned at exp
```

OAuth authorization codes + PKCE challenges live in **KV** (60 s TTL), not D1.

**New service:** a small `credentials` module (mint EAT via existing `mintIdentityJwt` path with `typ:"eat"` and configurable TTL; hash/verify opaque keys reusing `ai-gateway-auth.ts` hashing; scope model reusing `app-token-scopes.ts:42` `hasProviderScope`→`hasScope`).

**Reuses (not rebuilds):** identity keypair + `mintIdentityJwt`/`verifyPinnedJwt` (`protocol.ts`, `identity.ts`); key distribution (`identity-keys.ts`); `hasAppAccess`/org resolution (`betterAuthAuthenticator.ts`, `orgContext.ts`); opaque-token hashing + scopes from the legacy AI proxy.

---

## 4. App / SDK / manifest changes (target: near-zero)

**Manifest — one edit** in `everyapp.config.ts`:

```ts
defineEveryApp({
  public: [
    { path: "/mcp", methods: ["GET","POST"], auth: "eat" },   // new: auth hint
    { path: "/api/*", methods: ["GET","POST","PUT","DELETE"], auth: "eat" },
  ],
})
```

`PublicRouteSchema` (`manifest/manifest.ts:16`) gains an optional `auth?: "anonymous" | "eat"` (default **`"eat"`** for any route the SDK guard protects — see fail-closed note). `assertPublicPathIsSafe` already forbids the dangerous cases; `/api/*` is a single-segment glob (`publicRoutes.ts:globToRegExp`), fine. Note `/api/**` would be needed for nested paths — allowed (not a catch-all).

**SDK — one wrapper, zero hand-rolled auth.** The existing `everyApp()` server wrapper (`packages/sdk/src/server/everyApp.ts`) already verifies `x-everyapp-identity`. Extend it so it **also** accepts a forwarded EAT:

```ts
export default everyApp(app, {
  // identity from x-everyapp-identity OR forwarded Bearer EAT — unified
  // routes declared auth:"eat" are fail-closed automatically
})
```

- `getIdentityFromRequest` (`identity.ts:259`) gains a third branch: no `x-everyapp-*` header but a `Bearer` EAT present → verify as EAT → `{ user, isPublic:false, channel:"mcp"|"api" }`.
- **Fail-closed default:** if a route is declared public *and* `auth:"eat"` (the default), the SDK returns `401` + `WWW-Authenticate` when no valid EAT is present. An author must **explicitly** write `auth:"anonymous"` to serve a route unauthenticated. This preserves "default-private" *semantically* even though the gateway sees the route as public.

**MCP server itself:** the app ships a Streamable-HTTP MCP handler (e.g. `@modelcontextprotocol/sdk`), but **auth is not its concern** — the SDK guard runs before it and injects `ctx.user`. For claude.ai connector discovery the SDK also auto-serves `/.well-known/oauth-protected-resource` (RFC 9728) pointing at the gateway AS — zero app code.

**Net app author burden:** one manifest block + wrapping the handler (already required today). Everything else is SDK.

---

## 5. MCP-client compatibility matrix

| Client | Out of the box? | What the user does |
|---|---|---|
| **claude.ai connectors** (web/Desktop/mobile) | **Yes, with the OAuth AS (Tier B).** Requires the gateway's RFC 9728 challenge + RFC 8414 metadata + DCR/CIMD + PKCE + consent — all central, all built here. | Paste `https://<app>.<domain>/mcp` as a custom connector → redirected to gateway → **Better Auth login + consent** → done. No static-bearer field exists in their UI (brief §7), so OAuth is the *only* path — which this design supplies. |
| **Claude Code** | **Yes, two ways.** OAuth (loopback + CIMD) via the AS, or static header. | Simplest: `claude mcp add app --transport http --header "Authorization: Bearer <api-key EAT>" https://<app>.<domain>/mcp`. Or `claude mcp add` an OAuth server and log in. |
| **Cursor** | **Yes.** Header map or OAuth. | Add MCP server JSON with `"headers": { "Authorization": "Bearer <api-key EAT>" }`. OAuth if it advertises. |
| **Generic API client / curl / CI** | **Yes** (dominant path). | `Authorization: Bearer <api-key EAT>` against `/mcp` or `/api/*`. Copy the key from the dashboard once. |

Honest read: **Tier A (API keys) alone** — an M-sized slice — already unblocks Claude Code, Cursor, and every generic client the same day, because they all accept static bearers. **claude.ai connectors are the only client that forces the L-sized OAuth AS**, because their UI has no static-bearer field. Ship Tier A first.

---

## 6. Security analysis

**Threat model & how each perimeter invariant survives:**

| Invariant | Preserved? | Mechanism |
|---|---|---|
| Inbound trust-header stripping | **Yes, unchanged.** | `stripInboundHeaders` still deletes `cookie` + all `x-everyapp-*` (`headers.ts:23`). A client cannot forge identity; it can only present a `Bearer` the app must cryptographically verify. |
| Fail-closed identity JWTs | **Yes, extended.** | EAT verification is the *same* `verifyPinnedJwt` (alg-pinned RS256, kid-allowlist, `aud`=app-id, `typ` check). Forged/`alg:none`/wrong-aud/expired → throws → `401`. |
| Default-private routing | **Weakened → mitigated.** | The gateway now treats `/mcp`,`/api/*` as public (no gateway auth). The *real* gate is the SDK guard in the app. Mitigation: `auth:"eat"` is the **default** and the SDK is **fail-closed**; an author must type `auth:"anonymous"` to open a route. Still: if the app worker skips the SDK wrapper entirely, the route is open. **This is the approach's single biggest weakness** — a token-terminating gateway would not have it. |
| Private app workers | **Yes.** | Apps remain reachable only via `APP__<workerName>` service binding (`getAppFetcher.ts`). |
| First-user signup lock | **Yes, untouched.** | Issuance requires an authenticated Better Auth session + org membership; OAuth consent rides the same login. No new signup surface. |

**Credential exposure / blast radius:**
- EATs are **audience-bound** (`aud`=app-id) → a token stolen from app A **cannot** be replayed against app B (verify fails on audience). This is strictly better than a bearer that works everywhere.
- The **app sees the token** (it's forwarded). A malicious/compromised app worker learns the EATs presented *to it* — but those are already scoped to that app, so no cross-app escalation. It does **not** learn the gateway private key (only public keys are distributed), so it **cannot mint** EATs for itself or others.
- Access EATs are short-lived (10 min) → stolen access token has a small window. Refresh tokens are opaque + stored + revocable.
- **No provider keys or long-lived app secrets are involved** — unlike the legacy AI proxy (`ai-proxy.ts:88`), which this design does not touch.

**Revocation:** the honest weak spot. Local verification means revocation is **TTL + 60 s-cache bounded**, not instant. For OAuth this is fine (10 min access, instant refresh-token revoke). For long-lived static API keys it's worse — a revoked key stays valid until its jti propagates via the revocation list (60 s) *and* any cached EAT expires. Mitigations weighed in §9.

**New attack surface:** the OAuth AS (authorize/token/DCR) is a classic target — open-redirect via `redirect_uri`, DCR abuse (unbounded client registration), PKCE downgrade. Standard mitigations: strict `redirect_uri` allow-listing, mandatory S256, DCR rate-limiting + org binding, `resource`/audience parameter (RFC 8707) so codes can't be swapped across apps.

**Optional hardening:** restrict PR #220's `Authorization` forwarding to routes whose manifest `auth` is `"eat"`/`"mcp"`, so a plain public marketing route doesn't leak an unrelated inbound `Authorization` to the app. One conditional in `prepareOutboundHeaders`'s caller (`gateway.ts:167`).

---

## 7. Hosted multi-tenancy (many orgs, ~100k untrusted apps)

**This is where decentralized verification wins.** Because validation is **local to each app worker**, the gateway does **zero per-request auth work** for `/mcp` and `/api/*` — it just proxies. At 100k apps on Workers-for-Platforms dispatch (`getAppFetcher` `tier:"dispatch"` seam), a token-terminating gateway would be a per-request CPU + I/O bottleneck and a single hot shard for token lookups. Here the hot path stays a dumb proxy.

**State that accumulates (and where):**
- `app_credentials`, `oauth_clients` — **per-org, per-app**, grows with usage. Bounded by user behavior; prunable on `expires_at`. Fine in D1 at this scale, shardable by org later.
- `revoked_jti` — grows with revocations, **self-pruning at token exp**. The concern: the revocation list served at `identity-keys.ts` must stay small. Design it as **per-app-scoped** (an app fetches only its own revocations) or as a `revoked_before` timestamp per key-id rather than an unbounded jti list. This must be **per-tenant partitioned** or it becomes a cross-tenant hot object — call it out as a scaling item.
- KV auth codes — ephemeral, negligible.

**Per-org vs per-gateway:** issuance, consent, and keys are **per-gateway** (one AS, one signing keypair — consistent with brief §5's "one multi-tenant gateway"). Credentials and grants are **per-org/per-app**. Audience-scoping already aligns with the doc's future `aud = t_<tenant>_<app>` tenant-scoped JWTs (brief §5) — EAT `aud` just becomes the dispatch script name.

**Verdict:** scales *better* than a centralized token-terminating gateway on the hot path; the only accumulating shared object is the revocation list, which must be tenant-partitioned. No per-request gateway state.

---

## 8. Effort estimate

| Slice | Size | Rough LOC | Net-new subsystems |
|---|---|---|---|
| **Tier A — API keys + SDK verify** (D1 `app_credentials`, `api/keys/*` CRUD, dashboard issue/revoke UI, SDK EAT verify branch + fail-closed guard, manifest `auth` field, revocation-list distribution) | **M** | ~1,800–2,600 | credentials service; SDK auth toolkit; 2 D1 tables |
| **Tier B — OAuth AS** (RFC 8414 metadata, `/oauth/authorize` consent, `/oauth/token`+PKCE, DCR/CIMD, refresh tokens, SDK RFC 9728 `.well-known` + `WWW-Authenticate`) | **L** | ~2,800–4,200 | OAuth authorization server; `oauth_clients`/codes; consent UI |
| **Combined** | **L** | ~4,600–6,800 | |

Ship **Tier A first** — it's the cheaper slice and unblocks 3 of 4 clients. Tier B is gated purely by "we want claude.ai connectors."

Cheap relative to a token-terminating central MCP gateway (which needs the AS *plus* a ToolBus, per-request minting, and hot-path validation for every app — brief §6). This approach reuses the identity crypto and key distribution wholesale, so the crypto LOC is near zero.

---

## 9. Failure modes / what could go wrong

1. **App forgets the SDK guard → open endpoint.** The load-bearing risk. A public `/api/*` with no verify = unauthenticated access. *Mitigations:* SDK fail-closed default; a CLI lint at deploy that errors if a route is `auth:"eat"` but the handler doesn't wrap `everyApp()`; consider a gateway-side belt-and-suspenders (§6 optional) but that drifts toward the centralized approach.
2. **Revocation lag.** Long-lived static API-key EATs stay valid until exp + cache propagation. *Recommendation:* make static API keys **opaque `eak_` secrets** (hashed in D1, reuse `ai-gateway-auth.ts`) and have the SDK **introspect with a 30–60 s cache** — this buys near-instant revocation at the cost of one cached gateway round-trip. Yes, that reintroduces the gateway to the path for the static-key flow; I judge it the right trade for keys that live for months. **OAuth access EATs stay fully local** (short TTL makes lag a non-issue). Net: two verification modes, SDK hides both.
3. **Key rotation coupling.** EATs share the identity keypair; a rotation that invalidates identity JWTs also invalidates in-flight EATs. *Mitigation:* EATs verify against the *same* current+next key set (`identity.ts` already tries both), and rotation runbook (PR #215) already handles overlap. Long-TTL API keys need the overlap window ≥ their TTL, or must be opaque (see #2).
4. **`Authorization` forwarding is broader than intended.** PR #220 forwards on *every* public route. A marketing site's public route would leak a stray inbound `Authorization` to the app. *Mitigation:* the §6 `auth`-typed forwarding restriction.
5. **OAuth AS abuse:** open-redirect, DCR spam, code interception. Standard OAuth 2.1 hygiene required; PKCE mandatory; `resource`/RFC 8707 audience binding so codes are app-specific.
6. **CSRF downgrade interaction.** A browser-based attacker could hit a public `/api/*` cross-site; CSRF failure downgrades to anonymous (not reject), but the EAT guard then 401s an anonymous request — so the anonymous downgrade is *safe here* precisely because the SDK is fail-closed. Worth an explicit test.
7. **Two identity paths diverge.** App code must treat `x-everyapp-identity` (browser) and EAT (API) uniformly. If the SDK doesn't perfectly unify them, authz logic forks. *Mitigation:* single `ctx.user` object, one code path, `channel` field distinguishes.

---

## 10. Composition with the just-merged Wave 2 primitives

**Honest correction first (per brief §3):** the "AppGateway `WorkerEntrypoint` + deploy-time props `{organizationId, appId, workerName}`" primitive **does not exist in `main`**. There is no `app-gateway-entrypoint.ts`, no `AppGateway` class, no SDK `gatewayFetch`. So this design composes with the primitives that *actually* exist:

- **Public-route `Authorization` forwarding (PR #220 — real, and this design's foundation).** This is the entire mechanism by which the EAT reaches the app. My design is essentially "make PR #220 safe and useful": it forwards the credential, and this design supplies the (a) issuer, (b) SDK verifier, and (c) fail-closed default that turn a raw forwarded bearer into disciplined auth. Direct composition, zero conflict.

- **`getAppFetcher` + `APP__<workerName>` service binding (real, `getAppFetcher.ts:38`).** Unchanged. EATs ride the existing proxy; no new binding. When `tier:"dispatch"` lands, EAT `aud` maps to the dispatch script name (`t_<tenant>_<app>`) — the design is already audience-shaped for it (brief §5).

- **Provider allowlist / edge-key injection (real, but it's the *legacy AI proxy*, `ai-proxy.ts` — explicitly superseded).** My design deliberately **does not** extend the app-secret/`x-every-app-token` model (`ai-proxy-token-policy.ts`), which forbids inbound `Authorization` — the opposite of what MCP needs. I **reuse two ingredients** from it: the opaque-token **hashing** (`ai-gateway-auth.ts:13`) for the static-key introspection path (§9 #2), and the **scope model** (`app-token-scopes.ts:42`, generalized from `provider:*` to `app:read`/`mcp:tools`). The provider-allowlist/edge-key-injection pattern itself is orthogonal — it's for the app→gateway LLM egress direction, not client→app auth.

- **Identity keypair + distribution + `verifyPinnedJwt` (real, §4).** The design's crypto is 100% reuse: EAT = identity JWT with `typ:"eat"` + longer TTL, minted by the same `mintIdentityJwt`, verified by the same `verifyPinnedJwt`, distributed by the same `identity-keys.ts`. This is the cleanest composition point and the reason the effort estimate is L-not-XL.

**Bottom line on the approach:** it is the **lowest-gateway-change, best-hot-path-scaling** option, and it composes almost for free with what merged this week. Its price is real and I won't soft-pedal it: **enforcement trust moves into the app worker** (mitigated by a fail-closed SDK, not eliminated), and **revocation is TTL-bounded** for the local-verify path (mitigated by short OAuth TTLs and opaque+introspection for static keys). If the platform's non-negotiable is "the gateway, not the app, is the thing that can never fail open," a token-terminating central approach beats this one. If the non-negotiable is "minimal gateway surface that scales to 100k apps without per-request auth cost," this is the better design.