# Gateway: Security Boundary

Where trust is established, what apps receive, and what is deliberately not protected.

> Internal notes for tracking the prototype as it grows — not polished user docs. Verified against code on 2026-07-15.

**The boundary in one sentence:** the browser's session cookie terminates at the gateway; user identity reaches an app only as a 120-second RS256 JWT that the gateway mints and the SDK verifies fail-closed. (Anonymous public traffic carries a signed public marker instead — reused up to ~60s — and public routes may additionally run their own `Authorization`-based auth.)

```
  UNTRUSTED                     TRUSTED TO AUTHENTICATE            TRUSTED TO ACT
┌───────────┐  session cookie  ┌──────────────────┐  x-everyapp-  ┌──────────────┐
│  browser, │ ───────────────► │  GATEWAY WORKER  │  identity JWT │  APP WORKER  │
│  webhooks,│                  │  cookie stops    │ ────────────► │  everyApp()  │
│  API bots │                  │  here; all trust │  (service     │  verifies or │
└───────────┘                  │  headers stripped│   binding)    │  401s        │
                               └──────────────────┘               └──────────────┘
```

Three things this boundary **assumes but cannot enforce** (deployment invariants):

- **Apps stay private.** The CLI deploys them with no routes, `workers_dev: false`, `preview_urls: false` — but nothing at runtime stops someone re-exposing a worker.
- **Apps actually call SDK verification** — `everyApp()` or the `getEveryAppUser()`/`requireEveryAppUser()` helpers. No deploy-time check proves an app does.
- **`GATEWAY_URL` is set and valid.** If it isn't, `ownGatewayHost()` returns null and _every_ host serves the control plane — deliberately fail-open so a fresh deploy works before secrets exist.

## The checks, in order

Registered-host requests go through `handleGatewayRequest()` (`packages/perimeter/src/gateway.ts`); step 1 happens before it in `server.ts`:

1. **App resolution + status** — full-hostname D1 lookup; unknown subdomains of the gateway domain get 404 (never the control plane, since the cookie spans those hosts). A `binding` app (its Worker uploaded) becomes `active` on the first request that reaches it over the gateway's service binding; other non-`active` apps get 503.
2. **Public/private classification** — manifest match with fail-closed path canonicalization.
3. **CSRF** — before authentication. GET/HEAD/OPTIONS always pass; other methods need `Sec-Fetch-Site: same-origin`, or (if absent) an `Origin` whose host matches the app host (scheme is ignored). Origin-signal policy, no CSRF tokens.
4. **Header hygiene** — inbound `Cookie`, `Authorization`, and every `x-everyapp-*` header are deleted. Public routes get `Authorization` back (apps may run their own bearer/webhook auth; the gateway never interprets it).
5. **Authentication** — Better Auth resolves the cookie; org context is verified (active org, or sole membership as fallback).
6. **Authorization** — session org must equal the app's org, **and** a `user_app_access` row must exist. A personal token whose scopes are all `mcp:*` is refused (`403 token_scope`) on every path but `/mcp`.
7. **Agent tools** — `/mcp` of an app with a tool catalog (and no `mcp: "app"` in its manifest) is answered by the gateway's ToolBus instead of the app, for personal tokens and for the user's session on the app's own pages (step 3 keeps every other origin out).
8. **Identity injection** — one of the outcomes below.

### What the app receives

| Situation                            | `x-everyapp-identity`       | `x-everyapp-public`              | Cookie   | Authorization |
| ------------------------------------ | --------------------------- | -------------------------------- | -------- | ------------- |
| Private route, authorized member     | fresh user JWT              | —                                | stripped | stripped      |
| Private route, no session            | 302 to sign-in (HTML) / 401 | —                                | —        | —             |
| Private route, session but no access | 403                         | —                                | —        | —             |
| Public route, authorized member      | fresh user JWT              | —                                | stripped | forwarded     |
| Public route, anonymous / non-member | —                           | signed marker                    | stripped | forwarded     |
| Public route, CSRF failure           | —                           | signed marker (forced anonymous) | stripped | forwarded     |

The public-route CSRF downgrade is deliberate: webhooks work, but a cross-site request can never ride a member's cookie into an identity.

## The identity JWT

Minted by `mintIdentityJwt()` (`packages/sdk/src/internal/protocol.ts`), verified by `verifyPinnedJwt()` (`packages/sdk/src/internal/identity.ts`).

| Property         | Value                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Algorithm / key  | RS256, gateway's `JWT_PRIVATE_KEY`; `kid: everyapp-identity` (dev kid accepted when `EVERYAPP_DEV` is any non-empty value, or via explicit `allowDevIdentities: true`)         |
| Lifetime         | 120 seconds                                                                                                                                                                    |
| Audience         | the target app's ID — a token for `todo` is useless against `chef`                                                                                                             |
| Claims           | verified: `sub`, `email`, `org_id`, `org_role`, `typ: "user"`, audience. Minted but defaulted if absent: `chan: "web"`, `act`, `jti`                                           |
| Verification     | pins alg + kid before signature check (rejects `none`/confusion), requires audience + `typ` + nonempty user claims; issuer checked only when configured                        |
| Key distribution | `EVERYAPP_IDENTITY_PUBLIC_KEYS` env var injected at deploy — no runtime JWKS fetch. SDK supports a key _set_ for rotation; the CLI injects the one key it generated at install |
| Failure          | `everyApp()` returns 401 before app code runs; missing key config → 500                                                                                                        |

Anonymous public traffic gets a separate signed **public marker** JWT (`typ: "public"`, same audience binding to the app's Worker name, cached per Worker for ~60s) — so a forged `x-everyapp-public: 1` header from a re-exposed worker fails verification.

## Machine credentials

The gateway issues one kind of token: the **personal access token** (`epat_`, 32 random bytes, HMAC-SHA256-hashed at rest, domain-separated and keyed by `BETTER_AUTH_SECRET`, plaintext shown exactly once). It acts as its user for MCP and HTTP API clients, optionally bound to one app, and dies with the user's deactivation or removal.

Deploying needs no gateway credential at all (ADR-0003): in self-host, write access to the gateway's D1 in its Cloudflare account **is** operator authority. The CLI registers, deploys and deletes apps by writing the registry itself with the operator's Cloudflare login (or `CLOUDFLARE_API_TOKEN` in CI), running the rules in `@every-app/perimeter/registry`, and records the deploy's actor on the app row. There is no deploy API, no deploy token and no app token. The cost: revoking someone's deploy access is Cloudflare's job, not the gateway's, and any API token with D1 write on the account is an operator.

## What is deliberately NOT protected

- **Sibling apps share the cookie's delivery domain.** Apps never _see_ the cookie, but an XSS'd app can fire authenticated GETs at siblings (GET is CSRF-exempt), and the gateway will happily mint a fresh sibling-scoped JWT for those. Accepted at personal/small-team scale — the real damper is browser same-origin policy (the attacker can't read responses) plus apps keeping GETs side-effect-free.
- **No JWT replay detection.** `jti` is minted but never checked; a captured token replays against its own app for up to 120s.
- **No egress control.** Apps can fetch anywhere (the plan's outbound worker is hosted-tier, not built).
- **No public-route abuse controls.** No rate limiting, metering, or bot protection at the perimeter today.
- **Public-route business auth is the app's job.** The gateway forwards `Authorization` blind — webhook signature checks, quotas, replay are on the app.
- **CSP floor is narrow by design.** `frame-ancestors`/`base-uri`/`object-src` only — it does not try to contain arbitrary app XSS.

## Gaps found vs `docs/security-model.md` (worth tracking)

1. **Issuer verification is conditional** — the SDK checks `iss` only when `EVERYAPP_IDENTITY_ISSUER` is configured (the CLI normally injects it, but the SDK doesn't fail without it).
2. **`exp`, `iat`, `chan`, `act`, and `jti` are not required claims** — expired tokens are rejected when `exp` is present, but a signed token lacking any of these would pass (the last three silently default). Gateway always mints them, so this only matters if the signing key is misused.
3. **Security headers are not uniform** — gateway-generated errors (401/403/404/5xx) and login redirects return before `withSecurityHeaders()`; any response to a WebSocket upgrade request (not just 101s) bypasses both it _and_ the `Set-Cookie` domain-stripping.
4. **"Apps can't set parent-domain cookies" covers proxied HTTP responses only** — app JS could still write a non-HttpOnly parent-domain cookie via `document.cookie`.
5. **Key rotation is supported by the SDK but not used** — the CLI injects the single key it generated at install, not current+next.
6. **Revocation latency** — hostname/registry cache means disabled apps can serve for up to 30s per isolate; identity JWTs live up to 120s past access revocation.
