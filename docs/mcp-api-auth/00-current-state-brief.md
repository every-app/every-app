I have everything needed. Compiling the brief.

---

# Every App v2 — Current-State Auth/Perimeter Brief

**Basis:** `main` @ `e235a0f` (2026-07-15 19:38 EDT). All 11 auth-relevant PRs from today (#212–#223) are merged. Verified against source, not memory. **One item in the task spec (§3) does not exist in the code as described — flagged inline.**

---

## 1. Perimeter request/auth flow

Entry point: `handleGatewayRequest(request, deps)` in `packages/perimeter/src/gateway.ts:122`. The gateway is a single public Worker; apps are private workers reachable only through it. Flow, in order:

1. **Host → app resolution.** `parseHost` on the `host`/URL host (`gateway.ts:127`); `deps.resolveApp` maps it to a `RegisteredApp` (prod = full hostname, dev = first label). No app → `404 no_app_for_host`; non-`active` status → `503` (`gateway.ts:132-140`).
2. **Public-route match.** `matchPublicRoute(app.manifest.public, method, pathname)` (`gateway.ts:142`, impl `publicRoutes.ts:166`). Default-deny; details in §2.
3. **CSRF.** `evaluateCsrf(method, host, origin, sec-fetch-site)` (`gateway.ts:152`, impl `csrf.ts:25`). Safe methods (GET/HEAD/OPTIONS) always pass. For state-changing methods: `Sec-Fetch-Site: same-origin` passes; any other `Sec-Fetch-Site` value fails; absent → fall back to `Origin` host === app host; absent Origin → deny. **Private route + CSRF fail → `403 csrf_denied` (fail-closed). Public route + CSRF fail → NOT rejected; request is downgraded to anonymous** (session lookup is skipped, `gateway.ts:178` guards `if (csrf.allowed)`). This is the webhook/programmatic path.
4. **Session authentication (the Better Auth cookie read).** `deps.authenticator.authenticate(request)` (`gateway.ts:180`). Production impl `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts:23`: `auth.api.getSession({ headers: request.headers })` reads the Better Auth session cookie, then `resolveOrgContext` resolves org membership → `AuthenticatedSession {sub, email, orgId, orgRole}` (`packages/perimeter/src/session.ts:11`). On a **public** route, an auth exception is swallowed and the request continues anonymously (`gateway.ts:181-187`); on a private route it throws.
5. **Access check.** `hasAppAccess(session, app)` (`gateway.ts:189`): `session.orgId === app.organizationId` AND a `user_app_access` row exists (`betterAuthAuthenticator.ts:41-50`).
6. **Identity minting / marker / reject** (`gateway.ts:193-224`):
   - **session && allowed** → `mintIdentityJwt(...)` and set `x-everyapp-identity` (`gateway.ts:194-207`). This is where the JWT is minted and injected — per request, on both private routes and public routes where the visitor is an entitled member.
   - **else if public** → `getPublicMarker` (signed marker JWT, cached per app to half TTL) set as `x-everyapp-public` (`gateway.ts:208-213`).
   - **else if no session** → HTML navigation with a configured `loginUrl` gets a `302 …?return_to=` redirect; otherwise `401 unauthenticated` (`gateway.ts:214-221`).
   - **else** (session but not allowed) → `403 forbidden / no_app_access`.
7. **Proxy.** Outbound `Request` rebuilt (`gateway.ts:226`), fetched via `getAppFetcher(env, app).fetch()` (§3/§5). WebSocket 101 passes through untouched; everything else gets `withSecurityHeaders` (`gateway.ts:276-279`).

### Exact inbound header handling — `packages/perimeter/src/headers.ts`

- `stripInboundHeaders(inbound)` (`headers.ts:23`) clones the inbound headers and **deletes**: `cookie`, `authorization`, and **every** header whose name starts with `x-everyapp-` (prefix `EVERYAPP_HEADER_PREFIX = "x-everyapp-"`, `headers.ts:16`). This is what prevents a client from forging `x-everyapp-identity`/`x-everyapp-public` or leaking the session cookie to the app.
- `prepareOutboundHeaders(inbound, forwardAuthorization)` (`headers.ts:36`) calls `stripInboundHeaders`, then **if `forwardAuthorization` is true, re-adds the original inbound `Authorization` header** (`headers.ts:41-44`).
- Called at `gateway.ts:167` as `prepareOutboundHeaders(request.headers, publicMatch.public)`.

**CONFIRMED — the just-merged "Authorization policy" behavior (PR #220, `51c0a47`, 2026-07-15 19:14, touched `headers.ts` +13 / `gateway.ts`):**
On a **public** manifest route the gateway **forwards the inbound `Authorization` header verbatim to the app**, while still stripping the session `cookie` and all `x-everyapp-*` trust headers. On **private** routes `Authorization` is stripped and never restored. Rationale in the code comments (`gateway.ts:163-170`): public app surfaces (APIs, webhooks, ported OSS endpoints) may run their own bearer-token auth; the gateway does not interpret that credential, it only passes it through on manifest-declared public routes. Note this stacks: on a public route served to an entitled logged-in member, the app receives **both** a minted `x-everyapp-identity` and the forwarded `Authorization`.

### Outbound response headers — `withSecurityHeaders` (`headers.ts:106`)
Strips cross-subdomain `Domain=` from every app `Set-Cookie` (`stripSetCookieDomains`, `headers.ts:91`); sets HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`. HTML responses get a CSP floor (`frame-ancestors 'none'; base-uri 'self'; object-src 'none'`) merged over any app CSP — floor directives always overwrite the app's (`enforceCspFloor`, `headers.ts:72`).

---

## 2. Manifest public routes

Schema in `packages/perimeter/src/manifest/manifest.ts`:
- `PublicRouteSchema` (`manifest.ts:16`): `{ path: string, methods?: string[] }`. **`methods` defaults to `["GET"]`** when omitted (applied at match time, `publicRoutes.ts:184`; matching is case-insensitive).
- Manifest field `public?: PublicRoute[]` (`manifest.ts` `ManifestSchema`), default none → app is fully private.
- **How an app declares a route public:** in `everyapp.config.ts` via `defineEveryApp({... public: [{ path, methods }] })` (`manifest.ts:defineEveryApp`). The CLI validates author-time with `validateManifestStrict` (rejects unknown keys); the gateway re-validates the snapshot with the tolerant `validateManifest` (passthrough for forward-compat). Both run `assertPublicPathIsSafe` on every route (`manifest.ts:validateManifest`).
- **`assertPublicPathIsSafe`** (`manifest.ts`, the hard-error linter): path must be absolute; **catch-alls `/*`, `/**`, `*`, `/` are hard errors**; no `%`-encoding, no backslashes, no `.`/`..` segments; named segments must match `:[A-Za-z_][A-Za-z0-9_]*`; nothing under the reserved `/__everyapp` prefix (`EVERYAPP_INTERNAL_PREFIX`) may be public.
- **Glob semantics** (`publicRoutes.ts:globToRegExp:123`): `*` = one path segment, `**` = one-or-more segments, `:name` = exactly one non-empty segment.
- **Request-time matching is "default-private, deny on ambiguity"** (`publicRoutes.ts:normalizePath:40`): control chars, backslashes, encoded separators (`%2f`/`%5c`), double-encoding, `..` traversal above root, and encoded-dot traversal all mark the path `ambiguous` → never public. `/__everyapp/*` is denied **post-normalization** unconditionally (`isInternalPath`, `publicRoutes.ts:179`).

**The "signed public marker":** not a bare flag. On a public route with no entitled member, the gateway mints `mintPublicMarkerJwt` and sets header `x-everyapp-public` (`PUBLIC_HEADER`). It is a gateway-signed, app-scoped, short-lived JWT (`typ:"public"`, `pub:true`, `sub:"public"`, `aud=appId`), cached per-app for half the TTL (`getPublicMarker`, `gateway.ts:82`; `PUBLIC_MARKER_REUSE_MS = 60s`). The SDK verifies it like an identity token (§4), so a re-exposed app worker cannot be flipped into public mode by a client-typed header.

---

## 3. App→gateway service-binding proxy — **DOES NOT EXIST AS DESCRIBED**

The task describes "the AppGateway `WorkerEntrypoint`, deploy-time props `{organizationId, appId, workerName}`, provider allowlist, edge-key injection, at `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts` + SDK `gatewayFetch`." **None of these exist on `main`:**
- No `app-gateway-entrypoint.ts` (file absent). No class named `AppGateway`. No `extends WorkerEntrypoint` anywhere in source (only in generated `worker-configuration.d.ts` ambient types).
- `gatewayFetch` exists only as a **local variable in the CLI dev server** (`packages/cli/src/commands/dev/index.ts:209`, a dev "mirror mode" fetcher), not as an SDK export.
- The `{organizationId, appId, workerName}` triple is not "deploy-time props" of a WorkerEntrypoint — it's the shape of `RegisteredApp` (a D1 registry row): `packages/perimeter/src/registry.ts:14`.

**What actually exists — two real primitives:**

**(a) Gateway→app direction (the real service binding, opposite direction).** `getAppFetcher(env, app)` (`packages/perimeter/src/getAppFetcher.ts:38`) is the sole seam. Self-hosted tier: each app is a private worker exposed to the gateway as service binding **`APP__<workerName>`** (`getAppFetcher.ts:30`); the binding's `.fetch()` is the proxy. `tier: "dispatch"` (Workers for Platforms) is reserved and **throws `AppUnreachableError`** — unimplemented (`getAppFetcher.ts:52-56`). CLI reconstructs these bindings from the registry (`packages/cli/src/lib/cloudflare/serviceBindings.ts`, `APP_SERVICE_BINDING_PREFIX = "APP__"`).

**(b) App→gateway direction: the LEGACY AI proxy (the closest real precedent for edge-key injection / provider allowlist).** This is an **HTTP route, not a WorkerEntrypoint service binding**, and its own header banner marks it superseded:
- Route `apps/every-app-gateway/src/routes/api/ai/$provider.$.ts` → `handleAiProxyRequest` (`apps/every-app-gateway/src/server/ai-proxy.ts:48`). Header comment (`ai-proxy.ts:1`): *"Legacy AI proxy subsystem. Long-lived app tokens contradict the perimeter model; superseded by the perimeter LLM-gateway design in docs/architecture-v2-recommendation.md §2.3 when Phase 6 lands."*
- **Auth:** long-lived app token in header **`x-every-app-token`** (`ai-proxy-token-policy.ts:6`), hashed with `BETTER_AUTH_SECRET` and looked up in `app_tokens` (`ai-gateway-auth.ts:13`). An inbound `Authorization` header is **rejected** here (`ai-proxy-token-policy.ts:69-75`) — opposite of the perimeter's new public-route policy.
- **Provider allowlist / scopes:** token scopes `provider:<name>`; `hasProviderScope` gates each request (`app-token-scopes.ts:42`). Only `openai` is actually wired (`ai-proxy.ts:55`).
- **Edge key injection:** strips client headers, then sets `Authorization: Bearer ${env.OPENAI_API_KEY}` before forwarding to `api.openai.com` (`ai-proxy.ts:88-100`). Apps never hold the provider key. This is the real "edge key injection" precedent.

Net: the design explorations should treat §3 as **aspirational/not-yet-built**; the concrete precedents are `getAppFetcher`'s `APP__` service binding (gateway→app) and the legacy app-token AI proxy (app→gateway, HTTP + `x-every-app-token`).

---

## 4. Identity JWT protocol — `packages/sdk/src/internal/{protocol,identity}.ts`

**Wire constants** (`protocol.ts:10-26`): alg `RS256` (`IDENTITY_ALG`); prod kid `everyapp-identity`, dev kid `everyapp-identity-dev`; headers `x-everyapp-identity` / `x-everyapp-public`; **TTL 120 s** (`IDENTITY_TTL_SECONDS`). Env vars on the app side: `EVERYAPP_APP_ID` (expected audience), `EVERYAPP_IDENTITY_PUBLIC_KEYS` (verify keys), `EVERYAPP_IDENTITY_ISSUER` (optional expected iss), `EVERYAPP_DEV` (dev-kid opt-in).

**Identity claims** (`identitySubjectToClaims`, `protocol.ts:78`; minted by `mintIdentityJwt`, `protocol.ts:167`):
`typ:"user"`, `sub` (user id), `email`, `org_id`, `org_role`, `chan` (`"web"|"mcp"|"agent"`, default `web`), `act:{sub}` (acting principal — user, or `mcp:<client>`/agent), `jti` (`crypto.randomUUID()`), plus standard `iss` (gateway URL), `aud` (**app id**), `iat`, `exp` (iat+120s). Header `{alg:RS256, kid}`. Signed with a PKCS8 RSA private key PEM held only by the gateway (`loadPrivateKey`, cached; `protocol.ts:153`).

**Public-marker claims** (`publicMarkerClaims`, `protocol.ts:123`; `mintPublicMarkerJwt`, `protocol.ts:211`): `typ:"public"`, `pub:true`, `sub:"public"` (`PUBLIC_MARKER_SUB`), `jti`, `aud=appId`, `iss`, `exp`.

**Verification — fail-closed** (`verifyPinnedJwt`, `identity.ts:154`; entry `getIdentityFromRequest`, `identity.ts:259`, consumed by SDK `everyApp()` wrapper in `packages/sdk/src/server/everyApp.ts`):
1. `decodeProtectedHeader` **before any signature work**; require `alg === "RS256"` (defeats `alg:none` and HS/RS confusion).
2. `kid` must be in the allowed set: `[everyapp-identity]` in prod, `[everyapp-identity, everyapp-identity-dev]` only when `allowDevIdentities` (driven by `EVERYAPP_DEV`) — `identity.ts:175-180`.
3. `jwtVerify` with `algorithms:["RS256"]`, `audience = this app's id`, optional `issuer`. Tries each key in the set (current + next) → supports rotation. `EVERYAPP_IDENTITY_PUBLIC_KEYS` is a JSON array of SPKI PEMs (or a single PEM), read from env — **never a runtime JWKS fetch** (`parsePublicKeys`, `identity.ts:71`).
4. Post-verify `typ` check (`user` vs `public`); identity claims coerced to `EveryAppUser {id,email,orgId,orgRole,channel,actor,jti}` (`identityClaimsToEveryAppUser`, `protocol.ts:97`). Any failure throws `IdentityError` (401).
5. `getIdentityFromRequest`: if `x-everyapp-public` present → verify marker → `{user:null, isPublic:true}`; else require `x-everyapp-identity` → verify → `{user, isPublic:false}`; a request with neither header throws (app must be behind the gateway).

**Key distribution:** apps receive the public key set at deploy time; the gateway serves them at `apps/every-app-gateway/src/routes/api/deploy/identity-keys.ts`. A dev-only minting endpoint exists at `routes/api/dev/identity.ts`. Key-rotation runbook added in PR #215.

---

## 5. Org / tenant model + hosted multi-tenancy

**Today (self-hosted / single gateway):**
- `AuthenticatedSession {sub, email, orgId, orgRole}` (`session.ts:11`). Org resolved by `resolveOrgContext` (`orgContext.ts:31`) from the Better Auth **organization plugin** `members` table — uses `session.activeOrganizationId`, else falls back only if the user has exactly one membership. 30 s per-isolate cache (revocation lag matches the registry cache).
- **Roles:** `owner | admin | member` (`org-roles.ts`); `resolvePrimaryOrganizationRole` picks the highest. Surfaced as the `org_role` JWT claim; UI gating landed in PR #202.
- **App is org-scoped:** `RegisteredApp.organizationId` (`registry.ts:22`). Access = `session.orgId === app.organizationId` **and** a `user_app_access` row (`betterAuthAuthenticator.ts:41`). The org the session acts under must equal the app's org, or the minted JWT would carry wrong-org claims.
- Better Auth is the org/tenant authority: `organization()` + `admin()` plugins (`auth/config.ts:190-193`), invite-only sign-up once any owner exists, cross-subdomain session cookie `Domain=<gateway host>` (`crossSubDomainCookies`, `auth/config.ts:169-173`) so one cookie covers all `*.gateway` app subdomains. PR #219 ("Wave 1: consolidate the organization layer") and #199 ("enforce org-scoped services and token claims") are the recent org hardening.

**Future (per `docs/architecture-v2-recommendation.md`, unbuilt):** one multi-tenant public gateway fronting ~100k untrusted apps via **Workers for Platforms dispatch** — `getAppFetcher`'s `tier:"dispatch"` seam (currently throwing). Doc specifics: single dispatch namespace, untrusted mode, scripts `t_<tenant>_<app>`, `dispatcher.get(name,{},{limits,outbound})`; **internal JWTs become tenant-scoped (`aud = t_<tenant>_<app>`)**; single-label hostnames `{app}-{tenant}.everyapp.host` under one wildcard cert; per-tenant envelope-encrypted secrets; egress worker + perimeter LLM gateway (§2.3). This is **Phase 7** in the doc's roadmap; nothing dispatch-related is implemented.

---

## 6. Existing MCP-OAuth / auth proposal in docs — **proposed, UNBUILT**

Located in `docs/architecture-v2-recommendation.md` (the adopted "Proposal A — One Door" architecture). Relevant sections:

- **§2.4 "MCP aggregation and the agent"** and **Phase 6** (roadmap line 163): proposes **one MCP endpoint at the gateway** using **`workers-oauth-provider`** with per-app / per-tool scopes; a **"ToolBus"** aggregator with an operator-controlled registry that classifies tool risk (read/write/destructive) — enforced at the gateway, never trusting the app's `readOnlyHint`; convention `/__everyapp/tools/*`; write tools require inline user confirmation.
- **No token passthrough (§2.4):** the external MCP token **terminates at the gateway**; each `tools/call` mints a **fresh internal identity JWT** with `chan="mcp", act={sub:"mcp:<client_id>"}` — which is exactly why the identity protocol already carries `chan`/`act` fields (§4) though nothing populates `mcp`/`agent` yet.
- The agent is framed as "just another MCP-shaped client" (`chan="agent"`), same ToolBus/registry/audit log.

**Confirmed unbuilt in code:** no `/__everyapp/tools` handler, no `ToolBus`, no `workers-oauth-provider` dependency, no `/mcp` route, no OAuth authorization-server / DCR / protected-resource-metadata endpoints anywhere in `apps/` or `packages/` source. `packages/mcp` contains only a stale prebuilt `dist/` of an **unrelated filesystem-tools MCP server** (`list-directory`, `find-files`, `list-examples`) — no `src`, not the perimeter design. The identity protocol's `chan:"mcp"|"agent"` and `act` claims are the only scaffolding present.

---

## 7. What real MCP clients need to authenticate to a remote (Streamable HTTP) MCP server

**Spec baseline (MCP Authorization, current rev `2025-11-25`, via ctx7 `/websites/modelcontextprotocol_io_specification_2025-11-25`; supersedes `2025-06-18`):**
- Auth is **OAuth 2.1** (PKCE mandatory — `code_challenge_method=S256` on every authorization request; applies to public and confidential clients).
- **Discovery is server-driven:** the MCP server MUST implement **OAuth 2.0 Protected Resource Metadata (RFC 9728)** at `/.well-known/oauth-protected-resource`. An unauthenticated request gets **`401` + `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`**; the client fetches that metadata to find the authorization server, then does **Authorization Server Metadata (RFC 8414)** / OpenID Connect Discovery to get endpoints.
- **Client registration, three routes** (order of current preference in `2025-11-25`): **OAuth Client ID Metadata Documents (CIMD)** now recommended; **Dynamic Client Registration (RFC 7591 / DCR)** downgraded to "may / backwards-compat"; or a **pre-registered client ID**. Access tokens are sent as `Authorization: Bearer` on the Streamable HTTP transport; tokens are audience-bound to the specific MCP server (no passthrough).

**Client-by-client reality (grounded in current sources, July 2026):**

| Client | Discovery + DCR/CIMD + PKCE OAuth dance | Static bearer / custom header |
|---|---|---|
| **claude.ai connectors** (web/Desktop/mobile/Cowork) | **Yes** — full flow. Supports DCR, CIMD, and Anthropic-held credentials (optional Client ID/Secret in "Advanced settings"). PKCE S256. **User consent is mandatory — no `client_credentials` machine-to-machine grant.** | **No first-class static-bearer field** — the custom-connector UI exposes only OAuth client id/secret. Static `Authorization: Bearer` API-key MCPs cannot be added cleanly (open issue `anthropics/claude-ai-mcp#112`). |
| **Claude Code** | **Yes** — runs its own OAuth on the user's machine, **RFC 8252 loopback redirect on an ephemeral port**, identifies via its **own CIMD** (does not use Anthropic-held creds). Built-in login flow for OAuth-protected servers. | **Yes** — `claude mcp add <name> --transport http --header "Authorization: Bearer ${TOKEN}" <url>`. Supports arbitrary custom headers. This is the escape hatch for non-OAuth servers. |
| **Cursor** | Supports remote (Streamable HTTP) MCP with OAuth login for servers that advertise it; less precisely documented than Claude's clients. | **Yes** — supports headers/bearer in its MCP server JSON config (`headers` map). Commonly used for API-key servers. |
| **Generic HTTP/API clients / scripts / SDKs** | Only if the app implements the OAuth 2.1 + RFC 9728/8414 dance itself; most do not. | **Yes, dominant path** — a static `Authorization: Bearer <token>` (or custom header) is what raw HTTP callers and most CI/agent scripts use. |

**Implication for the Every App perimeter:** the spec-compliant clients (claude.ai connectors especially) require the server side to expose `WWW-Authenticate` challenges, RFC 9728 protected-resource-metadata, an authorization server with metadata + PKCE, and ideally DCR/CIMD — none of which exists today (§6). CLI/config-driven clients (Claude Code, Cursor, generic) can instead present a static `Authorization: Bearer`, which — post-PR #220 — the perimeter now **forwards untouched to the app on public routes** (§1), but strips on private routes. There is no OAuth authorization-server surface, no token-terminating MCP endpoint, and no user-consent flow anywhere in the current codebase.

Sources: [MCP Authorization spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization); [Claude custom connectors / remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp); [Claude connector authentication docs](https://claude.com/docs/connectors/building/authentication); [MCP authentication in Claude Code](https://www.truefoundry.com/blog/mcp-authentication-in-claude-code); [claude-ai-mcp#112 (no static bearer in connector UI)](https://github.com/anthropics/claude-ai-mcp/issues/112).

---

### Key file map (absolute paths)
- Perimeter core: `/Users/bensenescu/every-app-workspaces/private-every-app/packages/perimeter/src/{gateway,headers,csrf,publicRoutes,session,registry,getAppFetcher}.ts`
- Manifest: `.../packages/perimeter/src/manifest/manifest.ts`
- Identity protocol/verify: `.../packages/sdk/src/internal/{protocol,identity}.ts`; app wrapper `.../packages/sdk/src/server/everyApp.ts`
- Prod authenticator + org: `.../apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts`, `.../src/server/organization/orgContext.ts`, `.../src/server/org-roles.ts`, `.../src/auth/{config,shared}.ts`
- Legacy AI proxy (app→gateway precedent): `.../apps/every-app-gateway/src/server/{ai-proxy,ai-gateway-auth,ai-proxy-token-policy,app-token-scopes}.ts`, route `.../src/routes/api/ai/$provider.$.ts`
- Design docs (unbuilt): `/Users/bensenescu/every-app-workspaces/private-every-app/docs/architecture-v2-recommendation.md` (§2.3 LLM gateway, §2.4 MCP/agent, Phase 6 & 7), `docs/architecture-v2-overview.md`, `docs/security-model.md`