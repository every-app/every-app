I have what I need — the workers-oauth-provider substrate details and the current MCP 2025-11-25 authorization spec. Writing the design doc.

---

# Design Approach A — Gateway as a Full OAuth 2.1 / MCP-Spec Authorization Server

*Target: Every App v2 perimeter @ `main` e235a0f. Substrate evaluated: `@cloudflare/workers-oauth-provider`. Protocol basis: MCP Authorization `2025-11-25`, OAuth 2.1 draft-13, RFC 9728 / 8414 / 8707 / 7591 / CIMD-00.*

## 1. Summary

Make the gateway a real OAuth 2.1 Authorization Server so that every app host (`https://<app>.<domain>/mcp`, `/api/*`) becomes a spec-compliant OAuth 2.0 *resource server* fronted by that AS. External MCP clients discover the AS via RFC 9728 protected-resource-metadata (served by the gateway for each app host), run the standard PKCE authorization-code dance — reusing the existing Better Auth browser session for the login/consent step and reusing `hasAppAccess` for entitlement — and receive a gateway-issued, audience-bound (`resource=https://<app>.<domain>/mcp`, RFC 8707) access token. On each proxied request the gateway validates that token, loads the grant's props, and **mints a fresh internal identity JWT** (`chan:"mcp"`, `act:{sub:"mcp:<client_id>"}`, `aud=appId`) exactly as today (`mintIdentityJwt`, `protocol.ts:167`), stripping the external bearer before proxying. The external token terminates at the gateway; the app is unchanged and never sees an OAuth token. This is the **only** path that works out-of-the-box for claude.ai connectors, which mandate a real OAuth flow and expose no static-bearer field. I recommend adopting `workers-oauth-provider` as the substrate but mounting the *existing* `handleGatewayRequest` as its API/default handler, and I am honest below that this is the heaviest of the candidate approaches (net-new AS subsystem, consent UI, KV token store) — justified only because connector compatibility is a hard requirement.

## 2. End-to-end request/auth flow + token lifecycle

**Phase 0 — Discovery (unauthenticated).**
1. Client `POST https://acme.everyapp.host/mcp` with no token.
2. Gateway matches `/mcp`, finds no bearer and no session → returns **`401` + `WWW-Authenticate: Bearer resource_metadata="https://acme.everyapp.host/.well-known/oauth-protected-resource/mcp", scope="app:use"`** (RFC 9728 §5.1). This replaces today's bare `401 unauthenticated` (`gateway.ts:220`) *for the MCP/API surface only*.
3. Client GETs the PRM document from the app host. Gateway serves:
   ```json
   { "resource": "https://acme.everyapp.host/mcp",
     "authorization_servers": ["https://auth.everyapp.host"],
     "scopes_supported": ["app:use","api:read","api:write"],
     "bearer_methods_supported": ["header"] }
   ```
   `authorization_servers` always points at the single central gateway AS origin, regardless of which app host asked.
4. Client fetches AS metadata `https://auth.everyapp.host/.well-known/oauth-authorization-server` (served by `workers-oauth-provider`), advertising `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `code_challenge_methods_supported:["S256"]`, `client_id_metadata_document_supported:true`.

**Phase 1 — Client identity.** Priority order per spec §Client Registration: pre-registered → **CIMD** (Claude Code, and the recommended path) → **DCR** `POST /oauth/register` (claude.ai connectors fall here or use Anthropic-held creds). All three are handled by the substrate.

**Phase 2 — Authorization (browser, PKCE).**
1. Client opens `authorization_endpoint` with `code_challenge` (S256), `resource=https://acme.everyapp.host/mcp`, `scope`, `state`, `redirect_uri`.
2. Gateway `/authorize` handler: reads the **Better Auth session cookie** (`betterAuthAuthenticator.authenticate`, `betterAuthAuthenticator.ts:23`). No session → 302 to the existing login UX (`loginUrl`, `gateway.ts:216`), returning here after. It then resolves the app from the `resource` host (`parseHost` + `resolveApp`, `gateway.ts:127`) and enforces **`hasAppAccess(session, app)`** (`gateway.ts:189`) — `session.orgId === app.organizationId` AND a `user_app_access` row. Not entitled → deny (no grant).
3. Consent screen: "*Claude (claude.ai) wants to access **Acme** on behalf of you@org — scopes: app:use*". On approve, call `env.OAUTH_PROVIDER.completeAuthorization({ scope, props })` where **`props = { userId: session.sub, email, orgId: session.orgId, orgRole: session.orgRole, appId: app.appId, appHost, clientId }`**. Redirect back with the code.

**Phase 3 — Token exchange.** Client `POST /oauth/token` with `code` + `code_verifier` + `resource`. Substrate verifies PKCE, mints an **opaque** access token (`{userId}:{grantId}:{secret}` form, secret hashed in KV; props encrypted at rest under a key derived from the token) + rotating refresh token. Returns `{access_token, refresh_token, expires_in: 900, token_type:"Bearer"}`.

**Phase 4 — Resource requests (the hot path, per request).**
1. `POST https://acme.everyapp.host/mcp` with `Authorization: Bearer <gw-token>`.
2. Gateway resolves app (§1 flow steps 1–2, unchanged). New step before session auth: **`OAUTH_PROVIDER` validates the bearer** → returns decrypted `props`, or 401. Audience check: `props.appHost` must equal the request host (rejects a token minted for app B replayed at app A — RFC 8707 audience binding).
3. **Re-check live entitlement:** `hasAppAccess` against `props.{orgId,appId}` using the 30 s cache (`orgContext.ts`), so a revoked `user_app_access` row or org-membership change kills access within cache TTL even while the token is unexpired.
4. **Mint internal identity JWT** (`mintIdentityJwt`, `protocol.ts:167`) with `sub=props.userId`, `email`, `org_id`, `org_role`, `aud=props.appId`, `chan:"mcp"`, `act:{sub:"mcp:"+props.clientId}`, TTL 120 s. Set `x-everyapp-identity` (`gateway.ts:194-207` path).
5. **`stripInboundHeaders` runs as today** (`headers.ts:23`): the external `Authorization` bearer and all `x-everyapp-*` are stripped; only the freshly minted identity header survives. Proxy via `getAppFetcher(env, app).fetch()` (`getAppFetcher.ts:38`). **No token passthrough** — spec §Access Token Privilege Restriction satisfied by construction.

**Lifecycle summary.**
| Credential | Issue | Present | Validate | Refresh | Revoke |
|---|---|---|---|---|---|
| Access token (opaque) | `/oauth/token` after PKCE+consent | `Authorization: Bearer` on `/mcp`,`/api/*` | KV lookup → decrypt props → audience+entitlement check, per request | via refresh token | delete grant in KV; or drop `user_app_access` row (≤30 s) |
| Refresh token (rotating) | with access token | `/oauth/token` grant_type=refresh_token | KV, single-use rotation | self | delete grant |
| Internal identity JWT | minted per proxied request | `x-everyapp-identity` gateway→app | app-side `verifyPinnedJwt` (`identity.ts:154`) | n/a (120 s TTL) | expires in 120 s |
| OAuth client (DCR/CIMD) | `/oauth/register` or URL | `client_id` in authz/token | KV / CIMD fetch | n/a | delete client (cascades grants) |

## 3. Gateway changes (concrete)

**Substrate mount (the one structural decision).** `workers-oauth-provider` wants to *be* the worker entrypoint (`export default new OAuthProvider({...})`, wrapping an `apiHandler`). The gateway already owns the entrypoint (`handleGatewayRequest`, `gateway.ts:122`). Mount the provider as the outer entrypoint and pass the existing gateway in as both handlers:
```ts
export default new OAuthProvider({
  apiRoute: ['/mcp', '/api/'],                 // token-guarded surfaces
  apiHandler: { fetch: (req, env, ctx) =>       // ctx.props = grant props
     handleGatewayRequest(req, { ...deps, oauthProps: ctx.props }) },
  defaultHandler: { fetch: (req, env, ctx) =>   // browser/cookie surface + /authorize + PRM
     handleGatewayRequest(req, deps) },
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: ['app:use','api:read','api:write'],
  accessTokenTTL: 900, refreshTokenTTL: 2592000,
  allowPlainPKCE: false, clientIdMetadataDocumentEnabled: true,
});
```
Consequence: for `/mcp` and `/api/*`, `handleGatewayRequest` runs with `oauthProps` already populated and *skips* the Better Auth cookie read — it takes the mint-identity branch directly. For everything else it runs exactly as today. This is the smallest-diff way to keep the entire existing perimeter (CSRF, public routes, security headers, `getAppFetcher`) intact.

**Routes (new).**
- `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource[/mcp]` — AS metadata served by the substrate; **PRM served by us** per app host (substrate does not own RFC 9728). Small handler that emits the JSON in §2 keyed on request host.
- `/authorize` — consent UI + Better Auth session gate + `completeAuthorization`. This is the only genuinely new *product* surface (a React route under `apps/every-app-gateway/src/routes/`).
- `/oauth/token`, `/oauth/register` — substrate-implemented; we only configure.

**Perimeter changes (`packages/perimeter/src/gateway.ts`).**
- New branch: if `deps.oauthProps` present → audience check (`props.appHost === host`) → `hasAppAccess` re-check → `mintIdentityJwt` with `chan:"mcp"`. ~30 LOC around `gateway.ts:180-207`.
- `handleGatewayRequest`'s `401` for the `/mcp` `/api/*` prefixes gains the `WWW-Authenticate: Bearer resource_metadata=…` header (RFC 9728 §5.1). ~10 LOC in the `gateway.ts:214-221` reject block.
- `headers.ts` unchanged — `stripInboundHeaders` already deletes `authorization` and `x-everyapp-*`; we simply do **not** set `forwardAuthorization` for the MCP surface (opposite of PR #220's public-route path).

**D1 / storage.**
- OAuth state (registered clients, grants, access/refresh tokens) lives in **KV**, as the substrate expects — one `OAUTH_KV` namespace on the gateway. No new D1 tables strictly required for the POC.
- Recommended D1 additions for operability: `oauth_grant` (mirror: `grant_id, user_id, org_id, app_id, client_id, scopes, created_at, last_used_at`) written on `completeAuthorization` and a `revoked_at` column, so the admin UI can list/revoke "connected apps" per user and audit MCP access without scanning KV. `oauth_client` (mirror of DCR registrations for org-scoped review). These are shadow tables; KV remains source of truth for the token hot path.

**Services.** New `OAUTH_PROVIDER` binding (the helpers object) available in handlers. Reuse: identity minting (`protocol.ts`), `resolveApp`/registry (`registry.ts`), `betterAuthAuthenticator` + `orgContext` for the `/authorize` gate, `getAppFetcher` for proxy.

## 4. App / SDK / manifest changes (near-zero)

- **App code: zero.** The app receives `x-everyapp-identity` exactly as it does for browser traffic and verifies it with the existing `everyApp()` wrapper (`packages/sdk/src/server/everyApp.ts` → `getIdentityFromRequest`, `identity.ts:259`). It just needs an `/mcp` handler that speaks Streamable HTTP MCP — a product feature, not auth. `req` arrives already authenticated; the app reads `user.channel === "mcp"` and `user.actor` if it wants to gate tools.
- **Manifest: one optional field.** Add `expose?: { mcp?: boolean; api?: boolean }` to `ManifestSchema` (`manifest.ts`). It does **not** make routes public — `/mcp` and `/api/*` stay private and gateway-authenticated. Its only jobs: (a) let the gateway list the app in the consent screen / discovery, (b) let an app opt *out* of the MCP surface. Default `{ mcp: true, api: true }` → true near-zero. Critically, do **not** route MCP through the existing `public:` mechanism — that path (`gateway.ts:178,208`) downgrades to anonymous and forwards the raw bearer, which is exactly what we're avoiding.
- **SDK: additive, optional.** Ship a thin `createMcpHandler()` helper in `packages/sdk` so ported apps get Streamable HTTP + the identity read for free, but it's convenience, not required.
- **CLI:** `validateManifestStrict` learns the new `expose` key. No deploy-flow change; identity public keys already distributed (`identity-keys.ts`).

## 5. MCP-client compatibility matrix

| Client | Out of the box? | What the user does |
|---|---|---|
| **claude.ai connectors** (web/Desktop/mobile) | **Yes — the headline win.** Full RFC 9728 → RFC 8414 → DCR/CIMD → PKCE flow is exactly what the connector implements; consent + no `client_credentials` matches our browser-consent model. | Paste `https://acme.everyapp.host/mcp`, click "Connect", complete the gateway's login/consent in the popup. No headers, no secrets. |
| **Claude Code** | **Yes.** Runs its own loopback (RFC 8252) OAuth, identifies via its own CIMD (`clientIdMetadataDocumentEnabled:true` covers it). | `claude mcp add --transport http acme https://acme.everyapp.host/mcp` then complete the browser login once. (Static-header escape hatch also works but isn't needed.) |
| **Cursor** | **Yes**, for the OAuth-advertising path. | Add the server URL in MCP config; complete OAuth login when prompted. |
| **Generic API client / script / CI** | **Partial.** Must either implement the OAuth dance (most don't) or use a pre-registered client + refresh token stored as a secret. This is the ergonomic weak spot of the standards path. | For scripts: pre-register a client once (admin UI), store `client_id`/refresh token as CI secrets, or accept a long-lived token issued from the "connected apps" UI. |

The generic/script case is where a static-bearer approach (a competing design) is strictly nicer; this approach pays ergonomic tax there to win the connector case.

## 6. Security analysis

**Perimeter invariants — all preserved:**
- *Default-private routing:* `/mcp` and `/api/*` remain private routes. Unauthenticated → 401 (now with a `WWW-Authenticate` challenge, still 401). `matchPublicRoute` default-deny (`publicRoutes.ts:166`) untouched.
- *Fail-closed identity JWTs:* unchanged. App still requires a valid `x-everyapp-identity`/`x-everyapp-public` or throws (`identity.ts:259`). MCP traffic just populates the pre-existing `chan:"mcp"`/`act` claims.
- *Inbound trust-header stripping:* unchanged and load-bearing here — `stripInboundHeaders` (`headers.ts:23`) deletes the external `Authorization` bearer and any client-forged `x-everyapp-*`. The external token **never reaches the app** (no passthrough; spec §Token Passthrough forbidden-behavior avoided).
- *Private app workers:* proxy still via `APP__<workerName>` service binding (`getAppFetcher.ts:30`); apps stay unreachable except through the gateway.
- *First-user signup lock:* untouched — OAuth grants require an *existing* Better Auth session that passed invite-only signup (`auth/config.ts`). OAuth is an authorization layer on top of Better Auth identity, not a second signup path. No `client_credentials` grant → no machine can self-provision access without a consenting human org member.

**Threat model / blast radius.**
- *Stolen access token:* opaque, audience-bound to one app host, 15-min TTL, and every use re-checks `hasAppAccess` live → blast radius = one app, one user, ≤15 min or ≤30 s after entitlement revocation. Cannot be replayed at a sibling app (audience check step §2.4.2).
- *Stolen refresh token:* rotating (single-use); reuse detection is available in the substrate. Revoke by deleting the grant.
- *Confused-deputy via DCR + static AS:* the real risk of this design. Mitigation is mandatory per-client user consent (the `/authorize` screen), which we enforce; the substrate + our consent step satisfy spec §Confused Deputy.
- *CIMD SSRF:* the AS fetches attacker-supplied `client_id` URLs. Must run with `global_fetch_strictly_public` and an allowlist/deny-private-IP policy (spec §CIMD Security). New attack surface that did not exist before — call it out as a hardening line item.
- *Open redirect:* substrate enforces exact `redirect_uri` match; localhost redirects (Claude Code) get the spec's mandated hostname-display warning on the consent screen.
- *Token store compromise (KV):* props are encrypted at rest under token-derived keys; token secrets stored hashed. A KV dump without live tokens does not yield usable credentials or plaintext org data.

**Revocation paths:** (a) user "disconnect app" → delete grant (KV) + set `oauth_grant.revoked_at`; (b) admin removes `user_app_access` or org membership → next request's live `hasAppAccess` re-check denies within 30 s even on a valid token; (c) delete OAuth client → cascade grants. The 120 s internal-JWT TTL bounds any in-flight window.

## 7. Hosted multi-tenancy

**Scales to many orgs — mostly.** The internal identity JWT is already org-scoped (`aud=appId`, `org_id` claim), and the AS reuses Better Auth's org authority, so grants are naturally org-partitioned via `props.orgId`. The `resource`/audience binding gives per-app token isolation for free, which maps cleanly onto the future Workers-for-Platforms `aud=t_<tenant>_<app>` scheme (`architecture-v2-recommendation.md` §7) — this design does not foreclose the dispatch future; it pre-aligns with it.

**What accumulates (the honest concerns):**
- **OAuth clients are gateway-global, not org-scoped.** DCR/CIMD registrations live in one KV namespace for the whole gateway. At ~100k apps × many connector installs, the client table grows unbounded. `clientRegistrationTTL` (90 d default) garbage-collects idle DCR clients, and CIMD clients store nothing server-side (fetched by URL) — so **prefer CIMD, lean on client TTL**. Still, this is per-gateway state that grows with total connector activity, not per-org.
- **Grant + token count** scales with (users × apps-connected × clients). KV handles the volume, but the D1 shadow tables (`oauth_grant`) will be large; index on `(user_id, app_id)` and `(org_id, app_id)`, and prune on revoke/expiry.
- **PRM/AS metadata is per-host but static** — cache aggressively at the edge; no per-app state.
- **`/authorize` consent throughput** is bounded by Better Auth session checks + `hasAppAccess` (both 30 s cached). Fine.
- **Single AS origin** (`auth.everyapp.host`) is a central dependency all apps' discovery points at — a scaling and blast-radius chokepoint, but it's the same trust root as the gateway itself, so no *new* single point of failure.

Net: per-org state is clean; the gateway-global OAuth client/token store is the thing that accumulates and needs TTL + pruning discipline.

## 8. Effort estimate

**Overall: L.** This is the heavy approach — a genuinely new subsystem.

| Piece | Size | ~LOC |
|---|---|---|
| Mount `workers-oauth-provider`, wire config, KV binding | S | 80 |
| `/authorize` consent route + Better Auth gate + `completeAuthorization` (incl. React UI) | **M–L** | 300–450 |
| PRM (RFC 9728) + `WWW-Authenticate` challenge on 401 | S | 60 |
| Perimeter mint-from-oauth-props branch + audience + live entitlement re-check | S | 60 |
| Manifest `expose` field + CLI validation | S | 40 |
| D1 shadow tables + revoke/"connected apps" admin UI | M | 200 |
| CIMD SSRF hardening / allowlist | S | 50 |
| SDK `createMcpHandler` (optional) | S | 80 |
| Tests (OAuth flow e2e, audience isolation, revocation) | M | 250 |

**Net-new subsystems:** (1) OAuth 2.1 AS (substrate-backed), (2) consent UI + connected-apps management, (3) KV token store + D1 mirror. Rough total **~1,100–1,300 LOC** of our code plus the dependency. The `/authorize` consent UX and revocation UI are the real cost, not the protocol plumbing.

## 9. Failure modes / what could go wrong

- **Substrate/entrypoint impedance mismatch.** `workers-oauth-provider` assumes it owns the worker and wraps a handler; our gateway has rich pre-existing routing (CSRF, public routes, security-header floor). The mount in §3 works, but the double-dispatch (`apiRoute` match then `handleGatewayRequest` re-resolving the app) is subtle; getting `ctx.props` plumbed and *not* re-running cookie auth on the API path is where bugs hide. Verify `apiRoute` prefix matching plays well with per-app hostnames.
- **PRM ownership gap.** The substrate serves AS metadata but RFC 9728 PRM is the resource server's job and must be per-app-host. If we forget a host or serve the wrong `resource` value, connectors fail discovery with opaque errors. Audience mismatches between the PRM `resource`, the token `aud`, and the `WWW-Authenticate` value are the classic silent-failure class here.
- **Connector quirks.** Real claude.ai/Cursor clients deviate from spec in practice (trailing-slash `resource` canonicalization, scope handling, DCR field strictness). Expect an integration-testing tail; the matrix in §5 is aspirational until tested against live clients.
- **CIMD SSRF** if hardening is skipped — the AS becomes an SSRF pivot into the Cloudflare private network.
- **KV consistency.** KV is eventually consistent; a just-revoked grant may briefly validate. The live `hasAppAccess` re-check backstops entitlement revocation, but *client/grant deletion* itself races KV propagation — bound by short access-token TTL.
- **Consent fatigue / phishing.** A convincing `/authorize` page is a phishing target; and every new client triggers consent (confused-deputy mitigation), which users click through. UX vs. security tension.
- **Generic-client ergonomics** (§5) generate support load — people will want static bearers this design deliberately doesn't offer.
- **Dependency risk.** Betting the auth perimeter on a third-party library (`workers-oauth-provider`, still evolving — note the experimental enterprise/ID-JAG flags). Pin versions; the token-store format is effectively a persistence contract.

## 10. Composition with Wave 2 primitives

- **Public-route `Authorization` forwarding (PR #220, `headers.ts:41-44`):** this design is the deliberate *inverse* and they coexist cleanly by route class. Public manifest routes keep forwarding the raw bearer untouched to apps that roll their own auth (webhooks, ported OSS). The OAuth-terminated `/mcp` + `/api/*` surface is **private**, so `forwardAuthorization` is false there and the external token is stripped after the gateway consumes it. One app can have both: a public webhook that gets a passed-through bearer, and an OAuth-gated `/mcp`. No conflict — the `public:` match decides which policy applies, per route, as it already does.
- **Provider allowlist / edge-key injection (legacy AI proxy, `ai-proxy.ts`):** orthogonal and complementary. That subsystem is app→gateway egress with `x-every-app-token`; this is client→gateway ingress with OAuth. They don't touch. The relevant parallel is architectural: both terminate an external credential at the gateway and inject a gateway-controlled one downstream (there, `OPENAI_API_KEY`; here, the internal identity JWT). This design applies the same "credential terminates at the perimeter, mint a scoped internal one" principle to the ingress direction — consistent security posture across both edges.
- **AppGateway service binding + props (`WorkerEntrypoint`, brief §3 — noted as not-yet-built):** if/when the `WorkerEntrypoint`-with-deploy-props model lands (replacing the plain `APP__` service binding), this design rides on top unchanged: the OAuth layer produces an identity JWT and hands the request to `getAppFetcher` (`getAppFetcher.ts:38`), which is the single seam. Deploy-time props like `{organizationId, appId}` would let the gateway drop the registry lookup for audience binding, and the `tier:"dispatch"` future (§7) inherits the already-audience-bound token model. The OAuth AS sits strictly above the proxy seam and is insulated from how the app is ultimately reached.

**Bottom line:** the standards-compliant, connector-compatible, and most future-aligned option — and the most expensive. Adopt it specifically because claude.ai connectors leave no cheaper door; scope the POC to a single `app:use` scope (defer ToolBus/per-tool scopes, §6/Phase 6), lean on CIMD over DCR to bound gateway-global state, and budget the real cost in the consent/revocation UX rather than the OAuth plumbing.